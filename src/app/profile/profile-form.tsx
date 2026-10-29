"use client";

import { useFormAction } from "@/components/use-form-action";
import { saveProfile, type FormState } from "@/app/actions";

type Initial = Record<"fullName" | "email" | "phone" | "location" | "linkedinUrl" | "summary" | "content", string>;

const fields: { name: keyof Initial; label: string; type?: string; required?: boolean; ltr?: boolean }[] = [
  { name: "fullName", label: "الاسم الكامل", required: true },
  { name: "email", label: "البريد الإلكتروني", type: "email", required: true, ltr: true },
  { name: "phone", label: "رقم الهاتف", type: "tel", ltr: true },
  { name: "location", label: "الموقع" },
  { name: "linkedinUrl", label: "رابط لينكدإن", type: "url", ltr: true },
];

export function ProfileForm({ initial }: { initial: Initial }) {
  const { state, pending, formProps } = useFormAction<FormState>(saveProfile, {});

  return (
    <form {...formProps} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.name} className="field">
            <span>{f.label}</span>
            <input
              name={f.name}
              type={f.type ?? "text"}
              required={f.required}
              dir={f.ltr ? "ltr" : "auto"}
              defaultValue={initial[f.name]}
              className="input"
            />
          </label>
        ))}
      </div>
      <label className="field">
        <span>النبذة</span>
        <textarea name="summary" rows={3} dir="auto" defaultValue={initial.summary} className="input" />
      </label>
      <label className="field">
        <span>المحتوى (JSON: education, experience, projects, skills, certifications, languages)</span>
        <textarea
          name="content"
          rows={24}
          dir="ltr"
          defaultValue={initial.content}
          spellCheck={false}
          className="input font-mono"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? "جارٍ الحفظ…" : "حفظ الملف"}
        </button>
        {state.error && <p className="error">{state.error}</p>}
        {state.ok && <p className="success">{state.ok}</p>}
      </div>
    </form>
  );
}
