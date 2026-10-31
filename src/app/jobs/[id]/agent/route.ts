import { db } from "@/lib/db";
import { agentLogTail, isAgentRunning } from "@/lib/agent-runner";

/** Live agent status for the job page to poll. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.job.findUnique({
    where: { id },
    select: { status: true, application: { select: { failureReason: true } } },
  });
  if (!job) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json(
    {
      status: job.status,
      failureReason: job.application?.failureReason ?? null,
      running: isAgentRunning(id),
      log: await agentLogTail(id),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
