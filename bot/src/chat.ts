import type { Attachment } from "discord.js";
import type { BackendApi, ChatTurn, TeamPlan } from "./api";
import { downloadAttachments } from "./attachments";

/** Short-term memory per channel + agent (last 10 messages) for Discord chat; the backend runs the actual Claude call. */
const HISTORY_LIMIT = 10;
const history = new Map<string, ChatTurn[]>();

function remember(key: string, turn: ChatTurn) {
  const h = history.get(key) ?? [];
  h.push({ ...turn, content: turn.content.slice(0, 2000) });
  while (h.length > HISTORY_LIMIT) h.shift();
  history.set(key, h);
}

export interface ChatOutcome { reply: string; filesUsed: string[]; skipped: string[]; plan: TeamPlan | null }

/**
 * Downloads any attachments to /tmp/devenum-chat-<ts>/, asks the chosen agent (the Project Manager may also return a
 * team plan), and always cleans the folder up. Memory is kept per channel AND agent.
 */
export async function chat(api: BackendApi, channelId: string, author: string, message: string, attachments: Attachment[] = [], agentSlug = "executive-assistant"): Promise<ChatOutcome> {
  const key = `${channelId}:${agentSlug}`;
  const dl = await downloadAttachments(attachments);
  try {
    const files = dl?.files ?? [];
    const dir = files.length ? dl!.dir : undefined;
    const r = agentSlug === "project-manager"
      ? await api.pmChat(message, history.get(key) ?? [], author, files, dir)
      : { ...(await api.chat(message, history.get(key) ?? [], author, files, dir, agentSlug)), plan: null };
    const names = files.map(f => f.name);
    remember(key, { role: "user", author, content: `${message}${names.length ? `\n[attached: ${names.join(", ")}]` : ""}` });
    remember(key, { role: "assistant", content: `${r.reply}${r.plan ? `\n[proposed team plan #${r.plan.id}: ${r.plan.tasks.length} tasks]` : ""}` });
    return { reply: r.reply, filesUsed: names, skipped: dl?.skipped ?? [], plan: r.plan };
  } finally {
    dl?.cleanup();
  }
}

/** Splits text into Discord-sized chunks (<1900 chars), preferring paragraph/line breaks and keeping code fences balanced. */
export function chunks(text: string, size = 1900): string[] {
  const out: string[] = [];
  let rest = text.trim();
  let openFence: string | null = null;
  while (rest.length) {
    const budget = size - (openFence ? openFence.length + 1 : 0) - 4;
    let piece: string;
    if (rest.length <= budget) { piece = rest; rest = ""; }
    else {
      let cut = rest.lastIndexOf("\n\n", budget);
      if (cut < budget * 0.5) cut = rest.lastIndexOf("\n", budget);
      if (cut < budget * 0.5) cut = rest.lastIndexOf(" ", budget);
      if (cut < budget * 0.5) cut = budget;
      piece = rest.slice(0, cut);
      rest = rest.slice(cut).replace(/^\s*\n/, "");
    }
    let chunk = (openFence ? `${openFence}\n` : "") + piece;
    const fences = piece.match(/^```.*$/gm) ?? [];
    let fenceOpenAfter: string | null = openFence;
    for (const f of fences) fenceOpenAfter = fenceOpenAfter ? null : f.trim();
    if (fenceOpenAfter && rest) chunk += "\n```";
    openFence = rest ? fenceOpenAfter : null;
    out.push(chunk);
  }
  return out.length ? out : ["(empty reply)"];
}
