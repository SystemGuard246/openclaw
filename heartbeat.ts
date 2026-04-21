/**
 * heartbeat.ts — Proactive autonomous monitoring service
 *
 * This is what makes OpenClaw a "nervous system" rather than a chatbot.
 * Runs on schedules, reasons through data, acts without user prompting.
 *
 * Parse → Reason → Act → Log (autonomous loop)
 */

import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { heartbeatThink } from "./brain.js";
import { agentThink, AGENTS } from "./orchestrator.js";
import { logHeartbeat } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type SendFn = (chatId: string, text: string) => Promise<void>;

let sendMessage: SendFn = async () => {};
let ownerChatId: string = "";
const HEARTBEAT_CHAT_ID = "heartbeat-system";

export function initHeartbeat(sendFn: SendFn, chatId: string) {
  sendMessage = sendFn;
  ownerChatId = chatId;
}

async function notify(text: string) {
  if (!ownerChatId) return;
  await sendMessage(ownerChatId, text);
}

// ── Helper: read last N lines of a file ──────────────────────────────────────

function tailFile(filePath: string, lines = 50): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch { return ""; }
}

// ── Check 1: Aurum Bot State (every 15 min) ───────────────────────────────────

async function checkAurumBotState() {
  const statePath = "/home/aurumbot/Aurum/state.json";
  if (!fs.existsSync(statePath)) return;

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const prompt = `Aurum Bot system state:\n${JSON.stringify(state, null, 2)}
Is the pipeline stalled, failing, or does it need human intervention? Be specific.`;

  const result = await heartbeatThink(prompt);
  logHeartbeat("aurum_state", result.slice(0, 500));
  if (result !== "NO_ACTION") await notify(`[Ops] Aurum pipeline:\n${result}`);
}

// ── Check 2: System Logs (every 30 min) ──────────────────────────────────────

async function checkSystemLogs() {
  const logDir = "/home/aurumbot/Aurum/logs";
  if (!fs.existsSync(logDir)) return;

  const logs = fs.readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(logDir, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const firstLog = logs[0];
  if (!firstLog) return;

  const lines = tailFile(path.join(logDir, firstLog.f));
  const prompt = `Recent log (${firstLog.f}):\n${lines}\nErrors or action items?`;
  const result = await heartbeatThink(prompt);
  logHeartbeat("system_logs", result.slice(0, 500));
  if (result !== "NO_ACTION" && /error|fail|crash/i.test(result)) {
    await notify(`[DevOps] Log alert:\n${result}`);
  }
}

// ── Check 3: Disk Space (every hour) ─────────────────────────────────────────

async function checkDiskSpace() {
  const proc = Bun.spawn(["df", "-h", "/home"], { stdout: "pipe", stderr: "pipe" });
  const df = await new Response(proc.stdout).text();
  const prompt = `Disk usage:\n${df}\nIs usage critical (>85%)?`;
  const result = await heartbeatThink(prompt);
  logHeartbeat("disk_space", result.slice(0, 200));
  if (result !== "NO_ACTION") await notify(`[DevOps] Disk alert:\n${result}`);
}

// ── Helper: parse Aurum morning context ──────────────────────────────────────

function getAurumMorningContext(): string {
  const BASE = "/home/aurumbot/Aurum";
  const lines: string[] = [];

  // State: current book and chapter
  const statePath = `${BASE}/state.json`;
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const title = state.ebook_current_title ?? "unknown";
      const chIdx = state.ebook_chapter_index ?? 0;
      const chapters = state.ebook_chapters?.[title] ?? [];
      const chName = chapters[chIdx] ?? "Introduction";
      lines.push(`Book: ${title}`);
      lines.push(`Next chapter (${chIdx + 1}/${chapters.length}): ${chName}`);
    } catch { lines.push("State: unreadable"); }
  }

  // Review queue count
  const reviewDir = `${BASE}/queue/REVIEW`;
  if (fs.existsSync(reviewDir)) {
    try {
      const files = fs.readdirSync(reviewDir).filter((f) =>
        fs.statSync(`${reviewDir}/${f}`).isFile()
      );
      lines.push(`Review queue: ${files.length} item${files.length !== 1 ? "s" : ""} waiting for approval`);
    } catch { lines.push("Review queue: unreadable"); }
  }

  // Revenue this week from CSV
  const csvPath = `${BASE}/finance/revenue_log.csv`;
  if (fs.existsSync(csvPath)) {
    try {
      const csv = fs.readFileSync(csvPath, "utf8");
      const rows = csv.trim().split("\n").slice(1); // skip header
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      let weeklyTotal = 0;
      for (const row of rows) {
        const cols = row.split(",");
        const dateStr = cols[0]?.trim() ?? "";
        const amount = parseFloat(cols[3]?.trim() ?? "0") || 0;
        if (dateStr && new Date(dateStr).getTime() >= weekAgo) {
          weeklyTotal += amount;
        }
      }
      lines.push(`Revenue this week: $${weeklyTotal.toFixed(2)}`);
    } catch { lines.push("Revenue: unreadable"); }
  } else {
    lines.push("Revenue: $0.00 (no log yet)");
  }

  return lines.join("\n");
}

// ── Check 4: Morning Briefing — Ops Manager (06:00 daily) ────────────────────

async function morningBriefing() {
  const OPS = AGENTS.find((a) => a.slug === "ops-manager")!;
  const aurumCtx = getAurumMorningContext();

  const reply = await agentThink(
    HEARTBEAT_CHAT_ID,
    OPS,
    `Generate the morning briefing for ${new Date().toDateString()}.
Aurum system status:
${aurumCtx}
Include: (1) what's due today, (2) any items waiting for approval, (3) top priority action.
Max 150 words.`
  );
  logHeartbeat("morning_briefing", reply.slice(0, 500));
  // Send the AI briefing, then the raw Aurum data as a separate message
  await notify(`[Morning Briefing]\n${reply}\n\n---\n${aurumCtx}`);
}

// ── Check 5: End-of-Day Summary — Ops Manager (23:00 daily) ─────────────────

async function eodSummary() {
  const OPS = AGENTS.find((a) => a.slug === "ops-manager")!;

  // Read today's heartbeat log entries
  const { db } = await import("./db.js");
  const rows = db.query(
    "SELECT check_type, result FROM heartbeat_log WHERE ts > unixepoch() - 86400 ORDER BY ts DESC LIMIT 20"
  ).all() as Array<{ check_type: string; result: string }>;

  const summary = rows.map((r) => `[${r.check_type}] ${r.result.slice(0, 100)}`).join("\n");

  const reply = await agentThink(
    HEARTBEAT_CHAT_ID,
    OPS,
    `Generate the end-of-day summary for ${new Date().toDateString()}.
Today's heartbeat log:\n${summary || "No entries."}\nMax 120 words.`
  );
  logHeartbeat("eod_summary", reply.slice(0, 500));
  await notify(`[End-of-Day Summary]\n${reply}`);
}

// ── Check 6: Content Opportunity Scanner (09:00 daily) ───────────────────────

async function contentOpportunityCheck() {
  const CONTENT = AGENTS.find((a) => a.slug === "content-writer")!;
  const statePath = "/home/aurumbot/Aurum/state.json";
  let niche = "AI automation and robotics";
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.active_business) niche = state.active_business;
  }

  const reply = await agentThink(
    HEARTBEAT_CHAT_ID,
    CONTENT,
    `Today is ${new Date().toDateString()}. The business niche is: ${niche}.
Suggest 3 content ideas that would perform well today based on what's likely trending.
Format: title | format (blog/thread/email) | hook sentence. Be specific.`
  );
  logHeartbeat("content_opportunities", reply.slice(0, 500));
  await notify(`[Content Ideas for Today]\n${reply}`);
}

// ── Check 7: DevOps service watchdog (every 5 min) ───────────────────────────

async function serviceWatchdog() {
  const pidFile = path.join(__dirname, "data", "openclaw.pid");
  // Self-check: if we're running, we're fine
  // Check aurum-bot processes
  const proc = Bun.spawn(["ps", "aux"], { stdout: "pipe" });
  const ps = await new Response(proc.stdout).text();

  const aurumRunning = ps.includes("health_server.py") || ps.includes("aurum_gateway.py");
  if (!aurumRunning) {
    logHeartbeat("service_watchdog", "Aurum services not detected in process list");
    // Don't spam — only alert if this persists (logged, user can check)
  }
}

// ── Check 8: Calendar (every hour at :05) ────────────────────────────────────

async function checkCalendar() {
  const calFile = path.join(__dirname, "heartbeat", "calendar.json");
  if (!fs.existsSync(calFile)) return;

  const events = JSON.parse(fs.readFileSync(calFile, "utf8")) as Array<{start: string; title: string}>;
  const now = new Date();
  const soon = events.filter((e) => {
    const diff = new Date(e.start).getTime() - now.getTime();
    return diff > 0 && diff < 3_600_000;
  });

  if (soon.length) {
    const list = soon.map((e) => `- ${e.title} at ${new Date(e.start).toLocaleTimeString()}`).join("\n");
    await notify(`[Calendar] Upcoming in 1h:\n${list}`);
    logHeartbeat("calendar", `${soon.length} event(s) soon`);
  }
}

// ── Schedule registration ─────────────────────────────────────────────────────

export function startHeartbeat() {
  if (!ownerChatId) {
    console.warn("[heartbeat] No TELEGRAM_OWNER_CHAT_ID — heartbeats disabled");
    return;
  }

  // Every 5 min: service watchdog
  cron.schedule("*/5 * * * *", async () => {
    try { await serviceWatchdog(); } catch {}
  });

  // Every 15 min: aurum state
  cron.schedule("*/15 * * * *", async () => {
    try { await checkAurumBotState(); } catch (e) { console.error("[hb] aurum_state:", e); }
  });

  // Every 30 min: log scan
  cron.schedule("*/30 * * * *", async () => {
    try { await checkSystemLogs(); } catch (e) { console.error("[hb] logs:", e); }
  });

  // Every hour: disk
  cron.schedule("0 * * * *", async () => {
    try { await checkDiskSpace(); } catch (e) { console.error("[hb] disk:", e); }
  });

  // Every hour :05: calendar
  cron.schedule("5 * * * *", async () => {
    try { await checkCalendar(); } catch (e) { console.error("[hb] calendar:", e); }
  });

  // 06:00 daily: morning briefing
  cron.schedule("0 6 * * *", async () => {
    try { await morningBriefing(); } catch (e) { console.error("[hb] morning:", e); }
  });

  // 09:00 daily: content opportunities
  cron.schedule("0 9 * * *", async () => {
    try { await contentOpportunityCheck(); } catch (e) { console.error("[hb] content:", e); }
  });

  // 23:00 daily: EOD summary
  cron.schedule("0 23 * * *", async () => {
    try { await eodSummary(); } catch (e) { console.error("[hb] eod:", e); }
  });

  console.log("[heartbeat] Started — 8 autonomous checks scheduled");
}

// ── Manual trigger (for /heartbeat command) ───────────────────────────────────

export async function runCheckNow(checkName: string): Promise<string> {
  const map: Record<string, () => Promise<void>> = {
    aurum: checkAurumBotState,
    logs: checkSystemLogs,
    disk: checkDiskSpace,
    morning: morningBriefing,
    eod: eodSummary,
    content: contentOpportunityCheck,
    watchdog: serviceWatchdog,
    calendar: checkCalendar,
  };
  const fn = map[checkName];
  if (!fn) return `Unknown check. Available: ${Object.keys(map).join(", ")}`;
  await fn();
  return `Check '${checkName}' ran. Result sent via heartbeat channel.`;
}
