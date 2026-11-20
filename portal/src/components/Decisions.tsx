"use client";
import { useState } from "react";
import { BookMarked, Loader2, Pin, Trash2 } from "lucide-react";
import { api, Decision, timeAgo } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { EmptyState, ErrorBox, Field, HelpText, Skeleton } from "./ui";

/** Pinned project decisions — canonical CEO choices injected into every agent prompt for this project. */
export function DecisionsPanel({ projectId, projectName }: { projectId: number; projectName: string }) {
  const { canWrite } = useSession();
  const { toast, run } = useToast();
  const { data, error, reload } = useApi<Decision[]>(`/projects/${projectId}/decisions`);
  const [f, setF] = useState({ title: "", decision: "", rationale: "" });
  const [busy, setBusy] = useState(false);

  async function pin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/projects/${projectId}/decisions`, { method: "POST", body: { title: f.title.trim(), decision: f.decision.trim(), rationale: f.rationale.trim() || undefined } });
      toast("success", "Decision pinned — agents will follow it on every task for this project");
      setF({ title: "", decision: "", rationale: "" });
      reload();
    } catch (err) { toast("error", (err as Error).message); } finally { setBusy(false); }
  }
  async function unpin(d: Decision) {
    if (!window.confirm(`Unpin "${d.title}"? Agents will no longer be told about it.`)) return;
    if (await run(() => api(`/projects/${projectId}/decisions/${d.id}`, { method: "DELETE" }), "Decision unpinned")) reload();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <div>
        <ErrorBox message={error} />
        {!data ? <Skeleton className="h-48" /> : !data.length ? (
          <EmptyState icon={BookMarked} title="No pinned decisions yet" text={`Pin the choices agents must always respect on ${projectName} — tech stack, design rules, API conventions, business constraints. You can also pin from Discord with /decide or the 📌 button on agent replies.`} />
        ) : (
          <ol className="space-y-3">
            {data.map((d, i) => (
              <li key={d.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/15 text-xs font-semibold text-brand-soft">{data.length - i}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-white">{d.title}</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{d.decision}</p>
                    {d.rationale && <p className="mt-1.5 text-xs text-slate-500"><b className="text-slate-400">Why:</b> {d.rationale}</p>}
                    <div className="mt-2 text-[11px] text-slate-500">Pinned by {d.pinnedBy} · {timeAgo(d.createdAt)}</div>
                  </div>
                  {canWrite && <button className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300" onClick={() => unpin(d)} aria-label="Unpin"><Trash2 size={14} /></button>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {canWrite && (
        <form onSubmit={pin} className="card h-fit space-y-4 p-5">
          <h3 className="flex items-center gap-2 font-semibold text-white"><Pin size={15} className="text-brand" /> Pin a decision</h3>
          <HelpText>Pinned decisions are injected into every agent&apos;s prompt for this project, so agents never forget them.</HelpText>
          <Field label="Title"><input className="input" required minLength={2} maxLength={190} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="e.g. Database" /></Field>
          <Field label="Decision"><textarea className="input min-h-[100px]" required minLength={2} maxLength={20000} value={f.decision} onChange={e => setF({ ...f, decision: e.target.value })} placeholder="e.g. Use PostgreSQL via Prisma; no raw SQL in route handlers." /></Field>
          <Field label="Rationale (optional)"><textarea className="input min-h-[60px]" maxLength={5000} value={f.rationale} onChange={e => setF({ ...f, rationale: e.target.value })} /></Field>
          <button className="btn-primary w-full" disabled={busy || f.title.trim().length < 2 || f.decision.trim().length < 2}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Pin size={15} />} Pin decision</button>
        </form>
      )}
    </div>
  );
}
