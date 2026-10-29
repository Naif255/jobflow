import { Suspense } from "react";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { AnswerForm, AnswerRow } from "./answer-forms";

export default function AnswersPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="بنك الإجابات"
        description="إجابات جاهزة لأسئلة نماذج التقديم. سيستخدمها وكيل التقديم في المرحلة الثانية بدلاً من التخمين."
      />
      <section className="card space-y-4">
        <h2 className="section-title">إضافة إجابة</h2>
        <AnswerForm />
      </section>
      <Suspense fallback={<p className="muted">جارٍ التحميل…</p>}>
        <AnswerList />
      </Suspense>
    </div>
  );
}

async function AnswerList() {
  await connection();
  const answers = await db.answerBank.findMany({ orderBy: { questionKey: "asc" } });

  if (answers.length === 0) return <p className="muted">لا توجد إجابات بعد.</p>;

  return (
    <ul className="space-y-3">
      {answers.map((a) => (
        <li key={a.id}>
          <AnswerRow answer={{ id: a.id, questionKey: a.questionKey, questionText: a.questionText, answer: a.answer }} />
        </li>
      ))}
    </ul>
  );
}
