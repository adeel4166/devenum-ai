import { Router } from "express";
import { z } from "zod";
import { wrap } from "../http";
import { chatReply, ChatTurn } from "../services/chat";
import { getJob, startJob } from "../services/jobs";

export const chatTurns = z.array(z.object({
  role: z.enum(["user", "assistant"]), author: z.string().max(80).optional(), content: z.string().max(8000),
})).max(20).default([]);

/** Runs a chat turn as a background job and returns { jobId }; the reply arrives via GET /api/jobs/:id. */
export function startChatJob(message: string, history: ChatTurn[], author: string, surface: "Discord" | "the Devenum AI web portal") {
  return startJob("chat", async () => {
    const r = await chatReply(message, history, author, surface);
    if (!r.ok) throw new Error(r.timedOut ? "The assistant took longer than 60 seconds. Try a narrower question." : `Claude Code error: ${r.text.slice(0, 300)}`);
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
