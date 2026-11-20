import { spawn } from "child_process";
import fs from "fs";
import { workspacePath } from "./exec";

// Excludes build/dependency folders and real env files (secrets) — .env.example is kept.
const ZIP_SCRIPT = `import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
SKIP_DIRS = {"node_modules", ".git", ".next", "dist"}
n = 0
with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f == ".env" or (f.startswith(".env.") and f != ".env.example"):
                continue
            full = os.path.join(root, f)
            if os.path.islink(full):
                continue
            z.write(full, os.path.join(os.path.basename(src), os.path.relpath(full, src)))
            n += 1
print(n)`;

export const UPLOAD_LIMIT_BYTES = Number(process.env.DISCORD_UPLOAD_LIMIT_MB || 10) * 1024 * 1024;

/** Zips the workspace to /tmp/<slug>.zip. Caller must delete the file. */
export function zipWorkspace(slug: string): Promise<{ file: string; files: number; bytes: number }> {
  const src = workspacePath(slug);
  if (!fs.existsSync(src)) return Promise.reject(new Error(`Workspace ${src} does not exist yet.`));
  const file = `/tmp/${slug}.zip`;
  fs.rmSync(file, { force: true });
  return new Promise((resolve, reject) => {
    const p = spawn("python3", ["-c", ZIP_SCRIPT, src, file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", b => (out += b));
    p.stderr.on("data", b => (err += b));
    const t = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("error", reject);
    p.on("close", code => {
      clearTimeout(t);
      if (code !== 0) { fs.rmSync(file, { force: true }); return reject(new Error(`zip failed: ${err.trim().slice(-400)}`)); }
      resolve({ file, files: Number(out.trim()) || 0, bytes: fs.statSync(file).size });
    });
  });
}
