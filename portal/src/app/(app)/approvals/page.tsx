"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CheckCircle2, Inbox } from "lucide-react";
import { Proposal, timeAgo } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { ProposalReview } from "@/components/ProposalReview";
import { AgentAvatar, Badge, EmptyState, ErrorBox, ExpiryBadge, Mono, PageHeader, QaBadge, RISK_TONE, Skeleton, Tabs } from "@/components/ui";

function Inner() {
  const params = useSearchParams();
  const [tab, setTab] = useState<"PENDING" | "HISTORY">("PENDING");
  const { data, error, loading, reload } = useApi<Proposal[]>("/approvals", 6000);
  const [selected, setSelected] = useState<number | null>(params.get("open") ? Number(params.get("open")) : null);
  const { projectId } = useSession();
  const all = (data ?? []).filter(p => !projectId || p.projectId === projectId);
  const pending = all.filter(p => p.status === "PENDING");
  const history = all.filter(p => p.status !== "PENDING");
  const list = tab === "PENDING" ? pending : history;
  const current = all.find(p => p.id === selected) ?? null;

  useEffect(() => { // auto-select the first item on desktop
    if (!selected && list.length && typeof window !== "undefined" && window.innerWidth >= 1024) setSelected(list[0].id);
  }, [list, selected]);

  return (
    <div>
      <PageHeader title="Approval Inbox" subtitle="Agents never touch main on their own. Each proposal passed through the automated QA gate — check its badge, then Approve & Merge, send it back with feedback, or reject it." />
      <ErrorBox message={error} />
      <div className="mb-4"><Tabs value={tab} onChange={v => { setTab(v); setSelected(null); }} tabs={[{ id: "PENDING", label: "Needs decision", count: pending.length }, { id: "HISTORY", label: "Decided", count: history.length }]} /></div>
      {loading && !data ? <div className="grid gap-4 lg:grid-cols-[22rem_1fr]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div> : !list.length ? (
        <EmptyState icon={tab === "PENDING" ? CheckCircle2 : Inbox} title={tab === "PENDING" ? "Inbox zero" : "No decisions yet"}
          text={tab === "PENDING" ? "Nothing needs your decision right now. New proposals appear here (and in Discord) as soon as an agent finishes a task." : "Approved, rejected and expired proposals will be listed here."}
          action={tab === "PENDING" && <Link href="/" className="btn-primary">Start new work</Link>} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <ul className={`space-y-2 ${current ? "hidden lg:block" : ""}`}>
            {list.map(p => (
              <li key={p.id}>
                <button onClick={() => setSelected(p.id)} className={`w-full rounded-2xl border p-3 text-left transition ${selected === p.id ? "border-brand/50 bg-brand/[0.08]" : "border-white/[0.06] bg-ink-800/70 hover:border-white/15"}`}>
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar slug={p.requestingAgent.slug} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-100">{p.task?.title ?? p.actionType}</div>
                      <div className="truncate text-xs text-slate-500">{p.requestingAgent.name} · {p.project?.name}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={`rounded-full border px-2 py-0.5 ${RISK_TONE[p.riskLevel] ?? ""}`}>{p.riskLevel}</span>
                    <QaBadge qa={p.qaReport} compact />
                    <ExpiryBadge expiresAt={p.expiresAt} status={p.status} />
                    {p.branchName && <Mono>{p.branchName}</Mono>}
                    {!!p.changedFiles?.length && <span className="text-slate-500">{p.changedFiles.length} files</span>}
                    <span className="ml-auto text-slate-500">{tab === "HISTORY" ? <Badge value={p.mergeStatus === "MERGED" ? "DONE" : p.status} text={p.mergeStatus === "MERGED" ? "Merged" : undefined} /> : timeAgo(p.createdAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className={current ? "" : "hidden lg:block"}>
            {current ? <ProposalReview key={current.id} p={current} onDecided={reload} onBack={() => setSelected(null)} /> : <div className="card grid h-64 place-items-center text-sm text-slate-500">Select a proposal to review it</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><Inner /></Suspense>;
}
