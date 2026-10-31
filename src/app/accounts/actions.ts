"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { normalizeDomain } from "@/lib/domain";
import type { FormState } from "@/app/actions";

/**
 * Passwords are encrypted by the db client extension on every write and are
 * never read back here; an empty password on edit keeps the stored one.
 */
export async function saveAccount(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("id") ?? "").trim();
  const domain = normalizeDomain(String(formData.get("domain") ?? ""));
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!domain) return { error: "أدخل نطاقاً صالحاً، مثل linkedin.com." };
  if (!email) return { error: "البريد الإلكتروني أو اسم المستخدم مطلوب." };
  if (!id && !password) return { error: "كلمة المرور مطلوبة لحساب جديد." };

  try {
    if (id) {
      await db.portalAccount.update({ where: { id }, data: { domain, email, ...(password ? { password } : {}) } });
    } else {
      await db.portalAccount.create({ data: { domain, email, password } });
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: `يوجد حساب محفوظ للنطاق "${domain}" مسبقاً.` };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return { error: "هذا الحساب لم يعد موجوداً." };
    }
    throw err;
  }

  revalidatePath("/accounts");
  return { ok: id ? "تم حفظ التعديل." : "تمت إضافة الحساب." };
}

export async function deleteAccount(id: string): Promise<void> {
  await db.portalAccount.deleteMany({ where: { id } });
  revalidatePath("/accounts");
}
