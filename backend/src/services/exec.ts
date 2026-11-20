import { spawn } from "child_process";
import fs from "fs";

/**
 * Process helpers for running things as the unprivileged workspace user (default "devenum").
 * When the bot runs as root we use `su - <user> -c "<script>"`. su's child shell calls setsid, so every command
 * reports its session id ($$) and we kill by session — that catches everything it spawned.
 */
export const RUN_AS = process.env.RUN_AS_USER || "devenum";
export const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/opt/devenum-ai/workspaces";
const SID_MARK = "__DEVENUM_SID__";

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const isRoot = () => process.getuid?.() === 0;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,190}$/;

export function workspacePath(slug: string) {
  if (!SLUG_RE.test(slug)) throw new Error(`Unsafe project slug "${slug}"`);
  return `${WORKSPACES_DIR}/${slug}`;
}
export const workspaceExists = (slug: string) => fs.existsSync(`${workspacePath(slug)}/.git`) || fs.existsSync(workspacePath(slug));

export function killSession(sid: number, sig: "TERM" | "KILL") {
  try { spawn("pkill", [`-${sig}`, "-u", RUN_AS, "-s", String(sid)], { stdio: "ignore" }).on("error", () => undefined); } catch { /* ignore */ }
}

/** Wraps a shell script so it runs as RUN_AS (when root) and announces its session id first. */
function wrap(script: string): [string, string[]] {
  const inner = `echo ${SID_MARK}$$ >&2; ${script}`;
  return isRoot() ? ["su", ["-", RUN_AS, "-c", inner]] : ["bash", ["-c", inner]];
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; ms: number }

/** Runs a shell script as RUN_AS and waits for it. Secrets/prompts go through `input` (stdin), never the script. */
export function runScript(script: string, opts: { input?: string; timeoutMs: number }): Promise<RunResult> {
  const [cmd, args] = wrap(script);
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: "/", detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let sid: number | null = null, out = "", err = "", timedOut = false, done = false;
    const killAll = (sig: "TERM" | "KILL") => {
      if (sid) killSession(sid, sig);
      try { if (child.pid) process.kill(-child.pid, sig === "TERM" ? "SIGTERM" : "SIGKILL"); } catch { /* gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killAll("TERM"); setTimeout(() => { if (!done) killAll("KILL"); }, 5_000).unref(); }, opts.timeoutMs);
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
      if (sid === null) {
        const m = err.match(new RegExp(`${SID_MARK}(\\d+)\\n`));
        if (m) { sid = Number(m[1]); err = err.replace(m[0], ""); }
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sid) killSession(sid, "KILL");
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, stdout: out, stderr: err, timedOut, ms: Date.now() - started });
    };
    child.on("error", e => { err += e.message; finish(null); });
    child.on("close", code => finish(code));
    child.on("exit", code => setTimeout(() => finish(code), 2_000).unref());
  });
}

/**
 * Starts a long-running script as RUN_AS, detached from the bot, with output appended to logFile.
 * Resolves with the session id once the shell has announced it.
 */
export async function spawnService(script: string, logFile: string): Promise<{ sid: number; pid: number }> {
  fs.writeFileSync(logFile, "");
  const fd = fs.openSync(logFile, "a");
  const [cmd, args] = wrap(script);
  // setsid -f double-forks, so the service is re-parented to init and survives a PM2 restart of the backend.
  const child = spawn("setsid", ["-f", cmd, ...args], { cwd: "/", detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  child.unref();
  for (let i = 0; i < 50; i++) {
    const m = fs.readFileSync(logFile, "utf8").match(new RegExp(`${SID_MARK}(\\d+)`));
    if (m) return { sid: Number(m[1]), pid: child.pid ?? 0 };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Preview process did not start");
}

/** True if any RUN_AS process is still alive in that session. */
export async function sessionAlive(sid: number): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn("pgrep", ["-u", RUN_AS, "-s", String(sid)], { stdio: "ignore" });
    p.on("close", code => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}
