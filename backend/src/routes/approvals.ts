import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";

export const approvalsRouter = Router();

async function expireStale() {
  await prisma.proposal.updateMany({ where: { status: "PENDING", expiresAt: { lt: new Date() } }, data: { status: "EXPIRED" } });
}

approvalsRouter.get("/", wrap(async (req, res) => {
  await expireStale();
  const status = req.query.status as string | undefined;
  const rows = await prisma.proposal.findMany({
    where: status ? { status: status as never } : {},
    orderBy: { createdAt: "desc" },
    include: {
      project: { select: { id: true, name: true } },
      task: { select: { id: true, title: true } },
      requestingAgent: { select: { id: true, name: true, slug: true } },
      approvals: { include: { approver: { select: { name: true } } }, orderBy: { decidedAt: "desc" } },
    },
  });
  res.json(rows);
}));

// Only the CEO may decide proposals.
approvalsRouter.post("/:id/decision", requireRole("CEO"), wrap(async (req, res) => {
  const id = idParam(req);
  const { decision, comment } = z.object({
    decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
    comment: z.string().max(2000).optional(),
  }).parse(req.body);
  if (decision !== "APPROVED" && !comment?.trim()) throw new HttpError(400, "A comment is required for reject / request changes");

  const result = await prisma.$transaction(async tx => {
    const p = await tx.proposal.findUnique({ where: { id } });
    if (!p) throw new HttpError(404, "Proposal not found");
    if (p.status !== "PENDING") throw new HttpError(409, `Proposal already ${p.status}`);
    if (p.expiresAt < new Date()) {
      await tx.proposal.update({ where: { id }, data: { status: "EXPIRED" } });
      throw new HttpError(409, "Proposal has expired");
    }
    const approval = await tx.approval.create({ data: { proposalId: id, approverId: req.user!.id, decision, comment } });
    await tx.proposal.update({ where: { id }, data: { status: decision } });
    if (p.taskId) {
      await tx.task.update({ where: { id: p.taskId }, data: { status: decision === "APPROVED" ? "IN_PROGRESS" : "BLOCKED" } });
    }
    const agent = await tx.agent.findUnique({ where: { id: p.requestingAgentId } });
    if (agent && agent.status === "WAITING_APPROVAL") {
      await tx.agent.update({
        where: { id: agent.id },
        data: { status: decision === "APPROVED" ? "RUNNING" : "BLOCKED", currentTaskId: decision === "APPROVED" ? p.taskId : agent.currentTaskId },
      });
    }
    await audit("CEO", req.user!.id, `PROPOSAL_${decision}`, `proposal:${id}`, {
      actionType: p.actionType, targetResource: p.targetResource, riskLevel: p.riskLevel, comment: comment ?? null,
    }, tx);
    return approval;
  });
  res.json(result);
}));
