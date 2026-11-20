import fs from "fs";
import path from "path";
import { prisma } from "../db";
import { HttpError } from "../http";
import { runScript, sq, workspacePath } from "./exec";

/**
 * Safe, CEO-facing access to a project workspace: file tree, read, quick edit (committed to main as a CEO edit),
 * and the per-project .env secrets file. Every path is resolved and checked to stay inside the workspace
 * (including through symlinks); .git is never readable or writable.
 */
export const workspaceExists = (slug: string) => {
  try { return fs.existsSync(path.join(workspacePath(slug), ".git")); } catch { return false; }
};

export function requireWorkspace(slug: string) {
  if (!workspaceExists(slug)) throw new HttpError(409, "Run first task to initialize workspace");
  return workspacePath(slug);
}

/** Resolves a user-supplied relative path, refusing traversal, absolute paths, .git and symlink escapes. */
export function safeResolve(ws: string, rel: string) {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("\0")) throw new HttpError(400, "Invalid path");
  const abs = path.resolve(ws, clean);
  const root = path.resolve(ws);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, "Path is outside the workspace");
  const relNorm = path.relative(root, abs);
  if (relNorm.split(path.sep)[0] === ".git") throw new HttpError(403, ".git is not accessible");
  // Symlink check: the real path of the nearest existing ancestor must stay inside the real workspace root.
  const realRoot = fs.realpathSync(root);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw new HttpError(400, "Path escapes the workspace via a symlink");
  return { abs, rel: relNorm.split(path.sep).join("/") };
}

export interface TreeNode { name: string; path: string; type: "dir" | "file"; size?: number; children?: TreeNode[] }
const SKIP = new Set(["node_modules", ".git", ".next", ".turbo", ".cache"]);
const MAX_ENTRIES = 4000;

export function fileTree(ws: string): { tree: TreeNode[]; truncated: boolean } {
  let count = 0, truncated = false;
  const walk = (dir: string, rel: string, depth: number): TreeNode[] => {
    if (depth > 12) return [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const out: TreeNode[] = [];
    for (const e of entries) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      if (++count > MAX_ENTRIES) { truncated = true; break; }
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push({ name: e.name, path: p, type: "dir", children: walk(path.join(dir, e.name), p, depth + 1) });
      else if (e.isFile()) out.push({ name: e.name, path: p, type: "file", size: fs.statSync(path.join(dir, e.name)).size });
    }
    return out;
  };
  return { tree: walk(ws, "", 0), truncated };
}

const MAX_READ = 1024 * 1024;
export function readFile(ws: string, rel: string) {
  const { abs, rel: r } = safeResolve(ws, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, "File not found");
  const size = fs.statSync(abs).size;
  if (size > MAX_READ) return { path: r, size, binary: false, tooLarge: true, content: "" };
  const buf = fs.readFileSync(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: r, size, binary, tooLarge: false, content: binary ? "" : buf.toString("utf8") };
}

/** True while the worker is running a task in this project (the working tree is on a task branch). */
export async function projectBusy(projectId: number) {
  return (await prisma.agentRun.count({ where: { status: "RUNNING", task: { projectId } } })) > 0;
}

const isEnvFile = (rel: string) => /(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith(".env.example");

/** Writes a file and commits it to main as a CEO edit (agents never commit to main; this is an explicit CEO action). */
export async function writeFileAsCeo(projectId: number, ws: string, rel: string, content: string, author: string) {
  const { rel: r } = safeResolve(ws, rel);
  if (isEnvFile(r)) throw new HttpError(400, "Use the Environment tab to edit .env secrets");
  if (Buffer.byteLength(content) > MAX_READ) throw new HttpError(413, "File too large for the quick editor (1 MB max)");
  if (await projectBusy(projectId)) throw new HttpError(409, "An agent is working in this workspace right now — try again when the run finishes");
  const branch = (await runScript(`cd ${sq(ws)} && git rev-parse --abbrev-ref HEAD`, { timeoutMs: 20_000 })).stdout.trim();
  if (branch !== "main") throw new HttpError(409, `Workspace is on ${branch}, not main — try again in a moment`);
  // Content goes through stdin; the path is quoted; everything runs as the workspace user.
  const author_ = author.replace(/[^\w .@-]/g, "").slice(0, 60) || "CEO";
  const script = [
    `cd ${sq(ws)}`, `mkdir -p "$(dirname ${sq(r)})"`, `cat > ${sq(r)}`,
    `git add -- ${sq(r)}`,
    `if git diff --cached --quiet; then echo NOCHANGE; else git -c user.name=${sq(`Devenum CEO (${author_})`)} -c user.email=ceo@devenum.local commit -q -m ${sq(`CEO edit: ${r}`)} && git rev-parse HEAD; fi`,
  ].join(" && ");
  const res = await runScript(script, { input: content, timeoutMs: 60_000 });
  if (res.code !== 0) throw new HttpError(500, `Save failed: ${(res.stderr || res.stdout).trim().slice(-400)}`);
  const out = res.stdout.trim();
  return { path: r, committed: out !== "NOCHANGE", commit: out === "NOCHANGE" ? null : out.split("\n").pop() ?? null };
}

/* ---------- .env secrets ---------- */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function readEnv(ws: string): { key: string; value: string }[] {
  const file = path.join(ws, ".env");
  if (!fs.existsSync(file)) return [];
  const out: { key: string; value: string }[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
      if (m[2].trim().startsWith('"')) v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out.push({ key: m[1], value: v });
  }
  return out;
}

export async function writeEnv(ws: string, vars: { key: string; value: string }[]) {
  const seen = new Set<string>();
  for (const v of vars) {
    if (!KEY_RE.test(v.key)) throw new HttpError(400, `Invalid variable name: ${v.key}`);
    if (seen.has(v.key)) throw new HttpError(400, `Duplicate variable: ${v.key}`);
    seen.add(v.key);
  }
  const esc = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  const body = `# Managed by Devenum AI (Environment tab). Never committed to git.\n${vars.map(v => `${v.key}=${esc(v.value)}`).join("\n")}\n`;
  const res = await runScript(`cd ${sq(ws)} && umask 077 && cat > .env && chmod 600 .env`, { input: body, timeoutMs: 20_000 });
  if (res.code !== 0) throw new HttpError(500, `Could not write .env: ${res.stderr.trim().slice(-300)}`);
  return vars.length;
}
