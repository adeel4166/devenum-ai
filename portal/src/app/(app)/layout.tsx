"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bot, CheckSquare, FolderKanban, Inbox, LogOut, Menu, MessageSquare, OctagonAlert, Play, ScrollText, Settings, Sparkles, X, Zap,
} from "lucide-react";
import { SessionProvider, useSession } from "@/lib/session";
import { ToastProvider, useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";

const NAV = [
  { href: "/", label: "Command Center", icon: Zap, hint: "Start work & watch the agency" },
  { href: "/projects", label: "Projects", icon: FolderKanban, hint: "Workspaces, pipelines, previews" },
  { href: "/approvals", label: "Approval Inbox", icon: Inbox, hint: "Review & merge agent work" },
  { href: "/agents", label: "AI Team", icon: Bot, hint: "Your 11 specialist agents" },
  { href: "/chat", label: "Executive Chat", icon: MessageSquare, hint: "Brainstorm with your assistant" },
  { href: "/tasks", label: "Task Board", icon: CheckSquare, hint: "Every task across projects" },
  { href: "/logs", label: "Activity & Logs", icon: ScrollText, hint: "Runs and audit trail" },
  { href: "/settings", label: "Settings", icon: Settings, hint: "Controls, health & team" },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const { user, logout } = useSession();
  const dash = useApi<{ kpis: { pendingApprovals: number; runningAgents: number } }>("/system/dashboard", 10000);
  return (
    <div className="flex h-full flex-col">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-3 px-5 py-5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-amberx shadow-glow">
          <Sparkles size={18} className="text-white" />
        </div>
        <div className="leading-tight">
          <div className="font-semibold tracking-tight text-white">Devenum AI</div>
          <div className="text-[11px] text-slate-500">Virtual Software House</div>
        </div>
      </Link>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
        {NAV.map(n => {
          const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
          const count = n.href === "/approvals" ? dash.data?.kpis.pendingApprovals : n.href === "/agents" ? dash.data?.kpis.runningAgents : 0;
          return (
            <Link key={n.href} href={n.href} onClick={onNavigate} title={n.hint}
              className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${active ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"}`}>
              <n.icon size={17} className={active ? "text-brand" : ""} />
              <span className="flex-1">{n.label}</span>
              {!!count && (
                <span className={`rounded-full px-1.5 text-[10px] font-bold ${n.href === "/approvals" ? "bg-brand text-white" : "bg-sky-500/20 text-sky-300"}`}>{count}</span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="m-3 rounded-xl border border-white/5 bg-black/20 p-3">
        <div className="truncate text-sm text-white">{user?.name}</div>
        <div className="mb-2 text-xs text-slate-500">{user?.role} · {user?.email}</div>
        <button onClick={logout} className="btn-ghost w-full !py-1 text-xs"><LogOut size={13} /> Sign out</button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { canWrite } = useSession();
  const status = useApi<{ globalPaused: boolean }>("/system/status", 8000);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const paused = status.data?.globalPaused ?? false;
  const current = NAV.find(n => (n.href === "/" ? path === "/" : path.startsWith(n.href)));

  useEffect(() => setMobileOpen(false), [path]);

  async function togglePause() {
    const msg = paused ? "Resume the agency? Paused agents go back to work." : "Pause the whole agency? Running agent jobs are cancelled and re-queued.";
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await api(paused ? "/system/resume-all" : "/system/pause-all", { method: "POST" });
      toast("success", paused ? "Agency resumed" : "Agency paused");
      status.reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-white/[0.06] bg-ink-900 lg:block"><Sidebar /></aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden" onMouseDown={() => setMobileOpen(false)}>
          <aside className="slide-in-left h-full w-72 max-w-[85vw] border-r border-white/10 bg-ink-900 shadow-2xl" onMouseDown={e => e.stopPropagation()}>
            <button className="absolute left-[min(17rem,80vw)] top-4 rounded-lg p-1.5 text-slate-300 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={18} /></button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/[0.06] bg-ink-950/85 px-4 py-2.5 backdrop-blur md:px-8">
          <button className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-white">{current?.label ?? "Devenum AI"}</div>
            <div className="hidden truncate text-xs text-slate-500 sm:block">{current?.hint}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs sm:inline-flex ${paused ? "border-rose-500/30 bg-rose-500/10 text-rose-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-rose-400" : "animate-pulse bg-emerald-400"}`} />
              {paused ? "Agency paused" : "Agency active"}
            </span>
            {canWrite && (
              <button onClick={togglePause} disabled={busy} className={paused ? "btn-success !py-1 text-xs" : "btn-ghost !py-1 text-xs hover:!border-rose-500/40 hover:!text-rose-300"}>
                {paused ? <Play size={13} /> : <OctagonAlert size={13} />}
                <span className="hidden sm:inline">{paused ? "Resume agency" : "Pause all"}</span>
              </button>
            )}
          </div>
        </header>
        {paused && (
          <div className="border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-center text-xs text-rose-200 md:px-8">
            The agency is paused — no new tasks will start until you resume it.
          </div>
        )}
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider><ToastProvider>
      <Shell>{children}</Shell>
    </ToastProvider></SessionProvider>
  );
}
