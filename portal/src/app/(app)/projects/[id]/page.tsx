"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, CircleDashed, FolderGit2, Github, Layers, ListChecks, Plus, Radio, RefreshCw, Rocket, Wand2 } from "lucide-react";
import { api, label, ProjectDetail, runJob, Task, timeAgo } from "@/lib/api";
import { FileExplorer } from "@/components/FileExplorer";
import { EnvEditor } from "@/components/EnvEditor";
import { LiveRunDrawer } from "@/components/LiveRun";
import { ProposalReview } from "@/components/ProposalReview";
import { DecisionsPanel } from "@/components/Decisions";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { TaskDrawer } from "@/components/TaskDrawer";
import { AssignTaskModal } from "@/components/AssignTaskModal";
import { ProjectActions } from "@/components/ProjectActions";
import { AgentAvatar, Badge, EmptyState, ErrorBox, Field, HelpText, Modal, Mono, Progress, QaBadge, RISK_TONE, Skeleton, Tabs } from "@/components/ui";

const STATUSES = ["PLANNING", "IN_PROGRESS", "REVIEW", "COMPLETED", "FROZEN"];
const COLUMNS: { status: string; title: string; hint: string; tone: string }[] = [
  { status: "READY", title: "Ready", hint: "Queued — starts when the agent is free", tone: "border-t-indigo-400" },
  { status: "IN_PROGRESS", title: "In progress", hint: "An agent is working, or merging after approval", tone: "border-t-sky-400" },
  { status: "AWAITING_APPROVAL", title: "Awaiting approval", hint: "Done — waiting for your review", tone: "border-t-brand" },
  { status: "DONE", title: "Done", hint: "Approved & merged into main", tone: "border-t-emerald-400" },
];

function TaskCard({ t, onOpen, blockedBy, onWatch, onRetry }: { t: Task; onOpen: () => void; blockedBy?: number[]; onWatch?: () => void; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-ink-900/80 transition hover:border-brand/40">
    <button onClick={onOpen} className="w-full p-3 text-left">
      <div className="flex items-start gap-2">
        <AgentAvatar slug={t.assignedAgent?.slug} size={24} working={t.status === "IN_PROGRESS" && t.assignedAgent?.status === "RUNNING"} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm text-slate-100">{t.title}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            <Mono>task/{t.id}</Mono>
            {t.priority !== "MEDIUM" && <Badge value={t.priority} />}
            {t.parentTaskId && <span className="text-amber-300">revision of #{t.parentTaskId}</span>}
          </div>
          {!!blockedBy?.length && <div className="mt-1 text-[11px] text-slate-500">waits for {blockedBy.map(d => `#${d}`).join(", ")}</div>}
        </div>
      </div>
    </button>
    {(onWatch || onRetry) && (
      <div className="flex gap-1.5 border-t border-white/5 px-3 py-2">
        {onWatch && <button onClick={onWatch} className="btn-soft !px-2 !py-0.5 text-[11px] text-sky-300"><Radio size={11} className="animate-pulse" /> Watch live</button>}
        {onRetry && <button onClick={onRetry} className="btn-soft !px-2 !py-0.5 text-[11px] text-orange-300"><RefreshCw size={11} /> Retry</button>}
      </div>
    )}
    </div>
  );
}

function Pipeline({ p, onOpen, onWatch, onRetry }: { p: ProjectDetail; onOpen: (id: number) => void; onWatch: (id: number) => void; onRetry?: (id: number) => void }) {
  const byStatus = (s: string) => p.tasks.filter(t => t.status === s);
  const done = new Set(p.tasks.filter(t => t.status === "DONE").map(t => t.id));
  const other = p.tasks.filter(t => !COLUMNS.some(c => c.status === t.status));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map(c => {
          const tasks = byStatus(c.status);
          return (
            <div key={c.status} className={`rounded-2xl border border-white/[0.06] border-t-2 bg-ink-800/60 p-3 ${c.tone}`}>
              <div className="mb-1 flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold text-white">{c.title}</h3>
                <span className="rounded-full bg-white/10 px-2 text-xs text-slate-300">{tasks.length}</span>
              </div>
              <p className="mb-3 px-1 text-[11px] text-slate-500">{c.hint}</p>
              <div className="space-y-2">
                {tasks.length ? tasks.map(t => (
                  <TaskCard key={t.id} t={t} onOpen={() => onOpen(t.id)} blockedBy={c.status === "READY" ? (t.dependencies ?? []).filter(d => !done.has(d)) : undefined}
                    onWatch={c.status === "IN_PROGRESS" || c.status === "AWAITING_APPROVAL" ? () => onWatch(t.id) : undefined} />
                )) : <div className="rounded-xl border border-dashed border-white/10 py-6 text-center text-xs text-slate-600">Empty</div>}
              </div>
            </div>
          );
        })}
      </div>
      {!!other.length && (
        <div className="card p-4">
          <h3 className="mb-1 text-sm font-semibold text-white">Needs attention · backlog · blocked</h3>
          <p className="mb-3 text-xs text-slate-500">&quot;Needs retry&quot; tasks were stopped by the watchdog after a timeout (partial work is kept on their branch). Blocked tasks failed or were sent back. Click Retry to queue them again.</p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {other.map(t => <div key={t.id} className="relative"><TaskCard t={t} onOpen={() => onOpen(t.id)} onWatch={t.status === "NEEDS_RETRY" ? () => onWatch(t.id) : undefined}
              onRetry={onRetry && ["NEEDS_RETRY", "BLOCKED", "BACKLOG"].includes(t.status) ? () => onRetry(t.id) : undefined} /><span className="absolute right-2 top-2"><Badge value={t.status} /></span></div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function AutoBuildModal({ p, onClose, onDone }: { p: ProjectDetail; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await runJob<{ tasks: unknown[] }>(`/projects/${p.id}/auto-build`, { goal: goal.trim() }, setProgress);
      toast("success", `${r.tasks.length} sequential tasks queued`);
      onDone(); onClose();
    } catch (err) { toast("error", (err as Error).message); } finally { setBusy(false); setProgress(null); }
  }
  return (
    <Modal title={`Auto-build in ${p.name}`} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <HelpText>The Project Manager splits your goal into 3–5 ordered steps for the right specialists (e.g. Architect → Frontend → QA). They run one at a time; each step starts after you approve the previous one.</HelpText>
        <Field label="Goal"><textarea autoFocus required minLength={5} maxLength={3000} className="input min-h-[120px]" value={goal} onChange={e => setGoal(e.target.value)} placeholder="e.g. User sign-up and login with email verification" /></Field>
        {progress && <p className="text-xs text-slate-400">{progress}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button><button className="btn-primary" disabled={busy || goal.trim().length < 5}><Wand2 size={15} /> {busy ? "Planning…" : "Plan & queue"}</button></div>
      </form>
    </Modal>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useApi<ProjectDetail>(`/projects/${id}`, 5000);
  const { canWrite, refreshProjects } = useSession();
  const { run } = useToast();
  const [tab, setTab] = useState<"pipeline" | "files" | "env" | "proposals" | "decisions" | "details">("pipeline");
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [watch, setWatch] = useState<number | null>(null);
  const [review, setReview] = useState<number | null>(null);
  const [assign, setAssign] = useState(false);
  const [autoBuild, setAutoBuild] = useState(false);

  async function patch(body: object, msg: string) {
    if (await run(() => api(`/projects/${id}`, { method: "PATCH", body }), msg)) { reload(); refreshProjects(); }
  }

  async function freeze(frozen: boolean) {
    if (frozen && !window.confirm(`Freeze ${p!.name}? Running agent jobs on it are cancelled and re-queued, no new tasks start, and approved merges are held.`)) return;
    if (await run(() => api(`/projects/${id}/freeze`, { method: "POST", body: { frozen } }), frozen ? "Project frozen" : "Project unfrozen")) { reload(); refreshProjects(); }
  }

  async function retry(taskId: number) {
    if (await run(() => api(`/tasks/${taskId}/retry`, { method: "POST" }), `Task #${taskId} re-queued`)) reload();
  }

  if (error && !p) return <ErrorBox message={error} />;
  if (!p) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-72" /></div>;
  const total = p.tasks.length, done = p.tasks.filter(t => t.status === "DONE").length;
  const pending = p.proposals.filter(x => x.status === "PENDING");

  return (
    <>
      <Link href="/projects" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white"><ArrowLeft size={15} /> All projects</Link>
      <div className="card mb-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400"><span className="rounded bg-white/10 px-2 py-0.5">{label(p.category)}</span><Mono>#{p.id}</Mono><Mono title="Git workspace"><FolderGit2 size={11} />{p.repoPath}</Mono></div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">{p.name}</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">{p.description || "No description"}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="flex items-center gap-1.5"><Layers size={13} /> {p.techStack || "Stack chosen by agents"}</span>
              {p.githubRepoUrl && <a href={p.githubRepoUrl} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1.5 hover:text-white"><Github size={13} /> {p.githubRepoUrl.replace("https://github.com/", "")}</a>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <button onClick={() => freeze(!p.isFrozen)} title={p.isFrozen ? "Resume agent work and merges on this project" : "Emergency stop: agents stop working on this project (running jobs are cancelled) and approved merges are held"}
              className={`btn !py-1.5 text-xs ${p.isFrozen ? "border border-sky-400/40 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25" : "btn-ghost"}`}>
              {p.isFrozen ? "❄️ Frozen — Unfreeze" : "❄️ Freeze project"}
            </button>
          )}
          {canWrite ? (
            <select className="input !w-auto" value={p.status} onChange={e => patch({ status: e.target.value }, `Status set to ${label(e.target.value)}`)} aria-label="Project status">
              {STATUSES.map(s => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          ) : <Badge value={p.status} />}
          </div>
        </div>
        {p.isFrozen && <p className="mt-3 rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">❄️ This project is frozen: agents will not start tasks here, running jobs were stopped and re-queued, and approved merges are held until you unfreeze it.</p>}
        <div className="mt-4 max-w-xl">
          <div className="mb-1.5 flex justify-between text-xs text-slate-400"><span>{done}/{total} tasks merged</span><span>{total ? Math.round((done / total) * 100) : 0}%</span></div>
          <Progress value={total ? (done / total) * 100 : 0} />
        </div>
        <div className="mt-5 border-t border-white/5 pt-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Workspace actions</div>
          <ProjectActions project={p} onChanged={reload} />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto">
          <Tabs value={tab} onChange={setTab} tabs={[
            { id: "pipeline", label: "Pipeline & Tasks", count: total },
            { id: "files", label: "Files & Code" },
            { id: "env", label: "Environment (.env)" },
            { id: "proposals", label: "Approvals & QA", count: pending.length || undefined },
            { id: "decisions", label: "Decisions / Knowledge" },
            { id: "details", label: "Details" },
          ]} />
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setAssign(true)}><Plus size={15} /> Assign task</button>
            <button className="btn-primary" onClick={() => setAutoBuild(true)}><Rocket size={15} /> Auto-build</button>
          </div>
        )}
      </div>

      {tab === "pipeline" && (total ? <Pipeline p={p} onOpen={setOpenTask} onWatch={setWatch} onRetry={canWrite ? retry : undefined} /> : (
        <EmptyState icon={ListChecks} title="No tasks yet" text="Launch an auto-build with a goal, or assign a single task to one of your agents."
          action={canWrite && <div className="flex gap-2"><button className="btn-ghost" onClick={() => setAssign(true)}><Plus size={15} /> Assign task</button><button className="btn-primary" onClick={() => setAutoBuild(true)}><Rocket size={15} /> Auto-build</button></div>} />
      ))}

      {tab === "decisions" && <DecisionsPanel projectId={p.id} projectName={p.name} />}
      {tab === "files" && <FileExplorer projectId={p.id} workspaceExists={p.workspaceExists !== false} />}
      {tab === "env" && (canWrite ? <EnvEditor projectId={p.id} workspaceExists={p.workspaceExists !== false} /> : <div className="card p-8 text-center text-sm text-slate-400">Only the CEO and admins can view environment variables.</div>)}

      {tab === "proposals" && (p.proposals.length ? (
        <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <ul className={`space-y-2 ${review ? "hidden lg:block" : ""}`}>
            {p.proposals.map(x => (
              <li key={x.id}>
                <button onClick={() => setReview(x.id)} className={`w-full rounded-2xl border p-3 text-left transition ${review === x.id ? "border-brand/50 bg-brand/[0.08]" : "border-white/[0.06] bg-ink-800/70 hover:border-white/15"}`}>
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar slug={x.requestingAgent.slug} size={28} />
                    <div className="min-w-0 flex-1"><div className="truncate text-sm text-slate-100">{x.task?.title ?? x.actionType}</div><div className="text-xs text-slate-500">#{x.id} · {x.requestingAgent.name} · {timeAgo(x.createdAt)}</div></div>
                    <Badge value={x.mergeStatus === "MERGED" ? "DONE" : x.status} text={x.mergeStatus === "MERGED" ? "Merged" : undefined} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={`rounded-full border px-2 py-0.5 ${RISK_TONE[x.riskLevel] ?? ""}`}>{x.riskLevel}</span>
                    <QaBadge qa={x.qaReport} compact />
                    {x.branchName && <Mono>{x.branchName}</Mono>}
                    {!!x.changedFiles?.length && <span className="text-slate-500">{x.changedFiles.length} files</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className={review ? "" : "hidden lg:block"}>
            {(() => { const cur = p.proposals.find(x => x.id === review) ?? (typeof window !== "undefined" && window.innerWidth >= 1024 ? p.proposals.find(x => x.status === "PENDING") ?? p.proposals[0] : undefined);
              return cur ? <ProposalReview key={cur.id} p={{ ...cur, project: { id: p.id, name: p.name } }} onDecided={reload} onBack={() => setReview(null)} /> : <div className="card grid h-64 place-items-center text-sm text-slate-500">Select a proposal to review it</div>; })()}
          </div>
        </div>
      ) : <EmptyState icon={CircleDashed} title="No proposals yet" text="When an agent finishes a task it runs the automated QA gate and submits a proposal here and in the Approval Inbox." />)}

      {tab === "details" && (
        <div className="card grid gap-4 p-5 text-sm sm:grid-cols-2">
          {[["Slug", p.slug], ["Workspace", p.repoPath], ["Main branch", p.gitBranch], ["Created", new Date(p.createdAt).toLocaleString()], ["Tech stack", p.techStack || "—"], ["GitHub", p.githubRepoUrl || "Not pushed yet"]].map(([k, v]) => (
            <div key={k}><div className="label">{k}</div><div className="break-all font-mono text-[13px] text-slate-200">{v}</div></div>
          ))}
          <div className="sm:col-span-2"><div className="label">Agents involved</div>
            <div className="flex flex-wrap gap-2">{p.agents.length ? p.agents.map(a => <span key={a.id} className="flex items-center gap-2 rounded-full bg-white/5 py-1 pl-1 pr-3 text-xs"><AgentAvatar slug={a.slug} size={20} />{a.name}</span>) : <span className="text-slate-500">None yet</span>}</div>
          </div>
        </div>
      )}

      {watch && <LiveRunDrawer taskId={watch} onClose={() => setWatch(null)} />}
      {openTask && <TaskDrawer taskId={openTask} onClose={() => setOpenTask(null)} onChanged={reload} />}
      {assign && <AssignTaskModal projectId={p.id} onClose={() => setAssign(false)} onCreated={() => reload()} />}
      {autoBuild && <AutoBuildModal p={p} onClose={() => setAutoBuild(false)} onDone={reload} />}
    </>
  );
}
