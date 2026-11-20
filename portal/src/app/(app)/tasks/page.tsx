"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Agent, api, label, Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { TaskDrawer } from "@/components/TaskDrawer";
import { Badge, CardSkeletons, ErrorBox, Field, Modal, PageHeader } from "@/components/ui";

const COLUMNS = ["BACKLOG", "READY", "AWAITING_APPROVAL", "IN_PROGRESS", "BLOCKED", "DONE"];
// Order used by the ← / → buttons (approval status is entered via agent runs, not by hand).
const SEQ = ["BACKLOG", "READY", "IN_PROGRESS", "BLOCKED", "DONE"];
const MOVE_TO = ["BACKLOG", "READY", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"];

export default function TasksPage() {
  const { projectId, projects, canWrite } = useSession();
  const { data, setData, error, loading, reload } = useApi<Task[]>(`/tasks${projectId ? `?projectId=${projectId}` : ""}`, 8000);
  const { run } = useToast();
  const [create, setCreate] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  async function move(t: Task, status: string) {
    const prev = data;
    setData(d => (d ? d.map(x => (x.id === t.id ? { ...x, status } : x)) : d) as Task[]); // optimistic
    const ok = await run(() => api(`/tasks/${t.id}`, { method: "PATCH", body: { status } }), `Moved to ${label(status)}`);
    if (!ok) setData(prev);
    reload();
  }
  const inCol = (c: string) => data?.filter(t => t.status === c || (c === "IN_PROGRESS" && t.status === "IN_REVIEW")) ?? [];
  const step = (t: Task, dir: -1 | 1) => SEQ[SEQ.indexOf(t.status === "IN_REVIEW" ? "IN_PROGRESS" : t.status) + dir];

  return (
    <>
      <PageHeader title="Task Board" subtitle={projectId ? projects.find(p => p.id === projectId)?.name : "All projects — click a card for details"}
        action={canWrite && <button className="btn-primary" onClick={() => setCreate(true)}><Plus size={16} /> New task</button>} />
      <ErrorBox message={error} />
      {loading && !data && <div className="grid gap-4 md:grid-cols-3"><CardSkeletons n={3} h="h-64" /></div>}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {data && COLUMNS.map(c => (
          <div key={c} className="w-72 shrink-0">
            <div className="mb-3 flex items-center justify-between px-1 text-sm font-medium text-slate-300">{label(c)}<span className="rounded-full bg-white/5 px-2 text-xs text-slate-400">{inCol(c).length}</span></div>
            <div className="min-h-[8rem] space-y-3 rounded-xl bg-ink-900/60 p-2">
              {inCol(c).map(t => {
                const left = step(t, -1), right = step(t, 1);
                const locked = t.status === "AWAITING_APPROVAL";
                return (
                  <div key={t.id} className="card card-hover p-3" onClick={() => setOpen(t.id)}>
                    <div className="mb-1 flex items-start justify-between gap-2"><span className="text-sm font-medium text-white">{t.title}</span><Badge value={t.priority} /></div>
                    <div className="mb-2 text-xs text-slate-500">{t.project.name}</div>
                    <div className="mb-2 text-xs text-slate-400">{t.assignedAgent?.name ?? "Unassigned"}{t.status === "IN_REVIEW" && " · In review"}</div>
                    {locked && <div className="text-xs text-amber-300">Waiting for CEO decision in Approvals</div>}
                    {canWrite && !locked && (
                      <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        <button className="btn-ghost !px-1.5 !py-1" disabled={!left} onClick={() => left && move(t, left)} aria-label="Move left"><ChevronLeft size={14} /></button>
                        <select className="input !py-1 text-xs" value={t.status} onChange={e => move(t, e.target.value)} aria-label="Move task">
                          {MOVE_TO.map(s => <option key={s} value={s}>{label(s)}</option>)}
                        </select>
                        <button className="btn-ghost !px-1.5 !py-1" disabled={!right} onClick={() => right && move(t, right)} aria-label="Move right"><ChevronRight size={14} /></button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {create && <CreateTask defaultProject={projectId ?? projects[0]?.id} onClose={() => setCreate(false)} onCreated={() => { setCreate(false); reload(); }} />}
      {open && <TaskDrawer taskId={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function CreateTask({ defaultProject, onClose, onCreated }: { defaultProject?: number; onClose: () => void; onCreated: () => void }) {
  const { projects } = useSession();
  const { run } = useToast();
  const agents = useApi<Agent[]>("/agents");
  const [f, setF] = useState({ projectId: String(defaultProject ?? ""), assignedAgentId: "", title: "", description: "", priority: "MEDIUM", status: "READY" });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => api("/tasks", { method: "POST", body: { ...f, projectId: Number(f.projectId), assignedAgentId: f.assignedAgentId ? Number(f.assignedAgentId) : null } }), "Task created")) onCreated();
  }
  return (
    <Modal title="Create & assign task" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Project"><select required className="input" value={f.projectId} onChange={set("projectId")}><option value="" disabled>Select…</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Title"><input required minLength={2} className="input" value={f.title} onChange={set("title")} /></Field>
        <Field label="Description"><textarea className="input h-20" value={f.description} onChange={set("description")} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assign to"><select className="input" value={f.assignedAgentId} onChange={set("assignedAgentId")}><option value="">Unassigned</option>{agents.data?.filter(a => a.status !== "DISABLED").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          <Field label="Priority"><select className="input" value={f.priority} onChange={set("priority")}>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(p => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
        </div>
        <Field label="Initial status"><select className="input" value={f.status} onChange={set("status")}><option value="BACKLOG">Backlog</option><option value="READY">Ready</option></select></Field>
        <div className="flex justify-end gap-2 pt-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary">Create task</button></div>
      </form>
    </Modal>
  );
}
