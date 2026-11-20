import { config, loadSettings, log, prisma } from "./config";
import { processApprovedMerges } from "./merge";
import { pickProvider } from "./providers";
import { claimTask, executeTask } from "./runTask";
import { authWatchdog, claudeAuthOk } from "./claudeAuth";

interface Active { taskId: number; agentId: number; slug: string; abort: AbortController; done: Promise<void>; startedAt: number; timeoutSec: number }
const WATCHDOG_BUFFER_SEC = 60;
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

/**
 * Watchdog auto-heal: terminate runs that exceed their timeout + 60s buffer (the run is then recorded as TIMED_OUT,
 * the task as NEEDS_RETRY and the bot posts a Retry alert), and heal stale RUNNING rows this worker doesn't own.
 */
async function watchdog(maxRunTimeoutSeconds: number) {
  for (const [runId, a] of active) {
    if (!a.abort.signal.aborted && Date.now() - a.startedAt > (a.timeoutSec + WATCHDOG_BUFFER_SEC) * 1000) {
      log("warn", "watchdog terminating hung run", { runId, taskId: a.taskId, timeoutSec: a.timeoutSec });
      a.abort.abort("watchdog");
    }
  }
  const cutoff = new Date(Date.now() - (maxRunTimeoutSeconds + WATCHDOG_BUFFER_SEC) * 1000);
  const stale = await prisma.agentRun.findMany({
    where: { status: "RUNNING", logs: { startsWith: config.logMarker }, startedAt: { lt: cutoff }, id: { notIn: [...active.keys()] } },
  });
  for (const r of stale) {
    await prisma.$transaction(async tx => {
      await tx.agentRun.update({ where: { id: r.id }, data: { status: "TIMED_OUT", errorMessage: "Watchdog: run was stuck in RUNNING without an active process", finishedAt: new Date() } });
      if (r.taskId) await tx.task.updateMany({ where: { id: r.taskId, status: "IN_PROGRESS" }, data: { status: "NEEDS_RETRY" } });
      await tx.agent.updateMany({ where: { id: r.agentId, status: "RUNNING" }, data: { status: "AVAILABLE", currentTaskId: null } });
      await tx.auditEvent.create({ data: { actorType: "SYSTEM", actorId: "devenum-worker", action: "TASK_RUN_TIMED_OUT", target: `task:${r.taskId}`, details: { runId: r.id, watchdog: true } } });
    });
    log("warn", "watchdog healed stale run", { runId: r.id, taskId: r.taskId });
  }
}

/**
 * Daily CEO digest at DIGEST_HOUR (default 21:00) in DIGEST_TIMEZONE (default: server local time). The worker only
 * schedules it; the backend generates and stores the report and the bot posts it to Discord.
 */
async function maybeDailyDigest() {
  const tz = process.env.DIGEST_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  if (Number(parts.hour) < Number(process.env.DIGEST_HOUR ?? 21)) return;
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const last = await prisma.setting.findUnique({ where: { key: "digest:lastDate" } });
  if (last?.value === today) return;
  const token = process.env.BOT_SERVICE_TOKEN;
  if (!token) return;
  const res = await fetch(`${process.env.BACKEND_URL || "http://127.0.0.1:4200"}/api/bot/reports/daily`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-discord-user-id": "devenum-worker", "x-discord-user-tag": "scheduler" },
    body: JSON.stringify({ generatedBy: "scheduler" }), signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`backend responded ${res.status}`);
  await prisma.setting.upsert({ where: { key: "digest:lastDate" }, create: { key: "digest:lastDate", value: today }, update: { value: today } });
  log("info", "daily digest generated", { date: today, tz });
}

async function tick() {
  const settings = await loadSettings();
  // Liveness for the portal's health panel.
  const beat = { at: new Date().toISOString(), activeRuns: active.size, paused: settings.globalPaused };
  await prisma.setting.upsert({ where: { key: "heartbeat:worker" }, create: { key: "heartbeat:worker", value: beat }, update: { value: beat } });

  // Cancel in-flight runs when the system or the agent gets paused/disabled, or the project gets frozen.
  if (active.size) {
    const agents = await prisma.agent.findMany({ where: { id: { in: [...active.values()].map(a => a.agentId) } }, select: { id: true, status: true } });
    const frozen = new Set((await prisma.project.findMany({ where: { isFrozen: true }, select: { slug: true } })).map(p => p.slug));
    for (const a of active.values()) {
      const st = agents.find(x => x.id === a.agentId)?.status;
      if ((settings.globalPaused || frozen.has(a.slug) || (st && st !== "RUNNING")) && !a.abort.signal.aborted) {
        log("warn", "cancelling run", { taskId: a.taskId, agentStatus: st, globalPaused: settings.globalPaused });
        a.abort.abort();
      }
    }
  }
  await watchdog(settings.maxRunTimeoutSeconds);
  await maybeDailyDigest().catch(e => log("warn", "daily digest trigger failed", { error: (e as Error).message }));
  if (settings.globalPaused) return;

  await processApprovedMerges(withProjectLock);

  // Claude CLI auth watchdog: never start runs that are certain to fail; probe for recovery instead.
  await authWatchdog().catch(e => log("warn", "auth watchdog failed", { error: (e as Error).message }));
  if (!(await claudeAuthOk())) return;

  const slots = settings.maxConcurrentAgents - active.size;
  if (slots <= 0) return;

  const candidates = await prisma.task.findMany({
    where: { status: "READY", assignedAgent: { status: "AVAILABLE" }, project: { isFrozen: false } }, // paused agents & frozen projects are skipped
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
    const manifestTimeout = Number((agent.manifest as { timeoutSeconds?: number } | null)?.timeoutSeconds) || 1800;
    const timeoutSec = Math.max(30, Math.min(manifestTimeout, settings.maxRunTimeoutSeconds));
    log("info", "task claimed", { taskId: task.id, runId, agent: agent.slug, provider, project: task.project.slug });
    const done = executeTask({ ...task, assignedAgent: agent }, runId, provider, note, abort.signal)
      .catch(e => log("error", "executeTask crashed", { taskId: task.id, error: (e as Error).message }))
      .finally(() => { active.delete(runId); busyProjects.delete(task.project.slug); });
    active.set(runId, { taskId: task.id, agentId: agent.id, slug: task.project.slug, abort, done, startedAt: Date.now(), timeoutSec });
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
