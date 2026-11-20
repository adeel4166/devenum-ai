import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/** One-off data migration: switch every agent to the Claude Code CLI provider. Safe to re-run. */
const prisma = new PrismaClient();
prisma.agent.updateMany({ data: { modelProvider: "CLAUDE_CODE" } })
  .then(async r => {
    await prisma.auditEvent.create({ data: { actorType: "SYSTEM", action: "AGENTS_PROVIDER_SET", target: "agents", details: { modelProvider: "CLAUDE_CODE", affected: r.count } } });
    console.log(`Set modelProvider=CLAUDE_CODE on ${r.count} agents`);
  })
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
