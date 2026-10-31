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
        description="إجابات جاهزة لأسئلة نماذج التقديم. يستخدمها وكيل التقديم بدلاً من التخمين، ويضيف هنا كل سؤال لا يجد له إجابة."
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

  // Questions the agent saved without an answer come first: they block applications.
  const missing = answers.filter((a) => !a.answer.trim());
  const sorted = [...missing, ...answers.filter((a) => a.answer.trim())];

  return (
    <div className="space-y-4">
      {missing.length > 0 && (
        <p className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-300">
          {missing.length === 1
            ? "سؤال واحد ينتظر إجابتك."
            : `${missing.length} أسئلة تنتظر إجابتك.`}{" "}
          أوقف وكيل التقديم بسببها، أجب عليها ثم أعد التقديم.
        </p>
      )}
      <ul className="space-y-3">
        {sorted.map((a) => (
          <li key={a.id}>
            <AnswerRow
              answer={{ id: a.id, questionKey: a.questionKey, questionText: a.questionText, answer: a.answer }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
