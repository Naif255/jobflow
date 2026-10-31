# jobflow browser agent

Applies to one job in a real browser, using only your MasterProfile, the tailored
CV PDF and the answer bank. Whenever the form needs something else, it stops instead
of guessing. The cases are an unknown question, a CAPTCHA or OTP, and a login wall
with no stored account.

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

The job needs a tailored CV with a PDF, plus an apply URL. Without them the script
refuses to run and changes nothing.

## What it writes

| Outcome | Job.status / Application.status | Application.failureReason |
| --- | --- | --- |
| Confirmation page seen | `APPLIED` (+ `appliedAt`) | empty |
| Question it can't answer | `NEEDS_ME` | the question; it is also saved to the answer bank with an empty answer |
| Login rejected | `NEEDS_ME` | the site's error message; never retried |
| OTP / SMS or email code / 2FA / device confirmation | `NEEDS_ME` | the step and where the code was sent |
| Login required, no stored account | `NEEDS_ME` | the domain, and a pointer to /accounts |
| CAPTCHA or other blocker | `NEEDS_ME` | what is blocking |
| Anything else | `FAILED` | the error |

Questions saved with an empty answer appear at the top of the **/answers** page as
"يحتاج إجابتك". Answer them, then press **إعادة التقديم**.

Each run writes to `agent/runs/<job-id>/`, which is replaced on the next run:

- `log.txt`: the full agent log
- `step-NN.png`: a screenshot after each step
- `final.png`: the page when the run ended

Exit codes: `0` applied or needs-me, `2` refused, `3` failure recorded. Anything else
means the script crashed, and the app marks the job `FAILED`.

## Logging in

Accounts are managed on the app's **/accounts** page. Each account has a domain, an
email or username, and a password. The password is encrypted on save and never shown
again; you can only replace it. An account covers its domain and every subdomain, so
`linkedin.com` also matches `www.linkedin.com`.

- **Login first.** If an account is stored for the apply URL's domain, the agent opens
  that site's home page and signs in (or notices it's already signed in) before it opens
  the apply URL.
- **Credentials stay out of the model.** The model never sees the email or the
  password. It calls `enter_portal_email(index)` and `enter_portal_password(index)`,
  which look up the account for the *current page's* domain and type the value
  themselves. The password is only typed into a real `type=password` field, and only
  over HTTPS (localhost is allowed, for testing).
- **One attempt per site.** If the site rejects the login, the run stops with the
  site's error message. A second `enter_portal_password` call on the same site is
  refused in code and ends the run as `NEEDS_ME`, so a misbehaving model can't retry
  either.
- **OTP and verification.** If the site asks for a code sent by SMS or email, a 2FA
  step, or a device confirmation, the run stops and names the step.
- **No account stored.** A site that needs a login with no stored account ends the
  run with "Add one at /accounts".
- **Never signs up.** The agent never creates an account, signs up, or uses "forgot
  password", on any site. Applying as a guest is allowed if it doesn't involve setting
  a password.

## How it stays honest

- Before clicking the final submit button, the agent must call `verify_before_submit`
  and list every field with its source: `profile.<path>`, `answer.<key>`, `cv_pdf` or
  `portal_login`. Sources that don't exist, or answer-bank entries that are still empty,
  are rejected. Values that differ from their source (for example a split name or a
  mapped dropdown option) are allowed but logged as `review:` lines in `log.txt`.
- Web search, local file tools and arbitrary JavaScript are disabled.
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
