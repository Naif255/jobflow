"use client";

import { useActionState } from "react";
import { tailorCv, type FormState } from "@/app/actions";

export function TailorButton({ jobId, hasCv }: { jobId: string; hasCv: boolean }) {
  const [state, action, pending] = useActionState<FormState>(() => tailorCv(jobId), {});

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "جارٍ التخصيص…" : hasCv ? "إعادة تخصيص السيرة" : "تخصيص السيرة الذاتية"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
    </form>
  );
}
