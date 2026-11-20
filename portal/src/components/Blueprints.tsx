"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Briefcase, LayoutDashboard, Loader2, Mail, Rocket, ShoppingBag } from "lucide-react";
import { api, Project, runJob } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { Field, HelpText, Modal } from "./ui";

/** One-click starter templates: name + brand brief → new project + multi-agent auto-build pipeline. */
const BLUEPRINTS = [
  { id: "saas", title: "SaaS Landing + Waitlist", icon: Mail, color: "from-violet-500 to-indigo-600", stack: "Next.js, Tailwind CSS, SQLite",
    blurb: "Hero, features, pricing, FAQ and a waitlist form that stores sign-ups.",
    goal: (b: string) => `Build a conversion-focused SaaS marketing site with a working waitlist. Sections: hero with clear value proposition and CTA, features grid, how-it-works, pricing (3 tiers), testimonials placeholder, FAQ, footer. The waitlist form validates email, stores sign-ups server-side and shows a success state; add a simple protected admin page listing sign-ups. Responsive, accessible, fast. Brand brief: ${b}` },
  { id: "shop", title: "E-Commerce Storefront", icon: ShoppingBag, color: "from-emerald-500 to-teal-600", stack: "Next.js, Tailwind CSS, Prisma, SQLite",
    blurb: "Catalog, product pages, cart and a mock checkout with orders.",
    goal: (b: string) => `Build an e-commerce storefront: product catalog with categories, search and filters; product detail pages; persistent cart; checkout flow with a mock payment step that creates orders; order confirmation page; seed data with sample products. Responsive and accessible. Brand brief: ${b}` },
  { id: "admin", title: "Admin Dashboard + API", icon: LayoutDashboard, color: "from-sky-500 to-blue-600", stack: "React, Vite, Express, SQLite",
    blurb: "REST API with auth and a dashboard with tables, forms and charts.",
    goal: (b: string) => `Build an admin dashboard with a REST API: Express API with JWT auth, CRUD endpoints for the main entities implied by the brief, validation and error handling; React dashboard with login, sidebar navigation, data tables with search/pagination, create/edit forms, and a KPI overview with simple charts. Include seed data and API tests. Brand brief: ${b}` },
  { id: "portfolio", title: "Agency Portfolio", icon: Briefcase, color: "from-[#d97757] to-[#f0a35e]", stack: "Astro or Next.js, Tailwind CSS",
    blurb: "Showcase work, services, team and a contact form.",
    goal: (b: string) => `Build a polished agency portfolio website: hero, services, case-study grid with detail pages, team, client logos, testimonials, and a contact form with validation. Strong typography, subtle animations, SEO meta tags and Open Graph images, fully responsive. Brand brief: ${b}` },
] as const;

export function Blueprints({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const { canWrite, refreshProjects } = useSession();
  const { toast } = useToast();
  const [open, setOpen] = useState<(typeof BLUEPRINTS)[number] | null>(null);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  async function launch(e: React.FormEvent) {
    e.preventDefault();
    if (!open) return;
    setBusy(true);
    try {
      setProgress("Creating project…");
      const p = await api<Project>("/projects", { method: "POST", body: { name: name.trim(), category: "WEB", techStack: open.stack, description: `${open.title}. ${brief.trim()}`.slice(0, 5000) } });
      await refreshProjects();
      const r = await runJob<{ tasks: unknown[] }>(`/projects/${p.id}/auto-build`, { goal: open.goal(brief.trim()) }, setProgress);
      toast("success", `${name} launched — ${r.tasks.length} sequential tasks queued`);
      router.push(`/projects/${p.id}`);
    } catch (err) { toast("error", (err as Error).message); } finally { setBusy(false); setProgress(null); }
  }

  if (!canWrite) return null;
  return (
    <section>
      <div className="mb-3">
        <h2 className="font-semibold text-white">Start from a blueprint</h2>
        <p className="text-xs text-slate-500">Give it a name and a brand brief — the agents plan and build it step by step. You approve every step.</p>
      </div>
      <div className={`grid gap-3 ${compact ? "grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 xl:grid-cols-4"}`}>
        {BLUEPRINTS.map(b => (
          <button key={b.id} onClick={() => { setOpen(b); setName(""); setBrief(""); }} className="card card-hover flex flex-col items-start gap-2 p-4 text-left">
            <span className={`grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br ${b.color} text-white`}><b.icon size={17} /></span>
            <span className="text-sm font-semibold text-white">{b.title}</span>
            {!compact && <span className="text-xs text-slate-400">{b.blurb}</span>}
            <span className="mt-auto text-[11px] text-slate-500">{b.stack}</span>
          </button>
        ))}
      </div>
      {open && (
        <Modal title={`Launch: ${open.title}`} onClose={() => !busy && setOpen(null)}>
          <form onSubmit={launch} className="space-y-4">
            <HelpText>{open.blurb} Suggested stack: {open.stack}. The Project Manager turns this into 3–5 sequential tasks; nothing is merged without your approval.</HelpText>
            <Field label="Project name"><input className="input" required minLength={2} maxLength={120} autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Brewly" /></Field>
            <Field label="Brand brief" hint="Audience, tone, colours, must-have pages or features.">
              <textarea className="input min-h-[120px]" required minLength={10} maxLength={2000} value={brief} onChange={e => setBrief(e.target.value)} placeholder="e.g. Specialty coffee subscription for remote workers. Warm, playful tone; cream + espresso brown palette." />
            </Field>
            {progress && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> {progress}</p>}
            <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" disabled={busy} onClick={() => setOpen(null)}>Cancel</button><button className="btn-primary" disabled={busy || name.trim().length < 2 || brief.trim().length < 10}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Rocket size={15} />} Launch pipeline</button></div>
          </form>
        </Modal>
      )}
    </section>
  );
}
