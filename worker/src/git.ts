import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { must, run } from "./exec";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,190}$/;

export function workspacePath(slug: string) {
  if (!SLUG_RE.test(slug)) throw new Error(`Refusing unsafe project slug "${slug}"`);
  return path.join(config.workspacesDir, slug);
}

export const taskBranch = (taskId: number) => `task/${taskId}`;
const git = (ws: string, ...args: string[]) => must(["git", ...args], ws);

/** Creates the workspace + git repo with a `main` branch if missing, and leaves it clean on main. */
export async function prepareRepo(ws: string, label: string) {
  if (!fs.existsSync(ws)) await must(["mkdir", "-p", ws], config.workspacesDir);
  if (!fs.existsSync(path.join(ws, ".git"))) {
    await git(ws, "init", "-b", "main");
    await git(ws, "config", "user.name", "Devenum AI Worker");
    await git(ws, "config", "user.email", "worker@devenum.local");
    await git(ws, "commit", "--allow-empty", "-m", "chore: initialize Devenum AI workspace");
  }
  // Local-only ignore rules (never committed): dependencies, build caches and real env files must not reach git.
  const exclude = path.join(ws, ".git", "info", "exclude");
  const wanted = ["node_modules/", ".next/", ".env", ".env.local", ".env.*.local"];
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  const missing = wanted.filter(w => !current.split("\n").includes(w));
  if (missing.length) {
    await must(["bash", "-c", `mkdir -p .git/info && printf '%s\\n' ${missing.map(m => `'${m}'`).join(" ")} >> .git/info/exclude`], ws);
  }
  // Preserve (never discard) anything left behind by an interrupted run.
  if (await git(ws, "status", "--porcelain")) {
    await git(ws, "stash", "push", "--include-untracked", "-m", `devenum-worker autostash before ${label}`);
  }
  await git(ws, "checkout", "main");
}

export async function branchExists(ws: string, branch: string) {
  return (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: ws })).code === 0;
}

/**
 * Checks out task/<id>: reuses an existing branch (e.g. a task re-queued after rejection), otherwise branches from
 * `base` (the parent task's branch for Request-Changes follow-ups, else main). Returns the base actually used.
 */
export async function checkoutTaskBranch(ws: string, branch: string, base = "main"): Promise<string> {
  if (await branchExists(ws, branch)) { await git(ws, "checkout", branch); return branch; }
  const from = base !== "main" && (await branchExists(ws, base)) ? base : "main";
  await git(ws, "checkout", "-b", branch, from);
  return from;
}

export interface BranchResult { statusShort: string; commit: string | null; diffStat: string; changedFiles: string[]; insertions: number; deletions: number }

/** Commits whatever the agent changed onto the task branch and describes the branch relative to main. */
export async function commitAndDescribe(ws: string, branch: string, message: string, author: { name: string; email: string }): Promise<BranchResult> {
  const statusShort = await git(ws, "status", "--short");
  let commit: string | null = null;
  if (statusShort) {
    await git(ws, "add", "-A");
    await git(ws, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message);
    commit = await git(ws, "rev-parse", "HEAD");
  }
  const diffStat = await git(ws, "diff", "--stat", `main...${branch}`);
  const changedFiles = (await git(ws, "diff", "--name-only", `main...${branch}`)).split("\n").filter(Boolean);
  const short = await git(ws, "diff", "--shortstat", `main...${branch}`);
  const num = (re: RegExp) => Number(short.match(re)?.[1] ?? 0);
  await git(ws, "checkout", "main");
  return { statusShort, commit, diffStat, changedFiles, insertions: num(/(\d+) insertion/), deletions: num(/(\d+) deletion/) };
}

/**
 * Tamper lock for proposals: sha256 over branch name, head commit and `git diff --stat` against main's merge-base.
 * The backend computes exactly the same value (services/payloadHash.ts) — keep the command identical.
 */
export async function payloadHash(ws: string, branch: string) {
  const head = await git(ws, "rev-parse", `refs/heads/${branch}`);
  const stat = await git(ws, "diff", "--stat=200,180", `main...${branch}`);
  const hash = createHash("sha256").update(`${branch}\n${head}\n${stat}`).digest("hex");
  return { hash, head };
}

/** Merges the task branch into main with a merge commit; aborts cleanly on conflict. */
export async function mergeTaskBranch(ws: string, branch: string, message: string): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  await prepareRepo(ws, `merge of ${branch}`);
  if (!(await branchExists(ws, branch))) return { ok: false, error: `Branch ${branch} does not exist in ${ws}` };
  // Explicit identity: the merge commit must never depend on repo/global git config.
  const r = await run(["git", "-c", "user.name=Devenum AI Worker", "-c", "user.email=worker@devenum.local", "merge", "--no-ff", "-m", message, branch], { cwd: ws, timeoutMs: 120_000 });
  if (r.code !== 0) {
    await run(["git", "merge", "--abort"], { cwd: ws });
    return { ok: false, error: (r.stdout + "\n" + r.stderr).trim().slice(0, 4000) };
  }
  return { ok: true, commit: await git(ws, "rev-parse", "HEAD") };
}
