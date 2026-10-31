import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";

/**
 * Runs agent/apply.py as a local background process. Local-only by design:
 * the browser opens on this machine. The script writes its own log to
 * agent/runs/<jobId>/log.txt and records the outcome in the database.
 */

const AGENT_DIR = path.join(process.cwd(), "agent");

const globalForAgent = globalThis as unknown as { agentRuns?: Map<string, ChildProcess> };
const runs = (globalForAgent.agentRuns ??= new Map());

export function agentPython(): string {
  if (process.env.AGENT_PYTHON) return process.env.AGENT_PYTHON;
  return process.platform === "win32"
    ? path.join(AGENT_DIR, ".venv", "Scripts", "python.exe")
    : path.join(AGENT_DIR, ".venv", "bin", "python");
}

export const isAgentRunning = (jobId: string) => runs.has(jobId);

export const agentLogPath = (jobId: string) => path.join(AGENT_DIR, "runs", jobId, "log.txt");

export function startAgent(jobId: string): void {
  const child = spawn(agentPython(), [path.join(AGENT_DIR, "apply.py"), "--job-id", jobId], {
    cwd: process.cwd(),
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  runs.set(jobId, child);

  const finish = async (reason: string | null) => {
    runs.delete(jobId);
    if (!reason) return;
    // The script records its own outcome; this only catches runs that died before doing so.
    const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job?.status !== "APPLYING") return;
    await db.$transaction([
      db.job.update({ where: { id: jobId }, data: { status: "FAILED" } }),
      db.application.update({ where: { jobId }, data: { status: "FAILED", failureReason: reason } }),
    ]);
  };

  child.on("error", (err) => void finish(`Could not start the agent: ${err.message}`));
  // apply.py exit codes: 0 done, 3 failure already recorded, 2 refused, anything else crashed.
  child.on("exit", async (code) => {
    if (code === 0 || code === 3) return finish(null);
    const last = (await agentLogTail(jobId, 1))[0]?.replace(/^\[jobflow\]\s*/, "");
    await finish(last || `Agent exited with code ${code}; see agent/runs/${jobId}/log.txt`);
  });
}

export async function agentLogTail(jobId: string, lines = 8): Promise<string[]> {
  try {
    const text = await readFile(agentLogPath(jobId), "utf8");
    return text.trimEnd().split(/\r?\n/).slice(-lines);
  } catch {
    return [];
  }
}

export const agentInstalled = () => existsSync(agentPython());
