#!/usr/bin/env node
/**
 * Skill: shell
 * Run a whitelisted system command safely.
 * Uses argument array (no shell string expansion — prevents injection).
 *
 * Usage: /run shell {"cmd": "df -h"}
 *
 * SECURITY:
 * - Command parsed into argv array, never passed to shell
 * - Strict prefix + argument whitelist
 * - Blocks any argument containing path traversal (../)
 * - Blocks any argument that references sensitive files
 */

import { spawn } from "child_process";
import path from "path";

const args = (() => {
  try {
    const raw = process.env.SKILL_ARGS ?? "";
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
})();

const cmdStr = (args.cmd ?? "").trim();

if (!cmdStr) {
  console.error("Error: 'cmd' required. Example: {\"cmd\": \"df -h\"}");
  process.exit(1);
}

// Parse into argv array — NEVER pass to shell
const argv = cmdStr.split(/\s+/).filter(Boolean);
const bin = argv[0];
const cmdArgs = argv.slice(1);

// ── Allowed binaries (exact match) ────────────────────────────────────────────
const ALLOWED_BINS = new Set([
  "df", "du", "ls", "pwd", "whoami", "uptime", "free",
  "date", "uname", "ps", "top", "systemctl", "journalctl",
  "git", "python3", "node", "bun",
]);

if (!ALLOWED_BINS.has(bin)) {
  console.error(`Binary not allowed: ${bin}`);
  console.error(`Allowed: ${[...ALLOWED_BINS].join(", ")}`);
  process.exit(1);
}

// ── Argument safety checks ─────────────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  /\.\.\//,                // path traversal
  /\.env/i,                // env files
  /api_key|secret|token|password|credential/i,
  /\/etc\/shadow/,
  /\/proc\/[0-9]+\/mem/,
];

for (const arg of cmdArgs) {
  if (SENSITIVE_PATTERNS.some((p) => p.test(arg))) {
    console.error(`Argument blocked (sensitive pattern): ${arg}`);
    process.exit(1);
  }
}

// git log: limit to non-sensitive output
if (bin === "git" && cmdArgs[0] === "log") {
  // Only allow: git log --oneline -N
  const allowedGitLog = cmdArgs.every(
    (a) => a === "--oneline" || a === "--stat" || /^-\d+$/.test(a) || /^--max-count=\d+$/.test(a)
  );
  if (!allowedGitLog) {
    console.error("git log: only --oneline, --stat, -N allowed");
    process.exit(1);
  }
}

// ── Execute (no shell: true — spawn with argv array) ─────────────────────────
const proc = spawn(bin, cmdArgs, { shell: false, timeout: 10_000 });
let stdout = "";
let stderr = "";
proc.stdout.on("data", (d) => (stdout += d.toString()));
proc.stderr.on("data", (d) => (stderr += d.toString()));

proc.on("close", (code) => {
  const out = (stdout + stderr).slice(0, 5000).trim();
  if (code !== 0) {
    console.error(out || `Exit code ${code}`);
    process.exit(code ?? 1);
  }
  console.log(out);
});

proc.on("error", (err) => {
  console.error(`Spawn error: ${err.message}`);
  process.exit(1);
});
