import { spawn } from "child_process";

/**
 * Runs a one-shot conversational Claude Code query. When the bot runs as root the CLI runs as
 * CHAT_RUN_AS_USER via `su - <user> -c`, inside an empty scratch directory. Unlike devenum-worker it does
 * NOT pass --dangerously-skip-permissions, so tools that need approval (edits, shell) are denied: chat
 * can answer and reason, but cannot change files. The prompt goes through stdin, never the command line.
 */
export interface ChatResult { ok: boolean; text: string; timedOut: boolean; ms: number }

const RUN_AS = process.env.CHAT_RUN_AS_USER || "devenum";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CHAT_MODEL = process.env.CHAT_CLAUDE_MODEL || "";
const SID_MARK = "__DEVENUM_SID__";
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const isRoot = () => process.getuid?.() === 0;

/** su's child shell calls setsid, so kill by session to catch everything Claude spawned. */
const killSession = (sid: number, sig: "TERM" | "KILL") => {
  try { spawn("pkill", [`-${sig}`, "-s", String(sid)], { stdio: "ignore" }).on("error", () => undefined); } catch { /* ignore */ }
};

export function askClaude(prompt: string, timeoutMs = 60_000): Promise<ChatResult> {
  const argv = [CLAUDE_BIN, "-p", "--output-format", "text"];
  if (CHAT_MODEL) argv.push("--model", CHAT_MODEL);
  // Scratch dir in the run-as user's home; created on demand.
  const inner = `echo ${SID_MARK}$$ >&2; mkdir -p ~/devenum-chat && cd ~/devenum-chat && exec ${argv.map(sq).join(" ")}`;
  const [cmd, args] = isRoot() ? ["su", ["-", RUN_AS, "-c", inner]] : ["bash", ["-c", inner]];
  const started = Date.now();

  return new Promise(resolve => {
    const child = spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let sid: number | null = null, out = "", err = "", timedOut = false, done = false;

    const killAll = (sig: "TERM" | "KILL") => {
      if (sid) killSession(sid, sig);
      try { if (child.pid) process.kill(-child.pid, sig === "TERM" ? "SIGTERM" : "SIGKILL"); } catch { /* gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killAll("TERM"); setTimeout(() => { if (!done) killAll("KILL"); }, 5_000).unref(); }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString();
      if (sid === null) {
        const m = err.match(new RegExp(`${SID_MARK}(\\d+)\\n`));
        if (m) { sid = Number(m[1]); err = err.replace(m[0], ""); }
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sid) killSession(sid, "KILL");
      child.stdout.destroy(); child.stderr.destroy();
      const ms = Date.now() - started;
      if (timedOut) return resolve({ ok: false, text: out.trim(), timedOut, ms });
      if (code !== 0 || !out.trim()) return resolve({ ok: false, text: (err.trim() || out.trim() || `exit code ${code}`).slice(-500), timedOut, ms });
      resolve({ ok: true, text: out.trim(), timedOut, ms });
    };
    child.on("error", e => { err += e.message; finish(null); });
    child.on("close", code => finish(code));
    child.on("exit", code => setTimeout(() => finish(code), 2_000).unref());
  });
}
