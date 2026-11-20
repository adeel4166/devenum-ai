"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, ArrowUp, Bot, CheckCircle2, FolderKanban, Inbox, Loader2, MessageSquare, Rocket, Send, Sparkles, Wand2,
} from "lucide-react";
import { Agent, api, AuditEvent, Kpis, Project, Proposal, runJob, timeAgo } from "@/lib/api";
import { humanize, FeedItem } from "@/lib/humanize";
import { Markdown } from "@/lib/markdown";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { AgentAvatar, ErrorBox, Mono, Skeleton, StatCard } from "@/components/ui";

type Mode = "build" | "task" | "ask";
const MODES: { id: Mode; label: string; icon: typeof Rocket; help: string; placeholder: string }[] = [
  { id: "build", label: "Auto-Build Feature/Project", icon: Rocket, help: "Describe a goal. The Project Manager plans 3–5 steps and your agents build them one after another — you approve each step.", placeholder: "e.g. A landing page with a pricing table and a contact form that emails us" },
  { id: "task", label: "Assign Single Task", icon: Send, help: "Send one focused task to a specific agent. It starts within seconds and comes back to your Approval Inbox.", placeholder: "e.g. Add dark-mode support to the navbar" },
  { id: "ask", label: "Quick Ask Assistant", icon: MessageSquare, help: "Get an instant answer from your Executive Assistant — brainstorming, technical questions, specs. Nothing is changed.", placeholder: "e.g. What's the best stack for a multiplayer browser game?" },
];

interface AutoBuildResult { projectId: number; projectName: string; tasks: { id: number; title: string; priority: string; agent: { name: string; slug: string } }[] }

function Hero() {
  const router = useRouter();
  const { projects, refreshProjects, canWrite } = useSession();
  const agents = useApi<Agent[]>("/agents");
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("build");
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [newProject, setNewProject] = useState({ name: "", category: "WEB" });
  const [agentId, setAgentId] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ q: string; a: string } | null>(null);
  const [built, setBuilt] = useState<AutoBuildResult | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const m = MODES.find(x => x.id === mode)!;

  useEffect(() => { if (!projectId && projects[0]) setProjectId(String(projects[0].id)); }, [projects, projectId]);
  useEffect(() => { // auto-grow textarea
    const t = taRef.current; if (!t) return;
    t.style.height = "auto"; t.style.height = `${Math.min(220, t.scrollHeight)}px`;
  }, [text]);

  const creatingProject = projectId === "new";
  const canSubmit = text.trim().length >= (mode === "build" ? 5 : 2) && !busy
    && (mode === "ask" || (canWrite && (creatingProject ? newProject.name.trim().length >= 2 : !!projectId)))
    && (mode !== "task" || !!agentId);

  async function ensureProject(): Promise<number> {
    if (!creatingProject) return Number(projectId);
    setProgress("Creating project workspace…");
    const p = await api<Project>("/projects", { method: "POST", body: { name: newProject.name.trim(), category: newProject.category, description: text.trim().slice(0, 5000) } });
    await refreshProjects();
    setProjectId(String(p.id));
    return p.id;
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setAnswer(null); setBuilt(null);
    try {
      if (mode === "ask") {
        const q = text.trim();
        const r = await runJob<{ reply: string }>("/chat", { message: q, history: [] }, setProgress);
        setAnswer({ q, a: r.reply });
        try { // hand the exchange to the Executive Chat page so the user can continue
          window.localStorage.setItem("devenum_chat_handoff", JSON.stringify([{ role: "user", content: q }, { role: "assistant", content: r.reply }]));
        } catch { /* ignore */ }
        setText("");
      } else if (mode === "build") {
        const pid = await ensureProject();
        const r = await runJob<AutoBuildResult>(`/projects/${pid}/auto-build`, { goal: text.trim() }, setProgress);
        setBuilt(r);
        toast("success", `${r.tasks.length} tasks queued for ${r.projectName}`);
        setText("");
      } else {
        const pid = await ensureProject();
        const t = await api<{ id: number }>("/tasks", { method: "POST", body: {
          projectId: pid, assignedAgentId: Number(agentId), title: text.trim().slice(0, 200), description: text.trim(), priority, status: "READY",
        } });
        toast("success", `Task #${t.id} queued — the agent starts as soon as it's free`);
        setText("");
        router.push(`/projects/${pid}`);
      }
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-gradient-to-b from-ink-800 to-ink-900 px-4 pb-6 pt-8 sm:px-8 sm:pt-10">
      <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[36rem] -translate-x-1/2 rounded-full bg-brand/20 blur-3xl" />
      <div className="relative mx-auto max-w-3xl">
        <div className="mb-1 flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-widest text-brand"><Sparkles size={14} /> Command Center</div>
        <h1 className="text-center text-2xl font-semibold tracking-tight text-white sm:text-3xl">What should your AI software house build or solve today?</h1>

        <div className="mt-5 flex flex-wrap justify-center gap-2" role="tablist">
          {MODES.map(x => (
            <button key={x.id} role="tab" aria-selected={mode === x.id} onClick={() => setMode(x.id)}
              className={`pill ${mode === x.id ? "border-brand/50 bg-brand/15 text-white" : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200"}`}>
              <x.icon size={14} className={mode === x.id ? "text-brand" : ""} /> {x.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-4 rounded-2xl border border-white/10 bg-ink-950/70 p-2 shadow-glow focus-within:border-brand/50">
          <textarea ref={taRef} rows={2} value={text} onChange={e => setText(e.target.value)} placeholder={m.placeholder}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            className="w-full resize-none bg-transparent px-3 py-2 text-[15px] text-slate-100 placeholder:text-slate-500 focus:outline-none" aria-label="Prompt" />
          <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
            {mode !== "ask" && (
              <select className="input !h-8 !w-auto !py-0 text-xs" value={projectId} onChange={e => setProjectId(e.target.value)} aria-label="Project">
                {projects.map(p => <option key={p.id} value={p.id}>📁 {p.name}</option>)}
                <option value="new">＋ New project…</option>
              </select>
            )}
            {mode !== "ask" && creatingProject && (
              <>
                <input className="input !h-8 !w-44 !py-0 text-xs" placeholder="New project name" value={newProject.name} onChange={e => setNewProject({ ...newProject, name: e.target.value })} />
                <select className="input !h-8 !w-auto !py-0 text-xs" value={newProject.category} onChange={e => setNewProject({ ...newProject, category: e.target.value })} aria-label="Project type">
                  <option value="WEB">Web</option><option value="MOBILE_APP">Mobile app</option><option value="GAME">Game</option>
                </select>
              </>
            )}
            {mode === "task" && (
              <>
                <select className="input !h-8 !w-auto !py-0 text-xs" value={agentId} onChange={e => setAgentId(e.target.value)} aria-label="Agent">
                  <option value="">Choose agent…</option>
                  {agents.data?.filter(a => a.status !== "DISABLED").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select className="input !h-8 !w-auto !py-0 text-xs" value={priority} onChange={e => setPriority(e.target.value)} aria-label="Priority">
                  {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(p => <option key={p}>{p}</option>)}
                </select>
              </>
            )}
            <button type="submit" disabled={!canSubmit} className="ml-auto grid h-9 w-9 place-items-center rounded-xl bg-brand text-white transition hover:bg-brand-soft disabled:opacity-40" aria-label="Submit">
              {busy ? <Loader2 size={17} className="animate-spin" /> : <ArrowUp size={18} />}
            </button>
          </div>
        </form>
        <p className="mt-2 text-center text-xs text-slate-500">{progress ? <span className="inline-flex items-center gap-1.5 text-slate-300"><Loader2 size={12} className="animate-spin" />{progress}</span> : m.help}</p>
        {!canWrite && mode !== "ask" && <p className="mt-1 text-center text-xs text-amber-300">Your role is read-only — you can use Quick Ask, but not start work.</p>}

        {answer && (
          <div className="fade-up mt-5 rounded-2xl border border-white/10 bg-ink-950/60 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs text-slate-400"><AgentAvatar slug="executive-assistant" size={22} /> Executive Assistant</div>
            <Markdown text={answer.a} />
            <div className="mt-3 flex justify-end"><Link href="/chat?continue=1" className="btn-ghost text-xs">Continue in Executive Chat <ArrowRight size={13} /></Link></div>
          </div>
        )}
        {built && (
          <div className="fade-up mt-5 rounded-2xl border border-brand/30 bg-brand/[0.06] p-4">
            <div className="mb-3 flex items-center gap-2 font-medium text-white"><Wand2 size={16} className="text-brand" /> Pipeline queued for {built.projectName}</div>
            <ol className="space-y-2">
              {built.tasks.map((t, i) => (
                <li key={t.id} className="flex items-center gap-3 text-sm">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/10 text-xs">{i + 1}</span>
                  <AgentAvatar slug={t.agent.slug} size={24} />
                  <span className="min-w-0 flex-1 truncate text-slate-200">{t.title}</span>
                  <Mono>#{t.id}</Mono>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-slate-400">Step 1 starts now. Each next step starts automatically after you approve and merge the previous one.</p>
            <div className="mt-3 flex justify-end"><Link href={`/projects/${built.projectId}`} className="btn-primary text-xs">Open project pipeline <ArrowRight size={13} /></Link></div>
          </div>
        )}
      </div>
    </section>
  );
}

const TONE_DOT: Record<FeedItem["tone"], string> = {
  agent: "bg-sky-400", ceo: "bg-brand", system: "bg-slate-500", success: "bg-emerald-400", danger: "bg-rose-400", warning: "bg-amber-400",
};

function ActivityFeed() {
  const { data, error, loading } = useApi<AuditEvent[]>("/system/activity?limit=40", 5000);
  const items = useMemo(() => (data ?? []).map(humanize), [data]);
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-white">Live agency activity</h2>
          <p className="text-xs text-slate-500">What your agents and you have been doing — refreshes every 5 seconds.</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-emerald-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live</span>
      </div>
      <ErrorBox message={error} />
      {loading && !data ? <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div> : !items.length ? (
        <p className="py-8 text-center text-sm text-slate-500">No activity yet. Start something with the prompt bar above.</p>
      ) : (
        <ol className="relative space-y-4 border-l border-white/10 pl-5">
          {items.map(it => {
            const body = (
              <>
                <span className={`absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-ink-800 ${TONE_DOT[it.tone]}`} />
                <div className="text-sm text-slate-200">{it.text}</div>
                <div className="mt-0.5 text-xs text-slate-500">{it.detail ? <span className="text-slate-400">{it.detail} · </span> : null}{timeAgo(it.at)}</div>
              </>
            );
            return <li key={it.id} className="relative">{it.href ? <Link href={it.href} className="block rounded hover:opacity-90">{body}</Link> : body}</li>;
          })}
        </ol>
      )}
    </section>
  );
}

function SidePanels() {
  const agents = useApi<Agent[]>("/agents", 5000);
  const pending = useApi<Proposal[]>("/approvals?status=PENDING", 8000);
  const working = (agents.data ?? []).filter(a => a.status === "RUNNING");
  return (
    <div className="space-y-6">
      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-white">Agents working now</h2>
          <Link href="/agents" className="text-xs text-brand-soft hover:underline">AI Team →</Link>
        </div>
        {agents.loading && !agents.data ? <Skeleton className="h-16" /> : !working.length ? (
          <p className="text-sm text-slate-500">Everyone is idle. Assign a task or launch an auto-build to put the team to work.</p>
        ) : (
          <ul className="space-y-3">
            {working.map(a => (
              <li key={a.id} className="flex items-center gap-3">
                <AgentAvatar slug={a.slug} size={32} working />
                <div className="min-w-0">
                  <div className="text-sm text-slate-200">{a.name}</div>
                  <div className="truncate text-xs text-slate-500">{a.currentTask ? `Working on “${a.currentTask.title}”` : "Working"}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-white">Waiting for your approval</h2>
          <Link href="/approvals" className="text-xs text-brand-soft hover:underline">Inbox →</Link>
        </div>
        {pending.loading && !pending.data ? <Skeleton className="h-16" /> : !pending.data?.length ? (
          <p className="flex items-center gap-2 text-sm text-slate-500"><CheckCircle2 size={15} className="text-emerald-400" /> Inbox zero — nothing needs your decision.</p>
        ) : (
          <ul className="space-y-2">
            {pending.data.slice(0, 5).map(p => (
              <li key={p.id}>
                <Link href={`/approvals?open=${p.id}`} className="block rounded-xl border border-white/5 bg-black/20 p-3 transition hover:border-brand/40">
                  <div className="flex items-center gap-2">
                    <AgentAvatar slug={p.requestingAgent.slug} size={22} />
                    <span className="truncate text-sm text-slate-200">{p.task?.title ?? p.actionType}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    {p.branchName && <Mono>{p.branchName}</Mono>}<span>{p.riskLevel.toLowerCase()} risk · {timeAgo(p.createdAt)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function CommandCenter() {
  const router = useRouter();
  const { data, loading } = useApi<{ kpis: Kpis }>("/system/dashboard", 5000);
  const k = data?.kpis;
  return (
    <div className="space-y-6">
      <Hero />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading && !k ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />) : (
          <>
            <StatCard label="Active projects" value={k?.activeProjects ?? 0} hint="Planning, building or in review" icon={FolderKanban} accent="bg-violet-500/15 text-violet-300" onClick={() => router.push("/projects")} />
            <StatCard label="Agents working now" value={k?.runningAgents ?? 0} hint={`${k?.idleAgents ?? 0} of ${k?.totalAgents ?? 0} available`} icon={Bot} accent="bg-sky-500/15 text-sky-300" pulse={!!k?.runningAgents} onClick={() => router.push("/agents")} />
            <StatCard label="Pending approvals" value={k?.pendingApprovals ?? 0} hint={k?.pendingApprovals ? "Click to review →" : "Nothing waiting"} icon={Inbox} accent="bg-brand/15 text-brand" onClick={() => router.push("/approvals")} />
            <StatCard label="Completed runs" value={k?.completedRuns ?? 0} hint="Agent runs that finished successfully" icon={CheckCircle2} accent="bg-emerald-500/15 text-emerald-300" />
          </>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2"><ActivityFeed /></div>
        <SidePanels />
      </div>
    </div>
  );
}
