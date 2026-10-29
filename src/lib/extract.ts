import "server-only";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export function parseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Canonical form used for dedupe: no hash, no tracking params. */
export function normalizeUrl(url: URL): string {
  const u = new URL(url.toString());
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|ref$|refid$|trk|tracking|src$|source$|fbclid$|gclid$)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

/** Fetch a job page and return its readable text. */
export async function fetchReadableText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`فشل جلب الصفحة (HTTP ${res.status})`);

  const html = await res.text();
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = (article?.textContent ?? document.body?.textContent ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();

  // Apply links/emails often live outside the main article, so keep them visible to the model.
  const links = [...document.querySelectorAll("a[href]")]
    .map((a) => ({ text: (a.textContent ?? "").trim(), href: a.getAttribute("href") ?? "" }))
    .filter((l) => /apply|mailto:|career|job/i.test(l.text + l.href))
    .slice(0, 30)
    .flatMap((l) => {
      try {
        return [`- ${l.text || "(link)"}: ${new URL(l.href, url).toString()}`];
      } catch {
        return [];
      }
    });

  const title = article?.title ? `${article.title}\n\n` : "";
  return `${title}${text}${links.length ? `\n\nLinks on page:\n${links.join("\n")}` : ""}`;
}
