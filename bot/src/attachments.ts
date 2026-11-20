import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type { Attachment } from "discord.js";

/**
 * Downloads Discord attachments into /tmp/devenum-chat-<timestamp>-<rand>/ and extracts text where possible:
 * text formats are read directly, .docx via Python's zipfile (stdlib), and PDFs are left for Claude Code to read
 * natively (the folder is passed with --add-dir). The folder is world-readable so the unprivileged Claude user can
 * read it, and is always removed by `cleanup()` after the reply.
 */
export interface ChatFile { name: string; path: string; kind: string; size: number; text?: string; truncated?: boolean; note?: string }
export interface DownloadedFiles { dir: string; files: ChatFile[]; skipped: string[]; cleanup: () => void }

const TEXT_EXT = new Set(["md", "markdown", "txt", "json", "csv", "tsv", "log", "yaml", "yml", "xml", "html", "js", "ts", "tsx", "jsx", "py", "sql", "env.example"]);
const SUPPORTED = new Set([...TEXT_EXT, "pdf", "docx"]);
const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 50_000;

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";
const safeName = (name: string, i: number) => `${i + 1}-${name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file"}`;

const DOCX_SCRIPT = `import sys, zipfile, re, html
with zipfile.ZipFile(sys.argv[1]) as z:
    xml = z.read("word/document.xml").decode("utf8", "replace")
xml = re.sub(r"</w:p>", "\\n", xml)
xml = re.sub(r"<w:tab/>", "\\t", xml)
xml = re.sub(r"<w:br/>", "\\n", xml)
text = html.unescape(re.sub(r"<[^>]+>", "", xml))
sys.stdout.write(re.sub(r"\\n{3,}", "\\n\\n", text).strip())`;

function docxText(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", ["-I", "-c", DOCX_SCRIPT, file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", b => (out += b));
    p.stderr.on("data", b => (err += b));
    const t = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("error", reject);
    p.on("close", code => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `exit ${code}`)); });
  });
}

const clip = (s: string) => (s.length > MAX_TEXT_CHARS ? { text: s.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: s, truncated: false });

export async function downloadAttachments(attachments: Attachment[]): Promise<DownloadedFiles | null> {
  if (!attachments.length) return null;
  const dir = `/tmp/devenum-chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const files: ChatFile[] = [];
  const skipped: string[] = [];
  try {
    for (const [i, a] of attachments.entries()) {
      const kind = ext(a.name);
      if (files.length >= MAX_FILES) { skipped.push(`${a.name} (max ${MAX_FILES} files)`); continue; }
      if (!SUPPORTED.has(kind)) { skipped.push(`${a.name} (unsupported type)`); continue; }
      if (a.size > MAX_BYTES) { skipped.push(`${a.name} (over 20 MB)`); continue; }
      const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) { skipped.push(`${a.name} (download failed: HTTP ${res.status})`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(dir, safeName(a.name, i));
      fs.writeFileSync(file, buf, { mode: 0o644 });
      const f: ChatFile = { name: a.name, path: file, kind, size: buf.length };
      try {
        if (TEXT_EXT.has(kind)) Object.assign(f, clip(buf.toString("utf8")));
        else if (kind === "docx") Object.assign(f, clip(await docxText(file)));
        else if (kind === "pdf") f.note = "PDF — no local text extractor installed";
      } catch (e) {
        f.note = `Text extraction failed (${(e as Error).message.slice(0, 120)})`;
      }
      files.push(f);
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  if (!files.length) { cleanup(); return { dir, files, skipped, cleanup: () => undefined }; }
  return { dir, files, skipped, cleanup };
}
