"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, FileCode2, GitBranch, GitMerge, Inbox, Loader2, MessageSquareDiff, RotateCcw, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { api, fmtDate, Proposal, timeAgo } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { RejectModal, RequestChangesModal } from "@/components/DecisionModals";
import { AgentAvatar, Badge, EmptyState, ErrorBox, Mono, PageHeader, RISK_TONE, Skeleton, Tabs } from "@/components/ui";

/** Splits the worker's scopeSummary into the agent's summary and the `git diff --stat` block. */
function parseScope(p: Proposal) {
  const [summary, rest = ""] = p.scopeSummary.split(/\n\nChanged files \(/);
  const stat = rest.split("\n").filter(l => /\|\s+\d+|\d+ files? changed/.test(l)).join("\n");
  return { summary: summary.trim(), stat };
}

const RISK_ICON = { LOW: ShieldCheck, MEDIUM: ShieldAlert, HIGH: ShieldAlert } as const;

function Section({ title, icon: Icon, children }: { title: string; icon: typeof GitBranch; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400"><Icon size={13} /> {title}</h3>
      {children}
    </section>
  );
}

function Detail({ p, onDecided, onBack }: { p: Proposal; onDecided: () => void; onBack: () => void }) {
  const { isCeo } = useSession();
  const { run } = useToast();
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"changes" | "reject" | null>(null);
  const { summary, stat } = parseScope(p);
  const files = p.changedFiles ?? [];
  const RiskIcon = RISK_ICON[p.riskLevel as keyof typeof RISK_ICON] ?? ShieldAlert;
  const pending = p.status === "PENDING";

  async function approve() {
    setBusy(true);
    const ok = await run(() => api(`/approvals/${p.id}/decision`, { method: "POST", body: { decision: "APPROVED" } }),
      p.branchName ? `Approved — ${p.branchName} will be merged into main within seconds` : "Proposal approved");
    setBusy(false);
    if (ok) onDecided();
  }

  return (
    <div className="card fade-up p-5 sm:p-6">
      <button className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white lg:hidden" onClick={onBack}><ArrowLeft size={14} /> Back to list</button>
      <div className="flex flex-wrap items-start gap-3">
        <AgentAvatar slug={p.requestingAgent.slug} size={44} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">{p.requestingAgent.name}{p.requestingAgent.roleTitle ? ` · ${p.requestingAgent.roleTitle}` : ""} · {p.project?.name}</div>
          <h2 className="mt-0.5 text-xl font-semibold text-white">{p.task?.title ?? p.actionType.replace(/_/g, " ").toLowerCase()}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Mono>proposal #{p.id}</Mono>{p.task && <Mono>task #{p.task.id}</Mono>}
            {p.branchName && <Mono><GitBranch size={11} />{p.branchName} → main</Mono>}
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${RISK_TONE[p.riskLevel] ?? ""}`}><RiskIcon size={12} /> {p.riskLevel} risk</span>
            <Badge value={p.status} />
          </div>
          <div className="mt-1 text-xs text-slate-500">Submitted {timeAgo(p.createdAt)}{pending ? ` · expires ${fmtDate(p.expiresAt)}` : ""}</div>
        </div>
      </div>

      {pending && (
        <div className="mt-5 flex flex-wrap gap-2 rounded-xl border border-white/5 bg-black/20 p-3">
          <button className="btn-success" disabled={!isCeo || busy} onClick={approve}>{busy ? <Loader2 size={15} className="animate-spin" /> : <GitMerge size={15} />} Approve &amp; Merge</button>
          <button className="btn-primary" disabled={!isCeo || busy} onClick={() => setModal("changes")}><MessageSquareDiff size={15} /> Request Changes</button>
          <button className="btn-ghost hover:!border-rose-500/40 hover:!text-rose-300" disabled={!isCeo || busy} onClick={() => setModal("reject")}><XCircle size={15} /> Reject</button>
          {!isCeo && <span className="self-center text-xs text-amber-300">Only the CEO can decide proposals.</span>}
        </div>
      )}
      {p.mergeStatus === "MERGED" && <p className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"><CheckCircle2 size={15} /> Merged into main{p.mergeCommit ? <> as <span className="font-mono">{p.mergeCommit.slice(0, 10)}</span></> : null}{p.mergedAt ? ` · ${timeAgo(p.mergedAt)}` : ""}</p>}
      {p.mergeStatus === "FAILED" && <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-200">Merge failed: {p.mergeError}</pre>}
      {p.status === "APPROVED" && !p.mergeStatus && p.branchName && <p className="mt-4 flex items-center gap-2 text-sm text-sky-300"><Loader2 size={14} className="animate-spin" /> Merging {p.branchName} into main…</p>}

      <div className="mt-6 space-y-6">
        <Section title="What the agent did" icon={FileCode2}>
          <div className="whitespace-pre-wrap rounded-xl border border-white/5 bg-ink-900 p-4 text-sm leading-relaxed text-slate-200">{summary || "No summary provided."}</div>
        </Section>
        <Section title={`Files changed (${files.length})`} icon={GitBranch}>
          {files.length ? (
            <div className="overflow-hidden rounded-xl border border-white/5">
              <ul className="max-h-56 divide-y divide-white/5 overflow-y-auto bg-ink-900 font-mono text-xs">
                {files.map(f => <li key={f} className="px-3 py-1.5 text-slate-300">{f}</li>)}
              </ul>
              {stat && <pre className="overflow-x-auto border-t border-white/5 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-emerald-300/90">{stat}</pre>}
            </div>
          ) : <p className="text-sm text-slate-500">No file changes{p.branchName ? " on this branch" : ""}.</p>}
        </Section>
        <div className="grid gap-6 md:grid-cols-2">
          <Section title="Why / risk assessment" icon={ShieldAlert}><p className="whitespace-pre-wrap text-sm text-slate-300">{p.rationale}</p></Section>
          <Section title="Rollback plan" icon={RotateCcw}><p className="whitespace-pre-wrap text-sm text-slate-300">{p.rollbackPlan}</p></Section>
        </div>
        <Section title="How to verify" icon={CheckCircle2}><p className="whitespace-pre-wrap text-sm text-slate-300">{p.validationPlan}</p></Section>
        {!!p.approvals?.length && (
          <Section title="Decision history" icon={Inbox}>
            <ul className="space-y-2">{p.approvals.map((a, i) => (
              <li key={i} className="rounded-xl bg-white/[0.03] px-3 py-2 text-sm"><Badge value={a.decision} /> <span className="text-slate-400">by {a.approver.name} · {fmtDate(a.decidedAt)}</span>{a.comment && <p className="mt-1 text-slate-300">{a.comment}</p>}</li>
            ))}</ul>
          </Section>
        )}
      </div>
      {modal === "changes" && <RequestChangesModal proposal={p} onClose={() => setModal(null)} onDone={onDecided} />}
      {modal === "reject" && <RejectModal proposal={p} onClose={() => setModal(null)} onDone={onDecided} />}
    </div>
  );
}

function Inner() {
  const params = useSearchParams();
  const [tab, setTab] = useState<"PENDING" | "HISTORY">("PENDING");
  const { data, error, loading, reload } = useApi<Proposal[]>("/approvals", 6000);
  const [selected, setSelected] = useState<number | null>(params.get("open") ? Number(params.get("open")) : null);
  const all = data ?? [];
  const pending = all.filter(p => p.status === "PENDING");
  const history = all.filter(p => p.status !== "PENDING");
  const list = tab === "PENDING" ? pending : history;
  const current = all.find(p => p.id === selected) ?? null;

  useEffect(() => { // auto-select the first item on desktop
    if (!selected && list.length && typeof window !== "undefined" && window.innerWidth >= 1024) setSelected(list[0].id);
  }, [list, selected]);

  return (
    <div>
      <PageHeader title="Approval Inbox" subtitle="Agents never touch main on their own. Review each proposal, then Approve & Merge, send it back with feedback, or reject it." />
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
                    {p.branchName && <Mono>{p.branchName}</Mono>}
                    {!!p.changedFiles?.length && <span className="text-slate-500">{p.changedFiles.length} files</span>}
                    <span className="ml-auto text-slate-500">{tab === "HISTORY" ? <Badge value={p.mergeStatus === "MERGED" ? "DONE" : p.status} text={p.mergeStatus === "MERGED" ? "Merged" : undefined} /> : timeAgo(p.createdAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className={current ? "" : "hidden lg:block"}>
            {current ? <Detail key={current.id} p={current} onDecided={reload} onBack={() => setSelected(null)} /> : <div className="card grid h-64 place-items-center text-sm text-slate-500">Select a proposal to review it</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><Inner /></Suspense>;
}
