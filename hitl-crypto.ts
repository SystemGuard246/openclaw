/**
 * hitl-crypto.ts — Cryptographically strong HITL confirmation token generator
 *
 * Upgrades from 8-char UUID slices (~47-bit entropy) to 32-byte base64 tokens
 * (~256-bit entropy). Tokens are unforgeable and timestamped.
 *
 * Pattern: CONFIRM-{base64url_32bytes}_{unix_timestamp}
 * Example: CONFIRM-s8K2j9qL4mP1vXzYaB0cD5E6F7G8H9I0J1K2L3M4_1745000000
 */

import { randomBytes } from "crypto";

/**
 * Generate a cryptographically strong confirmation token.
 * Uses 32 random bytes (256-bit) encoded as URL-safe base64.
 */
export function generateConfirmToken(): string {
  const bytes = randomBytes(32);
  const b64 = bytes.toString("base64url"); // URL-safe, no padding issues
  const ts = Math.floor(Date.now() / 1000);
  return `CONFIRM-${b64}_${ts}`;
}

/**
 * Validate that a token matches the expected format and extract its timestamp.
 * Does NOT verify it exists in the database — that's security.ts's job.
 */
export function parseConfirmToken(token: string): { valid: boolean; issuedAt?: number } {
  const match = /^CONFIRM-([A-Za-z0-9_-]{43})_(\d{10})$/.exec(token);
  if (!match) return { valid: false };
  const issuedAt = parseInt(match[2] ?? "0", 10);
  return { valid: true, issuedAt };
}

/**
 * Check if a token is structurally valid (format only — not DB existence).
 */
export function isValidTokenFormat(token: string): boolean {
  return parseConfirmToken(token).valid;
}
