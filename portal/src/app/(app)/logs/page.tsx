"use client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { AuditEvent, fmtDate, fmtMs, label } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Badge, ErrorBox, PageHeader } from "@/components/ui";

interface Run { id: number; status: string; queuedMs: number; executionMs: number; logs: string; errorMessage: string | null; startedAt: string; agent: { name: string }; task: { title: string } | null }
interface Decision { id: number; decision: string; comment: string | null; decidedAt: string; approver: { name: string }; proposal: { id: number; actionType: string; targetResource: string; riskLevel: string } }

const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500";
const td = "px-3 py-2.5 align-top text-sm";

export default function LogsPage() {
  const [tab, setTab] = useState<"runs" | "decisions" | "audit">("runs");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(input), 300);
    return () => clearTimeout(t);
  }, [input]);
  const { data, error } = useApi<unknown[]>(`/logs/${tab}${q ? `?q=${encodeURIComponent(q)}` : ""}`, 10000);

  return (
    <>
      <PageHeader title="Logs & Audit" subtitle="Read-only, append-only record. Entries cannot be edited or deleted." />
      <ErrorBox message={error} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-white/10 p-0.5 text-sm">
          {([["runs", "Agent runs"], ["decisions", "CEO decisions"], ["audit", "Audit events"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1 ${tab === k ? "bg-brand text-white" : "text-slate-400"}`}>{l}</button>
          ))}
        </div>
        <div className="relative ml-auto w-full max-w-xs">
          <Search size={15} className="absolute left-3 top-2.5 text-slate-500" />
          <input className="input !pl-9" placeholder="Search…" value={input} onChange={e => setInput(e.target.value)} />
        </div>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-white/5">
            {tab === "runs" && <tr><th className={th}>Started</th><th className={th}>Agent</th><th className={th}>Task</th><th className={th}>Status</th><th className={th}>Queued</th><th className={th}>Execution</th><th className={th}>Output</th></tr>}
            {tab === "decisions" && <tr><th className={th}>Decided</th><th className={th}>Approver</th><th className={th}>Decision</th><th className={th}>Action</th><th className={th}>Target</th><th className={th}>Comment</th></tr>}
            {tab === "audit" && <tr><th className={th}>Time</th><th className={th}>Actor</th><th className={th}>Action</th><th className={th}>Target</th><th className={th}>Details</th></tr>}
          </thead>
          <tbody className="divide-y divide-white/5">
            {tab === "runs" && (data as Run[] | null)?.map(r => (
              <tr key={r.id}>
                <td className={td}>{fmtDate(r.startedAt)}</td>
                <td className={td}>{r.agent.name}</td>
                <td className={td}>{r.task?.title ?? "—"}</td>
                <td className={td}><Badge value={r.status} /></td>
                <td className={td}>{fmtMs(r.queuedMs)}</td>
                <td className={td}>{fmtMs(r.executionMs)}</td>
                <td className={`${td} max-w-md`}><pre className="whitespace-pre-wrap font-mono text-xs text-slate-400">{r.errorMessage ? `ERROR: ${r.errorMessage}\n` : ""}{r.logs}</pre></td>
              </tr>
            ))}
            {tab === "decisions" && (data as Decision[] | null)?.map(d => (
              <tr key={d.id}>
                <td className={td}>{fmtDate(d.decidedAt)}</td>
                <td className={td}>{d.approver.name}</td>
                <td className={td}><Badge value={d.decision} /></td>
                <td className={td}>{label(d.proposal.actionType)}</td>
                <td className={`${td} font-mono text-xs`}>{d.proposal.targetResource}</td>
                <td className={td}>{d.comment ?? "—"}</td>
              </tr>
            ))}
            {tab === "audit" && (data as AuditEvent[] | null)?.map(a => (
              <tr key={a.id}>
                <td className={td}>{fmtDate(a.createdAt)}</td>
                <td className={td}>{a.actorType}{a.actorId && <span className="text-slate-500"> #{a.actorId}</span>}</td>
                <td className={`${td} font-medium`}>{a.action}</td>
                <td className={`${td} text-slate-400`}>{a.target}</td>
                <td className={`${td} max-w-sm font-mono text-xs text-slate-500`}>{a.details ? JSON.stringify(a.details) : ""}</td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-500">No entries.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
