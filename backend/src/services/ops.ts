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
