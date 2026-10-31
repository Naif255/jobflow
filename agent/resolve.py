"""Find a LinkedIn job's own posting on the company's careers site.

LinkedIn hides the real apply link behind a login, so before applying the agent
looks for the same job elsewhere:

1. Web search (ddgs: free, no API key) for the company and title.
2. Keep results on a known ATS host or on a domain carrying the company's name.
3. Render each page in headless Chromium. A page whose heading matches the title
   is a candidate; otherwise it is treated as a job listing and its links whose
   text matches the title are opened.
4. Each candidate must share a large part of its text with the stored rawText
   (word 5-gram overlap), and then a model must judge it to be the same posting
   with high confidence. Title alone never decides.

Anything short of that returns NotFound, and the caller stops with NEEDS_ME.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any
from urllib.parse import urlparse

import httpx2
from ddgs import DDGS
from playwright.async_api import BrowserContext, async_playwright

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
VERIFY_MODEL = "anthropic/claude-sonnet-4.5"

ATS_HOSTS = (
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "successfactors.com",
    "successfactors.eu",
    "taleo.net",
    "smartrecruiters.com",
    "recruitee.com",
    "bamboohr.com",
)
# Job boards and social sites: they repost jobs but are never the company's own posting.
SKIP_HOSTS = (
    "linkedin.com",
    "lnkd.in",
    "indeed.com",
    "glassdoor.com",
    "bayt.com",
    "naukrigulf.com",
    "gulftalent.com",
    "wuzzuf.net",
    "ziprecruiter.com",
    "jooble.org",
    "talent.com",
    "builtin.com",
    "wellfound.com",
    "facebook.com",
    "x.com",
    "twitter.com",
    "instagram.com",
    "youtube.com",
    "wikipedia.org",
    "crunchbase.com",
)
# Dropped from company names before they are matched against hostnames.
COMPANY_NOISE = {
    "inc", "llc", "ltd", "limited", "co", "company", "corp", "corporation", "group", "holding",
    "holdings", "plc", "gmbh", "sa", "ag", "the", "and", "of", "international", "global",
}
# Dropped from page headings before comparing them with the job title.
HEADING_NOISE = {"careers", "career", "jobs", "job", "at", "apply", "now", "opening", "openings", "details"}

MAX_SEARCH_PAGES = 6
MAX_LINKS_PER_PAGE = 3
MAX_VERIFIED = 3
TITLE_MATCH = 0.6
# Share of the shorter text's word 5-grams that also appear in the other text.
# The same posting copied to LinkedIn scored 54-86% in testing; a different job
# at the same company shared only boilerplate (about a third).
MIN_TEXT_OVERLAP = 0.45
PAGE_TIMEOUT_MS = 25_000
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)


@dataclass
class Page:
    url: str
    headings: list[str]
    text: str
    links: list[tuple[str, str]] = field(default_factory=list)
    title_score: float = 0.0
    overlap: float = 0.0


@dataclass
class Found:
    url: str
    reason: str


@dataclass
class NotFound:
    reason: str


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def on_host(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def is_linkedin(url: str | None) -> bool:
    return on_host(host_of(url or ""), ("linkedin.com", "lnkd.in"))


def words(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def company_tokens(company: str) -> list[str]:
    """Name parts long enough to identify the company in a hostname, plus the joined name."""
    parts = [w for w in words(company) if w not in COMPANY_NOISE]
    tokens = {w for w in parts if len(w) >= 4}
    if len(parts) > 1:
        tokens.add("".join(parts))
    return sorted(tokens, key=len, reverse=True)


def title_score(job_title: str, heading: str, noise: set[str]) -> float:
    """1.0 for the same words; titles with extra or missing words score lower."""
    a = [w for w in words(job_title) if w not in noise]
    b = [w for w in words(heading) if w not in noise]
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    dice = 2 * len(sa & sb) / (len(sa) + len(sb))
    return max(dice, SequenceMatcher(None, " ".join(a), " ".join(b)).ratio())


def text_overlap(a: str, b: str, n: int = 5) -> float:
    def grams(text: str) -> set[tuple[str, ...]]:
        w = words(text)
        return {tuple(w[i : i + n]) for i in range(len(w) - n + 1)}

    ga, gb = grams(a), grams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / min(len(ga), len(gb))


def search(queries: list[str]) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    with DDGS() as ddgs:
        for q in queries:
            try:
                hits = ddgs.text(q, max_results=10)
            except Exception as err:  # "No results found" is raised as an exception
                print(f"[jobflow] search {q!r}: {err}")
                continue
            print(f"[jobflow] search {q!r}: {len(hits)} results")
            results.extend(hits)
    return results


def company_site_urls(results: list[dict[str, str]], company: str, job_title: str) -> list[str]:
    """Search hits on an ATS host or the company's own domain, best title match first."""
    tokens = company_tokens(company)
    ranked: dict[str, tuple[int, float]] = {}
    for r in results:
        url = r.get("href") or ""
        host = host_of(url)
        if not url.startswith("http") or not host or on_host(host, SKIP_HOSTS):
            continue
        path = urlparse(url).path.lower()
        if on_host(host, ATS_HOSTS):
            # ATS hosts serve every company; the company has to appear in the subdomain or path.
            if not any(t in host or t in path.replace("-", "") for t in tokens):
                continue
            kind = 0
        elif any(t in host for t in tokens):
            kind = 1
        else:
            continue
        rank = (kind, -title_score(job_title, r.get("title") or "", HEADING_NOISE | set(words(company))))
        ranked[url] = min(ranked.get(url, rank), rank)
    return sorted(ranked, key=lambda u: ranked[u])[:MAX_SEARCH_PAGES]


READ_PAGE_JS = """() => {
  const heads = [document.title, ...[...document.querySelectorAll('h1, h2')].slice(0, 6).map(h => h.innerText)];
  const links = [...document.querySelectorAll('a[href]')].slice(0, 2000).map(a => [a.innerText || a.title || '', a.href]);
  return { heads, text: document.body ? document.body.innerText : '', links };
}"""


async def read_page(context: BrowserContext, url: str) -> Page | None:
    page = await context.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        try:  # most careers sites render their postings with JavaScript
            await page.wait_for_load_state("networkidle", timeout=8_000)
        except Exception:
            pass
        data = await page.evaluate(READ_PAGE_JS)
        return Page(
            url=page.url,
            headings=[" ".join(h.split()) for h in data["heads"] if h and h.strip()],
            text=data["text"],
            links=[(" ".join(t.split()), h) for t, h in data["links"] if h.startswith("http")],
        )
    except Exception as err:
        print(f"[jobflow] could not open {url}: {type(err).__name__}: {str(err).splitlines()[0] if str(err) else ''}")
        return None
    finally:
        await page.close()


def extract_json(text: str) -> Any:
    body = re.sub(r"^```(?:json)?|```$", "", text.strip()).strip()
    start, end = body.find("{"), body.rfind("}")
    return json.loads(body[start : end + 1] if start != -1 and end > start else body)


VERIFY_SYSTEM = """You decide whether a page on a company's careers site is the SAME job posting as one saved from LinkedIn.

"Same" means the same opening: same role and seniority level, same location or remote arrangement, and a description that matches (same responsibilities and requirements, usually the same wording). A different level (Senior vs. Staff, I vs. II), a different location, team or contract type, or a generic careers page is NOT the same posting. A listing page, a closed posting, or a page whose description you cannot see is NOT a match.

Return JSON only: {"same_posting": boolean, "confidence": "high" | "medium" | "low", "reason": string}
"reason": one or two sentences citing the concrete evidence (matching or conflicting title, location, distinctive requirements)."""


async def verify_same_posting(job: dict[str, Any], page: Page) -> dict[str, Any]:
    user = (
        f"SAVED JOB\nTitle: {job['title']}\nCompany: {job['company']}\nLocation: {job.get('location') or 'unknown'}\n"
        f"Text:\n{job['rawText'][:8000]}\n\n"
        f"CAREERS SITE PAGE\nURL: {page.url}\nHeadings: {' | '.join(page.headings)}\nText:\n{page.text[:8000]}"
    )
    async with httpx2.AsyncClient(timeout=120) as client:
        res = await client.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {os.environ.get('OPENROUTER_API_KEY', '')}", "X-Title": "jobflow"},
            json={
                "model": VERIFY_MODEL,
                "max_tokens": 400,
                "temperature": 0,
                "messages": [{"role": "system", "content": VERIFY_SYSTEM}, {"role": "user", "content": user}],
            },
        )
    res.raise_for_status()
    return extract_json(res.json()["choices"][0]["message"]["content"])


async def find_on_company_site(job: dict[str, Any], chromium: str | None) -> Found | NotFound:
    title, company = job["title"].strip(), job["company"].strip()
    if not title or not company or "unknown" in (title.lower(), company.lower()):
        return NotFound("the job has no usable title or company name to search for")
    if not company_tokens(company):
        return NotFound(f'the company name "{company}" is too short to match against website addresses')

    results = await asyncio.to_thread(
        search, [f"{company} {title} careers", f"{company} {title} apply", f"{company} careers jobs"]
    )
    urls = company_site_urls(results, company, title)
    if not urls:
        return NotFound(f"web search found no page on {company}'s own site or a known ATS")
    print(f"[jobflow] company-site pages to check: {', '.join(urls)}")

    heading_noise = HEADING_NOISE | set(words(company))
    candidates: dict[str, Page] = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=chromium, headless=True)
        context = await browser.new_context(user_agent=USER_AGENT)
        seen: set[str] = set()
        try:
            for url in urls:
                if url in seen:
                    continue
                seen.add(url)
                page = await read_page(context, url)
                if not page:
                    continue
                page.title_score = max((title_score(title, h, heading_noise) for h in page.headings), default=0.0)
                if page.title_score >= TITLE_MATCH:
                    candidates.setdefault(page.url, page)
                    continue
                # Not a posting itself: look for one among the page's links.
                links = sorted(
                    {(title_score(title, text, heading_noise), href) for text, href in page.links if text},
                    reverse=True,
                )
                for score, href in [l for l in links if l[0] >= TITLE_MATCH][:MAX_LINKS_PER_PAGE]:
                    if href in seen or on_host(host_of(href), SKIP_HOSTS):
                        continue
                    seen.add(href)
                    posting = await read_page(context, href)
                    if posting:
                        posting.title_score = max(
                            [score, *(title_score(title, h, heading_noise) for h in posting.headings)]
                        )
                        candidates.setdefault(posting.url, posting)
        finally:
            await browser.close()

    for c in candidates.values():
        c.overlap = text_overlap(job["rawText"], c.text)
        print(f"[jobflow] candidate {c.url}: title match {c.title_score:.2f}, text overlap {c.overlap:.0%}")
    plausible = sorted(
        (c for c in candidates.values() if c.overlap >= MIN_TEXT_OVERLAP and not is_linkedin(c.url)),
        key=lambda c: (c.overlap, c.title_score),
        reverse=True,
    )
    if not plausible:
        best = max(candidates.values(), key=lambda c: c.overlap, default=None)
        detail = (
            f"; closest was {best.url} with {best.overlap:.0%} text overlap (needs {MIN_TEXT_OVERLAP:.0%})"
            if best
            else f"; checked {len(seen)} pages and none had a matching title"
        )
        return NotFound(f"no posting on {company}'s site matched the saved description{detail}")

    rejected = []
    for c in plausible[:MAX_VERIFIED]:
        try:
            verdict = await verify_same_posting(job, c)
        except Exception as err:
            return NotFound(f"could not verify {c.url}: {type(err).__name__}: {err}")
        reason = str(verdict.get("reason", "")).strip()
        print(
            f"[jobflow] verify {c.url}: same_posting={verdict.get('same_posting')} "
            f"confidence={verdict.get('confidence')}: {reason}"
        )
        if verdict.get("same_posting") is True and verdict.get("confidence") == "high":
            return Found(
                c.url,
                f"title match {c.title_score:.2f}, {c.overlap:.0%} of the description matches the saved text; {reason}",
            )
        rejected.append(f"{c.url} ({verdict.get('confidence')} confidence: {reason})")
    return NotFound("the closest match was not confidently the same posting: " + "; ".join(rejected))
