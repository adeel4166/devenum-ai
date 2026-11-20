"use client";
import { useState } from "react";
import { Loader2, Newspaper, RefreshCw } from "lucide-react";
import { api, ReportRow, timeAgo } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { useApi } from "@/lib/useApi";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/toast";
import { EmptyState, ErrorBox, PageHeader, Skeleton } from "@/components/ui";

export default function ReportsPage() {
  const { canWrite } = useSession();
  const { toast } = useToast();
  const list = useApi<ReportRow[]>("/reports", 30000);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = selected ?? list.data?.[0]?.id ?? null;
  const report = useApi<ReportRow>(currentId ? `/reports/${currentId}` : null);

  async function generate() {
    setBusy(true);
    try {
      const r = await api<ReportRow>("/reports/generate", { method: "POST" });
      toast("success", "Executive report generated — it will also be posted to Discord");
      await list.reload();
      setSelected(r.id);
    } catch (e) { toast("error", (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title="Executive Reports" subtitle="Your daily CEO digest — generated automatically every evening (21:00 server time) and posted to Discord. Generate one any time."
        action={canWrite && <button className="btn-primary" onClick={generate} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Generate Executive Report Now</button>} />
      <ErrorBox message={list.error} />
      {list.loading && !list.data ? <Skeleton className="h-96" /> : !list.data?.length ? (
        <EmptyState icon={Newspaper} title="No reports yet" text="The first digest is generated tonight at 21:00 server time — or click Generate Executive Report Now." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <ul className="space-y-1">
            {list.data.map(r => (
              <li key={r.id}>
                <button onClick={() => setSelected(r.id)} className={`w-full rounded-xl px-3 py-2 text-left text-sm transition ${currentId === r.id ? "bg-brand/15 text-white" : "text-slate-300 hover:bg-white/5"}`}>
                  <div className="truncate">{r.title.replace("Executive Digest — ", "")}</div>
                  <div className="text-xs text-slate-500">{timeAgo(r.createdAt)} · {r.generatedBy}{r.postedAt ? " · posted" : ""}</div>
                </button>
              </li>
            ))}
          </ul>
          <div className="card p-6">{report.data?.body ? <Markdown text={report.data.body} /> : <Skeleton className="h-80" />}</div>
        </div>
      )}
    </div>
  );
}
