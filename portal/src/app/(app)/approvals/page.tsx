"use client";
import { useState } from "react";
import { Check, MessageSquareWarning, X } from "lucide-react";
import { api, fmtDate, label, Proposal } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { Badge, ErrorBox, PageHeader } from "@/components/ui";

export default function ApprovalsPage() {
  const { projectId, isCeo } = useSession();
  const [tab, setTab] = useState<"PENDING" | "ALL">("PENDING");
  const { data, error, reload } = useApi<Proposal[]>(`/approvals${tab === "PENDING" ? "?status=PENDING" : ""}`, 8000);
  const [err, setErr] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<number, string>>({});
  const list = (data ?? []).filter(p => !projectId || p.projectId === projectId);

  async function decide(p: Proposal, decision: string) {
    const comment = comments[p.id]?.trim();
    if (decision !== "APPROVED" && !comment) {
      setErr("Add a comment explaining your decision first.");
      return;
    }
    try {
      await api(`/approvals/${p.id}/decision`, { method: "POST", body: { decision, comment } });
      setErr(null);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Approval Inbox"
        subtitle="Agents cannot perform these actions until you decide"
        action={
          <div className="flex rounded-lg border border-white/10 p-0.5 text-sm">
            {(["PENDING", "ALL"] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 ${tab === t ? "bg-brand text-white" : "text-slate-400"}`}>
                {t === "PENDING" ? "Pending" : "History"}
              </button>
            ))}
          </div>
        }
      />
      <ErrorBox message={error || err} />
      {list.length === 0 && <div className="card p-8 text-center text-slate-500">No proposals here.</div>}
      <div className="space-y-5">
        {list.map(p => (
          <article key={p.id} className="card p-5">
            <header className="mb-4 flex flex-wrap items-center gap-3">
              <h2 className="font-semibold text-white">{label(p.actionType)}</h2>
              <Badge value={p.riskLevel} text={`${label(p.riskLevel)} risk`} />
              <Badge value={p.status} />
              <span className="ml-auto text-xs text-slate-500">{p.requestingAgent.name} · {p.project.name} · expires {fmtDate(p.expiresAt)}</span>
            </header>
            <p className="mb-4 font-mono text-xs text-slate-400">Target: {p.targetResource}</p>
            <div className="grid gap-4 md:grid-cols-2">
              <Block title="Scope" text={p.scopeSummary} />
              <Block title="Rationale" text={p.rationale} />
              <Block title="Rollback plan" text={p.rollbackPlan} />
              <Block title="Validation plan" text={p.validationPlan} />
            </div>
            {p.status === "PENDING" && isCeo && (
              <div className="mt-5 border-t border-white/5 pt-4">
                <input className="input mb-3" placeholder="Comment (required for Reject / Request changes)" value={comments[p.id] ?? ""} onChange={e => setComments({ ...comments, [p.id]: e.target.value })} />
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary" onClick={() => decide(p, "APPROVED")}><Check size={15} /> Approve</button>
                  <button className="btn-ghost" onClick={() => decide(p, "CHANGES_REQUESTED")}><MessageSquareWarning size={15} /> Request Changes</button>
                  <button className="btn-danger" onClick={() => decide(p, "REJECTED")}><X size={15} /> Reject</button>
                </div>
              </div>
            )}
            {p.status === "PENDING" && !isCeo && <p className="mt-4 text-xs text-slate-500">Only the CEO can decide proposals.</p>}
            {p.approvals[0] && (
              <p className="mt-4 text-xs text-slate-400">
                Decision by {p.approvals[0].approver.name} on {fmtDate(p.approvals[0].decidedAt)}
                {p.approvals[0].comment && `: “${p.approvals[0].comment}”`}
              </p>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

const Block = ({ title, text }: { title: string; text: string }) => (
  <div className="rounded-lg bg-ink-900 p-3">
    <div className="label">{title}</div>
    <p className="text-sm text-slate-300">{text}</p>
  </div>
);
