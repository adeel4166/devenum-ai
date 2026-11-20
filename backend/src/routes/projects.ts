import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";

export const projectsRouter = Router();
const writers = requireRole("CEO", "ADMIN");

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

projectsRouter.get("/", wrap(async (_req, res) => {
  const projects = await prisma.project.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { tasks: true } } } });
  res.json(projects);
}));

projectsRouter.post("/", writers, wrap(async (req, res) => {
  const b = z.object({
    name: z.string().min(2).max(120),
    category: z.enum(["WEB", "MOBILE_APP", "GAME"]),
    description: z.string().max(5000).default(""),
    techStack: z.string().max(300).default(""),
    repoPath: z.string().max(300).default(""),
    gitBranch: z.string().max(100).default("main"),
  }).parse(req.body);
  let slug = slugify(b.name), n = 1;
  while (await prisma.project.findUnique({ where: { slug } })) slug = `${slugify(b.name)}-${++n}`;
  const p = await prisma.project.create({ data: { ...b, slug } });
  await audit("CEO", req.user!.id, "PROJECT_CREATED", `project:${p.slug}`, { category: p.category });
  res.status(201).json(p);
}));

projectsRouter.patch("/:id", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    status: z.enum(["PLANNING", "IN_PROGRESS", "REVIEW", "COMPLETED", "FROZEN"]).optional(),
    progressPercent: z.number().int().min(0).max(100).optional(),
    gitBranch: z.string().max(100).optional(),
  }).parse(req.body);
  const exists = await prisma.project.findUnique({ where: { id } });
  if (!exists) throw new HttpError(404, "Project not found");
  const p = await prisma.project.update({ where: { id }, data: b });
  await audit("CEO", req.user!.id, "PROJECT_UPDATED", `project:${p.slug}`, b);
  res.json(p);
}));
