import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (PortalAccount.password).
 *
 * Stored format: "v1:" + base64(iv[12] || ciphertext || authTag[16])
 * Key: ENCRYPTION_KEY, 32 random bytes encoded as base64.
 *
 * Python (Phase 2 agent), using the `cryptography` package:
 *   blob = base64.b64decode(value.removeprefix("v1:"))
 *   AESGCM(base64.b64decode(key)).decrypt(blob[:12], blob[12:], None)
 */
const PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) throw new Error("Value is not an encrypted secret");
  const blob = Buffer.from(value.slice(PREFIX.length), "base64");
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error("Encrypted secret is truncated");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), blob.subarray(0, IV_BYTES));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES, blob.length - TAG_BYTES)), decipher.final()]).toString(
    "utf8",
  );
}
