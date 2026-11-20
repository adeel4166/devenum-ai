"use client";
import { useMemo, useState } from "react";
import { Pause, Play, Send, SlidersHorizontal, Users } from "lucide-react";
import { Agent, api, label } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { AgentDrawer } from "@/components/AgentDrawer";
import { AssignTaskModal } from "@/components/AssignTaskModal";
import { AgentAvatar, Badge, CardSkeletons, EmptyState, ErrorBox, PageHeader, providerName } from "@/components/ui";

const DEPARTMENTS = ["ALL", "LEADERSHIP", "ARCHITECTURE", "DESIGN", "ENGINEERING", "QA_SECURITY", "DEVOPS"];

function statusLine(a: Agent) {
  if (a.status === "RUNNING") return { text: a.currentTask ? `Working on “${a.currentTask.title}”` : "Working", tone: "text-sky-300" };
  if (a.status === "AVAILABLE") return { text: "Available — ready for work", tone: "text-emerald-300" };
  if (a.status === "WAITING_APPROVAL") return { text: "Waiting for your approval", tone: "text-amber-300" };
  if (a.status === "PAUSED") return { text: "Paused", tone: "text-slate-400" };
  if (a.status === "DISABLED") return { text: "Disabled", tone: "text-slate-500" };
  return { text: label(a.status), tone: "text-rose-300" };
}

export default function AgentsPage() {
  const { data, error, loading, reload } = useApi<Agent[]>("/agents", 5000);
  const { canWrite } = useSession();
  const { run } = useToast();
  const [dept, setDept] = useState("ALL");
  const [open, setOpen] = useState<number | null>(null);
  const [assignTo, setAssignTo] = useState<number | null>(null);

  const agents = useMemo(() => (data ?? []).filter(a => dept === "ALL" || a.department === dept), [data, dept]);
  const working = (data ?? []).filter(a => a.status === "RUNNING").length;

  async function act(a: Agent, action: "pause" | "resume") {
    if (await run(() => api(`/agents/${a.id}/action`, { method: "POST", body: { action } }), `${a.name} ${action === "pause" ? "paused" : "resumed"}`)) reload();
  }

  return (
    <div>
      <PageHeader title="Your AI Team" subtitle={`${data?.length ?? 11} specialist agents. ${working ? `${working} working right now.` : "All idle right now."} Assign work directly, or open an agent to tune its rules and see its run history.`} />
      <div className="mb-5 flex flex-wrap gap-1.5">
        {DEPARTMENTS.map(d => (
          <button key={d} onClick={() => setDept(d)} className={`pill !py-1 text-xs ${dept === d ? "border-brand/50 bg-brand/15 text-white" : "border-white/10 text-slate-400 hover:text-slate-200"}`}>
            {d === "ALL" ? "Everyone" : label(d)}
          </button>
        ))}
      </div>
      <ErrorBox message={error} />
      {loading && !data ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><CardSkeletons n={6} h="h-52" /></div> : !agents.length ? (
        <EmptyState icon={Users} title="No agents in this department" text="Pick another filter above." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map(a => {
            const s = statusLine(a);
            const notes = String(a.manifest?.notes ?? "");
            return (
              <div key={a.id} className="card flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <AgentAvatar slug={a.slug} size={48} working={a.status === "RUNNING"} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold text-white">{a.name}</h3>
                    <div className="truncate text-xs text-slate-400">{a.roleTitle} · {label(a.department)}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${a.modelProvider === "CLAUDE_CODE" ? "border-brand/40 bg-brand/10 text-brand-soft" : "border-sky-500/40 bg-sky-500/10 text-sky-300"}`}>{providerName(a.modelProvider)}</span>
                      <Badge value={a.status} />
                    </div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 min-h-[3.75rem] text-sm text-slate-400">{notes || a.roleTitle}</p>
                <p className={`mt-2 truncate text-xs ${s.tone}`}>{s.text}</p>
                <div className="mt-1 text-[11px] text-slate-500">{a.totalRuns} runs completed</div>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-white/5 pt-4">
                  {canWrite && <button className="btn-primary !px-2.5 !py-1 text-xs" disabled={a.status === "DISABLED"} onClick={() => setAssignTo(a.id)}><Send size={13} /> Assign Task</button>}
                  <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setOpen(a.id)}><SlidersHorizontal size={13} /> Details & rules</button>
                  {canWrite && a.status !== "DISABLED" && (a.status === "PAUSED"
                    ? <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => act(a, "resume")}><Play size={13} /> Resume</button>
                    : <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => act(a, "pause")}><Pause size={13} /> Pause</button>)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open && <AgentDrawer agentId={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {assignTo && <AssignTaskModal agentId={assignTo} onClose={() => setAssignTo(null)} onCreated={() => reload()} />}
    </div>
  );
}
