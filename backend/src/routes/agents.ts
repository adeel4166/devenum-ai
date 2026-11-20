import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";

export const agentsRouter = Router();
const writers = requireRole("CEO", "ADMIN");

const manifestSchema = z.object({
  allowedTools: z.array(z.string().min(1)),
  prohibitedActions: z.array(z.string().min(1)),
  maxSteps: z.number().int().min(1).max(1000),
  timeoutSeconds: z.number().int().min(10).max(86400),
}).passthrough();

async function withTask<T extends { currentTaskId: number | null }>(agents: T[]) {
  const ids = agents.map(a => a.currentTaskId).filter((x): x is number => x != null);
  const tasks = ids.length ? await prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, projectId: true } }) : [];
  return agents.map(a => ({ ...a, currentTask: tasks.find(t => t.id === a.currentTaskId) ?? null }));
}

agentsRouter.get("/", wrap(async (req, res) => {
  const { department, status } = req.query as Record<string, string | undefined>;
  const agents = await prisma.agent.findMany({
    where: { ...(department ? { department: department as never } : {}), ...(status ? { status: status as never } : {}) },
    orderBy: { id: "asc" },
  });
  res.json(await withTask(agents));
}));

agentsRouter.get("/:id", wrap(async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: idParam(req) } });
  if (!agent) throw new HttpError(404, "Agent not found");
  const [withT] = await withTask([agent]);
  const runs = await prisma.agentRun.findMany({
    where: { agentId: agent.id }, orderBy: { startedAt: "desc" }, take: 10,
    include: { task: { select: { id: true, title: true } } },
  });
  res.json({ ...withT, runs });
}));

agentsRouter.post("/:id/action", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const { action } = z.object({ action: z.enum(["pause", "resume", "disable", "enable"]) }).parse(req.body);
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) throw new HttpError(404, "Agent not found");
  const resumed = agent.currentTaskId ? "RUNNING" : "AVAILABLE";
  const next = { pause: "PAUSED", resume: resumed, disable: "DISABLED", enable: "AVAILABLE" }[action] as typeof agent.status;
  if (action === "resume" && agent.status !== "PAUSED") throw new HttpError(409, "Only paused agents can be resumed");
  if (action === "enable" && agent.status !== "DISABLED") throw new HttpError(409, "Agent is not disabled");
  const updated = await prisma.agent.update({ where: { id }, data: { status: next } });
  await audit("CEO", req.user!.id, `AGENT_${action.toUpperCase()}`, `agent:${agent.slug}`, { from: agent.status, to: next });
  res.json(updated);
}));

// Full agent update: provider, status, role title and manifest in one call.
agentsRouter.patch("/:id", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    modelProvider: z.enum(["CLAUDE_CODE", "GEMINI_API"]).optional(),
    status: z.enum(["AVAILABLE", "RUNNING", "WAITING_APPROVAL", "BLOCKED", "PAUSED", "FAILED", "DISABLED"]).optional(),
    roleTitle: z.string().min(2).max(100).optional(),
    name: z.string().min(2).max(100).optional(),
    manifest: manifestSchema.optional(),
  }).parse(req.body);
  const before = await prisma.agent.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, "Agent not found");
  const { manifest, ...rest } = b;
  const merged = manifest ? { ...(before.manifest as Prisma.JsonObject), ...manifest } : undefined;
  const updated = await prisma.agent.update({
    where: { id },
    data: { ...rest, ...(merged ? { manifest: merged as Prisma.InputJsonObject } : {}) },
  });
  await audit("CEO", req.user!.id, "AGENT_UPDATED", `agent:${before.slug}`, {
    changed: Object.keys(b),
    before: { modelProvider: before.modelProvider, status: before.status, roleTitle: before.roleTitle, manifest: before.manifest },
    after: { modelProvider: updated.modelProvider, status: updated.status, roleTitle: updated.roleTitle, manifest: updated.manifest },
  } as Prisma.InputJsonObject);
  res.json(updated);
}));
