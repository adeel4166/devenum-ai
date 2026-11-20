export interface Actor { id: string; tag: string }

export interface QaReport { status: "PASSED" | "WARNINGS"; score: number; findings: { severity: string; check: string; message: string; file?: string }[] }
export interface DeployResult { projectId: number; projectName: string; name: string; port: number; url: string; kind: string }
export interface SystemInfo {
  vps: { cpu: { percent: number; cores: number; load: number[] }; memory: { total: number; used: number; percent: number }; disk: { total: number; used: number; percent: number }; uptimeSec: number };
  services: { name: string; status: string; cpu: number; memory: number; restarts: number; kind: string }[];
}
export interface TimeoutAlert { id: number; errorMessage: string | null; executionMs: number; agent: { name: string; slug: string }; task: { id: number; title: string; status: string; project: { id: number; name: string; slug: string } } | null }
export interface Proposal {
  id: number; actionType: string; targetResource: string; scopeSummary: string; rationale: string; riskLevel: "LOW" | "MEDIUM" | "HIGH";
  rollbackPlan: string; validationPlan: string; status: string; expiresAt: string; createdAt: string;
  branchName: string | null; changedFiles: string[] | null; qaReport?: QaReport | null; payloadHash?: string | null; headCommit?: string | null;
  project: { id: number; name: string; slug: string };
  task: { id: number; title: string; priority: string } | null;
  requestingAgent: { id: number; name: string; slug: string };
}
export interface Status {
  projects: { id: number; name: string; status: string; progressPercent: number; category: string }[];
  runningAgents: { id: number; name: string; slug: string; currentTaskId: number | null }[];
  pendingApprovals: number; readyTasks: number; globalPaused: boolean;
}
export interface ProjectRow { id: number; name: string; slug: string; category: string; description: string; techStack: string; repoPath: string; githubRepoUrl: string | null }
export interface MergedProposal extends Proposal { mergeStatus: "MERGED" | "FAILED"; mergeCommit: string | null; mergeError: string | null; project: Proposal["project"] & { githubRepoUrl: string | null } }
export interface CreatedTask { id: number; title: string; status: string; priority: string; project: { name: string }; assignedAgent: { name: string; slug: string; status: string } }
export interface AgentRow { id: number; slug: string; name: string; roleTitle: string; status: string; modelProvider: string; manifest: unknown }

export interface Job<T> { id: string; kind: string; status: "running" | "succeeded" | "failed"; progress: string | null; result: T | null; error: string | null }
export interface PreviewInfo { projectId: number; slug: string; port: number; url: string; kind: string; startedAt: string; projectName?: string }
export interface GithubPushResult { url: string; created: boolean; isPrivate: boolean; visibilityMismatch: boolean; projectName: string }
export interface AutoBuildResult { projectId: number; projectName: string; goal: string; tasks: { id: number; title: string; priority: string; agent: { name: string; slug: string } }[] }
export interface ChatTurn { role: "user" | "assistant"; author?: string; content: string }
export interface PlanTask { agentSlug: string; agentName: string; title: string; description: string; priority: string }
export interface TeamPlan { id: number; summary: string; project: { existingProjectId: number | null; name: string; category: string; techStack: string; description: string }; tasks: PlanTask[] }
export interface DispatchResult { planId: number; project: { id: number; name: string; slug: string }; tasks: { id: number; title: string; agent: string; agentSlug: string; priority: string }[] }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Thin client for the backend's /api/bot service API. */
export class BackendApi {
  constructor(private baseUrl: string, private token: string) {}

  private headers(actor?: Actor) {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      ...(actor ? { "x-discord-user-id": actor.id, "x-discord-user-tag": actor.tag } : {}),
    };
  }

  private async req<T>(method: string, path: string, body?: unknown, actor?: Actor): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/bot${path}`, {
      method, headers: this.headers(actor),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: { path: (string | number)[]; message: string }[] };
    if (!res.ok) {
      const issue = data.issues?.[0];
      throw new ApiError(res.status, issue ? `${issue.path.join(".")}: ${issue.message}` : data.error ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  status = () => this.req<Status>("GET", "/status");
  agents = () => this.req<AgentRow[]>("GET", "/agents");
  pendingProposals = () => this.req<Proposal[]>("GET", "/proposals");
  unnotifiedProposals = () => this.req<Proposal[]>("GET", "/proposals/unnotified");
  markNotified = (id: number, messageId: string) => this.req("POST", `/proposals/${id}/notified`, { messageId });
  createProject = (b: { name: string; category: string; description: string }, actor: Actor) =>
    this.req<{ id: number; name: string; slug: string; repoPath: string }>("POST", "/projects", b, actor);
  createTask = (b: { projectId: number; title: string; agentSlug: string; priority: string; description?: string; dependencies?: number[] }, actor: Actor) =>
    this.req<CreatedTask>("POST", "/tasks", b, actor);
  project = (id: number) => this.req<ProjectRow>("GET", `/projects/${id}`);
  heartbeat = (user: string) => this.req<{ ok: boolean; github: boolean }>("POST", "/heartbeat", { user });
  previews = () => this.req<PreviewInfo[]>("GET", "/previews");
  stopPreview = (projectId: number, actor: Actor) => this.req<{ stopped: boolean; preview: PreviewInfo | null }>("DELETE", `/projects/${projectId}/preview`, undefined, actor);
  handoff = (projectId: number, actor: Actor) => this.req<CreatedTask>("POST", `/projects/${projectId}/handoff`, {}, actor);

  /** Long operations run as backend jobs (they can outlive any single HTTP request); poll until done. */
  async runJob<T>(path: string, body: unknown, actor: Actor | undefined, onProgress?: (msg: string) => unknown, timeoutMs = 900_000): Promise<T> {
    const { jobId } = await this.req<{ jobId: string }>("POST", path, body, actor);
    const deadline = Date.now() + timeoutMs;
    let last: string | null = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      const job = await this.req<Job<T>>("GET", `/jobs/${jobId}`);
      if (job.progress && job.progress !== last) { last = job.progress; await onProgress?.(job.progress); }
      if (job.status === "succeeded") return job.result as T;
      if (job.status === "failed") throw new ApiError(500, job.error ?? "Job failed");
    }
    throw new ApiError(504, "Timed out waiting for the backend job");
  }
  startPreview = (projectId: number, actor: Actor, onProgress?: (m: string) => unknown) => this.runJob<PreviewInfo>(`/projects/${projectId}/preview`, {}, actor, onProgress);
  githubPush = (projectId: number, visibility: "private" | "public", actor: Actor) => this.runJob<GithubPushResult>(`/projects/${projectId}/github`, { visibility }, actor);
  autoBuild = (projectId: number, goal: string, actor: Actor) => this.runJob<AutoBuildResult>(`/projects/${projectId}/auto-build`, { goal }, actor);
  /** Chat may run up to 5 minutes on the backend (deep research / document analysis); wait a little longer than that. */
  chat = (message: string, history: ChatTurn[], author: string, attachments: unknown[] = [], dir?: string, agentSlug?: string) =>
    this.runJob<{ reply: string; ms: number }>("/chat", { message, history, author, attachments, dir, agentSlug }, undefined, undefined, 360_000);
  pmChat = (message: string, history: ChatTurn[], author: string, attachments: unknown[] = [], dir?: string) =>
    this.runJob<{ reply: string; plan: TeamPlan | null }>("/pm/chat", { message, history, author, attachments, dir }, undefined, undefined, 360_000);
  dispatchPlan = (id: number, actor: Actor) => this.req<DispatchResult>("POST", `/pm/plans/${id}/dispatch`, {}, actor);
  discardPlan = (id: number, actor: Actor) => this.req("POST", `/pm/plans/${id}/discard`, {}, actor);

  deleteProject = (id: number, actor: Actor) => this.req<{ name: string; tasks: number; proposals: number; workspaceRemoved: boolean }>("DELETE", `/projects/${id}`, undefined, actor);
  deploy = (id: number, actor: Actor, onProgress?: (m: string) => unknown) => this.runJob<DeployResult>(`/projects/${id}/deploy`, {}, actor, onProgress);
  deployStop = (id: number, actor: Actor) => this.req<{ stopped: boolean; name: string }>("POST", `/projects/${id}/deploy-stop`, {}, actor);
  retryTask = (id: number, actor: Actor) => this.req<{ id: number; title: string }>("POST", `/tasks/${id}/retry`, {}, actor);
  system = () => this.req<SystemInfo>("GET", "/system");
  restartService = (name: string, actor: Actor) => this.req<{ name: string; deferred: boolean }>("POST", `/system/restart/${name}`, {}, actor);
  backup = (actor: Actor, onProgress?: (m: string) => unknown) => this.runJob<{ name: string; bytes: number }>("/backup", {}, actor, onProgress, 3_600_000);
  pinDecision = (projectId: number, b: { title: string; decision: string; rationale?: string }, actor: Actor) =>
    this.req<{ id: number; title: string; project: { id: number; name: string } }>("POST", `/projects/${projectId}/decisions`, b, actor);
  freeze = (projectId: number, frozen: boolean, actor: Actor) => this.req<{ id: number; name: string; isFrozen: boolean }>("POST", `/projects/${projectId}/freeze`, { frozen }, actor);
  dailyReport = (actor: Actor) => this.req<{ id: number; title: string; body: string }>("POST", "/reports/daily", {}, actor);
  unpostedReports = () => this.req<{ id: number; title: string; body: string }[]>("GET", "/reports/unposted");
  markReportPosted = (id: number) => this.req("POST", `/reports/${id}/posted`, {});
  projectsWithoutChannel = () => this.req<{ id: number; name: string; slug: string; description: string }[]>("GET", "/discord/projects");
  projectChannels = () => this.req<{ id: number; discordChannelId: string | null }[]>("GET", "/discord/channels");
  setProjectChannel = (id: number, channelId: string) => this.req("POST", `/projects/${id}/discord`, { channelId });
  taskUpdates = () => this.req<{
    id: number; title: string; status: string; priority: string; outputSummary: string | null; discordThreadId: string | null; discordLastStatus: string | null;
    project: { id: number; name: string; discordChannelId: string | null }; assignedAgent: { name: string; slug: string } | null;
    proposals: { id: number; status: string; riskLevel: string; qaReport: unknown; branchName: string | null; mergeStatus: string | null }[];
  }[]>("GET", "/discord/task-updates");
  markTaskPosted = (id: number, status: string, threadId?: string) => this.req("POST", `/tasks/${id}/discord`, { status, threadId });
  discordCleanup = () => this.req<{ channelIds: string[] }>("GET", "/discord/cleanup");
  discordCleanupAck = (channelIds: string[]) => this.req("POST", "/discord/cleanup/ack", { channelIds });
  timeoutAlerts = () => this.req<TimeoutAlert[]>("GET", "/alerts/timeouts");
  markAlerted = (runId: number) => this.req("POST", `/runs/${runId}/alerted`, {});

  /** Downloads the workspace ZIP (backend enforces Discord's upload limit). */
  async download(projectId: number, actor: Actor): Promise<{ data: Buffer; name: string; files: number }> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/bot/projects/${projectId}/download`, { headers: this.headers(actor), signal: AbortSignal.timeout(180_000) });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    }
    const name = res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? `project-${projectId}.zip`;
    return { data: Buffer.from(await res.arrayBuffer()), name, files: Number(res.headers.get("x-zip-files") ?? 0) };
  }
  unpromptedMerges = () => this.req<MergedProposal[]>("GET", "/merges/unprompted");
  markGithubPrompted = (id: number) => this.req("POST", `/proposals/${id}/github-prompted`, {});
  revise = (id: number, comment: string, actor: Actor) => this.req<{ followUpTaskId: number; title: string }>("POST", `/proposals/${id}/revise`, { comment }, actor);
  audit = (action: string, target: string, details: Record<string, unknown>, actor: Actor) => this.req("POST", "/audit", { action, target, details }, actor);
  approve = (id: number, actor: Actor, comment?: string) => this.req("POST", `/proposals/${id}/approve`, { comment }, actor);
  reject = (id: number, actor: Actor, comment?: string) => this.req("POST", `/proposals/${id}/reject`, { comment }, actor);
}
