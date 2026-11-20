"use client";
import { useState } from "react";
import { GitBranch, Layers, Plus } from "lucide-react";
import { api, label, Project } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { Badge, ErrorBox, Field, Modal, PageHeader, Progress } from "@/components/ui";

export default function ProjectsPage() {
  const { data, error, reload } = useApi<Project[]>("/projects", 15000);
  const { canWrite, refreshProjects } = useSession();
  const [open, setOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Web, mobile and game builds"
        action={canWrite && <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New project</button>}
      />
      <ErrorBox message={error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map(p => (
          <div key={p.id} className="card p-5">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="font-semibold text-white">{p.name}</div>
              <Badge value={p.status} />
            </div>
            <div className="mb-3 flex gap-2 text-xs">
              <span className="rounded bg-white/10 px-2 py-0.5">{label(p.category)}</span>
              <span className="text-slate-500">{p._count?.tasks ?? 0} tasks</span>
            </div>
            <p className="mb-4 line-clamp-2 text-sm text-slate-400">{p.description || "No description."}</p>
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-400"><Layers size={13} /> {p.techStack || "—"}</div>
            <div className="mb-4 flex items-center gap-2 text-xs text-slate-400"><GitBranch size={13} /> {p.gitBranch}</div>
            <div className="mb-1 flex justify-between text-xs text-slate-400"><span>Progress</span><span>{p.progressPercent}%</span></div>
            <Progress value={p.progressPercent} />
          </div>
        ))}
      </div>
      {open && <CreateProject onClose={() => setOpen(false)} onCreated={() => { setOpen(false); reload(); refreshProjects(); }} />}
    </>
  );
}

function CreateProject({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: "", category: "WEB", description: "", techStack: "", repoPath: "", gitBranch: "main" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/projects", { method: "POST", body: f });
      onCreated();
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Create project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <ErrorBox message={err} />
        <Field label="Name"><input required minLength={2} className="input" value={f.name} onChange={set("name")} /></Field>
        <Field label="Category">
          <select className="input" value={f.category} onChange={set("category")}>
            <option value="WEB">Web</option>
            <option value="MOBILE_APP">Mobile App</option>
            <option value="GAME">Game</option>
          </select>
        </Field>
        <Field label="Description"><textarea className="input h-20" value={f.description} onChange={set("description")} /></Field>
        <Field label="Tech stack"><input className="input" placeholder="Next.js, Node.js, MySQL" value={f.techStack} onChange={set("techStack")} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repo path"><input className="input" value={f.repoPath} onChange={set("repoPath")} /></Field>
          <Field label="Git branch"><input className="input" value={f.gitBranch} onChange={set("gitBranch")} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>Create</button>
        </div>
      </form>
    </Modal>
  );
}
