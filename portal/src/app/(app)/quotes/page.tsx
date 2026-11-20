"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Calculator, CalendarClock, CheckCircle2, Copy, FileText, Loader2, Rocket, ShieldAlert, Sparkles } from "lucide-react";
import { api, runJob, timeAgo } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { AgentAvatar, EmptyState, ErrorBox, Field, HelpText, PageHeader, Skeleton } from "@/components/ui";

interface Milestone { name: string; description: string; deliverables: string[]; hours: number; weeks: number; agents: string[] }
interface QuoteResult {
  title: string; summary: string; scope: { inScope: string[]; outOfScope: string[] }; techStack: string; category: string;
  milestones: Milestone[]; timelineWeeks: number; totalHours: number;
  cost: { currency: string; hourlyRate: number; subtotal: number; contingencyPercent: number; contingency: number; total: number; low: number; high: number };
  risks: string[]; assumptions: string[]; projectName: string; autoBuildGoal: string;
}
interface Quote { id: number; clientName: string; title: string; requirements: string; hourlyRate: number; currency: string; result: QuoteResult; projectId: number | null; createdAt: string }

const money = (n: number, c: string) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: c, maximumFractionDigits: 0 }).format(n); } catch { return `${c} ${Math.round(n).toLocaleString()}`; } };

function QuoteView({ q, onConverted }: { q: Quote; onConverted: () => void }) {
  const router = useRouter();
  const { canWrite } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const r = q.result, c = r.cost;

  async function convert() {
    if (!window.confirm(`Create project "${r.projectName}" and launch the agent pipeline for this scope?`)) return;
    setBusy(true);
    try {
      const { projectId, jobId } = await api<{ projectId: number; jobId: string }>(`/quotes/${q.id}/convert`, { method: "POST" });
      setProgress("Planning tasks…");
      for (let i = 0; i < 200; i++) {
        await new Promise(res => setTimeout(res, 1500));
        const j = await api<{ status: string; progress: string | null; error: string | null }>(`/jobs/${jobId}`);
        if (j.progress) setProgress(j.progress);
        if (j.status === "failed") throw new Error(j.error ?? "Planning failed");
        if (j.status === "succeeded") break;
      }
      toast("success", "Project created and tasks launched");
      onConverted();
      router.push(`/projects/${projectId}`);
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); setProgress(null); }
  }
  const asText = () => [`${r.title} — quote for ${q.clientName}`, "", r.summary, "", "Scope:", ...r.scope.inScope.map(s => `• ${s}`), "", "Out of scope:", ...r.scope.outOfScope.map(s => `• ${s}`), "",
    "Milestones:", ...r.milestones.map((m, i) => `${i + 1}. ${m.name} — ${m.weeks} wk, ${m.hours} h\n   ${m.deliverables.join("; ")}`), "",
    `Timeline: ~${r.timelineWeeks} weeks`, `Estimate: ${money(c.total, c.currency)} (${r.totalHours} h × ${money(c.hourlyRate, c.currency)}/h + ${c.contingencyPercent}% contingency)`, "",
    "Assumptions:", ...r.assumptions.map(s => `• ${s}`), "", "Risks:", ...r.risks.map(s => `• ${s}`)].join("\n");

  return (
    <div className="card fade-up space-y-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400">Quote #{q.id} · {q.clientName} · {timeAgo(q.createdAt)}</div>
          <h2 className="mt-1 text-xl font-semibold text-white">{r.title}</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-300">{r.summary}</p>
          <p className="mt-2 text-xs text-slate-500">Suggested stack: {r.techStack || "—"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(asText()).then(() => toast("success", "Quote copied as text"))}><Copy size={14} /> Copy</button>
          {q.projectId ? <Link className="btn-success" href={`/projects/${q.projectId}`}>Open project <ArrowRight size={14} /></Link>
            : canWrite && <button className="btn-primary" disabled={busy} onClick={convert}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />} Convert to Project &amp; Launch Tasks</button>}
        </div>
      </div>
      {progress && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> {progress}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-brand/30 bg-brand/[0.07] p-4"><div className="text-xs uppercase tracking-wide text-slate-400">Estimated total</div><div className="mt-1 text-2xl font-semibold text-white">{money(c.total, c.currency)}</div><div className="text-xs text-slate-500">range {money(c.low, c.currency)} – {money(c.high, c.currency)}</div></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><div className="text-xs uppercase tracking-wide text-slate-400">Timeline</div><div className="mt-1 text-2xl font-semibold text-white">~{r.timelineWeeks} weeks</div><div className="text-xs text-slate-500">{r.milestones.length} milestones</div></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4"><div className="text-xs uppercase tracking-wide text-slate-400">Effort</div><div className="mt-1 text-2xl font-semibold text-white">{r.totalHours} h</div><div className="text-xs text-slate-500">at {money(c.hourlyRate, c.currency)}/h + {c.contingencyPercent}% contingency</div></div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div><h3 className="section-title mb-2">In scope</h3><ul className="space-y-1 text-sm text-slate-300">{r.scope.inScope.map(s => <li key={s} className="flex gap-2"><CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-400" />{s}</li>)}</ul></div>
        <div><h3 className="section-title mb-2">Out of scope</h3><ul className="space-y-1 text-sm text-slate-400">{r.scope.outOfScope.map(s => <li key={s}>— {s}</li>)}</ul></div>
      </div>

      <div>
        <h3 className="section-title mb-3">Milestone plan</h3>
        <ol className="space-y-3">
          {r.milestones.map((m, i) => (
            <li key={i} className="rounded-xl border border-white/[0.06] bg-ink-900/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-brand/20 text-xs text-brand-soft">{i + 1}</span>
                <span className="font-medium text-white">{m.name}</span>
                <span className="ml-auto text-xs text-slate-400">{m.weeks} wk · {m.hours} h · {money(m.hours * c.hourlyRate, c.currency)}</span>
              </div>
              <p className="mt-1.5 text-sm text-slate-400">{m.description}</p>
              {!!m.deliverables.length && <ul className="mt-2 flex flex-wrap gap-1.5">{m.deliverables.map(d => <li key={d} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-slate-300">{d}</li>)}</ul>}
              {!!m.agents.length && <div className="mt-2 flex gap-1">{m.agents.map(a => <AgentAvatar key={a} slug={a} size={20} />)}</div>}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div><h3 className="section-title mb-2">Assumptions</h3><ul className="space-y-1 text-sm text-slate-400">{r.assumptions.map(s => <li key={s}>• {s}</li>)}</ul></div>
        <div><h3 className="section-title mb-2 flex items-center gap-1.5"><ShieldAlert size={13} /> Risks</h3><ul className="space-y-1 text-sm text-slate-400">{r.risks.map(s => <li key={s}>• {s}</li>)}</ul></div>
      </div>
      <HelpText>Estimates are AI-generated from the requirements and are a starting point for your own judgement. Cost = hours × your rate + contingency, computed by the portal.</HelpText>
    </div>
  );
}

export default function QuotesPage() {
  const { canWrite } = useSession();
  const { toast } = useToast();
  const list = useApi<Quote[]>("/quotes");
  const [f, setF] = useState({ clientName: "", requirements: "", hourlyRate: 50, currency: "USD", deadline: "", budgetHint: "" });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const current = list.data?.find(q => q.id === selected) ?? list.data?.[0] ?? null;

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const q = await runJob<Quote>("/quotes", { ...f, deadline: f.deadline || undefined, budgetHint: f.budgetHint || undefined }, setProgress, 400_000);
      await list.reload();
      setSelected(q.id);
      toast("success", "Quote ready");
    } catch (err) { toast("error", (err as Error).message); } finally { setBusy(false); setProgress(null); }
  }

  return (
    <div>
      <PageHeader title="Client Quotes & Scope Builder" subtitle="Paste what the client wants. Your Executive Assistant and Software Architect turn it into a scope, milestone plan, timeline and cost estimate — then one click turns it into a project with tasks." />
      <div className="grid gap-6 xl:grid-cols-[24rem_1fr]">
        <div className="space-y-6">
          {canWrite && (
            <form onSubmit={generate} className="card space-y-4 p-5">
              <h2 className="flex items-center gap-2 font-semibold text-white"><Sparkles size={16} className="text-brand" /> New quote</h2>
              <Field label="Client name"><input className="input" required minLength={2} maxLength={120} value={f.clientName} onChange={e => setF({ ...f, clientName: e.target.value })} placeholder="e.g. Brewly Coffee Co." /></Field>
              <Field label="Client requirements" hint="Paste the brief or email. More detail → better estimate.">
                <textarea className="input min-h-[180px]" required minLength={20} maxLength={8000} value={f.requirements} onChange={e => setF({ ...f, requirements: e.target.value })} placeholder="What should it do, who uses it, integrations, platforms…" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Hourly rate"><input type="number" min={1} max={10000} className="input" value={f.hourlyRate} onChange={e => setF({ ...f, hourlyRate: Number(e.target.value) })} /></Field>
                <Field label="Currency"><select className="input" value={f.currency} onChange={e => setF({ ...f, currency: e.target.value })}>{["USD", "EUR", "GBP", "PKR", "AED", "INR", "CAD", "AUD"].map(c => <option key={c}>{c}</option>)}</select></Field>
              </div>
              <Field label="Deadline (optional)"><input className="input" maxLength={100} value={f.deadline} onChange={e => setF({ ...f, deadline: e.target.value })} placeholder="e.g. end of March" /></Field>
              <Field label="Budget hint (optional)"><input className="input" maxLength={200} value={f.budgetHint} onChange={e => setF({ ...f, budgetHint: e.target.value })} placeholder="e.g. around $5k" /></Field>
              <button className="btn-primary w-full" disabled={busy || f.clientName.trim().length < 2 || f.requirements.trim().length < 20}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Calculator size={15} />} {busy ? "Generating…" : "Generate scope & estimate"}</button>
              {progress && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> {progress} (usually 1–3 minutes)</p>}
            </form>
          )}
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-semibold text-white">Previous quotes</h3>
            <ErrorBox message={list.error} />
            {list.loading && !list.data ? <Skeleton className="h-24" /> : !list.data?.length ? <p className="text-sm text-slate-500">No quotes yet.</p> : (
              <ul className="space-y-1">
                {list.data.map(q => (
                  <li key={q.id}><button onClick={() => setSelected(q.id)} className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${current?.id === q.id ? "bg-brand/15 text-white" : "text-slate-300 hover:bg-white/5"}`}>
                    <div className="truncate">{q.title}</div>
                    <div className="flex justify-between text-xs text-slate-500"><span>{q.clientName}</span><span>{money(q.result.cost.total, q.currency)}{q.projectId ? " · project" : ""}</span></div>
                  </button></li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div>
          {busy && !current ? <Skeleton className="h-96" /> : current ? <QuoteView key={current.id} q={current} onConverted={list.reload} /> : (
            <EmptyState icon={FileText} title="No quote selected" text="Fill in the client's requirements on the left to generate your first scope, milestone plan and estimate." />
          )}
          {busy && current && <p className="mt-3 flex items-center gap-2 text-xs text-slate-400"><CalendarClock size={12} /> Generating a new quote…</p>}
        </div>
      </div>
    </div>
  );
}
