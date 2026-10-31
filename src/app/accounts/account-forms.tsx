"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useFormAction } from "@/components/use-form-action";
import type { FormState } from "@/app/actions";
import { deleteAccount, saveAccount } from "./actions";

type Account = { id: string; domain: string; email: string };

export function AccountForm({ initial, onDone }: { initial?: Account; onDone?: () => void }) {
  const { state, pending, formProps } = useFormAction<FormState>(saveAccount, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.ok) return;
    if (onDone) onDone();
    else formRef.current?.reset();
  }, [state, onDone]);

  return (
    <form ref={formRef} {...formProps} className="space-y-3" autoComplete="off">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="field">
          <span>النطاق</span>
          <input
            name="domain"
            required
            dir="ltr"
            placeholder="linkedin.com"
            defaultValue={initial?.domain}
            className="input font-mono"
          />
        </label>
        <label className="field">
          <span>البريد أو اسم المستخدم</span>
          <input name="email" required dir="ltr" defaultValue={initial?.email} className="input" />
        </label>
        <label className="field">
          <span>كلمة المرور</span>
          {/* Never prefilled: the stored password can only be replaced. */}
          <input
            name="password"
            type="password"
            required={!initial}
            dir="ltr"
            autoComplete="new-password"
            placeholder={initial ? "اتركها فارغة للإبقاء عليها" : undefined}
            className="input"
          />
        </label>
      </div>
      <p className="muted text-xs">يغطي الحساب النطاق وكل نطاقاته الفرعية، فـ linkedin.com يشمل www.linkedin.com.</p>
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

export function AccountRow({ account }: { account: Account }) {
  const [editing, setEditing] = useState(false);
  const [deleting, startDelete] = useTransition();

  if (editing) {
    return (
      <div className="card">
        <AccountForm initial={account} onDone={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="card flex items-center gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-mono font-medium">
          <bdi dir="ltr">{account.domain}</bdi>
        </p>
        <p className="text-sm text-zinc-400">
          <bdi dir="ltr">{account.email}</bdi>
          <span className="ms-3 text-zinc-600">كلمة المرور: ••••••••</span>
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
            if (confirm(`حذف حساب "${account.domain}"؟`)) startDelete(() => deleteAccount(account.id));
          }}
          className="btn-danger"
        >
          {deleting ? "…" : "حذف"}
        </button>
      </div>
    </div>
  );
}
