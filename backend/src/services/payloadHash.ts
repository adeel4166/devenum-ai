import { createHash } from "crypto";
import { runScript, sq, workspacePath } from "./exec";

/**
 * Tamper lock — must match worker/src/git.ts payloadHash(): sha256(`${branch}\n${head}\n${diffStat}`) where
 * diffStat = `git diff --stat=200,180 main...<branch>` (same command, same width, so the output is identical).
 */
export async function currentPayloadHash(slug: string, branch: string) {
  if (!/^task\/\d+$/.test(branch)) throw new Error("Unexpected branch name");
  const ws = workspacePath(slug);
  const r = await runScript(`cd ${sq(ws)} && git rev-parse ${sq(`refs/heads/${branch}`)} && echo __STAT__ && git diff --stat=200,180 ${sq(`main...${branch}`)}`, { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300) || "git failed");
  const [headPart, statPart = ""] = r.stdout.split("__STAT__\n");
  const head = headPart.trim();
  const stat = statPart.replace(/\n$/, "").trim();
  return { hash: createHash("sha256").update(`${branch}\n${head}\n${stat}`).digest("hex"), head };
}
