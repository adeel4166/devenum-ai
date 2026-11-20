import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { wrap } from "../http";
import { allPreviews, githubConfigured } from "../services/ops";
import { devenumServices, vpsMetrics } from "../services/sysops";
import { getClaudeAuth } from "../services/claudeAuth";

export const systemRouter = Router();
const writers = requireRole("CEO", "ADMIN");

export const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  claudeCliEnabled: true,
  autoExpireHours: 24,
  globalPaused: false,
  maxConcurrentAgents: 3,
  maxStepsPerRun: 50,
  maxRunTimeoutSeconds: 1800,
  dailyTokenBudget: 2_000_000,
  requireApprovalForHighRisk: true,
};
type Settings = typeof DEFAULT_SETTINGS;

export async function loadSettings(): Promise<Settings> {
  // Only real settings; heartbeat:* rows are service liveness, not configuration.
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.keys(DEFAULT_SETTINGS) } } });
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s as Settings;
}
const mask = (s: Settings) => ({ ...s, geminiApiKey: s.geminiApiKey ? "•".repeat(8) + s.geminiApiKey.slice(-4) : "" });

systemRouter.get("/settings", wrap(async (_req, res) => res.json(mask(await loadSettings()))));

systemRouter.put("/settings", writers, wrap(async (req, res) => {
  const b = z.object({
    geminiApiKey: z.string().max(200).optional(),
    claudeCliEnabled: z.boolean().optional(),
    autoExpireHours: z.number().int().min(1).max(720).optional(),
    maxConcurrentAgents: z.number().int().min(1).max(50).optional(),
    maxStepsPerRun: z.number().int().min(1).max(1000).optional(),
    maxRunTimeoutSeconds: z.number().int().min(10).max(86400).optional(),
    dailyTokenBudget: z.number().int().min(0).optional(),
    requireApprovalForHighRisk: z.boolean().optional(),
  }).parse(req.body);
  // Ignore the masked placeholder so it never overwrites the real key.
  if (b.geminiApiKey?.startsWith("•")) delete b.geminiApiKey;
  for (const [key, value] of Object.entries(b)) {
    await prisma.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
  }
  // Never write the key itself into the audit log.
  const { geminiApiKey, ...loggable } = b;
  await audit("CEO", req.user!.id, "SETTINGS_UPDATED", "settings", { ...loggable, geminiApiKeyChanged: geminiApiKey !== undefined });
  res.json(mask(await loadSettings()));
}));

systemRouter.get("/status", wrap(async (_req, res) => {
  const auth = await getClaudeAuth();
  res.json({ globalPaused: (await loadSettings()).globalPaused, claudeAuth: { ok: auth.ok, detectedAt: auth.detectedAt, source: auth.source } });
}));

systemRouter.post("/pause-all", writers, wrap(async (req, res) => {
  const r = await prisma.agent.updateMany({
    where: { status: { in: ["AVAILABLE", "RUNNING", "WAITING_APPROVAL", "BLOCKED"] } },
    data: { status: "PAUSED" },
  });
  await prisma.setting.upsert({ where: { key: "globalPaused" }, create: { key: "globalPaused", value: true }, update: { value: true } });
  await audit("CEO", req.user!.id, "EMERGENCY_PAUSE_ALL", "agents", { affected: r.count });
  res.json({ paused: r.count, globalPaused: true });
}));

systemRouter.post("/resume-all", writers, wrap(async (req, res) => {
  const idle = await prisma.agent.updateMany({ where: { status: "PAUSED", currentTaskId: null }, data: { status: "AVAILABLE" } });
  const busy = await prisma.agent.updateMany({ where: { status: "PAUSED", currentTaskId: { not: null } }, data: { status: "RUNNING" } });
  await prisma.setting.upsert({ where: { key: "globalPaused" }, create: { key: "globalPaused", value: false }, update: { value: false } });
  await audit("CEO", req.user!.id, "RESUME_ALL", "agents", { affected: idle.count + busy.count });
  res.json({ resumed: idle.count + busy.count, globalPaused: false });
}));

systemRouter.get("/dashboard", wrap(async (_req, res) => {
  await prisma.proposal.updateMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
  const [activeProjects, running, idle, pending, projects, activity, proposals, agentCount, completedRuns] = await Promise.all([
    prisma.project.count({ where: { status: { in: ["PLANNING", "IN_PROGRESS", "REVIEW"] } } }),
    prisma.agent.count({ where: { status: "RUNNING" } }),
    prisma.agent.count({ where: { status: "AVAILABLE" } }),
    prisma.proposal.count({ where: { status: "PENDING" } }),
    prisma.project.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, status: true, progressPercent: true, category: true } }),
    prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.proposal.findMany({
      where: { status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 3,
      include: { requestingAgent: { select: { name: true } }, project: { select: { name: true } } },
    }),
    prisma.agent.count(),
    prisma.agentRun.count({ where: { status: "SUCCEEDED" } }),
  ]);
  res.json({ kpis: { activeProjects, runningAgents: running, idleAgents: idle, pendingApprovals: pending, totalAgents: agentCount, completedRuns }, projects, activity, proposals });
}));

/** Recent audit events for the live activity feed (the portal renders them as plain-English sentences). */
systemRouter.get("/activity", wrap(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  const projectId = Number(req.query.projectId) || null;
  if (!projectId) return res.json(await prisma.auditEvent.findMany({ orderBy: { id: "desc" }, take: limit }));
  // Project context: events whose target is the project, one of its tasks, or one of its proposals.
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { slug: true, tasks: { select: { id: true } }, proposals: { select: { id: true } } } });
  if (!p) return res.json([]);
  const targets = [`project:${p.slug}`, `project:${projectId}`, ...p.tasks.map(t => `task:${t.id}`), ...p.proposals.map(x => `proposal:${x.id}`)];
  res.json(await prisma.auditEvent.findMany({ where: { target: { in: targets } }, orderBy: { id: "desc" }, take: limit }));
}));

/** Liveness of backend, worker (heartbeat every poll) and Discord bot (heartbeat every poll). */
systemRouter.get("/health", wrap(async (_req, res) => {
  const beats = await prisma.setting.findMany({ where: { key: { in: ["heartbeat:worker", "heartbeat:bot"] } } });
  const beat = (k: string, maxAgeMs: number) => {
    const v = beats.find(b => b.key === k)?.value as { at?: string; [k: string]: unknown } | undefined;
    const at = v?.at ? new Date(v.at) : null;
    return { ok: !!at && Date.now() - at.getTime() < maxAgeMs, lastSeen: at?.toISOString() ?? null, info: v ?? null };
  };
  let database = true;
  try { await prisma.$queryRaw`SELECT 1`; } catch { database = false; }
  res.json({
    backend: { ok: true, uptimeSec: Math.round(process.uptime()) },
    database: { ok: database },
    worker: beat("heartbeat:worker", 30_000),
    bot: beat("heartbeat:bot", 45_000),
    github: { configured: githubConfigured() },
    claudeAuth: await getClaudeAuth(),
    previews: allPreviews(),
    vps: await vpsMetrics().catch(() => null),
    services: await devenumServices().catch(() => []),
  });
}));
