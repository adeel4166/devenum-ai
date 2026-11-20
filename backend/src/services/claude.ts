import { runScript, sq } from "./exec";
import { looksLikeAuthError, reportClaudeAuthFailure, reportClaudeAuthOk } from "./claudeAuth";

/**
 * One-shot conversational Claude Code query, run as the workspace user inside an empty scratch directory.
 * Unlike devenum-worker it does NOT pass --dangerously-skip-permissions, so tools needing approval (edits, shell)
 * are denied: chat and planning can reason and answer, but cannot change files. The prompt goes through stdin.
 */
export interface ChatResult { ok: boolean; text: string; timedOut: boolean; ms: number }

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CHAT_MODEL = process.env.CHAT_CLAUDE_MODEL || "";

/** Extra read-only directories (chat attachment folders) are limited to /tmp/devenum-chat-* to keep access narrow. */
const ADD_DIR_RE = /^\/tmp\/devenum-chat-\d+(-[a-z0-9]+)?$/;

/** Read-only research toolset for conversations: local reading (scratch + attachment dirs only) plus live web access. */
export const CHAT_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];

export async function askClaude(prompt: string, timeoutMs = 60_000, opts: { addDirs?: string[]; allowedTools?: string[] } = {}): Promise<ChatResult> {
  const dirs = (opts.addDirs ?? []).filter(d => ADD_DIR_RE.test(d));
  const tools = (opts.allowedTools ?? []).filter(t => /^[A-Za-z]+$/.test(t));
  const argv = [CLAUDE_BIN, "-p", "--output-format", "text", ...(CHAT_MODEL ? ["--model", CHAT_MODEL] : []),
    ...(tools.length ? ["--allowedTools", tools.join(",")] : []), ...(dirs.length ? ["--add-dir", ...dirs] : [])];
  const r = await runScript(`mkdir -p ~/devenum-chat && cd ~/devenum-chat && exec ${argv.map(sq).join(" ")}`, { input: prompt, timeoutMs });
  const out = r.stdout.trim();
  if (r.timedOut) return { ok: false, text: out, timedOut: true, ms: r.ms };
  if (r.code !== 0 || !out) {
    const failure = `${r.stderr}\n${out}`;
    if (looksLikeAuthError(failure)) {
      await reportClaudeAuthFailure("chat", failure).catch(() => undefined);
      return { ok: false, text: "Claude CLI session expired — run /claude-login in Discord to reconnect.", timedOut: false, ms: r.ms };
    }
    return { ok: false, text: (r.stderr.trim() || out || `exit code ${r.code}`).slice(-500), timedOut: false, ms: r.ms };
  }
  await reportClaudeAuthOk("chat").catch(() => undefined);
  return { ok: true, text: out, timedOut: false, ms: r.ms };
}
