import { prisma } from "../db";
import { HttpError } from "../http";
import { askClaude } from "./claude";

/**
 * Client Quotation & Scope Builder. The Executive Assistant (client-facing scope) and Software Architect (technical
 * plan and estimates) are combined in one Claude Code planning call that returns strict JSON. Hours come from the
 * model; money is computed here (hours × rate) so the arithmetic is always consistent.
 */
export interface QuoteInput { clientName: string; requirements: string; hourlyRate: number; currency: string; deadline?: string; budgetHint?: string }
export interface Milestone { name: string; description: string; deliverables: string[]; hours: number; weeks: number; agents: string[] }
export interface QuoteResult {
  title: string; summary: string; scope: { inScope: string[]; outOfScope: string[] };
  techStack: string; category: "WEB" | "MOBILE_APP" | "GAME";
  milestones: Milestone[]; timelineWeeks: number; totalHours: number;
  cost: { currency: string; hourlyRate: number; subtotal: number; contingencyPercent: number; contingency: number; total: number; low: number; high: number };
  risks: string[]; assumptions: string[]; projectName: string; autoBuildGoal: string;
}

const clampNum = (v: unknown, min: number, max: number, dflt: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const strArr = (v: unknown, max = 12) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, max) : []);

export async function generateQuote(input: QuoteInput, progress: (m: string) => void): Promise<QuoteResult> {
  const agents = await prisma.agent.findMany({ where: { slug: { notIn: ["executive-assistant"] } }, select: { slug: true, name: true, roleTitle: true } });
  progress("The Executive Assistant and Software Architect are scoping the project…");
  const prompt = `You are two people at Devenum AI, an AI-powered software house, working together on a client quotation:
- the Executive Assistant (client-facing: clear scope, assumptions, plain-English summary), and
- the Software Architect (technical plan, milestones, realistic effort estimates).

Client: ${input.clientName}
Requirements from the client:
"""
${input.requirements}
"""
${input.deadline ? `Desired deadline: ${input.deadline}\n` : ""}${input.budgetHint ? `Budget hint: ${input.budgetHint}\n` : ""}
Our delivery team (AI agents, supervised by the CEO): ${agents.map(a => `${a.slug} (${a.roleTitle})`).join(", ")}.

Estimate effort in human-equivalent engineering HOURS per milestone (include design, implementation, QA, review and deployment). Be realistic, not optimistic. 3–6 milestones.

Respond with ONLY one JSON object, no prose and no code fences, exactly in this shape:
{"title": "...", "summary": "2-4 sentence plain-English overview for the client",
 "scope": {"inScope": ["..."], "outOfScope": ["..."]},
 "techStack": "comma-separated stack", "category": "WEB | MOBILE_APP | GAME",
 "milestones": [{"name": "...", "description": "...", "deliverables": ["..."], "hours": 40, "weeks": 1, "agents": ["agent-slug"]}],
 "contingencyPercent": 15,
 "risks": ["..."], "assumptions": ["..."],
 "projectName": "short project name",
 "autoBuildGoal": "one paragraph goal our agents can execute to build the first version (MVP) of this scope"}`;

  const r = await askClaude(prompt, Number(process.env.QUOTE_TIMEOUT_MS || 240_000));
  if (!r.ok) throw new HttpError(502, r.timedOut ? "Quote generation timed out — try shorter requirements" : `Quote generation failed: ${r.text}`);
  const start = r.text.indexOf("{"), end = r.text.lastIndexOf("}");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(r.text.slice(start, end + 1)); } catch { throw new HttpError(502, "The planner returned an invalid quote; please try again"); }

  const milestones: Milestone[] = (Array.isArray(raw.milestones) ? raw.milestones : []).slice(0, 8).map((m: Record<string, unknown>) => ({
    name: String(m.name ?? "Milestone").slice(0, 120), description: String(m.description ?? "").slice(0, 800),
    deliverables: strArr(m.deliverables, 10), hours: Math.round(clampNum(m.hours, 1, 2000, 20)), weeks: clampNum(m.weeks, 0.5, 52, 1),
    agents: strArr(m.agents, 6),
  }));
  if (!milestones.length) throw new HttpError(502, "The planner returned no milestones; please try again");
  const totalHours = milestones.reduce((s, m) => s + m.hours, 0);
  const contingencyPercent = Math.round(clampNum(raw.contingencyPercent, 0, 50, 15));
  const subtotal = totalHours * input.hourlyRate;
  const contingency = Math.round((subtotal * contingencyPercent) / 100);
  const cat = String(raw.category ?? "WEB").toUpperCase();
  const scope = (raw.scope ?? {}) as Record<string, unknown>;
  return {
    title: String(raw.title ?? `${input.clientName} project`).slice(0, 160),
    summary: String(raw.summary ?? "").slice(0, 2000),
    scope: { inScope: strArr(scope.inScope, 20), outOfScope: strArr(scope.outOfScope, 12) },
    techStack: String(raw.techStack ?? "").slice(0, 300),
    category: (["WEB", "MOBILE_APP", "GAME"].includes(cat) ? cat : "WEB") as QuoteResult["category"],
    milestones, totalHours,
    timelineWeeks: Math.round(milestones.reduce((s, m) => s + m.weeks, 0) * 10) / 10,
    cost: { currency: input.currency, hourlyRate: input.hourlyRate, subtotal, contingencyPercent, contingency, total: subtotal + contingency, low: Math.round(subtotal * 0.9), high: subtotal + contingency * 2 },
    risks: strArr(raw.risks), assumptions: strArr(raw.assumptions),
    projectName: String(raw.projectName ?? input.clientName).slice(0, 100),
    autoBuildGoal: String(raw.autoBuildGoal ?? raw.summary ?? "").slice(0, 2900),
  };
}
