import "server-only";
import { MODELS, callAI } from "@/lib/ai";
import { profileForPrompt, type TailoredCv } from "@/lib/profile";

const REWRITE_SYSTEM = `You write the summary section of a CV tailored to a job.

HARD RULE — NO FABRICATION: use only facts stated in the candidate's profile. Never invent or exaggerate a skill,
tool, employer, title, date, metric, or scope, and never add unsupported characterisations. 2-4 sentences.
Respond with JSON only.`;

const SUMMARY_CHECK_SYSTEM = `You audit a CV summary against the candidate's profile, which is the only source of truth.

Flag every claim in the summary that is not directly supported by the profile, including:
- skills, tools, technologies, employers, titles, degrees, dates, numbers, or durations not in the profile
- inflated scope or seniority (e.g. "led" when the profile says "helped", "tooling for AI systems" when the profile says "a script")
- characterisations with no basis in the profile (e.g. "proven track record", "expert", "extensive")

Do not flag faithful paraphrases, reorderings, or condensed restatements of what the profile says.

Return JSON: { "unsupported": [{ "claim": string, "reason": string }] }. Use an empty array if every claim is supported.`;

type SummaryCheck = { unsupported: { claim: string; reason: string }[] };

/** Returns the claims in `summary` the profile does not support (Haiku). */
export async function flagUnsupportedClaims(summary: string, profileText: string): Promise<string[]> {
  const result = await callAI<SummaryCheck>(
    SUMMARY_CHECK_SYSTEM,
    `PROFILE:\n${profileText}\n\nSUMMARY TO AUDIT:\n${summary}`,
    { model: MODELS.fast, maxTokens: 1000 },
  );
  if (!Array.isArray(result.unsupported)) throw new Error("Summary check returned an unexpected shape");
  return result.unsupported.map((f) => `"${f.claim}": ${f.reason}`);
}

/**
 * Second line of defence for the free-text summary, which index-based selection
 * cannot constrain: audit it, regenerate once with the flags as hard constraints,
 * and fall back to the profile's own summary if it still drifts.
 */
export async function verifiedSummary(
  summary: string,
  profile: { fullName: string; location: string | null; summary: string | null; content: unknown },
  jobContext: string,
): Promise<Pick<TailoredCv, "summary" | "summarySource" | "summaryFlags">> {
  const profileText = profileForPrompt(profile);
  const fallback = (summaryFlags: string[]) => ({
    summary: profile.summary ?? "",
    summarySource: "profile" as const,
    summaryFlags,
  });

  try {
    const flags = await flagUnsupportedClaims(summary, profileText);
    if (flags.length === 0) return { summary, summarySource: "tailored" };

    const rewrite = await callAI<{ summary: string }>(
      REWRITE_SYSTEM,
      `MASTER PROFILE:\n${profileText}\n\n${jobContext}\n\nYour previous summary was:\n${summary}\n\nThese claims are NOT supported by the profile and must not appear in any form:\n${flags.map((f) => `- ${f}`).join("\n")}\n\nWrite a new summary that uses only facts stated in the profile. Return JSON: { "summary": string }`,
      { maxTokens: 800 },
    );
    const rewritten = String(rewrite.summary ?? "").trim();
    const remaining = rewritten ? await flagUnsupportedClaims(rewritten, profileText) : ["empty summary"];
    if (remaining.length === 0) return { summary: rewritten, summarySource: "regenerated", summaryFlags: flags };
    return fallback(remaining);
  } catch (err) {
    // An unverifiable summary is treated like a drifting one.
    return fallback([`verification failed: ${(err as Error).message}`]);
  }
}

