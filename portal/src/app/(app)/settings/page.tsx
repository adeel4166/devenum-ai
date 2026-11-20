"use client";
import { useEffect, useState } from "react";
import { Activity, Bot, Database, Download, Github, Globe, HardDriveDownload, KeyRound, Loader2, Pause, Play, Plus, RotateCw, Save, ScrollText, Server, Square, Workflow } from "lucide-react";
import { api, BackupInfo, downloadFile, fmtBytes, fmtDate, Health, runJob, ServiceInfo, Settings, TeamUser, timeAgo, VpsMetrics } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, ErrorBox, Field, HelpText, Modal, PageHeader, Skeleton } from "@/components/ui";

export default function SettingsPage() {
  const { canWrite, isCeo } = useSession();
  return (
    <>
      <PageHeader title="Settings & Controls" subtitle="Run or pause the agency, control concurrency, watch server resources, restart services, take backups and manage your team — no terminal needed." />
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="space-y-6">
          <AgencySection canWrite={canWrite} />
          <ServerSection canWrite={canWrite} />
          {isCeo && <BackupSection />}
          <AdvancedSection canWrite={canWrite} />
          <PasswordSection />
          {isCeo && <TeamSection />}
        </div>
        <HealthPanel canWrite={canWrite} />
      </div>
    </>
  );
}

function Toggle({ on, onChange, disabled, label: l }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={l} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${on ? "bg-emerald-500" : "bg-white/15"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

function AgencySection({ canWrite }: { canWrite: boolean }) {
  const status = useApi<{ globalPaused: boolean }>("/system/status", 8000);
  const { data, error, reload } = useApi<Settings>("/settings");
  const { run, toast } = useToast();
  const [max, setMax] = useState(3);
  const [gemini, setGemini] = useState("");
  const [claude, setClaude] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setMax(data.maxConcurrentAgents); setGemini(data.geminiApiKey); setClaude(data.claudeCliEnabled); } }, [data]);
  const paused = status.data?.globalPaused ?? false;

  async function setPaused(next: boolean) {
    if (next && !window.confirm("Pause the whole agency? Running agent jobs are cancelled and re-queued.")) return;
    setBusy(true);
    try { await api(next ? "/system/pause-all" : "/system/resume-all", { method: "POST" }); toast("success", next ? "Agency paused" : "Agency active again"); status.reload(); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() => api<Settings>("/settings", { method: "PUT", body: { maxConcurrentAgents: max, geminiApiKey: gemini, claudeCliEnabled: claude } }), "Settings saved");
    if (r) reload();
  }

  if (!data) return error ? <ErrorBox message={error} /> : <Skeleton className="h-80" />;
  return (
    <form onSubmit={save} className="card space-y-5 p-5">
      <h2 className="font-semibold text-white">Agency controls</h2>
      <div className={`flex items-center justify-between gap-4 rounded-xl border p-4 ${paused ? "border-rose-500/30 bg-rose-500/[0.06]" : "border-emerald-500/30 bg-emerald-500/[0.06]"}`}>
        <div className="flex items-center gap-3">
          <span className={`grid h-10 w-10 place-items-center rounded-xl ${paused ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>{paused ? <Pause size={18} /> : <Play size={18} />}</span>
          <div>
            <div className="font-medium text-white">Agency is {paused ? "paused" : "active"}</div>
            <HelpText>{paused ? "No tasks start and running jobs were stopped. Switch on to resume." : "Agents pick up READY tasks automatically. Switch off for an emergency stop."}</HelpText>
          </div>
        </div>
        <Toggle on={!paused} onChange={v => setPaused(!v)} disabled={!canWrite || busy || status.loading} label="Agency active" />
      </div>
      <fieldset disabled={!canWrite} className="space-y-5">
        <Field label={`Max concurrent agents: ${max}`} hint="How many agents may run at the same time. Each running agent is one Claude Code session on this server.">
          <div className="flex items-center gap-3">
            <input type="range" min={1} max={11} value={max} onChange={e => setMax(Number(e.target.value))} className="w-full accent-[#d97757]" />
            <input type="number" min={1} max={50} value={max} onChange={e => setMax(Number(e.target.value))} className="input !w-20" />
          </div>
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-xl bg-ink-900 p-3">
          <div><div className="text-sm text-slate-200">Claude Code CLI</div><HelpText>All agents currently run on Claude Code. Turning this off stops new Claude runs.</HelpText></div>
          <Toggle on={claude} onChange={setClaude} label="Claude Code CLI enabled" />
        </div>
        <Field label="Gemini API key (optional, for later)" hint="Only used by agents you switch to Gemini; without a key they fall back to Claude Code. Stored server-side and shown masked.">
          <input className="input font-mono" type="password" autoComplete="off" placeholder="AIza…" value={gemini} onChange={e => setGemini(e.target.value)} />
        </Field>
        {canWrite && <button className="btn-primary"><Save size={15} /> Save</button>}
      </fieldset>
    </form>
  );
}

function AdvancedSection({ canWrite }: { canWrite: boolean }) {
  const { data } = useApi<Settings>("/settings");
  const { run } = useToast();
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  if (!f) return null;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await run(() => api<Settings>("/settings", { method: "PUT", body: {
      autoExpireHours: f!.autoExpireHours, maxStepsPerRun: f!.maxStepsPerRun, maxRunTimeoutSeconds: f!.maxRunTimeoutSeconds,
      dailyTokenBudget: f!.dailyTokenBudget, requireApprovalForHighRisk: f!.requireApprovalForHighRisk,
    } }), "Advanced settings saved");
  }
  return (
    <details className="card group p-5">
      <summary className="cursor-pointer list-none font-semibold text-white">Advanced safety limits <span className="text-xs font-normal text-slate-500">— timeouts, expiry, budgets</span></summary>
      <form onSubmit={save} className="mt-4">
        <fieldset disabled={!canWrite} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Proposal auto-expire (hours)" hint="Undecided proposals expire after this."><input type="number" min={1} max={720} className="input" value={f.autoExpireHours} onChange={num("autoExpireHours")} /></Field>
            <Field label="Max run timeout (seconds)" hint="Caps each agent's own timeout."><input type="number" min={10} className="input" value={f.maxRunTimeoutSeconds} onChange={num("maxRunTimeoutSeconds")} /></Field>
            <Field label="Max steps per run"><input type="number" min={1} max={1000} className="input" value={f.maxStepsPerRun} onChange={num("maxStepsPerRun")} /></Field>
            <Field label="Daily token budget"><input type="number" min={0} className="input" value={f.dailyTokenBudget} onChange={num("dailyTokenBudget")} /></Field>
          </div>
          <label className="flex items-center justify-between rounded-xl bg-ink-900 p-3 text-sm">
            <span className="text-slate-200">Always require CEO approval for high-risk actions</span>
            <input type="checkbox" className="h-5 w-5 accent-[#d97757]" checked={f.requireApprovalForHighRisk} onChange={e => setF({ ...f, requireApprovalForHighRisk: e.target.checked })} />
          </label>
          {canWrite && <button className="btn-ghost"><Save size={15} /> Save advanced settings</button>}
        </fieldset>
      </form>
    </details>
  );
}

function HealthRow({ icon: Icon, name, ok, detail }: { icon: typeof Server; name: string; ok: boolean | null; detail: string }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-slate-300"><Icon size={15} /></span>
      <div className="min-w-0 flex-1"><div className="text-sm text-slate-200">{name}</div><div className="truncate text-xs text-slate-500">{detail}</div></div>
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${ok == null ? "bg-white/10 text-slate-400" : ok ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${ok == null ? "bg-slate-400" : ok ? "bg-emerald-400" : "bg-rose-400"}`} />{ok == null ? "Unknown" : ok ? "Online" : "Offline"}
      </span>
    </li>
  );
}

function HealthPanel({ canWrite }: { canWrite: boolean }) {
  const { data: h, error, reload } = useApi<Health>("/system/health", 10000);
  const { run } = useToast();
  const seen = (s: string | null) => (s ? `last heartbeat ${timeAgo(s)}` : "no heartbeat yet");
  async function stop(projectId: number) {
    if (await run(() => api(`/projects/${projectId}/preview`, { method: "DELETE" }), "Preview stopped")) reload();
  }
  return (
    <aside className="space-y-6">
      <section className="card p-5">
        <div className="mb-1 flex items-center justify-between"><h2 className="font-semibold text-white">System health</h2><Activity size={15} className="text-slate-500" /></div>
        <HelpText>Refreshes every 10 seconds.</HelpText>
        <ErrorBox message={error} />
        <ul className="mt-2 divide-y divide-white/5">
          <HealthRow icon={Server} name="Backend API" ok={error ? false : h ? h.backend.ok : null} detail={h ? `up ${Math.round(h.backend.uptimeSec / 60)} min` : "checking…"} />
          <HealthRow icon={Database} name="Database (MySQL)" ok={h ? h.database.ok : null} detail="Projects, tasks, approvals" />
          <HealthRow icon={Workflow} name="Execution worker" ok={h ? h.worker.ok : null} detail={h ? `${seen(h.worker.lastSeen)}${h.worker.info?.activeRuns != null ? ` · ${h.worker.info.activeRuns} active run(s)` : ""}` : "checking…"} />
          <HealthRow icon={Bot} name="Discord bot" ok={h ? h.bot.ok : null} detail={h ? `${h.bot.info?.user ?? "devenum-bot"} · ${seen(h.bot.lastSeen)}` : "checking…"} />
          <HealthRow icon={KeyRound} name="Claude CLI session" ok={h ? h.claudeAuth?.ok ?? true : null}
            detail={h?.claudeAuth && !h.claudeAuth.ok ? `Expired — run /claude-login in Discord (since ${h.claudeAuth.detectedAt ? timeAgo(h.claudeAuth.detectedAt) : "?"})` : h?.claudeAuth?.recoveredAt ? `Logged in · last re-login ${timeAgo(h.claudeAuth.recoveredAt)}` : "Logged in"} />
          <HealthRow icon={Github} name="GitHub integration" ok={h ? h.github.configured : null} detail={h?.github.configured ? "Token configured" : "Set GITHUB_TOKEN in backend/.env"} />
        </ul>
      </section>
      <section className="card p-5">
        <h2 className="mb-1 font-semibold text-white">Live previews</h2>
        <HelpText>Preview servers started from the portal or Discord (ports 5101–5199).</HelpText>
        {!h?.previews.length ? <p className="mt-3 text-sm text-slate-500">No previews running.</p> : (
          <ul className="mt-3 space-y-2">
            {h.previews.map(p => (
              <li key={p.projectId} className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5 text-sm">
                <Globe size={14} className="shrink-0 text-emerald-300" />
                <a href={p.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate font-mono text-xs text-amber-200/90 hover:underline">{p.slug} · :{p.port}</a>
                {canWrite && <button className="btn-ghost !px-2 !py-0.5 text-xs" onClick={() => stop(p.projectId)}><Square size={11} /> Stop</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
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

function Meter({ label: l, pct, detail }: { label: string; pct: number; detail: string }) {
  const tone = pct >= 90 ? "bg-rose-400" : pct >= 75 ? "bg-amber-400" : "bg-sky-400";
  return (
    <div className="rounded-xl bg-ink-900 p-3">
      <div className="flex items-baseline justify-between"><span className="text-xs uppercase tracking-wide text-slate-400">{l}</span><span className="text-lg font-semibold tabular-nums text-white">{pct}%</span></div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} /></div>
      <div className="mt-1.5 text-xs text-slate-500">{detail}</div>
    </div>
  );
}

function ServerSection({ canWrite }: { canWrite: boolean }) {
  const { data: m, error, reload } = useApi<{ vps: VpsMetrics; services: ServiceInfo[] }>("/system/metrics", 5000);
  const { toast } = useToast();
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function restart(name: string) {
    if (!window.confirm(`Restart ${name}?${name === "devenum-worker" ? " Running agent jobs are cancelled and re-queued." : name === "devenum-backend" ? " The portal reconnects in a few seconds." : ""}`)) return;
    setBusy(name);
    try { await api(`/system/restart/${name}`, { method: "POST" }); toast("success", `${name} is restarting`); setTimeout(reload, 3000); }
    catch (e) { toast("error", (e as Error).message); } finally { setBusy(null); }
  }
  async function viewLogs(name: string) {
    setLogs({ name, text: "Loading…" });
    try { setLogs({ name, text: (await api<{ logs: string }>(`/system/logs/${name}?lines=300`)).logs || "(empty)" }); }
    catch (e) { setLogs({ name, text: (e as Error).message }); }
  }

  return (
    <section className="card space-y-4 p-5">
      <div><h2 className="font-semibold text-white">Server &amp; services</h2><HelpText>Live VPS resources and the Devenum PM2 processes. Restarts only ever touch Devenum services — never other apps on this server.</HelpText></div>
      <ErrorBox message={error} />
      {!m ? <Skeleton className="h-40" /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Meter label="CPU" pct={m.vps.cpu.percent} detail={`${m.vps.cpu.cores} cores · load ${m.vps.cpu.load.join(" / ")}`} />
            <Meter label="Memory" pct={m.vps.memory.percent} detail={`${fmtBytes(m.vps.memory.used)} of ${fmtBytes(m.vps.memory.total)}`} />
            <Meter label="Disk" pct={m.vps.disk.percent} detail={`${fmtBytes(m.vps.disk.used)} of ${fmtBytes(m.vps.disk.total)}`} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {m.services.map(s => (
              <div key={s.name} className="rounded-xl border border-white/[0.06] bg-ink-900 p-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${s.status === "online" ? "animate-pulse bg-emerald-400" : "bg-rose-400"}`} />
                  <span className="font-mono text-sm text-slate-100">{s.name}</span>
                  <span className="ml-auto text-[11px] text-slate-500">{s.kind === "live" ? "live deploy" : s.status}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-400">
                  <span><span className="block text-[10px] uppercase text-slate-500">CPU</span><span className="tabular-nums text-slate-200">{s.cpu}%</span></span>
                  <span><span className="block text-[10px] uppercase text-slate-500">RAM</span><span className="tabular-nums text-slate-200">{fmtBytes(s.memory)}</span></span>
                  <span><span className="block text-[10px] uppercase text-slate-500">Up since</span><span className="text-slate-200">{s.uptimeSince ? timeAgo(new Date(s.uptimeSince).toISOString()) : "—"}</span></span>
                </div>
                <div className="mt-3 flex gap-2">
                  {canWrite && <button className="btn-ghost !px-2 !py-0.5 text-xs" disabled={!!busy} onClick={() => restart(s.name)}><RotateCw size={12} className={busy === s.name ? "animate-spin" : ""} /> Restart</button>}
                  {canWrite && <button className="btn-ghost !px-2 !py-0.5 text-xs" onClick={() => viewLogs(s.name)}><ScrollText size={12} /> View logs</button>}
                  <span className="ml-auto self-center text-[11px] text-slate-500">↺ {s.restarts}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {logs && (
        <Modal title={`Logs · ${logs.name}`} onClose={() => setLogs(null)} wide>
          <HelpText>Last 300 lines of stdout and stderr. Secrets from the server environment are redacted.</HelpText>
          <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-slate-200">{logs.text}</pre>
          <div className="mt-3 flex justify-end"><button className="btn-ghost text-xs" onClick={() => viewLogs(logs.name)}><RotateCw size={12} /> Refresh</button></div>
        </Modal>
      )}
    </section>
  );
}

function BackupSection() {
  const { data, error, reload } = useApi<BackupInfo[]>("/system/backups");
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    try {
      const r = await runJob<BackupInfo>("/system/backup", {}, setProgress, 3_600_000);
      toast("success", `Backup ready (${fmtBytes(r.bytes)})`);
      await reload();
      await downloadFile(`/system/backups/${r.name}`, r.name);
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); setProgress(null); }
  }
  return (
    <section className="card space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-semibold text-white">Backups</h2><HelpText>One ZIP with the full MySQL database and every project workspace (git history included, node_modules excluded). Stored on the server in /opt/devenum-ai/backups. It contains secrets — keep downloads safe.</HelpText></div>
        <button className="btn-primary" onClick={create} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <HardDriveDownload size={15} />} Download Full Backup</button>
      </div>
      {progress && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> {progress}</p>}
      <ErrorBox message={error} />
      {!data ? <Skeleton className="h-16" /> : !data.length ? <p className="text-sm text-slate-500">No backups yet.</p> : (
        <ul className="divide-y divide-white/5">
          {data.map(b => (
            <li key={b.name} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{b.name}</span>
              <span className="text-xs text-slate-500">{fmtBytes(b.bytes)} · {timeAgo(b.createdAt)}</span>
              <button className="btn-ghost !px-2 !py-0.5 text-xs" onClick={() => downloadFile(`/system/backups/${b.name}`, b.name).catch(e => toast("error", (e as Error).message))}><Download size={12} /> Download</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
