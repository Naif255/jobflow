import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/db";
import type { TailoredCv } from "@/lib/profile";
import { ApplyMethodBadge, ScoreBadge, StatusBadge } from "@/components/badges";
import { TailorButton } from "./tailor-button";

export default function JobPage({ params }: PageProps<"/jobs/[id]">) {
  return (
    <Suspense fallback={<p className="muted">جارٍ تحميل الوظيفة…</p>}>
      <JobDetail params={params} />
    </Suspense>
  );
}

async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const job = await db.job.findUnique({ where: { id }, include: { application: true } });
  if (!job) notFound();

  const requirements = Array.isArray(job.keyRequirements) ? (job.keyRequirements as string[]) : [];
  const cv = job.application?.tailoredCv as TailoredCv | undefined;
  const link = "text-sky-400 underline hover:text-sky-300";

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <ScoreBadge score={job.matchScore} large />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight" dir="auto">
            {job.title}
          </h1>
          <p className="text-zinc-400" dir="auto">
            {job.company}
            {job.location ? ` · ${job.location}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
            <ApplyMethodBadge method={job.applyMethod} />
            <StatusBadge status={job.status} />
            {job.applyUrl && (
              <a href={job.applyUrl} target="_blank" rel="noreferrer" className={link}>
                رابط التقديم
              </a>
            )}
            {job.applyEmail && (
              <a href={`mailto:${job.applyEmail}`} className={link} dir="ltr">
                {job.applyEmail}
              </a>
            )}
            {job.url && (
              <a href={job.url} target="_blank" rel="noreferrer" className="text-zinc-500 underline hover:text-zinc-300">
                المصدر
              </a>
            )}
          </div>
        </div>
      </header>

      {job.matchReasoning && (
        <Section title="سبب التقييم">
          <p className="text-sm leading-7" dir="auto">
            {job.matchReasoning}
          </p>
        </Section>
      )}

      {requirements.length > 0 && (
        <Section title="المتطلبات الأساسية">
          <ul className="list-disc space-y-1 ps-5 text-sm" dir="auto">
            {requirements.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="السيرة الذاتية المخصصة">
        <TailorButton jobId={job.id} hasCv={Boolean(cv)} />
        {cv && <CvPreview cv={cv} />}
      </Section>

      <Section title="وصف الوظيفة">
        <details>
          <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">عرض النص الكامل</summary>
          <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-7 text-zinc-300" dir="auto">
            {job.rawText}
          </pre>
        </details>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

/** The CV keeps the profile's own language and direction, independent of the Arabic UI. */
function CvPreview({ cv }: { cv: TailoredCv }) {
  return (
    <div className="space-y-5 border-t border-zinc-800 pt-4 text-sm text-zinc-200" dir="auto">
      <p className="leading-6">{cv.summary}</p>

      {cv.experience.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-zinc-100">Experience</h3>
          {cv.experience.map((e, i) => (
            <div key={i}>
              <p className="font-medium">
                {e.title} — {e.company}
              </p>
              <p className="text-xs text-zinc-500">
                {e.startDate} – {e.endDate || "Present"}
                {e.location ? ` · ${e.location}` : ""}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5">
                {e.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {cv.projects.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-zinc-100">Projects</h3>
          {cv.projects.map((p, i) => (
            <div key={i}>
              <p className="font-medium">{p.name}</p>
              {p.description && <p>{p.description}</p>}
              {p.bullets && p.bullets.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 ps-5">
                  {p.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {cv.skills.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-zinc-100">Skills</h3>
          <p>{cv.skills.join(" · ")}</p>
        </div>
      )}
    </div>
  );
}
