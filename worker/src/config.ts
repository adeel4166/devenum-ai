import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

// worker/.env first, then fall back to the backend's .env for the shared DATABASE_URL.
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../backend/.env") });

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing (set it in worker/.env or backend/.env)");

export const config = {
  workspacesDir: process.env.WORKSPACES_DIR || "/opt/devenum-ai/workspaces",
  runAsUser: process.env.RUN_AS_USER || "devenum",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  claudeBin: process.env.CLAUDE_BIN || "claude",
  claudeModel: process.env.CLAUDE_MODEL || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-pro",
  /** Marker prefix on AgentRun.logs so the worker can recognise its own runs after a restart. */
  logMarker: "[devenum-worker]",
};

export const prisma = new PrismaClient();

/** Mirrors backend/src/routes/system.ts DEFAULT_SETTINGS. */
const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  claudeCliEnabled: true,
  autoExpireHours: 48,
  globalPaused: false,
  maxConcurrentAgents: 3,
  maxStepsPerRun: 50,
  maxRunTimeoutSeconds: 1800,
};
export type Settings = typeof DEFAULT_SETTINGS;

export async function loadSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.keys(DEFAULT_SETTINGS) } } });
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s as Settings;
}

export const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) =>
  console[level === "info" ? "log" : level](JSON.stringify({ ts: new Date().toISOString(), level, service: "devenum-worker", msg, ...extra }));
