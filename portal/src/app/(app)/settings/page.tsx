"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { ErrorBox, Field, PageHeader } from "@/components/ui";

interface S {
  geminiApiKey: string; claudeCliMode: boolean; maxConcurrentAgents: number; maxStepsPerRun: number;
  maxRunTimeoutSeconds: number; dailyTokenBudget: number; requireApprovalForHighRisk: boolean;
}

export default function SettingsPage() {
  const { data, error } = useApi<S>("/system/settings");
  const { canWrite } = useSession();
  const [f, setF] = useState<S | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return <ErrorBox message={error} />;

  const num = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      setF(await api<S>("/system/settings", { method: "PUT", body: f }));
      setMsg({ ok: true, text: "Settings saved and audit-logged." });
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Provider configuration and global safety caps" />
      <form onSubmit={save} className="max-w-2xl space-y-6">
        {msg && <div className={`rounded-lg border px-3 py-2 text-sm ${msg.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-rose-500/30 bg-rose-500/10 text-rose-300"}`}>{msg.text}</div>}
        <fieldset disabled={!canWrite} className="space-y-6">
          <section className="card space-y-4 p-5">
            <h2 className="font-semibold text-white">Model providers</h2>
            <Field label="Gemini API key (placeholder — stored server-side, shown masked)">
              <input className="input" type="password" autoComplete="off" placeholder="AIza…" value={f.geminiApiKey} onChange={e => setF({ ...f, geminiApiKey: e.target.value })} />
            </Field>
            <label className="flex items-center justify-between rounded-lg bg-ink-900 p-3 text-sm">
              <span>
                <span className="block text-slate-200">Claude CLI mode</span>
                <span className="text-xs text-slate-500">Run Claude Code agents through the local CLI instead of the API.</span>
              </span>
              <input type="checkbox" className="h-5 w-5 accent-indigo-500" checked={f.claudeCliMode} onChange={e => setF({ ...f, claudeCliMode: e.target.checked })} />
            </label>
          </section>
          <section className="card space-y-4 p-5">
            <h2 className="font-semibold text-white">Global safety caps</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max concurrent agents"><input type="number" min={1} max={50} className="input" value={f.maxConcurrentAgents} onChange={num("maxConcurrentAgents")} /></Field>
              <Field label="Max steps per run"><input type="number" min={1} max={1000} className="input" value={f.maxStepsPerRun} onChange={num("maxStepsPerRun")} /></Field>
              <Field label="Max run timeout (s)"><input type="number" min={10} className="input" value={f.maxRunTimeoutSeconds} onChange={num("maxRunTimeoutSeconds")} /></Field>
              <Field label="Daily token budget"><input type="number" min={0} className="input" value={f.dailyTokenBudget} onChange={num("dailyTokenBudget")} /></Field>
            </div>
            <label className="flex items-center justify-between rounded-lg bg-ink-900 p-3 text-sm">
              <span className="text-slate-200">Always require CEO approval for high-risk actions</span>
              <input type="checkbox" className="h-5 w-5 accent-indigo-500" checked={f.requireApprovalForHighRisk} onChange={e => setF({ ...f, requireApprovalForHighRisk: e.target.checked })} />
            </label>
          </section>
          {canWrite && <button className="btn-primary">Save settings</button>}
        </fieldset>
      </form>
    </>
  );
}
