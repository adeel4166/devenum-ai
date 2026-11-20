"use client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AuditEvent, fmtDate, fmtMs, label, RunLite } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, ErrorBox, Modal, PageHeader, Skeleton, Tabs, Terminal } from "@/components/ui";

interface Decision { id: number; decision: string; comment: string | null; decidedAt: string; approver: { name: string }; proposal: { id: number; actionType: string; targetResource: string; riskLevel: string } }

const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500";
const td = "px-3 py-2.5 align-top text-sm";
const PREFIXES = ["AUTH_", "AGENT_", "TASK_", "PROJECT_", "PROPOSAL_", "USER_", "SETTINGS_", "EMERGENCY_"];

export default function LogsPage() {
  const [tab, setTab] = useState<"audit" | "runs" | "decisions">("audit");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [prefix, setPrefix] = useState("");
  const [status, setStatus] = useState("");
  const [viewRun, setViewRun] = useState<RunLite | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(input), 300); return () => clearTimeout(t); }, [input]);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tab === "audit") { if (actor) params.set("actorType", actor); if (prefix) params.set("action", prefix); }
  if (tab === "runs" && status) params.set("status", status);
  const { data, error, loading } = useApi<unknown[]>(`/logs/${tab}${params.size ? `?${params}` : ""}`, 10000);

  return (
    <>
      <PageHeader title="Logs & Audit" subtitle="Read-only, append-only record. Entries cannot be edited or deleted." />
      <ErrorBox message={error} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "audit", label: "Audit Trail" }, { id: "runs", label: "Agent Runs" }, { id: "decisions", label: "CEO Decisions" }]} />
        {tab === "audit" && <>
          <select className="input !w-auto" value={actor} onChange={e => setActor(e.target.value)}><option value="">All actors</option>{["CEO", "AGENT", "SYSTEM"].map(a => <option key={a} value={a}>{a}</option>)}</select>
          <select className="input !w-auto" value={prefix} onChange={e => setPrefix(e.target.value)}><option value="">All actions</option>{PREFIXES.map(a => <option key={a} value={a}>{label(a.replace("_", ""))}</option>)}</select>
        </>}
        {tab === "runs" && <select className="input !w-auto" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].map(a => <option key={a} value={a}>{label(a)}</option>)}</select>}
        <div className="relative ml-auto w-full max-w-xs"><Search size={15} className="absolute left-3 top-2.5 text-slate-500" /><input className="input !pl-9" placeholder={tab === "audit" ? "Search actor, action, target…" : "Search…"} value={input} onChange={e => setInput(e.target.value)} /></div>
      </div>
      {loading && !data ? <Skeleton className="h-64" /> : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-white/5">
              {tab === "audit" && <tr><th className={th}>Time</th><th className={th}>Actor</th><th className={th}>Action</th><th className={th}>Target</th><th className={th}>Details</th></tr>}
              {tab === "runs" && <tr><th className={th}>Started</th><th className={th}>Agent</th><th className={th}>Task</th><th className={th}>Status</th><th className={th}>Queued</th><th className={th}>Execution</th><th className={th}></th></tr>}
              {tab === "decisions" && <tr><th className={th}>Decided</th><th className={th}>Approver</th><th className={th}>Decision</th><th className={th}>Action</th><th className={th}>Target</th><th className={th}>Comment</th></tr>}
            </thead>
            <tbody className="divide-y divide-white/5">
              {tab === "audit" && (data as AuditEvent[] | null)?.map(a => (
                <tr key={a.id}><td className={`${td} whitespace-nowrap`}>{fmtDate(a.createdAt)}</td><td className={td}>{a.actorType}{a.actorId && <span className="text-slate-500"> #{a.actorId}</span>}</td><td className={`${td} font-medium`}>{a.action}</td><td className={`${td} text-slate-400`}>{a.target}</td><td className={`${td} max-w-sm break-words font-mono text-xs text-slate-500`}>{a.details ? JSON.stringify(a.details).slice(0, 240) : ""}</td></tr>
              ))}
              {tab === "runs" && (data as RunLite[] | null)?.map(r => (
                <tr key={r.id} className="cursor-pointer hover:bg-white/[0.03]" onClick={() => setViewRun(r)}>
                  <td className={`${td} whitespace-nowrap`}>{fmtDate(r.startedAt)}</td><td className={td}>{r.agent?.name}</td><td className={td}>{r.task?.title ?? "—"}</td><td className={td}><Badge value={r.status} /></td><td className={td}>{fmtMs(r.queuedMs)}</td><td className={td}>{fmtMs(r.executionMs)}</td><td className={`${td} text-xs text-brand-soft`}>View log</td>
                </tr>
              ))}
              {tab === "decisions" && (data as Decision[] | null)?.map(d => (
                <tr key={d.id}><td className={`${td} whitespace-nowrap`}>{fmtDate(d.decidedAt)}</td><td className={td}>{d.approver.name}</td><td className={td}><Badge value={d.decision} dot={false} /></td><td className={td}>{label(d.proposal.actionType)}</td><td className={`${td} font-mono text-xs`}>{d.proposal.targetResource}</td><td className={td}>{d.comment ?? "—"}</td></tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">No entries match.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {viewRun && (
        <Modal title={`${viewRun.agent?.name ?? "Agent"} — run #${viewRun.id}`} onClose={() => setViewRun(null)} wide>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <Badge value={viewRun.status} /> <span>Task: {viewRun.task?.title ?? "—"}</span> <span>Execution: {fmtMs(viewRun.executionMs)}</span> <span>Queued: {fmtMs(viewRun.queuedMs)}</span> <span>{fmtDate(viewRun.startedAt)}</span>
          </div>
          {viewRun.errorMessage && <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{viewRun.errorMessage}</div>}
          <Terminal text={viewRun.logs || "(no output)"} />
        </Modal>
      )}
    </>
  );
}
