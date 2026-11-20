import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { wrap } from "../http";

export const logsRouter = Router();
// Read-only on purpose: logs are immutable via the API.

logsRouter.get("/runs", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const status = String(req.query.status ?? "");
  const where: Prisma.AgentRunWhereInput = {
    ...(status ? { status: status as never } : {}),
    ...(q ? { OR: [{ logs: { contains: q } }, { errorMessage: { contains: q } }, { agent: { name: { contains: q } } }, { task: { title: { contains: q } } }] } : {}),
  };
  res.json(await prisma.agentRun.findMany({
    where, orderBy: { startedAt: "desc" }, take: 200,
    include: { agent: { select: { name: true, slug: true } }, task: { select: { id: true, title: true } } },
  }));
}));

logsRouter.get("/decisions", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  res.json(await prisma.approval.findMany({
    where: q ? { OR: [{ comment: { contains: q } }, { proposal: { targetResource: { contains: q } } }, { proposal: { scopeSummary: { contains: q } } }] } : {},
    orderBy: { decidedAt: "desc" }, take: 200,
    include: { approver: { select: { name: true } }, proposal: { select: { id: true, actionType: true, targetResource: true, riskLevel: true } } },
  }));
}));

logsRouter.get("/audit", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const actorType = String(req.query.actorType ?? "");
  const action = String(req.query.action ?? "");
  res.json(await prisma.auditEvent.findMany({
    where: {
      ...(actorType ? { actorType: actorType as never } : {}),
      ...(action ? { action: { startsWith: action } } : {}),
      ...(q ? { OR: [{ action: { contains: q } }, { target: { contains: q } }, { actorId: { contains: q } }] } : {}),
    },
    orderBy: { createdAt: "desc" }, take: 300,
  }));
}));
