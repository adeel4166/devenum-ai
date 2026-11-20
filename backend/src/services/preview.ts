import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { killSession, runScript, sessionAlive, spawnService, sq, workspacePath } from "./exec";

/** Live preview servers per project. Persisted so a bot restart re-adopts running previews instead of losing them. */
export interface Preview { projectId: number; slug: string; port: number; sid: number; url: string; kind: string; startedAt: string }

const STATE_FILE = process.env.PREVIEW_STATE_FILE || path.resolve(process.cwd(), ".previews.json");
const PORT_MIN = Number(process.env.PREVIEW_PORT_MIN || 5101);
const PORT_MAX = Number(process.env.PREVIEW_PORT_MAX || 5199);
const previews = new Map<number, Preview>();

const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify([...previews.values()], null, 2), { mode: 0o600 });
export const listPreviews = () => [...previews.values()];
export const getPreview = (projectId: number) => previews.get(projectId);

export async function restorePreviews() {
  let rows: Preview[] = [];
  try { rows = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return; }
  for (const p of rows) if (await sessionAlive(p.sid)) previews.set(p.projectId, p);
  save();
}

/** Public host for URLs: PREVIEW_PUBLIC_HOST, else the first non-private IPv4 on this machine. */
export function publicHost(): string {
  if (process.env.PREVIEW_PUBLIC_HOST) return process.env.PREVIEW_PUBLIC_HOST;
  const priv = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  const addrs = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a!.address);
  return addrs.find(a => !priv.test(a)) ?? addrs[0] ?? "127.0.0.1";
}

const portFree = (port: number) => new Promise<boolean>(resolve => {
  const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
  s.listen(port, "0.0.0.0");
});
const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const s = net.connect({ port, host: "127.0.0.1" }).once("connect", () => { s.destroy(); resolve(true); }).once("error", () => resolve(false));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
});

async function pickPort() {
  const used = new Set([...previews.values()].map(p => p.port));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!used.has(p) && (await portFree(p))) return p;
  throw new Error(`No free preview port in ${PORT_MIN}-${PORT_MAX}`);
}

// Static server that refuses dotfiles (.git, .env…) and node_modules so they are never exposed publicly.
const STATIC_SERVER = `import sys, http.server, functools
class H(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if any(p.startswith(".") or p == "node_modules" for p in parts):
            self.send_error(404); return None
        return super().send_head()
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), functools.partial(H, directory=sys.argv[2])).serve_forever()`;

interface Plan { kind: string; script: string; needsInstall: boolean }

function plan(ws: string, port: number): Plan {
  const pkgPath = path.join(ws, "package.json");
  if (fs.existsSync(pkgPath)) {
    let pkg: { scripts?: Record<string, string> } = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { /* fall through to static */ }
    const scripts = pkg.scripts ?? {};
    const name = ["dev", "start", "preview", "serve"].find(s => scripts[s]);
    if (name) {
      const body = scripts[name];
      const extra = /\bvite\b/.test(body) ? ` -- --host 0.0.0.0 --port ${port} --strictPort`
        : /\bnext\b/.test(body) ? ` -- -H 0.0.0.0 -p ${port}`
        : /\bastro\b/.test(body) ? ` -- --host 0.0.0.0 --port ${port}` : "";
      return {
        kind: `npm run ${name}`, needsInstall: !fs.existsSync(path.join(ws, "node_modules")),
        script: `cd ${sq(ws)} && export PORT=${port} HOST=0.0.0.0 BROWSER=none CI=true && exec npm run ${sq(name)}${extra}`,
      };
    }
  }
  const dir = ["", "dist", "build", "public", "docs", "out"].map(d => path.join(ws, d)).find(d => fs.existsSync(path.join(d, "index.html")));
  if (dir) return { kind: `static (${path.relative(ws, dir) || "."})`, needsInstall: false, script: `exec python3 -c ${sq(STATIC_SERVER)} ${port} ${sq(dir)}` };
  throw new Error("Nothing to preview: no package.json dev/start/preview script and no index.html in the workspace (., dist, build, public, docs, out).");
}

const tail = (file: string) => { try { return fs.readFileSync(file, "utf8").replace(/__DEVENUM_SID__\d+\n?/, "").trim().slice(-800); } catch { return ""; } };

export async function startPreview(projectId: number, slug: string, onProgress?: (msg: string) => Promise<unknown>): Promise<Preview> {
  const ws = workspacePath(slug);
  if (!fs.existsSync(ws)) throw new Error(`Workspace ${ws} does not exist yet — run a task for this project first.`);
  await stopPreview(projectId);
  const port = await pickPort();
  const p = plan(ws, port);

  if (p.needsInstall) {
    await onProgress?.("📦 Installing dependencies (`npm install`) — this can take a few minutes…");
    const r = await runScript(`cd ${sq(ws)} && npm install --no-audit --no-fund 2>&1`, { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`npm install failed${r.timedOut ? " (timed out)" : ""}:\n${(r.stdout + r.stderr).trim().slice(-800)}`);
  }

  await onProgress?.(`🚀 Starting \`${p.kind}\` on port ${port}…`);
  const log = `/tmp/devenum-preview-${slug}.log`;
  const { sid } = await spawnService(p.script, log);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      const preview: Preview = { projectId, slug, port, sid, url: `http://${publicHost()}:${port}`, kind: p.kind, startedAt: new Date().toISOString() };
      previews.set(projectId, preview);
      save();
      return preview;
    }
    if (!(await sessionAlive(sid))) throw new Error(`Preview server exited before listening on ${port}:\n${tail(log)}`);
    await new Promise(r => setTimeout(r, 1500));
  }
  killSession(sid, "KILL");
  throw new Error(`Preview server did not open port ${port} within 120s. It may ignore PORT/--port.\n${tail(log)}`);
}

export async function stopPreview(projectId: number): Promise<Preview | null> {
  const p = previews.get(projectId);
  if (!p) return null;
  killSession(p.sid, "TERM");
  await new Promise(r => setTimeout(r, 1500));
  if (await sessionAlive(p.sid)) killSession(p.sid, "KILL");
  previews.delete(projectId);
  save();
  return p;
}
