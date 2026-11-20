"use client";
import { useEffect } from "react";
import { X } from "lucide-react";
import { label } from "@/lib/api";

const TONES: Record<string, string> = {
  AVAILABLE: "bg-emerald-500/15 text-emerald-300", RUNNING: "bg-sky-500/15 text-sky-300",
  WAITING_APPROVAL: "bg-amber-500/15 text-amber-300", AWAITING_APPROVAL: "bg-amber-500/15 text-amber-300",
  BLOCKED: "bg-rose-500/15 text-rose-300", PAUSED: "bg-slate-500/20 text-slate-300",
  FAILED: "bg-rose-500/15 text-rose-300", DISABLED: "bg-slate-600/20 text-slate-500",
  LOW: "bg-emerald-500/15 text-emerald-300", MEDIUM: "bg-amber-500/15 text-amber-300", HIGH: "bg-rose-500/15 text-rose-300",
  CRITICAL: "bg-fuchsia-500/20 text-fuchsia-300", SUCCEEDED: "bg-emerald-500/15 text-emerald-300",
  QUEUED: "bg-slate-500/20 text-slate-300", CANCELLED: "bg-slate-500/20 text-slate-300",
  APPROVED: "bg-emerald-500/15 text-emerald-300", REJECTED: "bg-rose-500/15 text-rose-300",
  CHANGES_REQUESTED: "bg-amber-500/15 text-amber-300", PENDING: "bg-amber-500/15 text-amber-300",
  EXPIRED: "bg-slate-500/20 text-slate-400", DONE: "bg-emerald-500/15 text-emerald-300", COMPLETED: "bg-emerald-500/15 text-emerald-300",
  IN_PROGRESS: "bg-sky-500/15 text-sky-300", IN_REVIEW: "bg-violet-500/15 text-violet-300", REVIEW: "bg-violet-500/15 text-violet-300",
  PLANNING: "bg-slate-500/20 text-slate-300", FROZEN: "bg-cyan-500/15 text-cyan-300", READY: "bg-indigo-500/15 text-indigo-300", BACKLOG: "bg-slate-500/20 text-slate-300",
};
const DOTS: Record<string, string> = {
  RUNNING: "bg-sky-400", AVAILABLE: "bg-emerald-400", WAITING_APPROVAL: "bg-amber-400", BLOCKED: "bg-rose-400", FAILED: "bg-rose-400", PAUSED: "bg-slate-400", DISABLED: "bg-slate-600",
};

/** Status badge. RUNNING gets an animated pulse dot; other agent statuses a static dot. */
export function Badge({ value, text, dot }: { value: string; text?: string; dot?: boolean }) {
  const showDot = dot ?? (value in DOTS && ["RUNNING", "AVAILABLE", "WAITING_APPROVAL", "BLOCKED", "FAILED", "PAUSED", "DISABLED"].includes(value));
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[value] ?? "bg-white/10 text-slate-300"}`}>
      {showDot && (
        <span className="relative flex h-2 w-2">
          {value === "RUNNING" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${DOTS[value] ?? "bg-slate-400"}`} />
        </span>
      )}
      {text ?? label(value)}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-white/5 ${className}`} />;
}
export const CardSkeletons = ({ n = 6, h = "h-40" }: { n?: number; h?: string }) => (
  <>{Array.from({ length: n }).map((_, i) => <Skeleton key={i} className={h} />)}</>
);

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-label={title} className={`card max-h-[90vh] w-full overflow-y-auto p-5 ${wide ? "max-w-3xl" : "max-w-lg"}`} onMouseDown={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10" aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onMouseDown={onClose}>
      <aside role="dialog" aria-label={title} onMouseDown={e => e.stopPropagation()}
        className="drawer-in absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-ink-900 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-white">{title}</h2>
            {subtitle && <div className="mt-1 text-xs text-slate-400">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{message}</div>;
}

export function Field({ label: l, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div><label className="label">{l}</label>{children}{hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}</div>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-gradient-to-r from-brand to-sky-400 transition-all" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="flex rounded-lg border border-white/10 p-0.5 text-sm">
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} className={`rounded-md px-3 py-1 transition ${value === t.id ? "bg-brand text-white" : "text-slate-400 hover:text-slate-200"}`}>
          {t.label}{t.count != null && <span className="ml-1.5 text-xs opacity-70">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Terminal({ text }: { text: string }) {
  return <pre className="max-h-96 overflow-auto rounded-lg border border-white/5 bg-black/60 p-3 font-mono text-xs leading-relaxed text-emerald-300/90 whitespace-pre-wrap">{text}</pre>;
}

export const providerName = (p: string) => (p === "CLAUDE_CODE" ? "Claude Code" : p === "GEMINI_API" ? "Gemini API" : p);
