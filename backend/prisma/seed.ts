import "dotenv/config";
import bcrypt from "bcryptjs";
import { Department, ModelProvider, Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Role-based default Claude models: deep planning → opus, coding/design/security → sonnet, fast ops/QA/assistant → haiku. */
export const ROLE_MODELS: Record<string, "opus" | "sonnet" | "haiku"> = {
  "project-manager": "opus", "software-architect": "opus",
  "ui-ux-designer": "sonnet", "frontend-developer": "sonnet", "backend-developer": "sonnet", "mobile-developer": "sonnet",
  "game-developer": "sonnet", "security-engineer": "sonnet", "devops-engineer": "sonnet",
  "qa-engineer": "haiku", "executive-assistant": "haiku",
};

const COMMON_PROHIBITED = [
  "push to main/master without CEO approval",
  "run destructive shell commands (rm -rf, drop database)",
  "read or print secrets / .env contents",
  "access paths outside the assigned project repoPath",
];

interface Def { slug: string; name: string; roleTitle: string; department: Department; modelProvider: ModelProvider;
  tools: string[]; extraProhibited?: string[]; maxSteps: number; timeoutSeconds: number; notes: string }

const agents: Def[] = [
  { slug: "project-manager", name: "Project Manager", roleTitle: "CEO/COO Orchestrator", department: "LEADERSHIP", modelProvider: "CLAUDE_CODE",
    tools: ["task.create", "task.assign", "task.reprioritize", "proposal.create", "report.generate"], maxSteps: 40, timeoutSeconds: 900,
    extraProhibited: ["write source code", "approve own proposals"], notes: "Decomposes CEO goals into tasks, assigns agents, tracks delivery." },
  { slug: "software-architect", name: "Software Architect", roleTitle: "Software Architect", department: "ARCHITECTURE", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "fs.write:docs", "git.diff", "diagram.generate", "proposal.create"], maxSteps: 60, timeoutSeconds: 1800,
    extraProhibited: ["modify application source outside /docs and /architecture"], notes: "Owns system design, ADRs and technical standards." },
  { slug: "ui-ux-designer", name: "UI/UX Designer", roleTitle: "UI/UX Designer", department: "DESIGN", modelProvider: "CLAUDE_CODE",
    tools: ["design.wireframe", "design.tokens", "fs.read", "fs.write:design"], maxSteps: 50, timeoutSeconds: 1200,
    extraProhibited: ["modify backend code"], notes: "Wireframes, design tokens and accessibility reviews." },
  { slug: "frontend-developer", name: "Frontend Developer", roleTitle: "Frontend Developer", department: "ENGINEERING", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "fs.write:src", "shell.run:npm", "git.commit", "browser.preview"], maxSteps: 80, timeoutSeconds: 2400,
    extraProhibited: ["modify database schema"], notes: "React / Next.js / Tailwind implementation." },
  { slug: "backend-developer", name: "Backend Developer", roleTitle: "Backend Developer", department: "ENGINEERING", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "fs.write:src", "shell.run:npm", "git.commit", "db.query:readonly"], maxSteps: 80, timeoutSeconds: 2400,
    extraProhibited: ["apply DB migrations without an approved DB_MIGRATION proposal"], notes: "APIs, business logic, Prisma/MySQL." },
  { slug: "mobile-developer", name: "Mobile App Developer", roleTitle: "Mobile App Developer", department: "ENGINEERING", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "fs.write:src", "shell.run:npm", "shell.run:expo", "git.commit"], maxSteps: 80, timeoutSeconds: 2400,
    extraProhibited: ["submit builds to app stores"], notes: "React Native / Expo applications." },
  { slug: "game-developer", name: "Game Developer", roleTitle: "Game Developer", department: "ENGINEERING", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "fs.write:src", "shell.run:npm", "git.commit", "asset.import"], maxSteps: 80, timeoutSeconds: 2400,
    extraProhibited: ["import unlicensed assets"], notes: "Gameplay systems, engine integration, performance." },
  { slug: "qa-engineer", name: "QA Engineer", roleTitle: "QA Engineer", department: "QA_SECURITY", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "test.run", "test.generate", "browser.e2e", "bug.report"], maxSteps: 60, timeoutSeconds: 1800,
    extraProhibited: ["modify production source (report bugs instead)"], notes: "Dual-model (Gemini + Claude): test planning with Gemini, test authoring with Claude Code." },
  { slug: "security-engineer", name: "Security Engineer", roleTitle: "Security Engineer", department: "QA_SECURITY", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "sast.scan", "dependency.audit", "secret.scan", "bug.report"], maxSteps: 60, timeoutSeconds: 1800,
    extraProhibited: ["exploit vulnerabilities against non-local targets", "modify production source"], notes: "Dual-model (Gemini + Claude): threat modelling and code review." },
  { slug: "devops-engineer", name: "DevOps Engineer", roleTitle: "DevOps Engineer", department: "DEVOPS", modelProvider: "CLAUDE_CODE",
    tools: ["fs.read", "fs.write:infra", "shell.run:docker", "ci.configure", "proposal.create"], maxSteps: 70, timeoutSeconds: 2400,
    extraProhibited: ["deploy to production", "deploy to staging without approved DEPLOY_STAGING proposal"], notes: "CI/CD, containers, staging deployments." },
  { slug: "executive-assistant", name: "Executive Assistant", roleTitle: "General Assistant", department: "LEADERSHIP", modelProvider: "CLAUDE_CODE",
    tools: ["chat.reply", "brainstorm.ideas", "qa.technical", "plan.project", "prompt.refine", "fs.read"], maxSteps: 20, timeoutSeconds: 600,
    extraProhibited: ["write or modify source code", "create git branches or proposals from chat", "make commitments on the CEO's behalf"],
    notes: "CEO's conversational partner: brainstorming, technical Q&A, project planning (break goals into tasks for the other agents), and refining prompts/task descriptions. Concise, practical, asks clarifying questions when needed." },
];

async function main() {
  const passwordHash = await bcrypt.hash("Admin@12345", 12);
  await prisma.user.upsert({
    where: { email: "ceo@devenum.com" }, update: {},
    create: { name: "Devenum CEO", email: "ceo@devenum.com", passwordHash, role: "CEO" },
  });

  for (const a of agents) {
    const manifest: Prisma.InputJsonObject = {
      allowedTools: a.tools,
      prohibitedActions: [...COMMON_PROHIBITED, ...(a.extraProhibited ?? [])],
      maxSteps: a.maxSteps,
      timeoutSeconds: a.timeoutSeconds,
      notes: a.notes,
    };
    await prisma.agent.upsert({
      where: { slug: a.slug }, update: {},
      create: { slug: a.slug, name: a.name, roleTitle: a.roleTitle, department: a.department, modelProvider: a.modelProvider, model: ROLE_MODELS[a.slug] ?? "sonnet", manifest },
    });
  }

  // No demo projects: a fresh install starts with an empty dashboard (CEO user + the agent team only).
  if (!(await prisma.auditEvent.findFirst({ where: { action: "SYSTEM_SEEDED" } }))) {
    await prisma.auditEvent.create({ data: { actorType: "SYSTEM", actorId: null, action: "SYSTEM_SEEDED", target: "database", details: { agents: agents.length } } });
  }
  console.log("Seed complete. Login: ceo@devenum.com / Admin@12345");
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
