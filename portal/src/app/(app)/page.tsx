"use client";
import Link from "next/link";
import { useState } from "react";
import { Bot, Check, FolderKanban, Moon, ShieldAlert, X } from "lucide-react";
import { api, AuditEvent, fmtDate, label } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { Badge, ErrorBox, PageHeader, Progress } from "@/components/ui";

interface Dash {
  kpis: { activeProjects: number; runningAgents: number; idleAgents: number; pendingApprovals: number };
  projects: { id: number; name: string; status: string; progressPercent: number }[];
  activity: AuditEvent[];
  proposals: { id: number; actionType: string; targetResource: string; scopeSummary: string; riskLevel: string; requestingAgent: { name: string }; project: { name: string } }[];
}

export default function Overview() {
  const { data, error, reload } = useApi<Dash>("/system/dashboard", 8000);
  const { isCeo, projectId } = useSession();
  const [err, setErr] = useState<string | null>(null);

  async function decide(id: number, decision: "APPROVED" | "REJECTED") {
    let comment: string | undefined;
    if (decision === "REJECTED") {
      comment = window.prompt("Reason for rejection (required):")?.trim();
      if (!comment) return;
    }
    try {
      await api(`/approvals/${id}/decision`, { method: "POST", body: { decision, comment } });
      setErr(null);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const k = data?.kpis;
  const cards = [
    { l: "Active Projects", v: k?.activeProjects, i: FolderKanban, c: "text-indigo-300" },
    { l: "Running Agents", v: k?.runningAgents, i: Bot, c: "text-sky-300" },
    { l: "Idle Agents", v: k?.idleAgents, i: Moon, c: "text-emerald-300" },
    { l: "Pending Approvals", v: k?.pendingApprovals, i: ShieldAlert, c: "text-amber-300" },
  ];
  const projects = (data?.projects ?? []).filter(p => !projectId || p.id === projectId);

  return (
    <>
      <PageHeader title="Executive Overview" subtitle="Live status of your autonomous software house" />
      <ErrorBox message={error || err} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(c => (
          <div key={c.l} className="card p-5">
            <div className="flex items-center justify-between text-sm text-slate-400">{c.l}<c.i size={18} className={c.c} /></div>
            <div className="mt-3 text-3xl font-semibold text-white">{c.v ?? "–"}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 font-semibold text-white">Project Delivery Progress</h2>
          {projects.length === 0 && <p className="text-sm text-slate-500">No projects yet.</p>}
          <div className="space-y-5">
            {projects.map(p => (
              <div key={p.id}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="text-slate-200">{p.name} <Badge value={p.status} /></span>
                  <span className="text-slate-400">{p.progressPercent}%</span>
                </div>
                <Progress value={p.progressPercent} />
              </div>
            ))}
          </div>
        </section>

        <section className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-white">Quick Approvals</h2>
            <Link href="/approvals" className="text-xs text-brand-soft hover:underline">Open inbox</Link>
          </div>
          {data?.proposals.length === 0 && <p className="text-sm text-slate-500">Nothing awaiting your decision.</p>}
          <div className="space-y-3">
            {data?.proposals.map(p => (
              <div key={p.id} className="rounded-lg border border-white/5 bg-ink-900 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-white">{label(p.actionType)}</span>
                  <Badge value={p.riskLevel} text={`${label(p.riskLevel)} risk`} />
                </div>
                <p className="mb-1 text-xs text-slate-400">{p.requestingAgent.name} · {p.project.name}</p>
                <p className="mb-3 line-clamp-2 text-xs text-slate-300">{p.scopeSummary}</p>
                {isCeo ? (
                  <div className="flex gap-2">
                    <button className="btn-primary flex-1 !py-1" onClick={() => decide(p.id, "APPROVED")}><Check size={14} /> Approve</button>
                    <button className="btn-ghost flex-1 !py-1" onClick={() => decide(p.id, "REJECTED")}><X size={14} /> Reject</button>
                  </div>
                ) : (
                  <Link href="/approvals" className="text-xs text-brand-soft">Review</Link>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="card p-5 lg:col-span-3">
          <h2 className="mb-4 font-semibold text-white">Live Agent Activity</h2>
          <ul className="divide-y divide-white/5">
            {data?.activity.map(a => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <Badge value={a.actorType === "AGENT" ? "RUNNING" : a.actorType === "CEO" ? "APPROVED" : "QUEUED"} text={a.actorType} />
                <span className="font-medium text-slate-200">{label(a.action.toLowerCase())}</span>
                <span className="text-slate-500">{a.target}</span>
                <span className="ml-auto text-xs text-slate-500">{fmtDate(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
