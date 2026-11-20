import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { requireAuth } from "./auth";
import { errorHandler } from "./http";
import { authRouter } from "./routes/auth";
import { agentsRouter } from "./routes/agents";
import { projectsRouter } from "./routes/projects";
import { tasksRouter } from "./routes/tasks";
import { approvalsRouter } from "./routes/approvals";
import { logsRouter } from "./routes/logs";
import { systemRouter } from "./routes/system";

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET missing — copy .env.example to .env");

const app = express();
app.use(helmet());
app.use(cors({ origin: (process.env.CORS_ORIGIN || "http://localhost:4201").split(",") }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "devenum-backend" }));
app.use("/api/auth", authRouter);
app.use("/api/agents", requireAuth, agentsRouter);
app.use("/api/projects", requireAuth, projectsRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/approvals", requireAuth, approvalsRouter);
app.use("/api/logs", requireAuth, logsRouter);
app.use("/api/system", requireAuth, systemRouter);
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

const port = Number(process.env.PORT || 4200);
app.listen(port, () => console.log(`Devenum backend listening on http://localhost:${port}`));
