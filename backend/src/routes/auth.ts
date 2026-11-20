import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth, signToken } from "../auth";
import { audit } from "../audit";
import { HttpError, wrap } from "../http";

export const authRouter = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

authRouter.post("/login", limiter, wrap(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!user || !ok || !user.isActive) {
    await audit("SYSTEM", null, "AUTH_LOGIN_FAILED", email.toLowerCase());
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const u = { id: user.id, email: user.email, role: user.role, name: user.name };
  await audit(user.role === "CEO" ? "CEO" : "SYSTEM", user.id, "AUTH_LOGIN", user.email);
  res.json({ token: signToken(u), user: u });
}));

authRouter.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

authRouter.post("/change-password", requireAuth, limiter, wrap(async (req, res) => {
  const { oldPassword, newPassword } = z.object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(10, "New password must be at least 10 characters").max(128),
  }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !(await bcrypt.compare(oldPassword, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
  if (oldPassword === newPassword) throw new HttpError(400, "New password must differ from the current one");
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } });
  await audit(user.role === "CEO" ? "CEO" : "SYSTEM", user.id, "AUTH_PASSWORD_CHANGED", `user:${user.email}`);
  res.json({ ok: true });
}));
