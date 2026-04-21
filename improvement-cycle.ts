/**
 * improvement-cycle.ts — 6-hour autonomous self-improvement loop.
 *
 * Every 6 hours:
 *   1. Scan audit_log + heartbeat_log for the past 6 hours
 *   2. Identify problems (auth failures, rate-limit bursts, injection attempts, etc.)
 *   3. If no problems: brainstorm a capability enhancement
 *   4. Ask Improver agent to generate a TypeScript fix
 *   5. Validate syntax with bun --print (type-check pass)
 *   6. Categorize risk (safe / medium / high)
 *   7. safe → auto-commit; medium/high → HITL queue
 *   8. Log full reasoning to self-reflection-journal.jsonl
 *   9. Notify owner via Telegram
 */

import cron from "node-cron";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { getAuditLogSince, getHeartbeatLogSince } from "./db.js";
import { logReflection, type ProposedFix } from "./self-reflection-journal.js";
import { requireConfirmation } from "./security.js";
import { agentThink, AGENTS } from "./orchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const CYCLE_HOURS = 6;
const CYCLE_MS = CYCLE_HOURS * 3_600_000;
const MIN_CONFIDENCE = 8;

// Injected at startup by gateway.ts
let sendMessage: (chatId: string, text: string) => Promise<void> = async () => {};
let ownerChatId = "";

export function initImprovementCycle(
  sendFn: (chatId: string, text: string) => Promise<void>,
  chatId: string
): void {
  sendMessage = sendFn;
  ownerChatId = chatId;
}

async function notify(text: string): Promise<void> {
  if (ownerChatId) await sendMessage(ownerChatId, text).catch(() => {});
}

// ── Cycle ID ──────────────────────────────────────────────────────────────────

function generateCycleId(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(Math.floor(now.getUTCHours() / CYCLE_HOURS) * CYCLE_HOURS).padStart(2, "0");
  return `cycle_${y}_${mo}_${d}_${h}h`;
}

// ── Problem detection ─────────────────────────────────────────────────────────

interface Problem {
  type: string;
  description: string;
  count: number;
  severity: "low" | "medium" | "high";
}

function identifyProblems(): Problem[] {
  const cutoff = Math.floor((Date.now() - CYCLE_MS) / 1000);
  const auditRows = getAuditLogSince(cutoff);
  const heartbeatRows = getHeartbeatLogSince(cutoff);
  const problems: Problem[] = [];

  // Auth failures
  const authFails = auditRows.filter((r) => r.command.includes("auth_fail") || r.skill_name === "auth_failure");
  if (authFails.length > 10) {
    problems.push({
      type: "auth_security",
      description: `${authFails.length} auth failures in ${CYCLE_HOURS}h — possible brute-force`,
      count: authFails.length,
      severity: "high",
    });
  }

  // Rate limit hits (logged as "command" audit entries)
  const rateLimitHits = auditRows.filter((r) => r.command.includes("rate_limit"));
  if (rateLimitHits.length > 30) {
    problems.push({
      type: "rate_limit",
      description: `${rateLimitHits.length} rate-limit hits in ${CYCLE_HOURS}h — threshold may need tuning`,
      count: rateLimitHits.length,
      severity: "medium",
    });
  }

  // Skill failures (exit_code != 0)
  const skillFails = auditRows.filter((r) => r.exit_code !== 0 && r.skill_name !== "command");
  if (skillFails.length > 5) {
    const names = [...new Set(skillFails.map((r) => r.skill_name))].join(", ");
    problems.push({
      type: "skill_failure",
      description: `${skillFails.length} skill failures in ${CYCLE_HOURS}h (${names})`,
      count: skillFails.length,
      severity: "medium",
    });
  }

  // Heartbeat errors
  const hbErrors = heartbeatRows.filter(
    (r) => r.check_type !== "self_reflection" && /error|fail|crash|alert/i.test(r.result)
  );
  if (hbErrors.length > 3) {
    problems.push({
      type: "heartbeat_error",
      description: `${hbErrors.length} heartbeat error signals in ${CYCLE_HOURS}h`,
      count: hbErrors.length,
      severity: "medium",
    });
  }

  return problems;
}

// ── LLM call via Improver agent ───────────────────────────────────────────────

const IMPROVER_AGENT = AGENTS.find((a) => a.slug === "improver");

async function callImprover(prompt: string): Promise<string> {
  if (!IMPROVER_AGENT) return "";
  return agentThink("improver-system", IMPROVER_AGENT, prompt);
}

// ── Parse structured output from Improver ────────────────────────────────────

function parseImproverOutput(raw: string): ProposedFix | null {
  const get = (key: string): string => {
    const match = new RegExp(`${key}:\\s*(.+)`, "i").exec(raw);
    return match?.[1]?.trim() ?? "";
  };

  const file = get("FIX_FILE");
  const description = get("FIX_DESCRIPTION");
  const confidence = parseInt(get("CONFIDENCE"), 10);
  const riskRaw = get("RISK_LEVEL").toLowerCase();
  const riskLevel: "safe" | "medium" | "high" =
    riskRaw === "safe" ? "safe" : riskRaw === "high" ? "high" : "medium";
  const reasoning = get("REASONING");

  // Extract code block
  const codeMatch = /```(?:typescript|ts)?\n([\s\S]+?)```/.exec(raw);
  const code = codeMatch?.[1]?.trim();

  if (!file || !description || isNaN(confidence)) return null;

  return { file, description, confidence, riskLevel, reasoning, code };
}

// ── Syntax validation ─────────────────────────────────────────────────────────

function validateCode(code: string): boolean {
  const tmpFile = path.join(__dirname, `data/.improver_tmp_${Date.now()}.ts`);
  try {
    writeFileSync(tmpFile, code, "utf8");
    // Use bun's type checker for fast validation
    const result = spawnSync("bun", ["--print", `import('${tmpFile}')`], {
      timeout: 15_000,
      encoding: "utf8",
      cwd: __dirname,
    });
    return result.status === 0;
  } catch {
    return false;
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
  }
}

// ── Risk categorizer ──────────────────────────────────────────────────────────

function categorizeRisk(fix: ProposedFix): "safe" | "medium" | "high" {
  // Respect Improver's own assessment
  if (fix.riskLevel === "high") return "high";

  // Override to high if touching critical files regardless of agent's assessment
  const highRiskFiles = ["security.ts", "gateway.ts", "hitl-crypto.ts", "db.ts"];
  if (highRiskFiles.some((f) => fix.file?.includes(f))) return "high";

  const mediumRiskFiles = ["brain.ts", "orchestrator.ts", "skills.ts"];
  if (mediumRiskFiles.some((f) => fix.file?.includes(f))) return "medium";

  return fix.riskLevel;
}

// ── Git commit ────────────────────────────────────────────────────────────────

function gitCommit(description: string, cycleId: string): string | null {
  // Stage only tracked files — never add untracked secrets
  const add = spawnSync("git", ["add", "-u"], { cwd: __dirname, encoding: "utf8" });
  if (add.status !== 0) return null;

  const commit = spawnSync(
    "git",
    ["commit", "-m", `🤖 Self-improvement: ${description} [${cycleId}]`],
    { cwd: __dirname, encoding: "utf8" }
  );
  if (commit.status !== 0) return null;

  const hash = /\[.*?\s+([a-f0-9]{7,})\]/.exec(commit.stdout)?.[1] ?? null;
  return hash;
}

// ── Main cycle ────────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const cycleId = generateCycleId();
  console.log(`[improver] Starting cycle ${cycleId}`);

  let problems = identifyProblems();
  let brainstormed = false;

  // No problems → brainstorm a capability enhancement
  if (problems.length === 0) {
    brainstormed = true;
    const recentHeartbeats = getHeartbeatLogSince(
      Math.floor((Date.now() - CYCLE_MS) / 1000)
    )
      .slice(-5)
      .map((r) => `[${r.check_type}] ${r.result}`)
      .join("\n");

    const suggestion = await callImprover(
      `No problems detected in the last ${CYCLE_HOURS} hours. ` +
      `Recent system activity:\n${recentHeartbeats || "(none)"}\n\n` +
      `What single, high-value capability improvement should be added to this system? ` +
      `Respond using the structured output format in your SOUL.md.`
    );

    if (suggestion) {
      problems = [{ type: "enhancement", description: suggestion, count: 0, severity: "low" }];
    }
  }

  if (problems.length === 0) {
    logReflection({
      timestamp: Date.now(),
      cycleId,
      problemsDetected: [],
      proposedFix: null,
      validationResult: "skipped",
      status: "no_problems",
    });
    console.log(`[improver] Cycle ${cycleId} — nothing to do`);
    return;
  }

  // Generate fix proposal
  const problemSummary = problems
    .map((p) => `[${p.type}] ${p.description}`)
    .join("\n");

  const rawProposal = await callImprover(
    `Analyze these ${brainstormed ? "enhancement opportunities" : "problems"} ` +
    `from the last ${CYCLE_HOURS} hours and generate a TypeScript fix:\n\n${problemSummary}\n\n` +
    `Use the structured output format from your SOUL.md.`
  );

  const fix = rawProposal ? parseImproverOutput(rawProposal) : null;

  if (!fix) {
    logReflection({
      timestamp: Date.now(),
      cycleId,
      problemsDetected: problems.map((p) => p.description),
      proposedFix: null,
      validationResult: "failed",
      status: "rejected",
    });
    await notify(`⚠️ Improver cycle ${cycleId}: could not parse proposal.`);
    return;
  }

  // Confidence gate
  if (fix.confidence < MIN_CONFIDENCE) {
    logReflection({
      timestamp: Date.now(),
      cycleId,
      problemsDetected: problems.map((p) => p.description),
      proposedFix: fix,
      validationResult: "skipped",
      status: "rejected",
    });
    await notify(
      `📋 Improver cycle ${cycleId}: proposal confidence ${fix.confidence}/10 — below threshold (${MIN_CONFIDENCE}), skipped.\n` +
      `Problem: ${problems[0]?.description}`
    );
    return;
  }

  // Validate code syntax
  const codePassed = fix.code ? validateCode(fix.code) : false;
  const finalRisk = categorizeRisk(fix);

  // Require HITL for medium/high risk or failed validation
  if (finalRisk !== "safe" || !codePassed) {
    const { id, message } = requireConfirmation(
      ownerChatId,
      `Self-improvement: ${fix.description} (risk: ${finalRisk}, syntax: ${codePassed ? "✓" : "✗"})`,
      finalRisk === "high" ? "high" : "medium",
      { cycleId, fix }
    );

    logReflection({
      timestamp: Date.now(),
      cycleId,
      problemsDetected: problems.map((p) => p.description),
      proposedFix: fix,
      validationResult: codePassed ? "passed" : "failed",
      status: "pending_hitl",
    });

    await notify(
      `🔒 Self-improvement proposal (${cycleId}):\n` +
      `Problem: ${problems[0]?.description}\n` +
      `Fix: ${fix.description}\n` +
      `File: ${fix.file}\n` +
      `Confidence: ${fix.confidence}/10 | Risk: ${finalRisk}\n\n` +
      message
    );
    return;
  }

  // Safe + validated → auto-commit
  const hash = gitCommit(fix.description, cycleId);

  logReflection({
    timestamp: Date.now(),
    cycleId,
    problemsDetected: problems.map((p) => p.description),
    proposedFix: fix,
    validationResult: "passed",
    gitCommitHash: hash ?? undefined,
    status: hash ? "committed" : "rejected",
  });

  if (hash) {
    await notify(
      `✅ Self-improvement committed (${cycleId}):\n` +
      `Problem: ${problems[0]?.description}\n` +
      `Fix: ${fix.description}\n` +
      `Commit: \`${hash}\``
    );
    console.log(`[improver] Committed ${hash} — ${fix.description}`);
  } else {
    await notify(`⚠️ Self-improvement ${cycleId}: fix validated but git commit failed.`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startImprovementCycle(
  sendFn: (chatId: string, text: string) => Promise<void>,
  chatId: string
): void {
  initImprovementCycle(sendFn, chatId);

  // Run at the top of every 6th hour: midnight, 6am, noon, 6pm UTC
  cron.schedule("0 */6 * * *", async () => {
    try {
      await runCycle();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[improver] Cycle error:", msg);
      logReflection({
        timestamp: Date.now(),
        cycleId: generateCycleId(),
        problemsDetected: ["Improvement cycle threw an exception"],
        proposedFix: null,
        validationResult: "failed",
        status: "rejected",
      });
      await notify(`❌ Improvement cycle failed: ${msg}`);
    }
  });

  console.log("[improver] Self-improvement cycle scheduled (every 6h)");
}

// ── Manual trigger (for /improver command) ────────────────────────────────────

export async function runImprovementCycleNow(): Promise<string> {
  try {
    await runCycle();
    const latest = (await import("./self-reflection-journal.js")).getRecentReflections(1);
    const entry = latest[0];
    if (!entry) return "Cycle ran — no journal entry produced.";
    return (
      `Cycle ${entry.cycleId}\n` +
      `Problems: ${entry.problemsDetected.length > 0 ? entry.problemsDetected[0] : "none"}\n` +
      `Status: ${entry.status}\n` +
      `Commit: ${entry.gitCommitHash ?? "none"}`
    );
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
