import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
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
    if (reason) await failIfStillApplying(jobId, reason);
  };

  child.on("error", (err) => void finish(`Could not start the agent: ${err.message}`));
  // apply.py exit codes: 0 done, 3 failure already recorded, 2 refused, anything else crashed.
  child.on("exit", async (code) => {
    if (code === 0 || code === 3) return finish(null);
    const last = (await agentLogTail(jobId, 1))[0]?.replace(/^\[jobflow\]\s*/, "");
    await finish(last || `Agent exited with code ${code}; see agent/runs/${jobId}/log.txt`);
  });
}

/** The script records its own outcome; this only catches runs that died before doing so. */
async function failIfStillApplying(jobId: string, reason: string): Promise<void> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (job?.status !== "APPLYING") return;
  await db.$transaction([
    db.job.update({ where: { id: jobId }, data: { status: "FAILED" } }),
    db.application.update({ where: { jobId }, data: { status: "FAILED", failureReason: reason } }),
  ]);
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

/** A human-assist pause in progress: apply.py writes waiting.json while it waits for the user. */
export type AgentWaiting = { reason: string; todo: string; attempt: number; maxAttempts: number; since: string };

/** What apply.py writes; pid and timeoutSeconds are only for the staleness check. */
type WaitingFile = AgentWaiting & { pid?: number; timeoutSeconds?: number };

/** apply.py's --assist-timeout default, for files written before timeoutSeconds existed. */
const DEFAULT_ASSIST_TIMEOUT_SECONDS = 30 * 60;
/** Slack past the timeout for the agent to notice it and clean up on its own. */
const STALE_GRACE_MS = 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks the process exists, also on Windows
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** Why a waiting.json is one the agent should have removed, or null if the pause is live. */
function staleness(waiting: WaitingFile): "dead" | "expired" | null {
  if (typeof waiting.pid === "number" && !processAlive(waiting.pid)) return "dead";
  const since = Date.parse(waiting.since);
  const timeoutMs = (waiting.timeoutSeconds ?? DEFAULT_ASSIST_TIMEOUT_SECONDS) * 1000;
  if (Number.isNaN(since) || Date.now() - since > timeoutMs + STALE_GRACE_MS) return "expired";
  return null;
}

const runDir = (jobId: string) => {
  // Job ids are cuids; refuse anything that could leave agent/runs/.
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`Invalid job id: ${jobId}`);
  return path.join(AGENT_DIR, "runs", jobId);
};

/** The pause in progress, or null. A stale waiting.json from a dead run is deleted, not shown. */
export async function agentWaiting(jobId: string): Promise<AgentWaiting | null> {
  const file = path.join(runDir(jobId), "waiting.json");
  let waiting: WaitingFile;
  try {
    waiting = JSON.parse(await readFile(file, "utf8")) as WaitingFile;
  } catch {
    return null;
  }
  const stale = staleness(waiting);
  if (stale) {
    await rm(file, { force: true });
    // An expired pause in a live process is the agent's to record (NEEDS_ME); a dead one never will.
    if (stale === "dead") {
      await failIfStillApplying(jobId, `Agent stopped while waiting for you: ${waiting.reason}`);
    }
    return null;
  }
  const { reason, todo, attempt, maxAttempts, since } = waiting;
  return { reason, todo, attempt, maxAttempts, since };
}

/** Same as pressing Enter in the agent's terminal; works for runs started from the app or a terminal. */
export async function resumeAgent(jobId: string): Promise<void> {
  await writeFile(path.join(runDir(jobId), "resume"), "");
}
