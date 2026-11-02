# jobflow browser agent

Applies to one job in a real browser, using only your MasterProfile, the tailored
CV PDF and the answer bank. It never guesses. An unknown question stops the run. A step
only a person can pass (a CAPTCHA, an OTP or other verification, a login wall) pauses the
run with the browser open until you've done that step yourself (see [Human assist](#human-assist)).

It talks to the same Neon database as the app and reads `DATABASE_URL`,
`OPENROUTER_API_KEY` and `ENCRYPTION_KEY` from the repo's `.env`.

## Setup (Windows, PowerShell, from the repo root)

```powershell
python -m venv agent\.venv
agent\.venv\Scripts\python -m pip install -r agent\requirements.txt
agent\.venv\Scripts\python -m playwright install chromium
```

The app's "تقديم" button looks for the interpreter at `agent\.venv\Scripts\python.exe`
(`agent/.venv/bin/python` on macOS/Linux). Set `AGENT_PYTHON` in `.env` to use another one.

## Run

From the job page, press **تقديم**, or run it from the terminal:

```powershell
agent\.venv\Scripts\python agent\apply.py --job-id <id>              # visible browser
agent\.venv\Scripts\python agent\apply.py --job-id <id> --headless   # no window
```

`--max-steps N` caps the number of agent steps (default 60).

`--no-assist` is for unattended runs: a CAPTCHA, OTP or login wall stops the run with
`NEEDS_ME` instead of waiting for you. `--headless` implies it, since nobody can reach a
hidden browser. `--assist-timeout M` sets how many minutes each pause waits (default 30).

The job needs a tailored CV with a PDF, plus an apply URL (or an apply method of
LinkedIn). Without them the script refuses to run and changes nothing.

## Human assist

When the agent reaches a step it must not or cannot do itself, it pauses instead of
closing the browser. This covers a CAPTCHA, an OTP, SMS or email code, a 2FA or device
confirmation, a login wall with no stored account, a rejected login, or anything else
it reports as blocking.

1. The browser stays open and is brought to the front. On Windows the taskbar button
   may only flash instead of taking focus.
2. The terminal prints a banner that says what is blocking and what to do, for example
   "Solve the CAPTCHA in the browser window yourself".
3. You do that step in the browser and press **Enter** in the terminal. For a run started
   from the app, which has no terminal, press **متابعة** on the job page instead. Both
   work for either kind of run. While the agent waits, the job page shows
   "في انتظارك في المتصفح" with the reason.
4. The agent looks at the page again and continues from where it is. It doesn't restart
   the flow or reopen the apply URL.
5. If the same blocker is still there, it waits again. Each kind of blocker on each site
   gets at most 3 waits. After that, or if nobody responds within `--assist-timeout`
   minutes, the run stops with `NEEDS_ME` as before.

Each pause is logged with how long it lasted, for example
`Assist pause 1/3 ended after 1m 12s (Enter); re-checking the page.`

**The agent never solves a CAPTCHA**, and no CAPTCHA-solving service is used anywhere.
This is enforced in code, not only in the prompt. Any click, typing, dropdown or upload
aimed at a CAPTCHA widget is refused. That means an element inside an iframe served by
hCaptcha, reCAPTCHA, Cloudflare Turnstile or Arkose, or the widget's own container or
response field on the page. Ordinary fields next to a CAPTCHA, such as the email box it
protects, stay usable. Coordinate clicks are turned off, so every click names an element
that can be checked this way.

An unanswered form question is not a human-assist step. It still stops the run and goes
to the answer bank, because every submitted value has to have a recorded source.

## LinkedIn jobs

LinkedIn shows the apply link only after a login, and the agent never signs in to
LinkedIn. When the apply URL is on linkedin.com, or the apply method is LinkedIn, the
agent first looks for the same job on the company's own site (`resolve.py`):

1. It searches the web for the company and title. Search uses
   [ddgs](https://pypi.org/project/ddgs/), a free metasearch library that needs no API key.
2. It keeps results on a known ATS (Workday, Greenhouse, Lever, Ashby, SuccessFactors,
   Taleo, SmartRecruiters, Recruitee, BambooHR) whose URL names the company, or on a
   domain containing the company's name. Job boards are skipped.
3. It opens each page in headless Chromium. A page whose heading matches the title is a
   candidate. Any other page is treated as a job list, and its links whose text matches
   the title are opened.
4. A candidate must share at least 45% of its word 5-grams with the stored job text.
   In testing the same posting scored 54-86% and other jobs at the same company about
   33%. Then Claude compares the two texts (role, level, location, requirements) and
   must call it the same posting with high confidence.

When a match passes both checks, the agent saves it as `Job.applyUrl`, sets the apply
method to Portal, keeps the old link in `Job.linkedinUrl`, logs the URL and its
evidence, and applies there. Otherwise it stops with `NEEDS_ME`. You can then paste
the direct link with **تعديل الرابط** on the job page and retry. The original LinkedIn
link stays on the job page either way.

## What it writes

| Outcome | Job.status / Application.status | Application.failureReason |
| --- | --- | --- |
| Confirmation page seen | `APPLIED` (+ `appliedAt`) | empty |
| LinkedIn job not found on the company site, or match uncertain | `NEEDS_ME` | what was searched and the closest candidate |
| Question it can't answer | `NEEDS_ME` | the question; it is also saved to the answer bank with an empty answer |
| Login rejected | `NEEDS_ME`* | the site's error message; the agent never retries |
| OTP / SMS or email code / 2FA / device confirmation | `NEEDS_ME`* | the step and where the code was sent |
| Login required, no stored account | `NEEDS_ME`* | the domain, and a pointer to /accounts |
| CAPTCHA or other blocker | `NEEDS_ME`* | what is blocking |
| Anything else | `FAILED` | the error |

\* With human assist on (the default for a visible browser), these first pause and wait
for you. They end as `NEEDS_ME` only after 3 waits, a timeout, `--no-assist` or `--headless`.

Questions saved with an empty answer appear at the top of the **/answers** page as
"يحتاج إجابتك". Answer them, then press **إعادة التقديم**.

Each run writes to `agent/runs/<job-id>/`, which is replaced on the next run:

- `log.txt`: the full agent log
- `step-NN.png`: a screenshot after each step
- `final.png`: the page when the run ended
- `waiting.json`: present only while the agent waits for you; the job page reads it.
  If the agent's process is gone, or the pause is past its timeout, the app deletes it
  instead, and a dead run's job is marked `FAILED`

Exit codes: `0` applied or needs-me, `2` refused, `3` failure recorded. Anything else
means the script crashed, and the app marks the job `FAILED`.

## Logging in

Accounts are managed on the app's **/accounts** page. Each account has a domain, an
email or username, and a password. The password is encrypted on save and never shown
again; you can only replace it. An account covers its domain and every subdomain, so
`myworkdayjobs.com` also matches `aramco.wd3.myworkdayjobs.com`.

- **Login first.** If an account is stored for the apply URL's domain, the agent opens
  that site's home page and signs in (or notices it's already signed in) before it opens
  the apply URL.
- **Credentials stay out of the model.** The model never sees the email or the
  password. It calls `enter_portal_email(index)` and `enter_portal_password(index)`,
  which look up the account for the *current page's* domain and type the value
  themselves. The password is only typed into a real `type=password` field, and only
  over HTTPS (localhost is allowed, for testing).
- **One attempt per site.** If the site rejects the login, the agent reports the site's
  error message and waits for you to sign in by hand (with `--no-assist`, the run stops
  there). A second `enter_portal_password` call on the same site is refused in code and
  ends the run as `NEEDS_ME`, so a misbehaving model can't retry either.
- **OTP and verification.** If the site asks for a code sent by SMS or email, a 2FA
  step, or a device confirmation, the agent names the step and waits for you to
  complete it (see Human assist).
- **No account stored.** On a site that needs a login and has no stored account, the
  agent waits for you to sign in by hand. With `--no-assist`, the run ends with "Add one
  at /accounts".
- **Never signs up.** The agent never creates an account, signs up, or uses "forgot
  password", on any site. Applying as a guest is allowed if it doesn't involve setting
  a password.

## How it stays honest

- Before clicking the final submit button, the agent must call `verify_before_submit`
  and list every field with its source: `profile.<path>`, `answer.<key>`, `cv_pdf` or
  `portal_login`. Sources that don't exist, or answer-bank entries that are still empty,
  are rejected. Values that differ from their source (for example a split name or a
  mapped dropdown option) are allowed but logged as `review:` lines in `log.txt`.
- The form-filling agent has no web search, local file tools or arbitrary JavaScript.
  Only the LinkedIn lookup above searches the web, and it runs in code before the agent starts.
- It never signs in to LinkedIn: the credential tools refuse linkedin.com pages.
- Passwords are decrypted only inside the agent process, from the `v1:` AES-256-GCM
  format described in `src/lib/crypto.ts`.
- browser-use telemetry and cloud sync are turned off.

## Implementation notes

- **Playwright's role.** browser-use 0.13 drives Chrome directly over CDP. Playwright
  is only used to install Chromium and to report its path. browser-use's own lookup
  misses Playwright's `chrome-win64` folder and would quietly use Edge instead.
- **Model connection.** The model is `anthropic/claude-sonnet-4.5`, called through
  OpenRouter's Anthropic-compatible endpoint with browser-use's `ChatAnthropic` client.
  browser-use's `ChatOpenRouter` forces strict JSON-schema output, and Anthropic rejects
  the agent's action schema as too large to compile.
- **Request fix-up.** A small HTTP transport strips the `"cache_control": null` fields
  that browser-use emits, because OpenRouter's validation rejects them.
- **Browser profile.** `agent/.browser-profile/` keeps cookies between runs. If a site
  stops at a login wall, you can sign in once by hand in that profile; later runs reuse
  the session.
- **Database TLS.** The connection verifies Neon's certificate against the `certifi`
  CA bundle. On Windows, libpq can't read the OS certificate store.
