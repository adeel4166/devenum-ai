import { CategoryChannel, ChannelType, Guild, PermissionFlagsBits, TextChannel, ThreadAutoArchiveDuration } from "discord.js";
import type { BackendApi } from "./api";
import { chunks } from "./chat";

/**
 * Per-project Discord channels (#proj-<slug> under "PROJECTS") and one thread per task
 * ("[PROJ-<id>][TASK-<id>] <title>") with status updates, so projects never mix in #general or #approvals.
 * Requires Manage Channels (+ Create Public Threads); without it this quietly does nothing and logs a throttled warning.
 */
const CATEGORY = process.env.PROJECTS_CATEGORY_NAME?.trim() || "PROJECTS";
let lastWarn = 0;
const warn = (log: (l: "warn", m: string, x?: Record<string, unknown>) => void, msg: string) => {
  if (Date.now() - lastWarn > 10 * 60_000) { lastWarn = Date.now(); log("warn", msg); }
};

export const projectChannelName = (slug: string) => `proj-${slug}`.slice(0, 100);
export const threadName = (pid: number, tid: number, title: string) => `[PROJ-${pid}][TASK-${tid}] ${title}`.slice(0, 100);

const STATUS_LINE: Record<string, (agent: string) => string> = {
  BACKLOG: () => "📋 In the backlog — not queued yet.",
  READY: a => `🟦 Queued — waiting for **${a}** to pick it up.`,
  IN_PROGRESS: a => `🔵 **${a}** is working on it (or it is being merged after approval).`,
  AWAITING_APPROVAL: () => "🟠 Work finished — proposal waiting for CEO approval in #approvals.",
  IN_REVIEW: () => "🟣 In review.",
  DONE: () => "✅ Approved by the CEO and merged into `main`.",
  BLOCKED: () => "⛔ Blocked — needs attention (failed, rejected, or merge blocked).",
  NEEDS_RETRY: () => "⏱ Timed out — use **Retry Task** in #approvals or the portal.",
};

async function projectsCategory(guild: Guild): Promise<CategoryChannel> {
  const chans = await guild.channels.fetch();
  const found = chans.find(c => c?.type === ChannelType.GuildCategory && c.name.toLowerCase() === CATEGORY.toLowerCase());
  if (found) return found as CategoryChannel;
  return guild.channels.create({ name: CATEGORY, type: ChannelType.GuildCategory, reason: "Devenum AI project channels" });
}

export async function syncProjects(guild: Guild, api: BackendApi, log: (l: "info" | "warn", m: string, x?: Record<string, unknown>) => void) {
  const me = guild.members.me ?? await guild.members.fetchMe();
  const canChannels = me.permissions.has(PermissionFlagsBits.ManageChannels);

  // 1. Channel cleanup for deleted projects (only channels we created: proj-* inside the PROJECTS category).
  const cleanup = await api.discordCleanup();
  if (cleanup.channelIds.length) {
    const done: string[] = [];
    for (const id of cleanup.channelIds) {
      const ch = await guild.channels.fetch(id).catch(() => null);
      if (!ch) { done.push(id); continue; }
      if (!canChannels) break;
      if (ch.name.startsWith("proj-") && ch.parent?.name.toLowerCase() === CATEGORY.toLowerCase()) {
        await ch.delete("Devenum project deleted").then(() => done.push(id)).catch(e => log("warn", "project channel delete failed", { id, error: (e as Error).message }));
      } else done.push(id); // not ours — never delete, just forget it
    }
    if (done.length) await api.discordCleanupAck(done);
  }

  // 2. Channels for new projects.
  const missing = await api.projectsWithoutChannel();
  if (missing.length && !canChannels) warn(log, `Missing "Manage Channels" permission — cannot create project channels (${missing.map(p => projectChannelName(p.slug)).join(", ")})`);
  if (missing.length && canChannels) {
    const category = await projectsCategory(guild);
    const existing = await guild.channels.fetch();
    for (const p of missing) {
      const name = projectChannelName(p.slug);
      let ch = existing.find(c => c?.type === ChannelType.GuildText && c.name === name && c.parentId === category.id) as TextChannel | undefined;
      if (!ch) {
        ch = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, topic: `Devenum project #${p.id} ${p.name} — task threads and updates`.slice(0, 1024), reason: "Devenum project created" });
        await ch.send(`📁 **Project #${p.id} — ${p.name}**\n${(p.description || "").slice(0, 1500)}\n\nEach task gets its own thread here. Approvals stay in the approvals channel.`).catch(() => undefined);
      }
      await api.setProjectChannel(p.id, ch.id);
      log("info", "project channel ready", { projectId: p.id, channel: name });
    }
  }

  // 3. Task threads + status updates.
  const updates = await api.taskUpdates();
  for (const t of updates) {
    const ch = t.project.discordChannelId ? await guild.channels.fetch(t.project.discordChannelId).catch(() => null) : null;
    if (!ch || ch.type !== ChannelType.GuildText) { await api.markTaskPosted(t.id, t.status); continue; }
    let threadId = t.discordThreadId;
    let thread = threadId ? await (ch as TextChannel).threads.fetch(threadId).catch(() => null) : null;
    if (!thread) {
      try {
        thread = await (ch as TextChannel).threads.create({ name: threadName(t.project.id, t.id, t.title), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason: "Devenum task thread" });
        threadId = thread.id;
      } catch (e) { warn(log, `Cannot create task threads (${(e as Error).message}) — grant "Create Public Threads"`); return; }
    }
    if (thread.archived) await thread.setArchived(false).catch(() => undefined);
    const agent = t.assignedAgent?.name ?? "an agent";
    const p = t.proposals[0];
    const qa = p?.qaReport as { status?: string; score?: number } | null;
    let msg = `${(STATUS_LINE[t.status] ?? (() => `Status: ${t.status}`))(agent)}`;
    if (t.status === "AWAITING_APPROVAL" && p) msg += `\nProposal #${p.id} · ${p.riskLevel} risk${qa?.status ? ` · ${qa.status === "PASSED" ? "✅ QA passed" : "⚠️ QA warning"} ${qa.score}/100` : ""}${p.branchName ? ` · \`${p.branchName}\`` : ""}`;
    if ((t.status === "AWAITING_APPROVAL" || t.status === "BLOCKED") && t.outputSummary) msg += `\n\n${t.outputSummary.slice(0, 1200)}`;
    if (!t.discordLastStatus) msg = `**Task #${t.id}: ${t.title}** · ${t.priority} · assigned to **${agent}**\n\n${msg}`;
    for (const part of chunks(msg)) await thread.send({ content: part, allowedMentions: { parse: [] } });
    await api.markTaskPosted(t.id, t.status, threadId ?? undefined);
  }
}
