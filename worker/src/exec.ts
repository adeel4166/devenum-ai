import { spawn } from "child_process";
import { config } from "./config";

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; durationMs: number }
export interface ExecOptions {
  cwd: string;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

/** POSIX single-quote escaping for `su -c` command strings. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

const SID_MARK = "__DEVENUM_SID__";

/** Signals every process in a session (su's child shell calls setsid, so a process-group kill is not enough). */
function killSession(sid: number, sig: "TERM" | "KILL") {
  try { spawn("pkill", [`-${sig}`, "-s", String(sid)], { stdio: "ignore" }).on("error", () => undefined); } catch { /* ignore */ }
}

/**
 * Runs argv inside cwd. When the worker runs as root, the command is executed as RUN_AS_USER via
 * `su - <user> -c "cd <cwd> && <argv>"` so Claude Code's non-root rules apply and workspace files stay
 * owned by that user. Untrusted text (prompts) must be passed via `input` (stdin), never argv.
 * On timeout/abort — and after normal exit — the whole session is killed so no stray processes survive.
 */
export function run(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const root = isRoot();
  const [cmd, args] = root
    ? ["su", ["-", config.runAsUser, "-c", `echo ${SID_MARK}$$ >&2; cd ${sq(opts.cwd)} && exec ${argv.map(sq).join(" ")}`]]
    : [argv[0], argv.slice(1)];
  const started = Date.now();

  return new Promise(resolve => {
    // detached => setsid, so in non-root mode child.pid is also the session id.
    const child = spawn(cmd, args as string[], { cwd: root ? "/" : opts.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let sid: number | null = root ? null : child.pid ?? null;
    let stdout = "", stderr = "", timedOut = false, aborted = false, done = false;

    const killAll = (sig: "TERM" | "KILL") => {
      if (sid) killSession(sid, sig);
      try { if (child.pid) process.kill(-child.pid, sig === "TERM" ? "SIGTERM" : "SIGKILL"); } catch { /* gone */ }
    };
    const terminate = () => { killAll("TERM"); setTimeout(() => { if (!done) killAll("KILL"); }, 10_000).unref(); };

    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; terminate(); }, opts.timeoutMs) : null;
    const onAbort = () => { aborted = true; terminate(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (b: Buffer) => { const s = b.toString(); stdout += s; opts.onOutput?.(s); });
    child.stderr.on("data", (b: Buffer) => {
      let s = b.toString();
      if (sid === null) {
        const m = (stderr + s).match(new RegExp(`${SID_MARK}(\\d+)\\n`));
        if (m) { sid = Number(m[1]); const all = (stderr + s).replace(m[0], ""); stderr = ""; s = all; }
        else { stderr += s; return; }
      }
      stderr += s; if (s) opts.onOutput?.(s);
    });
    child.stdin.on("error", () => { /* child exited before reading stdin */ });
    child.stdin.end(opts.input ?? "");

    const finish = (code: number | null, extraErr = "") => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (sid) killSession(sid, "KILL"); // reap anything the command left running in the background
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code, stdout, stderr: stderr + extraErr, timedOut, aborted, durationMs: Date.now() - started });
    };
    child.on("error", e => finish(null, `\nspawn error: ${e.message}`));
    child.on("close", code => finish(code));
    // Orphaned grandchildren can hold the pipes open forever; don't wait more than 3s past exit.
    child.on("exit", code => setTimeout(() => finish(code), 3_000).unref());
  });
}

/** Convenience wrapper for short commands (git) that must succeed. */
export async function must(argv: string[], cwd: string): Promise<string> {
  const r = await run(argv, { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`${argv.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  return r.stdout.trim();
}
