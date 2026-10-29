"use client";

import { useFormAction } from "@/components/use-form-action";
import { addJob, type FormState } from "./actions";

export function AddJobForm() {
  const { state, pending, formProps } = useFormAction<FormState>(addJob, {});

  return (
    <form {...formProps} className="space-y-3">
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
