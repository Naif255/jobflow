import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";

/** Streams the CV PDF written by generateCvPdf. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const application = await db.application.findUnique({
    where: { jobId: id },
    select: { cvPdfPath: true, job: { select: { company: true } } },
  });
  if (!application?.cvPdfPath) return new Response("CV PDF not generated yet", { status: 404 });

  let pdf: Buffer;
  try {
    pdf = await readFile(path.join(process.cwd(), application.cvPdfPath));
  } catch {
    return new Response("CV PDF file is missing", { status: 404 });
  }

  const profile = await db.masterProfile.findFirst({ select: { fullName: true } });
  const slug = (s: string | undefined) => (s ?? "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const filename = [slug(profile?.fullName), "CV", slug(application.job.company)].filter(Boolean).join("-") + ".pdf";

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
