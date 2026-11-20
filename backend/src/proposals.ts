import { ActorType, Decision } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { HttpError } from "./http";
import { currentPayloadHash } from "./services/payloadHash";

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

  // Tamper-proof approvals: the branch must still be exactly what the agent submitted and the QA gate checked.
  if (decision === "APPROVED") {
    const p = await prisma.proposal.findUnique({ where: { id }, include: { project: true } });
    if (p?.status === "PENDING" && p.payloadHash && p.branchName) {
      let reason: string | null = null;
      try {
        const now = await currentPayloadHash(p.project.slug, p.branchName);
        if (now.hash !== p.payloadHash) reason = `branch ${p.branchName} changed after it was submitted (reviewed ${p.headCommit?.slice(0, 10) ?? "?"}, now ${now.head.slice(0, 10)})`;
      } catch (e) { reason = `the payload could not be verified (${(e as Error).message.slice(0, 200)})`; }
      if (reason) {
        await prisma.proposal.updateMany({ where: { id, status: "PENDING" }, data: { status: "INVALIDATED" } });
        if (p.taskId) await prisma.task.update({ where: { id: p.taskId }, data: { status: "BLOCKED", outputSummary: `Proposal #${id} was invalidated: ${reason}. Retry the task to produce a fresh proposal.` } });
        await audit(actor.actorType, actor.actorId, "PROPOSAL_INVALIDATED", `proposal:${id}`, { reason, ...(actor.context ?? {}) });
        throw new HttpError(409, `Approval blocked — ${reason}. The proposal has been marked INVALIDATED.`);
      }
    }
  }

  return prisma.$transaction(async tx => {
    const p = await tx.proposal.findUnique({ where: { id } });
    if (!p) throw new HttpError(404, "Proposal not found");
    if (p.status !== "PENDING") throw new HttpError(409, `Proposal already ${p.status}`);
    if (p.expiresAt < new Date()) {
      await tx.proposal.update({ where: { id }, data: { status: "EXPIRED" } });
      throw new HttpError(409, "Proposal has expired");
    }
    // Conditional update guards against two approvers racing (portal + Discord).
    const now = new Date();
    const claimed = await tx.proposal.updateMany({ where: { id, status: "PENDING" }, data: { status: decision, ...(decision === "APPROVED" ? { approvedAt: now } : {}) } });
    if (claimed.count !== 1) throw new HttpError(409, "Proposal was decided concurrently");
    const approval = await tx.approval.create({ data: { proposalId: id, approverId: actor.approverId, decision, comment } });
    if (p.taskId) {
      await tx.task.update({ where: { id: p.taskId }, data: { status: decision === "APPROVED" ? "IN_PROGRESS" : "BLOCKED", ...(decision === "APPROVED" ? { approvedAt: now } : {}) } });
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
