"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import type { FormState } from "@/app/actions";
import { deleteAnswer, saveAnswer } from "./actions";

type Answer = { id: string; questionKey: string; questionText: string; answer: string };

export function AnswerForm({ initial, onDone }: { initial?: Answer; onDone?: () => void }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveAnswer, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.ok) return;
    if (onDone) onDone();
    else formRef.current?.reset();
  }, [state, onDone]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="field">
          <span>المفتاح</span>
          <input
            name="questionKey"
            required
            dir="ltr"
            placeholder="notice_period"
            defaultValue={initial?.questionKey}
            className="input font-mono"
          />
        </label>
        <label className="field">
          <span>نص السؤال</span>
          <input
            name="questionText"
            required
            dir="auto"
            placeholder="What is your notice period?"
            defaultValue={initial?.questionText}
            className="input"
          />
        </label>
      </div>
      <label className="field">
        <span>الإجابة</span>
        <textarea name="answer" required rows={3} dir="auto" defaultValue={initial?.answer} className="input" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="btn-primary">
          {pending ? "جارٍ الحفظ…" : initial ? "حفظ" : "إضافة"}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            إلغاء
          </button>
        )}
        {state.error && <p className="error">{state.error}</p>}
        {state.ok && !onDone && <p className="success">{state.ok}</p>}
      </div>
    </form>
  );
}

export function AnswerRow({ answer }: { answer: Answer }) {
  const [editing, setEditing] = useState(false);
  const [deleting, startDelete] = useTransition();

  if (editing) {
    return (
      <div className="card">
        <AnswerForm initial={answer} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="card flex items-start gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-mono text-xs text-zinc-500" dir="ltr">
          {answer.questionKey}
        </p>
        <p className="font-medium" dir="auto">
          {answer.questionText}
        </p>
        <p className="whitespace-pre-wrap text-sm text-zinc-300" dir="auto">
          {answer.answer}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={() => setEditing(true)} className="btn-ghost">
          تعديل
        </button>
        <button
          type="button"
          disabled={deleting}
          onClick={() => {
            if (confirm(`حذف الإجابة "${answer.questionKey}"؟`)) startDelete(() => deleteAnswer(answer.id));
          }}
          className="btn-danger"
        >
          {deleting ? "…" : "حذف"}
        </button>
      </div>
    </div>
  );
}
