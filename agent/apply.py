"""Apply to one job with a real browser.

    python agent/apply.py --job-id <id> [--headless] [--no-assist] [--max-steps 60]

A LinkedIn job is first looked up on the company's own careers site (see
resolve.py), since LinkedIn shows its apply link only after a login; if the
same posting can't be found with confidence, the run stops with NEEDS_ME.

Fills the application form using only the MasterProfile, the tailored CV PDF
and AnswerBank entries. If a PortalAccount covers the apply URL's domain it
logs in first, once, and never signs up anywhere. An unknown question stops the
run with status NEEDS_ME. A step only a human can pass (CAPTCHA, OTP or other
verification, a login wall or rejected login) pauses the run with the browser
open until you press Enter; the agent then re-checks the page and carries on.
With --no-assist or --headless those steps stop the run with NEEDS_ME instead.
Screenshots and the full log go to agent/runs/<job-id>/.
"""


import argparse
import asyncio
import json
import os
import re
import sys
import threading
import time
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

# Human-assist pauses. While the agent waits, WAITING_FILE in the run folder describes the pause
# for the job page. The page's continue button creates RESUME_FILE, which counts as pressing Enter.
WAITING_FILE = "waiting.json"
RESUME_FILE = "resume"
MAX_ASSISTS = 3


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
    for old in [*run_dir.glob("*.png"), run_dir / WAITING_FILE, run_dir / RESUME_FILE]:
        old.unlink(missing_ok=True)
    log = open(run_dir / "log.txt", "w", encoding="utf-8", buffering=1)
    sys.stdout = Tee(sys.stdout, log)
    sys.stderr = Tee(sys.stderr, log)
    return run_dir


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply to a job with a browser agent.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--headless", action="store_true", help="run without a visible browser window")
    parser.add_argument("--max-steps", type=int, default=60)
    parser.add_argument(
        "--no-assist",
        action="store_true",
        help="stop with NEEDS_ME at a CAPTCHA, OTP or login wall instead of waiting for you (unattended runs)",
    )
    parser.add_argument(
        "--assist-timeout",
        type=float,
        default=30,
        help="minutes to wait for you at each pause before stopping with NEEDS_ME (default 30)",
    )
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
import resolve  # noqa: E402


@dataclass
class Assist:
    """A step only a human can pass. The tool that hits it records it here, and the wait happens
    in on_step_end, which browser-use runs outside its per-step timeout."""

    key: str  # kind of blocker and site; each key gets at most MAX_ASSISTS waits
    reason: str  # recorded as the NEEDS_ME reason if the waits run out
    todo: str  # what the human has to do in the browser


@dataclass
class Outcome:
    status: str | None = None
    reason: str | None = None
    verified: bool = False
    # Account domains whose password has been typed once; a second attempt is refused.
    password_typed: set[str] = field(default_factory=set)
    pending_assist: Assist | None = None
    assist_counts: dict[str, int] = field(default_factory=dict)


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
L6. Never sign in to LinkedIn and never use "Apply with LinkedIn" or Easy Apply. If the only way to continue goes through LinkedIn, call stop_blocked with kind "other".

=== FORM RULES ===

1. NEVER GUESS. Every value you enter must come from the PROFILE or the ANSWER BANK. Allowed: reformatting (splitting the full name, date formats, phone format) and choosing the dropdown/radio option that means the same as a stored answer. Not allowed: inferring, estimating, or reusing an answer to a different question.
2. If any form field, required or optional, asks for something the data above does not answer (including a cover letter, salary, availability, demographic or "how did you hear about us" questions), immediately call stop_unanswerable_question with the field's question text exactly as shown on the page. Do not fill it, skip it, or submit.
3. CAPTCHA: call stop_blocked with kind "captcha". Never attempt to solve one, and never click, type into or otherwise touch a CAPTCHA widget, not even its checkbox.
4. Before clicking the final submit button, call verify_before_submit listing EVERY field you filled, with its source. Click submit only after it returns OK.
5. After submitting, once the page confirms the application was received, call mark_submitted with the confirmation text. If submission shows validation errors, fix them using the allowed data or stop per rule 2.
6. Finish only through stop_unanswerable_question, stop_login_failed, stop_verification_step, stop_login_required, stop_blocked or mark_submitted. If something else makes the application impossible (job closed, page broken), call done with success=false and explain why.
7. A human may take over the browser after stop_login_failed, stop_verification_step, stop_login_required or stop_blocked. If such a call returns instead of ending the run, look at the page again and continue the application from where it is now. Do not restart the flow or reopen the apply URL. If the same blocker is still there, call the same tool again.
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


# CAPTCHA widgets render inside an iframe served by the provider, so a frame from one of these
# hosts marks everything in it. Matching the word "captcha" anywhere up the tree or in the page
# URL is too broad: it blocked the plain email field on iCIMS's CAPTCHA-protected login page.
CAPTCHA_FRAME_URL = re.compile(
    r"^https?://([^/]*\.)?(hcaptcha\.com|recaptcha\.net|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com)/"
    r"|^https?://(www\.)?google\.com/recaptcha/",
    re.I,
)
# The widget's own elements on the host page: the response fields and the container divs.
CAPTCHA_ELEMENT = re.compile(r"^(h-captcha|g-recaptcha|cf-turnstile)(-response)?$", re.I)
# Actions aimed at a page element; none of them may reach a CAPTCHA widget.
ELEMENT_ACTIONS = {"click", "input", "send_keys", "select_dropdown", "dropdown_options", "upload_file"}


def in_captcha(node: Any, browser_session: BrowserSession) -> bool:
    """True if the element is a CAPTCHA widget or sits inside a CAPTCHA provider's iframe.
    The parent chain runs through iframes (browser-use links each iframe's document to its
    <iframe> element); a cross-origin frame's own URL is checked as well."""
    attrs = node.attributes or {}
    if any(CAPTCHA_ELEMENT.match(v) for k in ("name", "id", "class") for v in attrs.get(k, "").split()):
        return True
    while node is not None:
        if node.node_name.upper() == "IFRAME" and CAPTCHA_FRAME_URL.match((node.attributes or {}).get("src", "")):
            return True
        if node.target_id != browser_session.agent_focus_target_id:
            try:
                target = browser_session.session_manager.get_target(node.target_id)
                if target and CAPTCHA_FRAME_URL.match(getattr(target, "url", "") or ""):
                    return True
            except Exception:
                pass
        node = node.parent_node
    return False


class FormTools(Tools):
    """Refuses, in code, any action on a CAPTCHA widget. Coordinate clicks stay off (browser-use
    turns them on for Claude) so every click names an element this check can inspect."""

    def set_coordinate_clicking(self, enabled: bool) -> None:
        super().set_coordinate_clicking(False)

    async def act(self, action: Any, browser_session: BrowserSession, *args: Any, **kwargs: Any) -> ActionResult:
        for name, params in action.model_dump(exclude_unset=True).items():
            index = params.get("index") if isinstance(params, dict) else None
            if name not in ELEMENT_ACTIONS or index is None:
                continue
            try:
                node = await browser_session.get_element_by_index(index)
            except Exception:
                node = None
            if node is not None and in_captcha(node, browser_session):
                print(f"[jobflow] Refused {name} on element {index}: it is part of a CAPTCHA.")
                return ActionResult(
                    error='That element is part of a CAPTCHA. Never interact with a CAPTCHA; call stop_blocked with kind "captcha".'
                )
        return await super().act(action, browser_session, *args, **kwargs)


def build_tools(
    outcome: Outcome,
    profile: dict[str, Any],
    answers: dict[str, dict[str, str]],
    accounts: list[db.PortalAccount],
    assist: bool,
) -> Tools:
    tools = FormTools(exclude_actions=EXCLUDED_ACTIONS)

    def stop(status: str, reason: str) -> ActionResult:
        outcome.status, outcome.reason = status, reason
        print(f"[jobflow] {reason}")
        return ActionResult(is_done=True, success=False, extracted_content=reason)

    def needs_human(key: str, reason: str, todo: str) -> ActionResult:
        """Hand the step to the human (the wait runs in on_step_end), or stop with NEEDS_ME when
        assist is off or this blocker has already had its MAX_ASSISTS waits."""
        if not assist:
            return stop(db.NEEDS_ME, reason)
        waited = outcome.assist_counts.get(key, 0)
        if waited >= MAX_ASSISTS:
            return stop(db.NEEDS_ME, f"{reason} (still there after waiting for you {waited} times)")
        outcome.pending_assist = Assist(key, reason, todo)
        return ActionResult(
            extracted_content="The run is paused and a human is handling this in the browser. When your next "
            "step starts, look at the page again. If the blocker is gone, continue the application from the "
            "current page without restarting. If it is still there, call the same tool again.",
            long_term_memory=f"Paused for a human: {reason}",
        )

    @tools.action("Type the stored account email/username for the current site into the input with this index.")
    async def enter_portal_email(index: int, page_url: str, browser_session: BrowserSession) -> ActionResult:
        if resolve.is_linkedin(page_url):
            return ActionResult(error="Never sign in to LinkedIn. Call stop_blocked with kind \"other\".")
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
        if resolve.is_linkedin(page_url):
            return ActionResult(error="Never sign in to LinkedIn. Call stop_blocked with kind \"other\".")
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

    @tools.action(
        "Stop because the site rejected the login. Pass the error message exactly as shown.",
        terminates_sequence=True,
    )
    async def stop_login_failed(error_message: str, page_url: str) -> ActionResult:
        host = host_of(page_url)
        account = account_for(accounts, page_url)
        where = account.domain if account else host
        return needs_human(
            f"login_failed:{host}",
            f'Login to {host} failed ("{error_message.strip()}"). Not retried; check the {where} account at /accounts.',
            f"Sign in to {host} yourself in the browser window.",
        )

    @tools.action(
        "Stop because the site asks for a one-time code, SMS or email code, two-factor step, or device/email "
        "confirmation. Name the step and say where the code was sent if shown.",
        terminates_sequence=True,
    )
    async def stop_verification_step(step: str, explanation: str, page_url: str) -> ActionResult:
        host = host_of(page_url)
        return needs_human(
            f"verification:{host}",
            f"Verification needed on {host} ({step.strip()}): {explanation.strip()}",
            f"Complete the {step.strip()} in the browser window (enter the code and confirm it).",
        )

    @tools.action(
        "Stop because the site requires signing in and no account is stored for its domain.",
        terminates_sequence=True,
    )
    async def stop_login_required(explanation: str, page_url: str) -> ActionResult:
        host = host_of(page_url)
        if account_for(accounts, page_url):
            return ActionResult(error=f"An account is stored for {host}; sign in with enter_portal_email and enter_portal_password.")
        return needs_human(
            f"login_required:{host}",
            f"{host} requires signing in and no account is stored for it. Add one at /accounts, then retry. "
            f"({explanation.strip()})",
            f"Sign in to {host} yourself in the browser window.",
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
        "kind is captcha or other. Explain exactly what is blocking.",
        terminates_sequence=True,
    )
    async def stop_blocked(kind: str, explanation: str, page_url: str) -> ActionResult:
        kind = kind.strip().lower()
        todo = (
            "Solve the CAPTCHA in the browser window yourself. Leave the rest of the form to the agent."
            if kind == "captcha"
            else f"In the browser window: {explanation.strip()}"
        )
        return needs_human(f"{kind}:{host_of(page_url)}", f"Blocked ({kind}): {explanation.strip()}", todo)

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


async def resolve_linkedin_job(job: dict[str, Any], chromium: str | None) -> tuple[str | None, int]:
    """LinkedIn shows the apply link only after a login, so apply on the company's own
    posting instead. Returns its URL, or None and the exit code after recording why the run stopped."""
    print(f"[jobflow] {job['applyUrl'] or 'The job'} is on LinkedIn; looking for it on {job['company']}'s own site.")
    try:
        result = await resolve.find_on_company_site(job, chromium)
    except Exception as err:
        status, reason = db.FAILED, f"Looking for the job on the company site failed: {type(err).__name__}: {err}"
    else:
        if isinstance(result, resolve.Found):
            linkedin_url = next((u for u in (job["applyUrl"], job["url"]) if resolve.is_linkedin(u)), None)
            with db.connect() as conn:
                db.save_resolved_apply_url(conn, job["id"], result.url, linkedin_url)
            print(f"[jobflow] Found it on the company site: {result.url}")
            print(f"[jobflow] Confident because: {result.reason}")
            return result.url, 0
        status, reason = db.NEEDS_ME, (
            f"Could not locate this job on {job['company']}'s own careers site: {result.reason}. "
            "Paste the direct application URL on the job page, then retry."
        )
    with db.connect() as conn:
        db.set_status(conn, job["id"], status, reason)
    print(f"[jobflow] Result: {status} {reason}")
    return None, 0 if status == db.NEEDS_ME else EXIT_FAILED


class ResumeSignal:
    """Fires when Enter is pressed in the terminal or the job page creates RUN_DIR/resume.

    stdin is read on a daemon thread so the browser keeps running while we wait. When the app
    launches the agent, stdin is the null device: the first read hits EOF and the thread ends,
    leaving the job page's button as the only way to continue."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.entered = asyncio.Event()
        threading.Thread(target=self._read_stdin, daemon=True).start()

    def _read_stdin(self) -> None:
        try:
            while sys.stdin and sys.stdin.readline():
                self.loop.call_soon_threadsafe(self.entered.set)
        except (OSError, ValueError):
            pass

    async def wait(self, timeout: float) -> str | None:
        """How the human resumed ("Enter" or "the job page"), or None on timeout."""
        resume_file = RUN_DIR / RESUME_FILE
        resume_file.unlink(missing_ok=True)
        self.entered.clear()  # ignore Enter presses from before this pause
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.entered.is_set():
                return "Enter"
            if resume_file.exists():
                resume_file.unlink(missing_ok=True)
                return "the job page"
            try:
                await asyncio.wait_for(self.entered.wait(), timeout=0.5)
            except TimeoutError:
                pass
        return None


async def bring_to_front(browser: BrowserSession) -> None:
    """Un-minimize the browser window and raise the agent's tab. Windows may only flash the
    taskbar button instead of stealing focus from the terminal."""
    try:
        cdp = await browser.get_or_create_cdp_session()
        # Browser.* commands go to the root connection, not the page's session.
        window = await browser.cdp_client.send.Browser.getWindowForTarget(params={"targetId": cdp.target_id})
        await browser.cdp_client.send.Browser.setWindowBounds(
            params={"windowId": window["windowId"], "bounds": {"windowState": "normal"}}
        )
        await cdp.cdp_client.send.Page.bringToFront(session_id=cdp.session_id)
    except Exception as err:  # focus is a convenience; never fail the run over it
        print(f"[jobflow] Could not bring the browser to the front: {err}")


def format_duration(seconds: float) -> str:
    minutes, secs = divmod(round(seconds), 60)
    return f"{minutes}m {secs:02d}s" if minutes else f"{secs}s"


async def wait_for_human(assist: Assist, outcome: Outcome, browser: BrowserSession, signal: ResumeSignal, timeout: float) -> bool:
    """Pause with the browser open until the human resumes. Returns False if nobody did in time,
    after recording NEEDS_ME on the outcome."""
    attempt = outcome.assist_counts[assist.key] = outcome.assist_counts.get(assist.key, 0) + 1
    await bring_to_front(browser)
    waiting_file = RUN_DIR / WAITING_FILE
    waiting_file.write_text(
        json.dumps(
            {
                "reason": assist.reason,
                "todo": assist.todo,
                "attempt": attempt,
                "maxAttempts": MAX_ASSISTS,
                "since": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "pid": os.getpid(),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    rule = "=" * 72
    print(
        f"\n{rule}\n"
        f"[jobflow] WAITING FOR YOU in the browser ({attempt}/{MAX_ASSISTS})\n"
        f"[jobflow] Why: {assist.reason}\n"
        f"[jobflow] Do this: {assist.todo}\n"
        f"[jobflow] Then press Enter here, or press \"متابعة\" on the job page, and the agent continues from this page.\n"
        f"[jobflow] Waiting up to {format_duration(timeout)}.\n"
        f"{rule}"
    )
    started = time.monotonic()
    try:
        how = await signal.wait(timeout)
    finally:
        waiting_file.unlink(missing_ok=True)
    waited = format_duration(time.monotonic() - started)
    if how is None:
        print(f"[jobflow] Assist pause {attempt}/{MAX_ASSISTS} timed out after {waited}.")
        outcome.status = db.NEEDS_ME
        outcome.reason = f"{assist.reason} (nobody responded within {waited})"
        return False
    print(f"[jobflow] Assist pause {attempt}/{MAX_ASSISTS} ended after {waited} ({how}); re-checking the page.")
    return True


def refuse(message: str) -> None:
    print(f"[jobflow] Refusing to run: {message}")
    sys.exit(EXIT_REFUSED)


async def run(
    job_id: str, headless: bool, max_steps: int, chromium: str | None, assist: bool, assist_timeout: float
) -> int:
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
    needs_resolving = resolve.is_linkedin(job.get("applyUrl")) or job["applyMethod"] == "LINKEDIN"
    if not job.get("applyUrl") and not needs_resolving:
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

    if needs_resolving:
        with db.connect() as conn:
            db.set_status(conn, job_id, db.APPLYING)
        apply_url, code = await resolve_linkedin_job(job, chromium)
        if apply_url is None:
            return code
    else:
        apply_url = job["applyUrl"]

    # With an account for the apply URL's site, log in on its home page before opening the form.
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
    print(
        "[jobflow] Human assist is on: at a CAPTCHA, OTP or login wall the browser stays open and waits for you."
        if assist
        else "[jobflow] Human assist is off: a CAPTCHA, OTP or login wall stops the run with NEEDS_ME."
    )
    with db.connect() as conn:
        db.set_status(conn, job_id, db.APPLYING)

    outcome = Outcome()
    signal = ResumeSignal(asyncio.get_running_loop()) if assist else None
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
        tools=build_tools(outcome, profile, answers, accounts, assist),
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
        # Pauses run here rather than inside the tool: browser-use cancels a step after 180 s.
        if outcome.pending_assist and signal:
            pending, outcome.pending_assist = outcome.pending_assist, None
            if not await wait_for_human(pending, outcome, browser, signal, assist_timeout * 60):
                a.stop()

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
    # A headless browser can't be handed to a human, so it never waits.
    assist = not (args.no_assist or args.headless)
    sys.exit(
        asyncio.run(
            run(args.job_id, args.headless, args.max_steps, playwright_chromium(), assist, args.assist_timeout)
        )
    )
