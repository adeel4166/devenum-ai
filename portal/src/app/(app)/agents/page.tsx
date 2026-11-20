"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Pause, Play, Power } from "lucide-react";
import { Agent, api, label } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { AgentDrawer } from "@/components/AgentDrawer";
import { Badge, CardSkeletons, ErrorBox, PageHeader, providerName } from "@/components/ui";

const DEPTS = ["LEADERSHIP", "ARCHITECTURE", "DESIGN", "ENGINEERING", "QA_SECURITY", "DEVOPS"];
const STATUSES = ["AVAILABLE", "RUNNING", "WAITING_APPROVAL", "BLOCKED", "PAUSED", "FAILED", "DISABLED"];

export default function AgentsPage() {
  return <Suspense fallback={null}><AgentsInner /></Suspense>;
}

function AgentsInner() {
  const sp = useSearchParams();
  const [dept, setDept] = useState(sp.get("department") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const qs = new URLSearchParams({ ...(dept && { department: dept }), ...(status && { status }) }).toString();
  const { data, error, loading, reload } = useApi<Agent[]>(`/agents${qs ? `?${qs}` : ""}`, 8000);
  const { canWrite } = useSession();
  const { run } = useToast();
  const [open, setOpen] = useState<number | null>(null);

  async function act(a: Agent, action: string) {
    if (action === "disable" && !window.confirm(`Disable ${a.name}?`)) return;
    if (await run(() => api(`/agents/${a.id}/action`, { method: "POST", body: { action } }), `${a.name}: ${action} applied`)) reload();
  }
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      <PageHeader title="Agents Directory" subtitle="Click an agent to inspect runs and edit its manifest" action={
        <div className="flex gap-2">
          <select className="input !w-auto" value={dept} onChange={e => setDept(e.target.value)}><option value="">All departments</option>{DEPTS.map(d => <option key={d} value={d}>{label(d)}</option>)}</select>
          <select className="input !w-auto" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{STATUSES.map(d => <option key={d} value={d}>{label(d)}</option>)}</select>
        </div>} />
      <ErrorBox message={error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading && !data && <CardSkeletons n={6} h="h-44" />}
        {data?.map(a => (
          <div key={a.id} className="card card-hover flex flex-col p-5" onClick={() => setOpen(a.id)}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div><div className="font-semibold text-white">{a.name}</div><div className="text-xs text-slate-500">{a.roleTitle} · {label(a.department)}</div></div>
              <Badge value={a.status} />
            </div>
            <dl className="mb-4 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Model</dt><dd>{providerName(a.modelProvider)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">Current task</dt><dd className="truncate text-right">{a.currentTask?.title ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Total runs</dt><dd>{a.totalRuns}</dd></div>
            </dl>
            {canWrite && (
              <div className="mt-auto flex flex-wrap gap-2" onClick={stop}>
                {a.status === "PAUSED" ? <button className="btn-ghost" onClick={() => act(a, "resume")}><Play size={14} /> Resume</button>
                  : a.status !== "DISABLED" && <button className="btn-ghost" onClick={() => act(a, "pause")}><Pause size={14} /> Pause</button>}
                {a.status === "DISABLED" ? <button className="btn-ghost" onClick={() => act(a, "enable")}><Power size={14} /> Enable</button>
                  : <button className="btn-ghost" onClick={() => act(a, "disable")}><Power size={14} /> Disable</button>}
              </div>
            )}
          </div>
        ))}
        {data?.length === 0 && <div className="card col-span-full p-8 text-center text-slate-500">No agents match these filters.</div>}
      </div>
      {open && <AgentDrawer agentId={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}
