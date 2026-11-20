"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, tokenStore, User, Project } from "./api";

interface Ctx {
  user: User | null;
  canWrite: boolean;
  isCeo: boolean;
  projects: Project[];
  projectId: number | null; // null = all projects
  setProjectId: (id: number | null) => void;
  refreshProjects: () => Promise<void>;
  logout: () => void;
}
const SessionCtx = createContext<Ctx>(null as never);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setPid] = useState<number | null>(null);

  const refreshProjects = useCallback(async () => {
    setProjects(await api<Project[]>("/projects"));
  }, []);

  useEffect(() => {
    if (!tokenStore.get()) { router.replace("/login"); return; }
    api<{ user: User }>("/auth/me").then(r => setUser(r.user)).catch(() => router.replace("/login"));
    refreshProjects().catch(() => {});
    try {
      const saved = window.localStorage.getItem("devenum_project");
      if (saved) setPid(Number(saved));
    } catch { /* ignore */ }
  }, [router, refreshProjects]);

  const setProjectId = (id: number | null) => {
    setPid(id);
    try { id == null ? window.localStorage.removeItem("devenum_project") : window.localStorage.setItem("devenum_project", String(id)); } catch { /* ignore */ }
  };
  const logout = () => { tokenStore.clear(); router.replace("/login"); };

  if (!user) return <div className="grid min-h-screen place-items-center text-sm text-slate-500">Loading command center…</div>;
  return (
    <SessionCtx.Provider value={{
      user, canWrite: user.role !== "AUDITOR", isCeo: user.role === "CEO",
      projects, projectId, setProjectId, refreshProjects, logout,
    }}>{children}</SessionCtx.Provider>
  );
}
