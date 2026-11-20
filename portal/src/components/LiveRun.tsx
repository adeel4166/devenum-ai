"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Radio } from "lucide-react";
import { api, fmtMs, Task } from "@/lib/api";
import { AgentAvatar, Badge, Drawer, Skeleton } from "./ui";

interface RunLogs { id: number; status: string; logs: string; errorMessage: string | null; elapsedMs: number; agent: { name: string; slug: string }; task: { id: number; title: string } | null }

/** "Watch Live": polls the task's latest agent run every 2s and tails its stdout/stderr. */
export function LiveRunDrawer({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const [runId, setRunId] = useState<number | null>(null);
  const [run, setRun] = useState<RunLogs | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Task>(`/tasks/${taskId}`).then(t => {
      const latest = t.runs?.[0];
      if (latest) setRunId(latest.id); else setErr("This task has no agent runs yet — it starts as soon as its agent is free.");
    }).catch(e => setErr((e as Error).message));
  }, [taskId]);

  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<RunLogs>(`/runs/${runId}/logs`);
        if (stop) return;
        setRun(r);
        if (r.status === "RUNNING") setTimeout(tick, 2000);
      } catch (e) { if (!stop) setErr((e as Error).message); }
    };
    tick();
    return () => { stop = true; };
  }, [runId]);
  useEffect(() => { if (follow) endRef.current?.scrollIntoView({ block: "end" }); }, [run?.logs, follow]);

  const live = run?.status === "RUNNING";
  return (
    <Drawer title={run?.task ? `Task #${run.task.id}: ${run.task.title}` : `Task #${taskId}`} onClose={onClose}
      subtitle={run ? <span className="flex items-center gap-2"><AgentAvatar slug={run.agent.slug} size={18} working={live} /> {run.agent.name} · <Badge value={run.status} /> · {fmtMs(run.elapsedMs)}</span> : "Loading run…"}>
      {err && <p className="rounded-lg bg-white/5 p-3 text-sm text-slate-300">{err}</p>}
      {!run && !err && <Skeleton className="h-96" />}
      {run && (
        <>
          <div className="mb-2 flex items-center justify-between text-xs">
            {live ? <span className="flex items-center gap-1.5 text-sky-300"><Radio size={13} className="animate-pulse" /> Live — refreshing every 2 s</span> : <span className="text-slate-400">Run finished{run.errorMessage ? ` — ${run.errorMessage.slice(0, 120)}` : ""}</span>}
            <label className="flex items-center gap-1.5 text-slate-400"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} className="accent-[#d97757]" /> Follow output</label>
          </div>
          <pre className="max-h-[calc(100vh-12rem)] overflow-auto whitespace-pre-wrap rounded-xl border border-white/5 bg-black/70 p-3 font-mono text-xs leading-relaxed text-emerald-200/90">
            {run.logs || "Waiting for output…"}
            {live && <span className="inline-flex items-center gap-1 text-sky-300"><Loader2 size={11} className="animate-spin" /> working…</span>}
            <div ref={endRef} />
          </pre>
        </>
      )}
    </Drawer>
  );
}
