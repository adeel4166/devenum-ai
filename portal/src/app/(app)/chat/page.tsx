"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ArrowUp, Copy, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { runJob } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { AgentAvatar } from "@/components/ui";

interface Msg { role: "user" | "assistant"; content: string; error?: boolean }
const STORE = "devenum_chat_thread";
const HISTORY_SENT = 8; // matches the backend's per-conversation memory

const STARTERS = [
  "Help me scope an MVP for a booking app for barbershops",
  "Compare Next.js vs. Remix for our next client site",
  "Turn this idea into a clear auto-build goal: a habit tracker with streaks",
  "What should our QA engineer test before a launch?",
];

function ChatInner() {
  const params = useSearchParams();
  const { user } = useSession();
  const { toast } = useToast();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { // restore thread; append a Quick Ask hand-off from the Command Center
    let thread: Msg[] = [];
    try { thread = JSON.parse(window.localStorage.getItem(STORE) || "[]"); } catch { /* ignore */ }
    if (params.get("continue")) {
      try {
        const h = JSON.parse(window.localStorage.getItem("devenum_chat_handoff") || "[]") as Msg[];
        if (h.length) thread = [...thread, ...h];
        window.localStorage.removeItem("devenum_chat_handoff");
      } catch { /* ignore */ }
    }
    setMsgs(thread);
  }, [params]);
  useEffect(() => {
    try { window.localStorage.setItem(STORE, JSON.stringify(msgs.slice(-60))); } catch { /* ignore */ }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs]);
  useEffect(() => {
    const t = taRef.current; if (!t) return;
    t.style.height = "auto"; t.style.height = `${Math.min(200, t.scrollHeight)}px`;
  }, [text]);

  async function send(content?: string) {
    const q = (content ?? text).trim();
    if (!q || busy) return;
    const history = msgs.filter(m => !m.error).slice(-HISTORY_SENT).map(m => ({ role: m.role, content: m.content }));
    setMsgs(m => [...m, { role: "user", content: q }]);
    setText(""); setBusy(true);
    try {
      const r = await runJob<{ reply: string }>("/chat", { message: q, history }, undefined, 150_000);
      setMsgs(m => [...m, { role: "assistant", content: r.reply }]);
    } catch (e) {
      setMsgs(m => [...m, { role: "assistant", content: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
      taRef.current?.focus();
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-7.5rem)] max-w-3xl flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AgentAvatar slug="executive-assistant" size={36} />
          <div>
            <h1 className="font-semibold text-white">Executive Assistant</h1>
            <p className="text-xs text-slate-500">Brainstorm, ask technical questions, refine specs. Read-only — it never changes code.</p>
          </div>
        </div>
        {!!msgs.length && <button className="btn-ghost !py-1 text-xs" onClick={() => setMsgs([])} disabled={busy}><RotateCcw size={13} /> New chat</button>}
      </div>

      <div className="flex-1 overflow-y-auto rounded-2xl border border-white/[0.06] bg-ink-900/60 px-3 py-4 sm:px-6">
        {!msgs.length ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand"><Sparkles size={22} /></div>
            <h2 className="text-lg font-semibold text-white">Good to see you{user?.name ? `, ${user.name.split(" ")[0]}` : ""}.</h2>
            <p className="mt-1 max-w-md text-sm text-slate-400">I&apos;m your Executive Assistant. I remember the last few messages of this conversation.</p>
            <div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">
              {STARTERS.map(s => <button key={s} onClick={() => send(s)} className="rounded-xl border border-white/10 bg-ink-800 p-3 text-left text-sm text-slate-300 transition hover:border-brand/40 hover:text-white">{s}</button>)}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {msgs.map((m, i) => m.role === "user" ? (
              <div key={i} className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-white/[0.08] px-4 py-2.5 text-[15px] text-slate-100">{m.content}</div></div>
            ) : (
              <div key={i} className="group flex gap-3">
                <AgentAvatar slug="executive-assistant" size={28} />
                <div className="min-w-0 flex-1">
                  {m.error ? <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{m.content}</p> : <Markdown text={m.content} />}
                  {!m.error && (
                    <button className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500 opacity-0 transition hover:text-slate-300 group-hover:opacity-100"
                      onClick={() => navigator.clipboard.writeText(m.content).then(() => toast("success", "Copied"))}><Copy size={12} /> Copy</button>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-3 text-sm text-slate-400"><AgentAvatar slug="executive-assistant" size={28} /><span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Thinking…</span></div>}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <form onSubmit={e => { e.preventDefault(); send(); }} className="mt-3 rounded-2xl border border-white/10 bg-ink-800 p-2 shadow-glow focus-within:border-brand/50">
        <textarea ref={taRef} rows={1} value={text} onChange={e => setText(e.target.value)} placeholder="Message your Executive Assistant…" aria-label="Message"
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          className="w-full resize-none bg-transparent px-3 py-2 text-[15px] text-slate-100 placeholder:text-slate-500 focus:outline-none" />
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] text-slate-500">Enter to send · Shift+Enter for a new line</span>
          <button type="submit" disabled={busy || !text.trim()} className="grid h-8 w-8 place-items-center rounded-xl bg-brand text-white transition hover:bg-brand-soft disabled:opacity-40" aria-label="Send">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={17} />}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ChatPage() {
  return <Suspense fallback={null}><ChatInner /></Suspense>;
}
