"use client";

import { useActionState } from "react";
import { generateCvPdf, type FormState } from "@/app/actions";

/** Re-renders the PDF from the current tailored CV, then downloads it. */
export function CvPdfButton({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState<FormState>(async () => {
    const result = await generateCvPdf(jobId);
    if (!result.error) {
      const link = document.createElement("a");
      link.href = `/jobs/${jobId}/cv`;
      link.download = "";
      link.click();
    }
    return result;
  }, {});

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending} className="btn-ghost">
        {pending ? "جارٍ إنشاء الملف…" : "تحميل السيرة PDF"}
      </button>
      {state.error && <p className="error">{state.error}</p>}
      {state.ok && state.ok !== "تم إنشاء ملف PDF." && <p className="text-sm text-amber-400">{state.ok}</p>}
    </form>
  );
}
