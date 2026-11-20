import fs from "fs/promises";
import path from "path";
import { Agent, Project, Task } from "@prisma/client";
import { config, Settings } from "./config";
import { ExecResult, must, run } from "./exec";

export type Provider = "CLAUDE_CODE" | "GEMINI_API";

/** GEMINI_API only when a key is configured; otherwise fall back to Claude Code. */
export function pickProvider(agent: Agent, settings: Settings): { provider: Provider; note?: string } {
  if (agent.modelProvider === "GEMINI_API") {
    if (settings.geminiApiKey) return { provider: "GEMINI_API" };
    return { provider: "CLAUDE_CODE", note: "Agent is set to GEMINI_API but Setting.geminiApiKey is empty; fell back to CLAUDE_CODE." };
  }
  return { provider: "CLAUDE_CODE" };
}

export interface Manifest { allowedTools?: string[]; prohibitedActions?: string[]; maxSteps?: number; timeoutSeconds?: number; notes?: string }

export function buildPrompt(p: {
  agent: Agent; manifest: Manifest; project: Project; task: Task; branch: string; workspace: string;
  reviewFeedback: string[]; provider: Provider; decisions?: { title: string; decision: string; rationale: string | null }[];
}) {
  const { agent, manifest, project, task } = p;
  const list = (xs?: string[]) => (xs?.length ? xs.map(x => `- ${x}`).join("\n") : "- (none)");
  const canEdit = p.provider === "CLAUDE_CODE";
  return `You are the **${agent.name}** (${agent.roleTitle}, ${agent.department} department) at Devenum AI, an autonomous software house.
You are running non-interactively: never ask questions; make reasonable, clearly stated assumptions instead.

## Operating manifest
Allowed capabilities:
${list(manifest.allowedTools)}

Prohibited actions (hard rules, never violate):
${list(manifest.prohibitedActions)}

Step budget: at most ${manifest.maxSteps ?? 50} tool steps.${manifest.notes ? `\nRole notes: ${manifest.notes}` : ""}

## Workspace rules
${canEdit ? `- Your current directory is the project's git repository (${p.workspace}), checked out on branch \`${p.branch}\`.
- Only create or modify files inside this directory.
- Do NOT run git commit, push, checkout, switch, merge, rebase, reset, or stash. The platform commits your changes to \`${p.branch}\` and merges into \`main\` only after the CEO approves.
- Do not install global packages, start long-running servers, or touch anything outside the repository.` : `- You cannot edit files. Your full reply will be saved as a Markdown document on branch \`${p.branch}\`.`}
- Never read, print, or commit secrets (.env files, keys, tokens).

## Project
- Name: ${project.name} (${project.category})
- Tech stack: ${project.techStack || "not specified — choose a sensible default and state it"}
- Description: ${project.description || "(none)"}

${p.decisions?.length ? `
## Pinned project decisions (canonical CEO decisions — you MUST follow these)
${p.decisions.map((d, i) => `${i + 1}. **${d.title}**: ${d.decision}${d.rationale ? ` (why: ${d.rationale})` : ""}`).join("\n")}
` : ""}
## Task #${task.id} [${task.priority}]
Title: ${task.title}

${task.description || task.title}
${p.reviewFeedback.length ? `\n## CEO review feedback on earlier attempts (address all of it)\n${p.reviewFeedback.map(f => `- ${f}`).join("\n")}\n` : ""}
## Acceptance criteria
- The task above is fully implemented for this project, within your role's scope.
- The repository stays in a working state; add or update tests/docs where the stack supports it.
- Changes are minimal, focused, and consistent with the existing code style.

## Final reply format
Finish your reply with exactly these three Markdown sections:
### SUMMARY
What you did and why (bullet points, mention key files).
### VALIDATION
Concrete steps/commands a reviewer should run to verify the change.
### RISKS
Anything risky, assumptions made, or follow-up work needed.
`;
}

/** Extracts "### NAME" sections from the agent's final reply. */
export function section(output: string, name: string): string | null {
  const m = output.match(new RegExp(`#{2,3}\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s*(SUMMARY|VALIDATION|RISKS)\\b|$)`, "i"));
  return m?.[1].trim() || null;
}

export async function runClaude(prompt: string, workspace: string, timeoutMs: number, signal: AbortSignal, onOutput: (s: string) => void): Promise<ExecResult> {
  const argv = [config.claudeBin, "-p", "--output-format", "text", "--dangerously-skip-permissions"];
  if (config.claudeModel) argv.push("--model", config.claudeModel);
  // Prompt goes through stdin, never through the shell command line.
  return run(argv, { cwd: workspace, input: prompt, timeoutMs, signal, onOutput });
}

/** Gemini cannot edit files, so its answer is committed as a document on the task branch. */
export async function runGemini(prompt: string, apiKey: string, workspace: string, taskId: number, agentSlug: string, timeoutMs: number, signal: AbortSignal): Promise<ExecResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
    if (!res.ok) return { code: 1, stdout: "", stderr: `Gemini API ${res.status}: ${body.error?.message ?? "unknown error"}`, timedOut: false, aborted: false, durationMs: Date.now() - started };
    const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
    const rel = path.join("docs", "agents", `task-${taskId}-${agentSlug}.md`);
    // Written through the run-as user so ownership stays consistent with the rest of the workspace.
    await must(["mkdir", "-p", path.dirname(path.join(workspace, rel))], workspace);
    const tmp = path.join("/tmp", `devenum-gemini-${taskId}-${Date.now()}.md`);
    await fs.writeFile(tmp, text, { mode: 0o644 });
    try { await must(["cp", tmp, rel], workspace); } finally { await fs.rm(tmp, { force: true }); }
    return { code: 0, stdout: text, stderr: "", timedOut: false, aborted: false, durationMs: Date.now() - started };
  } catch (e) {
    const err = e as Error;
    return { code: 1, stdout: "", stderr: `Gemini request failed: ${err.message}`, timedOut: !signal.aborted && err.name === "AbortError", aborted: signal.aborted, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
