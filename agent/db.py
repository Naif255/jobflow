"""Direct access to the jobflow Postgres database (same schema Prisma manages).

Reads Job, Application, MasterProfile, AnswerBank and PortalAccount, and writes
back only run state: statuses, failureReason, appliedAt, and new AnswerBank
questions. Prisma fills `id` and `updatedAt` client-side, so inserts and
updates here set them explicitly.
"""

from __future__ import annotations

import base64
import os
import re
import secrets
import string
from dataclasses import dataclass
from typing import Any

import certifi
import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import dict_row

# Statuses the agent writes; names match both the JobStatus and ApplicationStatus enums.
APPLYING = "APPLYING"
NEEDS_ME = "NEEDS_ME"
APPLIED = "APPLIED"
FAILED = "FAILED"


@dataclass
class PortalAccount:
    domain: str
    email: str
    password: str


def connect() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    # Neon's URL asks libpq to verify the server certificate, but on Windows libpq has no
    # root.crt and can't read the OS store, so verify against certifi's CA bundle
    # unless the URL names its own.
    extra = {} if "sslrootcert" in url else {"sslrootcert": certifi.where()}
    return psycopg.connect(url, row_factory=dict_row, autocommit=True, **extra)


def load_job(conn: psycopg.Connection, job_id: str) -> dict[str, Any] | None:
    return conn.execute('SELECT * FROM "Job" WHERE id = %s', (job_id,)).fetchone()


def load_application(conn: psycopg.Connection, job_id: str) -> dict[str, Any] | None:
    return conn.execute('SELECT * FROM "Application" WHERE "jobId" = %s', (job_id,)).fetchone()


def load_profile(conn: psycopg.Connection) -> dict[str, Any] | None:
    return conn.execute('SELECT * FROM "MasterProfile" LIMIT 1').fetchone()


def load_answers(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return conn.execute(
        'SELECT "questionKey", "questionText", answer FROM "AnswerBank" ORDER BY "questionKey"'
    ).fetchall()


def load_portal_accounts(conn: psycopg.Connection) -> list[PortalAccount]:
    rows = conn.execute('SELECT domain, email, password FROM "PortalAccount"').fetchall()
    return [PortalAccount(r["domain"], r["email"], decrypt_secret(r["password"])) for r in rows]


def decrypt_secret(value: str) -> str:
    """Inverse of encryptSecret in src/lib/crypto.ts: "v1:" + base64(iv[12] || ciphertext || tag[16])."""
    if not value.startswith("v1:"):
        raise ValueError("PortalAccount password is not in the v1: encrypted format")
    raw_key = os.environ.get("ENCRYPTION_KEY")
    if not raw_key:
        raise RuntimeError("ENCRYPTION_KEY is not set")
    key = base64.b64decode(raw_key)
    if len(key) != 32:
        raise RuntimeError("ENCRYPTION_KEY must be 32 bytes, base64-encoded")
    blob = base64.b64decode(value.removeprefix("v1:"))
    if len(blob) < 12 + 16:
        raise ValueError("Encrypted secret is truncated")
    return AESGCM(key).decrypt(blob[:12], blob[12:], None).decode("utf-8")


def set_status(
    conn: psycopg.Connection,
    job_id: str,
    status: str,
    reason: str | None = None,
    applied: bool = False,
) -> None:
    """Job.status drives the UI; Application keeps the detailed record."""
    with conn.transaction():
        conn.execute(
            'UPDATE "Job" SET status = %s::"JobStatus", "updatedAt" = now() WHERE id = %s',
            (status, job_id),
        )
        conn.execute(
            'UPDATE "Application" SET status = %s::"ApplicationStatus", "failureReason" = %s, '
            '"appliedAt" = CASE WHEN %s THEN now() ELSE "appliedAt" END, "updatedAt" = now() '
            'WHERE "jobId" = %s',
            (status, reason, applied, job_id),
        )


def save_unanswered_question(conn: psycopg.Connection, question_text: str) -> str:
    """Store a question with an empty answer for the user to fill in; returns its key.

    Reuses an existing entry with the same text, so repeated runs don't pile up duplicates.
    """
    text = " ".join(question_text.split())
    existing = conn.execute(
        'SELECT "questionKey" FROM "AnswerBank" WHERE lower("questionText") = lower(%s)', (text,)
    ).fetchone()
    if existing:
        return existing["questionKey"]

    base = snake_case_key(text)
    taken = {
        r["questionKey"]
        for r in conn.execute(
            'SELECT "questionKey" FROM "AnswerBank" WHERE "questionKey" = %s OR "questionKey" LIKE %s',
            (base, base + "_%"),
        ).fetchall()
    }
    key, n = base, 2
    while key in taken:
        key, n = f"{base}_{n}", n + 1

    conn.execute(
        'INSERT INTO "AnswerBank" (id, "questionKey", "questionText", answer, "updatedAt") '
        "VALUES (%s, %s, %s, '', now())",
        (new_id(), key, text),
    )
    return key


_STOPWORDS = {"a", "an", "the", "do", "does", "you", "your", "are", "is", "of", "to", "for", "in", "on", "please", "what", "if"}


def snake_case_key(text: str, max_words: int = 6) -> str:
    """Matches the AnswerBank key format enforced by the UI: ^[a-z0-9]+(_[a-z0-9]+)*$."""
    words = re.findall(r"[a-z0-9]+", text.lower())
    meaningful = [w for w in words if w not in _STOPWORDS] or words
    return "_".join(meaningful[:max_words]) or "question"


def new_id() -> str:
    """cuid-shaped id (Prisma generates these client-side; any unique string is valid)."""
    alphabet = string.ascii_lowercase + string.digits
    return "c" + "".join(secrets.choice(alphabet) for _ in range(24))
