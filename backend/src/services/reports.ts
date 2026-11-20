import { Prisma } from "@prisma/client";
import { prisma } from "../db";

/**
 * Daily CEO Executive Digest. Generated here (single implementation) — on schedule by devenum-worker, or on demand
 * from the portal (/analytics) and Discord (/report-daily). Stored as a Report; devenum-bot posts unposted reports to
 * #executive-reports (or #general).
 */
const fmtDur = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export async function generateDailyReport(generatedBy: string) {
  const tz = process.env.DIGEST_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = new Date(Date.now() - 24 * 3600_000);
  const dateLabel = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

  const [projects, counts, merged, runs, pending, blocked, agents] = await Promise.all([
    prisma.project.findMany({ where: { status: { in: ["PLANNING", "IN_PROGRESS", "REVIEW"] } }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, isFrozen: true, liveUrl: true } }),
    prisma.task.groupBy({ by: ["projectId", "status"], _count: true }),
    prisma.proposal.findMany({ where: { mergeStatus: "MERGED", mergedAt: { gte: since } }, select: { id: true, task: { select: { id: true, title: true } }, project: { select: { name: true } } } }),
    prisma.agentRun.findMany({ where: { startedAt: { gte: since } }, select: { agentId: true, status: true, executionMs: true } }),
    prisma.proposal.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { id: true, riskLevel: true, createdAt: true, expiresAt: true, qaReport: true, task: { select: { title: true } }, project: { select: { name: true } } } }),
    prisma.task.findMany({ where: { status: { in: ["BLOCKED", "NEEDS_RETRY"] } }, select: { id: true, title: true, status: true, project: { select: { name: true } } } }),
    prisma.agent.findMany({ select: { id: true, name: true } }),
  ]);

  const progress = projects.map(p => {
    const c = counts.filter(x => x.projectId === p.id);
    const total = c.reduce((s, x) => s + x._count, 0);
    const done = c.find(x => x.status === "DONE")?._count ?? 0;
    return { ...p, total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  });
  const succeeded = runs.filter(r => r.status === "SUCCEEDED").length;
  const failed = runs.filter(r => ["FAILED", "TIMED_OUT"].includes(r.status)).length;
  const aiMs = runs.reduce((s, r) => s + (r.executionMs ?? 0), 0);
  const perAgent = new Map<number, { ok: number; ms: number }>();
  for (const r of runs.filter(x => x.status === "SUCCEEDED")) {
    const e = perAgent.get(r.agentId) ?? { ok: 0, ms: 0 };
    e.ok++; e.ms += r.executionMs ?? 0; perAgent.set(r.agentId, e);
  }
  const top = [...perAgent.entries()].sort((a, b) => b[1].ok - a[1].ok || a[1].ms - b[1].ms)[0];
  const topAgent = top ? { name: agents.find(a => a.id === top[0])?.name ?? `agent #${top[0]}`, runs: top[1].ok } : null;

  const lines: string[] = [
    `# 📊 Executive Digest — ${dateLabel}`,
    "",
    "## Today at a glance (last 24 h)",
    `- ✅ **${merged.length}** task(s) approved & merged · 🤖 **${succeeded}** successful agent run(s)`,
    `- ⚠️ **${failed}** failed / timed-out run(s) · ⛔ **${blocked.length}** task(s) blocked or needing retry`,
    `- 📥 **${pending.length}** proposal(s) waiting for your approval`,
    `- ⏱ **${fmtDur(aiMs)}** of total AI execution time`,
    `- 🏆 Top performer: ${topAgent ? `**${topAgent.name}** (${topAgent.runs} successful run${topAgent.runs === 1 ? "" : "s"})` : "no completed runs today"}`,
    "",
    "## Active projects",
    ...(progress.length ? progress.map(p => `- **${p.name}** — ${p.done}/${p.total} tasks merged (${p.pct}%)${p.isFrozen ? " · ❄️ frozen" : ""}${p.liveUrl ? ` · live: ${p.liveUrl}` : ""}`) : ["- No active projects."]),
  ];
  if (merged.length) lines.push("", "## Merged today", ...merged.slice(0, 15).map(m => `- ${m.project.name}: task #${m.task?.id} ${m.task?.title ?? ""}`));
  if (pending.length) lines.push("", "## Waiting for your approval", ...pending.slice(0, 15).map(p => {
    const qa = p.qaReport as { status?: string; score?: number } | null;
    return `- #${p.id} ${p.project.name}: ${p.task?.title ?? "proposal"} · ${p.riskLevel} risk${qa?.status ? ` · QA ${qa.status === "PASSED" ? "passed" : "warning"} ${qa.score}` : ""} · expires ${p.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }));
  if (blocked.length) lines.push("", "## Needs attention", ...blocked.slice(0, 15).map(t => `- ${t.project.name}: task #${t.id} ${t.title} (${t.status === "NEEDS_RETRY" ? "timed out — retry" : "blocked"})`));

  const data = { date: dateLabel, timezone: tz, merged: merged.length, succeeded, failed, blocked: blocked.length, pending: pending.length, aiMs, topAgent, projects: progress };
  return prisma.report.create({ data: { kind: "DAILY", title: `Executive Digest — ${dateLabel}`, body: lines.join("\n"), data: data as unknown as Prisma.InputJsonObject, generatedBy: generatedBy.slice(0, 120) } });
}
