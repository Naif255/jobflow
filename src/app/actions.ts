"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { callAI } from "@/lib/ai";
import { fetchReadableText, normalizeUrl, parseUrl } from "@/lib/extract";
import { parseProfileContent, type ProfileContent, type TailoredCv } from "@/lib/profile";
import { ApplyMethod } from "@/generated/prisma/enums";

export type FormState = { error?: string; ok?: string };

const MAX_JOB_CHARS = 20_000;

type ScoreResult = {
  title: string;
  company: string;
  location: string | null;
  applyMethod: string;
  applyUrl: string | null;
  applyEmail: string | null;
  matchScore: number;
  matchReasoning: string;
  keyRequirements: string[];
};

const SCORE_SYSTEM = `You extract structured data from job postings and score how well a candidate fits.

Return JSON with exactly these keys:
{
  "title": string,
  "company": string,
  "location": string | null,
  "applyMethod": "EMAIL" | "PORTAL" | "LINKEDIN" | "UNKNOWN",
  "applyUrl": string | null,
  "applyEmail": string | null,
  "matchScore": integer 0-100,
  "matchReasoning": string,
  "keyRequirements": string[]
}

Rules:
- applyMethod: EMAIL if the posting says to email an address; LINKEDIN if it is applied to via LinkedIn (Easy Apply or a linkedin.com job); PORTAL for an ATS or company careers site (Workday, Greenhouse, Lever, etc.); otherwise UNKNOWN.
- applyUrl / applyEmail: only values that literally appear in the posting. Never construct one.
- keyRequirements: 4-10 short items, must-haves first.
- matchScore: judge only against what the candidate profile actually contains. Missing must-haves weigh heavily. Be calibrated: 85+ means a strong fit on nearly all must-haves.
- matchReasoning: 2-4 sentences in Arabic naming the strongest matches and the most important gaps.
- keyRequirements: keep the posting's original language.
- If a field is unknown, use null (or "Unknown" for title/company).`;

export async function addJob(_prev: FormState, formData: FormData): Promise<FormState> {
  const input = String(formData.get("input") ?? "").trim();
  if (!input) return { error: "الصق رابط الوظيفة أو نص الإعلان." };

  const profile = await db.masterProfile.findFirst();
  if (!profile) return { error: "أنشئ ملفك الشخصي أولاً، فالتقييم يعتمد عليه." };

  const parsed = parseUrl(input);
  const url = parsed ? normalizeUrl(parsed) : null;

  if (url) {
    const existing = await db.job.findUnique({ where: { url }, select: { id: true } });
    if (existing) redirect(`/jobs/${existing.id}`);
  }

  let jobId: string;
  try {
    const rawText = url ? await fetchReadableText(url) : input;
    if (rawText.length < 200) {
      return {
        error: url
          ? "تعذّرت قراءة نص كافٍ من الصفحة (قد تتطلب تسجيل دخول أو JavaScript). الصق نص الوظيفة بدلاً من ذلك."
          : "النص قصير جداً ليكون إعلان وظيفة.",
      };
    }

    const result = await callAI<ScoreResult>(
      SCORE_SYSTEM,
      `CANDIDATE PROFILE:\n${profileForPrompt(profile)}\n\nJOB POSTING${url ? ` (from ${url})` : ""}:\n${rawText.slice(0, MAX_JOB_CHARS)}`,
    );

    const applyMethod = Object.values(ApplyMethod).includes(result.applyMethod as ApplyMethod)
      ? (result.applyMethod as ApplyMethod)
      : ApplyMethod.UNKNOWN;
    const score = Math.round(Number(result.matchScore));

    const job = await db.job.create({
      data: {
        url,
        rawText,
        source: "PASTED",
        title: result.title?.trim() || "Unknown",
        company: result.company?.trim() || "Unknown",
        location: result.location || null,
        applyMethod,
        applyUrl: result.applyUrl || (applyMethod === "EMAIL" ? null : url),
        applyEmail: result.applyEmail || null,
        matchScore: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : null,
        matchReasoning: result.matchReasoning || null,
        keyRequirements: Array.isArray(result.keyRequirements) ? result.keyRequirements.map(String) : [],
        status: "SCORED",
      },
    });
    jobId = job.id;
  } catch (err) {
    return { error: (err as Error).message };
  }

  revalidatePath("/jobs");
  redirect(`/jobs/${jobId}`);
}

type TailorResult = {
  summary: string;
  experience: { sourceIndex: number; bullets: string[] }[];
  projects: { sourceIndex: number; description?: string; bullets?: string[] }[];
  skills: string[];
};

const TAILOR_SYSTEM = `You tailor a candidate's CV to a specific job.

HARD RULE — NO FABRICATION:
You may only SELECT, REORDER, and REPHRASE content that exists in the candidate's MasterProfile.
Never invent or exaggerate a skill, tool, technology, employer, job title, date, metric, responsibility, degree, or certification.
Never inflate scope (e.g. "helped with" must not become "led"). If a number is not in the profile, do not add one.
If the job asks for something the profile lacks, leave it out — do not paper over gaps.

Return JSON with exactly these keys:
{
  "summary": string,            // 2-4 sentences, built only from facts in the profile
  "experience": [{ "sourceIndex": integer, "bullets": string[] }],
  "projects":   [{ "sourceIndex": integer, "description": string, "bullets": string[] }],
  "skills": string[]
}

- summary: state only facts present in the profile. No unsupported characterisations such as "proven track record", "expert", or "passionate".
- sourceIndex is the [index] of the entry in the profile. Order entries by relevance to the job; omit irrelevant ones.
- bullets: rephrase or reorder that entry's own bullets toward the job's language. Each bullet must be supported by the original entry.
- skills: copy names exactly as written in the profile's skills list, most relevant first. Never add a skill that is not in that list.`;

export async function tailorCv(jobId: string): Promise<FormState> {
  const [job, profile] = await Promise.all([
    db.job.findUnique({ where: { id: jobId } }),
    db.masterProfile.findFirst(),
  ]);
  if (!job) return { error: "الوظيفة غير موجودة." };
  if (!profile) return { error: "أنشئ ملفك الشخصي أولاً." };

  const content = parseProfileContent(profile.content);

  try {
    const result = await callAI<TailorResult>(
      TAILOR_SYSTEM,
      `MASTER PROFILE:\n${profileForPrompt(profile, true)}\n\nJOB: ${job.title} at ${job.company}\nKey requirements: ${JSON.stringify(job.keyRequirements ?? [])}\n\nJOB POSTING:\n${job.rawText.slice(0, MAX_JOB_CHARS)}`,
      6000,
    );
    const tailoredCv = enforceProfileBounds(result, content);

    await db.$transaction([
      db.application.upsert({
        where: { jobId },
        create: { jobId, tailoredCv, status: "DRAFT" },
        update: { tailoredCv, status: "DRAFT", failureReason: null },
      }),
      db.job.update({ where: { id: jobId }, data: { status: "TAILORED" } }),
    ]);
  } catch (err) {
    return { error: (err as Error).message };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
  return { ok: "تم تخصيص السيرة الذاتية." };
}

/**
 * Backstop for the no-fabrication rule: employers, titles, dates, and project
 * names are copied from the profile by index, and skills not in the profile are dropped.
 */
function enforceProfileBounds(result: TailorResult, content: ProfileContent): TailoredCv {
  // Keep only entries pointing at a real profile index, first occurrence wins.
  const pick = <T extends { sourceIndex: number }>(items: T[] | undefined, sourceLength: number) => {
    const seen = new Set<number>();
    return (Array.isArray(items) ? items : []).filter(({ sourceIndex: i }) => {
      if (!Number.isInteger(i) || i < 0 || i >= sourceLength || seen.has(i)) return false;
      seen.add(i);
      return true;
    });
  };

  const experience = pick(result.experience, content.experience.length).map((e) => {
    const src = content.experience[e.sourceIndex];
    const bullets = Array.isArray(e.bullets) && e.bullets.length ? e.bullets.map(String) : src.bullets;
    return { ...src, bullets };
  });

  const projects = pick(result.projects, content.projects.length).map((p) => {
    const src = content.projects[p.sourceIndex];
    return {
      ...src,
      description: p.description || src.description,
      bullets: Array.isArray(p.bullets) && p.bullets.length ? p.bullets.map(String) : src.bullets,
    };
  });

  const canonical = new Map(content.skills.map((s) => [s.trim().toLowerCase(), s]));
  const skills = [
    ...new Set(
      (Array.isArray(result.skills) ? result.skills : [])
        .map((s) => canonical.get(String(s).trim().toLowerCase()))
        .filter((s): s is string => Boolean(s)),
    ),
  ];

  return { summary: String(result.summary ?? ""), experience, projects, skills };
}

function profileForPrompt(
  profile: { fullName: string; location: string | null; summary: string | null; content: unknown },
  indexed = false,
): string {
  const c = parseProfileContent(profile.content);
  const withIndex = <T,>(items: T[]) => (indexed ? items.map((item, i) => ({ index: i, ...item })) : items);
  return JSON.stringify(
    {
      name: profile.fullName,
      location: profile.location,
      summary: profile.summary,
      ...c,
      experience: withIndex(c.experience),
      projects: withIndex(c.projects),
    },
    null,
    1,
  );
}

export async function saveProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const field = (name: string) => String(formData.get(name) ?? "").trim();
  const fullName = field("fullName");
  const email = field("email");
  if (!fullName || !email) return { error: "الاسم الكامل والبريد الإلكتروني مطلوبان." };

  let content: ProfileContent;
  try {
    content = parseProfileContent(JSON.parse(field("content") || "{}"));
  } catch (err) {
    return { error: `المحتوى ليس JSON صالحاً: ${(err as Error).message}` };
  }

  const data = {
    fullName,
    email,
    phone: field("phone") || null,
    location: field("location") || null,
    linkedinUrl: field("linkedinUrl") || null,
    summary: field("summary") || null,
    content,
  };

  const existing = await db.masterProfile.findFirst({ select: { id: true } });
  if (existing) await db.masterProfile.update({ where: { id: existing.id }, data });
  else await db.masterProfile.create({ data });

  revalidatePath("/profile");
  return { ok: "تم حفظ الملف الشخصي." };
}
