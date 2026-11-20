import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { idParam, wrap } from "../http";
import { decideProposal } from "../proposals";

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

  const result = await decideProposal(id, decision, { approverId: req.user!.id, actorType: "CEO", actorId: req.user!.id }, comment);
  res.json(result);
}));

/* Spec-style aliases used by the portal and integrations: POST /api/proposals/:id/approve | /reject */
export const proposalsRouter = Router();
const commentBody = z.object({ comment: z.string().max(2000).optional() });
proposalsRouter.post("/:id/approve", requireRole("CEO"), wrap(async (req, res) => {
  const { comment } = commentBody.parse(req.body ?? {});
  res.json(await decideProposal(idParam(req), "APPROVED", { approverId: req.user!.id, actorType: "CEO", actorId: req.user!.id }, comment));
}));
proposalsRouter.post("/:id/reject", requireRole("CEO"), wrap(async (req, res) => {
  const { comment } = commentBody.parse(req.body ?? {});
  res.json(await decideProposal(idParam(req), "REJECTED", { approverId: req.user!.id, actorType: "CEO", actorId: req.user!.id }, comment));
}));
