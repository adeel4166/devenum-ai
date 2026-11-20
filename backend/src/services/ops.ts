import fs from "fs";
import { ActorType, Prisma, Priority } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { HttpError } from "../http";
import { decideProposal } from "../proposals";
import { planGoal } from "./autobuild";
import { UPLOAD_LIMIT_BYTES, zipWorkspace } from "./download";
import { githubConfigured, pushProject } from "./github";
import { startJob } from "./jobs";
import { getPreview, listPreviews, startPreview, stopPreview } from "./preview";
import { createBackup } from "./backup";
import { deployProject, stopDeploy } from "./deploy";
import { workspacePath } from "./exec";
import { projectBusy, requireWorkspace } from "./workspace";

/**
 * Project operations shared by the portal (JWT routes) and the Discord bot (/api/bot routes), so both surfaces
 * have exactly the same capabilities and audit trail.
 */
export interface OpsActor {
  actorType: ActorType;        // CEO for the portal, DISCORD_CEO for the bot
  actorId: string;             // user id or Discord user id
  approverId: number;          // User row decisions are attributed to
  context?: Record<string, string>;
}

async function projectOr404(id: number) {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p) throw new HttpError(404, "Project not found");
  return p;
}
const log = (a: OpsActor, action: string, target: string, details: Prisma.InputJsonObject = {}) =>
  audit(a.actorType, a.actorId, action, target, { ...details, ...(a.context ?? {}) });

/* ---------- Preview ---------- */

export function previewInfo(projectId: number) {
  return getPreview(projectId) ?? null;
}
export const allPreviews = listPreviews;

export async function startPreviewJob(projectId: number, a: OpsActor) {
  const project = await projectOr404(projectId);
  return startJob("preview", async progress => {
    const p = await startPreview(project.id, project.slug, async msg => { progress(msg); });
    await log(a, "PREVIEW_STARTED", `project:${project.slug}`, { port: p.port, kind: p.kind, url: p.url });
    return { ...p, projectName: project.name };
  });
}

export async function stopProjectPreview(projectId: number, a: OpsActor) {
  const p = await stopPreview(projectId);
  if (p) await log(a, "PREVIEW_STOPPED", `project:${p.slug}`, { port: p.port });
  return p;
}

/* ---------- ZIP ---------- */

/** Builds the ZIP and hands it to `send`; the temp file is always removed afterwards. */
export async function withProjectZip<T>(projectId: number, a: OpsActor, send: (z: { file: string; name: string; files: number; bytes: number }) => Promise<T>, enforceDiscordLimit = false) {
  const project = await projectOr404(projectId);
  const z = await zipWorkspace(project.slug);
  try {
    if (enforceDiscordLimit && z.bytes > UPLOAD_LIMIT_BYTES) {
      throw new HttpError(413, `The ZIP is ${(z.bytes / 1048576).toFixed(1)} MB, above Discord's ${(UPLOAD_LIMIT_BYTES / 1048576).toFixed(0)} MB upload limit. Download it from the portal or push to GitHub instead.`);
    }
    await log(a, "WORKSPACE_DOWNLOADED", `project:${project.slug}`, { files: z.files, bytes: z.bytes });
    return await send({ file: z.file, name: `${project.slug}.zip`, files: z.files, bytes: z.bytes });
  } finally {
    fs.rmSync(z.file, { force: true });
  }
}

/* ---------- GitHub ---------- */

export async function githubPushJob(projectId: number, visibility: "private" | "public", a: OpsActor) {
  if (!githubConfigured()) throw new HttpError(503, "GITHUB_TOKEN is not configured in backend/.env");
  const project = await projectOr404(projectId);
  return startJob("github-push", async progress => {
    progress(`Pushing ${project.slug} (${visibility})…`);
    const r = await pushProject(project.slug, project.description || project.name, visibility === "private");
    await prisma.project.update({ where: { id: project.id }, data: { githubRepoUrl: r.url } });
    await log(a, "GITHUB_PUSHED", `project:${project.slug}`, { url: r.url, created: r.created, private: r.isPrivate, requested: visibility });
    return { url: r.url, created: r.created, isPrivate: r.isPrivate, visibilityMismatch: r.visibilityMismatch, projectName: project.name };
  });
}
export { githubConfigured };

/* ---------- Tasks: auto-build, handoff, request changes ---------- */

export async function autoBuildJob(projectId: number, goal: string, a: OpsActor) {
  const project = await projectOr404(projectId);
  return startJob("auto-build", async progress => {
    progress("The Project Manager is planning the work with Claude Code…");
    const agents = await prisma.agent.findMany({ orderBy: { id: "asc" } });
    const plan = await planGoal(project, goal, agents);
    progress(`Creating ${plan.length} tasks…`);
    const bySlug = new Map(agents.map(x => [x.slug, x]));
    const created: { id: number; title: string; priority: Priority; agent: { name: string; slug: string } }[] = [];
    let prev: number | null = null;
    for (const t of plan) {
      const agent = bySlug.get(t.agentSlug)!;
      const row: { id: number } = await prisma.task.create({ data: {
        projectId: project.id, assignedAgentId: agent.id, title: t.title, priority: t.priority, status: "READY",
        description: `${t.description}\n\n---\nPart of auto-build goal: ${goal}`.slice(0, 10000), dependencies: prev ? [prev] : [],
      } });
      created.push({ id: row.id, title: t.title, priority: t.priority, agent: { name: agent.name, slug: agent.slug } });
      prev = row.id;
    }
    await log(a, "AUTO_BUILD_PLANNED", `project:${project.slug}`, { goal: goal.slice(0, 500), taskIds: created.map(t => t.id) });
    return { projectId: project.id, projectName: project.name, goal, tasks: created };
  });
}

export const HANDOFF_DESCRIPTION = `Prepare this project for hand-off to a client. Do NOT change application behaviour; documentation and configuration templates only.

Deliverables:
1. README.md (root): project overview, features, tech stack, project structure, quick start, available scripts/commands, deployment notes, and license/ownership placeholder. Replace any agent-internal or placeholder text.
2. docs/SETUP.md: step-by-step setup guide for a developer on a clean machine (prerequisites with versions, install, configuration, database/services if any, running locally, building for production, running tests, troubleshooting).
3. .env.example: every environment variable the code reads (search the codebase), each with a short comment and a safe placeholder value. Never include real secrets. Do not create or modify a real .env.

Acceptance criteria: a new developer can clone the repo and run it by following README.md + docs/SETUP.md alone; .env.example covers all variables referenced in code.`;

export async function queueHandoff(projectId: number, a: OpsActor) {
  const project = await projectOr404(projectId);
  const agent = await prisma.agent.findUnique({ where: { slug: process.env.HANDOFF_AGENT_SLUG || "software-architect" } });
  if (!agent) throw new HttpError(500, "Hand-off agent not found");
  const t = await prisma.task.create({ data: {
    projectId: project.id, assignedAgentId: agent.id, title: "Client hand-off: README, setup guide and .env.example",
    description: HANDOFF_DESCRIPTION, priority: "HIGH", status: "READY", dependencies: [],
  } });
  await log(a, "HANDOFF_QUEUED", `task:${t.id}`, { project: project.slug, agent: agent.slug });
  return { ...t, assignedAgent: { id: agent.id, name: agent.name, slug: agent.slug, status: agent.status }, project: { id: project.id, name: project.name } };
}

/**
 * Request Changes: rejects the proposal with the CEO's feedback and queues a follow-up READY task for the same
 * agent. The follow-up branches from the old task branch (parentTaskId), and tasks that depended on the old task
 * are re-pointed to the follow-up so auto-build pipelines keep flowing.
 */
export async function requestChanges(proposalId: number, comment: string, a: OpsActor) {
  const before = await prisma.proposal.findUnique({ where: { id: proposalId }, include: { task: true } });
  if (!before) throw new HttpError(404, "Proposal not found");
  if (!before.task) throw new HttpError(409, "This proposal has no task to revise");
  await decideProposal(proposalId, "REJECTED", { approverId: a.approverId, actorType: a.actorType, actorId: a.actorId, context: a.context }, `Changes requested: ${comment}`);

  const old = before.task;
  const followUp = await prisma.$transaction(async tx => {
    const t = await tx.task.create({ data: {
      projectId: old.projectId, assignedAgentId: before.requestingAgentId, priority: old.priority, status: "READY",
      title: `Revise: ${old.title.replace(/^(Revise: )+/, "")}`.slice(0, 200),
      description: `${old.description}\n\n---\nFollow-up to task #${old.id} (proposal #${proposalId} was sent back). Continue from the previous work on branch task/${old.id}.\n\nCEO feedback to address:\n${comment}`.slice(0, 10000),
      dependencies: (old.dependencies ?? []) as Prisma.InputJsonValue, parentTaskId: old.id,
    } });
    const dependents = await tx.task.findMany({ where: { projectId: old.projectId, status: { not: "DONE" }, id: { not: t.id } } });
    for (const d of dependents) {
      const deps = Array.isArray(d.dependencies) ? (d.dependencies as unknown[]) : [];
      if (deps.includes(old.id)) await tx.task.update({ where: { id: d.id }, data: { dependencies: deps.map(x => (x === old.id ? t.id : x)) as Prisma.InputJsonValue } });
    }
    await audit(a.actorType, a.actorId, "TASK_REVISION_REQUESTED", `task:${t.id}`, { proposalId, previousTaskId: old.id, ...(a.context ?? {}) }, tx);
    return t;
  });
  return { followUpTaskId: followUp.id, title: followUp.title };
}

/* ---------- Freeze, decisions ---------- */

export async function setFrozen(projectId: number, frozen: boolean, a: OpsActor) {
  const p = await projectOr404(projectId);
  await prisma.project.update({ where: { id: projectId }, data: { isFrozen: frozen } });
  await log(a, frozen ? "PROJECT_FROZEN" : "PROJECT_UNFROZEN", `project:${p.slug}`, {});
  return { id: projectId, name: p.name, isFrozen: frozen };
}

export async function pinDecision(projectId: number, d: { title: string; decision: string; rationale?: string | null }, pinnedBy: string, a: OpsActor) {
  const p = await projectOr404(projectId);
  const row = await prisma.projectDecision.create({ data: { projectId, title: d.title.slice(0, 190), decision: d.decision.slice(0, 20000), rationale: d.rationale?.slice(0, 5000) || null, pinnedBy: pinnedBy.slice(0, 120) } });
  await log(a, "DECISION_PINNED", `project:${p.slug}`, { decisionId: row.id, title: row.title });
  return { ...row, project: { id: p.id, name: p.name } };
}

/* ---------- Retry, delete, deploy, backup ---------- */

/** CEO-triggered retry of a timed-out / blocked task: it goes back to READY and continues on its task branch. */
export async function retryTask(taskId: number, a: OpsActor) {
  const t = await prisma.task.findUnique({ where: { id: taskId } });
  if (!t) throw new HttpError(404, "Task not found");
  if (!["NEEDS_RETRY", "BLOCKED", "BACKLOG"].includes(t.status)) throw new HttpError(409, `Task is ${t.status}; only NEEDS_RETRY, BLOCKED or BACKLOG tasks can be retried`);
  await prisma.task.update({ where: { id: taskId }, data: { status: "READY", queuedAt: new Date(), startedAt: null, completedAt: null, approvedAt: null } });
  await log(a, "TASK_RETRY_REQUESTED", `task:${taskId}`, { previousStatus: t.status });
  return { id: taskId, title: t.title, status: "READY" };
}

/**
 * Deletes a project completely: stops its preview and live deploy, removes its DB records (runs, proposals,
 * approvals, tasks, related audit events, project) in one transaction, then removes the workspace folder.
 * A PROJECT_DELETED audit event is written afterwards so the deletion itself stays on record.
 */
export async function deleteProject(projectId: number, a: OpsActor) {
  const project = await projectOr404(projectId);
  if (await projectBusy(projectId)) throw new HttpError(409, "An agent is working on this project right now — pause it or wait for the run to finish");
  await stopPreview(projectId).catch(() => null);
  await stopDeploy(projectId).catch(() => null);

  const counts = await prisma.$transaction(async tx => {
    const tasks = await tx.task.findMany({ where: { projectId }, select: { id: true } });
    const proposals = await tx.proposal.findMany({ where: { projectId }, select: { id: true } });
    const taskIds = tasks.map(t => t.id), proposalIds = proposals.map(p => p.id);
    await tx.agent.updateMany({ where: { currentTaskId: { in: taskIds } }, data: { currentTaskId: null } });
    const runs = await tx.agentRun.deleteMany({ where: { taskId: { in: taskIds } } });
    const audits = await tx.auditEvent.deleteMany({ where: { target: { in: [
      `project:${project.slug}`, ...taskIds.map(id => `task:${id}`), ...proposalIds.map(id => `proposal:${id}`),
    ] } } });
    await tx.quote.updateMany({ where: { projectId }, data: { projectId: null } });
    // Ask devenum-bot to remove the project's Discord channel (it polls this list).
    if (project.discordChannelId) {
      const row = await tx.setting.findUnique({ where: { key: "discord:channelCleanup" } });
      const list = Array.isArray(row?.value) ? (row!.value as string[]) : [];
      await tx.setting.upsert({ where: { key: "discord:channelCleanup" }, create: { key: "discord:channelCleanup", value: [...list, project.discordChannelId] }, update: { value: [...list, project.discordChannelId] } });
    }
    await tx.project.delete({ where: { id: projectId } }); // cascades tasks, proposals, approvals
    return { tasks: taskIds.length, proposals: proposalIds.length, runs: runs.count, auditEvents: audits.count };
  });

  let workspaceRemoved = false;
  try {
    const ws = workspacePath(project.slug); // slug-validated, always inside WORKSPACES_DIR
    if (fs.existsSync(ws)) { fs.rmSync(ws, { recursive: true, force: true }); workspaceRemoved = true; }
  } catch { /* reported below */ }
  await log(a, "PROJECT_DELETED", `project:${project.slug}`, { name: project.name, ...counts, workspaceRemoved });
  return { deleted: true, name: project.name, slug: project.slug, ...counts, workspaceRemoved };
}

export async function deployJob(projectId: number, a: OpsActor) {
  const project = await projectOr404(projectId);
  requireWorkspace(project.slug);
  return startJob("deploy", async progress => {
    const r = await deployProject(projectId, progress);
    await log(a, "PROJECT_DEPLOYED", `project:${project.slug}`, { url: r.url, port: r.port, kind: r.kind, pm2: r.name });
    return r;
  });
}

export async function stopProjectDeploy(projectId: number, a: OpsActor) {
  const project = await projectOr404(projectId);
  const r = await stopDeploy(projectId);
  await log(a, "DEPLOY_STOPPED", `project:${project.slug}`, { pm2: r.name, wasRunning: r.stopped });
  return r;
}

export function backupJob(a: OpsActor) {
  return startJob("backup", async progress => {
    const r = await createBackup(progress);
    await log(a, "BACKUP_CREATED", `backup:${r.name}`, { bytes: r.bytes });
    return r;
  });
}
