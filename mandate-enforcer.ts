/**
 * mandate-enforcer.ts — Pre/post execution mandate checking for named agents.
 * Each agent's SOUL.md defines constraints and prohibitions; this module
 * enforces them programmatically so violations are caught before/after LLM calls.
 */

import { db } from "./db.js";

// ── Mandate definitions (mirror each agent's SOUL.md) ────────────────────────

interface Mandate {
  /** Pre-execution: patterns in the USER message that violate constraints */
  preBlock?: Array<{ pattern: RegExp; reason: string }>;
  /** Post-execution: patterns in the AGENT response that are prohibited */
  postBlock?: Array<{ pattern: RegExp; reason: string }>;
  /** Words/phrases that must never appear in responses */
  outputProhibitions?: string[];
}

const MANDATES: Record<string, Mandate> = {
  marcus: {
    preBlock: [
      { pattern: /delete\s+(?:all|every|the)\s+\w+/i,   reason: "Marcus: autonomous deletion prohibited" },
      { pattern: /publish\s+(?:now|immediately|right\s*away)/i, reason: "Marcus: autonomous publishing prohibited" },
    ],
  },
  iris: {
    preBlock: [
      { pattern: /^should\s+we\b/i,  reason: "Iris provides analysis only — no recommendations" },
      { pattern: /^recommend\s+we\b/i, reason: "Iris provides analysis only — no recommendations" },
    ],
    postBlock: [
      { pattern: /I\s+recommend\s+you\s+(?:immediately|right\s*now)/i, reason: "Iris: high-urgency directive prohibited" },
    ],
  },
  victor: {
    preBlock: [
      {
        pattern: /(?:by\s+tomorrow|by\s+end\s+of\s+(?:today|day)|within\s+24\s*h(?:ours?)?)\b/i,
        reason: "Victor: timeline < 48h violates mandate — propose minimum 48h",
      },
      {
        pattern: /(?:give|offer|provide)\s+(?:a\s+)?(?:\d+%?\s+)?discount/i,
        reason: "Victor: discount > 15% requires operator confirmation",
      },
    ],
    postBlock: [
      {
        pattern: /\bsign(?:ed)?\s+(?:the\s+)?contract\b/i,
        reason: "Victor: cannot autonomously sign or commit to contracts",
      },
    ],
  },
  aria: {
    postBlock: [
      {
        pattern: /\b(?:published?|posted?|tweeted?|broadcast(?:ed)?)\b(?!\s+draft)/i,
        reason: "Aria: all content must be reviewed before publishing",
      },
    ],
  },
  sterling: {
    preBlock: [
      {
        pattern: /(?:transfer|move|send|wire)\s+[\$£€]?\d/i,
        reason: "Sterling: financial transfers require explicit HITL confirmation",
      },
    ],
    postBlock: [
      {
        pattern: /\b(?:transfer(?:ring|red)?|mov(?:ing|ed))\s+[\$£€]?\d/i,
        reason: "Sterling: financial movement detected in response — HITL required",
      },
    ],
  },
  solomon: {
    postBlock: [
      {
        pattern: /\b(?:you\s+should\s+(?:definitely|certainly|absolutely)|I\s+guarantee)\b/i,
        reason: "Solomon: must label confidence, not make guarantees",
      },
      {
        pattern: /\b(?:as\s+your\s+(?:lawyer|doctor|physician|financial\s+advisor))\b/i,
        reason: "Solomon: legal/medical/financial advice prohibited",
      },
    ],
  },
  sage: {
    postBlock: [
      {
        pattern: /\byou\s+(?:have|likely\s+have|definitely\s+have)\s+\w+(?:\s+disorder|\s+syndrome|\s+disease)/i,
        reason: "Sage: cannot diagnose medical conditions",
      },
      {
        pattern: /\b(?:take|prescribe|stop\s+taking)\s+\w+\s+(?:mg|milligrams?|pills?|tablets?)\b/i,
        reason: "Sage: cannot prescribe or advise stopping medication",
      },
    ],
  },
  finn: {
    preBlock: [
      {
        pattern: /send\s+(?:the\s+)?(?:email|message|outreach|dm)\s+(?:now|immediately)/i,
        reason: "Finn: outreach requires explicit operator approval before sending",
      },
    ],
  },
};

// ── Enforcement ───────────────────────────────────────────────────────────────

export interface MandateCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkPreExecution(agentSlug: string, message: string): MandateCheckResult {
  const mandate = MANDATES[agentSlug];
  if (!mandate?.preBlock) return { ok: true };

  for (const { pattern, reason } of mandate.preBlock) {
    if (pattern.test(message)) {
      logMandateEvent(agentSlug, "pre_block", reason, message.slice(0, 200));
      return { ok: false, reason };
    }
  }
  return { ok: true };
}

export function checkPostExecution(agentSlug: string, response: string): MandateCheckResult {
  const mandate = MANDATES[agentSlug];
  if (!mandate?.postBlock) return { ok: true };

  for (const { pattern, reason } of mandate.postBlock) {
    if (pattern.test(response)) {
      logMandateEvent(agentSlug, "post_block", reason, response.slice(0, 200));
      return { ok: false, reason };
    }
  }
  return { ok: true };
}

// ── Mandate event logging ─────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS mandate_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent      TEXT NOT NULL,
    stage      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    excerpt    TEXT,
    ts         INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

function logMandateEvent(agent: string, stage: string, reason: string, excerpt: string): void {
  db.run(
    "INSERT INTO mandate_events (agent, stage, reason, excerpt) VALUES (?, ?, ?, ?)",
    [agent, stage, reason, excerpt]
  );
  console.warn(`[mandate] ${stage.toUpperCase()} blocked [${agent}]: ${reason}`);
}

export function getMandateEvents(hours = 24): Array<{ agent: string; stage: string; reason: string; ts: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  return db.query(
    "SELECT agent, stage, reason, ts FROM mandate_events WHERE ts >= ? ORDER BY ts DESC"
  ).all(cutoff) as Array<{ agent: string; stage: string; reason: string; ts: number }>;
}
