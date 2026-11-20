import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireRole } from "../auth";
import { audit } from "../audit";
import { HttpError, idParam, wrap } from "../http";
import { pinDecision, setFrozen, autoBuildJob, deleteProject, deployJob, githubConfigured, githubPushJob, OpsActor, previewInfo, queueHandoff, startPreviewJob, stopProjectDeploy, stopProjectPreview, withProjectZip } from "../services/ops";
import { fileTree, readEnv, readFile, requireWorkspace, workspaceExists, writeEnv, writeFileAsCeo } from "../services/workspace";
import { liveStatus } from "../services/deploy";

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
    return { ...p, taskCounts, lastActivityAt: (lastRun ?? p.createdAt).toISOString?.() ?? p.createdAt, preview: previewInfo(p.id), workspaceExists: workspaceExists(p.slug) };
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
  res.json({ ...project, agents: [...agents.values()], preview: previewInfo(project.id), workspaceExists: workspaceExists(project.slug), live: project.liveUrl ? await liveStatus(project.slug) : null });
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

/* ---------------- Delete, deploy, env, files ---------------- */

projectsRouter.delete("/:id", requireRole("CEO"), wrap(async (req, res) => {
  res.json(await deleteProject(idParam(req), portalActor(req)));
}));

projectsRouter.post("/:id/deploy", requireRole("CEO"), wrap(async (req, res) => {
  res.status(202).json({ jobId: (await deployJob(idParam(req), portalActor(req))).id });
}));
projectsRouter.post("/:id/deploy-stop", requireRole("CEO"), wrap(async (req, res) => {
  res.json(await stopProjectDeploy(idParam(req), portalActor(req)));
}));

const projectWs = async (req: import("express").Request) => {
  const p = await prisma.project.findUnique({ where: { id: idParam(req) } });
  if (!p) throw new HttpError(404, "Project not found");
  return { project: p, ws: requireWorkspace(p.slug) };
};

projectsRouter.get("/:id/env", writers, wrap(async (req, res) => {
  const { ws } = await projectWs(req);
  res.json({ vars: readEnv(ws) });
}));
projectsRouter.put("/:id/env", writers, wrap(async (req, res) => {
  const { vars } = z.object({ vars: z.array(z.object({ key: z.string().min(1).max(120), value: z.string().max(10000) })).max(300) }).parse(req.body);
  const { project, ws } = await projectWs(req);
  const n = await writeEnv(ws, vars);
  await audit("CEO", req.user!.id, "PROJECT_ENV_UPDATED", `project:${project.slug}`, { keys: vars.map(v => v.key) }); // never the values
  res.json({ saved: n });
}));

projectsRouter.get("/:id/files", wrap(async (req, res) => {
  const { ws } = await projectWs(req);
  res.json(fileTree(ws));
}));
projectsRouter.get("/:id/file", wrap(async (req, res) => {
  const { ws } = await projectWs(req);
  const rel = String(req.query.path ?? "");
  if (/(^|\/)\.env(\.|$)/.test(rel) && !rel.endsWith(".env.example")) throw new HttpError(403, "Use the Environment tab to view .env secrets");
  res.json(readFile(ws, rel));
}));
projectsRouter.put("/:id/file", requireRole("CEO"), wrap(async (req, res) => {
  const b = z.object({ path: z.string().min(1).max(500), content: z.string().max(1024 * 1024) }).parse(req.body);
  const { project, ws } = await projectWs(req);
  const r = await writeFileAsCeo(project.id, ws, b.path, b.content, req.user!.name);
  await audit("CEO", req.user!.id, "FILE_EDITED", `project:${project.slug}`, { path: r.path, commit: r.commit });
  res.json(r);
}));

/* ---------------- Pinned decisions & freeze ---------------- */

projectsRouter.get("/:id/decisions", wrap(async (req, res) => {
  res.json(await prisma.projectDecision.findMany({ where: { projectId: idParam(req) }, orderBy: { createdAt: "desc" } }));
}));
projectsRouter.post("/:id/decisions", writers, wrap(async (req, res) => {
  const b = z.object({ title: z.string().trim().min(2).max(190), decision: z.string().trim().min(2).max(20000), rationale: z.string().trim().max(5000).optional() }).parse(req.body);
  res.status(201).json(await pinDecision(idParam(req), b, req.user!.name, portalActor(req)));
}));
projectsRouter.delete("/:id/decisions/:decisionId", writers, wrap(async (req, res) => {
  const projectId = idParam(req), decisionId = Number(req.params.decisionId);
  const d = await prisma.projectDecision.findFirst({ where: { id: decisionId, projectId } });
  if (!d) throw new HttpError(404, "Decision not found");
  await prisma.projectDecision.delete({ where: { id: d.id } });
  await audit("CEO", req.user!.id, "DECISION_UNPINNED", `project:${projectId}`, { decisionId, title: d.title });
  res.json({ ok: true });
}));
projectsRouter.post("/:id/freeze", writers, wrap(async (req, res) => {
  const { frozen } = z.object({ frozen: z.boolean() }).parse(req.body);
  res.json(await setFrozen(idParam(req), frozen, portalActor(req)));
}));
