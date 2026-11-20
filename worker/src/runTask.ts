import { ActionType, Agent, Prisma, Project, RiskLevel, Task } from "@prisma/client";
import { config, loadSettings, log, prisma } from "./config";
import { ExecResult } from "./exec";
import { checkoutTaskBranch, commitAndDescribe, payloadHash, prepareRepo, taskBranch, workspacePath, BranchResult } from "./git";
import { buildPrompt, Manifest, pickProvider, Provider, runClaude, runGemini, section } from "./providers";
import { QaReport, runQa } from "./qa";
import { looksLikeAuthError, reportAuthFailure } from "./claudeAuth";

/** MySQL TEXT holds 65,535 bytes; keep head + tail of long text within a byte budget. */
export function clip(s: string, maxBytes = 60_000): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  const half = Math.floor(maxBytes / 2) - 100;
  const head = Buffer.from(s).subarray(0, half).toString().replace(/�+$/, "");
  const tail = Buffer.from(s).subarray(-half).toString().replace(/^�+/, "");
  return `${head}\n\n… [truncated ${Buffer.byteLength(s) - 2 * half} bytes] …\n\n${tail}`;
}

const SENSITIVE = [/(^|\/)prisma\/(schema\.prisma|migrations\/)/, /\.sql$/i, /(^|\/)migrations?\//i, /(^|\/)\.env/, /(^|\/)Dockerfile/i,
  /docker-compose/i, /(^|\/)\.github\//, /(^|\/)package(-lock)?\.json$/, /(^|\/)(infra|deploy|k8s|terraform)\//i, /(^|\/)ecosystem\.config/];
const DB_FILES = [/(^|\/)prisma\/(schema\.prisma|migrations\/)/, /\.sql$/i, /(^|\/)migrations?\//i];

function assessRisk(task: Task, br: BranchResult | null, failed: boolean): { risk: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  const files = br?.changedFiles ?? [];
  const sensitive = files.filter(f => SENSITIVE.some(re => re.test(f)));
  const lines = (br?.insertions ?? 0) + (br?.deletions ?? 0);
  if (failed) reasons.push("agent run did not finish successfully");
  if (sensitive.length) reasons.push(`touches sensitive files: ${sensitive.slice(0, 8).join(", ")}`);
  if (files.length > 40 || lines > 2000) reasons.push(`large change (${files.length} files, ${lines} lines)`);
  if (task.priority === "CRITICAL") reasons.push("CRITICAL priority task");
  if (reasons.length) return { risk: "HIGH", reasons };
  if (files.length > 10 || lines > 500) reasons.push(`medium-sized change (${files.length} files, ${lines} lines)`);
  if (task.priority === "HIGH") reasons.push("HIGH priority task");
  return { risk: reasons.length ? "MEDIUM" : "LOW", reasons: reasons.length ? reasons : [`small change (${files.length} files, ${lines} lines)`] };
}

type FullTask = Task & { project: Project; assignedAgent: Agent };

/** Atomically claims a READY task for an AVAILABLE agent. Returns the AgentRun id or null if someone else won. */
export async function claimTask(task: FullTask, provider: Provider): Promise<number | null> {
  try {
    return await prisma.$transaction(async tx => {
      const t = await tx.task.updateMany({ where: { id: task.id, status: "READY" }, data: { status: "IN_PROGRESS", startedAt: new Date(), queuedAt: task.queuedAt ?? task.createdAt } });
      if (t.count !== 1) throw new Error("lost-race");
      const a = await tx.agent.updateMany({ where: { id: task.assignedAgent.id, status: "AVAILABLE" }, data: { status: "RUNNING", currentTaskId: task.id } });
      if (a.count !== 1) throw new Error("lost-race");
      const run = await tx.agentRun.create({ data: {
        agentId: task.assignedAgent.id, taskId: task.id, status: "RUNNING",
        queuedMs: Math.min(Date.now() - (task.queuedAt ?? task.createdAt).getTime(), 2_147_483_647),
        queuedAt: task.queuedAt ?? task.createdAt,
        logs: `${config.logMarker} claimed task #${task.id} for ${task.assignedAgent.slug} via ${provider}\n`,
      } });
      await tx.auditEvent.create({ data: { actorType: "SYSTEM", actorId: "devenum-worker", action: "TASK_RUN_STARTED", target: `task:${task.id}`,
        details: { agent: task.assignedAgent.slug, runId: run.id, provider } } });
      return run.id;
    });
  } catch (e) {
    if ((e as Error).message === "lost-race") return null;
    throw e;
  }
}

/** Executes a claimed task end-to-end. Never throws; all failures are recorded on the run/task. */
export async function executeTask(task: FullTask, runId: number, provider: Provider, providerNote: string | undefined, signal: AbortSignal) {
  const { assignedAgent: agent, project } = task;
  const settings = await loadSettings();
  const manifest = (agent.manifest ?? {}) as Manifest;
  const timeoutSec = Math.max(30, Math.min(Number(manifest.timeoutSeconds) || 1800, settings.maxRunTimeoutSeconds));
  const branch = taskBranch(task.id);
  const header: string[] = [`${config.logMarker} run #${runId} task #${task.id} "${task.title}"`, `provider=${provider} timeout=${timeoutSec}s branch=${branch}`];
  if (providerNote) header.push(`note: ${providerNote}`);
  let live = "";
  let lastFlush = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - lastFlush < 3_000) return; // live log stream for the portal
    lastFlush = Date.now();
    await prisma.agentRun.update({ where: { id: runId }, data: { logs: clip(`${header.join("\n")}\n\n${live}`) } }).catch(() => undefined);
  };

  let ws = "";
  let result: ExecResult | null = null;
  let br: BranchResult | null = null;
  let errorMessage: string | null = null;

  try {
    ws = workspacePath(project.slug);
    header.push(`workspace=${ws}`);
    await prepareRepo(ws, `task #${task.id}`);
    const base = await checkoutTaskBranch(ws, branch, task.parentTaskId ? taskBranch(task.parentTaskId) : "main");
    if (base !== "main" && base !== branch) header.push(`based on ${base} (follow-up of task #${task.parentTaskId})`);

    const feedback = await prisma.approval.findMany({
      where: { proposal: { taskId: { in: task.parentTaskId ? [task.id, task.parentTaskId] : [task.id] } }, decision: { in: ["REJECTED", "CHANGES_REQUESTED"] }, comment: { not: null } },
      orderBy: { decidedAt: "asc" }, select: { comment: true },
    });
    const decisions = await prisma.projectDecision.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { title: true, decision: true, rationale: true } });
    if (decisions.length) header.push(`injected ${decisions.length} pinned project decision(s)`);
    const prompt = buildPrompt({ agent, manifest, project, task, branch, workspace: ws, provider, decisions,
      reviewFeedback: feedback.map(f => f.comment!).filter(Boolean) });
    await flush(true);

    const onOutput = (s: string) => { live += s; void flush(); };
    result = provider === "GEMINI_API"
      ? await runGemini(prompt, settings.geminiApiKey, ws, task.id, agent.slug, timeoutSec * 1000, signal)
      : await runClaude(prompt, ws, timeoutSec * 1000, signal, onOutput);

    // Expired/logged-out Claude CLI: not the agent's fault — re-queue the task and raise the auth alert.
    if (provider === "CLAUDE_CODE" && result.code !== 0 && !result.timedOut && looksLikeAuthError(`${result.stderr}\n${result.stdout}`)) {
      await reportAuthFailure(`task #${task.id} (${agent.slug})`, `${result.stderr}\n${result.stdout}`);
      result.aborted = true;
      errorMessage = "Claude CLI session expired — task re-queued. Run /claude-login in Discord to reconnect.";
    }
    const watchdog = signal.aborted && signal.reason === "watchdog";
    if (watchdog) { result.timedOut = true; result.aborted = false; }
    if (result.aborted && !errorMessage) errorMessage = "Cancelled: agent was paused/disabled or the system was paused during the run";
    else if (result.timedOut) errorMessage = watchdog ? `Watchdog: run exceeded ${timeoutSec}s + 60s buffer and was terminated` : `Timed out after ${timeoutSec}s`;
    else if (result.code !== 0) errorMessage = `${provider} exited with code ${result.code}: ${result.stderr.trim().slice(-1500)}`;

    br = await commitAndDescribe(ws, branch, `task #${task.id}: ${task.title}\n\nAgent: ${agent.name} (${agent.slug}) via ${provider}\nRun: #${runId}`,
      { name: `Devenum ${agent.name}`, email: `${agent.slug}@agents.devenum.local` });
  } catch (e) {
    errorMessage = errorMessage ?? `Worker error: ${(e as Error).message}`;
    log("error", "task execution error", { taskId: task.id, runId, error: (e as Error).message });
  }

  // Automated QA & security gate (only when a proposal will be created).
  let qa: QaReport | null = null;
  const timedOut = !!result?.timedOut;
  if (ws && br && !result?.aborted && !timedOut && !(errorMessage && !br.changedFiles.length)) {
    header.push("running automated QA gate…");
    await flush(true);
    try { qa = await runQa(ws, branch, { runFailed: !!errorMessage, changedFiles: br.changedFiles }); }
    catch (e) { qa = { status: "WARNINGS", score: 0, findings: [{ severity: "MEDIUM", check: "qa", message: `QA gate could not run: ${(e as Error).message.slice(0, 300)}` }], checks: [], ranAt: new Date().toISOString() }; }
  }

  let lock: { hash: string; head: string } | null = null;
  if (ws && br?.changedFiles.length) { try { lock = await payloadHash(ws, branch); } catch { lock = null; } }

  await finalize({ task, runId, provider, result, br, errorMessage, header, branch, ws, aborted: !!result?.aborted, timedOut, qa, lock, autoExpireHours: settings.autoExpireHours });
}

async function finalize(p: {
  task: FullTask; runId: number; provider: Provider; result: ExecResult | null; br: BranchResult | null; errorMessage: string | null;
  header: string[]; branch: string; ws: string; aborted: boolean; timedOut: boolean; qa: QaReport | null; lock: { hash: string; head: string } | null; autoExpireHours: number;
}) {
  const { task, runId, result, br, branch } = p;
  const agent = task.assignedAgent;
  const output = result?.stdout ?? "";
  const failed = !!p.errorMessage;
  const executionMs = result?.durationMs ?? 0;
  const changed = br?.changedFiles ?? [];

  const logs = clip([
    ...p.header, "",
    "===== agent output (stdout) =====", output.trim() || "(empty)", "",
    "===== stderr =====", result?.stderr.trim() || "(empty)", "",
    "===== git status --short (before commit) =====", br?.statusShort || "(clean)", "",
    `===== git diff --stat main...${branch} =====`, br?.diffStat || "(no changes)", "",
    `exit=${result?.code ?? "n/a"} timedOut=${result?.timedOut ?? false} executionMs=${executionMs}`,
    ...(p.qa ? ["", `===== QA gate: ${p.qa.status} (score ${p.qa.score}/100) =====`, ...p.qa.checks.map(c => `[${c.status}] ${c.name}: ${c.detail}`), ...p.qa.findings.map(f => `- ${f.severity} ${f.check}${f.file ? ` ${f.file}` : ""}: ${f.message.split("\n")[0]}`)] : []),
  ].join("\n"));

  const summary = section(output, "SUMMARY") ?? (output.trim().slice(-3000) || "(the agent produced no output)");
  const validation = section(output, "VALIDATION");
  const risks = section(output, "RISKS");
  const assessed = assessRisk(task, br, failed);
  const reasons = assessed.reasons;
  let risk = assessed.risk;
  if (p.qa?.status === "WARNINGS") { reasons.push(`QA gate reported warnings (score ${p.qa.score}/100)`); if (risk === "LOW") risk = "MEDIUM"; }
  if (p.qa?.findings.some(f => f.check === "secrets")) risk = "HIGH";
  const actionType: ActionType = changed.some(f => DB_FILES.some(re => re.test(f))) ? "DB_MIGRATION" : "GIT_BRANCH_WRITE";

  // Cancelled runs go back to READY; timed-out runs need a CEO retry (partial work stays on the branch);
  // runs with nothing to review are BLOCKED; everything else awaits approval.
  const outcome: "cancelled" | "timedout" | "blocked" | "proposal" =
    p.aborted ? "cancelled" : p.timedOut ? "timedout" : failed && changed.length === 0 ? "blocked" : "proposal";

  await prisma.$transaction(async tx => {
    await tx.agentRun.update({ where: { id: runId }, data: {
      status: p.aborted ? "CANCELLED" : p.timedOut ? "TIMED_OUT" : failed ? "FAILED" : "SUCCEEDED",
      executionMs: Math.min(executionMs, 2_147_483_647), logs, errorMessage: p.errorMessage, finishedAt: new Date(),
    } });
    // Don't clobber a PAUSED/DISABLED status the CEO set mid-run.
    const current = await tx.agent.findUnique({ where: { id: agent.id } });
    await tx.agent.update({ where: { id: agent.id }, data: {
      currentTaskId: null, totalRuns: { increment: 1 }, ...(current?.status === "RUNNING" ? { status: "AVAILABLE" } : {}),
    } });

    const taskSummary = clip(`${failed ? `⚠ ${p.errorMessage}\n\n` : ""}${summary}`, 20_000);
    if (outcome !== "proposal") {
      await tx.task.update({ where: { id: task.id }, data: { status: outcome === "cancelled" ? "READY" : outcome === "timedout" ? "NEEDS_RETRY" : "BLOCKED", outputSummary: taskSummary, executionTimeMs: executionMs,
        ...(outcome === "cancelled" ? { queuedAt: new Date(), startedAt: null } : { completedAt: new Date() }) } });
      await tx.auditEvent.create({ data: { actorType: "SYSTEM", actorId: "devenum-worker", action: outcome === "cancelled" ? "TASK_RUN_CANCELLED" : outcome === "timedout" ? "TASK_RUN_TIMED_OUT" : "TASK_RUN_FAILED",
        target: `task:${task.id}`, details: { agent: agent.slug, runId, error: p.errorMessage } } });
      return;
    }

    await tx.task.update({ where: { id: task.id }, data: { status: "AWAITING_APPROVAL", outputSummary: taskSummary, executionTimeMs: executionMs, completedAt: new Date() } });
    const filesList = changed.length ? changed.slice(0, 60).map(f => `- ${f}`).join("\n") + (changed.length > 60 ? `\n- … and ${changed.length - 60} more` : "") : "- (no file changes)";
    const proposal = await tx.proposal.create({ data: {
      projectId: task.projectId, taskId: task.id, requestingAgentId: agent.id, actionType,
      targetResource: `${p.ws}@${branch} → main`,
      scopeSummary: clip(`${failed ? `⚠ Run ended with an error: ${p.errorMessage}\n\n` : ""}${summary}\n\nChanged files (${changed.length}, +${br?.insertions ?? 0}/-${br?.deletions ?? 0}):\n${filesList}\n\n${br?.diffStat ?? ""}`, 60_000),
      rationale: clip(`Delivers task #${task.id} "${task.title}" (${task.priority}) by ${agent.name} via ${p.provider} in ${Math.round(executionMs / 1000)}s.\nRisk assessment: ${reasons.join("; ")}.${risks ? `\n\nAgent-reported risks:\n${risks}` : ""}`, 60_000),
      riskLevel: risk,
      rollbackPlan: `Approval merges ${branch} into main with a --no-ff merge commit in ${p.ws}. To roll back: git -C ${p.ws} revert -m 1 <merge-commit> (the commit hash is recorded on this proposal). Rejecting leaves main untouched; ${branch} is kept for reference.`,
      validationPlan: clip(validation ?? `Review the diff (git -C ${p.ws} diff main...${branch}), then run the project's build and test suite before approving.`, 20_000),
      branchName: branch,
      changedFiles: changed as Prisma.InputJsonArray,
      qaReport: (p.qa ?? undefined) as Prisma.InputJsonValue | undefined,
      payloadHash: p.lock?.hash ?? null,
      headCommit: p.lock?.head ?? null,
      expiresAt: new Date(Date.now() + p.autoExpireHours * 3600_000),
    } });
    await tx.auditEvent.create({ data: { actorType: "AGENT", actorId: agent.slug, action: "PROPOSAL_SUBMITTED", target: `proposal:${proposal.id}`,
      details: { actionType, riskLevel: risk, taskId: task.id, runId, branch, changedFiles: changed.length, provider: p.provider, qa: p.qa ? `${p.qa.status} ${p.qa.score}` : null } } });
  });
  log("info", "task finished", { taskId: task.id, runId, outcome, failed, changedFiles: changed.length, risk, qa: p.qa ? `${p.qa.status}/${p.qa.score}` : null });
}
