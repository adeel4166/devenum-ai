import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";

export const tasksRouter = Router();
const writers = requireRole("CEO", "ADMIN");
const STATUSES = ["BACKLOG", "READY", "AWAITING_APPROVAL", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"] as const;

tasksRouter.get("/", wrap(async (req, res) => {
  const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
  const tasks = await prisma.task.findMany({
    where: projectId ? { projectId } : {},
    orderBy: [{ createdAt: "desc" }],
    include: { assignedAgent: { select: { id: true, name: true, slug: true } }, project: { select: { id: true, name: true } } },
  });
  res.json(tasks);
}));

tasksRouter.post("/", writers, wrap(async (req, res) => {
  const b = z.object({
    projectId: z.number().int(),
    assignedAgentId: z.number().int().nullable().optional(),
    title: z.string().min(2).max(200),
    description: z.string().max(10000).default(""),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    status: z.enum(STATUSES).default("BACKLOG"),
    dependencies: z.array(z.number().int()).default([]),
  }).parse(req.body);
  if (!(await prisma.project.findUnique({ where: { id: b.projectId } }))) throw new HttpError(404, "Project not found");
  if (b.assignedAgentId && !(await prisma.agent.findUnique({ where: { id: b.assignedAgentId } }))) throw new HttpError(404, "Agent not found");
  const t = await prisma.task.create({ data: b });
  await audit("CEO", req.user!.id, "TASK_CREATED", `task:${t.id}`, { title: t.title, assignedAgentId: t.assignedAgentId });
  res.status(201).json(t);
}));

tasksRouter.patch("/:id", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    status: z.enum(STATUSES).optional(),
    assignedAgentId: z.number().int().nullable().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  }).parse(req.body);
  const before = await prisma.task.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, "Task not found");
  const t = await prisma.task.update({ where: { id }, data: b });
  await audit("CEO", req.user!.id, "TASK_UPDATED", `task:${id}`, { before: { status: before.status, assignedAgentId: before.assignedAgentId }, after: b });
  res.json(t);
}));
