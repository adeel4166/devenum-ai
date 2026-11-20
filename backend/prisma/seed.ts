import "dotenv/config";
import bcrypt from "bcryptjs";
import { Department, ModelProvider, Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const day = 24 * 3600 * 1000;

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
];

async function main() {
  const passwordHash = await bcrypt.hash("Admin@12345", 12);
  const ceo = await prisma.user.upsert({
    where: { email: "ceo@devenum.com" }, update: {},
    create: { name: "Devenum CEO", email: "ceo@devenum.com", passwordHash, role: "CEO" },
  });

  const byslug: Record<string, number> = {};
  for (const a of agents) {
    const manifest: Prisma.InputJsonObject = {
      allowedTools: a.tools,
      prohibitedActions: [...COMMON_PROHIBITED, ...(a.extraProhibited ?? [])],
      maxSteps: a.maxSteps,
      timeoutSeconds: a.timeoutSeconds,
      notes: a.notes,
    };
    const row = await prisma.agent.upsert({
      where: { slug: a.slug }, update: {},
      create: { slug: a.slug, name: a.name, roleTitle: a.roleTitle, department: a.department, modelProvider: a.modelProvider, manifest },
    });
    byslug[a.slug] = row.id;
  }

  // Demo data only on first setup.
  if ((await prisma.project.count()) > 0) { console.log("Demo data already present, skipping."); return; }

  const project = await prisma.project.create({
    data: {
      name: "Devenum E-Commerce MVP", slug: "devenum-e-commerce-mvp", category: "WEB",
      description: "Storefront MVP with catalog, cart, checkout and an admin back office.",
      techStack: "Next.js, Node.js, Prisma, MySQL, Stripe", repoPath: "C:/projects/devenum-ecommerce", gitBranch: "develop",
      status: "IN_PROGRESS", progressPercent: 35,
    },
  });

  const mk = (title: string, description: string, status: never, agent: string, priority: never, extra: object = {}) =>
    prisma.task.create({ data: { projectId: project.id, assignedAgentId: byslug[agent], title, description, status, priority, ...extra } });

  await mk("Design system architecture & ADRs", "Define service boundaries, data model and ADRs for the MVP.", "DONE" as never, "software-architect", "HIGH" as never,
    { outputSummary: "Published 4 ADRs and the C4 container diagram.", executionTimeMs: 412_000 });
  const apiTask = await mk("Implement product catalog API", "CRUD + search endpoints for products and categories.", "AWAITING_APPROVAL" as never, "backend-developer", "HIGH" as never);
  const feTask = await mk("Build storefront product listing page", "Responsive grid with filters and pagination.", "IN_PROGRESS" as never, "frontend-developer", "MEDIUM" as never);
  const devopsTask = await mk("Set up staging deployment pipeline", "Dockerize apps and configure CI for staging.", "AWAITING_APPROVAL" as never, "devops-engineer", "CRITICAL" as never);
  await mk("Write checkout E2E test plan", "Cover cart, payment and order confirmation flows.", "BACKLOG" as never, "qa-engineer", "LOW" as never);

  await prisma.agent.update({ where: { id: byslug["frontend-developer"] }, data: { status: "RUNNING", currentTaskId: feTask.id, totalRuns: 7 } });
  await prisma.agent.update({ where: { id: byslug["backend-developer"] }, data: { status: "WAITING_APPROVAL", currentTaskId: apiTask.id, totalRuns: 9 } });
  await prisma.agent.update({ where: { id: byslug["devops-engineer"] }, data: { status: "WAITING_APPROVAL", currentTaskId: devopsTask.id, totalRuns: 3 } });
  await prisma.agent.update({ where: { id: byslug["software-architect"] }, data: { totalRuns: 5 } });

  await prisma.proposal.create({ data: {
    projectId: project.id, taskId: apiTask.id, requestingAgentId: byslug["backend-developer"], actionType: "DB_MIGRATION",
    targetResource: "mysql://devenum_ecommerce (Product, Category tables)",
    scopeSummary: "Create Product and Category tables with indexes on slug, categoryId and price.",
    rationale: "The catalog API needs persistent storage; no existing tables are altered.",
    riskLevel: "MEDIUM", rollbackPlan: "Run the generated down-migration (DROP TABLE Product, Category). No data exists yet, so no data loss.",
    validationPlan: "Run migrations on a clean database, execute the API integration suite, and verify schema diff is empty.",
    expiresAt: new Date(Date.now() + 2 * day),
  } });
  await prisma.proposal.create({ data: {
    projectId: project.id, taskId: devopsTask.id, requestingAgentId: byslug["devops-engineer"], actionType: "DEPLOY_STAGING",
    targetResource: "staging.devenum-ecommerce.internal",
    scopeSummary: "Deploy containerized frontend and backend to the staging host via GitHub Actions.",
    rationale: "Stakeholders need a shareable build to review the MVP; staging is isolated from production.",
    riskLevel: "HIGH", rollbackPlan: "Redeploy the previous image tag; staging database is snapshotted before each deploy.",
    validationPlan: "Health-check endpoints, smoke tests on login and catalog, and a log review for errors for 15 minutes.",
    expiresAt: new Date(Date.now() + 1 * day),
  } });

  await prisma.agentRun.createMany({ data: [
    { agentId: byslug["software-architect"], status: "SUCCEEDED", queuedMs: 800, executionMs: 412_000, logs: "Analysed requirements\nDrafted ADR-001..004\nExported C4 diagram", startedAt: new Date(Date.now() - 3 * 3600_000), finishedAt: new Date(Date.now() - 3 * 3600_000 + 412_000) },
    { agentId: byslug["frontend-developer"], status: "RUNNING", queuedMs: 1200, executionMs: 95_000, logs: "Scaffolded ProductGrid\nAdded filter sidebar\nRunning component tests...", startedAt: new Date(Date.now() - 600_000) },
    { agentId: byslug["backend-developer"], status: "FAILED", queuedMs: 500, executionMs: 38_000, logs: "Generated Prisma models\nAttempted migration", errorMessage: "Blocked: DB_MIGRATION requires CEO approval", startedAt: new Date(Date.now() - 1800_000), finishedAt: new Date(Date.now() - 1800_000 + 38_000) },
  ] });

  await prisma.auditEvent.createMany({ data: [
    { actorType: "SYSTEM", actorId: null, action: "SYSTEM_SEEDED", target: "database", details: { agents: agents.length } },
    { actorType: "CEO", actorId: String(ceo.id), action: "PROJECT_CREATED", target: `project:${project.slug}`, details: { category: "WEB" } },
    { actorType: "AGENT", actorId: "backend-developer", action: "PROPOSAL_SUBMITTED", target: "DB_MIGRATION", details: { riskLevel: "MEDIUM" } },
    { actorType: "AGENT", actorId: "devops-engineer", action: "PROPOSAL_SUBMITTED", target: "DEPLOY_STAGING", details: { riskLevel: "HIGH" } },
  ] });
  console.log("Seed complete. Login: ceo@devenum.com / Admin@12345");
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
