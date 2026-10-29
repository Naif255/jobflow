import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { ApplyMethodBadge, ScoreBadge, StatusBadge } from "@/components/badges";
import { PageHeader } from "@/components/ui";

export default function JobsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="الوظائف" description="مرتبة حسب درجة الملاءمة." />
      <Suspense fallback={<p className="muted">جارٍ تحميل الوظائف…</p>}>
        <JobList />
      </Suspense>
    </div>
  );
}

async function JobList() {
  await connection();
  const jobs = await db.job.findMany({
    orderBy: [{ matchScore: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    select: { id: true, title: true, company: true, location: true, matchScore: true, applyMethod: true, status: true },
  });

  if (jobs.length === 0) {
    return (
      <p className="muted">
        لا توجد وظائف بعد.{" "}
        <Link href="/" className="underline hover:text-white">
          أضف وظيفة
        </Link>
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {jobs.map((job) => (
        <li key={job.id}>
          <Link
            href={`/jobs/${job.id}`}
            className="card flex items-center gap-4 p-4 transition-colors hover:border-zinc-600"
          >
            <ScoreBadge score={job.matchScore} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                <bdi>{job.title}</bdi>
              </p>
              <p className="truncate text-sm text-zinc-400">
                <bdi>{job.company}</bdi>
                {job.location && (
                  <>
                    {" · "}
                    <bdi>{job.location}</bdi>
                  </>
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
              <ApplyMethodBadge method={job.applyMethod} />
              <StatusBadge status={job.status} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
