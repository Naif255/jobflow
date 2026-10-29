"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { FormState } from "@/app/actions";

const KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export async function saveAnswer(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("id") ?? "").trim();
  const questionKey = String(formData.get("questionKey") ?? "").trim().toLowerCase();
  const questionText = String(formData.get("questionText") ?? "").trim();
  const answer = String(formData.get("answer") ?? "").trim();

  if (!questionKey || !questionText || !answer) return { error: "جميع الحقول مطلوبة." };
  if (!KEY_PATTERN.test(questionKey)) {
    return { error: "المفتاح يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطة سفلية، مثل notice_period." };
  }

  try {
    if (id) await db.answerBank.update({ where: { id }, data: { questionKey, questionText, answer } });
    else await db.answerBank.create({ data: { questionKey, questionText, answer } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: `المفتاح "${questionKey}" مستخدم مسبقاً.` };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "هذه الإجابة لم تعد موجودة." };
    }
    throw err;
  }

  revalidatePath("/answers");
  return { ok: id ? "تم حفظ التعديل." : "تمت إضافة الإجابة." };
}

export async function deleteAnswer(id: string): Promise<void> {
  await db.answerBank.deleteMany({ where: { id } });
  revalidatePath("/answers");
}
