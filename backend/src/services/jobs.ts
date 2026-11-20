import { randomUUID } from "crypto";

/**
 * Tiny in-memory job runner for operations that can outlive nginx's 60s proxy timeout (auto-build planning,
 * npm install for previews, GitHub pushes, chat). POST endpoints return { jobId }; clients poll GET /jobs/:id.
 * Jobs are kept for an hour; they do not survive a backend restart (callers simply retry).
 */
export interface Job<T = unknown> {
  id: string; kind: string; status: "running" | "succeeded" | "failed";
  progress: string | null; result: T | null; error: string | null; createdAt: string; finishedAt: string | null;
}

const jobs = new Map<string, Job>();
const TTL_MS = 3600_000;

export function startJob<T>(kind: string, fn: (progress: (msg: string) => void) => Promise<T>): Job<T> {
  const job: Job<T> = { id: randomUUID(), kind, status: "running", progress: null, result: null, error: null, createdAt: new Date().toISOString(), finishedAt: null };
  jobs.set(job.id, job as Job);
  fn(msg => { job.progress = msg; })
    .then(r => { job.result = r; job.status = "succeeded"; })
    .catch(e => { job.error = (e as Error).message || String(e); job.status = "failed"; })
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}

export const getJob = (id: string) => jobs.get(id) ?? null;

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, j] of jobs) if (new Date(j.createdAt).getTime() < cutoff) jobs.delete(id);
}, 600_000).unref();
