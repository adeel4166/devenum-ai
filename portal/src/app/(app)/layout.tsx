"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Activity, Bot, CheckSquare, FolderKanban, LayoutDashboard, LogOut, OctagonAlert, Play, ScrollText, Settings, ShieldCheck } from "lucide-react";
import { SessionProvider, useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/tasks", label: "Task Board", icon: CheckSquare },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/logs", label: "Logs & Audit", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { user, canWrite, projects, projectId, setProjectId, logout } = useSession();
  const status = useApi<{ globalPaused: boolean }>("/system/status", 10000);
  const pending = useApi<{ kpis: { pendingApprovals: number } }>("/system/dashboard", 15000);
  const [busy, setBusy] = useState(false);
  const paused = status.data?.globalPaused ?? false;

  async function togglePause() {
    const msg = paused ? "Resume all paused agents?" : "EMERGENCY: pause ALL agents immediately?";
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await api(paused ? "/system/resume-all" : "/system/pause-all", { method: "POST" });
      window.location.reload();
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/5 bg-ink-900 md:flex">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand">
            <Activity size={18} className="text-white" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold text-white">Devenum AI</div>
            <div className="text-[11px] text-slate-500">Command Center</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(n => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
            const count = n.href === "/approvals" ? pending.data?.kpis.pendingApprovals : 0;
            return (
              <Link key={n.href} href={n.href} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${active ? "bg-brand/15 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}>
                <n.icon size={17} /> <span className="flex-1">{n.label}</span>
                {!!count && <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-black">{count}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/5 p-4">
          <div className="truncate text-sm text-white">{user?.name}</div>
          <div className="mb-3 text-xs text-slate-500">{user?.role}</div>
          <button onClick={logout} className="btn-ghost w-full"><LogOut size={14} /> Sign out</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-white/5 bg-ink-950/90 px-4 py-3 backdrop-blur md:px-8">
          <select className="input !w-auto min-w-[14rem]" value={projectId ?? ""} onChange={e => setProjectId(e.target.value ? Number(e.target.value) : null)} aria-label="Project switcher">
            <option value="">All projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <nav className="flex gap-1 md:hidden">
            {NAV.map(n => <Link key={n.href} href={n.href} aria-label={n.label} className="rounded p-2 text-slate-400 hover:bg-white/5"><n.icon size={16} /></Link>)}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {paused && <span className="text-xs font-medium text-rose-300">All agents paused</span>}
            {canWrite && (
              <button onClick={togglePause} disabled={busy} className={paused ? "btn-primary" : "btn-danger"}>
                {paused ? <Play size={15} /> : <OctagonAlert size={15} />}
                {paused ? "Resume All Agents" : "Pause All Agents"}
              </button>
            )}
          </div>
        </header>
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
