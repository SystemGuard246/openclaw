/**
 * gateway.ts — OpenClaw Telegram Gateway (Grammy.js)
 * Security controls: input validation, per-user rate limits, HITL confirmation,
 * skill authorization, AI disclosure, command auditing.
 */

import { Bot } from "grammy";
import { think } from "./brain.js";
import { routeToAgent, agentThink, runPipeline, AGENTS, PIPELINES } from "./orchestrator.js";
import { runSkill, listSkills } from "./skills.js";
import { doctorReport } from "./doctor.js";
import { getOrCreateSession, getFacts, db } from "./db.js";
import { initHeartbeat, startHeartbeat, runCheckNow } from "./heartbeat.js";
import { startImprovementCycle, runImprovementCycleNow } from "./improvement-cycle.js";
import { getRecentReflections } from "./self-reflection-journal.js";
import { config } from "./config.js";
import {
  validateMessage, validateArgs, sanitizeChatId, auditCommand,
  requireConfirmation, resolveConfirmation, cancelAction,
  getSkillRisk, isDesktopControlEnabled, setConfig,
  pruneOldMessages, pruneExpired,
  AI_DISCLOSURE, hasReceivedDisclosure, markDisclosed,
  recordAuthFailure, isAuthBlocked, clearAuthAttempts,
  checkBurstLimit, checkCommandLimit,
} from "./security.js";
import { getAuditSummary } from "./db.js";

// ── Validate required env ─────────────────────────────────────────────────────

if (!config.telegramToken) {
  console.error("[gateway] TELEGRAM_BOT_TOKEN not set in .env — exiting");
  process.exit(1);
}
if (!config.allowedChatIds) {
  console.error("[gateway] TELEGRAM_ALLOWED_IDS is not set. Set it to your chat ID to prevent unauthorized access.");
  process.exit(1);
}

const BRAIN_READY = !!config.groqKey;
if (!BRAIN_READY) console.warn("[gateway] ANTHROPIC_API_KEY not set — AI responses disabled");

// ── Bot init ──────────────────────────────────────────────────────────────────

const bot = new Bot(config.telegramToken);

const ALLOWED_IDS = new Set(
  config.allowedChatIds.split(",").map((s) => s.trim()).filter(Boolean)
);

// Separate admin IDs (for /doctor, /run high-risk skills)
const ADMIN_IDS = new Set(
  (config.adminChatIds ?? config.allowedChatIds).split(",").map((s) => s.trim()).filter(Boolean)
);

function isAdmin(chatId: string): boolean {
  return ADMIN_IDS.has(chatId);
}

async function send(chatId: string, text: string) {
  const MAX = 4000;
  for (let i = 0; i < text.length; i += MAX) {
    await bot.api.sendMessage(chatId, text.slice(i, i + MAX), { parse_mode: "Markdown" })
      .catch(() => bot.api.sendMessage(chatId, text.slice(i, i + MAX)));
  }
}

// ── Auth gate middleware ──────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = String(ctx.chat?.id ?? "");

  // Validate chat ID format
  if (!sanitizeChatId(chatId)) {
    console.warn(`[gateway] Malformed chat_id: ${chatId}`);
    return;
  }

  if (!ALLOWED_IDS.has(chatId)) {
    // Track auth failure — block after 5 attempts in 15 min
    recordAuthFailure(chatId);
    await ctx.reply("Unauthorized.");
    console.warn(`[gateway] Blocked unauthorized chat_id=${chatId} username=${ctx.from?.username}`);
    return;
  }

  // Burst protection: max 5 messages per 60 seconds
  if (!checkBurstLimit(chatId)) {
    await ctx.reply("Rate limited (burst). Try again in 60 seconds.");
    console.warn(`[gateway] Burst limit hit chat_id=${chatId}`);
    return;
  }

  // Block temporarily if repeated auth failures from this ID
  if (isAuthBlocked(chatId)) {
    await ctx.reply("Too many failed auth attempts. Try again in 15 minutes.");
    return;
  }

  // Clear failure counter on successful auth
  clearAuthAttempts(chatId);

  await next();
});

// ── AI disclosure helper ──────────────────────────────────────────────────────

async function sendWithDisclosure(chatId: string, text: string) {
  if (!hasReceivedDisclosure(chatId)) {
    markDisclosed(chatId);
    await send(chatId, AI_DISCLOSURE + text);
  } else {
    await send(chatId, text);
  }
}

// ── /start ────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const chatId = String(ctx.chat.id);
  getOrCreateSession(chatId, ctx.from?.username);
  markDisclosed(chatId); // /start always discloses
  auditCommand(chatId, "/start");

  await ctx.reply(
    `${AI_DISCLOSURE}` +
    `*OpenClaw online.*\n\n` +
    `${BRAIN_READY ? "AI brain: ready" : "AI brain: API key missing"}\n` +
    `Agents: ${AGENTS.length} | Heartbeats: 8 | Skills: ${listSkills().length}\n\n` +
    `Type anything — your message is routed to the right agent automatically.\n` +
    `/agents — meet the team\n` +
    `/help — all commands`,
    { parse_mode: "Markdown" }
  );
});

// ── /help ─────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  await ctx.reply(
    `*Commands*\n\n` +
    `*Conversation*\n` +
    `/agents — list the agent team\n` +
    `/agent <slug> <msg> — talk to a specific agent\n` +
    `/pipeline <name> <input> — multi-agent pipeline\n\n` +
    `*Memory*\n` +
    `/memory — list long-term memories\n` +
    `/forget — clear memories for this chat\n` +
    `/delete-history — delete all conversation history\n\n` +
    `*Skills*\n` +
    `/skills — list available skills\n` +
    `/run <skill> [args] — execute a skill (high-risk requires confirmation)\n\n` +
    `*Monitoring*\n` +
    `/heartbeat <check> — trigger a proactive check now\n` +
    `/status — session stats\n\n` +
    `*Admin only*\n` +
    `/doctor — health check\n` +
    `/enable-desktop-control — opt in to mouse/keyboard control\n` +
    `/improver — trigger self-improvement cycle now\n\n` +
    `*Self-Evolution*\n` +
    `/journal [hours] — view self-improvement log (default: 24h)\n\n` +
    `*Confirmation*\n` +
    `/confirm <id> — approve a pending action\n` +
    `/cancel <id> — cancel a pending action\n\n` +
    `*Security*\n` +
    `/audit [days] — show security and command audit summary (default: 7d)`,
    { parse_mode: "Markdown" }
  );
});

// ── /agents ───────────────────────────────────────────────────────────────────

bot.command("agents", async (ctx) => {
  const list = AGENTS.map((a) => `*${a.name}* (\`${a.slug}\`)\n_${a.description}_`).join("\n\n");
  await ctx.reply(
    `*AI Agent Team* _(all powered by Claude/Anthropic)_\n\n${list}\n\n` +
    `Direct access: \`/agent seo-specialist <message>\``,
    { parse_mode: "Markdown" }
  );
});

// ── /agent <slug> <msg> ───────────────────────────────────────────────────────

bot.command("agent", async (ctx) => {
  if (!BRAIN_READY) { await ctx.reply("ANTHROPIC_API_KEY not set."); return; }
  const chatId = String(ctx.chat.id);
  const parts = (ctx.message?.text ?? "").split(" ").slice(1);
  const slug = parts[0] ?? "";
  const rawMessage = parts.slice(1).join(" ");

  const agent = AGENTS.find((a) => a.slug === slug);
  if (!agent) {
    await ctx.reply(`Unknown agent: ${slug}\nAvailable: ${AGENTS.map((a) => a.slug).join(", ")}`);
    return;
  }

  const validation = validateMessage(rawMessage);
  if (!validation.ok) { await ctx.reply(validation.error!); return; }

  const cmdLimit = checkCommandLimit(chatId, "agent");
  if (!cmdLimit.allowed) { await ctx.reply(`⚠️ ${cmdLimit.reason}`); return; }

  auditCommand(chatId, "/agent", slug);
  await ctx.replyWithChatAction("typing");
  const reply = await agentThink(chatId, agent, validation.sanitized);
  await sendWithDisclosure(chatId, `*[${agent.name}]*\n${reply}`);
});

// ── /pipeline <name> <input> ──────────────────────────────────────────────────

bot.command("pipeline", async (ctx) => {
  if (!BRAIN_READY) { await ctx.reply("ANTHROPIC_API_KEY not set."); return; }
  const chatId = String(ctx.chat.id);
  const parts = (ctx.message?.text ?? "").split(" ").slice(1);
  const pipeName = parts[0] ?? "";
  const input = parts.slice(1).join(" ");

  const factory = PIPELINES[pipeName];
  if (!factory) {
    await ctx.reply(`Unknown pipeline: ${pipeName}\nAvailable: ${Object.keys(PIPELINES).join(", ")}`);
    return;
  }
  if (!input) { await ctx.reply(`Usage: /pipeline ${pipeName} <topic>`); return; }

  const validation = validateMessage(input);
  if (!validation.ok) { await ctx.reply(validation.error!); return; }

  const cmdLimit = checkCommandLimit(chatId, "pipeline");
  if (!cmdLimit.allowed) { await ctx.reply(`⚠️ ${cmdLimit.reason}`); return; }

  auditCommand(chatId, "/pipeline", pipeName);
  await ctx.reply(`Running pipeline *${pipeName}* (${factory(input).length} agents)...`, { parse_mode: "Markdown" });

  try {
    const result = await runPipeline(chatId, factory(validation.sanitized), validation.sanitized);
    for (const step of result.steps) {
      await send(chatId, `*[${step.agent}]*\n${step.output}`);
    }
  } catch (err: unknown) {
    await ctx.reply(`Pipeline error: ${err instanceof Error ? err.message : "unknown"}`);
  }
});

// ── /heartbeat <check> ────────────────────────────────────────────────────────

bot.command("heartbeat", async (ctx) => {
  if (!BRAIN_READY) { await ctx.reply("ANTHROPIC_API_KEY not set."); return; }
  const chatId = String(ctx.chat.id);
  const check = (ctx.message?.text ?? "").split(" ")[1] ?? "";
  if (!check) {
    await ctx.reply(
      "Available checks:\n" +
      "`/heartbeat morning` `/heartbeat eod` `/heartbeat content`\n" +
      "`/heartbeat aurum` `/heartbeat disk` `/heartbeat logs` `/heartbeat watchdog`",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const hbLimit = checkCommandLimit(chatId, "heartbeat");
  if (!hbLimit.allowed) { await ctx.reply(`⚠️ ${hbLimit.reason}`); return; }

  auditCommand(chatId, "/heartbeat", check);
  await ctx.reply(`Running check: ${check}...`);
  const result = await runCheckNow(check);
  await ctx.reply(result);
});

// ── /skills ───────────────────────────────────────────────────────────────────

bot.command("skills", async (ctx) => {
  const skills = listSkills();
  if (!skills.length) { await ctx.reply("No skills installed."); return; }
  const list = skills.map((s) => {
    const risk = getSkillRisk(s);
    const badge = risk === "safe" ? "" : risk === "high" ? " ⚠️ HIGH RISK" : " ⚡ MEDIUM";
    return `- \`${s}\`${badge}`;
  });
  await ctx.reply(`*Skills:*\n${list.join("\n")}\n\nHigh-risk skills require confirmation.`, { parse_mode: "Markdown" });
});

// ── /run <skill> [args] ───────────────────────────────────────────────────────

bot.command("run", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const parts = (ctx.message?.text ?? "").split(" ").slice(1);
  const skillName = parts[0] ?? "";
  if (!skillName) { await ctx.reply("Usage: /run <skill> [args]"); return; }

  const rawArgs = parts.slice(1).join(" ");
  const argsValidation = validateArgs(rawArgs);
  if (!argsValidation.ok) { await ctx.reply(argsValidation.error!); return; }

  const runLimit = checkCommandLimit(chatId, skillName.includes("shell") ? "shell" : "run");
  if (!runLimit.allowed) { await ctx.reply(`⚠️ ${runLimit.reason}`); return; }

  // Check skill risk level
  const risk = getSkillRisk(skillName);

  // desktop-control requires explicit opt-in
  if (skillName.includes("desktop-control")) {
    if (!isAdmin(chatId)) { await ctx.reply("Admin only."); return; }
    if (!isDesktopControlEnabled()) {
      await ctx.reply(
        "Desktop control is disabled.\n" +
        "Run `/enable-desktop-control` to opt in.\n\n" +
        "_Warning: grants full mouse/keyboard access to the AI._",
        { parse_mode: "Markdown" }
      );
      return;
    }
  }

  // High-risk skills require HITL confirmation
  if (risk === "high") {
    if (!isAdmin(chatId)) { await ctx.reply("Admin only."); return; }
    const { id, message } = requireConfirmation(
      chatId,
      `Run skill \`${skillName}\`${rawArgs ? ` with args: ${rawArgs.slice(0, 100)}` : ""}`,
      "high",
      { skillName, rawArgs }
    );
    await ctx.reply(message, { parse_mode: "Markdown" });
    return;
  }

  let args: Record<string, unknown> = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { args = { input: rawArgs }; }

  auditCommand(chatId, "/run", skillName);
  await ctx.reply(`Running: \`${skillName}\`...`, { parse_mode: "Markdown" });
  const result = await runSkill(skillName, args, chatId);
  await send(chatId, `*${skillName}* ${result.ok ? "✓" : "✗"}\n\`\`\`\n${result.output.slice(0, 3000) || "(no output)"}\n\`\`\``);
});

// ── /confirm <id> ─────────────────────────────────────────────────────────────

bot.command("confirm", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const id = (ctx.message?.text ?? "").split(" ")[1] ?? "";
  if (!id) { await ctx.reply("Usage: /confirm <id>"); return; }

  const resolution = resolveConfirmation(id, chatId);
  if (!resolution.found) { await ctx.reply("Confirmation not found. It may have already been used."); return; }
  if (resolution.expired) { await ctx.reply("Confirmation expired (5 min timeout). Retry the command."); return; }

  // Execute the confirmed action
  const payload = resolution.payload as { skillName: string; rawArgs: string };
  let args: Record<string, unknown> = {};
  try { args = payload.rawArgs ? JSON.parse(payload.rawArgs) : {}; } catch { args = { input: payload.rawArgs }; }

  auditCommand(chatId, "/confirm", `confirmed:${payload.skillName}`);
  await ctx.reply(`Confirmed. Running \`${payload.skillName}\`...`, { parse_mode: "Markdown" });
  const result = await runSkill(payload.skillName, args, chatId);
  await send(chatId, `*${payload.skillName}* ${result.ok ? "✓" : "✗"}\n\`\`\`\n${result.output.slice(0, 3000) || "(no output)"}\n\`\`\``);
});

// ── /cancel <id> ──────────────────────────────────────────────────────────────

bot.command("cancel", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const id = (ctx.message?.text ?? "").split(" ")[1] ?? "";
  if (!id) { await ctx.reply("Usage: /cancel <id>"); return; }
  const cancelled = cancelAction(id, chatId);
  await ctx.reply(cancelled ? `Action ${id} cancelled.` : "Action not found or already resolved.");
});

// ── /enable-desktop-control ───────────────────────────────────────────────────

bot.command("enable-desktop-control", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAdmin(chatId)) { await ctx.reply("Admin only."); return; }

  const { id, message } = requireConfirmation(
    chatId,
    "Enable desktop control (gives AI full mouse/keyboard access)",
    "critical",
    { action: "enable-desktop-control" }
  );
  await ctx.reply(
    `⚠️ *Security Warning*\n\n` +
    `Desktop control gives OpenClaw full mouse and keyboard access to this machine.\n` +
    `Only enable this on a dedicated machine, never on your personal computer.\n\n` +
    message,
    { parse_mode: "Markdown" }
  );
});

// Override /confirm for desktop control
const origConfirmHandler = bot.command.bind(bot);
// (Desktop control confirmation handled via /confirm route above — payload check needed)

// ── /memory / /forget / /delete-history ──────────────────────────────────────

bot.command("memory", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const facts = getFacts(chatId);
  if (!facts.length) { await ctx.reply("No memories stored yet."); return; }
  const lines = facts.map((f, i) => `${i + 1}. ${f.fact}${f.tags ? ` _(${f.tags})_` : ""}`);
  await ctx.reply(`*Long-term memories:*\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("forget", async (ctx) => {
  const chatId = String(ctx.chat.id);
  auditCommand(chatId, "/forget");
  db.run("DELETE FROM memories WHERE chat_id = ?", [chatId]);
  await ctx.reply("Long-term memories cleared.");
});

bot.command("delete_history", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const { id, message } = requireConfirmation(chatId, "Delete all conversation history for this chat", "high", { action: "delete-history", chatId });
  await ctx.reply(message, { parse_mode: "Markdown" });
});

// ── /status ───────────────────────────────────────────────────────────────────

bot.command("status", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const session = getOrCreateSession(chatId) as { message_count: number; last_seen: number };
  const facts = getFacts(chatId);
  await ctx.reply(
    `*Status*\n` +
    `Chat ID: \`${chatId}\`\n` +
    `Messages: ${session.message_count}\n` +
    `Memories: ${facts.length}\n` +
    `Agents: ${AGENTS.length}\n` +
    `Brain: ${BRAIN_READY ? "ready" : "no API key"}\n` +
    `Last active: ${new Date(session.last_seen * 1000).toISOString()}`,
    { parse_mode: "Markdown" }
  );
});

// ── /doctor (admin only) ──────────────────────────────────────────────────────

bot.command("doctor", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAdmin(chatId)) { await ctx.reply("Admin only."); return; }
  auditCommand(chatId, "/doctor");
  await ctx.reply("Running diagnostics...");
  const report = doctorReport();
  await send(chatId, `\`\`\`\n${report}\n\`\`\``);
});

// ── /journal ──────────────────────────────────────────────────────────────────

bot.command("journal", async (ctx) => {
  const chatId = String(ctx.chat.id);
  auditCommand(chatId, "/journal");
  const hours = parseInt((ctx.message?.text ?? "").split(" ")[1] ?? "24", 10) || 24;
  const entries = getRecentReflections(hours);

  if (!entries.length) {
    await ctx.reply(`No self-improvement cycles recorded in the last ${hours}h.`);
    return;
  }

  const lines = entries.slice(0, 10).map((e) => {
    const ts = new Date(e.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const statusIcon = { committed: "✅", rejected: "❌", pending_hitl: "⏳", no_problems: "💤" }[e.status] ?? "?";
    const problem = e.problemsDetected[0]?.slice(0, 60) ?? "no problems";
    const commit = e.gitCommitHash ? ` | commit: \`${e.gitCommitHash.slice(0, 7)}\`` : "";
    const confidence = e.proposedFix ? ` | conf: ${e.proposedFix.confidence}/10` : "";
    return `${statusIcon} \`${ts}\`\n   ${problem}${confidence}${commit}`;
  });

  await ctx.reply(
    `*Self-Reflection Journal* (last ${hours}h, ${entries.length} entries)\n\n` +
    lines.join("\n\n"),
    { parse_mode: "Markdown" }
  );
});

// ── /improver ─────────────────────────────────────────────────────────────────

bot.command("improver", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAdmin(chatId)) { await ctx.reply("Admin only."); return; }
  if (!BRAIN_READY) { await ctx.reply("GROQ_API_KEY not set."); return; }
  auditCommand(chatId, "/improver");
  await ctx.reply("Running improvement cycle now...");
  const result = await runImprovementCycleNow();
  await send(chatId, `*Improvement cycle result:*\n\`\`\`\n${result}\n\`\`\``);
});

// ── /audit [days] ─────────────────────────────────────────────────────────────

bot.command("audit", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const days = parseInt((ctx.message?.text ?? "").split(" ")[1] ?? "7", 10) || 7;
  auditCommand(chatId, "/audit");
  const summary = getAuditSummary(chatId, days);
  await ctx.reply(summary, { parse_mode: "Markdown" });
});

// ── Main message handler ──────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const rawText = ctx.message.text;

  // Input validation
  const validation = validateMessage(rawText);
  if (!validation.ok) { await ctx.reply(validation.error!); return; }

  getOrCreateSession(chatId, ctx.from?.username);
  await ctx.replyWithChatAction("typing");

  if (!BRAIN_READY) {
    await ctx.reply(
      "OpenClaw is online but `ANTHROPIC_API_KEY` is not set.\n" +
      "Add it to `.env` and restart.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    const agent = await routeToAgent(validation.sanitized);

    let replyText: string;
    let disclosure: string | undefined;

    if (agent) {
      replyText = await agentThink(chatId, agent, validation.sanitized);
      replyText = `*[${agent.name}]*\n${replyText}`;
      if (!hasReceivedDisclosure(chatId)) {
        disclosure = AI_DISCLOSURE;
        markDisclosed(chatId);
      }
    } else {
      const result = await think(chatId, validation.sanitized);
      replyText = result.reply;
      disclosure = result.disclosure;
    }

    await send(chatId, disclosure ? disclosure + replyText : replyText);
  } catch (err: unknown) {
    // Log full error server-side, return opaque message to user
    const errorId = Math.random().toString(36).slice(2, 8).toUpperCase();
    console.error(`[gateway] Error ${errorId}:`, err);
    await ctx.reply(`Something went wrong (ref: ${errorId}). Run /doctor for diagnostics.`);
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

console.log("[openclaw] Starting gateway (secure mode)...");

initHeartbeat(send, config.ownerChatId ?? "");
startHeartbeat();

startImprovementCycle(send, config.ownerChatId ?? "");

// Maintenance: prune old data every 6 hours
setInterval(() => {
  pruneOldMessages();
  pruneExpired();
}, 6 * 3600 * 1000);

process.on("SIGINT",  () => { bot.stop(); process.exit(0); });
process.on("SIGTERM", () => { bot.stop(); process.exit(0); });

bot.start({
  onStart: (info) => {
    console.log(`[openclaw] @${info.username} | ${AGENTS.length} agents | allowed: ${[...ALLOWED_IDS].join(",")}`);
  },
});
