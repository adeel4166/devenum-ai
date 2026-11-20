import type { AgentRow } from "./api";
import { askClaude, ChatResult } from "./claude";

/** Short in-memory, per-channel conversation history so multi-turn chat works. Lost on restart by design. */
interface Turn { role: "user" | "assistant"; author: string; content: string }
const HISTORY_LIMIT = 8;
const history = new Map<string, Turn[]>();

const MAX_CONCURRENT = Number(process.env.CHAT_MAX_CONCURRENT || 2);
let running = 0;

function remember(channelId: string, turn: Turn) {
  const h = history.get(channelId) ?? [];
  h.push({ ...turn, content: turn.content.slice(0, 2000) });
  while (h.length > HISTORY_LIMIT) h.shift();
  history.set(channelId, h);
}

export const clearHistory = (channelId: string) => history.delete(channelId);

function buildPrompt(assistant: AgentRow | undefined, turns: Turn[], author: string, message: string) {
  const m = (assistant?.manifest ?? {}) as { notes?: string; prohibitedActions?: string[] };
  const name = assistant?.name ?? "Executive Assistant";
  const transcript = turns.map(t => `${t.role === "user" ? `${t.author} (user)` : name}: ${t.content}`).join("\n\n");
  return `You are the ${name} (${assistant?.roleTitle ?? "General Assistant"}) of Devenum AI, an autonomous virtual software house run by a CEO with a team of AI agents (project manager, architect, designer, frontend/backend/mobile/game developers, QA, security, DevOps).
${m.notes ? `Your role: ${m.notes}\n` : ""}${m.prohibitedActions?.length ? `Never: ${m.prohibitedActions.join("; ")}.\n` : ""}
You are chatting inside Discord. Reply conversationally and concisely in Discord Markdown (no tables; short headings and bullets are fine). Keep the reply under 1,800 characters unless the user explicitly asks for something long. Do not modify files or run commands; answer from your own knowledge. When useful, suggest concrete next steps such as \`/task-add\` tasks for a specific agent role.
${transcript ? `\nRecent conversation in this channel (oldest first):\n${transcript}\n` : ""}
New message from ${author}:
${message}

Reply as the ${name}:`;
}

/** Runs one chat turn. Returns null when too many chats are already running. */
export async function chat(channelId: string, author: string, message: string, assistant: AgentRow | undefined): Promise<ChatResult | null> {
  if (running >= MAX_CONCURRENT) return null;
  running++;
  try {
    const prompt = buildPrompt(assistant, history.get(channelId) ?? [], author, message);
    const r = await askClaude(prompt, Number(process.env.CHAT_TIMEOUT_MS || 60_000));
    if (r.ok) {
      remember(channelId, { role: "user", author, content: message });
      remember(channelId, { role: "assistant", author: "assistant", content: r.text });
    }
    return r;
  } finally {
    running--;
  }
}

/** Splits text into Discord-sized (≤2000 char) chunks, preferring line breaks. */
export function chunks(text: string, size = 1900): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
