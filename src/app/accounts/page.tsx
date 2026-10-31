import { Suspense } from "react";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { AccountForm, AccountRow } from "./account-forms";

export default function AccountsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="حسابات بوابات التوظيف"
        description="حسابات موجودة يسجّل بها وكيل التقديم دخوله. لا ينشئ الوكيل حسابات جديدة أبداً، وكلمات المرور تُخزَّن مشفّرة ولا تُعرض."
      />
      <section className="card space-y-4">
        <h2 className="section-title">إضافة حساب</h2>
        <AccountForm />
      </section>
      <Suspense fallback={<p className="muted">جارٍ التحميل…</p>}>
        <AccountList />
      </Suspense>
    </div>
  );
}

async function AccountList() {
  await connection();
  // Never select the password: not even its ciphertext leaves the server.
  const accounts = await db.portalAccount.findMany({
    select: { id: true, domain: true, email: true, createdAt: true },
    orderBy: { domain: "asc" },
  });

  if (accounts.length === 0) return <p className="muted">لا توجد حسابات محفوظة بعد.</p>;

  return (
    <ul className="space-y-3">
      {accounts.map((a) => (
        <li key={a.id}>
          <AccountRow account={{ id: a.id, domain: a.domain, email: a.email }} />
        </li>
      ))}
    </ul>
  );
}
