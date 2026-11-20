export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4200";
const TOKEN_KEY = "devenum_token";

export const tokenStore = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "Cannot reach the backend API. Is it running on port 4200?");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/login")) {
    tokenStore.clear();
    if (typeof window !== "undefined") window.location.href = "/login";
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data as T;
}

/* ---------- Types ---------- */
export type Role = "CEO" | "ADMIN" | "AUDITOR";
export interface User { id: number; name: string; email: string; role: Role }
export interface Manifest { allowedTools: string[]; prohibitedActions: string[]; maxSteps: number; timeoutSeconds: number; [k: string]: unknown }
export interface Agent {
  id: number; slug: string; name: string; roleTitle: string; department: string; modelProvider: string;
  status: string; manifest: Manifest; currentTaskId: number | null; totalRuns: number;
  currentTask: { id: number; title: string; projectId: number } | null;
}
export interface Project {
  id: number; name: string; slug: string; category: string; description: string; techStack: string;
  repoPath: string; gitBranch: string; status: string; progressPercent: number; createdAt: string;
  _count?: { tasks: number };
}
export interface Task {
  id: number; projectId: number; assignedAgentId: number | null; title: string; description: string;
  priority: string; status: string; outputSummary: string | null; executionTimeMs: number | null;
  assignedAgent: { id: number; name: string } | null; project: { id: number; name: string };
}
export interface Proposal {
  id: number; projectId: number; actionType: string; targetResource: string; scopeSummary: string; rationale: string;
  riskLevel: string; rollbackPlan: string; validationPlan: string; status: string; expiresAt: string; createdAt: string;
  project: { id: number; name: string }; task: { id: number; title: string } | null;
  requestingAgent: { id: number; name: string };
  approvals: { decision: string; comment: string | null; decidedAt: string; approver: { name: string } }[];
}
export interface AuditEvent { id: number; actorType: string; actorId: string | null; action: string; target: string | null; details: unknown; createdAt: string }

export const label = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
export const fmtMs = (ms: number | null | undefined) => {
  if (!ms) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const fmtDate = (d: string) => new Date(d).toLocaleString();
