"use client";
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
  EXPIRED: "bg-slate-500/20 text-slate-400", DONE: "bg-emerald-500/15 text-emerald-300",
  IN_PROGRESS: "bg-sky-500/15 text-sky-300", IN_REVIEW: "bg-violet-500/15 text-violet-300",
};

export function Badge({ value, text }: { value: string; text?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[value] ?? "bg-white/10 text-slate-300"}`}>
      {text ?? label(value)}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={`card max-h-[90vh] w-full overflow-y-auto p-5 ${wide ? "max-w-2xl" : "max-w-lg"}`} onMouseDown={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10" aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
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

export function Field({ label: l, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="label">{l}</label>{children}</div>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
      <div className="h-full rounded-full bg-gradient-to-r from-brand to-sky-400 transition-all" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export const providerName = (p: string) => (p === "CLAUDE_CODE" ? "Claude Code" : p === "GEMINI_API" ? "Gemini API" : p);
