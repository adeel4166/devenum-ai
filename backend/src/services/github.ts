import { runScript, sq, workspacePath } from "./exec";

const TOKEN = () => process.env.GITHUB_TOKEN?.trim() ?? "";
let username = process.env.GITHUB_USERNAME?.trim() ?? "";

export const githubConfigured = () => !!TOKEN();
const redact = (s: string) => (TOKEN() ? s.split(TOKEN()).join("***") : s);

async function gh<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
      "user-agent": "devenum-bot", ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

export async function getUsername(): Promise<string> {
  if (username) return username;
  const r = await gh<{ login?: string; message?: string }>("GET", "/user");
  if (r.status !== 200 || !r.data.login) throw new Error(`GitHub token rejected (HTTP ${r.status}: ${r.data.message ?? "unknown"})`);
  return (username = r.data.login);
}

export interface PushResult { url: string; created: boolean; isPrivate: boolean; visibilityMismatch: boolean; output: string }

/** Creates <slug> under the token's user (422 "already exists" is fine) and pushes the workspace's main branch. */
export async function pushProject(slug: string, description: string, wantPrivate: boolean): Promise<PushResult> {
  if (!githubConfigured()) throw new Error("GITHUB_TOKEN is not set in bot/.env");
  const ws = workspacePath(slug);
  const user = await getUsername();

  const created = await gh<{ html_url?: string; private?: boolean; message?: string; errors?: { message?: string }[] }>("POST", "/user/repos", {
    name: slug, private: wantPrivate, description: description.replace(/\s+/g, " ").slice(0, 300), auto_init: false,
  });
  let isPrivate = wantPrivate, url = `https://github.com/${user}/${slug}`, wasCreated = false;
  if (created.status === 201) { wasCreated = true; url = created.data.html_url ?? url; isPrivate = !!created.data.private; }
  else if (created.status === 422) {
    const existing = await gh<{ html_url?: string; private?: boolean }>("GET", `/repos/${user}/${slug}`);
    if (existing.status !== 200) throw new Error(`GitHub refused to create ${slug}: ${created.data.errors?.[0]?.message ?? created.data.message ?? "422"}`);
    url = existing.data.html_url ?? url; isPrivate = !!existing.data.private;
  } else throw new Error(`GitHub repo creation failed (HTTP ${created.status}: ${created.data.message ?? "unknown"})`);

  // The token is read from stdin into an env var and handed to git through a credential helper:
  // it never appears in argv, the process list, the remote URL, or .git/config.
  const helper = `!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`;
  const script = [
    "IFS= read -r GH_TOKEN", "export GH_TOKEN GIT_TERMINAL_PROMPT=0", `cd ${sq(ws)}`,
    "git rev-parse --verify --quiet refs/heads/main >/dev/null || { echo 'workspace has no main branch yet' >&2; exit 3; }",
    `git -c credential.helper= -c ${sq(`credential.helper=${helper}`)} push ${sq(`https://github.com/${user}/${slug}.git`)} main:main 2>&1`,
  ].join(" && ");
  const r = await runScript(script, { input: `${TOKEN()}\n`, timeoutMs: 180_000 });
  const output = redact(`${r.stdout}${r.stderr}`).trim();
  if (r.timedOut) throw new Error("git push timed out after 180s");
  if (r.code !== 0) throw new Error(`git push failed: ${output.slice(-800)}`);
  return { url, created: wasCreated, isPrivate, visibilityMismatch: isPrivate !== wantPrivate, output };
}
