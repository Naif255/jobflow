import "server-only";
import PDFDocument from "pdfkit";
import type { ProfileContent, TailoredCv } from "@/lib/profile";

type ProfileHeader = {
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
};

/**
 * ATS-friendly CV: one column of real text in a standard font, no images,
 * tables or columns, conventional section headings. Shrinks the type in steps
 * until it fits one page; if it still overflows at the smallest size it keeps
 * every line on a second page rather than dropping content.
 */
export async function renderCvPdf(
  profile: ProfileHeader,
  content: ProfileContent,
  cv: TailoredCv,
): Promise<{ pdf: Buffer; pages: number }> {
  let last: { pdf: Buffer; pages: number } | undefined;
  for (const size of [10.5, 10, 9.5, 9]) {
    last = await renderAt(size, profile, content, cv);
    if (last.pages === 1) break;
  }
  return last!;
}

const REGULAR = "Helvetica";
const BOLD = "Helvetica-Bold";
const OBLIQUE = "Helvetica-Oblique";

/**
 * ASCII only: the built-in PDF fonts carry no Unicode map, so anything beyond
 * ASCII (bullets, dashes, accents) extracts as junk in an ATS. Typographic
 * characters are mapped, accents stripped, and anything else (e.g. Arabic) dropped.
 */
function clean(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/\s+/g, " ")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/…/g, "...")
    .replace(/[•·]/g, "-")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/ +([,.;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

const join = (parts: (string | null | undefined)[], sep: string) =>
  parts.map(clean).filter(Boolean).join(sep);

const dateRange = (start?: string, end?: string) => {
  const s = clean(start);
  const e = clean(end);
  if (!s && !e) return "";
  return s ? `${s} - ${e || "Present"}` : e;
};

/** Profiles may store these as plain strings or as structured objects. */
const certificationLine = (c: ProfileContent["certifications"][number] | string) =>
  typeof c === "string" ? clean(c) : join([c.name, c.issuer, c.date], ", ");
const languageLine = (l: ProfileContent["languages"][number] | string) =>
  typeof l === "string" ? clean(l) : join([l.language, l.level && `(${l.level})`], " ");

const displayUrl = (url: string | null) => clean(url).replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

function renderAt(
  size: number,
  profile: ProfileHeader,
  content: ProfileContent,
  cv: TailoredCv,
): Promise<{ pdf: Buffer; pages: number }> {
  const margin = 46;
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    bufferPages: true,
    info: { Title: `${clean(profile.fullName)} - CV`, Author: clean(profile.fullName) },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const width = doc.page.width - margin * 2;
  const gap = size * 0.25;
  const text = (value: string, font = REGULAR, opts: PDFKit.Mixins.TextOptions = {}) =>
    doc.font(font).fontSize(size).fillColor("#000").text(value, { width, lineGap: 1, ...opts });

  const heading = (title: string) => {
    doc.moveDown(0.6);
    doc.font(BOLD).fontSize(size + 1.5).fillColor("#000").text(title.toUpperCase(), { width, characterSpacing: 0.5 });
    const y = doc.y + 1;
    doc.moveTo(margin, y).lineTo(margin + width, y).lineWidth(0.6).strokeColor("#000").stroke();
    doc.y = y + gap + 1;
  };

  // The bullet is a drawn dot, not a glyph, so extracted text is just the line itself.
  const indent = size * 1.1;
  const bullets = (items: string[] | undefined) => {
    for (const item of (items ?? []).map(clean).filter(Boolean)) {
      doc.font(REGULAR).fontSize(size);
      const y = doc.y;
      doc.circle(margin + size * 0.35, y + size * 0.42, size * 0.13).fill("#000");
      doc.fillColor("#000").text(item, margin + indent, y, { width: width - indent, lineGap: 1, paragraphGap: 0.5 });
      doc.x = margin;
    }
  };

  // Header: name and one line of contact details.
  doc.font(BOLD).fontSize(size * 2).text(clean(profile.fullName), { width, align: "center" });
  doc.moveDown(0.15);
  text(join([profile.email, profile.phone, profile.location, displayUrl(profile.linkedinUrl)], " | "), REGULAR, {
    align: "center",
  });

  if (clean(cv.summary)) {
    heading("Summary");
    text(clean(cv.summary));
  }

  if (cv.experience.length) {
    heading("Experience");
    cv.experience.forEach((e, i) => {
      if (i) doc.moveDown(0.4);
      text(join([e.title, e.company], ", "), BOLD);
      const meta = join([dateRange(e.startDate, e.endDate), e.location], " | ");
      if (meta) text(meta, OBLIQUE);
      bullets(e.bullets);
    });
  }

  if (cv.projects.length) {
    heading("Projects");
    cv.projects.forEach((p, i) => {
      if (i) doc.moveDown(0.4);
      text(clean(p.name), BOLD);
      if (p.tech?.length) text(`Technologies: ${join(p.tech, ", ")}`, OBLIQUE);
      if (clean(p.description)) text(clean(p.description));
      bullets(p.bullets);
      if (clean(p.url)) text(clean(p.url));
    });
  }

  if (content.education.length) {
    heading("Education");
    content.education.forEach((ed, i) => {
      if (i) doc.moveDown(0.4);
      text(join([join([ed.degree, ed.field], " in "), ed.institution], ", "), BOLD);
      const dates = dateRange(ed.startDate, ed.endDate);
      if (dates) text(dates, OBLIQUE);
      bullets(ed.details);
    });
  }

  if (cv.skills.length) {
    heading("Skills");
    text(join(cv.skills, ", "));
  }

  const certifications = content.certifications.map(certificationLine).filter(Boolean);
  if (certifications.length) {
    heading("Certifications");
    bullets(certifications);
  }

  const languages = content.languages.map(languageLine).filter(Boolean);
  if (languages.length) {
    heading("Languages");
    text(languages.join(", "));
  }

  const pages = doc.bufferedPageRange().count;
  doc.end();
  return done.then((pdf) => ({ pdf, pages }));
}
