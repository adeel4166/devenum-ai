import {
  ActionRowBuilder, ButtonBuilder, CategoryChannel, ChannelType, EmbedBuilder, Guild, GuildTextBasedChannel, PermissionFlagsBits, TextChannel, Webhook,
} from "discord.js";
import type { AgentRow } from "./api";

/** Agent identity in Discord: emoji badge, avatar URL, @aliases, and the department channels each agent owns. */
export const BADGE: Record<string, string> = {
  "project-manager": "🧭", "software-architect": "🏛", "ui-ux-designer": "🎨", "frontend-developer": "🖥", "backend-developer": "🗄",
  "mobile-developer": "📱", "game-developer": "🎮", "qa-engineer": "🧪", "security-engineer": "🛡", "devops-engineer": "🚀", "executive-assistant": "✨",
};

const ALIASES: Record<string, string> = {
  pm: "project-manager", projectmanager: "project-manager", manager: "project-manager",
  architect: "software-architect", softwarearchitect: "software-architect", sa: "software-architect",
  designer: "ui-ux-designer", ux: "ui-ux-designer", ui: "ui-ux-designer", uiux: "ui-ux-designer",
  frontend: "frontend-developer", fe: "frontend-developer", frontenddeveloper: "frontend-developer", frontendengineer: "frontend-developer",
  backend: "backend-developer", be: "backend-developer", backenddeveloper: "backend-developer", backendengineer: "backend-developer",
  mobile: "mobile-developer", game: "game-developer", gamedev: "game-developer",
  qa: "qa-engineer", tester: "qa-engineer", qaengineer: "qa-engineer",
  security: "security-engineer", sec: "security-engineer", securityengineer: "security-engineer",
  devops: "devops-engineer", ops: "devops-engineer", devopsengineer: "devops-engineer",
  assistant: "executive-assistant", ea: "executive-assistant", executiveassistant: "executive-assistant",
};

/**
 * One channel per active agent, named after its slug (e.g. #ui-ux-designer, #devops-engineer) and built from the
 * agents in MySQL — new agents get a channel on the next sync. #general (and DISCORD_CHAT_CHANNELS) go to the
 * Executive Assistant; a few legacy department names keep routing for backwards compatibility.
 */
export interface TeamChannel { name: string; slug: string; topic: string }
const LEGACY_CHANNELS: Record<string, string> = {
  general: "executive-assistant", "backend-engineering": "backend-developer", "frontend-engineering": "frontend-developer", "qa-and-security": "qa-engineer",
};
const channelName = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);

export function teamChannels(agents: AgentRow[]): TeamChannel[] {
  return agents.filter(a => a.status !== "DISABLED").map(a => {
    const notes = (a.manifest as { notes?: string } | null)?.notes ?? "";
    return { name: channelName(a.slug), slug: a.slug, topic: `${BADGE[a.slug] ?? "🤖"} Talk to the ${a.name} (${a.roleTitle}). ${notes} Attach .md .txt .json .csv .pdf .docx files for analysis.`.slice(0, 1024) };
  });
}

/** Channel name → agent slug: the agent's own channel, or a legacy/general channel. */
export function channelAgent(name: string, agents: AgentRow[]) {
  const n = name.toLowerCase();
  return agents.find(a => a.status !== "DISABLED" && channelName(a.slug) === n)?.slug ?? LEGACY_CHANNELS[n];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Finds an @Agent / @Role shorthand in the text (e.g. "@PM", "@Frontend", "@SoftwareArchitect"); returns slug + text without it. */
export function findAddressedAgent(text: string, agents: AgentRow[]): { slug: string; text: string } | null {
  const re = /(^|\s)@([A-Za-z][A-Za-z0-9_-]{1,40})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const key = norm(m[2]);
    const slug = ALIASES[key] ?? agents.find(a => norm(a.slug) === key || norm(a.name) === key || norm(a.roleTitle) === key)?.slug;
    if (slug && agents.some(a => a.slug === slug)) return { slug, text: (text.slice(0, m.index) + m[1] + text.slice(m.index + m[0].length)).trim() };
  }
  return null;
}

export const AVATAR_BASE = (process.env.AVATAR_BASE_URL || "https://ai.devenum.com/api/avatars").replace(/\/$/, "");
export function identity(agent: AgentRow) {
  const username = `${BADGE[agent.slug] ?? "🤖"} ${agent.name} · ${agent.roleTitle}`.replace(/discord|clyde/gi, "").slice(0, 80);
  return { username, avatarURL: `${AVATAR_BASE}/${agent.slug}.png` };
}

/* ---------------- Webhooks: speak as an agent ---------------- */

const hooks = new Map<string, Webhook | null>();
const HOOK_NAME = "Devenum Agents";

async function webhookFor(channel: TextChannel, appId: string): Promise<Webhook | null> {
  if (hooks.has(channel.id)) return hooks.get(channel.id)!;
  let hook: Webhook | null = null;
  try {
    const existing = await channel.fetchWebhooks();
    hook = existing.find(w => w.applicationId === appId && w.name === HOOK_NAME) ?? await channel.createWebhook({ name: HOOK_NAME, reason: "Devenum AI agent identities" });
  } catch { hook = null; } // missing Manage Webhooks → fall back to normal bot messages
  hooks.set(channel.id, hook);
  return hook;
}

export interface SendAsOptions { parts: string[]; embeds?: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] }

/** Posts parts as the agent (webhook username + avatar). Embeds/components ride on the last part. */
export async function sendAs(channel: GuildTextBasedChannel, agent: AgentRow, appId: string, o: SendAsOptions) {
  const base = channel.isThread() ? channel.parent : channel;
  const hook = base && base.type === ChannelType.GuildText ? await webhookFor(base as TextChannel, appId) : null;
  const id = identity(agent);
  for (const [i, content] of o.parts.entries()) {
    const last = i === o.parts.length - 1;
    const extra = last ? { embeds: o.embeds ?? [], components: o.components ?? [] } : {};
    if (hook) {
      try {
        await hook.send({ content, username: id.username, avatarURL: id.avatarURL, allowedMentions: { parse: [] }, ...(channel.isThread() ? { threadId: channel.id } : {}), ...extra });
        continue;
      } catch { hooks.delete(base!.id); /* fall through to a normal message */ }
    }
    await channel.send({ content: `${i === 0 ? `**${id.username}**\n` : ""}${content}`.slice(0, 2000), allowedMentions: { parse: [] }, ...extra });
  }
}

/* ---------------- Department channels ---------------- */

export interface SetupReport { category: string; created: string[]; existing: string[]; errors: string[]; canWebhooks: boolean; channels: TeamChannel[] }

/**
 * Ensures the team category and agent channels exist. Never renames, moves or deletes existing channels — an existing
 * channel with the same name (e.g. #general) is simply reused where it is.
 */
export async function setupTeamChannels(guild: Guild, categoryName: string, agents: AgentRow[]): Promise<SetupReport> {
  const TEAM_CHANNELS = teamChannels(agents);
  const report: SetupReport = { category: categoryName, created: [], existing: [], errors: [], canWebhooks: false, channels: TEAM_CHANNELS };
  const me = guild.members.me ?? await guild.members.fetchMe();
  report.canWebhooks = me.permissions.has(PermissionFlagsBits.ManageWebhooks);
  const channels = await guild.channels.fetch();
  const missing = TEAM_CHANNELS.filter(t => !channels.some(c => c?.type === ChannelType.GuildText && c.name === t.name));
  TEAM_CHANNELS.filter(t => !missing.includes(t)).forEach(t => report.existing.push(`#${t.name}`));
  if (!missing.length) return report;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    report.errors.push(`Missing "Manage Channels" permission — cannot create ${missing.map(t => `#${t.name}`).join(", ")}`);
    return report;
  }
  let category = channels.find(c => c?.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()) as CategoryChannel | undefined;
  try {
    if (!category) { category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory, reason: "Devenum AI team channels" }); report.created.push(`category ${categoryName}`); }
  } catch (e) { report.errors.push((e as Error).message); return report; }
  for (const t of missing) {
    try {
      const ch = await guild.channels.create({ name: t.name, type: ChannelType.GuildText, parent: category.id, topic: t.topic, reason: "Devenum AI agent channel" });
      report.created.push(`#${t.name}`);
      // Create the persona webhook up front so the agent's first reply already uses its own name and avatar.
      if (report.canWebhooks) await ch.createWebhook({ name: HOOK_NAME, reason: "Devenum AI agent identities" }).catch(() => undefined);
    } catch (e) { report.errors.push(`#${t.name}: ${(e as Error).message}`); }
  }
  return report;
}
