import { Router } from "express";
import { prisma } from "../db";
import { wrap } from "../http";

export const logsRouter = Router();
// Read-only on purpose: logs are immutable via the API.

logsRouter.get("/runs", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const runs = await prisma.agentRun.findMany({
    where: q ? { OR: [{ logs: { contains: q } }, { errorMessage: { contains: q } }, { agent: { name: { contains: q } } }, { task: { title: { contains: q } } }] } : {},
    orderBy: { startedAt: "desc" },
    take: 200,
    include: { agent: { select: { name: true, slug: true } }, task: { select: { id: true, title: true } } },
  });
  res.json(runs);
}));

logsRouter.get("/decisions", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const rows = await prisma.approval.findMany({
    where: q ? { OR: [{ comment: { contains: q } }, { proposal: { targetResource: { contains: q } } }, { proposal: { scopeSummary: { contains: q } } }] } : {},
    orderBy: { decidedAt: "desc" },
    take: 200,
    include: { approver: { select: { name: true } }, proposal: { select: { id: true, actionType: true, targetResource: true, riskLevel: true } } },
  });
  res.json(rows);
}));

logsRouter.get("/audit", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const rows = await prisma.auditEvent.findMany({
    where: q ? { OR: [{ action: { contains: q } }, { target: { contains: q } }, { actorId: { contains: q } }] } : {},
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  res.json(rows);
}));
