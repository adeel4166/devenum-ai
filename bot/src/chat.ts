import type { BackendApi, ChatTurn } from "./api";

/** Per-channel short-term memory (last 8 messages) for Discord chat; the backend runs the actual Claude call. */
const HISTORY_LIMIT = 8;
const history = new Map<string, ChatTurn[]>();

function remember(channelId: string, turn: ChatTurn) {
  const h = history.get(channelId) ?? [];
  h.push({ ...turn, content: turn.content.slice(0, 2000) });
  while (h.length > HISTORY_LIMIT) h.shift();
  history.set(channelId, h);
}

export async function chat(api: BackendApi, channelId: string, author: string, message: string): Promise<string> {
  const r = await api.chat(message, history.get(channelId) ?? [], author);
  remember(channelId, { role: "user", author, content: message });
  remember(channelId, { role: "assistant", content: r.reply });
  return r.reply;
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
