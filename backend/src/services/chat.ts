import { prisma } from "../db";
import { askClaude, ChatResult } from "./claude";

/** Executive Assistant chat shared by the portal (/api/chat) and Discord (/api/bot/chat). Callers own the history. */
export interface ChatTurn { role: "user" | "assistant"; author?: string; content: string }

export const CHAT_HISTORY_LIMIT = 8;
const MAX_CONCURRENT = Number(process.env.CHAT_MAX_CONCURRENT || 3);
let running = 0;

export class ChatBusyError extends Error {
  constructor() { super("The Executive Assistant is handling other conversations — try again in a moment."); }
}

function buildPrompt(assistant: { name: string; roleTitle: string; manifest: unknown } | null, turns: ChatTurn[], author: string, message: string, surface: string) {
  const m = (assistant?.manifest ?? {}) as { notes?: string; prohibitedActions?: string[] };
  const name = assistant?.name ?? "Executive Assistant";
  const transcript = turns.slice(-CHAT_HISTORY_LIMIT)
    .map(t => `${t.role === "user" ? `${t.author ?? "CEO"} (user)` : name}: ${t.content.slice(0, 2000)}`).join("\n\n");
  return `You are the ${name} (${assistant?.roleTitle ?? "General Assistant"}) of Devenum AI, an autonomous virtual software house run by a CEO with a team of AI agents (project manager, architect, UI/UX designer, frontend/backend/mobile/game developers, QA, security, DevOps).
${m.notes ? `Your role: ${m.notes}\n` : ""}${m.prohibitedActions?.length ? `Never: ${m.prohibitedActions.join("; ")}.\n` : ""}
You are chatting in ${surface}. Reply conversationally and concisely in Markdown${surface === "Discord" ? " (no tables; keep it under 1,800 characters unless asked for more)" : ""}. Do not modify files or run commands; answer from your own knowledge. When useful, suggest concrete next steps such as tasks for a specific agent role or an auto-build goal.
${transcript ? `\nRecent conversation (oldest first):\n${transcript}\n` : ""}
New message from ${author}:
${message}

Reply as the ${name}:`;
}

export async function chatReply(message: string, history: ChatTurn[], author: string, surface: "Discord" | "the Devenum AI web portal"): Promise<ChatResult> {
  if (running >= MAX_CONCURRENT) throw new ChatBusyError();
  running++;
  try {
    const assistant = await prisma.agent.findUnique({ where: { slug: process.env.CHAT_AGENT_SLUG || "executive-assistant" } });
    return await askClaude(buildPrompt(assistant, history, author, message, surface), Number(process.env.CHAT_TIMEOUT_MS || 60_000));
  } finally {
    running--;
  }
}
