export interface Actor { id: string; tag: string }

export interface Proposal {
  id: number; actionType: string; targetResource: string; scopeSummary: string; rationale: string; riskLevel: "LOW" | "MEDIUM" | "HIGH";
  rollbackPlan: string; validationPlan: string; status: string; expiresAt: string; createdAt: string;
  branchName: string | null; changedFiles: string[] | null;
  project: { id: number; name: string; slug: string };
  task: { id: number; title: string; priority: string } | null;
  requestingAgent: { id: number; name: string; slug: string };
}
export interface Status {
  projects: { id: number; name: string; status: string; progressPercent: number; category: string }[];
  runningAgents: { id: number; name: string; slug: string; currentTaskId: number | null }[];
  pendingApprovals: number; readyTasks: number; globalPaused: boolean;
}
export interface AgentRow { id: number; slug: string; name: string; status: string; modelProvider: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Thin client for the backend's /api/bot service API. */
export class BackendApi {
  constructor(private baseUrl: string, private token: string) {}

  private async req<T>(method: string, path: string, body?: unknown, actor?: Actor): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/bot${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(actor ? { "x-discord-user-id": actor.id, "x-discord-user-tag": actor.tag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
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
  createTask = (b: { projectId: number; title: string; agentSlug: string; priority: string; description?: string }, actor: Actor) =>
    this.req<{ id: number; title: string; status: string; priority: string; project: { name: string }; assignedAgent: { name: string; status: string } }>("POST", "/tasks", b, actor);
  approve = (id: number, actor: Actor, comment?: string) => this.req("POST", `/proposals/${id}/approve`, { comment }, actor);
  reject = (id: number, actor: Actor, comment?: string) => this.req("POST", `/proposals/${id}/reject`, { comment }, actor);
}
