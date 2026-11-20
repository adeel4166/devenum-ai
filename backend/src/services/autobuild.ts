import { askClaude } from "./claude";

export interface AgentRow { slug: string; name: string; roleTitle: string; status: string; manifest: unknown }

export interface PlannedTask { agentSlug: string; title: string; description: string; priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" }

// Coordination-only roles never receive build tasks.
const NON_BUILDERS = new Set(["project-manager", "executive-assistant"]);

/** Asks Claude Code (as the Project Manager, read-only) to split a goal into 3–5 ordered tasks for existing agents. */
export async function planGoal(project: { name: string; category: string; techStack: string; description: string }, goal: string, agents: AgentRow[]): Promise<PlannedTask[]> {
  const builders = agents.filter(a => !NON_BUILDERS.has(a.slug) && a.status !== "DISABLED");
  const roster = builders.map(a => `- ${a.slug}: ${a.name} (${a.roleTitle})${(a.manifest as { notes?: string })?.notes ? ` — ${(a.manifest as { notes?: string }).notes}` : ""}`).join("\n");
  const prompt = `You are the Project Manager of Devenum AI, an autonomous software house. Break the CEO's goal into 3 to 5 ordered engineering tasks.
Each task is executed by one AI agent with Claude Code in the project's git repository, strictly one after another (each task starts only after the previous one is approved and merged), so every task must build on the previous ones and be completable in a single focused session.

Project: ${project.name} (${project.category})
Tech stack: ${project.techStack || "not specified — pick a simple, sensible default and state it in the first task"}
Description: ${project.description || "(none)"}

CEO goal:
${goal}

Available agents (use ONLY these slugs):
${roster}

Typical order: architecture/design first, then implementation (frontend/backend/mobile/game), then QA, then security/devops if relevant.
Each description must be specific and self-contained: what to build, which files/areas, and acceptance criteria.

Respond with ONLY a JSON array, no prose and no code fences, in this exact shape:
[{"agent_slug": "software-architect", "title": "short imperative title", "description": "detailed instructions and acceptance criteria", "priority": "HIGH"}]
priority is one of LOW, MEDIUM, HIGH, CRITICAL.`;

  const r = await askClaude(prompt, Number(process.env.AUTOBUILD_TIMEOUT_MS || 180_000));
  if (!r.ok) throw new Error(r.timedOut ? "Planning timed out" : `Planning failed: ${r.text}`);
  const start = r.text.indexOf("["), end = r.text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Planner did not return a JSON task list");
  let raw: unknown;
  try { raw = JSON.parse(r.text.slice(start, end + 1)); } catch { throw new Error("Planner returned invalid JSON"); }
  if (!Array.isArray(raw)) throw new Error("Planner output is not a list");

  const valid = new Set(builders.map(a => a.slug));
  const tasks: PlannedTask[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    const slug = String(t.agent_slug ?? t.agentSlug ?? "");
    if (!valid.has(slug)) continue;
    const pr = String(t.priority ?? "MEDIUM").toUpperCase();
    tasks.push({
      agentSlug: slug,
      title: String(t.title ?? "").trim().slice(0, 200),
      description: String(t.description ?? "").trim().slice(0, 8000),
      priority: (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(pr) ? pr : "MEDIUM") as PlannedTask["priority"],
    });
  }
  const usable = tasks.filter(t => t.title.length >= 2).slice(0, 5);
  if (usable.length < 2) throw new Error("Planner produced fewer than 2 usable tasks; try rephrasing the goal");
  return usable;
}
