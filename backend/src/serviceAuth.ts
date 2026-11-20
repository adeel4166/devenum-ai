import { createHash, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { prisma } from "./db";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Authenticates internal services (devenum-bot) with a shared BOT_SERVICE_TOKEN.
 * Decisions are attributed to the first active CEO user; the audit log records actorType DISCORD_CEO
 * plus the Discord user id/tag passed in X-Discord-User-Id / X-Discord-User-Tag.
 */
export async function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.BOT_SERVICE_TOKEN;
  if (!expected || expected.length < 24) return res.status(503).json({ error: "BOT_SERVICE_TOKEN is not configured on the backend" });
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ") || !timingSafeEqual(digest(h.slice(7)), digest(expected))) {
    return res.status(401).json({ error: "Invalid service token" });
  }
  const ceo = await prisma.user.findFirst({ where: { role: "CEO", isActive: true }, orderBy: { id: "asc" } });
  if (!ceo) return res.status(503).json({ error: "No active CEO user to act on behalf of" });
  req.user = { id: ceo.id, email: ceo.email, role: ceo.role, name: ceo.name };
  next();
}

export const discordContext = (req: Request) => ({
  discordUserId: String(req.headers["x-discord-user-id"] ?? "unknown").slice(0, 32),
  discordUserTag: String(req.headers["x-discord-user-tag"] ?? "unknown").slice(0, 64),
});
