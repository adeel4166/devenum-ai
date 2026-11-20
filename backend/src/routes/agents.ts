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
  allowedTools: z.array(z.string()),
  prohibitedActions: z.array(z.string()),
  maxSteps: z.number().int().min(1).max(1000),
  timeoutSeconds: z.number().int().min(10).max(86400),
}).passthrough();

async function withTask(agents: Awaited<ReturnType<typeof prisma.agent.findMany>>) {
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

agentsRouter.put("/:id/manifest", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const manifest = manifestSchema.parse(req.body.manifest);
  const body = z.object({ name: z.string().min(1).optional(), roleTitle: z.string().min(1).optional() }).parse(req.body);
  const before = await prisma.agent.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, "Agent not found");
  const updated = await prisma.agent.update({ where: { id }, data: { manifest: manifest as Prisma.InputJsonObject, ...body } });
  await audit("CEO", req.user!.id, "AGENT_MANIFEST_UPDATED", `agent:${before.slug}`, { before: before.manifest, after: manifest } as never);
  res.json(updated);
}));
