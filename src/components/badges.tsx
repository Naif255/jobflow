const pill = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

export function ScoreBadge({ score, large = false }: { score: number | null; large?: boolean }) {
  const tone =
    score == null
      ? "border-zinc-800 text-zinc-500"
      : score >= 75
        ? "border-emerald-900 bg-emerald-950/50 text-emerald-300"
        : score >= 50
          ? "border-amber-900 bg-amber-950/50 text-amber-300"
          : "border-rose-900 bg-rose-950/50 text-rose-300";
  const size = large ? "h-16 w-16 text-2xl" : "h-11 w-11 text-base";
  return (
    <div className={`flex shrink-0 items-center justify-center rounded-xl border font-semibold tabular-nums ${size} ${tone}`}>
      {score ?? "–"}
    </div>
  );
}

const methodLabels: Record<string, string> = {
  EMAIL: "بريد إلكتروني",
  PORTAL: "بوابة توظيف",
  LINKEDIN: "لينكدإن",
  UNKNOWN: "غير معروف",
};

export function ApplyMethodBadge({ method }: { method: string }) {
  return <span className={`${pill} border-sky-900 bg-sky-950/50 text-sky-300`}>{methodLabels[method] ?? method}</span>;
}

const statusLabels: Record<string, string> = {
  NEW: "جديدة",
  SCORED: "مُقيَّمة",
  TAILORED: "سيرة مخصصة",
  APPLYING: "جارٍ التقديم",
  NEEDS_ME: "تحتاج تدخلي",
  APPLIED: "تم التقديم",
  FAILED: "فشل",
  SKIPPED: "متجاهلة",
};

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "APPLIED"
      ? "border-emerald-900 bg-emerald-950/50 text-emerald-300"
      : status === "FAILED" || status === "NEEDS_ME"
        ? "border-rose-900 bg-rose-950/50 text-rose-300"
        : "border-zinc-700 bg-zinc-800/50 text-zinc-300";
  return <span className={`${pill} ${tone}`}>{statusLabels[status] ?? status}</span>;
}
