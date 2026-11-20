import { Router } from "express";
import { z } from "zod";
import { ActionType, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { loadSettings } from "./system";

export const tasksRouter = Router();
const writers = requireRole("CEO", "ADMIN");
const STATUSES = ["BACKLOG", "READY", "AWAITING_APPROVAL", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const agentSel = { id: true, name: true, slug: true, status: true } as const;

tasksRouter.get("/", wrap(async (req, res) => {
  const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
  res.json(await prisma.task.findMany({
    where: projectId ? { projectId } : {},
    orderBy: [{ createdAt: "desc" }],
    include: { assignedAgent: { select: agentSel }, project: { select: { id: true, name: true } } },
  }));
}));

tasksRouter.get("/:id", wrap(async (req, res) => {
  const t = await prisma.task.findUnique({
    where: { id: idParam(req) },
    include: {
      assignedAgent: { select: agentSel },
      project: { select: { id: true, name: true } },
      runs: { orderBy: { startedAt: "desc" }, take: 10, include: { agent: { select: { name: true } } } },
      proposals: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!t) throw new HttpError(404, "Task not found");
  res.json(t);
}));

tasksRouter.post("/", writers, wrap(async (req, res) => {
  const b = z.object({
    projectId: z.number().int(),
    assignedAgentId: z.number().int().nullable().optional(),
    title: z.string().min(2).max(200),
    description: z.string().max(10000).default(""),
    priority: z.enum(PRIORITIES).default("MEDIUM"),
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
    title: z.string().min(2).max(200).optional(),
    description: z.string().max(10000).optional(),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignedAgentId: z.number().int().nullable().optional(),
    outputSummary: z.string().max(10000).nullable().optional(),
  }).parse(req.body);
  const before = await prisma.task.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, "Task not found");
  if (b.assignedAgentId && !(await prisma.agent.findUnique({ where: { id: b.assignedAgentId } }))) throw new HttpError(404, "Agent not found");
  const t = await prisma.task.update({ where: { id }, data: b });
  await audit("CEO", req.user!.id, "TASK_UPDATED", `task:${id}`, {
    changed: b, before: { status: before.status, priority: before.priority, assignedAgentId: before.assignedAgentId },
  } as Prisma.InputJsonObject);
  res.json(t);
}));

tasksRouter.delete("/:id", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const t = await prisma.task.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, "Task not found");
  await prisma.$transaction(async tx => {
    await tx.agent.updateMany({ where: { currentTaskId: id }, data: { currentTaskId: null, status: "AVAILABLE" } });
    await tx.task.delete({ where: { id } });
    await audit("CEO", req.user!.id, "TASK_DELETED", `task:${id}`, { title: t.title, status: t.status }, tx);
  });
  res.json({ ok: true });
}));

/* ---------------- Agent run simulation ---------------- */

const ACTION_BY_DEPT: Record<string, ActionType> = {
  LEADERSHIP: "CONFIG_CHANGE", ARCHITECTURE: "CONFIG_CHANGE", DESIGN: "GIT_BRANCH_WRITE",
  ENGINEERING: "GIT_BRANCH_WRITE", QA_SECURITY: "CONFIG_CHANGE", DEVOPS: "DEPLOY_STAGING",
};
const RISK_BY_PRIORITY = { LOW: "LOW", MEDIUM: "LOW", HIGH: "MEDIUM", CRITICAL: "HIGH" } as const;

tasksRouter.post("/:id/simulate-run", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const task = await prisma.task.findUnique({ where: { id }, include: { project: true, assignedAgent: true } });
  if (!task) throw new HttpError(404, "Task not found");
  if (task.status !== "READY") throw new HttpError(409, "Only READY tasks can be run");
  const agent = task.assignedAgent;
  if (!agent) throw new HttpError(400, "Assign an agent to this task first");
  if (agent.status !== "AVAILABLE") throw new HttpError(409, `${agent.name} is ${agent.status.toLowerCase().replace(/_/g, " ")} and cannot start a run`);

  const settings = await loadSettings();
  const running = await prisma.agent.count({ where: { status: "RUNNING" } });
  if (running >= settings.maxConcurrentAgents) throw new HttpError(429, `Concurrency cap reached (${settings.maxConcurrentAgents} agents running)`);

  const maxSteps = Number((agent.manifest as Prisma.JsonObject)?.maxSteps ?? 50);
  const actionType: ActionType = agent.slug === "backend-developer" ? "DB_MIGRATION" : ACTION_BY_DEPT[agent.department];
  const riskLevel = RISK_BY_PRIORITY[task.priority];
  const branch = `agent/${agent.slug}/task-${task.id}`;
  const target = actionType === "DEPLOY_STAGING" ? `staging.${task.project.slug}.internal`
    : actionType === "CONFIG_CHANGE" ? `${task.project.repoPath || task.project.slug}/config`
    : `${task.project.repoPath || task.project.slug}@${branch}`;

  const executionMs = 20_000 + Math.floor(Math.random() * 70_000);
  const queuedMs = 300 + Math.floor(Math.random() * 1500);
  const startedAt = new Date(Date.now() - executionMs);
  const stamp = (offset: number) => new Date(startedAt.getTime() + offset).toISOString().slice(11, 19);
  const steps = [
    `Loaded manifest for ${agent.name} (${agent.modelProvider}, maxSteps=${maxSteps})`,
    `Read task #${task.id}: "${task.title}" [${task.priority}]`,
    `Checked out project ${task.project.name} on branch ${task.project.gitBranch}`,
    "Analysed repository structure and dependencies",
    "Drafted implementation plan (4 steps)",
    `Created working branch ${branch}`,
    "Implemented changes in sandbox",
    "Ran lint and unit tests: 42 passed, 0 failed",
    `Prepared ${actionType} request for ${target}`,
    "Submitted proposal to CEO Approval Inbox — waiting for decision",
  ];
  const logs = steps.map((s, i) => `[${stamp(Math.floor((executionMs / steps.length) * i))}] step ${i + 1}/${steps.length}: ${s}`).join("\n");

  const result = await prisma.$transaction(async tx => {
    const run = await tx.agentRun.create({
      data: { agentId: agent.id, taskId: task.id, status: "SUCCEEDED", queuedMs, executionMs, logs, startedAt, finishedAt: new Date() },
    });
    const proposal = await tx.proposal.create({
      data: {
        projectId: task.projectId, taskId: task.id, requestingAgentId: agent.id, actionType, targetResource: target,
        scopeSummary: `${agent.name} completed "${task.title}" and requests permission to apply the result via ${actionType.replace(/_/g, " ").toLowerCase()}.`,
        rationale: `Required to deliver task #${task.id}. Work was done in an isolated sandbox; tests passed.`,
        riskLevel,
        rollbackPlan: actionType === "DEPLOY_STAGING" ? "Redeploy the previous image tag and restore the staging snapshot."
          : actionType === "DB_MIGRATION" ? "Run the down-migration; take a database snapshot beforehand."
          : `Delete branch ${branch} / revert the merge commit. No other resources are touched.`,
        validationPlan: "Re-run the automated test suite, review the diff, and smoke-test the affected feature.",
        expiresAt: new Date(Date.now() + settings.autoExpireHours * 3600_000),
      },
    });
    await tx.task.update({ where: { id }, data: { status: "AWAITING_APPROVAL", executionTimeMs: executionMs, outputSummary: `Simulated run finished in ${Math.round(executionMs / 1000)}s. Awaiting CEO approval of ${actionType}.` } });
    await tx.agent.update({ where: { id: agent.id }, data: { status: "WAITING_APPROVAL", currentTaskId: task.id, totalRuns: { increment: 1 } } });
    await audit("CEO", req.user!.id, "TASK_RUN_TRIGGERED", `task:${id}`, { agent: agent.slug, runId: run.id }, tx);
    await audit("AGENT", agent.slug, "PROPOSAL_SUBMITTED", `proposal:${proposal.id}`, { actionType, riskLevel, taskId: id }, tx);
    return { run, proposal };
  });
  res.status(201).json(result);
}));
