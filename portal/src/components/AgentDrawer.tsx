"use client";
import { useEffect, useState } from "react";
import { Pause, Play, Power, Save } from "lucide-react";
import { Agent, api, fmtDate, fmtMs, label } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, Drawer, Field, providerName, Skeleton, Terminal } from "@/components/ui";

const lines = (s: string) => s.split("\n").map(x => x.trim()).filter(Boolean);

export function AgentDrawer({ agentId, onClose, onChanged }: { agentId: number; onClose: () => void; onChanged: () => void }) {
  const { data: agent, reload } = useApi<Agent>(`/agents/${agentId}`, 10000);
  const { canWrite } = useSession();
  const { run } = useToast();
  const [f, setF] = useState({ roleTitle: "", modelProvider: "CLAUDE_CODE", maxSteps: 50, timeoutSeconds: 1800, allowedTools: "", prohibitedActions: "" });
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Populate the form once per agent so polling doesn't overwrite edits in progress.
  useEffect(() => {
    if (agent && loadedId !== agent.id) {
      setLoadedId(agent.id);
      setF({
        roleTitle: agent.roleTitle, modelProvider: agent.modelProvider, maxSteps: agent.manifest.maxSteps, timeoutSeconds: agent.manifest.timeoutSeconds,
        allowedTools: agent.manifest.allowedTools.join("\n"), prohibitedActions: agent.manifest.prohibitedActions.join("\n"),
      });
    }
  }, [agent, loadedId]);

  async function save() {
    setBusy(true);
    const r = await run(() => api(`/agents/${agentId}`, {
      method: "PATCH",
      body: { roleTitle: f.roleTitle, modelProvider: f.modelProvider, manifest: { maxSteps: Number(f.maxSteps), timeoutSeconds: Number(f.timeoutSeconds), allowedTools: lines(f.allowedTools), prohibitedActions: lines(f.prohibitedActions) } },
    }), "Agent updated");
    setBusy(false);
    if (r) { reload(); onChanged(); }
  }
  async function act(action: string) {
    if (action === "disable" && !window.confirm("Disable this agent?")) return;
    const r = await run(() => api(`/agents/${agentId}/action`, { method: "POST", body: { action } }), `Agent ${action}d`);
    if (r) { reload(); onChanged(); }
  }

  return (
    <Drawer title={agent?.name ?? "Agent"} onClose={onClose}
      subtitle={agent && <span className="flex flex-wrap items-center gap-2">{label(agent.department)} · {providerName(agent.modelProvider)} <Badge value={agent.status} /> · {agent.totalRuns} runs</span>}>
      {!agent ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-40" /></div> : (
        <div className="space-y-5">
          <div className="text-sm text-slate-400">Current task: <span className="text-slate-200">{agent.currentTask?.title ?? "none"}</span></div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {agent.status === "PAUSED" && <button className="btn-ghost" onClick={() => act("resume")}><Play size={14} /> Resume</button>}
              {!["PAUSED", "DISABLED"].includes(agent.status) && <button className="btn-ghost" onClick={() => act("pause")}><Pause size={14} /> Pause</button>}
              {agent.status === "DISABLED" ? <button className="btn-ghost" onClick={() => act("enable")}><Power size={14} /> Enable</button>
                : <button className="btn-ghost" onClick={() => act("disable")}><Power size={14} /> Disable</button>}
            </div>
          )}

          <fieldset disabled={!canWrite} className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Manifest editor</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Role title"><input className="input" value={f.roleTitle} onChange={e => setF({ ...f, roleTitle: e.target.value })} /></Field>
              <Field label="Model provider">
                <select className="input" value={f.modelProvider} onChange={e => setF({ ...f, modelProvider: e.target.value })}>
                  <option value="CLAUDE_CODE">Claude Code</option><option value="GEMINI_API">Gemini API</option>
                </select>
              </Field>
              <Field label="Max steps"><input type="number" min={1} max={1000} className="input" value={f.maxSteps} onChange={e => setF({ ...f, maxSteps: Number(e.target.value) })} /></Field>
              <Field label="Timeout (seconds)"><input type="number" min={10} max={86400} className="input" value={f.timeoutSeconds} onChange={e => setF({ ...f, timeoutSeconds: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Allowed tools" hint="One per line"><textarea className="input h-28 font-mono text-xs" value={f.allowedTools} onChange={e => setF({ ...f, allowedTools: e.target.value })} /></Field>
            <Field label="Prohibited actions" hint="One per line"><textarea className="input h-28 font-mono text-xs" value={f.prohibitedActions} onChange={e => setF({ ...f, prohibitedActions: e.target.value })} /></Field>
          </fieldset>
          {canWrite && <button className="btn-primary" onClick={save} disabled={busy}><Save size={15} /> Save manifest</button>}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-white">Recent runs</h3>
            {(agent.runs?.length ?? 0) === 0 && <p className="text-sm text-slate-500">No runs recorded.</p>}
            <div className="space-y-2">
              {agent.runs?.map(r => (
                <div key={r.id} className="rounded-lg border border-white/5 bg-ink-800/60">
                  <button className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                    <Badge value={r.status} /> <span className="text-slate-300">{r.task?.title ?? "—"}</span>
                    <span className="ml-auto text-slate-500">{fmtDate(r.startedAt)} · {fmtMs(r.executionMs)}</span>
                  </button>
                  {openRun === r.id && <div className="px-3 pb-3"><Terminal text={(r.errorMessage ? `ERROR: ${r.errorMessage}\n` : "") + r.logs} /></div>}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </Drawer>
  );
}
