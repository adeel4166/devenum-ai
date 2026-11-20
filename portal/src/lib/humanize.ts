import type { AuditEvent } from "./api";

/** Turns raw audit events into one-line, plain-English activity sentences for the live feed. */
export interface FeedItem { id: number; text: string; detail?: string; tone: "agent" | "ceo" | "system" | "success" | "danger" | "warning"; at: string; href?: string }

const num = (target: string | null, kind: string) => {
  const m = target?.match(new RegExp(`^${kind}:(\\d+)$`));
  return m ? Number(m[1]) : null;
};
const slugName = (s: string | null | undefined) => (s ?? "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const who = (e: AuditEvent) =>
  e.actorType === "DISCORD_CEO" ? "The CEO (via Discord)" : e.actorType === "CEO" ? "The CEO" : e.actorType === "AGENT" ? slugName(e.actorId) : "Devenum";

export function humanize(e: AuditEvent): FeedItem {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const task = num(e.target, "task"), proposal = num(e.target, "proposal");
  const project = e.target?.startsWith("project:") ? e.target.slice(8) : null;
  const base = { id: e.id, at: e.createdAt };
  switch (e.action) {
    case "TASK_RUN_STARTED": return { ...base, tone: "agent", text: `${slugName(String(d.agent))} started working on task #${task}`, detail: d.provider === "GEMINI_API" ? "via Gemini" : "via Claude Code" };
    case "PROPOSAL_SUBMITTED": return { ...base, tone: "agent", text: `${who(e)} finished and submitted proposal #${proposal} for approval`, detail: [d.branch && `branch ${d.branch}`, d.changedFiles != null && `${d.changedFiles} files changed`, d.riskLevel && `${String(d.riskLevel).toLowerCase()} risk`].filter(Boolean).join(" · "), href: "/approvals" };
    case "PROPOSAL_APPROVED": return { ...base, tone: "success", text: `${who(e)} approved proposal #${proposal}`, detail: d.branchName ? `merging ${d.branchName} into main` : undefined, href: "/approvals" };
    case "PROPOSAL_REJECTED": return { ...base, tone: "danger", text: `${who(e)} rejected proposal #${proposal}`, detail: typeof d.comment === "string" ? d.comment.slice(0, 140) : undefined, href: "/approvals" };
    case "PROPOSAL_CHANGES_REQUESTED": return { ...base, tone: "warning", text: `${who(e)} requested changes on proposal #${proposal}`, href: "/approvals" };
    case "TASK_REVISION_REQUESTED": return { ...base, tone: "warning", text: `${who(e)} sent work back — follow-up task #${task} queued`, detail: d.previousTaskId ? `revises task #${d.previousTaskId}` : undefined };
    case "TASK_BRANCH_MERGED": return { ...base, tone: "success", text: `Merged ${d.branch ?? "a task branch"} into main`, detail: typeof d.mergeCommit === "string" ? `commit ${d.mergeCommit.slice(0, 8)}` : undefined };
    case "TASK_BRANCH_MERGE_FAILED": return { ...base, tone: "danger", text: `Merge of ${d.branch ?? "a task branch"} failed — needs attention`, detail: typeof d.error === "string" ? d.error.slice(0, 140) : undefined };
    case "TASK_RUN_FAILED": return { ...base, tone: "danger", text: `${slugName(String(d.agent))} could not finish task #${task}`, detail: typeof d.error === "string" ? d.error.slice(0, 140) : undefined };
    case "TASK_RUN_CANCELLED": return { ...base, tone: "warning", text: `Run for task #${task} was cancelled and re-queued` };
    case "TASK_RUN_ORPHANED": return { ...base, tone: "warning", text: `A run for task #${task} was interrupted by a worker restart` };
    case "TASK_CREATED": return { ...base, tone: "ceo", text: `${who(e)} created task #${task}${d.title ? `: ${d.title}` : ""}` };
    case "TASK_UPDATED": return { ...base, tone: "ceo", text: `${who(e)} updated task #${task}` };
    case "TASK_DELETED": return { ...base, tone: "ceo", text: `${who(e)} deleted task #${task}` };
    case "TASK_RUN_TRIGGERED": return { ...base, tone: "ceo", text: `${who(e)} triggered a simulated run of task #${task}` };
    case "HANDOFF_QUEUED": return { ...base, tone: "ceo", text: `${who(e)} requested a client hand-off package (task #${task})` };
    case "AUTO_BUILD_PLANNED": return { ...base, tone: "ceo", text: `${who(e)} launched an auto-build for ${project}`, detail: Array.isArray(d.taskIds) ? `${d.taskIds.length} sequential tasks queued` : undefined };
    case "PROJECT_CREATED": return { ...base, tone: "ceo", text: `${who(e)} created project ${project}` };
    case "PROJECT_UPDATED": return { ...base, tone: "ceo", text: `${who(e)} updated project ${project}` };
    case "GITHUB_PUSHED": return { ...base, tone: "success", text: `${who(e)} pushed ${project} to GitHub`, detail: typeof d.url === "string" ? d.url : undefined };
    case "PREVIEW_STARTED": return { ...base, tone: "system", text: `${who(e)} started a live preview of ${project}`, detail: typeof d.url === "string" ? d.url : undefined };
    case "PREVIEW_STOPPED": return { ...base, tone: "system", text: `${who(e)} stopped the preview of ${project}` };
    case "WORKSPACE_DOWNLOADED": return { ...base, tone: "system", text: `${who(e)} downloaded ${project} as a ZIP` };
    case "EMERGENCY_PAUSE_ALL": return { ...base, tone: "danger", text: `${who(e)} paused the whole agency` };
    case "RESUME_ALL": return { ...base, tone: "success", text: `${who(e)} resumed the agency` };
    case "SETTINGS_UPDATED": return { ...base, tone: "system", text: `${who(e)} changed agency settings` };
    case "AGENTS_PROVIDER_SET": return { ...base, tone: "system", text: "All agents switched to Claude Code" };
    case "SYSTEM_SEEDED": return { ...base, tone: "system", text: "Devenum AI was initialised" };
    default:
      if (e.action.startsWith("AGENT_")) return { ...base, tone: "ceo", text: `${who(e)} ${e.action.slice(6).toLowerCase().replace(/_/g, " ")} ${slugName(e.target?.replace(/^agent:/, ""))}` };
      if (e.action.startsWith("USER_")) return { ...base, tone: "system", text: `${who(e)} ${e.action.slice(5).toLowerCase().replace(/_/g, " ")} a team member` };
      return { ...base, tone: "system", text: `${who(e)}: ${e.action.toLowerCase().replace(/_/g, " ")}${e.target ? ` (${e.target})` : ""}` };
  }
}
