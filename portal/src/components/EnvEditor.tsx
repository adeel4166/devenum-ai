"use client";
import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "./toast";
import { ErrorBox, HelpText, Skeleton } from "./ui";

interface Var { key: string; value: string; reveal?: boolean }
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Key/value editor for the project's workspace .env (never committed to git, excluded from ZIPs). */
export function EnvEditor({ projectId, workspaceExists }: { projectId: number; workspaceExists: boolean }) {
  const { toast } = useToast();
  const [vars, setVars] = useState<Var[] | null>(null);
  const [initial, setInitial] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceExists) return;
    api<{ vars: Var[] }>(`/projects/${projectId}/env`).then(r => { setVars(r.vars); setInitial(JSON.stringify(r.vars)); }).catch(e => setErr((e as Error).message));
  }, [projectId, workspaceExists]);

  if (!workspaceExists) return <div className="card p-8 text-center text-sm text-slate-400">Run first task to initialize workspace — then you can manage this project&apos;s environment variables here.</div>;
  if (!vars) return err ? <ErrorBox message={err} /> : <Skeleton className="h-64" />;

  const clean = vars.map(v => ({ key: v.key.trim(), value: v.value }));
  const invalid = clean.filter(v => v.key && !KEY_RE.test(v.key)).map(v => v.key);
  const dupes = clean.map(v => v.key).filter((k, i, a) => k && a.indexOf(k) !== i);
  const dirty = JSON.stringify(clean.filter(v => v.key)) !== initial;
  const set = (i: number, patch: Partial<Var>) => setVars(vs => vs!.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  async function save() {
    setSaving(true);
    try {
      const body = clean.filter(v => v.key);
      await api(`/projects/${projectId}/env`, { method: "PUT", body: { vars: body } });
      setInitial(JSON.stringify(body));
      toast("success", `Saved ${body.length} variable(s) to .env`);
    } catch (e) { toast("error", (e as Error).message); } finally { setSaving(false); }
  }

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold text-white"><KeyRound size={16} className="text-brand" /> Environment variables (.env)</h3>
          <HelpText>Saved to the workspace&apos;s <span className="mono-badge">.env</span> (mode 600). Never committed to git, never included in ZIP downloads. Used by previews and live deploys. Values are masked — click the eye to reveal.</HelpText>
        </div>
        <button className="btn-primary" onClick={save} disabled={saving || !dirty || !!invalid.length || !!dupes.length}>{saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save</button>
      </div>
      {(invalid.length > 0 || dupes.length > 0) && <ErrorBox message={invalid.length ? `Invalid names: ${invalid.join(", ")} (letters, digits, _ ; not starting with a digit)` : `Duplicate names: ${[...new Set(dupes)].join(", ")}`} />}
      {!vars.length && <p className="mb-3 text-sm text-slate-500">No variables yet.</p>}
      <div className="space-y-2">
        {vars.map((v, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <input className="input font-mono sm:!w-64" placeholder="KEY_NAME" value={v.key} onChange={e => set(i, { key: e.target.value.toUpperCase().replace(/\s/g, "_") })} aria-label="Variable name" />
            <span className="hidden text-slate-500 sm:inline">=</span>
            <input className="input flex-1 font-mono" type={v.reveal ? "text" : "password"} autoComplete="off" placeholder="value" value={v.value} onChange={e => set(i, { value: e.target.value })} aria-label={`Value of ${v.key}`} />
            <button className="rounded-lg p-2 text-slate-400 hover:bg-white/10" onClick={() => set(i, { reveal: !v.reveal })} aria-label={v.reveal ? "Hide value" : "Reveal value"}>{v.reveal ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            <button className="rounded-lg p-2 text-slate-400 hover:bg-rose-500/10 hover:text-rose-300" onClick={() => setVars(vs => vs!.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <button className="btn-ghost mt-3" onClick={() => setVars(vs => [...vs!, { key: "", value: "", reveal: true }])}><Plus size={15} /> Add variable</button>
    </div>
  );
}
