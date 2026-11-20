import { Prisma } from "@prisma/client";
import { config, log, prisma } from "./config";
import { run } from "./exec";

/**
 * Claude CLI auth watchdog for the worker. Shares Setting "claudeAuth" with backend/src/services/claudeAuth.ts
 * (keep AUTH_RE identical). While the session is expired the worker claims no new tasks; every 5 minutes it checks
 * `claude auth status` (when healthy) or runs a tiny probe prompt (when broken) to detect recovery.
 */
export const AUTH_RE = /(not logged in|login required|please (run|use) \/login|run `?\/?login`?|claude (auth )?login|invalid (x-)?api[ -]?key|oauth token (has )?expired|token (has )?(expired|been revoked)|authentication[_ ]?(error|failed|required)|unauthori[sz]ed|\b401\b|credentials? (are |have )?(expired|invalid|missing))/i;
export const looksLikeAuthError = (failureOutput: string) => AUTH_RE.test(failureOutput.slice(-4000));

const KEY = "claudeAuth";
type State = { ok: boolean; detectedAt: string | null; source: string | null; message: string | null; alertedAt: string | null; recoveredAt: string | null; recoveryNotifiedAt: string | null };
const EMPTY: State = { ok: true, detectedAt: null, source: null, message: null, alertedAt: null, recoveredAt: null, recoveryNotifiedAt: null };

async function get(): Promise<State> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return { ...EMPTY, ...((row?.value as Partial<State> | null) ?? {}) };
}
async function save(s: State) {
  const value = s as unknown as Prisma.InputJsonObject;
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

export async function claudeAuthOk() { return (await get()).ok; }

export async function reportAuthFailure(source: string, output: string) {
  const s = await get();
  if (!s.ok) return;
  await save({ ...s, ok: false, detectedAt: new Date().toISOString(), source, message: output.trim().slice(-500), alertedAt: null, recoveredAt: null, recoveryNotifiedAt: null });
  log("error", "Claude CLI authentication failure detected — task claiming paused until re-login", { source });
}

async function reportAuthOk(source: string) {
  const s = await get();
  if (s.ok) return;
  await save({ ...s, ok: true, recoveredAt: new Date().toISOString(), source: `${s.source} → recovered via ${source}` });
  log("info", "Claude CLI authentication recovered", { source });
}

let lastCheck = 0;
export async function authWatchdog() {
  if (Date.now() - lastCheck < 5 * 60_000) return;
  lastCheck = Date.now();
  const s = await get();
  if (s.ok) {
    // Cheap local check (no tokens): catches a logged-out CLI before a task fails on it.
    const r = await run([config.claudeBin, "auth", "status", "--json"], { cwd: config.workspacesDir, timeoutMs: 30_000 });
    try {
      if (JSON.parse(r.stdout).loggedIn === false) await reportAuthFailure("auth status check", "claude auth status: loggedIn=false");
    } catch { /* unparseable output — ignore; real failures are caught from task runs */ }
  } else {
    // Recovery probe: a tiny real request, because `auth status` can say loggedIn while the token is rejected.
    const r = await run([config.claudeBin, "-p", "--output-format", "text"], { cwd: config.workspacesDir, input: "Reply with exactly: OK", timeoutMs: 90_000 });
    if (r.code === 0 && /\bOK\b/.test(r.stdout)) await reportAuthOk("worker probe");
  }
}
