"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { continueApply, startApply, type FormState } from "@/app/actions";
import { StatusBadge } from "@/components/badges";
import type { AgentWaiting } from "@/lib/agent-runner";

type Live = {
  status: string;
  failureReason: string | null;
  running: boolean;
  waiting: AgentWaiting | null;
  log: string[];
};

/** Starts the browser agent and follows its progress until it leaves APPLYING. */
export function ApplyPanel({
  jobId,
  status,
  failureReason,
  waiting: initialWaiting,
  blocked,
}: {
  jobId: string;
  status: string;
  failureReason: string | null;
  /** A human-assist pause already in progress when the page loaded. */
  waiting: AgentWaiting | null;
  /** Why applying isn't possible yet, if it isn't. */
  blocked?: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<FormState>(() => startApply(jobId), {});
  const [live, setLive] = useState<Live | null>(null);

  const current = live?.status ?? status;
  const reason = live ? live.failureReason : failureReason;
  const applying = current === "APPLYING";
  const waiting = applying ? (live ? live.waiting : initialWaiting) : null;

  useEffect(() => {
    if (!applying) return;
    let stopped = false;
    const poll = async () => {
      const res = await fetch(`/jobs/${jobId}/agent`, { cache: "no-store" });
      if (!res.ok || stopped) return;
      const next = (await res.json()) as Live;
      setLive(next);
      if (next.status !== "APPLYING") router.refresh();
    };
    const timer = setInterval(poll, 2000);
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [applying, jobId, router]);

  if (current === "APPLIED") {
    return (
      <div className="flex items-center gap-3 text-sm">
        <StatusBadge status={current} />
        {reason && <span className="text-amber-400" dir="ltr">{reason}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <form
        action={() => {
          setLive(null);
          action();
        }}
        className="flex flex-wrap items-center gap-3"
      >
        <button type="submit" disabled={pending || applying || Boolean(blocked)} className="btn-primary">
          {applying ? "جارٍ التقديم…" : current === "NEEDS_ME" || current === "FAILED" ? "إعادة التقديم" : "تقديم"}
        </button>
        <StatusBadge status={current} />
        {blocked && <p className="muted text-sm">{blocked}</p>}
        {state.error && <p className="error">{state.error}</p>}
      </form>

      {waiting && <WaitingNotice jobId={jobId} waiting={waiting} />}

      {applying && (
        <div className="space-y-2">
          {!waiting && (
            <p className="text-sm text-zinc-400">نافذة المتصفح مفتوحة والوكيل يملأ النموذج. يتحدث هذا القسم تلقائياً.</p>
          )}
          {live && live.log.length > 0 && (
            <pre
              dir="ltr"
              className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-950 p-3 text-xs leading-5 text-zinc-400"
            >
              {live.log.join("\n")}
            </pre>
          )}
        </div>
      )}

      {!applying && reason && (current === "NEEDS_ME" || current === "FAILED") && (
        <div
          className={`space-y-2 rounded-lg border p-3 text-sm ${
            current === "NEEDS_ME" ? "border-amber-900 bg-amber-950/30" : "border-rose-900 bg-rose-950/30"
          }`}
        >
          <p className="font-medium">{current === "NEEDS_ME" ? "توقف الوكيل ويحتاج تدخلك:" : "فشل التقديم:"}</p>
          <p dir="ltr" className="text-zinc-300">
            {reason}
          </p>
          {reason.startsWith("Unanswered question") && (
            <Link href="/answers" className="text-sky-400 underline hover:text-sky-300">
              أضف الإجابة في بنك الإجابات ثم أعد التقديم
            </Link>
          )}
          {reason.includes("Paste the direct application URL") && (
            <p className="text-zinc-400">الصق رابط الوظيفة المباشر عبر «تعديل الرابط» أعلى الصفحة ثم أعد التقديم.</p>
          )}
          {reason.includes("/accounts") && (
            <Link href="/accounts" className="text-sky-400 underline hover:text-sky-300">
              إدارة حسابات البوابات ثم أعد التقديم
            </Link>
          )}
        </div>
      )}

      {current !== "TAILORED" && current !== "SCORED" && current !== "NEW" && (
        <p className="muted text-xs">
          لقطات الشاشة والسجل في{" "}
          <bdi dir="ltr" className="font-mono">
            agent/runs/{jobId}/
          </bdi>
        </p>
      )}
    </div>
  );
}

/** The agent is paused with the browser open until the user handles the step and continues. */
function WaitingNotice({ jobId, waiting }: { jobId: string; waiting: AgentWaiting }) {
  const [state, action, pending] = useActionState<FormState>(() => continueApply(jobId), {});
  return (
    <div className="space-y-2 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm">
      <p className="font-medium text-amber-300">
        في انتظارك في المتصفح{" "}
        <span className="text-xs font-normal text-zinc-400">
          (محاولة {waiting.attempt} من {waiting.maxAttempts})
        </span>
      </p>
      <p dir="ltr" className="text-zinc-300">
        {waiting.reason}
      </p>
      <p dir="ltr" className="text-zinc-400">
        {waiting.todo}
      </p>
      <form action={action} className="flex flex-wrap items-center gap-3 pt-1">
        <button type="submit" disabled={pending} className="btn-primary">
          متابعة
        </button>
        <p className="muted text-xs">بعد إنهاء الخطوة في نافذة المتصفح اضغط «متابعة» هنا أو Enter في الطرفية.</p>
        {state.error && <p className="error">{state.error}</p>}
      </form>
    </div>
  );
}
