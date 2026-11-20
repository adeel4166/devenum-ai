import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { Attachment } from "discord.js";

/**
 * Multimodal attachment pipeline for agent chat. Files are downloaded to /tmp/devenum-chat-<timestamp>-<rand>/ and
 * turned into things Claude Code can use:
 *  - text/code/CSV/JSON/MD → read directly
 *  - PDF → pdftotext (falls back to Claude reading the PDF itself if it has no text layer)
 *  - DOCX → pandoc (fallback: python-docx-free zip parsing)
 *  - images → kept as files; Claude opens them with its Read tool
 *  - video → up to 8 evenly spaced keyframes (as images) + transcript of the audio track
 *  - voice notes / audio → offline Whisper transcript (auto language detection, incl. Urdu & English)
 * Every external tool (ffmpeg, pdftotext, pandoc, whisper) processes untrusted media as the unprivileged RUN_AS user
 * under a hard timeout. The folder is always removed by cleanup() after the reply.
 */
export interface ChatFile { name: string; path: string; kind: string; size: number; text?: string; truncated?: boolean; note?: string }
export interface DownloadedFiles { dir: string; files: ChatFile[]; skipped: string[]; cleanup: () => void }

const RUN_AS = process.env.CHAT_RUN_AS_USER || process.env.RUN_AS_USER || "devenum";
const WHISPER_PY = process.env.WHISPER_PYTHON || "/opt/devenum-ai/tools/whisper-venv/bin/python";
const TRANSCRIBE = path.resolve(__dirname, "../scripts/transcribe.py");

const TEXT_EXT = new Set(["md", "markdown", "txt", "json", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "js", "ts", "tsx", "jsx", "py", "sql", "css", "sh", "env.example"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const AUDIO_EXT = new Set(["ogg", "oga", "opus", "mp3", "wav", "m4a", "aac", "flac"]);
const MAX_FILES = 5;
const MAX_BYTES = Number(process.env.CHAT_MAX_ATTACHMENT_MB || 50) * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;
const MAX_FRAMES = 8;
const MAX_TRANSCRIBE_SEC = Number(process.env.CHAT_MAX_TRANSCRIBE_SEC || 1200);

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";
const safeName = (name: string, i: number) => `${i + 1}-${name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file"}`;
const clip = (s: string) => (s.length > MAX_TEXT_CHARS ? { text: s.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: s, truncated: false });
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

let runAsIds: { uid: number; gid: number } | null = null;
function ids() {
  if (!runAsIds) runAsIds = { uid: Number(execFileSync("id", ["-u", RUN_AS]).toString().trim()), gid: Number(execFileSync("id", ["-g", RUN_AS]).toString().trim()) };
  return runAsIds;
}

/** Runs argv as RUN_AS (when root) under `timeout`, returning stdout. No shell is involved. */
function tool(argv: string[], timeoutSec: number): Promise<string> {
  const isRoot = process.getuid?.() === 0;
  const full = ["timeout", "-k", "5", String(timeoutSec), ...argv];
  const [cmd, args] = isRoot ? ["runuser", ["-u", RUN_AS, "--", "env", `HOME=/home/${RUN_AS}`, ...full]] : [full[0], full.slice(1)];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", b => (out += b));
    p.stderr.on("data", b => (err += b));
    p.on("error", reject);
    p.on("close", code => (code === 0 ? resolve(out) : reject(new Error(code === 124 ? `timed out after ${timeoutSec}s` : (err.trim().split("\n").pop() || `exit ${code}`).slice(0, 200)))));
  });
}

/** Whisper is CPU-heavy: one transcription at a time. */
let whisperQueue: Promise<unknown> = Promise.resolve();
function transcribe(wav: string): Promise<{ language: string; duration: number; text: string }> {
  const job = whisperQueue.then(async () => JSON.parse((await tool([WHISPER_PY, "-I", TRANSCRIBE, wav], 900)).trim().split("\n").pop()!));
  whisperQueue = job.catch(() => undefined);
  return job as Promise<{ language: string; duration: number; text: string }>;
}

async function probe(file: string) {
  const out = await tool(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], 60);
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const types = new Set((j.streams ?? []).map(s => s.codec_type));
  return { duration: Number(j.format?.duration ?? 0) || 0, hasVideo: types.has("video"), hasAudio: types.has("audio") };
}

async function audioToText(file: string, dir: string, base: string, duration: number) {
  const wav = path.join(dir, `${base}.16k.wav`);
  const lim = duration > MAX_TRANSCRIBE_SEC
    ? { note: `audio is ${mmss(duration)} long — only the first ${mmss(MAX_TRANSCRIBE_SEC)} were transcribed`, cut: MAX_TRANSCRIBE_SEC }
    : { note: "", cut: 0 };
  await tool(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", file, ...(lim.cut ? ["-t", String(lim.cut)] : []), "-vn", "-ac", "1", "-ar", "16000", wav], 300);
  const t = await transcribe(wav);
  fs.rmSync(wav, { force: true });
  return { ...t, note: lim.note };
}

export async function downloadAttachments(attachments: Attachment[]): Promise<DownloadedFiles | null> {
  if (!attachments.length) return null;
  const dir = `/tmp/devenum-chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { mode: 0o755 });
  if (process.getuid?.() === 0) fs.chownSync(dir, ids().uid, ids().gid); // tools write frames/text here as RUN_AS
  fs.chmodSync(dir, 0o755);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const files: ChatFile[] = [];
  const skipped: string[] = [];
  let userFiles = 0;
  try {
    for (const [i, a] of attachments.entries()) {
      let kind = ext(a.name);
      if (!kind || kind === a.name.toLowerCase()) kind = a.contentType?.split("/")[1]?.split(";")[0] ?? "";
      const isVoice = (a as { waveform?: string | null }).waveform != null || /^voice-message/i.test(a.name);
      const supported = TEXT_EXT.has(kind) || IMAGE_EXT.has(kind) || VIDEO_EXT.has(kind) || AUDIO_EXT.has(kind) || kind === "pdf" || kind === "docx";
      if (userFiles >= MAX_FILES) { skipped.push(`${a.name} (max ${MAX_FILES} files)`); continue; }
      if (!supported) { skipped.push(`${a.name} (unsupported type)`); continue; }
      if (a.size > MAX_BYTES) { skipped.push(`${a.name} (over ${MAX_BYTES / 1048576} MB)`); continue; }
      const res = await fetch(a.url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) { skipped.push(`${a.name} (download failed: HTTP ${res.status})`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(dir, safeName(a.name, i));
      fs.writeFileSync(file, buf, { mode: 0o644 });
      userFiles++;
      const base = path.basename(file).replace(/\.[^.]+$/, "");
      const f: ChatFile = { name: a.name, path: file, kind, size: buf.length };
      const extra: ChatFile[] = []; // e.g. video keyframes, listed right after their video
      try {
        if (TEXT_EXT.has(kind)) Object.assign(f, clip(buf.toString("utf8")));
        else if (kind === "pdf") {
          const out = path.join(dir, `${base}.txt`);
          await tool(["pdftotext", "-layout", "-enc", "UTF-8", file, out], 120);
          const text = fs.readFileSync(out, "utf8").replace(/\f/g, "\n").trim();
          if (text.length > 20) Object.assign(f, clip(text));
          else f.note = "PDF has no text layer (probably scanned) — open the PDF itself with your Read tool to see its pages";
        } else if (kind === "docx") {
          try { Object.assign(f, clip((await tool(["pandoc", "-t", "plain", "--wrap=none", file], 120)).trim())); }
          catch { Object.assign(f, clip((await tool(["python3", "-I", "-c", "import sys,docx;print('\\n'.join(p.text for p in docx.Document(sys.argv[1]).paragraphs))", file], 60)).trim())); }
        } else if (IMAGE_EXT.has(kind)) {
          f.kind = "image";
          f.note = "Image — open this file with your Read tool to see it";
        } else if (AUDIO_EXT.has(kind) || (kind === "webm" && !(await probe(file)).hasVideo)) {
          const p = await probe(file);
          f.kind = isVoice ? "voice-note" : "audio";
          const t = await audioToText(file, dir, base, p.duration);
          f.text = `${isVoice ? "Voice Note Transcript" : "Audio Transcript"} (language: ${t.language}, length ${mmss(p.duration)}${t.note ? `; ${t.note}` : ""}): ${t.text || "(no speech detected)"}`;
        } else if (VIDEO_EXT.has(kind)) {
          const p = await probe(file);
          f.kind = "video";
          const frames: string[] = [];
          if (p.hasVideo) {
            const n = Math.max(1, Math.min(MAX_FRAMES, Math.floor(p.duration) || 1));
            for (let k = 0; k < n; k++) {
              const at = p.duration ? (p.duration * (k + 0.5)) / n : 0;
              const out = path.join(dir, `${base}-frame-${String(k + 1).padStart(2, "0")}-${mmss(at).replace(":", "m")}s.jpg`);
              try {
                await tool(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", out], 60);
                if (fs.existsSync(out)) frames.push(out);
              } catch { /* skip unreadable frame */ }
            }
          }
          let transcript = "";
          if (p.hasAudio) {
            try { const t = await audioToText(file, dir, base, p.duration); transcript = t.text ? `Audio transcript (language: ${t.language}${t.note ? `; ${t.note}` : ""}): ${t.text}` : "Audio track contains no detectable speech."; }
            catch (e) { transcript = `Audio could not be transcribed (${(e as Error).message})`; }
          } else transcript = "No audio track.";
          f.text = `Video, length ${mmss(p.duration)}. ${frames.length} evenly spaced keyframe(s) are attached as separate image files below (open each with your Read tool). ${transcript}`;
          for (const fr of frames) extra.push({ name: `${a.name} — ${path.basename(fr).replace(`${base}-`, "")}`, path: fr, kind: "image", size: fs.statSync(fr).size, note: "Video keyframe — open with your Read tool" });
        }
      } catch (e) {
        f.note = `Processing failed (${(e as Error).message.slice(0, 160)}) — try reading the original file with your Read tool`;
      }
      files.push(f, ...extra);
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  if (!files.length) { cleanup(); return { dir, files, skipped, cleanup: () => undefined }; }
  return { dir, files, skipped, cleanup };
}
