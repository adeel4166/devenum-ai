"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Agent, api, label, Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { Badge, ErrorBox, Field, Modal, PageHeader } from "@/components/ui";

const COLUMNS = ["BACKLOG", "READY", "AWAITING_APPROVAL", "IN_PROGRESS", "BLOCKED", "DONE"];
const MOVE_TO = ["BACKLOG", "READY", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "DONE"];

export default function TasksPage() {
  const { projectId, projects, canWrite } = useSession();
  const { data, error, reload } = useApi<Task[]>(`/tasks${projectId ? `?projectId=${projectId}` : ""}`, 8000);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function move(t: Task, status: string) {
    try {
      await api(`/tasks/${t.id}`, { method: "PATCH", body: { status } });
      setErr(null);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  // IN_REVIEW has no dedicated column; it is shown with In Progress.
  const inCol = (c: string) => data?.filter(t => t.status === c || (c === "IN_PROGRESS" && t.status === "IN_REVIEW")) ?? [];

  return (
    <>
      <PageHeader
        title="Task Board"
        subtitle={projectId ? projects.find(p => p.id === projectId)?.name : "All projects"}
        action={canWrite && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New task</button>}
      />
      <ErrorBox message={error || err} />
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map(c => (
          <div key={c} className="w-72 shrink-0">
            <div className="mb-3 flex items-center justify-between px-1 text-sm font-medium text-slate-300">
              {label(c)}<span className="text-xs text-slate-500">{inCol(c).length}</span>
            </div>
            <div className="min-h-[8rem] space-y-3 rounded-xl bg-ink-900/60 p-2">
              {inCol(c).map(t => (
                <div key={t.id} className="card p-3">
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-white">{t.title}</span>
                    <Badge value={t.priority} />
                  </div>
                  <div className="mb-2 text-xs text-slate-500">{t.project.name}</div>
                  <div className="mb-2 text-xs text-slate-400">{t.assignedAgent?.name ?? "Unassigned"}{t.status === "IN_REVIEW" && " · In review"}</div>
                  {canWrite && t.status !== "AWAITING_APPROVAL" && (
                    <select className="input !py-1 text-xs" value={t.status} onChange={e => move(t, e.target.value)} aria-label="Move task">
                      {MOVE_TO.map(s => <option key={s} value={s}>{label(s)}</option>)}
                    </select>
                  )}
                  {t.status === "AWAITING_APPROVAL" && <div className="text-xs text-amber-300">Decide in Approvals inbox</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {open && <CreateTask defaultProject={projectId ?? projects[0]?.id} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); reload(); }} />}
    </>
  );
}

function CreateTask({ defaultProject, onClose, onCreated }: { defaultProject?: number; onClose: () => void; onCreated: () => void }) {
  const { projects } = useSession();
  const agents = useApi<Agent[]>("/agents");
  const [f, setF] = useState({ projectId: String(defaultProject ?? ""), assignedAgentId: "", title: "", description: "", priority: "MEDIUM", status: "READY" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/tasks", { method: "POST", body: { ...f, projectId: Number(f.projectId), assignedAgentId: f.assignedAgentId ? Number(f.assignedAgentId) : null } });
      onCreated();
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  return (
    <Modal title="Create & assign task" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <ErrorBox message={err} />
        <Field label="Project">
          <select required className="input" value={f.projectId} onChange={set("projectId")}>
            <option value="" disabled>Select…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Title"><input required minLength={2} className="input" value={f.title} onChange={set("title")} /></Field>
        <Field label="Description"><textarea className="input h-20" value={f.description} onChange={set("description")} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assign to">
            <select className="input" value={f.assignedAgentId} onChange={set("assignedAgentId")}>
              <option value="">Unassigned</option>
              {agents.data?.filter(a => a.status !== "DISABLED").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select className="input" value={f.priority} onChange={set("priority")}>
              {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(p => <option key={p} value={p}>{label(p)}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Initial status">
          <select className="input" value={f.status} onChange={set("status")}>
            <option value="BACKLOG">Backlog</option>
            <option value="READY">Ready</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary">Create task</button>
        </div>
      </form>
    </Modal>
  );
}
