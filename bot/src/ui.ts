import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Proposal, Status } from "./api";

const RISK_COLOR = { LOW: 0x22c55e, MEDIUM: 0xf59e0b, HIGH: 0xef4444 } as const;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ts = (iso: string) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;

export const ids = {
  approve: (id: number) => `devenum:approve:${id}`,
  reject: (id: number) => `devenum:reject:${id}`,
  rejectModal: (id: number) => `devenum:rejectmodal:${id}`,
  parse: (customId: string) => {
    const m = customId.match(/^devenum:(approve|reject|rejectmodal):(\d+)$/);
    return m ? { action: m[1] as "approve" | "reject" | "rejectmodal", id: Number(m[2]) } : null;
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
    new ButtonBuilder().setCustomId(ids.approve(id)).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(ids.reject(id)).setLabel("Reject").setStyle(ButtonStyle.Danger).setDisabled(disabled),
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
