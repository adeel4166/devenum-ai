import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/** One-off data migration: apply role-based default Claude models to existing agents. Safe to re-run. */
const ROLE_MODELS: Record<string, string> = {
  "project-manager": "opus", "software-architect": "opus",
  "ui-ux-designer": "sonnet", "frontend-developer": "sonnet", "backend-developer": "sonnet", "mobile-developer": "sonnet",
  "game-developer": "sonnet", "security-engineer": "sonnet", "devops-engineer": "sonnet",
  "qa-engineer": "haiku", "executive-assistant": "haiku",
};
const prisma = new PrismaClient();
(async () => {
  for (const [slug, model] of Object.entries(ROLE_MODELS)) await prisma.agent.updateMany({ where: { slug }, data: { model } });
  await prisma.auditEvent.create({ data: { actorType: "SYSTEM", action: "AGENT_MODELS_SET", target: "agents", details: ROLE_MODELS } });
  console.table(await prisma.agent.findMany({ select: { slug: true, model: true }, orderBy: { id: "asc" } }));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
