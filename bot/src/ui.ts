import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Proposal, Status } from "./api";

const RISK_COLOR = { LOW: 0x22c55e, MEDIUM: 0xf59e0b, HIGH: 0xef4444 } as const;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ts = (iso: string) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;

/** Button / modal custom IDs. Format "<action>:<numeric id>"; legacy "devenum:<action>:<id>" is still accepted. */
export const ACTIONS = ["approve", "reject", "rejectmodal", "proposal_revise", "proposal_revise_modal",
  "gh_push_private", "gh_push_public", "gh_push_skip", "preview_stop"] as const;
export type Action = (typeof ACTIONS)[number];
export const ids = {
  make: (action: Action, id: number) => `${action}:${id}`,
  parse: (customId: string): { action: Action; id: number } | null => {
    const m = customId.replace(/^devenum:/, "").match(/^([a-z_]+):(\d+)$/);
    return m && (ACTIONS as readonly string[]).includes(m[1]) ? { action: m[1] as Action, id: Number(m[2]) } : null;
  },
};

export function proposalEmbed(p: Proposal) {
  const files = p.changedFiles ?? [];
  const e = new EmbedBuilder()
    .setColor(RISK_COLOR[p.riskLevel] ?? 0x64748b)
    .setTitle(cut(`Proposal #${p.id} · ${p.task ? `Task #${p.task.id}: ${p.task.title}` : p.actionType}`, 256))
    .setDescription(cut(p.scopeSummary, 1800))
    .addFields(
      { name: "Project", value: cut(p.project.name, 1024), inline: true },
      { name: "Agent", value: cut(p.requestingAgent.name, 1024), inline: true },
      { name: "Risk", value: p.riskLevel, inline: true },
      { name: "Action", value: p.actionType, inline: true },
      { name: "Branch", value: p.branchName ? `\`${p.branchName}\` → \`main\`` : "—", inline: true },
      { name: "Expires", value: ts(p.expiresAt), inline: true },
    );
  if (files.length) e.addFields({ name: `Changed files (${files.length})`, value: cut(files.slice(0, 15).map(f => `\`${f}\``).join("\n"), 1024) });
  e.addFields(
    { name: "Rollback plan", value: cut(p.rollbackPlan, 1024) },
    { name: "Validation plan", value: cut(p.validationPlan, 1024) },
  ).setFooter({ text: "Devenum AI · Approval Inbox" }).setTimestamp(new Date(p.createdAt));
  return e;
}

export function decisionButtons(id: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.make("approve", id)).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ids.make("proposal_revise", id)).setLabel("Request Changes").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ids.make("reject", id)).setLabel("Reject").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

export function githubButtons(projectId: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ids.make("gh_push_private", projectId)).setLabel("Push (Private Repo)").setEmoji("🔒").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ids.make("gh_push_public", projectId)).setLabel("Push (Public Repo)").setEmoji("🌍").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ids.make("gh_push_skip", projectId)).setLabel("Skip").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

export function previewButtons(projectId: number, url: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Preview").setStyle(ButtonStyle.Link).setURL(url).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ids.make("preview_stop", projectId)).setLabel("Stop Preview").setEmoji("⏹").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

export function statusEmbed(s: Status) {
  const projects = s.projects.length
    ? s.projects.map(p => `**${p.name}** (#${p.id}) · ${p.status.replace(/_/g, " ").toLowerCase()} · ${p.progressPercent}%`).join("\n")
    : "No active projects";
  const agents = s.runningAgents.length
    ? s.runningAgents.map(a => `🟢 ${a.name}${a.currentTaskId ? ` → task #${a.currentTaskId}` : ""}`).join("\n")
    : "No agents running";
  return new EmbedBuilder()
    .setColor(s.globalPaused ? 0xef4444 : 0x6366f1)
    .setTitle(s.globalPaused ? "Devenum AI Command Center · ⏸ GLOBALLY PAUSED" : "Devenum AI Command Center")
    .addFields(
      { name: "Active projects", value: String(s.projects.length), inline: true },
      { name: "Running agents", value: String(s.runningAgents.length), inline: true },
      { name: "Pending approvals", value: String(s.pendingApprovals), inline: true },
      { name: "Projects", value: cut(projects, 1024) },
      { name: "Agents at work", value: cut(agents, 1024) },
      { name: "Queue", value: `${s.readyTasks} task(s) READY for the worker`, inline: true },
    )
    .setTimestamp();
}
