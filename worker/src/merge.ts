import { log, prisma } from "./config";
import { mergeTaskBranch, payloadHash, workspacePath } from "./git";

/**
 * Approval Merge Hook: merges task/<id> into main for APPROVED worker proposals that have not been merged yet.
 * `withProjectLock` serialises git access per workspace with task execution.
 */
export async function processApprovedMerges(withProjectLock: (slug: string, fn: () => Promise<void>) => Promise<boolean>) {
  const pending = await prisma.proposal.findMany({
    where: { status: "APPROVED", branchName: { not: null }, mergeStatus: null, project: { isFrozen: false } }, // frozen projects: merges are held
    include: { project: true, task: true },
    orderBy: { createdAt: "asc" }, take: 10,
  });

  for (const p of pending) {
    await withProjectLock(p.project.slug, async () => {
      const ws = workspacePath(p.project.slug);
      const message = `Merge ${p.branchName}: ${p.task?.title ?? "task"} (proposal #${p.id} approved)`;
      let r: Awaited<ReturnType<typeof mergeTaskBranch>>;
      // Tamper-proof gate: the approval is only valid for the exact payload that was reviewed, and only until it expires.
      let invalid: { status: "EXPIRED" | "INVALIDATED"; reason: string } | null = null;
      if (p.expiresAt < (p.approvedAt ?? new Date())) invalid = { status: "EXPIRED", reason: `Approval came after the proposal expired (${p.expiresAt.toISOString()})` };
      else if (p.payloadHash) {
        try {
          const now = await payloadHash(ws, p.branchName!);
          if (now.hash !== p.payloadHash) invalid = { status: "INVALIDATED", reason: `Branch ${p.branchName} changed after review (reviewed ${p.headCommit?.slice(0, 10) ?? "?"}, now ${now.head.slice(0, 10)}) — payload hash mismatch` };
        } catch (e) { invalid = { status: "INVALIDATED", reason: `Could not verify payload hash: ${(e as Error).message.slice(0, 300)}` }; }
      }
      if (invalid) r = { ok: false, error: `Merge blocked — ${invalid.reason}` };
      else {
        try { r = await mergeTaskBranch(ws, p.branchName!, message); }
        catch (e) { r = { ok: false, error: (e as Error).message }; }
      }

      await prisma.$transaction(async tx => {
        if (r.ok) {
          await tx.proposal.update({ where: { id: p.id }, data: { mergeStatus: "MERGED", mergeCommit: r.commit, mergedAt: new Date() } });
          if (p.taskId) await tx.task.updateMany({ where: { id: p.taskId, status: { in: ["IN_PROGRESS", "AWAITING_APPROVAL", "IN_REVIEW"] } }, data: { status: "DONE" } });
          const [total, done] = await Promise.all([
            tx.task.count({ where: { projectId: p.projectId } }),
            tx.task.count({ where: { projectId: p.projectId, status: "DONE" } }),
          ]);
          await tx.project.update({ where: { id: p.projectId }, data: { progressPercent: total ? Math.round((done / total) * 100) : 0 } });
        } else {
          await tx.proposal.update({ where: { id: p.id }, data: { mergeStatus: "FAILED", mergeError: r.error, ...(invalid ? { status: invalid.status } : {}) } });
          if (p.taskId) await tx.task.update({ where: { id: p.taskId }, data: { status: "BLOCKED", outputSummary: `Merge of ${p.branchName} into main failed:\n${r.error}` } });
        }
        await tx.auditEvent.create({ data: {
          actorType: "SYSTEM", actorId: "devenum-worker", action: r.ok ? "TASK_BRANCH_MERGED" : invalid ? `PROPOSAL_${invalid.status}` : "TASK_BRANCH_MERGE_FAILED",
          target: `proposal:${p.id}`,
          details: { branch: p.branchName, workspace: ws, taskId: p.taskId, ...(r.ok ? { mergeCommit: r.commit } : { error: r.error.slice(0, 1000) }) },
        } });
      });
      log(r.ok ? "info" : "warn", r.ok ? "branch merged" : "merge failed", { proposalId: p.id, branch: p.branchName, ...(r.ok ? { commit: r.commit } : { error: r.error.slice(0, 300) }) });
    });
  }
}
