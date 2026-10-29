# jobflow

A personal job-application pipeline. Paste a job URL or posting; jobflow extracts it, scores it against your master profile, and tailors your CV for it — without inventing anything that isn't in your profile.

**Phase 1** (this repo, done) covers intake, scoring, and tailoring. **Phase 2** adds a Python browser agent that applies and Gmail job-alert ingestion.

The UI is Arabic (RTL). Stack: Next.js 16 (App Router, Cache Components), TypeScript, Tailwind 4, Prisma 7 on PostgreSQL (Neon), OpenRouter.

## What it does

| Page | Purpose |
| --- | --- |
| `/` | Paste a job URL or text. URLs are fetched and reduced to readable text, then one AI call extracts title, company, location, apply method/URL/email, a 0–100 match score, reasoning, and key requirements. URLs are deduped (tracking params stripped). |
| `/jobs` | All jobs, highest score first. |
| `/jobs/[id]` | Full job, score, reasoning, requirements, and **Tailor CV**. |
| `/profile` | The single master profile that scoring and tailoring rely on. Set this up first. |
| `/answers` | Answer bank for application-form questions, so the Phase 2 agent never guesses. |

### No-fabrication guarantees

Tailoring may only select, reorder, and rephrase what's in the master profile. That is enforced in code, not just the prompt:

- The model picks experience and projects **by index**; employer, title, dates, and project names are copied from the profile.
- Skills not in the profile's skills list are dropped.
- The free-text summary is audited by a second, cheaper model (Haiku) against the profile. Unsupported claims trigger one rewrite with those claims forbidden; if it still drifts, or the check fails, the profile's own summary is used unchanged. The job page shows when this happened and what was flagged.

## Schema

Defined in [`prisma/schema.prisma`](prisma/schema.prisma).

- **MasterProfile** — single row. `fullName`, `email`, `phone`, `location`, `linkedinUrl`, `summary`, and `content` (JSON: `education`, `experience`, `projects`, `skills`, `certifications`, `languages`).
- **Job** — `url` (unique, nullable for pasted text), `title`, `company`, `location`, `rawText`, `source` (`PASTED` | `ALERT`), `applyMethod` (`EMAIL` | `PORTAL` | `LINKEDIN` | `UNKNOWN`), `applyUrl`, `applyEmail`, `matchScore`, `matchReasoning`, `keyRequirements`, `status` (`NEW` → `SCORED` → `TAILORED` → `APPLYING` → `APPLIED`, or `NEEDS_ME` / `FAILED` / `SKIPPED`). Indexed on `(status, matchScore)` for the agent's queue.
- **Application** — one per job. `tailoredCv` (JSON), `cvPdfPath`, `status` (`DRAFT` | `READY` | `APPLYING` | `NEEDS_ME` | `APPLIED` | `FAILED`), `failureReason`, `appliedAt`.
- **AnswerBank** — `questionKey` (unique, snake_case), `questionText`, `answer`.
- **PortalAccount** — `domain` (unique), `email`, `password`. Passwords are **always encrypted** with AES-256-GCM by a Prisma client extension on every write; reads return ciphertext and must be decrypted explicitly with `decryptSecret()` from [`src/lib/crypto.ts`](src/lib/crypto.ts). Stored format: `v1:` + base64(iv[12] ‖ ciphertext ‖ tag[16]).

## Environment

Create `.env` in the project root:

```bash
# Neon Postgres. Use sslmode=verify-full.
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=verify-full&channel_binding=require"

# https://openrouter.ai/keys
OPENROUTER_API_KEY=sk-or-...

# 32 random bytes, base64. Generate once and back it up: losing it makes stored portal passwords unreadable.
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY=...
```

Models (via OpenRouter): `anthropic/claude-sonnet-4.5` for extraction, scoring, and tailoring; `anthropic/claude-haiku-4.5` for the summary check. Both are set in [`src/lib/ai.ts`](src/lib/ai.ts).

## Running it

```bash
npm install
npx prisma generate          # generates the client into src/generated/prisma (gitignored)
npx prisma migrate deploy    # applies migrations to DATABASE_URL
npm run dev                  # http://localhost:3000
```

Then open `/profile` and fill in your master profile before adding jobs.

For a production build: `npm run build && npm start`. After changing the schema, run `npx prisma migrate dev --name <change>`.

## Phase 2

- **Python browser agent** — picks the next `TAILORED` job by `matchScore`, renders the tailored CV to PDF (`Application.cvPdfPath`), and applies via the job's `applyMethod`: email, company portal, or LinkedIn. It answers form questions only from `AnswerBank`, logs in with `PortalAccount` credentials (decrypt in Python with `cryptography`'s `AESGCM`, format above), and moves the job to `APPLIED`, `FAILED` (with `failureReason`), or `NEEDS_ME` whenever it hits a question or step it can't answer without guessing.
- **Gmail alert ingestion** — reads job-alert emails (LinkedIn, Indeed, etc.), extracts the posting links, and runs them through the same extract-and-score pipeline as `source = ALERT`, deduped by URL.
