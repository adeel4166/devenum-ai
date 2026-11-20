"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Bot, Check, FolderKanban, Moon, ShieldAlert, X } from "lucide-react";
import { Agent, api, AuditEvent, label, timeAgo } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, ErrorBox, PageHeader, Progress, Skeleton } from "@/components/ui";

interface Dash {
  kpis: { activeProjects: number; runningAgents: number; idleAgents: number; pendingApprovals: number };
  projects: { id: number; name: string; status: string; progressPercent: number; category: string }[];
  activity: AuditEvent[];
  proposals: { id: number; actionType: string; scopeSummary: string; riskLevel: string; requestingAgent: { name: string }; project: { name: string } }[];
}
const DEPTS = ["LEADERSHIP", "ARCHITECTURE", "DESIGN", "ENGINEERING", "QA_SECURITY", "DEVOPS"];
const ACTOR_TONE: Record<string, string> = { AGENT: "bg-sky-400", CEO: "bg-emerald-400", SYSTEM: "bg-slate-400" };

export default function Overview() {
  const { data, error, loading, reload } = useApi<Dash>("/system/dashboard", 6000);
  const agents = useApi<Agent[]>("/agents", 6000);
  const { isCeo, projectId } = useSession();
  const { run } = useToast();
  const [notes, setNotes] = useState<Record<number, string>>({});

  async function decide(id: number, decision: "APPROVED" | "REJECTED") {
    const comment = notes[id]?.trim();
    if (decision === "REJECTED" && !comment) { window.alert("Add a short reason in the comment box before rejecting."); return; }
    const ok = await run(() => api(`/approvals/${id}/decision`, { method: "POST", body: { decision, comment } }), decision === "APPROVED" ? "Proposal approved" : "Proposal rejected");
    if (ok) { reload(); agents.reload(); }
  }

  const k = data?.kpis;
  const cards = [
    { l: "Active Projects", v: k?.activeProjects, i: FolderKanban, c: "text-indigo-300", href: "/projects" },
    { l: "Running Agents", v: k?.runningAgents, i: Bot, c: "text-sky-300", href: "/agents?status=RUNNING" },
    { l: "Idle Agents", v: k?.idleAgents, i: Moon, c: "text-emerald-300", href: "/agents?status=AVAILABLE" },
    { l: "Pending Approvals", v: k?.pendingApprovals, i: ShieldAlert, c: "text-amber-300", href: "/approvals" },
  ];
  const projects = (data?.projects ?? []).filter(p => !projectId || p.id === projectId);
  const total = agents.data?.length ?? 0;

  return (
    <>
      <PageHeader title="Executive Overview" subtitle="Live status of your autonomous software house" />
      <ErrorBox message={error} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading && !data ? [0, 1, 2, 3].map(i => <Skeleton key={i} className="h-28" />) : cards.map(c => (
          <Link key={c.l} href={c.href} className="card card-hover group p-5">
            <div className="flex items-center justify-between text-sm text-slate-400">{c.l}<c.i size={18} className={c.c} /></div>
            <div className="mt-3 flex items-end justify-between"><span className="text-3xl font-semibold text-white">{c.v ?? "–"}</span><ArrowRight size={16} className="text-slate-600 transition group-hover:translate-x-1 group-hover:text-brand-soft" /></div>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 font-semibold text-white">Active Projects</h2>
          {projects.length === 0 && <p className="text-sm text-slate-500">No projects yet.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map(p => (
              <Link key={p.id} href={`/projects/${p.id}`} className="card-hover rounded-lg border border-white/5 bg-ink-900 p-4">
                <div className="mb-1 flex items-start justify-between gap-2"><span className="font-medium text-white">{p.name}</span><Badge value={p.status} /></div>
                <div className="mb-3 text-xs text-slate-500">{label(p.category)}</div>
                <div className="mb-1 flex justify-between text-xs text-slate-400"><span>Delivery</span><span>{p.progressPercent}%</span></div>
                <Progress value={p.progressPercent} />
              </Link>
            ))}
          </div>
        </section>

        <section className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-white">Pending Approvals</h2>
            <Link href="/approvals" className="text-xs text-brand-soft hover:underline">Open inbox</Link>
          </div>
          {data?.proposals.length === 0 && <p className="text-sm text-slate-500">Nothing awaiting your decision.</p>}
          <div className="space-y-3">
            {data?.proposals.map(p => (
              <div key={p.id} className="rounded-lg border border-white/5 bg-ink-900 p-3">
                <div className="mb-1 flex items-center justify-between"><span className="text-sm font-medium text-white">{label(p.actionType)}</span><Badge value={p.riskLevel} text={`${label(p.riskLevel)} risk`} dot={false} /></div>
                <p className="mb-1 text-xs text-slate-400">{p.requestingAgent.name} · {p.project.name}</p>
                <p className="mb-2 line-clamp-2 text-xs text-slate-300">{p.scopeSummary}</p>
                {isCeo ? (
                  <>
                    <input className="input mb-2 !py-1 text-xs" placeholder="Comment (required to reject)" value={notes[p.id] ?? ""} onChange={e => setNotes({ ...notes, [p.id]: e.target.value })} />
                    <div className="flex gap-2">
                      <button className="btn-primary flex-1 !py-1" onClick={() => decide(p.id, "APPROVED")}><Check size={14} /> Approve</button>
                      <button className="btn-ghost flex-1 !py-1" onClick={() => decide(p.id, "REJECTED")}><X size={14} /> Reject</button>
                    </div>
                  </>
                ) : <Link href="/approvals" className="text-xs text-brand-soft">Review</Link>}
              </div>
            ))}
          </div>
        </section>

        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 font-semibold text-white">Department & Agent Utilization</h2>
          {!agents.data ? <Skeleton className="h-40" /> : (
            <div className="space-y-4">
              {DEPTS.map(d => {
                const list = agents.data!.filter(a => a.department === d);
                if (!list.length) return null;
                const busy = list.filter(a => ["RUNNING", "WAITING_APPROVAL"].includes(a.status)).length;
                const pct = Math.round((busy / list.length) * 100);
                return (
                  <div key={d}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <Link href={`/agents?department=${d}`} className="text-slate-200 hover:text-white">{label(d)}</Link>
                      <span className="text-xs text-slate-400">{busy}/{list.length} active · {pct}%</span>
                    </div>
                    <Progress value={pct} />
                    <div className="mt-2 flex flex-wrap gap-1.5">{list.map(a => <span key={a.id} className="flex items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-300">{a.name}<Badge value={a.status} text="" /></span>)}</div>
                  </div>
                );
              })}
              <p className="text-xs text-slate-500">{total} agents total · utilization counts Running and Waiting-approval agents.</p>
            </div>
          )}
        </section>

        <section className="card p-5">
          <h2 className="mb-4 font-semibold text-white">Audit & Activity</h2>
          <ol className="relative space-y-4 border-l border-white/10 pl-5">
            {data?.activity.map(a => (
              <li key={a.id} className="relative">
                <span className={`absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-ink-800 ${ACTOR_TONE[a.actorType] ?? "bg-slate-400"}`} />
                <div className="text-sm text-slate-200">{label(a.action.toLowerCase())}</div>
                <div className="text-xs text-slate-500">{a.actorType}{a.target && ` · ${a.target}`} · {timeAgo(a.createdAt)}</div>
              </li>
            ))}
            {loading && !data && <Skeleton className="h-32" />}
          </ol>
        </section>
      </div>
    </>
  );
}
