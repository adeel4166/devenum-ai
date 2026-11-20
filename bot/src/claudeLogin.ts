import { ChildProcess, spawn } from "child_process";

/**
 * Headless Claude CLI re-login for the workspace user (default "devenum"), driven from Discord:
 *   start()  → spawns `claude auth login`, returns the OAuth URL it prints
 *   submit() → writes the code the CEO pasted after signing in, waits for the CLI to finish, then verifies
 *              `claude auth status --json`.
 * One session at a time; sessions expire after 10 minutes. The login link is only ever shown ephemerally.
 */
const RUN_AS = process.env.CHAT_RUN_AS_USER || process.env.RUN_AS_USER || "devenum";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const asUser = (args: string[]) => (process.getuid?.() === 0 ? ["runuser", ["-u", RUN_AS, "--", "env", `HOME=/home/${RUN_AS}`, CLAUDE_BIN, ...args]] as const : [CLAUDE_BIN, args] as const);

interface Session { id: number; proc: ChildProcess; output: string; url: string; startedBy: string; timer: NodeJS.Timeout; exited: Promise<number | null> }
let current: Session | null = null;
let nextId = 1;

function end(s: Session) {
  clearTimeout(s.timer);
  if (s.proc.exitCode === null) s.proc.kill("SIGTERM");
  if (current?.id === s.id) current = null;
}

export async function authStatus(): Promise<{ loggedIn: boolean; email?: string; subscriptionType?: string }> {
  const [cmd, args] = asUser(["auth", "status", "--json"]);
  return new Promise(resolve => {
    const p = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", b => (out += b));
    const t = setTimeout(() => p.kill("SIGKILL"), 30_000);
    p.on("close", () => { clearTimeout(t); try { resolve(JSON.parse(out)); } catch { resolve({ loggedIn: false }); } });
    p.on("error", () => { clearTimeout(t); resolve({ loggedIn: false }); });
  });
}

export async function startLogin(startedBy: string): Promise<{ id: number; url: string }> {
  if (current) end(current); // a new request supersedes an abandoned one
  const [cmd, args] = asUser(["auth", "login", "--claudeai"]);
  const proc = spawn(cmd, [...args], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });
  const s: Session = {
    id: nextId++, proc, output: "", url: "", startedBy,
    timer: setTimeout(() => end(s), 10 * 60_000),
    exited: new Promise(res => proc.on("close", code => res(code))),
  };
  current = s;
  const onData = (b: Buffer) => { s.output += b.toString(); };
  proc.stdout!.on("data", onData);
  proc.stderr!.on("data", onData);
  proc.stdin!.on("error", () => undefined);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const m = s.output.match(/https:\/\/\S+oauth\/authorize\S+/);
    if (m) { s.url = m[0]; return { id: s.id, url: s.url }; }
    if (proc.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const out = s.output.trim().slice(-300);
  end(s);
  throw new Error(`claude auth login did not produce a login link${out ? `: ${out}` : ""}`);
}

export async function submitCode(id: number, code: string): Promise<{ loggedIn: boolean; email?: string; detail: string }> {
  const s = current;
  if (!s || s.id !== id) throw new Error("This login session has expired — run /claude-login again.");
  const clean = code.trim();
  if (!/^[\w#.\-~]{8,512}$/.test(clean)) throw new Error("That doesn't look like a valid authorization code. Copy the full code shown after signing in.");
  s.proc.stdin!.write(`${clean}\n`);
  const code_ = await Promise.race([s.exited, new Promise<"timeout">(r => setTimeout(() => r("timeout"), 60_000))]);
  const detail = s.output.replace(/https:\/\/\S+/g, "<link>").trim().split("\n").slice(-3).join(" ").slice(0, 300);
  end(s);
  const st = await authStatus();
  if (code_ === "timeout" && !st.loggedIn) throw new Error("The CLI did not confirm the login within 60 s. Run /claude-login again.");
  return { loggedIn: !!st.loggedIn, email: st.email, detail };
}
