"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, FolderKanban, Gamepad2, Github, Globe, Plus, Smartphone } from "lucide-react";
import { api, Project, timeAgo } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { Badge, CardSkeletons, EmptyState, ErrorBox, Field, HelpText, Modal, Mono, PageHeader, Progress } from "@/components/ui";
import { ProjectActions } from "@/components/ProjectActions";
import { Blueprints } from "@/components/Blueprints";

const CATEGORY = { WEB: { icon: Globe, text: "Web" }, MOBILE_APP: { icon: Smartphone, text: "Mobile app" }, GAME: { icon: Gamepad2, text: "Game" } } as const;

function taskProgress(p: Project) {
  const c = p.taskCounts ?? {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { total, done: c.DONE ?? 0, active: (c.IN_PROGRESS ?? 0) + (c.READY ?? 0), review: c.AWAITING_APPROVAL ?? 0, pct: total ? Math.round(((c.DONE ?? 0) / total) * 100) : 0 };
}

export default function ProjectsPage() {
  const { data, error, loading, reload } = useApi<Project[]>("/projects", 10000);
  const { canWrite, refreshProjects } = useSession();
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <PageHeader title="Projects & Workspaces" subtitle="Each project is an isolated git workspace your agents build in. Open one to see its pipeline, preview it live, download it or push it to GitHub."
        action={canWrite && <button className="btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> New project</button>} />
      <ErrorBox message={error} />
      <div className="mb-8"><Blueprints /></div>
      <h2 className="mb-3 font-semibold text-white">Your projects</h2>
      {loading && !data ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><CardSkeletons n={3} h="h-56" /></div> : !data?.length ? (
        <EmptyState icon={FolderKanban} title="No projects yet" text="Create your first project, then describe what to build — the agents take it from there."
          action={canWrite && <button className="btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> Create a project</button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map(p => {
            const Cat = CATEGORY[p.category as keyof typeof CATEGORY] ?? CATEGORY.WEB;
            const t = taskProgress(p);
            return (
              <div key={p.id} className="card flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/projects/${p.id}`} className="min-w-0 group">
                    <div className="flex items-center gap-2 text-xs text-slate-400"><Cat.icon size={13} /> {Cat.text} <Mono>#{p.id}</Mono></div>
                    <h3 className="mt-1 truncate text-lg font-semibold text-white group-hover:text-brand-soft">{p.name}</h3>
                  </Link>
                  <Badge value={p.status} />
                </div>
                <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm text-slate-400">{p.description || "No description"}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {(p.techStack || "Stack not set").split(",").slice(0, 4).map(s => <span key={s} className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-slate-300">{s.trim()}</span>)}
                </div>
                <div className="mt-4">
                  <div className="mb-1.5 flex justify-between text-xs text-slate-400">
                    <span>{t.total ? `${t.done}/${t.total} tasks done` : "No tasks yet"}{t.review ? ` · ${t.review} awaiting approval` : ""}</span><span>{t.pct}%</span>
                  </div>
                  <Progress value={t.pct} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>Last activity {timeAgo(p.lastActivityAt ?? p.createdAt)}</span>
                  {p.preview && <a href={p.preview.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-emerald-300 hover:underline"><Globe size={11} /> Preview live</a>}
                  {p.githubRepoUrl && <a href={p.githubRepoUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-slate-300"><Github size={11} /> GitHub</a>}
                  {!!t.active && <span className="text-sky-300">{t.active} queued/in progress</span>}
                  {p.liveUrl && <a href={p.liveUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-emerald-300 hover:underline">● Live</a>}
                  {p.isFrozen && <span className="text-sky-300">❄️ frozen</span>}
                  {p.workspaceExists === false && <span className="text-amber-200/70">workspace not initialized</span>}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-4">
                  <Link href={`/projects/${p.id}`} className="btn-soft !px-2.5 !py-1 text-xs">Open workspace <ArrowRight size={12} /></Link>
                  <ProjectActions project={p} onChanged={reload} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {creating && <CreateProject onClose={() => setCreating(false)} onCreated={() => { reload(); refreshProjects(); }} />}
    </div>
  );
}

function CreateProject({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const { run } = useToast();
  const [f, setF] = useState({ name: "", category: "WEB", description: "", techStack: "" });
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const p = await run(() => api<Project>("/projects", { method: "POST", body: f }), "Project created");
    setBusy(false);
    if (p) { onCreated(p); onClose(); }
  }
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <HelpText>A git workspace is created automatically the first time an agent works on it. Leave the stack empty and the agents will choose a sensible one.</HelpText>
        <Field label="Name"><input className="input" required minLength={2} maxLength={120} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. Acme Marketing Site" /></Field>
        <Field label="Type">
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(CATEGORY) as (keyof typeof CATEGORY)[]).map(k => {
              const C = CATEGORY[k];
              return (
                <button type="button" key={k} onClick={() => setF({ ...f, category: k })}
                  className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-xs transition ${f.category === k ? "border-brand/60 bg-brand/10 text-white" : "border-white/10 text-slate-400 hover:border-white/20"}`}>
                  <C.icon size={18} /> {C.text}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="What is it?"><textarea className="input min-h-[90px]" maxLength={5000} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} placeholder="Who it's for and what it should do" /></Field>
        <Field label="Tech stack (optional)" hint="Comma-separated, e.g. Next.js, Tailwind, Prisma"><input className="input" maxLength={300} value={f.techStack} onChange={e => setF({ ...f, techStack: e.target.value })} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button></div>
      </form>
    </Modal>
  );
}

