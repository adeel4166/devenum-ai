"use client";
import { useState } from "react";
import { Send } from "lucide-react";
import { Agent, api, Task } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { AgentAvatar, Field, HelpText, Modal } from "./ui";

/** Creates a READY task for one agent. The worker picks it up automatically within ~5 seconds. */
export function AssignTaskModal({ onClose, onCreated, agentId, projectId, initialTitle = "" }: {
  onClose: () => void; onCreated?: (t: Task) => void; agentId?: number; projectId?: number; initialTitle?: string;
}) {
  const { projects } = useSession();
  const agents = useApi<Agent[]>("/agents");
  const { run } = useToast();
  const [f, setF] = useState({
    projectId: String(projectId ?? projects[0]?.id ?? ""), assignedAgentId: agentId ? String(agentId) : "",
    title: initialTitle, description: "", priority: "MEDIUM",
  });
  const [busy, setBusy] = useState(false);
  const agent = agents.data?.find(a => String(a.id) === f.assignedAgentId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const t = await run(() => api<Task>("/tasks", { method: "POST", body: {
      projectId: Number(f.projectId), assignedAgentId: Number(f.assignedAgentId), title: f.title.trim(),
      description: f.description.trim() || f.title.trim(), priority: f.priority, status: "READY",
    } }), "Task queued — the agent will start as soon as it's free");
    setBusy(false);
    if (t) { onCreated?.(t); onClose(); }
  }

  return (
    <Modal title="Assign a task" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <HelpText>The task goes straight into the <b>READY</b> queue. The agent works on its own git branch and sends you a proposal to approve when done.</HelpText>
        {!projects.length && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">Create a project first — every task belongs to a project workspace.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Project">
            <select className="input" required value={f.projectId} onChange={e => setF({ ...f, projectId: e.target.value })}>
              <option value="" disabled>Select project…</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Agent">
            <select className="input" required value={f.assignedAgentId} onChange={e => setF({ ...f, assignedAgentId: e.target.value })}>
              <option value="" disabled>Select agent…</option>
              {agents.data?.filter(a => a.status !== "DISABLED").map(a => <option key={a.id} value={a.id}>{a.name} — {a.roleTitle}</option>)}
            </select>
          </Field>
        </div>
        {agent && (
          <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-black/20 p-3">
            <AgentAvatar slug={agent.slug} size={34} working={agent.status === "RUNNING"} />
            <div className="min-w-0 text-xs text-slate-400">
              <div className="text-sm text-slate-200">{agent.name}</div>
              <div className="truncate">{String(agent.manifest?.notes ?? agent.roleTitle)}</div>
            </div>
          </div>
        )}
        <Field label="What should be done?">
          <input className="input" required minLength={2} maxLength={200} placeholder="e.g. Add a pricing section to the landing page" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Details & acceptance criteria (optional)">
          <textarea className="input min-h-[100px]" maxLength={10000} placeholder="Requirements, constraints, what 'done' looks like…" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Priority">
          <select className="input" value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })}>
            {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(p => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !projects.length}><Send size={15} /> {busy ? "Queuing…" : "Send to agent"}</button>
        </div>
      </form>
    </Modal>
  );
}
