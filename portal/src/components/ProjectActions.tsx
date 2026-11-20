"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BookOpenCheck, Download, ExternalLink, Github, Globe, Info, Loader2, Lock, Rocket, Square, Trash2 } from "lucide-react";
import { api, downloadFile, PreviewInfo, Project, runJob } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { Field, HelpText, Modal } from "./ui";

const NO_WS = "Run first task to initialize workspace";

/** Explicit target shown before any write / deploy / delete action. */
function TargetBanner({ project }: { project: Project }) {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-2 text-xs text-slate-200">
      🎯 Target project: <b className="text-white">{project.name}</b> <span className="font-mono text-slate-400">#{project.id} · {project.slug}</span>
      {project.isFrozen && <span className="text-sky-300">❄️ frozen</span>}
    </div>
  );
}

/**
 * Workspace action toolbar: Live Preview, Deploy Live, Download ZIP, Push to GitHub, Generate Handoff, Delete Project.
 * Same backend operations as the Discord bot. Workspace-dependent actions are disabled (with guidance) until the
 * first agent run has created the git workspace.
 */
export function ProjectActions({ project, onChanged, compact }: { project: Project; onChanged?: () => void; compact?: boolean }) {
  const router = useRouter();
  const { canWrite, isCeo, refreshProjects } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null | undefined>(undefined);
  const [liveUrl, setLiveUrl] = useState<string | null | undefined>(undefined);
  const [modal, setModal] = useState<"github" | "delete" | "deploy" | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const live = preview === undefined ? project.preview ?? null : preview;
  const deployed = liveUrl === undefined ? project.liveUrl ?? null : liveUrl;
  const ws = project.workspaceExists !== false;

  async function act<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => string) {
    setBusy(key); setProgress(null);
    try {
      const r = await fn();
      if (ok) toast("success", ok(r));
      onChanged?.();
      return r;
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null); setProgress(null);
    }
  }

  const startPreview = () => act("preview", async () => {
    const p = await runJob<PreviewInfo>(`/projects/${project.id}/preview`, {}, setProgress);
    setPreview(p); window.open(p.url, "_blank", "noopener");
    return p;
  }, p => `Preview is live on port ${p.port}`);
  const stopPreview = () => act("stop", async () => { await api(`/projects/${project.id}/preview`, { method: "DELETE" }); setPreview(null); }, () => "Preview stopped");
  const deploy = () => act("deploy", async () => {
    setModal(null);
    const r = await runJob<{ url: string; port: number; kind: string }>(`/projects/${project.id}/deploy`, {}, setProgress);
    setLiveUrl(r.url); window.open(r.url, "_blank", "noopener");
    return r;
  }, r => `Live on ${r.url} (${r.kind})`);
  const stopDeploy = () => {
    if (!window.confirm(`Stop the permanent live deploy of ${project.name}?`)) return;
    act("undeploy", async () => { await api(`/projects/${project.id}/deploy-stop`, { method: "POST" }); setLiveUrl(null); }, () => "Live deploy stopped");
  };
  const download = () => act("zip", () => downloadFile(`/projects/${project.id}/download`, `${project.slug}.zip`), n => `Downloaded ${n}`);
  const handoff = () => act("handoff", () => api<{ id: number }>(`/projects/${project.id}/handoff`, { method: "POST" }), t => `Hand-off task #${t.id} queued (README, setup guide, .env.example)`);
  const del = () => act("delete", async () => {
    setModal(null);
    const r = await api<{ name: string }>(`/projects/${project.id}`, { method: "DELETE" });
    await refreshProjects();
    router.push("/projects");
    return r;
  }, r => `${r.name} deleted`);

  if (!canWrite) return null;
  const size = compact ? "!px-2.5 !py-1 text-xs" : "";
  const spin = (k: string) => busy === k && <Loader2 size={14} className="animate-spin" />;
  const wsTitle = (t: string) => (ws ? t : NO_WS);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {live ? (
          <>
            <a className={`btn-success ${size}`} href={live.url} target="_blank" rel="noreferrer noopener"><Globe size={15} /> Open Preview <ExternalLink size={12} /></a>
            <button className={`btn-ghost ${size}`} onClick={stopPreview} disabled={!!busy}>{spin("stop") || <Square size={13} />} Stop</button>
          </>
        ) : (
          <button className={`btn-primary ${size}`} onClick={startPreview} disabled={!!busy || !ws} title={wsTitle("Start a temporary staging preview (ports 5101–5199)")}>{spin("preview") || <Globe size={15} />} Live Preview</button>
        )}
        {!compact && isCeo && (deployed ? (
          <>
            <a className={`btn-success ${size}`} href={deployed} target="_blank" rel="noreferrer noopener"><Rocket size={15} /> Live Site <ExternalLink size={12} /></a>
            <button className={`btn-ghost ${size}`} onClick={() => setModal("deploy")} disabled={!!busy || !ws} title="Rebuild and redeploy">{spin("deploy") || <Rocket size={13} />} Redeploy</button>
            <button className={`btn-ghost ${size}`} onClick={stopDeploy} disabled={!!busy}>{spin("undeploy") || <Square size={13} />} Stop live</button>
          </>
        ) : (
          <button className={`btn-ghost ${size}`} onClick={() => setModal("deploy")} disabled={!!busy || !ws} title={wsTitle("Build and run permanently with PM2 (ports 5201–5299)")}>{spin("deploy") || <Rocket size={15} />} Deploy Live</button>
        ))}
        <button className={`btn-ghost ${size}`} onClick={download} disabled={!!busy || !ws} title={wsTitle("ZIP of the workspace (without node_modules, .git, build output and real .env files)")}>{spin("zip") || <Download size={15} />} {compact ? "ZIP" : "Download ZIP"}</button>
        <button className={`btn-ghost ${size}`} onClick={() => setModal("github")} disabled={!!busy || !ws} title={wsTitle("Create the GitHub repo if needed and push main")}>{spin("github") || <Github size={15} />} {compact ? "GitHub" : "Push to GitHub"}</button>
        {!compact && <button className={`btn-ghost ${size}`} onClick={handoff} disabled={!!busy} title="Queue a docs-only task: README.md, docs/SETUP.md, .env.example">{spin("handoff") || <BookOpenCheck size={15} />} Generate Handoff</button>}
        {!compact && isCeo && <button className={`btn-ghost ${size} hover:!border-rose-500/40 hover:!text-rose-300`} onClick={() => { setConfirmName(""); setModal("delete"); }} disabled={!!busy}>{spin("delete") || <Trash2 size={15} />} Delete Project</button>}
      </div>
      {!ws && <p className="flex items-center gap-1.5 text-xs text-amber-200/80"><Info size={12} /> {NO_WS} — preview, deploy, ZIP and GitHub unlock after the first agent run.</p>}
      {progress && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> {progress}</p>}
      {!compact && (live || deployed || project.githubRepoUrl) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          {live && <span>Preview: <a className="font-mono text-amber-200/90 hover:underline" href={live.url} target="_blank" rel="noreferrer noopener">{live.url}</a></span>}
          {deployed && <span>Live: <a className="font-mono text-emerald-300 hover:underline" href={deployed} target="_blank" rel="noreferrer noopener">{deployed}</a>{project.live ? ` · ${project.live.status}` : ""}</span>}
          {project.githubRepoUrl && <span>GitHub: <a className="font-mono text-amber-200/90 hover:underline" href={project.githubRepoUrl} target="_blank" rel="noreferrer noopener">{project.githubRepoUrl}</a></span>}
        </div>
      )}

      {modal === "github" && (
        <Modal title="Push to GitHub" onClose={() => setModal(null)}>
          <TargetBanner project={project} />
          <HelpText>
            Creates <span className="mono-badge">{project.slug}</span> on your GitHub account if it doesn&apos;t exist yet, then pushes the workspace&apos;s <span className="mono-badge">main</span> branch — only CEO-approved, merged work. Existing repos keep their visibility.
          </HelpText>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(["private", "public"] as const).map(v => (
              <button key={v} className="card card-hover flex flex-col items-start gap-1 p-4 text-left" disabled={!!busy}
                onClick={() => { setModal(null); act("github", async () => {
                  const r = await runJob<{ url: string; created: boolean; isPrivate: boolean; visibilityMismatch: boolean }>(`/projects/${project.id}/github`, { visibility: v }, setProgress);
                  window.open(r.url, "_blank", "noopener");
                  return r;
                }, r => `${r.created ? "Created" : "Updated"} ${r.isPrivate ? "private" : "public"} repo: ${r.url}${r.visibilityMismatch ? " (existing visibility kept)" : ""}`); }}>
                <span className="flex items-center gap-2 font-medium text-white">{v === "private" ? <Lock size={15} /> : <Globe size={15} />} {v === "private" ? "Private repository" : "Public repository"}</span>
                <span className="text-xs text-slate-400">{v === "private" ? "Only you and collaborators can see it." : "Anyone on the internet can see the code."}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {modal === "deploy" && (
        <Modal title={deployed ? "Redeploy live site" : "Deploy live"} onClose={() => setModal(null)}>
          <TargetBanner project={project} />
          <HelpText>
            Builds <span className="mono-badge">main</span> (npm install + build if defined) and runs it permanently as PM2 process <span className="mono-badge">live-{project.slug}</span> on a dedicated port (5201–5299). It survives reboots and keeps running until you stop it. Only approved, merged work is deployed.
          </HelpText>
          <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={() => setModal(null)}>Cancel</button><button className="btn-primary" onClick={deploy}><Rocket size={15} /> {deployed ? "Redeploy now" : "Deploy now"}</button></div>
        </Modal>
      )}

      {modal === "delete" && (
        <Modal title={`Delete ${project.name}?`} onClose={() => setModal(null)}>
          <div className="space-y-4">
            <TargetBanner project={project} />
            <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100">
              This stops its preview and live deploy, permanently deletes all its tasks, proposals, runs and related audit events, and removes the workspace folder <span className="font-mono">{project.repoPath}</span>. GitHub repos are not touched. <b>This cannot be undone.</b>
            </p>
            <Field label={`Type "${project.name}" to confirm`}><input className="input" autoFocus value={confirmName} onChange={e => setConfirmName(e.target.value)} /></Field>
            <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={() => setModal(null)}>Cancel</button><button className="btn-danger" disabled={confirmName !== project.name} onClick={del}><Trash2 size={15} /> Delete permanently</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
