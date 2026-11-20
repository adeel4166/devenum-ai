"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";
import { api, tokenStore } from "@/lib/api";
import { ErrorBox } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>("/auth/login", { method: "POST", body: { email, password } });
      tokenStore.set(r.token);
      router.replace("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(ellipse_at_top,#1b1f3a,#07090f_60%)] p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand">
            <Bot size={22} className="text-white" />
          </div>
          <div>
            <div className="text-lg font-semibold text-white">Devenum AI</div>
            <div className="text-xs text-slate-400">CEO Command Center</div>
          </div>
        </div>
        <ErrorBox message={error} />
        <label className="label" htmlFor="email">Email</label>
        <input id="email" type="email" required autoComplete="username" className="input mb-4" value={email} onChange={e => setEmail(e.target.value)} placeholder="ceo@devenum.com" />
        <label className="label" htmlFor="pw">Password</label>
        <input id="pw" type="password" required autoComplete="current-password" className="input mb-6" value={password} onChange={e => setPassword(e.target.value)} />
        <button className="btn-primary w-full" disabled={busy}>
          {busy && <Loader2 size={16} className="animate-spin" />} Sign in
        </button>
      </form>
    </main>
  );
}
