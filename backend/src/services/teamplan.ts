import { Prisma, Priority } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { HttpError } from "../http";
import { createProject } from "../routes/projects";
import { askClaude, CHAT_TOOLS } from "./claude";
import { attachmentBlock, ChatAttachment, chatAgent, chatRules, ChatTurn, personaHeader, transcript, withChatSlot } from "./chat";
import type { OpsActor } from "./ops";

/**
 * Project Manager team-delegation workflow. The PM chats normally; when the CEO asks to plan/build/divide work it
 * also returns a structured multi-agent plan, stored as a PENDING TeamPlan. Nothing is created until the CEO clicks
 * "Approve & Assign to Team" (dispatchPlan). Dispatched tasks run sequentially and every code change still needs
 * CEO approval before it reaches main.
 */
export interface PlanTask { agentSlug: string; agentName: string; title: string; description: string; priority: Priority }
export interface TeamPlanBody {
  summary: string;
  project: { existingProjectId: number | null; name: string; category: "WEB" | "MOBILE_APP" | "GAME"; techStack: string; description: string };
  tasks: PlanTask[];
}

const PLAN_FENCE = /```devenum-plan\s*([\s\S]*?)```/i;
const NON_BUILDERS = new Set(["project-manager", "executive-assistant"]);
const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export async function pmChat(message: string, history: ChatTurn[], author: string, files: ChatAttachment[], dir?: string) {
  const pm = await chatAgent("project-manager");
  const [agents, projects] = await Promise.all([
    prisma.agent.findMany({ where: { status: { not: "DISABLED" } }, orderBy: { id: "asc" } }),
    prisma.project.findMany({ orderBy: { createdAt: "desc" }, take: 30, select: { id: true, name: true, category: true, status: true, techStack: true } }),
  ]);
  const roster = agents.filter(a => !NON_BUILDERS.has(a.slug))
    .map(a => `- ${a.slug}: ${a.name} (${a.roleTitle})${(a.manifest as { notes?: string })?.notes ? ` — ${(a.manifest as { notes?: string }).notes}` : ""}`).join("\n");
  const prompt = `${personaHeader(pm)}
${chatRules("Discord")}

You lead the delivery team. When — and only when — the CEO asks you to plan, build, scope or divide work among the team, design a concrete execution plan:
- 2 to 8 ordered tasks, each assigned to the single best-suited agent; typical order: software-architect → (ui-ux-designer) → backend-developer → frontend-developer → qa-engineer (→ security-engineer / devops-engineer when relevant).
- Tasks run strictly one after another; each must be self-contained, buildable in one focused session, and state acceptance criteria.
- Use an existing project if the CEO refers to one; otherwise propose a new project.
Then, after your normal conversational reply (which should explain the plan briefly), append exactly one fenced block:
\`\`\`devenum-plan
{"summary": "one sentence", "project": {"existingProjectId": null, "name": "...", "category": "WEB|MOBILE_APP|GAME", "techStack": "...", "description": "..."},
 "tasks": [{"agent_slug": "software-architect", "title": "...", "description": "...", "priority": "HIGH"}]}
\`\`\`
If the CEO is just asking a question or chatting, answer normally and do NOT include the block.

Team you can assign (use only these slugs):
${roster}

Existing projects: ${projects.length ? projects.map(p => `#${p.id} ${p.name} (${p.category}, ${p.status}${p.techStack ? `, ${p.techStack}` : ""})`).join("; ") : "none yet"}
${transcript(history, pm.name)}${attachmentBlock(files, dir)}
New message from ${author}:
${message || "(no text — please analyse the attached file(s))"}

Reply as the ${pm.name}:`;

  const r = await withChatSlot(() => askClaude(prompt, Number(process.env.CHAT_TIMEOUT_MS || 300_000), { addDirs: dir ? [dir] : [], allowedTools: CHAT_TOOLS }));
  if (!r.ok) throw new HttpError(502, r.timedOut ? "The Project Manager ran out of time (5 minute limit). Try a more focused request." : `Claude Code error: ${r.text.slice(0, 300)}`);

  const m = r.text.match(PLAN_FENCE);
  const reply = r.text.replace(PLAN_FENCE, "").trim();
  if (!m) return { reply, plan: null };

  let raw: Record<string, unknown>;
  try { raw = JSON.parse(m[1].trim()); } catch { return { reply: `${reply}\n\n_(I drafted a plan but it wasn't valid — ask me to "redo the plan".)_`, plan: null }; }
  const bySlug = new Map(agents.map(a => [a.slug, a]));
  const proj = (raw.project ?? {}) as Record<string, unknown>;
  const existingId = Number(proj.existingProjectId) || null;
  const existing = existingId ? projects.find(p => p.id === existingId) : undefined;
  const cat = String(proj.category ?? "WEB").toUpperCase();
  const tasks: PlanTask[] = (Array.isArray(raw.tasks) ? raw.tasks : []).flatMap((t: Record<string, unknown>) => {
    const slug = String(t.agent_slug ?? t.agentSlug ?? "");
    const a = bySlug.get(slug);
    if (!a || NON_BUILDERS.has(slug)) return [];
    const pr = String(t.priority ?? "MEDIUM").toUpperCase();
    const title = String(t.title ?? "").trim().slice(0, 200);
    if (title.length < 2) return [];
    return [{ agentSlug: slug, agentName: a.name, title, description: String(t.description ?? title).trim().slice(0, 8000), priority: (PRIORITIES as readonly string[]).includes(pr) ? pr as Priority : "MEDIUM" }];
  }).slice(0, 8);
  if (!tasks.length) return { reply, plan: null };

  const body: TeamPlanBody = {
    summary: String(raw.summary ?? "").slice(0, 500),
    project: {
      existingProjectId: existing?.id ?? null,
      name: existing?.name ?? (String(proj.name ?? "").trim().slice(0, 120) || "New project"),
      category: (["WEB", "MOBILE_APP", "GAME"].includes(cat) ? cat : "WEB") as TeamPlanBody["project"]["category"],
      techStack: String(proj.techStack ?? existing?.techStack ?? "").slice(0, 300),
      description: String(proj.description ?? raw.summary ?? "").slice(0, 5000),
    },
    tasks,
  };
  const saved = await prisma.teamPlan.create({ data: { plan: body as unknown as Prisma.InputJsonObject, requestedBy: author.slice(0, 80) } });
  return { reply, plan: { id: saved.id, ...body } };
}

export async function getPlan(id: number) {
  const p = await prisma.teamPlan.findUnique({ where: { id } });
  if (!p) throw new HttpError(404, "Plan not found");
  return { ...p, plan: p.plan as unknown as TeamPlanBody };
}

/** CEO approval: create the project (if new) and all tasks, chained so they run one after another. */
export async function dispatchPlan(id: number, a: OpsActor) {
  // Claim atomically so a double-click can't create the tasks twice.
  const claimed = await prisma.teamPlan.updateMany({ where: { id, status: "PENDING" }, data: { status: "DISPATCHED", dispatchedAt: new Date() } });
  if (claimed.count !== 1) {
    const p = await prisma.teamPlan.findUnique({ where: { id } });
    throw new HttpError(p ? 409 : 404, p ? `Plan #${id} is already ${p.status.toLowerCase()}` : "Plan not found");
  }
  try {
    const { plan } = await getPlan(id);
    let project = plan.project.existingProjectId ? await prisma.project.findUnique({ where: { id: plan.project.existingProjectId } }) : null;
    if (!project) {
      project = await createProject({ name: plan.project.name, category: plan.project.category, techStack: plan.project.techStack, description: plan.project.description, repoPath: "", gitBranch: "main" });
      await audit(a.actorType, a.actorId, "PROJECT_CREATED", `project:${project.slug}`, { category: project.category, viaTeamPlan: id });
    }
    const agents = await prisma.agent.findMany({ where: { slug: { in: plan.tasks.map(t => t.agentSlug) } } });
    const created: { id: number; title: string; agent: string; agentSlug: string; priority: string }[] = [];
    let prev: number | null = null;
    for (const t of plan.tasks) {
      const agent = agents.find(x => x.slug === t.agentSlug);
      if (!agent) continue;
      const row: { id: number } = await prisma.task.create({ data: {
        projectId: project.id, assignedAgentId: agent.id, title: t.title, priority: t.priority, status: "READY",
        description: `${t.description}\n\n---\nPart of Project Manager plan #${id}: ${plan.summary}`.slice(0, 10000), dependencies: prev ? [prev] : [],
      } });
      created.push({ id: row.id, title: t.title, agent: agent.name, agentSlug: agent.slug, priority: t.priority });
      prev = row.id;
    }
    await prisma.teamPlan.update({ where: { id }, data: { projectId: project.id } });
    await audit(a.actorType, a.actorId, "TEAM_PLAN_DISPATCHED", `project:${project.slug}`, { planId: id, taskIds: created.map(t => t.id), ...(a.context ?? {}) });
    return { planId: id, project: { id: project.id, name: project.name, slug: project.slug }, tasks: created };
  } catch (e) {
    await prisma.teamPlan.update({ where: { id }, data: { status: "PENDING", dispatchedAt: null } }).catch(() => undefined);
    throw e;
  }
}

export async function discardPlan(id: number, a: OpsActor) {
  const r = await prisma.teamPlan.updateMany({ where: { id, status: "PENDING" }, data: { status: "DISCARDED" } });
  if (r.count !== 1) throw new HttpError(409, "Plan is not pending");
  await audit(a.actorType, a.actorId, "TEAM_PLAN_DISCARDED", `plan:${id}`, a.context ?? {});
  return { discarded: true };
}
