import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";

export const usersRouter = Router();
usersRouter.use(requireRole("CEO"));

const select = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } as const;
const password = z.string().min(10, "Password must be at least 10 characters").max(128);

usersRouter.get("/", wrap(async (_req, res) => {
  res.json(await prisma.user.findMany({ select, orderBy: { id: "asc" } }));
}));

usersRouter.post("/", wrap(async (req, res) => {
  const b = z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    password,
    role: z.enum(["ADMIN", "AUDITOR"]),
  }).parse(req.body);
  const email = b.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(409, "A user with this email already exists");
  const u = await prisma.user.create({
    data: { name: b.name, email, role: b.role, passwordHash: await bcrypt.hash(b.password, 12) }, select,
  });
  await audit("CEO", req.user!.id, "USER_CREATED", `user:${email}`, { role: b.role });
  res.status(201).json(u);
}));

usersRouter.patch("/:id", wrap(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    name: z.string().min(2).max(100).optional(),
    role: z.enum(["ADMIN", "AUDITOR"]).optional(),
    isActive: z.boolean().optional(),
    password: password.optional(),
  }).parse(req.body);
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw new HttpError(404, "User not found");
  if (target.role === "CEO") throw new HttpError(403, "CEO accounts cannot be modified here");
  const { password: pw, ...rest } = b;
  const u = await prisma.user.update({
    where: { id }, select,
    data: { ...rest, ...(pw ? { passwordHash: await bcrypt.hash(pw, 12) } : {}) },
  });
  await audit("CEO", req.user!.id, "USER_UPDATED", `user:${target.email}`, { ...rest, passwordReset: !!pw });
  res.json(u);
}));
