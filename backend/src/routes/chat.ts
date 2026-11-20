import { Router } from "express";
import { z } from "zod";
import { wrap } from "../http";
import { ChatAttachment, chatReply, ChatTurn } from "../services/chat";
import { getJob, startJob } from "../services/jobs";

export const chatTurns = z.array(z.object({
  role: z.enum(["user", "assistant"]), author: z.string().max(80).optional(), content: z.string().max(8000),
})).max(24).default([]);

/** Runs a chat turn as a background job and returns { jobId }; the reply arrives via GET /api/jobs/:id. */
export const chatAttachments = z.array(z.object({
  name: z.string().max(200), path: z.string().regex(/^\/tmp\/devenum-chat-\d+(-[a-z0-9]+)?\/[^/]+$/), kind: z.string().max(20),
  size: z.number().int().min(0), text: z.string().max(60_000).optional(), truncated: z.boolean().optional(), note: z.string().max(300).optional(),
})).max(6).default([]);

export function startChatJob(message: string, history: ChatTurn[], author: string, surface: "Discord" | "the Devenum AI web portal", files: ChatAttachment[] = [], dir?: string, agentSlug?: string) {
  return startJob("chat", async () => {
    const r = await chatReply(message, history, author, surface, files, dir, agentSlug);
    if (!r.ok) throw new Error(r.timedOut ? "The assistant ran out of time (5 minute limit). Try splitting the request into smaller questions." : `Claude Code error: ${r.text.slice(0, 300)}`);
    return { reply: r.text, ms: r.ms };
  });
}

export const chatRouter = Router();
chatRouter.post("/", wrap(async (req, res) => {
  const b = z.object({ message: z.string().trim().min(1).max(8000), history: chatTurns }).parse(req.body);
  const job = startChatJob(b.message, b.history, req.user!.name, "the Devenum AI web portal");
  res.status(202).json({ jobId: job.id });
}));

export const jobsRouter = Router();
jobsRouter.get("/:id", wrap(async (req, res) => {
  const job = getJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  res.json(job);
}));
