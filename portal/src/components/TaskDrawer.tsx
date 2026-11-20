"use client";
import { useEffect, useState } from "react";
import { Play, Save, Trash2 } from "lucide-react";
import { Agent, api, fmtDate, fmtMs, label, STATUS_ORDER, Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, Drawer, Field, Skeleton, Terminal } from "@/components/ui";

export function TaskDrawer({ taskId, onClose, onChanged }: { taskId: number; onClose: () => void; onChanged: () => void }) {
  const { data: task, reload } = useApi<Task>(`/tasks/${taskId}`);
  const agents = useApi<Agent[]>("/agents");
  const { canWrite } = useSession();
  const { run, toast } = useToast();
  const [f, setF] = useState({ title: "", description: "", priority: "MEDIUM", status: "BACKLOG", assignedAgentId: "", outputSummary: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (task) setF({ title: task.title, description: task.description, priority: task.priority, status: task.status, assignedAgentId: task.assignedAgentId ? String(task.assignedAgentId) : "", outputSummary: task.outputSummary ?? "" });
  }, [task]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setBusy(true);
    const r = await run(() => api(`/tasks/${taskId}`, {
      method: "PATCH",
      body: { title: f.title, description: f.description, priority: f.priority, status: f.status, outputSummary: f.outputSummary || null, assignedAgentId: f.assignedAgentId ? Number(f.assignedAgentId) : null },
    }), "Task updated");
    setBusy(false);
    if (r) { reload(); onChanged(); }
  }
  async function trigger() {
    setBusy(true);
    const r = await run(() => api(`/tasks/${taskId}/simulate-run`, { method: "POST" }), "Agent run finished — proposal sent to the Approval Inbox");
    setBusy(false);
    if (r) { reload(); onChanged(); }
  }
  async function remove() {
    if (!window.confirm("Delete this task permanently?")) return;
    const r = await run(() => api(`/tasks/${taskId}`, { method: "DELETE" }), "Task deleted");
    if (r) { onChanged(); onClose(); }
  }

  const dirty = task && (f.title !== task.title || f.description !== task.description || f.priority !== task.priority || f.status !== task.status
    || f.assignedAgentId !== (task.assignedAgentId ? String(task.assignedAgentId) : "") || f.outputSummary !== (task.outputSummary ?? ""));

  return (
    <Drawer title={task?.title ?? "Task"} onClose={onClose}
      subtitle={task && <span className="flex flex-wrap items-center gap-2">#{task.id} · {task.project.name} <Badge value={task.status} /> <Badge value={task.priority} /></span>}>
      {!task ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-32" /><Skeleton className="h-24" /></div> : (
        <div className="space-y-4">
          {canWrite && task.status === "READY" && (
            <button className="btn-primary w-full" onClick={trigger} disabled={busy || !task.assignedAgentId}>
              <Play size={15} /> Trigger Agent Run
            </button>
          )}
          {task.status === "READY" && !task.assignedAgentId && <p className="text-xs text-amber-300">Assign an agent before triggering a run.</p>}

          <fieldset disabled={!canWrite} className="space-y-3">
            <Field label="Title"><input className="input" value={f.title} onChange={set("title")} /></Field>
            <Field label="Description"><textarea className="input h-28" value={f.description} onChange={set("description")} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Status"><select className="input" value={f.status} onChange={set("status")}>{STATUS_ORDER.map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
              <Field label="Priority"><select className="input" value={f.priority} onChange={set("priority")}>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
              <Field label="Assigned agent">
                <select className="input" value={f.assignedAgentId} onChange={set("assignedAgentId")}>
                  <option value="">Unassigned</option>
                  {agents.data?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Output summary"><textarea className="input h-20" value={f.outputSummary} onChange={set("outputSummary")} placeholder="Result of the work…" /></Field>
          </fieldset>

          {canWrite && (
            <div className="flex gap-2">
              <button className="btn-primary" onClick={save} disabled={busy || !dirty}><Save size={15} /> Save changes</button>
              <button className="btn-ghost ml-auto text-rose-300" onClick={remove}><Trash2 size={15} /> Delete</button>
            </div>
          )}

          <div className="text-xs text-slate-500">Created {fmtDate(task.createdAt)} · Execution time {fmtMs(task.executionTimeMs)}</div>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-white">Execution logs</h3>
            {(task.runs?.length ?? 0) === 0 && <p className="text-sm text-slate-500">No runs yet.</p>}
            <div className="space-y-4">
              {task.runs?.map(r => (
                <div key={r.id}>
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-slate-400">
                    <Badge value={r.status} /> {r.agent?.name} · {fmtDate(r.startedAt)} · {fmtMs(r.executionMs)}
                  </div>
                  <Terminal text={(r.errorMessage ? `ERROR: ${r.errorMessage}\n` : "") + r.logs} />
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {!canWrite && <p className="mt-4 text-xs text-slate-500" onClick={() => toast("info", "Auditors have read-only access")}>Read-only access.</p>}
    </Drawer>
  );
}
