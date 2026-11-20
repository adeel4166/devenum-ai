"use client";
import { useState } from "react";
import { Pause, Play, Power, Settings2 } from "lucide-react";
import { Agent, api, label } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { Badge, ErrorBox, Modal, PageHeader, providerName } from "@/components/ui";

const DEPTS = ["LEADERSHIP", "ARCHITECTURE", "DESIGN", "ENGINEERING", "QA_SECURITY", "DEVOPS"];
const STATUSES = ["AVAILABLE", "RUNNING", "WAITING_APPROVAL", "BLOCKED", "PAUSED", "FAILED", "DISABLED"];

export default function AgentsPage() {
  const [dept, setDept] = useState("");
  const [status, setStatus] = useState("");
  const qs = new URLSearchParams({ ...(dept && { department: dept }), ...(status && { status }) }).toString();
  const { data, error, reload } = useApi<Agent[]>(`/agents${qs ? `?${qs}` : ""}`, 8000);
  const { canWrite } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Agent | null>(null);

  async function act(a: Agent, action: string) {
    try {
      await api(`/agents/${a.id}/action`, { method: "POST", body: { action } });
      setErr(null);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Agents Directory"
        subtitle="Your digital employees"
        action={
          <div className="flex gap-2">
            <select className="input !w-auto" value={dept} onChange={e => setDept(e.target.value)}>
              <option value="">All departments</option>
              {DEPTS.map(d => <option key={d} value={d}>{label(d)}</option>)}
            </select>
            <select className="input !w-auto" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map(d => <option key={d} value={d}>{label(d)}</option>)}
            </select>
          </div>
        }
      />
      <ErrorBox message={error || err} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map(a => (
          <div key={a.id} className="card flex flex-col p-5">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-white">{a.name}</div>
                <div className="text-xs text-slate-500">{a.roleTitle} · {label(a.department)}</div>
              </div>
              <Badge value={a.status} />
            </div>
            <dl className="mb-4 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Model</dt><dd>{providerName(a.modelProvider)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-slate-500">Current task</dt><dd className="truncate text-right">{a.currentTask?.title ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Total runs</dt><dd>{a.totalRuns}</dd></div>
            </dl>
            {canWrite && (
              <div className="mt-auto flex flex-wrap gap-2">
                {a.status === "PAUSED" ? (
                  <button className="btn-ghost" onClick={() => act(a, "resume")}><Play size={14} /> Resume</button>
                ) : (
                  a.status !== "DISABLED" && <button className="btn-ghost" onClick={() => act(a, "pause")}><Pause size={14} /> Pause</button>
                )}
                {a.status === "DISABLED" ? (
                  <button className="btn-ghost" onClick={() => act(a, "enable")}><Power size={14} /> Enable</button>
                ) : (
                  <button className="btn-ghost" onClick={() => window.confirm(`Disable ${a.name}?`) && act(a, "disable")}><Power size={14} /> Disable</button>
                )}
                <button className="btn-ghost ml-auto" onClick={() => setEditing(a)}><Settings2 size={14} /> Manifest</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {editing && <ManifestModal agent={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function ManifestModal({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(JSON.stringify(agent.manifest, null, 2));
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      setErr("Manifest is not valid JSON");
      return;
    }
    try {
      await api(`/agents/${agent.id}/manifest`, { method: "PUT", body: { manifest } });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Modal title={`Manifest — ${agent.name}`} onClose={onClose} wide>
      <ErrorBox message={err} />
      <p className="mb-2 text-xs text-slate-400">Required: allowedTools[], prohibitedActions[], maxSteps, timeoutSeconds. Changes are written to the audit log.</p>
      <textarea className="input h-80 font-mono text-xs" spellCheck={false} value={text} onChange={e => setText(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save}>Save manifest</button>
      </div>
    </Modal>
  );
}
