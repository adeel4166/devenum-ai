"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderOpen, Loader2, Pencil, RefreshCw, Save, X } from "lucide-react";
import { api, fmtBytes } from "@/lib/api";
import { Highlighted } from "@/lib/highlight";
import { useSession } from "@/lib/session";
import { useToast } from "./toast";
import { ErrorBox, HelpText, Skeleton } from "./ui";

interface Node { name: string; path: string; type: "dir" | "file"; size?: number; children?: Node[] }
interface FileData { path: string; size: number; binary: boolean; tooLarge: boolean; content: string }

function Tree({ nodes, open, toggle, select, selected, depth = 0 }: {
  nodes: Node[]; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null; depth?: number;
}) {
  return (
    <ul>
      {nodes.map(n => (
        <li key={n.path}>
          <button onClick={() => (n.type === "dir" ? toggle(n.path) : select(n.path))} title={n.path}
            className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] transition ${selected === n.path ? "bg-brand/15 text-white" : "text-slate-300 hover:bg-white/5"}`}
            style={{ paddingLeft: 6 + depth * 14 }}>
            {n.type === "dir" ? (open.has(n.path) ? <ChevronDown size={13} className="shrink-0 text-slate-500" /> : <ChevronRight size={13} className="shrink-0 text-slate-500" />) : <span className="w-[13px] shrink-0" />}
            {n.type === "dir" ? (open.has(n.path) ? <FolderOpen size={14} className="shrink-0 text-amber-300/80" /> : <Folder size={14} className="shrink-0 text-amber-300/80" />)
              : /\.(tsx?|jsx?|py|go|rs|css|html|json|prisma)$/.test(n.name) ? <FileCode2 size={14} className="shrink-0 text-sky-300/80" /> : <File size={14} className="shrink-0 text-slate-500" />}
            <span className="truncate">{n.name}</span>
          </button>
          {n.type === "dir" && open.has(n.path) && n.children && <Tree nodes={n.children} open={open} toggle={toggle} select={select} selected={selected} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function FileExplorer({ projectId, workspaceExists }: { projectId: number; workspaceExists: boolean }) {
  const { isCeo } = useSession();
  const { toast } = useToast();
  const [tree, setTree] = useState<{ tree: Node[]; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileData | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const loadTree = () => api<{ tree: Node[]; truncated: boolean }>(`/projects/${projectId}/files`).then(t => { setTree(t); setErr(null); }).catch(e => setErr((e as Error).message));
  useEffect(() => { if (workspaceExists) loadTree(); }, [projectId, workspaceExists]); // eslint-disable-line react-hooks/exhaustive-deps

  async function select(path: string) {
    if (editing && draft !== file?.content && !window.confirm("Discard unsaved changes?")) return;
    setSelected(path); setEditing(false); setLoadingFile(true);
    try { setFile(await api<FileData>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`)); }
    catch (e) { setFile(null); toast("error", (e as Error).message); }
    finally { setLoadingFile(false); }
  }
  async function save() {
    if (!file) return;
    setSaving(true);
    try {
      const r = await api<{ committed: boolean; commit: string | null }>(`/projects/${projectId}/file`, { method: "PUT", body: { path: file.path, content: draft } });
      toast("success", r.committed ? `Saved & committed to main (${r.commit?.slice(0, 8)})` : "No changes to save");
      setFile({ ...file, content: draft, size: new Blob([draft]).size }); setEditing(false);
    } catch (e) { toast("error", (e as Error).message); } finally { setSaving(false); }
  }

  if (!workspaceExists) return <div className="card p-8 text-center text-sm text-slate-400">Run first task to initialize workspace — files appear here once an agent has created the project&apos;s git workspace.</div>;
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div className="card max-h-[70vh] overflow-y-auto p-2">
        <div className="mb-1 flex items-center justify-between px-2 py-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Explorer</span>
          <button className="rounded p-1 text-slate-400 hover:bg-white/10" onClick={loadTree} title="Refresh" aria-label="Refresh"><RefreshCw size={13} /></button>
        </div>
        <ErrorBox message={err} />
        {!tree ? <div className="space-y-2 p-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-5" />)}</div>
          : !tree.tree.length ? <p className="p-3 text-xs text-slate-500">The workspace is empty.</p>
          : <Tree nodes={tree.tree} open={open} selected={selected} select={select} toggle={p => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; })} />}
        {tree?.truncated && <p className="p-2 text-[11px] text-slate-500">Large workspace — list truncated.</p>}
      </div>

      <div className="card flex min-h-[50vh] min-w-0 flex-col overflow-hidden">
        {!selected ? (
          <div className="grid flex-1 place-items-center p-8 text-center text-sm text-slate-500">Select a file to view it.{isCeo && <><br />You can make quick edits; saving commits them to main as a CEO edit.</>}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-black/20 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-amber-200/90">{selected}</span>
              {file && <span className="text-[11px] text-slate-500">{fmtBytes(file.size)}</span>}
              {isCeo && file && !file.binary && !file.tooLarge && (editing ? (
                <>
                  <button className="btn-ghost !px-2 !py-0.5 text-xs" onClick={() => setEditing(false)} disabled={saving}><X size={12} /> Cancel</button>
                  <button className="btn-primary !px-2 !py-0.5 text-xs" onClick={save} disabled={saving || draft === file.content}>{saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save &amp; commit</button>
                </>
              ) : <button className="btn-ghost !px-2 !py-0.5 text-xs" onClick={() => { setDraft(file.content); setEditing(true); }}><Pencil size={12} /> Edit</button>)}
            </div>
            {editing && <div className="border-b border-white/5 px-3 py-1.5"><HelpText>Saving commits this file directly to <b>main</b> as a CEO edit (blocked while an agent is working in this workspace).</HelpText></div>}
            <div className="flex-1 overflow-auto">
              {loadingFile ? <div className="p-4"><Skeleton className="h-64" /></div>
                : !file ? null
                : file.binary ? <p className="p-6 text-sm text-slate-500">Binary file — not shown.</p>
                : file.tooLarge ? <p className="p-6 text-sm text-slate-500">File is larger than 1 MB — download the ZIP to view it.</p>
                : editing ? (
                  <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } }}
                    className="h-full min-h-[60vh] w-full resize-none bg-black/40 p-4 font-mono text-[13px] leading-relaxed text-slate-100 focus:outline-none" />
                ) : (
                  <pre className="min-h-full overflow-x-auto bg-black/30 p-4 font-mono text-[13px] leading-relaxed text-slate-200">
                    <code><Highlighted code={file.content} path={file.path} /></code>
                  </pre>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
