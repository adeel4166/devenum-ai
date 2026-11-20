"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Activity, BarChart3, Gauge, Loader2, Newspaper, Table2, Timer, Trophy } from "lucide-react";
import { api, AuditEvent, fmtDate, fmtMs } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { humanize } from "@/lib/humanize";
import { useApi } from "@/lib/useApi";
import { AgentAvatar, ErrorBox, PageHeader, Skeleton, StatCard } from "@/components/ui";

interface Leader { id: number; slug: string; name: string; roleTitle: string; status: string; runs: number; succeeded: number; failed: number; timedOut: number; successRate: number | null; avgMs: number }
interface Day { date: string; tasksCreated: number; runsSucceeded: number; runsFailed: number }
interface Analytics {
  leaderboard: Leader[]; daily: Day[]; auditTrail: AuditEvent[]; totals: { runs: number; avgMs: number };
  quota: { runsLast24h: number; cooldown: { detectedAt: string; message: string } | null; note: string };
  timeBreakdown: { queueWaitMs: number | null; activeAiMs: number | null; ceoWaitMs: number | null; samples: { queue: number; ai: number; ceo: number } };
}

function TimeBreakdownCard({ tb }: { tb: Analytics["timeBreakdown"] }) {
  const rows = [
    { label: "Queue wait", hint: "READY → an agent starts", v: tb.queueWaitMs, n: tb.samples.queue, tone: "text-indigo-300" },
    { label: "Active AI work", hint: "agent starts → work finished", v: tb.activeAiMs, n: tb.samples.ai, tone: "text-sky-300" },
    { label: "CEO review wait", hint: "work finished → you approve", v: tb.ceoWaitMs, n: tb.samples.ceo, tone: "text-amber-300" },
  ];
  return (
    <section className="card p-5">
      <h2 className="font-semibold text-white">Where the time goes · last 30 days</h2>
      <p className="mb-4 text-xs text-slate-500">Average per task. A long CEO review wait means the team is waiting on you, not the other way round.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map(r => (
          <div key={r.label} className="rounded-xl bg-ink-900 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-400">{r.label}</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${r.v == null ? "text-slate-600" : r.tone}`}>{r.v == null ? "—" : fmtMs(r.v)}</div>
            <div className="text-xs text-slate-500">{r.hint} · {r.n} task(s)</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Validated (dataviz validator, dark surface #21211f): single series = blue; succeeded/failed = aqua/red.
// The pair sits in the CVD 6–8 band, so failed segments also carry a texture + 2px gap, a legend and a table view.
const C = { tasks: "#3987e5", ok: "#199e70", bad: "#e66767" };
const FAILED_FILL = `repeating-linear-gradient(135deg, ${C.bad} 0 4px, rgba(0,0,0,.28) 4px 6px)`;
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function BarChart({ days, mode }: { days: Day[]; mode: "tasks" | "runs" }) {
  const [hover, setHover] = useState<number | null>(null);
  const val = (d: Day) => (mode === "tasks" ? d.tasksCreated : d.runsSucceeded + d.runsFailed);
  const max = Math.max(1, ...days.map(val));
  const ticks = [max, Math.round(max / 2), 0].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <div className="relative">
      <div className="flex h-44 gap-2">
        <div className="flex flex-col justify-between py-0.5 text-right text-[10px] tabular-nums text-slate-500">{ticks.map(t => <span key={t}>{t}</span>)}</div>
        <div className="relative flex flex-1 items-end gap-[2px] border-b border-white/15">
          {ticks.slice(0, -1).map(t => <div key={t} className="pointer-events-none absolute inset-x-0 border-t border-white/[0.05]" style={{ bottom: `${(t / max) * 100}%` }} />)}
          {days.map((d, i) => {
            const total = val(d);
            return (
              <div key={d.date} className="group relative flex h-full flex-1 cursor-default flex-col justify-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {mode === "tasks" ? (
                  <div className="mx-auto w-full max-w-[22px] rounded-t-[4px] transition-opacity" style={{ height: `${(total / max) * 100}%`, background: C.tasks, opacity: hover === null || hover === i ? 1 : 0.45, minHeight: total ? 2 : 0 }} />
                ) : (
                  <div className="mx-auto flex w-full max-w-[22px] flex-col justify-end gap-[2px] transition-opacity" style={{ height: `${(total / max) * 100}%`, opacity: hover === null || hover === i ? 1 : 0.45 }}>
                    {d.runsFailed > 0 && <div className="rounded-t-[4px]" style={{ flex: d.runsFailed, background: FAILED_FILL, minHeight: 2 }} />}
                    {d.runsSucceeded > 0 && <div className={d.runsFailed ? "" : "rounded-t-[4px]"} style={{ flex: d.runsSucceeded, background: C.ok, minHeight: 2 }} />}
                  </div>
                )}
              </div>
            );
          })}
      {hover !== null && (
            <div className="pointer-events-none absolute top-0 z-10 whitespace-nowrap -translate-x-1/2 -translate-y-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs shadow-xl"
              style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}>
              <div className="mb-1 font-medium text-slate-200">{dayLabel(days[hover].date)}</div>
              {mode === "tasks" ? <div className="text-slate-300">{days[hover].tasksCreated} task(s) created</div> : (
                <>
                  <div className="flex items-center gap-1.5 text-slate-300"><span className="h-2 w-2 rounded-sm" style={{ background: C.ok }} /> {days[hover].runsSucceeded} succeeded</div>
                  <div className="flex items-center gap-1.5 text-slate-300"><span className="h-2 w-2 rounded-sm" style={{ background: FAILED_FILL }} /> {days[hover].runsFailed} failed / timed out</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ml-6 mt-1 flex gap-[2px] pl-2 text-[10px] text-slate-500">
        {days.map((d, i) => <span key={d.date} className="flex-1 text-center">{i % 2 === 1 ? "" : dayLabel(d.date)}</span>)}
      </div>
    </div>
  );
}

function DailyCard({ data }: { data: Analytics }) {
  const [table, setTable] = useState(false);
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-semibold text-white">Daily volume · last 14 days</h2><p className="text-xs text-slate-500">Tasks created and agent runs finished per day.</p></div>
        <button className="btn-ghost !py-1 text-xs" onClick={() => setTable(t => !t)}>{table ? <BarChart3 size={13} /> : <Table2 size={13} />} {table ? "Show charts" : "Show table"}</button>
      </div>
      {table ? (
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-400"><th className="py-1.5 pr-4 font-medium">Day</th><th className="pr-4 font-medium">Tasks created</th><th className="pr-4 font-medium">Runs succeeded</th><th className="font-medium">Runs failed / timed out</th></tr></thead>
          <tbody>{[...data.daily].reverse().map(d => <tr key={d.date} className="border-t border-white/5 tabular-nums text-slate-300"><td className="py-1.5 pr-4">{dayLabel(d.date)}</td><td className="pr-4">{d.tasksCreated}</td><td className="pr-4">{d.runsSucceeded}</td><td>{d.runsFailed}</td></tr>)}</tbody>
        </table></div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <div><div className="mb-3 text-sm text-slate-300">Tasks created</div><BarChart days={data.daily} mode="tasks" /></div>
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-4 text-sm text-slate-300">
              <span>Agent runs</span>
              <span className="flex items-center gap-1.5 text-xs text-slate-400"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.ok }} /> Succeeded</span>
              <span className="flex items-center gap-1.5 text-xs text-slate-400"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: FAILED_FILL }} /> Failed / timed out</span>
            </div>
            <BarChart days={data.daily} mode="runs" />
          </div>
        </div>
      )}
    </section>
  );
}

function Leaderboard({ rows }: { rows: Leader[] }) {
  const maxRuns = Math.max(1, ...rows.map(r => r.succeeded));
  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 font-semibold text-white"><Trophy size={16} className="text-amber-300" /> Agent leaderboard</h2>
      <p className="mb-4 text-xs text-slate-500">Ranked by successful runs. Success rate counts finished runs only.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-xs text-slate-400"><th className="pb-2 font-medium">#</th><th className="pb-2 font-medium">Agent</th><th className="pb-2 font-medium">Completed runs</th><th className="pb-2 text-right font-medium">Success rate</th><th className="pb-2 text-right font-medium">Failed</th><th className="pb-2 text-right font-medium">Timed out</th><th className="pb-2 text-right font-medium">Avg duration</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="py-2.5 pr-3 tabular-nums text-slate-500">{i + 1}</td>
                <td className="py-2.5 pr-3"><div className="flex items-center gap-2.5"><AgentAvatar slug={r.slug} size={28} working={r.status === "RUNNING"} /><div><div className="text-slate-100">{r.name}</div><div className="text-xs text-slate-500">{r.roleTitle}</div></div></div></td>
                <td className="py-2.5 pr-3">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-28 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full" style={{ width: `${(r.succeeded / maxRuns) * 100}%`, background: C.tasks }} /></div>
                    <span className="tabular-nums text-slate-200">{r.succeeded}</span><span className="text-xs text-slate-500">/ {r.runs}</span>
                  </div>
                </td>
                <td className="py-2.5 text-right tabular-nums text-slate-200">{r.successRate == null ? "—" : `${r.successRate}%`}</td>
                <td className="py-2.5 text-right tabular-nums text-slate-400">{r.failed}</td>
                <td className="py-2.5 text-right tabular-nums text-slate-400">{r.timedOut}</td>
                <td className="py-2.5 text-right tabular-nums text-slate-300">{fmtMs(r.avgMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AuditTrail({ events }: { events: AuditEvent[] }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => events.map(e => ({ e, h: humanize(e) })).filter(({ e, h }) => !q || `${h.text} ${e.action} ${e.target ?? ""}`.toLowerCase().includes(q.toLowerCase())), [events, q]);
  return (
    <section className="card p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="font-semibold text-white">CEO audit trail</h2><p className="text-xs text-slate-500">Every decision and action taken by the CEO in the portal or via Discord (latest 200).</p></div>
        <input className="input !w-56" placeholder="Filter…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="max-h-[28rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-ink-800"><tr className="text-left text-xs text-slate-400"><th className="py-1.5 pr-4 font-medium">When</th><th className="pr-4 font-medium">Where</th><th className="pr-4 font-medium">What happened</th><th className="font-medium">Action</th></tr></thead>
          <tbody>
            {rows.map(({ e, h }) => (
              <tr key={e.id} className="border-t border-white/5 align-top">
                <td className="whitespace-nowrap py-2 pr-4 text-xs text-slate-500">{fmtDate(e.createdAt)}</td>
                <td className="py-2 pr-4 text-xs text-slate-400">{e.actorType === "DISCORD_CEO" ? "Discord" : "Portal"}</td>
                <td className="py-2 pr-4 text-slate-200">{h.text}{h.detail && <div className="text-xs text-slate-500">{h.detail}</div>}</td>
                <td className="py-2 font-mono text-[11px] text-slate-500">{e.action}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="py-6 text-center text-slate-500">No matching events.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function AnalyticsPage() {
  const router = useRouter();
  const { canWrite } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { data, error, loading } = useApi<Analytics>("/analytics", 30000);
  async function report() {
    setBusy(true);
    try { await api("/reports/generate", { method: "POST" }); toast("success", "Executive report generated"); router.push("/reports"); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  }
  const succeeded = data?.leaderboard.reduce((s, r) => s + r.succeeded, 0) ?? 0;
  const finished = data?.leaderboard.reduce((s, r) => s + r.succeeded + r.failed + r.timedOut, 0) ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Executive Analytics" subtitle="How your AI team is performing: throughput, reliability, speed, Claude usage, and a full record of your decisions."
        action={canWrite && <button className="btn-primary" onClick={report} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Newspaper size={15} />} Generate Executive Report Now</button>} />
      <ErrorBox message={error} />
      {loading && !data ? <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-64" /><Skeleton className="h-96" /></div> : data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Agent runs (all time)" value={data.totals.runs} hint={`${succeeded} succeeded`} icon={Activity} accent="bg-sky-500/15 text-sky-300" />
            <StatCard label="Success rate" value={finished ? `${Math.round((succeeded / finished) * 100)}%` : "—"} hint="Of finished runs" icon={Gauge} accent="bg-emerald-500/15 text-emerald-300" />
            <StatCard label="Avg run duration" value={fmtMs(data.totals.avgMs)} hint="Claude Code execution time" icon={Timer} accent="bg-violet-500/15 text-violet-300" />
            <div className={`card p-4 ${data.quota.cooldown ? "border-amber-500/40" : ""}`}>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Claude quota status</div>
              <div className={`mt-2 text-lg font-semibold ${data.quota.cooldown ? "text-amber-300" : "text-emerald-300"}`}>{data.quota.cooldown ? "⚠ Cooldown detected" : "✓ No limits hit"}</div>
              <div className="mt-1 text-xs text-slate-500">{data.quota.runsLast24h} run(s) in the last 24 h{data.quota.cooldown ? ` · limit seen ${fmtDate(data.quota.cooldown.detectedAt)}` : ""}</div>
              <div className="mt-1 text-[11px] leading-snug text-slate-600">{data.quota.note}</div>
            </div>
          </div>
          {data.timeBreakdown && <TimeBreakdownCard tb={data.timeBreakdown} />}
          <DailyCard data={data} />
          <Leaderboard rows={data.leaderboard} />
          <AuditTrail events={data.auditTrail} />
        </>
      )}
    </div>
  );
}
