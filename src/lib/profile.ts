export type Experience = {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate?: string;
  bullets: string[];
};

export type Project = {
  name: string;
  description?: string;
  tech?: string[];
  bullets?: string[];
  url?: string;
};

export type ProfileContent = {
  education: { institution: string; degree: string; field?: string; startDate?: string; endDate?: string; details?: string[] }[];
  experience: Experience[];
  projects: Project[];
  skills: string[];
  certifications: { name: string; issuer?: string; date?: string }[];
  languages: { language: string; level?: string }[];
};

export type TailoredCv = {
  summary: string;
  /** tailored: passed the check; regenerated: passed after one rewrite; profile: fell back to the profile summary. */
  summarySource?: "tailored" | "regenerated" | "profile";
  /** Claims flagged by the summary check (those that triggered the rewrite, or that remained on fallback). */
  summaryFlags?: string[];
  experience: Experience[];
  projects: Project[];
  skills: string[];
};

export const EMPTY_PROFILE_CONTENT: ProfileContent = {
  education: [],
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
};

/** Coerce stored JSON into ProfileContent, defaulting missing sections. */
export function parseProfileContent(value: unknown): ProfileContent {
  const v = (value && typeof value === "object" ? value : {}) as Partial<ProfileContent>;
  return {
    education: Array.isArray(v.education) ? v.education : [],
    experience: Array.isArray(v.experience) ? v.experience : [],
    projects: Array.isArray(v.projects) ? v.projects : [],
    skills: Array.isArray(v.skills) ? v.skills : [],
    certifications: Array.isArray(v.certifications) ? v.certifications : [],
    languages: Array.isArray(v.languages) ? v.languages : [],
  };
}

/** Profile as JSON for prompts; `indexed` adds the positions tailoring selects by. */
export function profileForPrompt(
  profile: { fullName: string; location: string | null; summary: string | null; content: unknown },
  indexed = false,
): string {
  const c = parseProfileContent(profile.content);
  const withIndex = <T extends object>(items: T[]) => (indexed ? items.map((item, i) => ({ index: i, ...item })) : items);
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

