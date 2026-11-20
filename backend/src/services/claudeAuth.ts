import { Prisma } from "@prisma/client";
import { prisma } from "../db";

/**
 * Claude CLI authentication watchdog state (Setting "claudeAuth"), shared by backend chat, devenum-worker and
 * devenum-bot. A failure is recorded when a *failed* Claude run's output matches AUTH_RE (successful replies that
 * merely talk about "authentication" never count). The bot alerts once per incident; the portal shows a banner.
 */
export const AUTH_RE = /(not logged in|login required|please (run|use) \/login|run `?\/?login`?|claude (auth )?login|invalid (x-)?api[ -]?key|oauth token (has )?expired|token (has )?(expired|been revoked)|authentication[_ ]?(error|failed|required)|unauthori[sz]ed|\b401\b|credentials? (are |have )?(expired|invalid|missing))/i;
export const looksLikeAuthError = (failureOutput: string) => AUTH_RE.test(failureOutput.slice(-4000));

export interface ClaudeAuthState { ok: boolean; detectedAt: string | null; source: string | null; message: string | null; alertedAt: string | null; recoveredAt: string | null; recoveryNotifiedAt: string | null }
const KEY = "claudeAuth";
const EMPTY: ClaudeAuthState = { ok: true, detectedAt: null, source: null, message: null, alertedAt: null, recoveredAt: null, recoveryNotifiedAt: null };

export async function getClaudeAuth(): Promise<ClaudeAuthState> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return { ...EMPTY, ...((row?.value as Partial<ClaudeAuthState> | null) ?? {}) };
}
async function save(s: ClaudeAuthState) {
  const value = s as unknown as Prisma.InputJsonObject;
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

let cachedOk = true; // avoids a DB read on every successful chat (re-checked at most once a minute)
let cachedAt = 0;
export async function reportClaudeAuthFailure(source: string, output: string) {
  const s = await getClaudeAuth();
  cachedOk = false;
  if (!s.ok) return; // already in an incident; keep the first detection
  await save({ ...s, ok: false, detectedAt: new Date().toISOString(), source, message: output.trim().slice(-500), alertedAt: null, recoveredAt: null, recoveryNotifiedAt: null });
}
export async function reportClaudeAuthOk(source: string) {
  if (cachedOk && Date.now() - cachedAt < 60_000) return;
  const s = await getClaudeAuth();
  cachedOk = true; cachedAt = Date.now();
  if (s.ok) return;
  await save({ ...s, ok: true, recoveredAt: new Date().toISOString(), source: `${s.source} → recovered via ${source}` });
}
export async function markAlerted(kind: "failure" | "recovery") {
  const s = await getClaudeAuth();
  await save(kind === "failure" ? { ...s, alertedAt: new Date().toISOString() } : { ...s, recoveryNotifiedAt: new Date().toISOString() });
}
