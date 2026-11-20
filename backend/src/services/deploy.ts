import { execFile } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { promisify } from "util";
import { prisma } from "../db";
import { HttpError } from "../http";
import { RUN_AS, runScript, sq } from "./exec";
import { publicHost } from "./preview";
import { requireWorkspace } from "./workspace";

const pexec = promisify(execFile);

/**
 * Permanent production deploys: one PM2 process per project named `live-<slug>`, running as the workspace user on a
 * dedicated port in 5201–5299. Only processes with the `live-` prefix are ever created, restarted or deleted here.
 */
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/opt/devenum-ai/deploys";
const PORT_MIN = Number(process.env.LIVE_PORT_MIN || 5201);
const PORT_MAX = Number(process.env.LIVE_PORT_MAX || 5299);
export const liveName = (slug: string) => `live-${slug}`;

const STATIC_SERVER = `import sys, http.server, functools
class H(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if any(p.startswith(".") or p == "node_modules" for p in parts):
            self.send_error(404); return None
        return super().send_head()
    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\\n" % (self.address_string(), fmt % args))
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), functools.partial(H, directory=sys.argv[2])).serve_forever()
`;

const pm2 = (...args: string[]) => pexec("pm2", args, { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });

export async function pm2List(): Promise<{ name: string; pid: number; pm2_env: Record<string, unknown>; monit: { cpu: number; memory: number } }[]> {
  const { stdout } = await pm2("jlist");
  return JSON.parse(stdout);
}

const portFree = (port: number) => new Promise<boolean>(resolve => {
  const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
  s.listen(port, "0.0.0.0");
});
const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const s = net.connect({ port, host: "127.0.0.1" }).once("connect", () => { s.destroy(); resolve(true); }).once("error", () => resolve(false));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
});

async function pickPort(projectId: number, current: number | null, running: boolean) {
  if (current && (running || (await portFree(current)))) return current;
  const taken = new Set((await prisma.project.findMany({ where: { livePort: { not: null }, id: { not: projectId } }, select: { livePort: true } })).map(p => p.livePort));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!taken.has(p) && (await portFree(p))) return p;
  throw new HttpError(503, `No free live port in ${PORT_MIN}-${PORT_MAX}`);
}

interface StartPlan { kind: string; script: string; args: string[] }

function planStart(ws: string, port: number, scripts: Record<string, string>): StartPlan {
  const s = String(port);
  if (scripts.start) {
    const extra = /\bnext\b/.test(scripts.start) ? ["--", "-p", s, "-H", "0.0.0.0"] : /\bvite\b/.test(scripts.start) ? ["--", "--host", "0.0.0.0", "--port", s, "--strictPort"] : [];
    return { kind: "npm start", script: "npm", args: ["run", "start", ...extra] };
  }
  if (scripts.preview && /\bvite\b|\bastro\b/.test(scripts.preview)) return { kind: "npm run preview", script: "npm", args: ["run", "preview", "--", "--host", "0.0.0.0", "--port", s] };
  const dir = ["dist", "build", "out", "public", "docs", ""].map(d => path.join(ws, d)).find(d => fs.existsSync(path.join(d, "index.html")));
  if (dir) return { kind: `static (${path.relative(ws, dir) || "."})`, script: "python3", args: [path.join(DEPLOY_DIR, "static-server.py"), s, dir] };
  throw new HttpError(422, "Nothing to deploy: add a `start` script (or a `build` that outputs index.html) to package.json, or an index.html.");
}

export async function deployProject(projectId: number, progress: (m: string) => void) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new HttpError(404, "Project not found");
  const ws = requireWorkspace(project.slug);
  const name = liveName(project.slug);
  fs.mkdirSync(DEPLOY_DIR, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(DEPLOY_DIR, "static-server.py"), STATIC_SERVER, { mode: 0o644 });

  let scripts: Record<string, string> = {};
  const pkg = path.join(ws, "package.json");
  if (fs.existsSync(pkg)) {
    try { scripts = JSON.parse(fs.readFileSync(pkg, "utf8")).scripts ?? {}; } catch { throw new HttpError(422, "package.json is not valid JSON"); }
    progress("Installing dependencies…");
    const inst = await runScript(`cd ${sq(ws)} && npm install --no-audit --no-fund 2>&1 | tail -30`, { timeoutMs: 600_000 });
    if (inst.code !== 0 || inst.timedOut) throw new HttpError(500, `npm install failed:\n${inst.stdout.slice(-800)}`);
    if (scripts.build) {
      progress("Building for production (npm run build)…");
      const b = await runScript(`cd ${sq(ws)} && NODE_ENV=production npm run build 2>&1; echo "__EXIT__$?"`, { timeoutMs: 900_000 });
      const exit = Number(b.stdout.match(/__EXIT__(\d+)/)?.[1] ?? 1);
      if (exit !== 0 || b.timedOut) throw new HttpError(500, `Build failed:\n${b.stdout.replace(/__EXIT__\d+/, "").slice(-1200)}`);
    }
  }

  const running = (await pm2List()).some(p => p.name === name);
  const port = await pickPort(project.id, project.livePort, running);
  const plan = planStart(ws, port, scripts);
  const config = {
    apps: [{
      name, cwd: ws, script: plan.script, args: plan.args, interpreter: "none", uid: RUN_AS, gid: RUN_AS,
      autorestart: true, max_restarts: 15, restart_delay: 3000, time: true,
      env: { PORT: String(port), HOST: "0.0.0.0", NODE_ENV: "production", HOME: `/home/${RUN_AS}`, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    }],
  };
  const file = path.join(DEPLOY_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o644 });

  progress(`Starting ${name} on port ${port}…`);
  if (running) await pm2("delete", name);
  await pm2("start", file);
  const deadline = Date.now() + 90_000;
  while (!(await portOpen(port))) {
    if (Date.now() > deadline) {
      const logs = await tailPm2Logs(name, 30).catch(() => "");
      await pm2("delete", name).catch(() => undefined);
      throw new HttpError(500, `${name} did not open port ${port} within 90s (it may ignore PORT).\n${logs}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  await pm2("save");
  const url = `http://${publicHost()}:${port}`;
  await prisma.project.update({ where: { id: project.id }, data: { livePort: port, liveUrl: url, liveDeployedAt: new Date() } });
  return { projectId: project.id, projectName: project.name, name, port, url, kind: plan.kind };
}

export async function stopDeploy(projectId: number) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new HttpError(404, "Project not found");
  const name = liveName(project.slug);
  const existed = (await pm2List()).some(p => p.name === name);
  if (existed) { await pm2("delete", name); await pm2("save"); }
  fs.rmSync(path.join(DEPLOY_DIR, `${name}.json`), { force: true });
  await prisma.project.update({ where: { id: project.id }, data: { livePort: null, liveUrl: null, liveDeployedAt: null } });
  return { stopped: existed, name };
}

export async function liveStatus(slug: string) {
  const p = (await pm2List().catch(() => [])).find(x => x.name === liveName(slug));
  return p ? { status: String(p.pm2_env.status), restarts: Number(p.pm2_env.restart_time ?? 0), cpu: p.monit.cpu, memory: p.monit.memory } : null;
}

export async function tailPm2Logs(name: string, lines: number) {
  const p = (await pm2List()).find(x => x.name === name);
  if (!p) throw new HttpError(404, `No PM2 process named ${name}`);
  const read = (f: unknown) => {
    if (typeof f !== "string" || !fs.existsSync(f)) return "";
    const size = fs.statSync(f).size;
    const fd = fs.openSync(f, "r");
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").slice(-lines).join("\n");
  };
  return `===== stdout =====\n${read(p.pm2_env.pm_out_log_path)}\n\n===== stderr =====\n${read(p.pm2_env.pm_err_log_path)}`;
}
