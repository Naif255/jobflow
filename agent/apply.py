"""Apply to one job with a real browser.

    python agent/apply.py --job-id <id> [--headless] [--max-steps 60]

Fills the application form using only the MasterProfile, the tailored CV PDF
and AnswerBank entries. If a PortalAccount covers the apply URL's domain it
logs in first, once, and never signs up anywhere. Anything else (an unknown
question, rejected login, OTP, CAPTCHA, a login wall without a stored account)
stops the run with status NEEDS_ME. Screenshots and the full log go to
agent/runs/<job-id>/.
"""


import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import urlparse

AGENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = AGENT_DIR.parent
MODEL = "anthropic/claude-sonnet-4.5"

# Exit codes: 0 applied or needs-me, 2 refused (nothing changed), 3 failure recorded in the database.
# Anything else is a crash; the app's launcher then marks the job FAILED.
EXIT_REFUSED = 2
EXIT_FAILED = 3


class Tee:
    """Mirror a stream into the run log. The original may be None when launched without a console."""

    def __init__(self, original: TextIO | None, log: TextIO):
        self.original, self.log = original, log

    def write(self, data: str) -> int:
        self.log.write(data)
        if self.original is not None:
            try:
                self.original.write(data)
            except UnicodeEncodeError:
                enc = self.original.encoding or "utf-8"
                self.original.write(data.encode(enc, errors="replace").decode(enc))
        return len(data)

    def flush(self) -> None:
        self.log.flush()
        if self.original is not None:
            self.original.flush()

    def isatty(self) -> bool:
        return False


def start_run_dir(job_id: str) -> Path:
    """Fresh run folder with stdout/stderr tee'd to log.txt. Runs before browser_use is
    imported so its log handlers write through the tee."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
        sys.exit(f"Invalid job id: {job_id!r}")
    run_dir = AGENT_DIR / "runs" / job_id
    run_dir.mkdir(parents=True, exist_ok=True)
    for old in run_dir.glob("*.png"):
        old.unlink()
    log = open(run_dir / "log.txt", "w", encoding="utf-8", buffering=1)
    sys.stdout = Tee(sys.stdout, log)
    sys.stderr = Tee(sys.stderr, log)
    return run_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply to a job with a browser agent.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--headless", action="store_true", help="run without a visible browser window")
    parser.add_argument("--max-steps", type=int, default=60)
    return parser.parse_args()


args = parse_args()
RUN_DIR = start_run_dir(args.job_id)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")

from browser_use import ActionResult, Agent, Browser, BrowserSession, ChatAnthropic, Tools  # noqa: E402
from browser_use.browser.events import TypeTextEvent  # noqa: E402
import httpx2  # noqa: E402  (the anthropic SDK's HTTP client)
from pydantic import BaseModel, Field  # noqa: E402

import db  # noqa: E402


@dataclass
class Outcome:
    status: str | None = None
    reason: str | None = None
    verified: bool = False
    # Account domains whose password has been typed once; a second attempt is refused.
    password_typed: set[str] = field(default_factory=set)


class FormField(BaseModel):
    label: str = Field(description="the field label or question exactly as shown on the page")
    value: str = Field(description="the value entered or option selected")
    source: str = Field(
        description='where the value came from: "profile.<path>", "answer.<questionKey>", "cv_pdf" or "portal_login"'
    )


class VerifyParams(BaseModel):
    fields: list[FormField]


def resolve_profile_path(profile: dict[str, Any], path: str) -> Any:
    """Walk "content.education.0.institution" through the profile's dicts and lists."""
    node: Any = profile
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
        else:
            return None
    return node


def profile_for_agent(row: dict[str, Any]) -> dict[str, Any]:
    keys = ("fullName", "email", "phone", "location", "linkedinUrl", "summary")
    profile = {k: row[k] for k in keys if row.get(k)}
    profile["content"] = row["content"]
    return profile


def normalize_domain(value: str) -> str:
    """Same canonical form as src/lib/domain.ts: bare lowercase host without "www."."""
    host = re.sub(r"^[a-z][a-z0-9+.-]*://", "", value.strip().lower())
    host = re.split(r"[/?#]", host)[0]
    return re.sub(r":\d+$", "", host).removeprefix("www.").rstrip(".")


def host_of(url: str | None) -> str:
    return normalize_domain(urlparse(url or "").hostname or "")


def account_for(accounts: list[db.PortalAccount], url: str | None) -> db.PortalAccount | None:
    """The stored account covering this URL's host (its domain or a subdomain); most specific wins."""
    host = host_of(url)
    if not host:
        return None
    matches = [a for a in accounts if host == a.domain or host.endswith("." + a.domain)]
    return max(matches, key=lambda a: len(a.domain), default=None)


def is_secure(url: str | None) -> bool:
    parsed = urlparse(url or "")
    return parsed.scheme == "https" or parsed.hostname in ("localhost", "127.0.0.1")


def build_task(
    apply_url: str,
    profile: dict[str, Any],
    answers: dict[str, dict[str, str]],
    cv_path: Path,
    account_domains: list[str],
    login_first: str | None,
) -> str:
    answer_lines = "\n".join(
        f'- answer.{key}\n  Q: {a["questionText"]}\n  A: {a["answer"]}' for key, a in answers.items()
    ) or "(none)"
    accounts = (
        "Stored accounts exist for these domains (each covers its subdomains): " + ", ".join(account_domains) + "."
        if account_domains
        else "No accounts are stored for any site."
    )
    if login_first:
        start = f"""STEP 1, LOG IN FIRST. You are on the home page of {login_first}, where an account is stored.
If you are already signed in, go straight to step 2. Otherwise open the site's sign-in page (sign IN, never sign up) and log in using the login rules below.
STEP 2. Once signed in, open {apply_url} and complete the application form."""
    else:
        start = f"Open {apply_url} and complete the application form."

    return f"""Apply to a job for the candidate described below.

{start}

=== DATA YOU MAY USE (nothing else) ===

PROFILE (cite as "profile.<path>", e.g. profile.email, profile.content.education.0.institution):
{json.dumps(profile, ensure_ascii=False, indent=1)}

ANSWER BANK (cite as "answer.<key>"):
{answer_lines}

CV FILE: for a resume/CV upload field, upload {cv_path} (cite as "cv_pdf"). Upload no other file.

PORTAL ACCOUNTS: {accounts}

=== LOGIN RULES ===

L1. Sign in only with enter_portal_email and enter_portal_password. They type the stored credentials for the current site; you never see or type a password yourself.
L2. NEVER create an account, register or sign up, on any site, even if offered. Never use "forgot password". Applying as a guest is fine as long as you never set a password.
L3. Submit the password once. If the site then shows any login error (wrong email or password, account not found, locked), call stop_login_failed with the error text exactly as shown. Do not try again.
L4. If, after the password or anywhere else, the site asks for a one-time code, a code sent by SMS or email, a two-factor step, or to confirm a device or an email address, call stop_verification_step naming that step.
L5. If the site requires signing in and no account is stored for its domain, call stop_login_required. Do not look for another way in.

=== FORM RULES ===

1. NEVER GUESS. Every value you enter must come from the PROFILE or the ANSWER BANK. Allowed: reformatting (splitting the full name, date formats, phone format) and choosing the dropdown/radio option that means the same as a stored answer. Not allowed: inferring, estimating, or reusing an answer to a different question.
2. If any form field, required or optional, asks for something the data above does not answer (including a cover letter, salary, availability, demographic or "how did you hear about us" questions), immediately call stop_unanswerable_question with the field's question text exactly as shown on the page. Do not fill it, skip it, or submit.
3. CAPTCHA: call stop_blocked with kind "captcha". Never attempt to solve one.
4. Before clicking the final submit button, call verify_before_submit listing EVERY field you filled, with its source. Click submit only after it returns OK.
5. After submitting, once the page confirms the application was received, call mark_submitted with the confirmation text. If submission shows validation errors, fix them using the allowed data or stop per rule 2.
6. Finish only through stop_unanswerable_question, stop_login_failed, stop_verification_step, stop_login_required, stop_blocked or mark_submitted. If something else makes the application impossible (job closed, page broken), call done with success=false and explain why.
"""


# Built-in actions a form never needs. Dropping them also keeps the action schema under
# Anthropic's structured-output limit of 16 union-typed parameters (the full set has 17),
# and keeps the agent off web search, local files and arbitrary JavaScript.
EXCLUDED_ACTIONS = [
    "search",
    "search_page",
    "find_elements",
    "screenshot",
    "save_as_pdf",
    "write_file",
    "replace_file",
    "read_file",
    "evaluate",
]


async def type_secret(browser_session: BrowserSession, index: int, text: str, key: str, password: bool) -> str | None:
    """Type a stored credential into element `index`; returns an error message instead of raising."""
    node = await browser_session.get_element_by_index(index)
    if node is None:
        return f"Element {index} is not available; the page may have changed."
    if password and (node.attributes or {}).get("type", "").lower() != "password":
        return f"Element {index} is not a password field; the password is only typed into one."
    event = browser_session.event_bus.dispatch(
        TypeTextEvent(node=node, text=text, clear=True, is_sensitive=True, sensitive_key_name=key)
    )
    await event
    await event.event_result(raise_if_any=True, raise_if_none=False)
    return None


def build_tools(outcome: Outcome, profile: dict[str, Any], answers: dict[str, dict[str, str]], accounts: list[db.PortalAccount]) -> Tools:
    tools = Tools(exclude_actions=EXCLUDED_ACTIONS)

    def stop(status: str, reason: str) -> ActionResult:
        outcome.status, outcome.reason = status, reason
        print(f"[jobflow] {reason}")
        return ActionResult(is_done=True, success=False, extracted_content=reason)

    @tools.action("Type the stored account email/username for the current site into the input with this index.")
    async def enter_portal_email(index: int, page_url: str, browser_session: BrowserSession) -> ActionResult:
        account = account_for(accounts, page_url)
        if not account:
            return ActionResult(error=f"No account is stored for {host_of(page_url)}. Call stop_login_required.")
        error = await type_secret(browser_session, index, account.email, "portal_email", password=False)
        if error:
            return ActionResult(error=error)
        print(f"[jobflow] Typed the stored email for {account.domain}")
        return ActionResult(extracted_content=f"Typed the stored email for {account.domain}.")

    @tools.action(
        "Type the stored password for the current site into the password input with this index. "
        "Allowed once per site: a second call means the login failed."
    )
    async def enter_portal_password(index: int, page_url: str, browser_session: BrowserSession) -> ActionResult:
        account = account_for(accounts, page_url)
        if not account:
            return ActionResult(error=f"No account is stored for {host_of(page_url)}. Call stop_login_required.")
        if account.domain in outcome.password_typed:
            # The first attempt did not get through; another try risks a lockout.
            return stop(
                db.NEEDS_ME,
                f"Login to {host_of(page_url)} did not succeed with the stored account for {account.domain}; "
                "not retrying. Check that account at /accounts.",
            )
        if not is_secure(page_url):
            return stop(db.NEEDS_ME, f"Refused to send the {account.domain} password over an insecure connection ({page_url}).")
        error = await type_secret(browser_session, index, account.password, "portal_password", password=True)
        if error:
            return ActionResult(error=error)
        outcome.password_typed.add(account.domain)
        print(f"[jobflow] Typed the stored password for {account.domain}")
        return ActionResult(extracted_content=f"Typed the stored password for {account.domain}. Submit the login form once.")

    @tools.action("Stop because the site rejected the login. Pass the error message exactly as shown.")
    async def stop_login_failed(error_message: str, page_url: str) -> ActionResult:
        account = account_for(accounts, page_url)
        where = account.domain if account else host_of(page_url)
        return stop(
            db.NEEDS_ME,
            f'Login to {host_of(page_url)} failed ("{error_message.strip()}"). Not retried; '
            f"check the {where} account at /accounts.",
        )

    @tools.action(
        "Stop because the site asks for a one-time code, SMS or email code, two-factor step, or device/email "
        "confirmation. Name the step and say where the code was sent if shown."
    )
    async def stop_verification_step(step: str, explanation: str, page_url: str) -> ActionResult:
        return stop(db.NEEDS_ME, f"Verification needed on {host_of(page_url)} ({step.strip()}): {explanation.strip()}")

    @tools.action("Stop because the site requires signing in and no account is stored for its domain.")
    async def stop_login_required(explanation: str, page_url: str) -> ActionResult:
        host = host_of(page_url)
        if account_for(accounts, page_url):
            return ActionResult(error=f"An account is stored for {host}; sign in with enter_portal_email and enter_portal_password.")
        return stop(
            db.NEEDS_ME,
            f"{host} requires signing in and no account is stored for it. Add one at /accounts, then retry. "
            f"({explanation.strip()})",
        )

    @tools.action(
        "Stop because a form field asks something not answerable from the PROFILE or ANSWER BANK. "
        "Pass the question text exactly as shown on the page."
    )
    async def stop_unanswerable_question(question_text: str) -> ActionResult:
        with db.connect() as conn:
            key = db.save_unanswered_question(conn, question_text)
        return stop(db.NEEDS_ME, f'Unanswered question "{question_text.strip()}" saved to the answer bank as {key}.')

    @tools.action(
        "Stop because the site needs a human for something other than login or verification: "
        "kind is captcha or other. Explain exactly what is blocking."
    )
    async def stop_blocked(kind: str, explanation: str) -> ActionResult:
        return stop(db.NEEDS_ME, f"Blocked ({kind}): {explanation.strip()}")

    @tools.action(
        "Call before clicking the final submit button, listing every field you filled with its source.",
        param_model=VerifyParams,
    )
    async def verify_before_submit(params: VerifyParams) -> ActionResult:
        problems = []
        for f in params.fields:
            source = f.source.strip()
            if source == "cv_pdf" or (source == "portal_login" and outcome.password_typed):
                continue
            if source.startswith("answer."):
                entry = answers.get(source.removeprefix("answer."))
                if not entry:
                    problems.append(f'"{f.label}": {source} is not an answered answer-bank entry')
                    continue
                stored = entry["answer"]
            elif source.startswith("profile."):
                stored = resolve_profile_path(profile, source.removeprefix("profile."))
                if stored in (None, "", [], {}):
                    problems.append(f'"{f.label}": {source} does not exist in the profile')
                    continue
            else:
                problems.append(f'"{f.label}": unknown source "{source}"')
                continue
            # Reformatting and option mapping are allowed, so this is logged for review rather than enforced.
            flat = json.dumps(stored, ensure_ascii=False).lower() if not isinstance(stored, str) else stored.lower()
            if f.value.strip().lower() not in flat and flat not in f.value.strip().lower():
                print(f'[jobflow] review: "{f.label}" = "{f.value}" (from {source})')

        if problems:
            print("[jobflow] verify_before_submit rejected:\n  " + "\n  ".join(problems))
            return ActionResult(
                error="Do not submit. These fields have no valid source:\n"
                + "\n".join(problems)
                + "\nIf a field cannot be sourced, call stop_unanswerable_question with its question text."
            )
        outcome.verified = True
        print(f"[jobflow] verify_before_submit OK ({len(params.fields)} fields)")
        return ActionResult(extracted_content="OK. All fields are sourced; you may click submit now.")

    @tools.action("Call after the page confirms the application was submitted, with the confirmation text.")
    async def mark_submitted(confirmation_text: str) -> ActionResult:
        outcome.status = db.APPLIED
        outcome.reason = None if outcome.verified else "Submitted without verify_before_submit; review log.txt."
        print(f"[jobflow] Submitted. Confirmation: {confirmation_text.strip()}")
        return ActionResult(is_done=True, success=True, extracted_content=confirmation_text)

    return tools


def playwright_chromium() -> str | None:
    """Chromium installed by `playwright install chromium`. browser-use's own lookup misses
    Playwright's chrome-win64 folder and falls back to Edge, so pass the path explicitly."""
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            path = p.chromium.executable_path
        return path if Path(path).is_file() else None
    except Exception:
        return None


def _drop_null_cache_control(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _drop_null_cache_control(v) for k, v in value.items() if not (k == "cache_control" and v is None)}
    if isinstance(value, list):
        return [_drop_null_cache_control(v) for v in value]
    return value


class OpenRouterAnthropicTransport(httpx2.AsyncHTTPTransport):
    """browser-use writes "cache_control": null on content blocks; Anthropic ignores it but
    OpenRouter's request validation rejects it, so strip those keys before sending."""

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST" and request.url.path.endswith("/messages"):
            body = _drop_null_cache_control(json.loads(request.content))
            request = httpx2.Request(
                request.method,
                request.url,
                headers=[(k, v) for k, v in request.headers.items() if k.lower() != "content-length"],
                json=body,
                extensions=request.extensions,
            )
        return await super().handle_async_request(request)


def claude() -> ChatAnthropic:
    """Claude through OpenRouter's Anthropic-compatible endpoint. browser-use's OpenRouter client
    forces a strict JSON schema, and Anthropic rejects the agent's action schema as too large
    to compile; the Anthropic client sends it as an ordinary tool call instead."""
    return ChatAnthropic(
        model=MODEL,
        auth_token=os.environ.get("OPENROUTER_API_KEY"),
        base_url="https://openrouter.ai/api",
        http_client=httpx2.AsyncClient(transport=OpenRouterAnthropicTransport(), timeout=120),
    )


def refuse(message: str) -> None:
    print(f"[jobflow] Refusing to run: {message}")
    sys.exit(EXIT_REFUSED)


async def run(job_id: str, headless: bool, max_steps: int, chromium: str | None) -> int:
    # Short-lived connections only: a run can take minutes and Neon drops idle connections.
    conn = db.connect()
    job = db.load_job(conn, job_id)
    if not job:
        refuse(f"no job with id {job_id}")
    application = db.load_application(conn, job_id)
    if not application or not application.get("tailoredCv"):
        refuse("this job has no tailored CV yet")
    cv_path = REPO_ROOT / (application.get("cvPdfPath") or "")
    if not application.get("cvPdfPath") or not cv_path.is_file():
        refuse("the tailored CV has no PDF on disk; re-run tailoring in the app")
    if not job.get("applyUrl"):
        refuse("the job has no apply URL (email applications are not handled by the agent)")
    if job["status"] == db.APPLIED:
        refuse("this job is already marked as applied")
    profile_row = db.load_profile(conn)
    if not profile_row:
        refuse("no MasterProfile exists")

    profile = profile_for_agent(profile_row)
    answers = {
        a["questionKey"]: {"questionText": a["questionText"], "answer": a["answer"]}
        for a in db.load_answers(conn)
        if a["answer"].strip()
    }
    accounts = [
        db.PortalAccount(normalize_domain(a.domain), a.email, a.password) for a in db.load_portal_accounts(conn)
    ]
    conn.close()

    # With an account for the apply URL's site, log in on its home page before opening the form.
    apply_url = job["applyUrl"]
    login_account = account_for(accounts, apply_url)
    origin = urlparse(apply_url)
    start_url = f"{origin.scheme}://{origin.netloc}/" if login_account else apply_url

    print(f"[jobflow] Applying to {job['title']} @ {job['company']}: {apply_url}")
    print(f"[jobflow] CV: {cv_path} | answers: {len(answers)} | portal accounts: {len(accounts)}")
    print(
        f"[jobflow] Logging in first with the stored {login_account.domain} account."
        if login_account
        else f"[jobflow] No stored account for {host_of(apply_url)}; opening the apply URL directly."
    )
    with db.connect() as conn:
        db.set_status(conn, job_id, db.APPLYING)

    outcome = Outcome()
    if not chromium:
        print("[jobflow] Playwright Chromium not found; letting browser-use pick a browser.")
    browser = Browser(
        headless=headless,
        keep_alive=True,
        executable_path=chromium,
        user_data_dir=str(AGENT_DIR / ".browser-profile"),
    )
    agent = Agent(
        task=build_task(
            apply_url,
            profile,
            answers,
            cv_path,
            [a.domain for a in accounts],
            login_account.domain if login_account else None,
        ),
        llm=claude(),
        browser=browser,
        tools=build_tools(outcome, profile, answers, accounts),
        # Open the start page ourselves; browser-use would otherwise jump to the first URL in the task.
        directly_open_url=False,
        initial_actions=[{"navigate": {"url": start_url, "new_tab": False}}],
        available_file_paths=[str(cv_path)],
        use_judge=False,
    )

    async def screenshot(name: str) -> None:
        try:
            await browser.take_screenshot(path=str(RUN_DIR / f"{name}.png"))
        except Exception as err:  # a screenshot must never fail the run
            print(f"[jobflow] screenshot {name} failed: {err}")

    async def on_step_end(a: Agent) -> None:
        # n_steps has already advanced to the next step when this hook runs.
        await screenshot(f"step-{a.state.n_steps - 1:02d}")

    try:
        history = await agent.run(max_steps=max_steps, on_step_end=on_step_end)
        if outcome.status is None:
            if history.is_done():
                outcome.status = db.FAILED
                outcome.reason = f"Agent stopped without submitting: {history.final_result() or 'no reason given'}"
            else:
                errors = [e for e in history.errors() if e]
                outcome.status = db.FAILED
                outcome.reason = errors[-1] if errors else f"Did not finish within {max_steps} steps."
    except (Exception, asyncio.CancelledError, KeyboardInterrupt) as err:
        outcome.status = db.FAILED
        outcome.reason = f"{type(err).__name__}: {err}" if str(err) else type(err).__name__
    finally:
        await screenshot("final")
        with db.connect() as conn:
            db.set_status(conn, job_id, outcome.status or db.FAILED, outcome.reason, applied=outcome.status == db.APPLIED)
        print(f"[jobflow] Result: {outcome.status} {outcome.reason or ''}".rstrip())
        try:
            await browser.kill()
        except Exception:
            pass

    return 0 if outcome.status in (db.APPLIED, db.NEEDS_ME) else EXIT_FAILED


if __name__ == "__main__":
    # Playwright's sync API refuses to run inside an event loop, so resolve the browser first.
    sys.exit(asyncio.run(run(args.job_id, args.headless, args.max_steps, playwright_chromium())))
