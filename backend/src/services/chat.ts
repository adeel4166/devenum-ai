import { Agent } from "@prisma/client";
import { prisma } from "../db";
import { HttpError } from "../http";
import { askClaude, ChatResult } from "./claude";

/**
 * Conversational chat with any agent (default: Executive Assistant), shared by the portal (/api/chat) and Discord
 * (/api/bot/chat). The agent answers in its own persona from its manifest. Chat is read-only — agents never change
 * code from a conversation; real work goes through tasks, the QA gate and CEO approval.
 */
export interface ChatTurn { role: "user" | "assistant"; author?: string; content: string }
/** A file the user attached in Discord; `text` is pre-extracted when possible, `path` is readable by Claude. */
export interface ChatAttachment { name: string; path: string; kind: string; size: number; text?: string; truncated?: boolean; note?: string }

export const CHAT_HISTORY_LIMIT = 10;
const MAX_CONCURRENT = Number(process.env.CHAT_MAX_CONCURRENT || 3);
let running = 0;

export class ChatBusyError extends Error {
  constructor() { super("The team is handling other conversations — try again in a moment."); }
}

export async function chatAgent(slug?: string) {
  const agent = await prisma.agent.findUnique({ where: { slug: slug || process.env.CHAT_AGENT_SLUG || "executive-assistant" } });
  if (!agent) throw new HttpError(404, `No agent "${slug}"`);
  return agent;
}

export function attachmentBlock(files: ChatAttachment[], dir?: string) {
  if (!files.length) return "";
  const parts = files.map(f => {
    const head = `<file name="${f.name.replace(/"/g, "'")}" type="${f.kind}" bytes="${f.size}" path="${f.path}">`;
    if (f.text) return `${head}\n${f.text}${f.truncated ? "\n[… content truncated; read the full file at its path if needed]" : ""}\n</file>`;
    return `${head}\n[${f.note ?? "No text extracted"} — read this file directly with your Read tool at the path above.]\n</file>`;
  });
  return `\nThe user attached ${files.length} file(s)${dir ? `, saved in ${dir} (you may read them with your Read tool)` : ""}. Base your answer on their actual contents:\n${parts.join("\n\n")}\n`;
}

export function personaHeader(agent: Agent) {
  const m = (agent.manifest ?? {}) as { notes?: string; prohibitedActions?: string[]; allowedTools?: string[] };
  return `You are the ${agent.name} (${agent.roleTitle}, ${agent.department} department) of Devenum AI, an autonomous virtual software house run by a CEO with a team of AI agents: Project Manager, Software Architect, UI/UX Designer, Frontend/Backend/Mobile/Game Developers, QA Engineer, Security Engineer, DevOps Engineer and an Executive Assistant.
${m.notes ? `Your role: ${m.notes}\n` : ""}${m.allowedTools?.length ? `Your capabilities in task runs: ${m.allowedTools.join(", ")}.\n` : ""}${m.prohibitedActions?.length ? `Hard rules: never ${m.prohibitedActions.join("; never ")}.\n` : ""}Speak as this specialist, from your own expertise and point of view.`;
}

export function chatRules(surface: string) {
  return `You are chatting with the CEO in ${surface}. Reply conversationally in Markdown${surface === "Discord" ? " (no tables)" : ""}. This is a conversation, not a task run: do not modify files or run commands. If the CEO wants real work done, say which task you (or a teammate) would take on, or suggest asking the Project Manager to plan it — all code changes go through task branches, an automated QA gate, and CEO approval before reaching main. For deep-research or document-analysis requests, be thorough and well structured.`;
}

export function transcript(turns: ChatTurn[], agentName: string) {
  const t = turns.slice(-CHAT_HISTORY_LIMIT)
    .map(x => `${x.role === "user" ? `${x.author ?? "CEO"} (user)` : agentName}: ${x.content.slice(0, 2000)}`).join("\n\n");
  return t ? `\nRecent conversation (oldest first):\n${t}\n` : "";
}

export async function withChatSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) throw new ChatBusyError();
  running++;
  try { return await fn(); } finally { running--; }
}

export async function chatReply(
  message: string, history: ChatTurn[], author: string, surface: "Discord" | "the Devenum AI web portal",
  files: ChatAttachment[] = [], dir?: string, agentSlug?: string,
): Promise<ChatResult> {
  const agent = await chatAgent(agentSlug);
  const prompt = `${personaHeader(agent)}
${chatRules(surface)}
${transcript(history, agent.name)}${attachmentBlock(files, dir)}
New message from ${author}:
${message || "(no text — please analyse the attached file(s))"}

Reply as the ${agent.name}:`;
  // 5 minutes by default so deep-research prompts and document analysis can finish.
  return withChatSlot(() => askClaude(prompt, Number(process.env.CHAT_TIMEOUT_MS || 300_000), { addDirs: dir ? [dir] : [] }));
}
