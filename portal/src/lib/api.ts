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
  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/change-password")) {
    tokenStore.clear();
    if (typeof window !== "undefined") window.location.href = "/login";
  }
  if (!res.ok) {
    const issue = Array.isArray(data.issues) ? data.issues[0]?.message : null;
    throw new ApiError(res.status, issue || data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

/* ---------- Types ---------- */
export type Role = "CEO" | "ADMIN" | "AUDITOR";
export interface User { id: number; name: string; email: string; role: Role }
export interface TeamUser extends User { isActive: boolean; createdAt: string }
export interface Manifest { allowedTools: string[]; prohibitedActions: string[]; maxSteps: number; timeoutSeconds: number; [k: string]: unknown }

export interface RunLite {
  id: number; status: string; queuedMs: number; executionMs: number; logs: string; errorMessage: string | null;
  startedAt: string; finishedAt: string | null;
  task?: { id: number; title: string } | null; agent?: { name: string; slug?: string };
}
export interface Agent {
  id: number; slug: string; name: string; roleTitle: string; department: string; modelProvider: string;
  status: string; manifest: Manifest; currentTaskId: number | null; totalRuns: number;
  currentTask: { id: number; title: string; projectId: number } | null;
  runs?: RunLite[];
}
export interface PreviewInfo { projectId: number; slug: string; port: number; url: string; kind: string; startedAt: string; projectName?: string }
export interface Project {
  id: number; name: string; slug: string; category: string; description: string; techStack: string;
  repoPath: string; gitBranch: string; status: string; progressPercent: number; createdAt: string;
  githubRepoUrl?: string | null;
  _count?: { tasks: number };
  taskCounts?: Record<string, number>; lastActivityAt?: string; preview?: PreviewInfo | null;
  isFrozen?: boolean; discordChannelId?: string | null;
  workspaceExists?: boolean; livePort?: number | null; liveUrl?: string | null; liveDeployedAt?: string | null;
  live?: { status: string; restarts: number; cpu: number; memory: number } | null;
}
export interface AgentLite { id: number; name: string; slug: string; status: string; modelProvider?: string }
export interface Task {
  id: number; projectId: number; assignedAgentId: number | null; title: string; description: string;
  priority: string; status: string; outputSummary: string | null; executionTimeMs: number | null; createdAt: string;
  parentTaskId?: number | null; dependencies?: number[] | null;
  queuedAt?: string | null; startedAt?: string | null; completedAt?: string | null; approvedAt?: string | null;
  assignedAgent: AgentLite | null; project: { id: number; name: string };
  runs?: RunLite[];
}
export interface Proposal {
  id: number; projectId: number; actionType: string; targetResource: string; scopeSummary: string; rationale: string;
  riskLevel: string; rollbackPlan: string; validationPlan: string; status: string; expiresAt: string; createdAt: string;
  project?: { id: number; name: string }; task: { id: number; title: string } | null;
  requestingAgent: { id: number; name: string; slug?: string; roleTitle?: string; modelProvider?: string };
  branchName?: string | null; changedFiles?: string[] | null; qaReport?: QaReport | null;
  payloadHash?: string | null; headCommit?: string | null; approvedAt?: string | null;
  mergeStatus?: "MERGED" | "FAILED" | null; mergeCommit?: string | null; mergeError?: string | null; mergedAt?: string | null;
  approvals?: { decision: string; comment: string | null; decidedAt: string; approver: { name: string } }[];
}
export interface ProjectDetail extends Project {
  tasks: Task[]; proposals: Proposal[]; agents: AgentLite[];
}
export interface QaFinding { severity: "HIGH" | "MEDIUM" | "LOW"; check: string; message: string; file?: string }
export interface QaReport { status: "PASSED" | "WARNINGS"; score: number; findings: QaFinding[]; checks: { name: string; status: string; detail: string; ms: number }[]; ranAt: string }
export interface ServiceInfo { name: string; status: string; pid: number; cpu: number; memory: number; restarts: number; uptimeSince: number | null; kind: "core" | "live" }
export interface VpsMetrics { cpu: { percent: number; cores: number; load: number[] }; memory: { total: number; used: number; percent: number }; disk: { total: number; used: number; avail: number; percent: number }; uptimeSec: number; hostname: string }
export interface BackupInfo { name: string; bytes: number; createdAt: string; downloadPath: string }
export const fmtBytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export interface Decision { id: number; projectId: number; title: string; decision: string; rationale: string | null; pinnedBy: string; createdAt: string }
export interface ReportRow { id: number; kind: string; title: string; body?: string; generatedBy: string; postedAt: string | null; createdAt: string; data: Record<string, unknown> }
export interface Job<T> { id: string; kind: string; status: "running" | "succeeded" | "failed"; progress: string | null; result: T | null; error: string | null }
export interface Health {
  backend: { ok: boolean; uptimeSec: number }; database: { ok: boolean };
  worker: { ok: boolean; lastSeen: string | null; info: { activeRuns?: number; paused?: boolean } | null };
  bot: { ok: boolean; lastSeen: string | null; info: { user?: string } | null };
  github: { configured: boolean }; previews: PreviewInfo[];
  vps: VpsMetrics | null; services: ServiceInfo[];
}
export interface Kpis { activeProjects: number; runningAgents: number; idleAgents: number; pendingApprovals: number; totalAgents: number; completedRuns: number }

/**
 * Long operations (auto-build, preview start, GitHub push, chat) run as backend jobs so they never hit the
 * proxy timeout. POST returns { jobId }; this polls until the job finishes.
 */
export async function runJob<T>(path: string, body: unknown, onProgress?: (msg: string) => void, timeoutMs = 900_000): Promise<T> {
  const { jobId } = await api<{ jobId: string }>(path, { method: "POST", body });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1200));
    const job = await api<Job<T>>(`/jobs/${jobId}`);
    if (job.progress) onProgress?.(job.progress);
    if (job.status === "succeeded") return job.result as T;
    if (job.status === "failed") throw new ApiError(500, job.error ?? "The operation failed");
  }
  throw new ApiError(504, "Timed out waiting for the operation to finish");
}

/** Authenticated file download (the browser can't attach the bearer token to a plain link). */
export async function downloadFile(path: string, fallbackName: string) {
  const token = tokenStore.get();
  const res = await fetch(`${API_URL}/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Download failed (${res.status})`);
  }
  const name = res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
export interface AuditEvent { id: number; actorType: string; actorId: string | null; action: string; target: string | null; details: unknown; createdAt: string }
export interface Settings {
  geminiApiKey: string; claudeCliEnabled: boolean; globalPaused?: boolean; maxConcurrentAgents: number; autoExpireHours: number;
  maxStepsPerRun: number; maxRunTimeoutSeconds: number; dailyTokenBudget: number; requireApprovalForHighRisk: boolean;
}

export const STATUS_ORDER = ["BACKLOG", "READY", "AWAITING_APPROVAL", "IN_PROGRESS", "IN_REVIEW", "BLOCKED", "NEEDS_RETRY", "DONE"];
export const label = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
export const fmtMs = (ms: number | null | undefined) => {
  if (!ms) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const fmtDate = (d: string) => new Date(d).toLocaleString();
export const timeAgo = (d: string) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
