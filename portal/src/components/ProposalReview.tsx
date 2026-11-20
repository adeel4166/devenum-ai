"use client";
import { useState } from "react";
import {
  ArrowLeft, CheckCircle2, ClipboardCheck, FileCode2, GitBranch, GitMerge, Inbox, Loader2, MessageSquareDiff, RotateCcw, ShieldAlert, ShieldCheck, XCircle,
} from "lucide-react";
import { api, fmtDate, Proposal, timeAgo } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { RejectModal, RequestChangesModal } from "./DecisionModals";
import { AgentAvatar, Badge, ExpiryBadge, HashBadge, Mono, QaBadge, RISK_TONE } from "./ui";

/** Splits the worker's scopeSummary into the agent's summary and the `git diff --stat` block. */
function parseScope(p: Proposal) {
  const [summary, rest = ""] = p.scopeSummary.split(/\n\nChanged files \(/);
  const stat = rest.split("\n").filter(l => /\|\s+\d+|\d+ files? changed/.test(l)).join("\n");
  return { summary: summary.trim(), stat };
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof GitBranch; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400"><Icon size={13} /> {title}</h3>
      {children}
    </section>
  );
}

const CHECK_TONE: Record<string, string> = { passed: "text-emerald-300", failed: "text-rose-300", warning: "text-amber-300", skipped: "text-slate-500" };

function QaPanel({ p }: { p: Proposal }) {
  const qa = p.qaReport;
  if (!qa) return <p className="text-sm text-slate-500">No automated QA report for this proposal (created before the QA gate existed, or not produced by the worker).</p>;
  const ok = qa.status === "PASSED";
  return (
    <div className={`rounded-xl border p-4 ${ok ? "border-emerald-500/25 bg-emerald-500/[0.05]" : "border-amber-500/30 bg-amber-500/[0.06]"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className={`grid h-12 w-12 place-items-center rounded-xl text-lg font-semibold tabular-nums ${ok ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>{qa.score}</div>
        <div>
          <div className="font-medium text-white">{ok ? "QA Passed" : "QA Warning — review the findings before approving"}</div>
          <div className="text-xs text-slate-400">Automated checks on the task branch · {timeAgo(qa.ranAt)}</div>
        </div>
      </div>
      {!!qa.checks.length && (
        <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2">
          {qa.checks.map(c => <li key={c.name} className="flex gap-2"><span className={`w-14 shrink-0 font-medium uppercase ${CHECK_TONE[c.status] ?? ""}`}>{c.status}</span><span className="text-slate-300">{c.name}</span><span className="truncate text-slate-500">— {c.detail}</span></li>)}
        </ul>
      )}
      {!!qa.findings.length && (
        <ul className="mt-3 space-y-1.5">
          {qa.findings.map((f, i) => (
            <li key={i} className="rounded-lg bg-black/25 px-3 py-2 text-xs">
              <span className={`mr-2 font-semibold ${f.severity === "HIGH" ? "text-rose-300" : f.severity === "MEDIUM" ? "text-amber-300" : "text-slate-400"}`}>{f.severity}</span>
              <span className="text-slate-400">{f.check}</span>{f.file && <span className="ml-2 font-mono text-amber-200/80">{f.file}</span>}
              <pre className="mt-1 whitespace-pre-wrap font-sans text-slate-200">{f.message}</pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ProposalReview({ p, onDecided, onBack }: { p: Proposal; onDecided: () => void; onBack?: () => void }) {
  const { isCeo } = useSession();
  const { run } = useToast();
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"changes" | "reject" | null>(null);
  const { summary, stat } = parseScope(p);
  const files = p.changedFiles ?? [];
  const RiskIcon = p.riskLevel === "LOW" ? ShieldCheck : ShieldAlert;
  const pending = p.status === "PENDING";

  async function approve() {
    if (p.qaReport?.status === "WARNINGS" && !window.confirm(`The automated QA gate reported warnings (score ${p.qaReport.score}/100). Approve and merge anyway?`)) return;
    setBusy(true);
    const ok = await run(() => api(`/approvals/${p.id}/decision`, { method: "POST", body: { decision: "APPROVED" } }),
      p.branchName ? `Approved — ${p.branchName} will be merged into main within seconds` : "Proposal approved");
    setBusy(false);
    if (ok) onDecided();
  }

  return (
    <div className="card fade-up p-5 sm:p-6">
      {onBack && <button className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white lg:hidden" onClick={onBack}><ArrowLeft size={14} /> Back to list</button>}
      <div className="flex flex-wrap items-start gap-3">
        <AgentAvatar slug={p.requestingAgent.slug} size={44} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">{p.requestingAgent.name}{p.requestingAgent.roleTitle ? ` · ${p.requestingAgent.roleTitle}` : ""}{p.project ? ` · ${p.project.name}` : ""}</div>
          <h2 className="mt-0.5 text-xl font-semibold text-white">{p.task?.title ?? p.actionType.replace(/_/g, " ").toLowerCase()}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Mono>proposal #{p.id}</Mono>{p.task && <Mono>task #{p.task.id}</Mono>}
            {p.branchName && <Mono><GitBranch size={11} />{p.branchName} → main</Mono>}
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${RISK_TONE[p.riskLevel] ?? ""}`}><RiskIcon size={12} /> {p.riskLevel} risk</span>
            <QaBadge qa={p.qaReport} />
            <ExpiryBadge expiresAt={p.expiresAt} status={p.status} />
            <HashBadge hash={p.payloadHash} head={p.headCommit} status={p.status} />
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
          {isCeo && <span className="self-center text-xs text-slate-500">Nothing reaches main until you click Approve &amp; Merge.</span>}
        </div>
      )}
      {p.mergeStatus === "MERGED" && <p className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"><CheckCircle2 size={15} /> Merged into main{p.mergeCommit ? <> as <span className="font-mono">{p.mergeCommit.slice(0, 10)}</span></> : null}{p.mergedAt ? ` · ${timeAgo(p.mergedAt)}` : ""}</p>}
      {p.status === "INVALIDATED" && <p className="mt-4 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-200">This approval was blocked: the task branch changed after it was submitted and reviewed, so the payload hash no longer matches. Retry the task to get a fresh, verified proposal.</p>}
      {p.mergeStatus === "FAILED" && <pre className="mt-4 whitespace-pre-wrap rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-200">Merge failed: {p.mergeError}</pre>}
      {p.status === "APPROVED" && !p.mergeStatus && p.branchName && <p className="mt-4 flex items-center gap-2 text-sm text-sky-300"><Loader2 size={14} className="animate-spin" /> Merging {p.branchName} into main…</p>}

      <div className="mt-6 space-y-6">
        <Section title="Automated QA & security gate" icon={ClipboardCheck}><QaPanel p={p} /></Section>
        <Section title="What the agent did" icon={FileCode2}>
          <div className="whitespace-pre-wrap rounded-xl border border-white/5 bg-ink-900 p-4 text-sm leading-relaxed text-slate-200">{summary || "No summary provided."}</div>
        </Section>
        <Section title={`Files changed (${files.length})`} icon={GitBranch}>
          {files.length ? (
            <div className="overflow-hidden rounded-xl border border-white/5">
              <ul className="max-h-56 divide-y divide-white/5 overflow-y-auto bg-ink-900 font-mono text-xs">{files.map(f => <li key={f} className="px-3 py-1.5 text-slate-300">{f}</li>)}</ul>
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
