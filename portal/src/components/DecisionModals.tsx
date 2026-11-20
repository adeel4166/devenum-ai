"use client";
import { useState } from "react";
import { MessageSquareDiff, XCircle } from "lucide-react";
import { api, Proposal } from "@/lib/api";
import { useToast } from "./toast";
import { Field, HelpText, Modal } from "./ui";

/** Request Changes: rejects the proposal with feedback and re-queues a follow-up task for the same agent. */
export function RequestChangesModal({ proposal, onClose, onDone }: { proposal: Proposal; onClose: () => void; onDone: () => void }) {
  const { run } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await run(() => api<{ followUpTaskId: number }>(`/proposals/${proposal.id}/request-changes`, { method: "POST", body: { comment: text.trim() } }));
    setBusy(false);
    if (r) { onDone(); onClose(); }
  }
  return (
    <Modal title="Changes / Feedback" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <HelpText>
          {proposal.requestingAgent.name} will get a new task that continues from its previous branch{proposal.branchName ? <> (<span className="mono-badge">{proposal.branchName}</span>)</> : null} with your feedback.
          This proposal is closed as rejected; nothing is merged.
        </HelpText>
        <Field label="What should change?">
          <textarea autoFocus required minLength={2} maxLength={2000} className="input min-h-[140px]" placeholder="e.g. Use the brand colours from the design system and add form validation messages under each field."
            value={text} onChange={e => setText(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || text.trim().length < 2}><MessageSquareDiff size={15} /> {busy ? "Sending…" : "Send back to agent"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function RejectModal({ proposal, onClose, onDone }: { proposal: Proposal; onClose: () => void; onDone: () => void }) {
  const { run } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await run(() => api(`/approvals/${proposal.id}/decision`, { method: "POST", body: { decision: "REJECTED", comment: text.trim() } }), "Proposal rejected");
    setBusy(false);
    if (ok) { onDone(); onClose(); }
  }
  return (
    <Modal title={`Reject proposal #${proposal.id}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <HelpText>Rejecting closes this proposal and blocks the task. Nothing is merged; the branch is kept for reference. Use <b>Request Changes</b> instead if you want the agent to try again.</HelpText>
        <Field label="Reason">
          <textarea autoFocus required minLength={2} maxLength={2000} className="input min-h-[100px]" value={text} onChange={e => setText(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-danger" disabled={busy || text.trim().length < 2}><XCircle size={15} /> Reject</button>
        </div>
      </form>
    </Modal>
  );
}
