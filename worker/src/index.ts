import { config, loadSettings, log, prisma } from "./config";
import { processApprovedMerges } from "./merge";
import { pickProvider } from "./providers";
import { claimTask, executeTask } from "./runTask";

interface Active { taskId: number; agentId: number; slug: string; abort: AbortController; done: Promise<void> }
const active = new Map<number, Active>(); // keyed by AgentRun id
const busyProjects = new Set<string>();   // one git operation per workspace at a time
let ticking = false;
let stopping = false;

async function withProjectLock(slug: string, fn: () => Promise<void>): Promise<boolean> {
  if (busyProjects.has(slug)) return false;
  busyProjects.add(slug);
  try { await fn(); } finally { busyProjects.delete(slug); }
  return true;
}

/** Runs left RUNNING by a previous worker process can't be resumed: fail them and free their agents. */
async function recoverOrphans() {
  const orphans = await prisma.agentRun.findMany({ where: { status: "RUNNING", logs: { startsWith: config.logMarker } } });
  for (const r of orphans) {
    await prisma.$transaction(async tx => {
      await tx.agentRun.update({ where: { id: r.id }, data: { status: "FAILED", errorMessage: "Worker restarted while this run was in progress", finishedAt: new Date() } });
      if (r.taskId) {
        await tx.task.updateMany({ where: { id: r.taskId, status: "IN_PROGRESS" }, data: { status: "BLOCKED", outputSummary: "Run interrupted by a worker restart. Set the task back to READY to retry." } });
        await tx.agent.updateMany({ where: { id: r.agentId, currentTaskId: r.taskId }, data: { currentTaskId: null } });
      }
      await tx.agent.updateMany({ where: { id: r.agentId, status: "RUNNING", currentTaskId: null }, data: { status: "AVAILABLE" } });
      await tx.auditEvent.create({ data: { actorType: "SYSTEM", actorId: "devenum-worker", action: "TASK_RUN_ORPHANED", target: `task:${r.taskId}`, details: { runId: r.id } } });
    });
    log("warn", "recovered orphaned run", { runId: r.id, taskId: r.taskId });
  }
}

async function tick() {
  const settings = await loadSettings();
  // Liveness for the portal's health panel.
  const beat = { at: new Date().toISOString(), activeRuns: active.size, paused: settings.globalPaused };
  await prisma.setting.upsert({ where: { key: "heartbeat:worker" }, create: { key: "heartbeat:worker", value: beat }, update: { value: beat } });

  // Cancel in-flight runs when the system or the agent gets paused/disabled.
  if (active.size) {
    const agents = await prisma.agent.findMany({ where: { id: { in: [...active.values()].map(a => a.agentId) } }, select: { id: true, status: true } });
    for (const a of active.values()) {
      const st = agents.find(x => x.id === a.agentId)?.status;
      if ((settings.globalPaused || (st && st !== "RUNNING")) && !a.abort.signal.aborted) {
        log("warn", "cancelling run", { taskId: a.taskId, agentStatus: st, globalPaused: settings.globalPaused });
        a.abort.abort();
      }
    }
  }
  if (settings.globalPaused) return;

  await processApprovedMerges(withProjectLock);

  const slots = settings.maxConcurrentAgents - active.size;
  if (slots <= 0) return;

  const candidates = await prisma.task.findMany({
    where: { status: "READY", assignedAgent: { status: "AVAILABLE" } },
    include: { project: true, assignedAgent: true },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 25,
  });

  let started = 0;
  const usedAgents = new Set<number>();
  for (const task of candidates) {
    if (started >= slots) break;
    const agent = task.assignedAgent!;
    if (busyProjects.has(task.project.slug) || usedAgents.has(agent.id)) continue;

    const deps = Array.isArray(task.dependencies) ? (task.dependencies as unknown[]).filter((d): d is number => typeof d === "number") : [];
    if (deps.length && (await prisma.task.count({ where: { id: { in: deps }, status: { not: "DONE" } } })) > 0) continue;

    const { provider, note } = pickProvider(agent, settings);
    if (provider === "CLAUDE_CODE" && settings.claudeCliEnabled === false) continue;

    const runId = await claimTask({ ...task, assignedAgent: agent }, provider);
    if (runId == null) continue;

    usedAgents.add(agent.id);
    busyProjects.add(task.project.slug);
    started++;
    const abort = new AbortController();
    log("info", "task claimed", { taskId: task.id, runId, agent: agent.slug, provider, project: task.project.slug });
    const done = executeTask({ ...task, assignedAgent: agent }, runId, provider, note, abort.signal)
      .catch(e => log("error", "executeTask crashed", { taskId: task.id, error: (e as Error).message }))
      .finally(() => { active.delete(runId); busyProjects.delete(task.project.slug); });
    active.set(runId, { taskId: task.id, agentId: agent.id, slug: task.project.slug, abort, done });
  }
}

async function loop() {
  if (stopping) return;
  if (!ticking) {
    ticking = true;
    try { await tick(); } catch (e) { log("error", "tick failed", { error: (e as Error).message }); }
    finally { ticking = false; }
  }
  setTimeout(loop, config.pollIntervalMs);
}

async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log("info", "shutting down", { signal: sig, activeRuns: active.size });
  // Cancelled runs are recorded as CANCELLED and their tasks return to READY.
  for (const a of active.values()) a.abort.abort();
  await Promise.race([Promise.allSettled([...active.values()].map(a => a.done)), new Promise(r => setTimeout(r, 25_000))]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

(async () => {
  log("info", "starting", { workspacesDir: config.workspacesDir, runAsUser: config.runAsUser, pollIntervalMs: config.pollIntervalMs, uid: process.getuid?.() });
  await recoverOrphans();
  await loop();
})().catch(e => { log("error", "fatal", { error: (e as Error).message }); process.exit(1); });
