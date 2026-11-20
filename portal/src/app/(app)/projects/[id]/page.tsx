"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, GitBranch, Layers, Save, X } from "lucide-react";
import { api, label, ProjectDetail } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { TaskDrawer } from "@/components/TaskDrawer";
import { Badge, ErrorBox, Progress, Skeleton } from "@/components/ui";

const STATUSES = ["PLANNING", "IN_PROGRESS", "REVIEW", "COMPLETED", "FROZEN"];

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useApi<ProjectDetail>(`/projects/${id}`, 8000);
  const { canWrite, isCeo, refreshProjects } = useSession();
  const { run } = useToast();
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [edit, setEdit] = useState({ progressPercent: 0, gitBranch: "" });
  const [loaded, setLoaded] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});

  useEffect(() => {
    if (p && loaded !== p.id) { setLoaded(p.id); setEdit({ progressPercent: p.progressPercent, gitBranch: p.gitBranch }); }
  }, [p, loaded]);

  async function patch(body: object, msg: string) {
    if (await run(() => api(`/projects/${id}`, { method: "PATCH", body }), msg)) { reload(); refreshProjects(); }
  }
  async function decide(pid: number, decision: string) {
    const comment = notes[pid]?.trim();
    if (decision !== "APPROVED" && !comment) { window.alert("Add a comment first."); return; }
    if (await run(() => api(`/approvals/${pid}/decision`, { method: "POST", body: { decision, comment } }), "Decision recorded")) reload();
  }

  if (error && !p) return <ErrorBox message={error} />;
  if (!p) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  const pending = p.proposals.filter(x => x.status === "PENDING");

  return (
    <>
      <Link href="/projects" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white"><ArrowLeft size={15} /> All projects</Link>
      <div className="card mb-6 p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">{p.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-400">
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs">{label(p.category)}</span>
              <span className="flex items-center gap-1.5"><Layers size={14} /> {p.techStack || "—"}</span>
              <span className="flex items-center gap-1.5"><GitBranch size={14} /> {p.gitBranch}</span>
            </div>
          </div>
          {canWrite ? (
            <select className="input !w-auto" value={p.status} onChange={e => patch({ status: e.target.value }, `Status set to ${label(e.target.value)}`)} aria-label="Project status">
              {STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          ) : <Badge value={p.status} />}
        </div>
        <p className="mb-5 max-w-3xl text-sm text-slate-300">{p.description || "No description."}</p>
        <div className="mb-1 flex justify-between text-xs text-slate-400"><span>Delivery progress</span><span>{p.progressPercent}%</span></div>
        <Progress value={p.progressPercent} />
        {canWrite && (
          <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-white/5 pt-4">
            <div><label className="label">Progress %</label><input type="number" min={0} max={100} className="input !w-24" value={edit.progressPercent} onChange={e => setEdit({ ...edit, progressPercent: Number(e.target.value) })} /></div>
            <div><label className="label">Git branch</label><input className="input !w-56" value={edit.gitBranch} onChange={e => setEdit({ ...edit, gitBranch: e.target.value })} /></div>
            <button className="btn-ghost" onClick={() => patch({ progressPercent: Math.min(100, Math.max(0, Math.round(edit.progressPercent))), gitBranch: edit.gitBranch }, "Project updated")}><Save size={14} /> Save</button>
            <span className="ml-auto text-xs text-slate-500">Repo: {p.repoPath || "—"}</span>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 font-semibold text-white">Project tasks <span className="text-sm font-normal text-slate-500">({p.tasks.length})</span></h2>
          {p.tasks.length === 0 && <p className="text-sm text-slate-500">No tasks yet — create one on the Task Board.</p>}
          <div className="divide-y divide-white/5">
            {p.tasks.map(t => (
              <button key={t.id} onClick={() => setOpenTask(t.id)} className="flex w-full flex-wrap items-center gap-3 py-3 text-left hover:bg-white/[0.02]">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{t.title}</span>
                <span className="text-xs text-slate-500">{t.assignedAgent?.name ?? "Unassigned"}</span>
                <Badge value={t.priority} /><Badge value={t.status} />
              </button>
            ))}
          </div>
        </section>

        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="mb-3 font-semibold text-white">Pending proposals</h2>
            {pending.length === 0 && <p className="text-sm text-slate-500">None.</p>}
            <div className="space-y-3">
              {pending.map(x => (
                <div key={x.id} className="rounded-lg border border-white/5 bg-ink-900 p-3">
                  <div className="mb-1 flex items-center justify-between"><span className="text-sm font-medium text-white">{label(x.actionType)}</span><Badge value={x.riskLevel} text={`${label(x.riskLevel)} risk`} dot={false} /></div>
                  <p className="mb-2 text-xs text-slate-400">{x.requestingAgent.name}{x.task && ` · ${x.task.title}`}</p>
                  <p className="mb-2 text-xs text-slate-300">{x.scopeSummary}</p>
                  {isCeo && (
                    <>
                      <input className="input mb-2 !py-1 text-xs" placeholder="Comment" value={notes[x.id] ?? ""} onChange={e => setNotes({ ...notes, [x.id]: e.target.value })} />
                      <div className="flex gap-2">
                        <button className="btn-primary flex-1 !py-1" onClick={() => decide(x.id, "APPROVED")}><Check size={14} /></button>
                        <button className="btn-ghost flex-1 !py-1" onClick={() => decide(x.id, "REJECTED")}><X size={14} /></button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="card p-5">
            <h2 className="mb-3 font-semibold text-white">Assigned agents</h2>
            {p.agents.length === 0 && <p className="text-sm text-slate-500">No agents assigned.</p>}
            <ul className="space-y-2">{p.agents.map(a => <li key={a.id} className="flex items-center justify-between text-sm text-slate-300">{a.name}<Badge value={a.status} /></li>)}</ul>
          </section>
        </div>
      </div>
      {openTask && <TaskDrawer taskId={openTask} onClose={() => setOpenTask(null)} onChanged={reload} />}
    </>
  );
}
