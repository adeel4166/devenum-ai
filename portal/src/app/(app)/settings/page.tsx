"use client";
import { useEffect, useState } from "react";
import { KeyRound, Plus, Save } from "lucide-react";
import { api, fmtDate, Settings, TeamUser } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, ErrorBox, Field, Modal, PageHeader, Skeleton } from "@/components/ui";

export default function SettingsPage() {
  const { canWrite, isCeo } = useSession();
  return (
    <>
      <PageHeader title="Settings" subtitle="AI engine, security and team access" />
      <div className="max-w-3xl space-y-6">
        <EngineSection canWrite={canWrite} />
        <PasswordSection />
        {isCeo && <TeamSection />}
      </div>
    </>
  );
}

function EngineSection({ canWrite }: { canWrite: boolean }) {
  const { data, error } = useApi<Settings>("/settings");
  const { run } = useToast();
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return error ? <ErrorBox message={error} /> : <Skeleton className="h-72" />;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() => api<Settings>("/settings", { method: "PUT", body: {
      geminiApiKey: f!.geminiApiKey, claudeCliEnabled: f!.claudeCliEnabled, maxConcurrentAgents: f!.maxConcurrentAgents, autoExpireHours: f!.autoExpireHours,
      maxStepsPerRun: f!.maxStepsPerRun, maxRunTimeoutSeconds: f!.maxRunTimeoutSeconds, dailyTokenBudget: f!.dailyTokenBudget, requireApprovalForHighRisk: f!.requireApprovalForHighRisk,
    } }), "Settings saved");
    if (r) setF(r);
  }

  return (
    <form onSubmit={save} className="card space-y-5 p-5">
      <h2 className="font-semibold text-white">1 · AI Engine & Safety Caps</h2>
      <fieldset disabled={!canWrite} className="space-y-5">
        <Field label="Gemini API key" hint="Stored server-side and always returned masked. Leave the masked value to keep the current key.">
          <input className="input" type="password" autoComplete="off" placeholder="AIza…" value={f.geminiApiKey} onChange={e => setF({ ...f, geminiApiKey: e.target.value })} />
        </Field>
        <label className="flex items-center justify-between rounded-lg bg-ink-900 p-3 text-sm">
          <span><span className="block text-slate-200">Claude CLI mode</span><span className="text-xs text-slate-500">Run Claude Code agents through the local CLI.</span></span>
          <input type="checkbox" className="h-5 w-5 accent-indigo-500" checked={f.claudeCliEnabled} onChange={e => setF({ ...f, claudeCliEnabled: e.target.checked })} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max concurrent agents"><input type="number" min={1} max={50} className="input" value={f.maxConcurrentAgents} onChange={num("maxConcurrentAgents")} /></Field>
          <Field label="Proposal auto-expire (hours)"><input type="number" min={1} max={720} className="input" value={f.autoExpireHours} onChange={num("autoExpireHours")} /></Field>
          <Field label="Max steps per run"><input type="number" min={1} max={1000} className="input" value={f.maxStepsPerRun} onChange={num("maxStepsPerRun")} /></Field>
          <Field label="Max run timeout (s)"><input type="number" min={10} className="input" value={f.maxRunTimeoutSeconds} onChange={num("maxRunTimeoutSeconds")} /></Field>
          <Field label="Daily token budget"><input type="number" min={0} className="input" value={f.dailyTokenBudget} onChange={num("dailyTokenBudget")} /></Field>
        </div>
        <label className="flex items-center justify-between rounded-lg bg-ink-900 p-3 text-sm">
          <span className="text-slate-200">Always require CEO approval for high-risk actions</span>
          <input type="checkbox" className="h-5 w-5 accent-indigo-500" checked={f.requireApprovalForHighRisk} onChange={e => setF({ ...f, requireApprovalForHighRisk: e.target.checked })} />
        </label>
        {canWrite && <button className="btn-primary"><Save size={15} /> Save settings</button>}
      </fieldset>
    </form>
  );
}

function PasswordSection() {
  const { run } = useToast();
  const [f, setF] = useState({ oldPassword: "", newPassword: "", confirm: "" });
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.newPassword.length < 10) { setErr("New password must be at least 10 characters."); return; }
    if (f.newPassword !== f.confirm) { setErr("New passwords do not match."); return; }
    setErr(null);
    if (await run(() => api("/auth/change-password", { method: "POST", body: { oldPassword: f.oldPassword, newPassword: f.newPassword } }), "Password changed")) setF({ oldPassword: "", newPassword: "", confirm: "" });
  }
  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <h2 className="font-semibold text-white">2 · CEO Security — Change password</h2>
      <ErrorBox message={err} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Current password"><input type="password" required autoComplete="current-password" className="input" value={f.oldPassword} onChange={e => setF({ ...f, oldPassword: e.target.value })} /></Field>
        <Field label="New password" hint="Min 10 characters"><input type="password" required autoComplete="new-password" className="input" value={f.newPassword} onChange={e => setF({ ...f, newPassword: e.target.value })} /></Field>
        <Field label="Confirm new"><input type="password" required autoComplete="new-password" className="input" value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} /></Field>
      </div>
      <button className="btn-primary"><KeyRound size={15} /> Update password</button>
    </form>
  );
}

function TeamSection() {
  const { data, error, reload } = useApi<TeamUser[]>("/users");
  const { run } = useToast();
  const [add, setAdd] = useState(false);

  async function patch(u: TeamUser, body: object, msg: string) {
    if (await run(() => api(`/users/${u.id}`, { method: "PATCH", body }), msg)) reload();
  }
  async function resetPw(u: TeamUser) {
    const pw = window.prompt(`New password for ${u.email} (min 10 characters):`);
    if (pw) patch(u, { password: pw }, "Password reset");
  }

  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-white">3 · Team & RBAC Management</h2>
        <button className="btn-primary" onClick={() => setAdd(true)}><Plus size={15} /> Add Admin / Auditor</button>
      </div>
      <ErrorBox message={error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="py-2">User</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody className="divide-y divide-white/5">
            {data?.map(u => (
              <tr key={u.id}>
                <td className="py-2.5"><div className="text-slate-200">{u.name}</div><div className="text-xs text-slate-500">{u.email}</div></td>
                <td>{u.role === "CEO" ? <Badge value="APPROVED" text="CEO" dot={false} /> : (
                  <select className="input !w-auto !py-1" value={u.role} onChange={e => patch(u, { role: e.target.value }, "Role updated")}><option value="ADMIN">Admin</option><option value="AUDITOR">Auditor</option></select>)}</td>
                <td><Badge value={u.isActive ? "AVAILABLE" : "DISABLED"} text={u.isActive ? "Active" : "Disabled"} dot={false} /></td>
                <td className="text-xs text-slate-500">{fmtDate(u.createdAt)}</td>
                <td className="space-x-2 text-right">
                  {u.role !== "CEO" && <>
                    <button className="btn-ghost !py-1" onClick={() => resetPw(u)}>Reset password</button>
                    <button className="btn-ghost !py-1" onClick={() => patch(u, { isActive: !u.isActive }, u.isActive ? "User disabled" : "User enabled")}>{u.isActive ? "Disable" : "Enable"}</button>
                  </>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {add && <AddUser onClose={() => setAdd(false)} onCreated={() => { setAdd(false); reload(); }} />}
    </section>
  );
}

function AddUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { run } = useToast();
  const [f, setF] = useState({ name: "", email: "", password: "", role: "ADMIN" });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => api("/users", { method: "POST", body: f }), "User created")) onCreated();
  }
  return (
    <Modal title="Add team member" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name"><input required minLength={2} className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input required type="email" className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Temporary password" hint="Min 10 characters. Share it securely."><input required minLength={10} type="password" autoComplete="new-password" className="input" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Role"><select className="input" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option value="ADMIN">Admin — manage agents, projects, tasks</option><option value="AUDITOR">Auditor — read-only</option></select></Field>
        <div className="flex justify-end gap-2 pt-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary">Create user</button></div>
      </form>
    </Modal>
  );
}
