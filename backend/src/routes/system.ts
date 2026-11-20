import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { wrap } from "../http";

export const systemRouter = Router();
const writers = requireRole("CEO", "ADMIN");

export const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  claudeCliMode: true,
  globalPaused: false,
  maxConcurrentAgents: 3,
  maxStepsPerRun: 50,
  maxRunTimeoutSeconds: 1800,
  dailyTokenBudget: 2_000_000,
  requireApprovalForHighRisk: true,
};
type Settings = typeof DEFAULT_SETTINGS;

async function loadSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany();
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s as Settings;
}
const mask = (s: Settings) => ({ ...s, geminiApiKey: s.geminiApiKey ? "•".repeat(8) + s.geminiApiKey.slice(-4) : "" });

systemRouter.get("/settings", wrap(async (_req, res) => res.json(mask(await loadSettings()))));

systemRouter.put("/settings", writers, wrap(async (req, res) => {
  const b = z.object({
    geminiApiKey: z.string().max(200).optional(),
    claudeCliMode: z.boolean().optional(),
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
  res.json({ globalPaused: (await loadSettings()).globalPaused });
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
  const [activeProjects, running, idle, pending, projects, activity, proposals, agentCount] = await Promise.all([
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
  ]);
  res.json({ kpis: { activeProjects, runningAgents: running, idleAgents: idle, pendingApprovals: pending, totalAgents: agentCount }, projects, activity, proposals });
}));
