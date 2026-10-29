import { Suspense } from "react";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { EMPTY_PROFILE_CONTENT } from "@/lib/profile";
import { PageHeader } from "@/components/ui";
import { ProfileForm } from "./profile-form";

export default function ProfilePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="الملف الشخصي"
        description="المصدر الوحيد للتقييم وتخصيص السيرة الذاتية. السيرة المخصصة لا تستخدم إلا ما هو موجود هنا."
      />
      <Suspense fallback={<p className="muted">جارٍ تحميل الملف…</p>}>
        <LoadedProfileForm />
      </Suspense>
    </div>
  );
}

async function LoadedProfileForm() {
  await connection();
  const profile = await db.masterProfile.findFirst();
  return (
    <ProfileForm
      initial={{
        fullName: profile?.fullName ?? "",
        email: profile?.email ?? "",
        phone: profile?.phone ?? "",
        location: profile?.location ?? "",
        linkedinUrl: profile?.linkedinUrl ?? "",
        summary: profile?.summary ?? "",
        content: JSON.stringify(profile?.content ?? EXAMPLE_CONTENT, null, 2),
      }}
    />
  );
}

/** Shape guide shown only when no profile exists yet. */
const EXAMPLE_CONTENT = {
  ...EMPTY_PROFILE_CONTENT,
  education: [{ institution: "", degree: "", field: "", startDate: "", endDate: "", details: [] }],
  experience: [{ company: "", title: "", location: "", startDate: "YYYY-MM", endDate: "", bullets: [""] }],
  projects: [{ name: "", description: "", tech: [""], bullets: [""], url: "" }],
  skills: [""],
  certifications: [{ name: "", issuer: "", date: "" }],
  languages: [{ language: "", level: "" }],
};
