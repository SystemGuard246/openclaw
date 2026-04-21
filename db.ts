/**
 * db.ts — SQLite database layer for OpenClaw
 * Uses bun:sqlite (built-in, no external deps)
 */

import { Database } from "bun:sqlite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "openclaw.db");

export const db = new Database(DB_PATH, { create: true });

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// ── Schema ────────────────────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    chat_id       TEXT PRIMARY KEY,
    username      TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen     INTEGER NOT NULL DEFAULT (unixepoch()),
    message_count INTEGER NOT NULL DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id  TEXT NOT NULL,
    role     TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content  TEXT NOT NULL,
    ts       INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, ts DESC)`);

db.run(`
  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    fact        TEXT NOT NULL,
    tags        TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    accessed_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id)`);

db.run(`
  CREATE TABLE IF NOT EXISTS heartbeat_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    check_type   TEXT NOT NULL,
    result       TEXT NOT NULL,
    action_taken TEXT,
    ts           INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT,
    skill_name TEXT,
    command    TEXT,
    exit_code  INTEGER,
    ts         INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGTERM", () => { db.close(); });
process.on("SIGINT",  () => { db.close(); });

// ── Session helpers ───────────────────────────────────────────────────────────

export function getOrCreateSession(chatId: string, username?: string) {
  const existing = db.query("SELECT * FROM sessions WHERE chat_id = ?").get(chatId);
  if (existing) {
    db.run("UPDATE sessions SET last_seen = unixepoch(), username = ? WHERE chat_id = ?",
      [username ?? null, chatId]);
    return existing;
  }
  db.run("INSERT INTO sessions (chat_id, username) VALUES (?, ?)", [chatId, username ?? null]);
  return db.query("SELECT * FROM sessions WHERE chat_id = ?").get(chatId);
}

export function addMessage(chatId: string, role: "user" | "assistant", content: string) {
  db.run("INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)", [chatId, role, content]);
  db.run("UPDATE sessions SET message_count = message_count + 1, last_seen = unixepoch() WHERE chat_id = ?", [chatId]);
}

export function getHistory(chatId: string, limit = 40): Array<{ role: string; content: string }> {
  const rows = db.query(
    "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?"
  ).all(chatId, limit) as Array<{ role: string; content: string }>;
  return rows.reverse();
}

// ── Memory helpers ────────────────────────────────────────────────────────────

export function saveFact(chatId: string, fact: string, tags?: string) {
  db.run("INSERT INTO memories (chat_id, fact, tags) VALUES (?, ?, ?)", [chatId, fact, tags ?? null]);
}

export function getFacts(chatId: string): Array<{ fact: string; tags: string | null }> {
  const rows = db.query(
    "SELECT fact, tags FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT 30"
  ).all(chatId) as Array<{ fact: string; tags: string | null }>;
  db.run("UPDATE memories SET accessed_at = unixepoch() WHERE chat_id = ?", [chatId]);
  return rows;
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

export function logAudit(chatId: string | null, skillName: string, command: string, exitCode: number) {
  // Never log raw content that may contain secrets — log only the operation type
  const safeCommand = command.length > 500 ? command.slice(0, 500) + "…" : command;
  db.run(
    "INSERT INTO audit_log (chat_id, skill_name, command, exit_code) VALUES (?, ?, ?, ?)",
    [chatId, skillName, safeCommand, exitCode]
  );
}

export function logHeartbeat(checkType: string, result: string, actionTaken?: string) {
  db.run(
    "INSERT INTO heartbeat_log (check_type, result, action_taken) VALUES (?, ?, ?)",
    [checkType, result.slice(0, 1000), actionTaken ?? null]
  );
}

// ── Audit/heartbeat readers (used by improvement cycle) ──────────────────────

export interface AuditRow {
  id: number;
  chat_id: string | null;
  skill_name: string;
  command: string;
  exit_code: number;
  ts: number;
}

export interface HeartbeatRow {
  id: number;
  check_type: string;
  result: string;
  action_taken: string | null;
  ts: number;
}

export function getAuditLogSince(sinceUnix: number): AuditRow[] {
  return db.query(
    "SELECT * FROM audit_log WHERE ts >= ? ORDER BY ts ASC"
  ).all(sinceUnix) as AuditRow[];
}

export function getHeartbeatLogSince(sinceUnix: number): HeartbeatRow[] {
  return db.query(
    "SELECT * FROM heartbeat_log WHERE ts >= ? ORDER BY ts ASC"
  ).all(sinceUnix) as HeartbeatRow[];
}

// ── Security event log ────────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS security_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT,
    event_type TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK(severity IN ('info','medium','high','critical')),
    detail     TEXT NOT NULL,
    ts         INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sec_events ON security_events(ts DESC)`);

export function logSecurityEvent(
  chatId: string | null,
  eventType: string,
  severity: "info" | "medium" | "high" | "critical",
  detail: string
): void {
  const safe = detail.length > 500 ? detail.slice(0, 500) + "…" : detail;
  db.run(
    "INSERT INTO security_events (chat_id, event_type, severity, detail) VALUES (?, ?, ?, ?)",
    [chatId, eventType, severity, safe]
  );
  if (severity === "critical") {
    console.error(`[security] 🚨 CRITICAL [${eventType}]: ${safe}`);
  } else if (severity === "high") {
    console.warn(`[security] ⚠️ HIGH [${eventType}]: ${safe}`);
  }
}

// ── Audit summary (for /audit command) ───────────────────────────────────────

export function getAuditSummary(chatId: string, days = 7): string {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const ops = db.query(
    `SELECT command, COUNT(*) as count FROM audit_log
     WHERE chat_id = ? AND ts > ? GROUP BY command ORDER BY count DESC LIMIT 15`
  ).all(chatId, cutoff) as Array<{ command: string; count: number }>;

  const events = db.query(
    `SELECT severity, COUNT(*) as count FROM security_events
     WHERE (chat_id = ? OR chat_id IS NULL) AND ts > ? GROUP BY severity`
  ).all(chatId, cutoff) as Array<{ severity: string; count: number }>;

  const mandateBlocks = db.query(
    `SELECT COUNT(*) as n FROM mandate_events WHERE ts > ?`
  ).get(cutoff) as { n: number } | null;

  const redactions = db.query(
    `SELECT COALESCE(SUM(count), 0) as n FROM redaction_log WHERE chat_id = ? AND ts > ?`
  ).get(chatId, cutoff) as { n: number } | null;

  let out = `📊 Audit Report (${days}d)\n\n`;

  if (ops.length) {
    out += `*Commands:*\n`;
    out += ops.map((o) => `  ${o.command}: ${o.count}`).join("\n") + "\n\n";
  }

  if (events.length) {
    out += `*Security Events:*\n`;
    out += events.map((e) => `  ${e.severity}: ${e.count}`).join("\n") + "\n\n";
  }

  out += `*Mandate blocks:* ${mandateBlocks?.n ?? 0}\n`;
  out += `*Secrets redacted:* ${redactions?.n ?? 0}`;

  return out;
}
