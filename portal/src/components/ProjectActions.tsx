"use client";
import { useState } from "react";
import { BookOpenCheck, Download, ExternalLink, Github, Globe, Loader2, Lock, Square } from "lucide-react";
import { api, downloadFile, PreviewInfo, Project, runJob } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { HelpText, Modal } from "./ui";

/**
 * Workspace action toolbar: Live Preview, Download ZIP, Push to GitHub, Generate Client Handoff.
 * Same backend operations as the Discord bot's /preview, /download, /github-push and /handoff.
 */
export function ProjectActions({ project, onChanged, compact }: { project: Project; onChanged?: () => void; compact?: boolean }) {
  const { canWrite } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(project.preview ?? null);
  const [ghOpen, setGhOpen] = useState(false);
  const live = preview ?? project.preview ?? null;

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
    setPreview(p);
    window.open(p.url, "_blank", "noopener");
    return p;
  }, p => `Preview is live on port ${p.port}`);
  const stopPreview = () => act("stop", async () => { await api(`/projects/${project.id}/preview`, { method: "DELETE" }); setPreview(null); }, () => "Preview stopped");
  const download = () => act("zip", () => downloadFile(`/projects/${project.id}/download`, `${project.slug}.zip`), n => `Downloaded ${n}`);
  const handoff = () => act("handoff", () => api<{ id: number }>(`/projects/${project.id}/handoff`, { method: "POST" }), t => `Hand-off task #${t.id} queued (README, setup guide, .env.example)`);

  if (!canWrite) return null;
  const size = compact ? "!px-2.5 !py-1 text-xs" : "";
  const spin = (k: string) => busy === k && <Loader2 size={14} className="animate-spin" />;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {live ? (
          <>
            <a className={`btn-success ${size}`} href={live.url} target="_blank" rel="noreferrer noopener"><Globe size={15} /> Open Preview <ExternalLink size={12} /></a>
            <button className={`btn-ghost ${size}`} onClick={stopPreview} disabled={!!busy}>{spin("stop") || <Square size={13} />} Stop</button>
          </>
        ) : (
          <button className={`btn-primary ${size}`} onClick={startPreview} disabled={!!busy} title="Start a live staging server for this workspace">{spin("preview") || <Globe size={15} />} Live Preview</button>
        )}
        <button className={`btn-ghost ${size}`} onClick={download} disabled={!!busy} title="ZIP of the workspace (without node_modules, .git, build output and real .env files)">{spin("zip") || <Download size={15} />} Download ZIP</button>
        <button className={`btn-ghost ${size}`} onClick={() => setGhOpen(true)} disabled={!!busy}>{spin("github") || <Github size={15} />} Push to GitHub</button>
        {!compact && <button className={`btn-ghost ${size}`} onClick={handoff} disabled={!!busy} title="Queue a docs-only task: README.md, docs/SETUP.md, .env.example">{spin("handoff") || <BookOpenCheck size={15} />} Generate Client Handoff</button>}
      </div>
      {progress && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> {progress}</p>}
      {live && !compact && <p className="text-xs text-slate-500">Preview: <a className="font-mono text-amber-200/90 hover:underline" href={live.url} target="_blank" rel="noreferrer noopener">{live.url}</a> · {live.kind}</p>}
      {project.githubRepoUrl && !compact && <p className="text-xs text-slate-500">GitHub: <a className="font-mono text-amber-200/90 hover:underline" href={project.githubRepoUrl} target="_blank" rel="noreferrer noopener">{project.githubRepoUrl}</a></p>}

      {ghOpen && (
        <Modal title="Push to GitHub" onClose={() => setGhOpen(false)}>
          <HelpText>
            Creates <span className="mono-badge">{project.slug}</span> on your GitHub account if it doesn&apos;t exist yet, then pushes the workspace&apos;s <span className="mono-badge">main</span> branch (only CEO-approved, merged work).
            If the repo already exists its visibility is left unchanged.
          </HelpText>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(["private", "public"] as const).map(v => (
              <button key={v} className="card card-hover flex flex-col items-start gap-1 p-4 text-left" disabled={!!busy}
                onClick={() => { setGhOpen(false); act("github", async () => {
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
    </div>
  );
}
