"use client";
import { useEffect } from "react";
import {
  Bot, Brain, Bug, Code2, Compass, Gamepad2, LucideIcon, Palette, Rocket, Server, ShieldCheck, Smartphone, Sparkles, X,
} from "lucide-react";
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
  CHANGES_REQUESTED: "bg-amber-500/15 text-amber-300", INVALIDATED: "bg-rose-500/20 text-rose-200", PENDING: "bg-amber-500/15 text-amber-300",
  EXPIRED: "bg-slate-500/20 text-slate-400", DONE: "bg-emerald-500/15 text-emerald-300", COMPLETED: "bg-emerald-500/15 text-emerald-300",
  IN_PROGRESS: "bg-sky-500/15 text-sky-300", IN_REVIEW: "bg-violet-500/15 text-violet-300", REVIEW: "bg-violet-500/15 text-violet-300",
  NEEDS_RETRY: "bg-orange-500/15 text-orange-300", TIMED_OUT: "bg-orange-500/15 text-orange-300",
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
      <div className="h-full rounded-full bg-gradient-to-r from-brand to-amberx transition-all" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="flex rounded-lg border border-white/10 p-0.5 text-sm">
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} className={`rounded-md px-3 py-1 transition ${value === t.id ? "bg-white/10 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}>
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

/** Monospace pill for git branches, IDs and paths. */
export const Mono = ({ children, title }: { children: React.ReactNode; title?: string }) => <span className="mono-badge" title={title}>{children}</span>;

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand"><Icon size={22} /></div>
      <h3 className="font-semibold text-white">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-400">{text}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function HelpText({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-slate-500">{children}</p>;
}

const AGENT_ICONS: Record<string, { icon: LucideIcon; color: string }> = {
  "project-manager": { icon: Compass, color: "from-amber-500 to-orange-600" },
  "software-architect": { icon: Brain, color: "from-violet-500 to-indigo-600" },
  "ui-ux-designer": { icon: Palette, color: "from-pink-500 to-rose-600" },
  "frontend-developer": { icon: Code2, color: "from-sky-500 to-blue-600" },
  "backend-developer": { icon: Server, color: "from-emerald-500 to-teal-600" },
  "mobile-developer": { icon: Smartphone, color: "from-cyan-500 to-sky-600" },
  "game-developer": { icon: Gamepad2, color: "from-fuchsia-500 to-purple-600" },
  "qa-engineer": { icon: Bug, color: "from-lime-500 to-green-600" },
  "security-engineer": { icon: ShieldCheck, color: "from-red-500 to-rose-700" },
  "devops-engineer": { icon: Rocket, color: "from-orange-500 to-red-600" },
  "executive-assistant": { icon: Sparkles, color: "from-[#d97757] to-[#f0a35e]" },
};

export function AgentAvatar({ slug, size = 40, working }: { slug?: string; size?: number; working?: boolean }) {
  const a = (slug && AGENT_ICONS[slug]) || { icon: Bot, color: "from-stone-500 to-stone-700" };
  return (
    <span className="relative inline-flex shrink-0">
      <span className={`grid place-items-center rounded-xl bg-gradient-to-br ${a.color} text-white shadow-md shadow-black/30`} style={{ width: size, height: size }}>
        <a.icon size={Math.round(size * 0.48)} />
      </span>
      {working && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-ink-800 bg-sky-400" />
        </span>
      )}
    </span>
  );
}

export function StatCard({ label: l, value, hint, icon: Icon, accent, pulse, onClick }: {
  label: string; value: React.ReactNode; hint?: string; icon: LucideIcon; accent: string; pulse?: boolean; onClick?: () => void;
}) {
  return (
    <div onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={e => onClick && (e.key === "Enter" || e.key === " ") && onClick()}
      className={`card relative overflow-hidden p-4 ${onClick ? "card-hover" : ""}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{l}</div>
          <div className="mt-2 text-3xl font-semibold tabular-nums text-white">{value}</div>
          {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
        </div>
        <span className={`relative grid h-10 w-10 place-items-center rounded-xl ${accent}`}>
          {pulse && <span className="absolute inset-0 animate-ping rounded-xl bg-sky-400/30" />}
          <Icon size={19} />
        </span>
      </div>
    </div>
  );
}

export const RISK_TONE: Record<string, string> = {
  LOW: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  MEDIUM: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  HIGH: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

/** "QA Passed" / "QA Warning" badge from the automated pre-approval gate. */
export function QaBadge({ qa, compact }: { qa?: { status: string; score: number } | null; compact?: boolean }) {
  if (!qa) return compact ? null : <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-500">No QA</span>;
  const ok = qa.status === "PASSED";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
      {ok ? "✓ QA Passed" : "⚠ QA Warning"} <span className="tabular-nums opacity-80">{qa.score}</span>
    </span>
  );
}

const dur = (ms: number) => { if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`; const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

/** Queue wait vs active AI work vs CEO review wait for one task. */
export function TimeBreakdown({ t }: { t: { createdAt: string; queuedAt?: string | null; startedAt?: string | null; completedAt?: string | null; approvedAt?: string | null } }) {
  const q = t.queuedAt ?? t.createdAt;
  const ms = (a?: string | null, b?: string | null) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
  const rows = [
    { label: "Queue wait", v: ms(q, t.startedAt), hint: "READY → agent started", tone: "text-indigo-300" },
    { label: "Active AI work", v: ms(t.startedAt, t.completedAt), hint: "started → finished", tone: "text-sky-300" },
    { label: "CEO review wait", v: ms(t.completedAt, t.approvedAt), hint: "finished → approved", tone: "text-amber-300" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/5 bg-black/20 p-3">
      {rows.map(r => (
        <div key={r.label} title={r.hint}>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{r.label}</div>
          <div className={`text-sm font-semibold tabular-nums ${r.v == null ? "text-slate-600" : r.tone}`}>{r.v == null ? "—" : dur(r.v)}</div>
        </div>
      ))}
    </div>
  );
}

/** Live countdown to a proposal's expiry. */
export function ExpiryBadge({ expiresAt, status }: { expiresAt: string; status: string }) {
  if (status !== "PENDING") return null;
  const left = new Date(expiresAt).getTime() - Date.now();
  const tone = left <= 0 ? "border-rose-500/40 text-rose-300" : left < 3 * 3600_000 ? "border-amber-500/40 text-amber-300" : "border-white/10 text-slate-400";
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${tone}`} title={`Expires ${new Date(expiresAt).toLocaleString()}`}>⏳ {left <= 0 ? "expired" : `expires in ${dur(left)}`}</span>;
}

export function HashBadge({ hash, head, status }: { hash?: string | null; head?: string | null; status: string }) {
  if (status === "INVALIDATED") return <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200">⛔ Hash mismatch — invalidated</span>;
  if (!hash) return null;
  return <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 px-2 py-0.5 font-mono text-[10px] text-emerald-300/90" title={`Payload hash ${hash}\nHead ${head ?? "?"}\nRe-verified at approval and merge`}>🔒 {hash.slice(0, 10)}</span>;
}
