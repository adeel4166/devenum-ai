import fs from "fs";
import path from "path";
import { must, run, sq } from "./exec";

/**
 * Automated pre-approval QA & security gate. Runs on the task branch before a proposal is created and produces a
 * structured report the CEO sees as a "QA Passed" / "QA Warning" badge. It never blocks the proposal by itself —
 * the CEO always makes the final call — but it makes problems impossible to miss.
 */
export type Severity = "HIGH" | "MEDIUM" | "LOW";
export interface QaFinding { severity: Severity; check: string; message: string; file?: string }
export interface QaCheck { name: string; status: "passed" | "warning" | "failed" | "skipped"; detail: string; ms: number }
export interface QaReport { status: "PASSED" | "WARNINGS"; score: number; findings: QaFinding[]; checks: QaCheck[]; ranAt: string }

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style API key", re: /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: "Stripe secret key", re: /\b(sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { name: "Discord bot token", re: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/ },
  { name: "Private key", re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "Credentials in URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"]{6,}@[^\s'"]+/i },
  { name: "Hard-coded secret", re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s$<{]{8,}["']/i },
];
const PLACEHOLDER = /(example|placeholder|changeme|change-me|your[_-]|xxx|<|\$\{|process\.env|dummy|test|sample|\*\*\*)/i;

function scanDiffForSecrets(diff: string): QaFinding[] {
  const findings: QaFinding[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (/\.env\.example$|\.md$|(^|\/)(test|tests|__tests__|fixtures?)\//i.test(file)) continue;
    for (const p of SECRET_PATTERNS) {
      const m = line.match(p.re);
      if (m && !(p.name === "Hard-coded secret" || p.name === "Credentials in URL" ? PLACEHOLDER.test(m[0]) : false)) {
        findings.push({ severity: "HIGH", check: "secrets", file, message: `Possible ${p.name} added (${m[0].slice(0, 6)}…)` });
        break;
      }
    }
    if (findings.length >= 10) break;
  }
  return findings;
}

const timed = async <T>(fn: () => Promise<T>) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };

/** Runs on `branch` (checked out by this function) and returns to main afterwards. */
export async function runQa(ws: string, branch: string, opts: { runFailed: boolean; changedFiles: string[] }): Promise<QaReport> {
  const findings: QaFinding[] = [];
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);

  // 1. Diff sanity
  if (!opts.changedFiles.length) {
    findings.push({ severity: "MEDIUM", check: "diff", message: "The branch has no file changes compared to main (empty diff)." });
    add({ name: "Diff not empty", status: "warning", detail: "No changes", ms: 0 });
  } else add({ name: "Diff not empty", status: "passed", detail: `${opts.changedFiles.length} file(s) changed`, ms: 0 });
  if (opts.runFailed) findings.push({ severity: "HIGH", check: "run", message: "The agent run ended with an error; the result may be incomplete." });

  // 2. Committed env files
  const envFiles = opts.changedFiles.filter(f => /(^|\/)\.env(\.[^/]*)?$/.test(f) && !/\.env\.example$/.test(f));
  envFiles.forEach(f => findings.push({ severity: "HIGH", check: "secrets", file: f, message: "A real .env file is committed — it may contain secrets." }));

  // 3. Secret scan of added lines
  const { r: diff, ms: diffMs } = await timed(() => run(["git", "diff", "--unified=0", `main...${branch}`], { cwd: ws, timeoutMs: 60_000 }));
  const secretHits = scanDiffForSecrets(diff.stdout);
  findings.push(...secretHits);
  add({ name: "Secret scan", status: secretHits.length || envFiles.length ? "failed" : "passed", detail: secretHits.length || envFiles.length ? `${secretHits.length + envFiles.length} potential secret(s)` : "No hard-coded secrets found", ms: diffMs });

  // Work on the branch's tree for syntax/build checks.
  await must(["git", "checkout", "--quiet", branch], ws);
  try {
    // 4. Fast syntax checks on changed JS/JSON files (no dependencies needed)
    const { r: syntax, ms: syntaxMs } = await timed(async () => {
      let n = 0, bad = 0;
      for (const f of opts.changedFiles.slice(0, 200)) {
        const abs = path.join(ws, f);
        if (!fs.existsSync(abs)) continue;
        if (/\.(c|m)?js$/.test(f)) {
          n++;
          const r = await run(["node", "--check", f], { cwd: ws, timeoutMs: 20_000 });
          if (r.code !== 0) { bad++; findings.push({ severity: "HIGH", check: "syntax", file: f, message: (r.stderr.trim().split("\n").find(l => /Error/.test(l)) ?? "Syntax error").slice(0, 240) }); }
        } else if (/\.json$/.test(f) && !/lock\.json$/.test(f)) {
          n++;
          try { JSON.parse(fs.readFileSync(abs, "utf8")); } catch (e) { bad++; findings.push({ severity: "HIGH", check: "syntax", file: f, message: `Invalid JSON: ${(e as Error).message.slice(0, 200)}` }); }
        }
      }
      return { n, bad };
    });
    add({ name: "Syntax check (JS/JSON)", status: syntax.n === 0 ? "skipped" : syntax.bad ? "failed" : "passed", detail: syntax.n ? `${syntax.n} file(s) checked, ${syntax.bad} with errors` : "No JS/JSON files changed", ms: syntaxMs });

    // 5. Project build / typecheck if the project defines one
    const pkgPath = path.join(ws, "package.json");
    if (fs.existsSync(pkgPath)) {
      let scripts: Record<string, string> = {};
      try { scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts ?? {}; } catch { /* reported by JSON check */ }
      const script = ["typecheck", "build", "lint"].find(s => scripts[s]);
      if (!script) add({ name: "Build check", status: "skipped", detail: "package.json has no typecheck/build/lint script", ms: 0 });
      else {
        const { r, ms } = await timed(async () => {
          if (!fs.existsSync(path.join(ws, "node_modules"))) {
            const inst = await run(["bash", "-c", "npm install --no-audit --no-fund --ignore-scripts 2>&1 | tail -20"], { cwd: ws, timeoutMs: Number(process.env.QA_INSTALL_TIMEOUT_MS || 240_000) });
            if (inst.code !== 0 || inst.timedOut) return { ok: false, out: `npm install failed${inst.timedOut ? " (timed out)" : ""}: ${inst.stdout.slice(-600)}` };
          }
          const b = await run(["bash", "-c", `CI=true npm run ${sq(script)} 2>&1 | tail -40`], { cwd: ws, timeoutMs: Number(process.env.QA_BUILD_TIMEOUT_MS || 240_000) });
          // `| tail` hides npm's exit code; detect failure from the output instead.
          const failed = b.timedOut || /npm ERR!|error TS\d+|ERR_|Failed to compile|Build failed|SyntaxError|✖|ELIFECYCLE/i.test(b.stdout);
          return { ok: !failed, out: b.stdout.slice(-1200) };
        });
        if (!r.ok) findings.push({ severity: "HIGH", check: "build", message: `\`npm run ${script}\` failed:\n${r.out.trim().slice(-800)}` });
        add({ name: `npm run ${script}`, status: r.ok ? "passed" : "failed", detail: r.ok ? "Succeeded" : "Failed — see findings", ms });
      }
    } else add({ name: "Build check", status: "skipped", detail: "No package.json", ms: 0 });
  } finally {
    await run(["git", "checkout", "--quiet", "main"], { cwd: ws, timeoutMs: 60_000 });
  }

  const penalty = findings.reduce((sum, f) => sum + (f.check === "secrets" ? 40 : f.check === "build" ? 35 : f.check === "syntax" ? 20 : f.check === "run" ? 30 : f.severity === "MEDIUM" ? 15 : 5), 0);
  const score = Math.max(0, 100 - penalty);
  const status = score >= 80 && !findings.some(f => f.severity === "HIGH") ? "PASSED" : "WARNINGS";
  return { status, score, findings: findings.slice(0, 25), checks, ranAt: new Date().toISOString() };
}
