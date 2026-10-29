"use client";

import { useActionState } from "react";
import { addJob, type FormState } from "./actions";

export function AddJobForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(addJob, {});

  return (
    <form action={action} className="space-y-3">
      <textarea
        name="input"
        required
        rows={14}
        dir="auto"
        placeholder="https://… أو الصق نص الوظيفة هنا"
        className="input font-mono"
      />
      {state.error && <p className="error">{state.error}</p>}
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "جارٍ الاستخراج والتقييم…" : "إضافة الوظيفة"}
      </button>
    </form>
  );
}
