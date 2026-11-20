import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { decideProposal } from "../proposals";
import { discordContext } from "../serviceAuth";
import { createProject, projectInput } from "./projects";
import { chatTurns, startChatJob } from "./chat";
import { getJob } from "../services/jobs";
import {
  allPreviews, autoBuildJob, githubConfigured, githubPushJob, OpsActor, queueHandoff, requestChanges, startPreviewJob, stopProjectPreview, withProjectZip,
} from "../services/ops";

const discordActor = (req: import("express").Request): OpsActor => {
  const ctx = discordContext(req);
  return { actorType: "DISCORD_CEO", actorId: ctx.discordUserId, approverId: req.user!.id, context: ctx };
};

/** Internal API for devenum-bot. Mounted at /api/bot behind requireServiceToken. */
export const botRouter = Router();

const proposalInclude = {
  project: { select: { id: true, name: true, slug: true } },
  task: { select: { id: true, title: true, priority: true } },
  requestingAgent: { select: { id: true, name: true, slug: true } },
} as const;

const expireStale = () =>
  prisma.proposal.updateMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });

botRouter.get("/status", wrap(async (_req, res) => {
  await expireStale();
  const [projects, runningAgents, pendingApprovals, readyTasks, settings] = await Promise.all([
    prisma.project.findMany({
      where: { status: { in: ["PLANNING", "IN_PROGRESS", "REVIEW"] } },
      orderBy: { createdAt: "desc" }, take: 15,
      select: { id: true, name: true, slug: true, status: true, progressPercent: true, category: true },
    }),
    prisma.agent.findMany({ where: { status: "RUNNING" }, select: { id: true, name: true, slug: true, currentTaskId: true } }),
    prisma.proposal.count({ where: { status: "PENDING" } }),
    prisma.task.count({ where: { status: "READY" } }),
    prisma.setting.findUnique({ where: { key: "globalPaused" } }),
  ]);
  res.json({ projects, runningAgents, pendingApprovals, readyTasks, globalPaused: settings?.value === true });
}));

botRouter.get("/agents", wrap(async (_req, res) => {
  res.json(await prisma.agent.findMany({ orderBy: { id: "asc" }, select: { id: true, slug: true, name: true, roleTitle: true, status: true, modelProvider: true, manifest: true } }));
}));

botRouter.post("/projects", wrap(async (req, res) => {
  const p = await createProject(projectInput.parse(req.body));
  await audit("DISCORD_CEO", req.user!.id, "PROJECT_CREATED", `project:${p.slug}`, { category: p.category, ...discordContext(req) });
  res.status(201).json(p);
}));

botRouter.post("/tasks", wrap(async (req, res) => {
  const b = z.object({
    projectId: z.number().int().positive(),
    title: z.string().min(2).max(200),
    agentSlug: z.string().min(2).max(60),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    description: z.string().max(10000).default(""),
    dependencies: z.array(z.number().int().positive()).max(20).default([]),
    parentTaskId: z.number().int().positive().optional(),
  }).parse(req.body);
  const [project, agent] = await Promise.all([
    prisma.project.findUnique({ where: { id: b.projectId } }),
    prisma.agent.findUnique({ where: { slug: b.agentSlug } }),
  ]);
  if (!project) throw new HttpError(404, `Project #${b.projectId} not found`);
  if (!agent) throw new HttpError(404, `No agent with role "${b.agentSlug}"`);
  const t = await prisma.task.create({
    data: { projectId: project.id, assignedAgentId: agent.id, title: b.title, description: b.description || b.title, priority: b.priority, status: "READY", dependencies: b.dependencies, parentTaskId: b.parentTaskId ?? null },
  });
  await audit("DISCORD_CEO", discordContext(req).discordUserId, "TASK_CREATED", `task:${t.id}`, { title: t.title, assignedAgentId: agent.id, dependencies: b.dependencies, ...discordContext(req) });
  res.status(201).json({ ...t, project: { id: project.id, name: project.name }, assignedAgent: { id: agent.id, name: agent.name, slug: agent.slug, status: agent.status } });
}));

botRouter.get("/proposals", wrap(async (_req, res) => {
  await expireStale();
  res.json(await prisma.proposal.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 25, include: proposalInclude }));
}));

/** PENDING proposals that have not been announced in Discord yet. */
botRouter.get("/proposals/unnotified", wrap(async (_req, res) => {
  await expireStale();
  res.json(await prisma.proposal.findMany({
    where: { status: "PENDING", discordNotifiedAt: null }, orderBy: { createdAt: "asc" }, take: 10, include: proposalInclude,
  }));
}));

botRouter.post("/proposals/:id/notified", wrap(async (req, res) => {
  const { messageId } = z.object({ messageId: z.string().max(40).optional() }).parse(req.body ?? {});
  await prisma.proposal.update({ where: { id: idParam(req) }, data: { discordNotifiedAt: new Date(), discordMessageId: messageId ?? null } });
  res.json({ ok: true });
}));

const commentBody = z.object({ comment: z.string().max(2000).optional() });

botRouter.post("/proposals/:id/approve", wrap(async (req, res) => {
  const ctx = discordContext(req);
  const { comment } = commentBody.parse(req.body ?? {});
  res.json(await decideProposal(idParam(req), "APPROVED",
    { approverId: req.user!.id, actorType: "DISCORD_CEO", actorId: ctx.discordUserId, context: ctx }, comment ?? `Approved via Discord by ${ctx.discordUserTag}`));
}));

botRouter.post("/proposals/:id/reject", wrap(async (req, res) => {
  const ctx = discordContext(req);
  const { comment } = commentBody.parse(req.body ?? {});
  res.json(await decideProposal(idParam(req), "REJECTED",
    { approverId: req.user!.id, actorType: "DISCORD_CEO", actorId: ctx.discordUserId, context: ctx }, comment?.trim() || `Rejected via Discord by ${ctx.discordUserTag}`));
}));

botRouter.get("/projects/:id", wrap(async (req, res) => {
  const p = await prisma.project.findUnique({ where: { id: idParam(req) }, include: { _count: { select: { tasks: true } } } });
  if (!p) throw new HttpError(404, "Project not found");
  res.json(p);
}));

/** Worker merges (and merge failures) not yet announced with a "Push to GitHub?" card. */
botRouter.get("/merges/unprompted", wrap(async (_req, res) => {
  res.json(await prisma.proposal.findMany({
    where: { mergeStatus: { not: null }, githubPromptedAt: null }, orderBy: { mergedAt: "asc" }, take: 10,
    include: { ...proposalInclude, project: { select: { id: true, name: true, slug: true, githubRepoUrl: true } } },
  }));
}));

botRouter.post("/proposals/:id/github-prompted", wrap(async (req, res) => {
  await prisma.proposal.update({ where: { id: idParam(req) }, data: { githubPromptedAt: new Date() } });
  res.json({ ok: true });
}));

/** Request Changes from Discord (same implementation as the portal). */
botRouter.post("/proposals/:id/revise", wrap(async (req, res) => {
  const { comment } = z.object({ comment: z.string().trim().min(2).max(2000) }).parse(req.body ?? {});
  res.status(201).json(await requestChanges(idParam(req), comment, discordActor(req)));
}));

/** Lets the bot record its own actions (previews, downloads, auto-build plans) in the audit log. */
botRouter.post("/audit", wrap(async (req, res) => {
  const b = z.object({ action: z.string().regex(/^DISCORD_[A-Z_]{2,60}$/), target: z.string().max(200).optional(), details: z.record(z.unknown()).default({}) }).parse(req.body);
  await audit("DISCORD_CEO", discordContext(req).discordUserId, b.action, b.target ?? null, { ...b.details, ...discordContext(req) } as Prisma.InputJsonObject);
  res.json({ ok: true });
}));

/* ---------------- Workspace operations (identical to the portal; see services/ops) ---------------- */

botRouter.get("/jobs/:id", wrap(async (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  res.json(job);
}));

botRouter.post("/heartbeat", wrap(async (req, res) => {
  const value = { at: new Date().toISOString(), ...z.object({ user: z.string().max(80).optional() }).parse(req.body ?? {}) };
  await prisma.setting.upsert({ where: { key: "heartbeat:bot" }, create: { key: "heartbeat:bot", value }, update: { value } });
  res.json({ ok: true, github: githubConfigured() });
}));

botRouter.get("/previews", wrap(async (_req, res) => { res.json(allPreviews()); }));
botRouter.post("/projects/:id/preview", wrap(async (req, res) => {
  res.status(202).json({ jobId: (await startPreviewJob(idParam(req), discordActor(req))).id });
}));
botRouter.delete("/projects/:id/preview", wrap(async (req, res) => {
  const p = await stopProjectPreview(idParam(req), discordActor(req));
  res.json({ stopped: !!p, preview: p });
}));

botRouter.get("/projects/:id/download", wrap(async (req, res) => {
  await withProjectZip(idParam(req), discordActor(req), z => new Promise<void>((resolve, reject) => {
    res.setHeader("x-zip-files", String(z.files));
    res.download(z.file, z.name, err => (err ? reject(err) : resolve()));
  }), true);
}));

botRouter.post("/projects/:id/github", wrap(async (req, res) => {
  const { visibility } = z.object({ visibility: z.enum(["private", "public"]) }).parse(req.body);
  res.status(202).json({ jobId: (await githubPushJob(idParam(req), visibility, discordActor(req))).id });
}));

botRouter.post("/projects/:id/auto-build", wrap(async (req, res) => {
  const { goal } = z.object({ goal: z.string().min(5).max(3000) }).parse(req.body);
  res.status(202).json({ jobId: (await autoBuildJob(idParam(req), goal, discordActor(req))).id });
}));

botRouter.post("/projects/:id/handoff", wrap(async (req, res) => {
  res.status(201).json(await queueHandoff(idParam(req), discordActor(req)));
}));

botRouter.post("/chat", wrap(async (req, res) => {
  const b = z.object({ message: z.string().trim().min(1).max(8000), history: chatTurns, author: z.string().max(80).default("CEO") }).parse(req.body);
  res.status(202).json({ jobId: startChatJob(b.message, b.history, b.author, "Discord").id });
}));
