"use client";
import { useState } from "react";
import { Check, ChevronDown, MessageSquareWarning, X } from "lucide-react";
import { api, fmtDate, label, Proposal } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, CardSkeletons, ErrorBox, PageHeader, Tabs } from "@/components/ui";

const MSG: Record<string, string> = { APPROVED: "Proposal approved", REJECTED: "Proposal rejected", CHANGES_REQUESTED: "Changes requested" };

export default function ApprovalsPage() {
  const { projectId, isCeo } = useSession();
  const { run } = useToast();
  const [tab, setTab] = useState<"PENDING" | "HISTORY">("PENDING");
  const { data, error, loading, reload } = useApi<Proposal[]>("/approvals", 8000);
  const [comments, setComments] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const scoped = (data ?? []).filter(p => !projectId || p.projectId === projectId);
  const pending = scoped.filter(p => p.status === "PENDING");
  const history = scoped.filter(p => p.status !== "PENDING");
  const list = tab === "PENDING" ? pending : history;

  async function decide(p: Proposal, decision: string) {
    const comment = comments[p.id]?.trim();
    if (decision !== "APPROVED" && !comment) { window.alert("A comment is required to reject or request changes."); return; }
    if (await run(() => api(`/approvals/${p.id}/decision`, { method: "POST", body: { decision, comment } }), MSG[decision])) reload();
  }

  return (
    <>
      <PageHeader title="Approval Inbox" subtitle="Agents cannot perform these actions until you decide"
        action={<Tabs value={tab} onChange={setTab} tabs={[{ id: "PENDING", label: "Pending", count: pending.length }, { id: "HISTORY", label: "History (Decided)", count: history.length }]} />} />
      <ErrorBox message={error} />
      {loading && !data && <CardSkeletons n={2} h="h-56" />}
      {data && list.length === 0 && <div className="card p-8 text-center text-slate-500">{tab === "PENDING" ? "Inbox zero — nothing awaiting approval." : "No decided proposals yet."}</div>}
      <div className="space-y-5">
        {list.map(p => {
          const open = expanded[p.id];
          const d = p.approvals?.[0];
          return (
            <article key={p.id} className="card p-5">
              <header className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="font-semibold text-white">{label(p.actionType)}</h2>
                <Badge value={p.riskLevel} text={`${label(p.riskLevel)} risk`} dot={false} />
                {p.status !== "PENDING" && <Badge value={p.status} dot={false} />}
                <span className="ml-auto text-xs text-slate-500">{p.requestingAgent.name} · {p.project?.name} · {p.status === "PENDING" ? `expires ${fmtDate(p.expiresAt)}` : `requested ${fmtDate(p.createdAt)}`}</span>
              </header>
              <p className="mb-3 font-mono text-xs text-slate-400">Target: {p.targetResource}</p>
              <div className="grid gap-3 md:grid-cols-2">
                <Block title="Scope" text={p.scopeSummary} />
                <Block title="Rationale" text={p.rationale} />
              </div>
              <button className="mt-3 flex items-center gap-1.5 text-xs text-brand-soft hover:underline" onClick={() => setExpanded({ ...expanded, [p.id]: !open })}>
                <ChevronDown size={14} className={`transition ${open ? "rotate-180" : ""}`} /> {open ? "Hide" : "Show"} rollback & validation plans
              </button>
              {open && <div className="mt-3 grid gap-3 md:grid-cols-2"><Block title="Rollback plan" text={p.rollbackPlan} /><Block title="Validation plan" text={p.validationPlan} /></div>}

              {p.status === "PENDING" && isCeo && (
                <div className="mt-5 border-t border-white/5 pt-4">
                  <input className="input mb-3" placeholder="CEO comment — optional for Approve, required for Reject / Request changes" value={comments[p.id] ?? ""} onChange={e => setComments({ ...comments, [p.id]: e.target.value })} />
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary" onClick={() => decide(p, "APPROVED")}><Check size={15} /> Approve</button>
                    <button className="btn-ghost" onClick={() => decide(p, "CHANGES_REQUESTED")}><MessageSquareWarning size={15} /> Request Changes</button>
                    <button className="btn-danger" onClick={() => decide(p, "REJECTED")}><X size={15} /> Reject</button>
                  </div>
                </div>
              )}
              {p.status === "PENDING" && !isCeo && <p className="mt-4 text-xs text-slate-500">Only the CEO can decide proposals.</p>}
              {d && <p className="mt-4 text-xs text-slate-400">{label(d.decision)} by {d.approver.name} on {fmtDate(d.decidedAt)}{d.comment && ` — “${d.comment}”`}</p>}
              {p.status === "EXPIRED" && <p className="mt-4 text-xs text-slate-500">This proposal expired before a decision was made.</p>}
            </article>
          );
        })}
      </div>
    </>
  );
}

const Block = ({ title, text }: { title: string; text: string }) => (
  <div className="rounded-lg bg-ink-900 p-3"><div className="label">{title}</div><p className="text-sm text-slate-300">{text}</p></div>
);
