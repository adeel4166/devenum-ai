import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { autoBuildJob, githubConfigured, githubPushJob, OpsActor, previewInfo, queueHandoff, startPreviewJob, stopProjectPreview, withProjectZip } from "../services/ops";

export const projectsRouter = Router();
const writers = requireRole("CEO", "ADMIN");
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/opt/devenum-ai/workspaces";

export const projectInput = z.object({
  name: z.string().min(2).max(120),
  category: z.enum(["WEB", "MOBILE_APP", "GAME"]),
  description: z.string().max(5000).default(""),
  techStack: z.string().max(300).default(""),
  repoPath: z.string().max(300).default(""),
  gitBranch: z.string().max(100).default("main"),
});

/** Creates a project with a unique slug. repoPath defaults to the worker workspace for that slug. */
export async function createProject(b: z.infer<typeof projectInput>) {
  let slug = slugify(b.name) || "project", n = 1;
  const base = slug;
  while (await prisma.project.findUnique({ where: { slug } })) slug = `${base}-${++n}`;
  return prisma.project.create({ data: { ...b, repoPath: b.repoPath || `${WORKSPACES_DIR}/${slug}`, slug } });
}

projectsRouter.get("/", wrap(async (_req, res) => {
  const [projects, counts, lastRuns] = await Promise.all([
    prisma.project.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { tasks: true } } } }),
    prisma.task.groupBy({ by: ["projectId", "status"], _count: true }),
    prisma.$queryRaw<{ projectId: number; lastAt: Date }[]>`SELECT t.projectId AS projectId, MAX(r.startedAt) AS lastAt FROM AgentRun r JOIN Task t ON t.id = r.taskId GROUP BY t.projectId`,
  ]);
  res.json(projects.map(p => {
    const taskCounts: Record<string, number> = {};
    for (const c of counts) if (c.projectId === p.id) taskCounts[c.status] = c._count;
    const lastRun = lastRuns.find(r => Number(r.projectId) === p.id)?.lastAt;
    return { ...p, taskCounts, lastActivityAt: (lastRun ?? p.createdAt).toISOString?.() ?? p.createdAt, preview: previewInfo(p.id) };
  }));
}));

projectsRouter.get("/capabilities", wrap(async (_req, res) => { res.json({ github: githubConfigured() }); }));

projectsRouter.get("/:id", wrap(async (req, res) => {
  const id = idParam(req);
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      tasks: { orderBy: { createdAt: "desc" }, include: { assignedAgent: { select: { id: true, name: true, slug: true, status: true, modelProvider: true } } } },
      proposals: {
        orderBy: { createdAt: "desc" },
        include: { requestingAgent: { select: { id: true, name: true, slug: true } }, task: { select: { id: true, title: true } } },
      },
    },
  });
  if (!project) throw new HttpError(404, "Project not found");
  const agents = new Map<number, NonNullable<(typeof project.tasks)[number]["assignedAgent"]>>();
  for (const t of project.tasks) if (t.assignedAgent) agents.set(t.assignedAgent.id, t.assignedAgent);
  res.json({ ...project, agents: [...agents.values()], preview: previewInfo(project.id) });
}));

projectsRouter.post("/", writers, wrap(async (req, res) => {
  const p = await createProject(projectInput.parse(req.body));
  await audit("CEO", req.user!.id, "PROJECT_CREATED", `project:${p.slug}`, { category: p.category });
  res.status(201).json(p);
}));

projectsRouter.patch("/:id", writers, wrap(async (req, res) => {
  const id = idParam(req);
  const b = z.object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(5000).optional(),
    techStack: z.string().max(300).optional(),
    repoPath: z.string().max(300).optional(),
    gitBranch: z.string().max(100).optional(),
    status: z.enum(["PLANNING", "IN_PROGRESS", "REVIEW", "COMPLETED", "FROZEN"]).optional(),
    progressPercent: z.number().int().min(0).max(100).optional(),
  }).parse(req.body);
  const before = await prisma.project.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, "Project not found");
  const p = await prisma.project.update({ where: { id }, data: b });
  await audit("CEO", req.user!.id, "PROJECT_UPDATED", `project:${p.slug}`, { changed: b, previousStatus: before.status });
  res.json(p);
}));

/* ---------------- Workspace operations (shared with the Discord bot via services/ops) ---------------- */

const portalActor = (req: import("express").Request): OpsActor => ({ actorType: "CEO", actorId: String(req.user!.id), approverId: req.user!.id });

projectsRouter.get("/:id/preview", wrap(async (req, res) => { res.json({ preview: previewInfo(idParam(req)) }); }));
projectsRouter.post("/:id/preview", writers, wrap(async (req, res) => {
  const job = await startPreviewJob(idParam(req), portalActor(req));
  res.status(202).json({ jobId: job.id });
}));
projectsRouter.delete("/:id/preview", writers, wrap(async (req, res) => {
  res.json({ stopped: !!(await stopProjectPreview(idParam(req), portalActor(req))) });
}));

projectsRouter.get("/:id/download", writers, wrap(async (req, res) => {
  await withProjectZip(idParam(req), portalActor(req), z => new Promise<void>((resolve, reject) => {
    res.download(z.file, z.name, err => (err ? reject(err) : resolve()));
  }));
}));

projectsRouter.post("/:id/github", writers, wrap(async (req, res) => {
  const { visibility } = z.object({ visibility: z.enum(["private", "public"]) }).parse(req.body);
  const job = await githubPushJob(idParam(req), visibility, portalActor(req));
  res.status(202).json({ jobId: job.id });
}));

projectsRouter.post("/:id/auto-build", writers, wrap(async (req, res) => {
  const { goal } = z.object({ goal: z.string().min(5).max(3000) }).parse(req.body);
  const job = await autoBuildJob(idParam(req), goal, portalActor(req));
  res.status(202).json({ jobId: job.id });
}));

projectsRouter.post("/:id/handoff", writers, wrap(async (req, res) => {
  res.status(201).json(await queueHandoff(idParam(req), portalActor(req)));
}));
