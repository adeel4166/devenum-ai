import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { decideProposal } from "../proposals";
import { discordContext } from "../serviceAuth";
import { createProject, projectInput } from "./projects";
import { chatAttachments, chatTurns, startChatJob } from "./chat";
import { getJob, startJob } from "../services/jobs";
import { discardPlan, dispatchPlan, getPlan, pmChat } from "../services/teamplan";
import { generateDailyReport } from "../services/reports";
import { pinDecision, setFrozen } from "../services/ops";
import { devenumServices, restartService, vpsMetrics } from "../services/sysops";
import {
  backupJob, deleteProject, deployJob, retryTask, stopProjectDeploy,
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
  const b = z.object({
    message: z.string().trim().max(8000).default(""), history: chatTurns, author: z.string().max(80).default("CEO"),
    attachments: chatAttachments, dir: z.string().regex(/^\/tmp\/devenum-chat-\d+(-[a-z0-9]+)?$/).optional(),
    agentSlug: z.string().regex(/^[a-z0-9-]{2,60}$/).optional(),
  }).parse(req.body);
  if (!b.message && !b.attachments.length) throw new HttpError(400, "Send a message or attach a file");
  if (b.attachments.some(a => !b.dir || !a.path.startsWith(`${b.dir}/`))) throw new HttpError(400, "Attachments must live in the given chat folder");
  res.status(202).json({ jobId: startChatJob(b.message, b.history, b.author, "Discord", b.attachments, b.dir, b.agentSlug).id });
}));

/* ---------------- Delete, deploy, retry, system, backup, watchdog alerts ---------------- */

botRouter.delete("/projects/:id", wrap(async (req, res) => { res.json(await deleteProject(idParam(req), discordActor(req))); }));
botRouter.post("/projects/:id/deploy", wrap(async (req, res) => {
  res.status(202).json({ jobId: (await deployJob(idParam(req), discordActor(req))).id });
}));
botRouter.post("/projects/:id/deploy-stop", wrap(async (req, res) => { res.json(await stopProjectDeploy(idParam(req), discordActor(req))); }));
botRouter.post("/tasks/:id/retry", wrap(async (req, res) => { res.json(await retryTask(idParam(req), discordActor(req))); }));

botRouter.get("/system", wrap(async (_req, res) => { res.json({ vps: await vpsMetrics(), services: await devenumServices() }); }));
botRouter.post("/system/restart/:service", wrap(async (req, res) => {
  const r = await restartService(String(req.params.service));
  await audit("DISCORD_CEO", discordContext(req).discordUserId, "SERVICE_RESTARTED", `service:${r.name}`, discordContext(req));
  res.json(r);
}));
botRouter.post("/backup", wrap(async (req, res) => { res.status(202).json({ jobId: backupJob(discordActor(req)).id }); }));

/** Watchdog: TIMED_OUT runs not yet announced in Discord (with a Retry Task button). */
botRouter.get("/alerts/timeouts", wrap(async (_req, res) => {
  res.json(await prisma.agentRun.findMany({
    where: { status: "TIMED_OUT", alertedAt: null }, orderBy: { id: "asc" }, take: 10,
    select: { id: true, errorMessage: true, executionMs: true, startedAt: true, agent: { select: { name: true, slug: true } },
      task: { select: { id: true, title: true, status: true, project: { select: { id: true, name: true, slug: true } } } } },
  }));
}));
botRouter.post("/runs/:id/alerted", wrap(async (req, res) => {
  await prisma.agentRun.update({ where: { id: idParam(req) }, data: { alertedAt: new Date() } });
  res.json({ ok: true });
}));

/* ---------------- Project Manager team delegation ---------------- */

const pmBody = z.object({
  message: z.string().trim().max(8000).default(""), history: chatTurns, author: z.string().max(80).default("CEO"),
  attachments: chatAttachments, dir: z.string().regex(/^\/tmp\/devenum-chat-\d+(-[a-z0-9]+)?$/).optional(),
});
/** Chat with the PM; if the CEO asked for a plan, the result includes a PENDING TeamPlan (id + tasks). */
botRouter.post("/pm/chat", wrap(async (req, res) => {
  const b = pmBody.parse(req.body);
  if (!b.message && !b.attachments.length) throw new HttpError(400, "Send a message or attach a file");
  if (b.attachments.some(a => !b.dir || !a.path.startsWith(`${b.dir}/`))) throw new HttpError(400, "Attachments must live in the given chat folder");
  res.status(202).json({ jobId: startJob("pm-chat", () => pmChat(b.message, b.history, b.author, b.attachments, b.dir)).id });
}));
botRouter.get("/pm/plans/:id", wrap(async (req, res) => { res.json(await getPlan(idParam(req))); }));
botRouter.post("/pm/plans/:id/dispatch", wrap(async (req, res) => { res.json(await dispatchPlan(idParam(req), discordActor(req))); }));
botRouter.post("/pm/plans/:id/discard", wrap(async (req, res) => { res.json(await discardPlan(idParam(req), discordActor(req))); }));

/* ---------------- Decisions, freeze, reports ---------------- */

botRouter.post("/projects/:id/decisions", wrap(async (req, res) => {
  const b = z.object({ title: z.string().trim().min(2).max(190), decision: z.string().trim().min(2).max(20000), rationale: z.string().trim().max(5000).optional() }).parse(req.body);
  res.status(201).json(await pinDecision(idParam(req), b, `${discordContext(req).discordUserTag} (Discord)`, discordActor(req)));
}));
botRouter.post("/projects/:id/freeze", wrap(async (req, res) => {
  const { frozen } = z.object({ frozen: z.boolean() }).parse(req.body);
  res.json(await setFrozen(idParam(req), frozen, discordActor(req)));
}));
botRouter.post("/reports/daily", wrap(async (req, res) => {
  const { generatedBy } = z.object({ generatedBy: z.string().max(120).optional() }).parse(req.body ?? {});
  const r = await generateDailyReport(generatedBy ?? `${discordContext(req).discordUserTag} (Discord)`);
  res.status(201).json(r);
}));
botRouter.get("/reports/unposted", wrap(async (_req, res) => {
  res.json(await prisma.report.findMany({ where: { postedAt: null }, orderBy: { id: "asc" }, take: 3 }));
}));
botRouter.post("/reports/:id/posted", wrap(async (req, res) => {
  await prisma.report.update({ where: { id: idParam(req) }, data: { postedAt: new Date() } });
  res.json({ ok: true });
}));

/* ---------------- Discord project channels & task threads ---------------- */

botRouter.get("/discord/projects", wrap(async (_req, res) => {
  res.json(await prisma.project.findMany({ where: { discordChannelId: null }, orderBy: { id: "asc" }, take: 10, select: { id: true, name: true, slug: true, description: true } }));
}));
botRouter.post("/projects/:id/discord", wrap(async (req, res) => {
  const { channelId } = z.object({ channelId: z.string().regex(/^\d{5,25}$/) }).parse(req.body);
  await prisma.project.update({ where: { id: idParam(req) }, data: { discordChannelId: channelId } });
  res.json({ ok: true });
}));
/** Tasks of projects that have a Discord channel whose thread is missing or whose status changed since the last post. */
botRouter.get("/discord/task-updates", wrap(async (_req, res) => {
  // Compared in JS (not SQL) to stay independent of column collations.
  const candidates = await prisma.task.findMany({ where: { project: { discordChannelId: { not: null } } }, select: { id: true, status: true, discordThreadId: true, discordLastStatus: true }, orderBy: { id: "asc" } });
  const ids = candidates.filter(t => !t.discordThreadId || t.discordLastStatus !== t.status).slice(0, 15).map(t => t.id);
  res.json(await prisma.task.findMany({
    where: { id: { in: ids } }, orderBy: { id: "asc" },
    select: { id: true, title: true, status: true, priority: true, outputSummary: true, discordThreadId: true, discordLastStatus: true, projectId: true,
      project: { select: { id: true, name: true, discordChannelId: true } }, assignedAgent: { select: { name: true, slug: true } },
      proposals: { orderBy: { id: "desc" }, take: 1, select: { id: true, status: true, riskLevel: true, qaReport: true, branchName: true, mergeStatus: true } } },
  }));
}));
botRouter.post("/tasks/:id/discord", wrap(async (req, res) => {
  const b = z.object({ threadId: z.string().regex(/^\d{5,25}$/).optional(), status: z.string().max(40) }).parse(req.body);
  await prisma.task.update({ where: { id: idParam(req) }, data: { discordLastStatus: b.status, ...(b.threadId ? { discordThreadId: b.threadId } : {}) } });
  res.json({ ok: true });
}));
botRouter.get("/discord/cleanup", wrap(async (_req, res) => {
  const row = await prisma.setting.findUnique({ where: { key: "discord:channelCleanup" } });
  res.json({ channelIds: Array.isArray(row?.value) ? row!.value : [] });
}));
botRouter.post("/discord/cleanup/ack", wrap(async (req, res) => {
  const { channelIds } = z.object({ channelIds: z.array(z.string()).max(100) }).parse(req.body);
  const row = await prisma.setting.findUnique({ where: { key: "discord:channelCleanup" } });
  const left = (Array.isArray(row?.value) ? (row!.value as string[]) : []).filter(id => !channelIds.includes(id));
  await prisma.setting.upsert({ where: { key: "discord:channelCleanup" }, create: { key: "discord:channelCleanup", value: left }, update: { value: left } });
  res.json({ remaining: left.length });
}));

botRouter.get("/discord/channels", wrap(async (_req, res) => {
  res.json(await prisma.project.findMany({ where: { discordChannelId: { not: null } }, select: { id: true, discordChannelId: true } }));
}));
