import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { requireAuth } from "./auth";
import { errorHandler } from "./http";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { agentsRouter } from "./routes/agents";
import { projectsRouter } from "./routes/projects";
import { tasksRouter } from "./routes/tasks";
import { approvalsRouter, proposalsRouter } from "./routes/approvals";
import { botRouter } from "./routes/bot";
import { requireServiceToken } from "./serviceAuth";
import { chatRouter, jobsRouter } from "./routes/chat";
import { analyticsRouter, quotesRouter, reportsRouter, runsRouter, systemOpsRouter } from "./routes/ops";
import { restorePreviews } from "./services/preview";
import { agentAvatarPng } from "./services/avatar";
import { logsRouter } from "./routes/logs";
import { systemRouter } from "./routes/system";

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing — copy .env.example to .env");

const app = express();
app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGIN || "http://localhost:4201").split(",") }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "devenum-backend" }));
// Public agent avatars for Discord webhooks (served at https://<host>/api/avatars/<slug>.png through nginx).
app.get("/avatars/:file", (req, res) => {
  const m = /^([a-z0-9][a-z0-9-]{0,60})\.png$/.exec(String(req.params.file));
  if (!m) return res.status(404).end();
  res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", "Cross-Origin-Resource-Policy": "cross-origin" }).send(agentAvatarPng(m[1]));
});
app.use("/api/auth", authRouter);
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/agents", requireAuth, agentsRouter);
app.use("/api/projects", requireAuth, projectsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/approvals", requireAuth, approvalsRouter);
app.use("/api/proposals", requireAuth, proposalsRouter);
app.use("/api/chat", requireAuth, chatRouter);
app.use("/api/jobs", requireAuth, jobsRouter);
app.use("/api/runs", requireAuth, runsRouter);
app.use("/api/quotes", requireAuth, quotesRouter);
app.use("/api/analytics", requireAuth, analyticsRouter);
app.use("/api/reports", requireAuth, reportsRouter);
app.use("/api/system", requireAuth, systemOpsRouter);
// Internal service API for devenum-bot (shared BOT_SERVICE_TOKEN, not a user JWT).
app.use("/api/bot", requireServiceToken, botRouter);
app.use("/api/logs", requireAuth, logsRouter);
// /api/system holds settings, status and dashboard; /api/settings is the spec-friendly alias for it.
app.use("/api/system", requireAuth, systemRouter);
app.use("/api/settings", requireAuth, (req, res, next) => { req.url = `/settings${req.url === "/" ? "" : req.url}`; systemRouter(req, res, next); });
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

const port = Number(process.env.PORT || 4200);
app.listen(port, () => console.log(`Devenum backend listening on http://localhost:${port}`));
// Preview servers outlive backend restarts; re-adopt the ones still running.
restorePreviews().catch(e => console.error(JSON.stringify({ level: "warn", message: `preview restore failed: ${(e as Error).message}` })));
