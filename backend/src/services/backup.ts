import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { HttpError } from "../http";

/**
 * Full agency backup: mysqldump of the Devenum database + every project workspace (git history included,
 * node_modules excluded) in one timestamped ZIP under /opt/devenum-ai/backups (root-only, mode 600).
 * Backups contain secrets (DB password hashes, workspace .env files) — they are only downloadable by the CEO/admins.
 */
export const BACKUP_DIR = process.env.BACKUP_DIR || "/opt/devenum-ai/backups";
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || "/opt/devenum-ai/workspaces";
const NAME_RE = /^devenum-backup-\d{8}-\d{6}\.zip$/;

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdoutFile?: string; timeoutMs: number }) {
  return new Promise<void>((resolve, reject) => {
    const out = opts.stdoutFile ? fs.openSync(opts.stdoutFile, "w", 0o600) : "ignore";
    const p = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["ignore", out, "pipe"] });
    let err = "";
    p.stderr?.on("data", b => (err += b));
    const t = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs);
    p.on("error", e => { clearTimeout(t); reject(e); });
    p.on("close", code => {
      clearTimeout(t);
      if (typeof out === "number") fs.closeSync(out);
      // mysqldump warns about passwords on stderr even on success; only the exit code matters.
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.replace(/Using a password.*\n?/i, "").trim().slice(-600)}`));
    });
  });
}

const ZIP_SCRIPT = `import os, sys, zipfile
dest, sql, ws = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
    z.write(sql, "database/devenum_ai.sql"); n += 1
    if os.path.isdir(ws):
        for root, dirs, files in os.walk(ws):
            dirs[:] = [d for d in dirs if d != "node_modules"]
            for f in files:
                full = os.path.join(root, f)
                if os.path.islink(full): continue
                z.write(full, os.path.join("workspaces", os.path.relpath(full, ws))); n += 1
print(n)`;

export async function createBackup(progress: (m: string) => void) {
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  if (!url) throw new HttpError(500, "DATABASE_URL is not set");
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(BACKUP_DIR, 0o700);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const name = `devenum-backup-${stamp}.zip`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devenum-backup-"));
  const sql = path.join(tmp, "devenum_ai.sql");
  try {
    progress("Dumping MySQL database…");
    // Password goes through the environment (MYSQL_PWD), never the command line.
    await run("mysqldump", [
      "-h", url.hostname, "-P", url.port || "3306", "-u", decodeURIComponent(url.username),
      "--single-transaction", "--routines", "--triggers", "--no-tablespaces", "--set-gtid-purged=OFF",
      url.pathname.replace(/^\//, ""),
    ], { env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) }, stdoutFile: sql, timeoutMs: 600_000 });

    progress("Archiving workspaces (without node_modules)…");
    const dest = path.join(BACKUP_DIR, name);
    await run("python3", ["-c", ZIP_SCRIPT, dest, sql, WORKSPACES_DIR], { timeoutMs: 1_800_000 });
    fs.chmodSync(dest, 0o600);
    return { name, bytes: fs.statSync(dest).size, createdAt: new Date().toISOString(), downloadPath: `/system/backups/${name}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => NAME_RE.test(f)).map(f => {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    return { name: f, bytes: st.size, createdAt: st.mtime.toISOString(), downloadPath: `/system/backups/${f}` };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

export function backupFile(name: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, "Invalid backup name");
  const f = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(f)) throw new HttpError(404, "Backup not found");
  return f;
}
