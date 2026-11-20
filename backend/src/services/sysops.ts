import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import { promisify } from "util";
import { HttpError } from "../http";
import { pm2List, tailPm2Logs } from "./deploy";

const pexec = promisify(execFile);

/** Only Devenum services and Devenum live deploys can be inspected or restarted — never other apps on this VPS. */
export const CORE_SERVICES = ["devenum-backend", "devenum-worker", "devenum-bot", "devenum-portal"] as const;
const allowed = (name: string) => (CORE_SERVICES as readonly string[]).includes(name) || /^live-[a-z0-9][a-z0-9-]{0,190}$/.test(name);

function cpuSample() {
  const t = os.cpus().reduce((a, c) => { const tot = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + tot }; }, { idle: 0, total: 0 });
  return t;
}

export async function vpsMetrics() {
  const a = cpuSample();
  await new Promise(r => setTimeout(r, 250));
  const b = cpuSample();
  const cpuPct = Math.round((1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)) * 100);
  let memAvail = os.freemem();
  try { memAvail = Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0) * 1024 || memAvail; } catch { /* non-linux */ }
  let disk = { total: 0, used: 0, avail: 0 };
  try {
    const { stdout } = await pexec("df", ["-B1", "--output=size,used,avail", "/"]);
    const [total, used, avail] = stdout.trim().split("\n")[1].trim().split(/\s+/).map(Number);
    disk = { total, used, avail };
  } catch { /* ignore */ }
  return {
    cpu: { percent: cpuPct, cores: os.cpus().length, load: os.loadavg().map(x => Math.round(x * 100) / 100) },
    memory: { total: os.totalmem(), used: os.totalmem() - memAvail, percent: Math.round(((os.totalmem() - memAvail) / os.totalmem()) * 100) },
    disk: { ...disk, percent: disk.total ? Math.round((disk.used / disk.total) * 100) : 0 },
    uptimeSec: Math.round(os.uptime()), hostname: os.hostname(),
  };
}

export async function devenumServices() {
  const list = await pm2List().catch(() => []);
  return list.filter(p => allowed(p.name)).map(p => ({
    name: p.name, status: String(p.pm2_env.status), pid: p.pid, cpu: p.monit.cpu, memory: p.monit.memory,
    restarts: Number(p.pm2_env.restart_time ?? 0), uptimeSince: Number(p.pm2_env.pm_uptime ?? 0) || null,
    kind: (CORE_SERVICES as readonly string[]).includes(p.name) ? "core" : "live",
  }));
}

/** Restarts an allowed service. Restarting the backend itself is deferred so the HTTP response gets out first. */
export async function restartService(name: string) {
  if (!allowed(name)) throw new HttpError(403, "Only Devenum services (devenum-*, live-*) can be restarted from here");
  if (!(await pm2List()).some(p => p.name === name)) throw new HttpError(404, `No PM2 process named ${name}`);
  if (name === "devenum-backend") {
    setTimeout(() => spawn("pm2", ["restart", name], { detached: true, stdio: "ignore" }).unref(), 500);
    return { name, restarting: true, deferred: true };
  }
  await pexec("pm2", ["restart", name], { timeout: 60_000 });
  return { name, restarting: true, deferred: false };
}

/** Values of secret-looking environment variables, redacted from any log output we return. */
function secretValues() {
  const vals = Object.entries(process.env)
    .filter(([k, v]) => v && v.length >= 8 && /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/i.test(k))
    .map(([, v]) => v!);
  const dbPass = process.env.DATABASE_URL?.match(/:\/\/[^:]+:([^@]+)@/)?.[1];
  if (dbPass) vals.push(dbPass, decodeURIComponent(dbPass));
  return vals.sort((a, b) => b.length - a.length);
}
export const redact = (text: string) => secretValues().reduce((t, v) => t.split(v).join("***"), text)
  .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,})/g, "***");

export async function serviceLogs(name: string, lines = 200) {
  if (!allowed(name)) throw new HttpError(403, "Only Devenum services (devenum-*, live-*) are viewable here");
  return redact(await tailPm2Logs(name, Math.min(1000, Math.max(10, lines))));
}
