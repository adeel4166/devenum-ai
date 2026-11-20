"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";

type Kind = "success" | "error" | "info";
interface Toast { id: number; kind: Kind; text: string }
interface Ctx {
  toast: (kind: Kind, text: string) => void;
  /** Runs an async action, shows a success/error toast, returns true on success. */
  run: <T>(fn: () => Promise<T>, successText?: string) => Promise<T | undefined>;
}
const ToastCtx = createContext<Ctx>(null as never);
export const useToast = () => useContext(ToastCtx);

let counter = 0;
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((kind: Kind, text: string) => {
    const id = ++counter;
    setItems(s => [...s, { id, kind, text }]);
    setTimeout(() => setItems(s => s.filter(t => t.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  const run = useCallback(async <T,>(fn: () => Promise<T>, successText?: string) => {
    try {
      const r = await fn();
      if (successText) toast("success", successText);
      return r;
    } catch (e) {
      toast("error", (e as Error).message);
      return undefined;
    }
  }, [toast]);

  const icon = { success: <CheckCircle2 size={16} className="text-emerald-400" />, error: <XCircle size={16} className="text-rose-400" />, info: <Info size={16} className="text-sky-400" /> };
  return (
    <ToastCtx.Provider value={{ toast, run }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className="toast-in pointer-events-auto flex items-start gap-2.5 rounded-lg border border-white/10 bg-ink-800 px-3.5 py-3 text-sm text-slate-100 shadow-xl shadow-black/40">
            <span className="mt-0.5">{icon[t.kind]}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
