/**
 * self-reflection-journal.ts — Append-only log of every self-improvement cycle.
 * Stores structured JSON entries in logs/self-reflection-journal.jsonl.
 * Also writes a summary row to heartbeat_log for /status visibility.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = path.join(__dirname, "logs", "self-reflection-journal.jsonl");

// Ensure logs/ directory exists at import time
mkdirSync(path.join(__dirname, "logs"), { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProposedFix {
  file: string;
  description: string;
  confidence: number;     // 1–10
  riskLevel: "safe" | "medium" | "high";
  reasoning: string;
  code?: string;
}

export interface ReflectionEntry {
  timestamp: number;
  cycleId: string;
  problemsDetected: string[];
  proposedFix: ProposedFix | null;
  validationResult: "passed" | "failed" | "pending" | "skipped";
  gitCommitHash?: string;
  status: "committed" | "rejected" | "pending_hitl" | "no_problems";
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function logReflection(entry: ReflectionEntry): void {
  // 1. Append to JSONL file
  appendFileSync(JOURNAL_PATH, JSON.stringify(entry) + "\n", "utf8");

  // 2. Summary row to heartbeat_log so /doctor and heartbeat checks can surface it
  const summary =
    `[${entry.cycleId}] status=${entry.status} ` +
    `problems=${entry.problemsDetected.length} ` +
    `confidence=${entry.proposedFix?.confidence ?? "n/a"} ` +
    `commit=${entry.gitCommitHash ?? "none"}`;

  db.run(
    "INSERT INTO heartbeat_log (check_type, result, action_taken) VALUES (?, ?, ?)",
    ["self_reflection", summary.slice(0, 1000), entry.status]
  );
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getRecentReflections(hours: number): ReflectionEntry[] {
  if (!existsSync(JOURNAL_PATH)) return [];

  const cutoff = Date.now() - hours * 3_600_000;
  const lines = readFileSync(JOURNAL_PATH, "utf8")
    .split("\n")
    .filter(Boolean);

  const entries: ReflectionEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ReflectionEntry;
      if (entry.timestamp >= cutoff) entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

export function getAllReflections(): ReflectionEntry[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  const lines = readFileSync(JOURNAL_PATH, "utf8").split("\n").filter(Boolean);
  const entries: ReflectionEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as ReflectionEntry); } catch { /* skip */ }
  }
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}
