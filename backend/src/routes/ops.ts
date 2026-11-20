import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { startJob } from "../services/jobs";
import { autoBuildJob, backupJob, OpsActor } from "../services/ops";
import { generateQuote, QuoteResult } from "../services/quotes";
import { backupFile, listBackups } from "../services/backup";
import { devenumServices, restartService, serviceLogs, vpsMetrics } from "../services/sysops";
import { createProject } from "./projects";
import { generateDailyReport } from "../services/reports";

/* ---------------- Executive reports ---------------- */
export const reportsRouter = Router();
reportsRouter.get("/", wrap(async (_req, res) => {
  res.json(await prisma.report.findMany({ orderBy: { id: "desc" }, take: 60, select: { id: true, kind: true, title: true, generatedBy: true, postedAt: true, createdAt: true, data: true } }));
}));
reportsRouter.get("/:id", wrap(async (req, res) => {
  const r = await prisma.report.findUnique({ where: { id: idParam(req) } });
  if (!r) throw new HttpError(404, "Report not found");
  res.json(r);
}));
reportsRouter.post("/generate", requireRole("CEO", "ADMIN"), wrap(async (req, res) => {
  const r = await generateDailyReport(`${req.user!.name} (portal)`);
  await audit("CEO", req.user!.id, "REPORT_GENERATED", `report:${r.id}`, {});
  res.status(201).json(r);
}));

const writers = requireRole("CEO", "ADMIN");
const actor = (req: import("express").Request): OpsActor => ({ actorType: "CEO", actorId: String(req.user!.id), approverId: req.user!.id });

/* ---------------- Live agent logs ---------------- */
export const runsRouter = Router();
runsRouter.get("/:id/logs", wrap(async (req, res) => {
  const r = await prisma.agentRun.findUnique({
    where: { id: idParam(req) },
    select: { id: true, status: true, logs: true, errorMessage: true, startedAt: true, finishedAt: true, executionMs: true,
      agent: { select: { name: true, slug: true } }, task: { select: { id: true, title: true, projectId: true } } },
  });
  if (!r) throw new HttpError(404, "Run not found");
  res.json({ ...r, elapsedMs: r.finishedAt ? r.executionMs : Date.now() - r.startedAt.getTime() });
}));

/* ---------------- System ops (PM2, logs, backups) ---------------- */
export const systemOpsRouter = Router();
systemOpsRouter.get("/metrics", wrap(async (_req, res) => { res.json({ vps: await vpsMetrics(), services: await devenumServices() }); }));
systemOpsRouter.post("/restart/:service", writers, wrap(async (req, res) => {
  const r = await restartService(String(req.params.service));
  await audit("CEO", req.user!.id, "SERVICE_RESTARTED", `service:${r.name}`, {});
  res.json(r);
}));
systemOpsRouter.get("/logs/:service", writers, wrap(async (req, res) => {
  res.json({ name: req.params.service, logs: await serviceLogs(String(req.params.service), Number(req.query.lines) || 200) });
}));
systemOpsRouter.post("/backup", requireRole("CEO"), wrap(async (req, res) => { res.status(202).json({ jobId: backupJob(actor(req)).id }); }));
systemOpsRouter.get("/backups", requireRole("CEO"), wrap(async (_req, res) => { res.json(listBackups()); }));
systemOpsRouter.get("/backups/:name", requireRole("CEO"), wrap(async (req, res) => {
  const f = backupFile(String(req.params.name));
  await audit("CEO", req.user!.id, "BACKUP_DOWNLOADED", `backup:${req.params.name}`, {});
  res.download(f);
}));

/* ---------------- Quotes ---------------- */
export const quotesRouter = Router();
quotesRouter.get("/", wrap(async (_req, res) => {
  res.json(await prisma.quote.findMany({ orderBy: { createdAt: "desc" }, take: 50 }));
}));
quotesRouter.get("/:id", wrap(async (req, res) => {
  const q = await prisma.quote.findUnique({ where: { id: idParam(req) } });
  if (!q) throw new HttpError(404, "Quote not found");
  res.json(q);
}));
quotesRouter.post("/", writers, wrap(async (req, res) => {
  const b = z.object({
    clientName: z.string().trim().min(2).max(120), requirements: z.string().trim().min(20).max(8000),
    hourlyRate: z.number().int().min(1).max(10000).default(50), currency: z.string().trim().min(3).max(3).toUpperCase().default("USD"),
    deadline: z.string().max(100).optional(), budgetHint: z.string().max(200).optional(),
  }).parse(req.body);
  const userId = req.user!.id;
  const job = startJob("quote", async progress => {
    const result = await generateQuote(b, progress);
    const q = await prisma.quote.create({ data: {
      clientName: b.clientName, title: result.title, requirements: b.requirements, hourlyRate: b.hourlyRate, currency: b.currency,
      result: result as unknown as Prisma.InputJsonObject, createdById: userId,
    } });
    await audit("CEO", userId, "QUOTE_CREATED", `quote:${q.id}`, { client: b.clientName, total: result.cost.total, currency: b.currency });
    return q;
  });
  res.status(202).json({ jobId: job.id });
}));
quotesRouter.post("/:id/convert", writers, wrap(async (req, res) => {
  const q = await prisma.quote.findUnique({ where: { id: idParam(req) } });
  if (!q) throw new HttpError(404, "Quote not found");
  if (q.projectId) throw new HttpError(409, `Already converted to project #${q.projectId}`);
  const r = q.result as unknown as QuoteResult;
  const project = await createProject({
    name: r.projectName || q.clientName, category: r.category ?? "WEB", techStack: r.techStack ?? "",
    description: `${r.summary}\n\nClient: ${q.clientName}. Scope from quote #${q.id}.`.slice(0, 5000), repoPath: "", gitBranch: "main",
  });
  await prisma.quote.update({ where: { id: q.id }, data: { projectId: project.id } });
  await audit("CEO", req.user!.id, "QUOTE_CONVERTED", `quote:${q.id}`, { projectId: project.id });
  const job = await autoBuildJob(project.id, r.autoBuildGoal || r.summary, actor(req));
  res.status(202).json({ projectId: project.id, jobId: job.id });
}));

/* ---------------- Analytics ---------------- */
export const analyticsRouter = Router();
analyticsRouter.get("/", wrap(async (_req, res) => {
  const since14 = new Date(Date.now() - 14 * 86400_000), since24 = new Date(Date.now() - 86400_000);
  const [agents, runStats, tasksDaily, runsDaily, recentRuns, limited, audit, totals] = await Promise.all([
    prisma.agent.findMany({ select: { id: true, slug: true, name: true, roleTitle: true, status: true } }),
    prisma.agentRun.groupBy({ by: ["agentId", "status"], _count: true, _avg: { executionMs: true } }),
    prisma.$queryRaw<{ d: string; n: bigint }[]>`SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') d, COUNT(*) n FROM Task WHERE createdAt >= ${since14} GROUP BY d`,
    prisma.$queryRaw<{ d: string; status: string; n: bigint }[]>`SELECT DATE_FORMAT(startedAt, '%Y-%m-%d') d, status, COUNT(*) n FROM AgentRun WHERE startedAt >= ${since14} GROUP BY d, status`,
    prisma.agentRun.count({ where: { startedAt: { gte: since24 } } }),
    prisma.agentRun.findFirst({
      where: { startedAt: { gte: since24 }, OR: [{ errorMessage: { contains: "rate limit" } }, { errorMessage: { contains: "usage limit" } }, { errorMessage: { contains: "429" } }, { logs: { contains: "usage limit" } }, { logs: { contains: "rate_limit" } }] },
      orderBy: { startedAt: "desc" }, select: { startedAt: true, errorMessage: true },
    }),
    prisma.auditEvent.findMany({ where: { actorType: { in: ["CEO", "DISCORD_CEO"] } }, orderBy: { id: "desc" }, take: 200 }),
    prisma.agentRun.aggregate({ _count: true, _avg: { executionMs: true } }),
  ]);
  const leaderboard = agents.map(a => {
    const rows = runStats.filter(r => r.agentId === a.id);
    const count = (s: string) => rows.find(r => r.status === s)?._count ?? 0;
    const total = rows.reduce((s, r) => s + r._count, 0);
    const finished = total - count("RUNNING") - count("QUEUED");
    const ok = count("SUCCEEDED");
    const avg = ok ? Math.round(rows.find(r => r.status === "SUCCEEDED")?._avg.executionMs ?? 0) : 0;
    return { ...a, runs: total, succeeded: ok, failed: count("FAILED"), timedOut: count("TIMED_OUT"), successRate: finished ? Math.round((ok / finished) * 100) : null, avgMs: avg };
  }).sort((x, y) => y.succeeded - x.succeeded || (y.successRate ?? -1) - (x.successRate ?? -1));
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400_000).toISOString().slice(0, 10));
  const daily = days.map(d => ({
    date: d,
    tasksCreated: Number(tasksDaily.find(r => r.d === d)?.n ?? 0),
    runsSucceeded: Number(runsDaily.find(r => r.d === d && r.status === "SUCCEEDED")?.n ?? 0),
    runsFailed: runsDaily.filter(r => r.d === d && ["FAILED", "TIMED_OUT"].includes(r.status)).reduce((s, r) => s + Number(r.n), 0),
  }));
  // Time breakdown over the last 30 days: queue wait, active AI work, CEO review wait.
  const tb = await prisma.$queryRaw<{ queueMs: number | null; aiMs: number | null; ceoMs: number | null; nQ: bigint; nA: bigint; nC: bigint }[]>`
    SELECT AVG(CASE WHEN startedAt IS NOT NULL THEN GREATEST(0, TIMESTAMPDIFF(MICROSECOND, COALESCE(queuedAt, createdAt), startedAt)) / 1000 END) AS queueMs,
           AVG(CASE WHEN startedAt IS NOT NULL AND completedAt IS NOT NULL THEN GREATEST(0, TIMESTAMPDIFF(MICROSECOND, startedAt, completedAt)) / 1000 END) AS aiMs,
           AVG(CASE WHEN completedAt IS NOT NULL AND approvedAt IS NOT NULL THEN GREATEST(0, TIMESTAMPDIFF(MICROSECOND, completedAt, approvedAt)) / 1000 END) AS ceoMs,
           SUM(startedAt IS NOT NULL) AS nQ, SUM(startedAt IS NOT NULL AND completedAt IS NOT NULL) AS nA, SUM(completedAt IS NOT NULL AND approvedAt IS NOT NULL) AS nC
    FROM Task WHERE createdAt >= ${new Date(Date.now() - 30 * 86400_000)}`;
  const t0 = tb[0];
  const timeBreakdown = {
    queueWaitMs: t0?.queueMs != null ? Math.round(Number(t0.queueMs)) : null, activeAiMs: t0?.aiMs != null ? Math.round(Number(t0.aiMs)) : null,
    ceoWaitMs: t0?.ceoMs != null ? Math.round(Number(t0.ceoMs)) : null, samples: { queue: Number(t0?.nQ ?? 0), ai: Number(t0?.nA ?? 0), ceo: Number(t0?.nC ?? 0) },
  };
  res.json({
    leaderboard, daily, auditTrail: audit, timeBreakdown,
    totals: { runs: totals._count, avgMs: Math.round(totals._avg.executionMs ?? 0) },
    quota: {
      runsLast24h: recentRuns,
      cooldown: limited ? { detectedAt: limited.startedAt, message: (limited.errorMessage ?? "Usage limit reached").slice(0, 300) } : null,
      note: "Claude Code does not expose remaining quota; this tracks usage and any rate/usage-limit errors seen in agent runs.",
    },
  });
}));
