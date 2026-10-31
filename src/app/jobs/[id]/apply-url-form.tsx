"use client";

import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { updateApplyUrl, type FormState } from "@/app/actions";

/** Inline editor for Job.applyUrl, for pasting the direct posting when the agent can't find it. */
export function ApplyUrlForm({ jobId, applyUrl }: { jobId: string; applyUrl: string | null }) {
  const [editing, setEditing] = useState(false);
  const { state, pending, formProps } = useFormAction<FormState>(async (prev, formData) => {
    const next = await updateApplyUrl(jobId, prev, formData);
    if (next.ok) setEditing(false);
    return next;
  }, {});

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-zinc-500 underline hover:text-zinc-300">
        {applyUrl ? "تعديل الرابط" : "إضافة رابط التقديم"}
      </button>
    );
  }

  return (
    <form {...formProps} className="flex w-full flex-wrap items-center gap-2 pt-1">
      <input
        name="applyUrl"
        type="url"
        required
        dir="ltr"
        autoFocus
        defaultValue={applyUrl ?? ""}
        placeholder="https://careers.example.com/jobs/123"
        className="input min-w-0 flex-1"
      />
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "جارٍ الحفظ…" : "حفظ"}
      </button>
      <button type="button" onClick={() => setEditing(false)} className="btn-ghost">
        إلغاء
      </button>
      {state.error && <p className="error w-full">{state.error}</p>}
    </form>
  );
}
