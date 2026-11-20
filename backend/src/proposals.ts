import { ActorType, Decision } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";

export interface DecisionActor {
  /** User row that the Approval is attributed to (the CEO). */
  approverId: number;
  actorType: ActorType;
  actorId: string | number;
  /** Extra audit context, e.g. the Discord user who clicked the button. */
  context?: Record<string, string>;
}

/**
 * Single source of truth for deciding a proposal (portal, /api/proposals and the Discord bot).
 * Approving a worker-produced proposal (branchName set) leaves mergeStatus null; devenum-worker
 * picks it up, merges task/<id> into main and marks the task DONE.
 */
export async function decideProposal(id: number, decision: Decision, actor: DecisionActor, comment?: string) {
  if (decision !== "APPROVED" && !comment?.trim()) throw new HttpError(400, "A comment is required for reject / request changes");

  return prisma.$transaction(async tx => {
    const p = await tx.proposal.findUnique({ where: { id } });
    if (!p) throw new HttpError(404, "Proposal not found");
    if (p.status !== "PENDING") throw new HttpError(409, `Proposal already ${p.status}`);
    if (p.expiresAt < new Date()) {
      await tx.proposal.update({ where: { id }, data: { status: "EXPIRED" } });
      throw new HttpError(409, "Proposal has expired");
    }
    // Conditional update guards against two approvers racing (portal + Discord).
    const claimed = await tx.proposal.updateMany({ where: { id, status: "PENDING" }, data: { status: decision } });
    if (claimed.count !== 1) throw new HttpError(409, "Proposal was decided concurrently");
    const approval = await tx.approval.create({ data: { proposalId: id, approverId: actor.approverId, decision, comment } });
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
    await audit(actor.actorType, actor.actorId, `PROPOSAL_${decision}`, `proposal:${id}`, {
      actionType: p.actionType, targetResource: p.targetResource, riskLevel: p.riskLevel, comment: comment ?? null,
      branchName: p.branchName, ...(actor.context ?? {}),
    }, tx);
    return approval;
  });
}
