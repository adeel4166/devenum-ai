import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { decideProposal } from "../proposals";
import { discordContext } from "../serviceAuth";
import { createProject, projectInput } from "./projects";

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
  }).parse(req.body);
  const [project, agent] = await Promise.all([
    prisma.project.findUnique({ where: { id: b.projectId } }),
    prisma.agent.findUnique({ where: { slug: b.agentSlug } }),
  ]);
  if (!project) throw new HttpError(404, `Project #${b.projectId} not found`);
  if (!agent) throw new HttpError(404, `No agent with role "${b.agentSlug}"`);
  const t = await prisma.task.create({
    data: { projectId: project.id, assignedAgentId: agent.id, title: b.title, description: b.description || b.title, priority: b.priority, status: "READY", dependencies: [] },
  });
  await audit("DISCORD_CEO", req.user!.id, "TASK_CREATED", `task:${t.id}`, { title: t.title, assignedAgentId: agent.id, ...discordContext(req) });
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
