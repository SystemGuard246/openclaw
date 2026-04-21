/**
 * secret-scanner.ts — Redacts secrets from LLM output before delivery.
 * Prevents API keys, tokens, credit card numbers, and private keys
 * from leaking through agent responses.
 */

import { db } from "./db.js";

// ── Patterns ──────────────────────────────────────────────────────────────────

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  // Groq API keys
  { name: "groq_key",      regex: /gsk_[A-Za-z0-9]{48}/g },
  // Anthropic API keys
  { name: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_-]{88}/g },
  // OpenAI API keys
  { name: "openai_key",    regex: /sk-[A-Za-z0-9]{48,}/g },
  // GitHub personal access tokens
  { name: "github_token",  regex: /ghp_[A-Za-z0-9]{36}/g },
  // Bearer tokens (generic)
  { name: "bearer_token",  regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/gi },
  // Credit card numbers (Luhn-formatted groups)
  { name: "credit_card",   regex: /\b(?:\d{4}[\s\-]){3}\d{4}\b/g },
  // SSH / PEM private keys
  { name: "ssh_key",       regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----/g },
  // AWS access key IDs
  { name: "aws_key",       regex: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  // Generic high-entropy assignments (key=<40+ char value>)
  { name: "generic_secret", regex: /(?:api[_-]?key|secret|token|password|passwd|auth[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{32,}["']?/gi },
];

// ── Scanner ───────────────────────────────────────────────────────────────────

export interface ScanResult {
  cleaned: string;
  redactedCount: number;
  types: string[];
}

export function scanAndRedact(text: string, chatId?: string): ScanResult {
  let cleaned = text;
  let redactedCount = 0;
  const types: string[] = [];

  for (const { name, regex } of PATTERNS) {
    // Reset lastIndex for stateful global regexes
    regex.lastIndex = 0;
    const matches = cleaned.match(regex);
    if (matches) {
      redactedCount += matches.length;
      types.push(name);
      cleaned = cleaned.replace(regex, `[REDACTED:${name}]`);
    }
  }

  if (redactedCount > 0) {
    logRedaction(chatId ?? "system", redactedCount, types);
  }

  return { cleaned, redactedCount, types };
}

// ── Logging ───────────────────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS redaction_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT,
    count       INTEGER NOT NULL,
    types       TEXT NOT NULL,
    ts          INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

function logRedaction(chatId: string, count: number, types: string[]): void {
  db.run(
    "INSERT INTO redaction_log (chat_id, count, types) VALUES (?, ?, ?)",
    [chatId, count, types.join(",")]
  );
  console.warn(`[secret-scanner] Redacted ${count} secret(s) (${types.join(", ")}) for chat=${chatId}`);
}

export function getRedactionStats(hours = 24): Array<{ chat_id: string; count: number; types: string; ts: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.query(
    "SELECT chat_id, count, types, ts FROM redaction_log WHERE ts >= ? ORDER BY ts DESC"
  ).all(cutoff) as Array<{ chat_id: string; count: number; types: string; ts: number }>;
}
