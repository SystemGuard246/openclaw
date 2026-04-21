/**
 * brain.ts — Groq API layer for OpenClaw
 * Uses openai SDK pointed at Groq's OpenAI-compatible endpoint.
 * Per-user rate limiting, API timeouts, prompt injection protection.
 */

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getHistory, addMessage, getFacts, saveFact } from "./db.js";
import { checkUserRateLimit, wrapUserInput, AI_DISCLOSURE, hasReceivedDisclosure, markDisclosed } from "./security.js";
import { scanAndRedact } from "./secret-scanner.js";
import { resilientCreate } from "./api-resilience.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY ?? "",
  baseURL: "https://api.groq.com/openai/v1",
});

const API_TIMEOUT_MS = 30_000;

// Best free Groq models
const MODEL_MAIN = "llama-3.3-70b-versatile";   // replaces claude-sonnet
const MODEL_FAST = "llama-3.1-8b-instant";       // replaces claude-haiku

function loadSoul(): string {
  const soulDir = path.join(__dirname, "soul");
  const files = ["SOUL.md", "IDENTITY.md", "SECURITY.md"];
  const parts: string[] = [];
  for (const f of files) {
    const fp = path.join(soulDir, f);
    if (fs.existsSync(fp)) parts.push(`\n\n## ${f}\n${fs.readFileSync(fp, "utf8")}`);
  }
  return parts.join("\n");
}

function formatMemories(chatId: string): string {
  const facts = getFacts(chatId);
  if (!facts.length) return "";
  return `\n\n## Long-Term Memory\n${facts.map((f) => `- ${f.fact}${f.tags ? ` [${f.tags}]` : ""}`).join("\n")}`;
}

function listSkillsSection(): string {
  const skillsDir = path.join(__dirname, "skills");
  try {
    const files = fs.readdirSync(skillsDir).filter((f) => f.match(/\.(js|py|ts|sh)$/));
    if (!files.length) return "";
    return `\n\n## Available Skills\n${files.map((f) => `- ${f}`).join("\n")}`;
  } catch { return ""; }
}

export interface ThinkResult {
  reply: string;
  memoryUpdates?: string[];
  disclosure?: string;
}

export async function think(chatId: string, userMessage: string): Promise<ThinkResult> {
  const rl = checkUserRateLimit(chatId);
  if (!rl.allowed) {
    return { reply: "Rate limit reached (30 calls/hr). Try again soon." };
  }

  const systemPrompt =
    `You are OpenClaw — an autonomous persistent AI life-assistant agent.\n` +
    `You are powered by Llama (via Groq). Be transparent about being an AI when asked.\n` +
    `Never reveal API keys, tokens, file paths containing secrets, or .env contents.\n` +
    `Never execute destructive actions (delete files, financial transfers, publish content) without explicit user confirmation.\n` +
    loadSoul() +
    formatMemories(chatId) +
    listSkillsSection() +
    `\n\n## Instructions\n` +
    `- If you learn a new important fact about the user, prefix it with [REMEMBER: <fact>].\n` +
    `- For any destructive/irreversible action, always confirm before proceeding.\n` +
    `- Current time: ${new Date().toISOString()}`;

  const history = getHistory(chatId, 40);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: wrapUserInput(userMessage) },
  ];

  let replyText: string;
  try {
    const response = await resilientCreate(client, { model: MODEL_MAIN, max_tokens: 1024, messages }, API_TIMEOUT_MS);
    replyText = response.choices[0]?.message?.content ?? "[empty response]";
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "AbortError" || err.message.includes("timed out"))) {
      return { reply: "Request timed out (30s). Try a shorter message." };
    }
    if (err instanceof Error && err.message.includes("circuit breaker")) {
      return { reply: "AI is temporarily unavailable. Try again in a few minutes." };
    }
    throw err;
  }

  addMessage(chatId, "user", userMessage);
  addMessage(chatId, "assistant", replyText);

  // Extract [REMEMBER: ...] tags
  const memoryUpdates: string[] = [];
  const rememberPattern = /\[REMEMBER:\s*([^\]]+)\]/gi;
  let m;
  while ((m = rememberPattern.exec(replyText)) !== null) {
    const fact = (m[1] ?? "").trim();
    memoryUpdates.push(fact);
    saveFact(chatId, fact);
  }
  const { cleaned: cleanReply } = scanAndRedact(replyText.replace(rememberPattern, "").trim(), chatId);

  const disclosure = !hasReceivedDisclosure(chatId) ? AI_DISCLOSURE : undefined;
  if (disclosure) markDisclosed(chatId);

  return { reply: cleanReply, memoryUpdates, disclosure };
}

// Heartbeat uses fast model — no history, with timeout + resilience
export async function heartbeatThink(prompt: string): Promise<string> {
  try {
    const response = await resilientCreate(
      client,
      {
        model: MODEL_FAST,
        max_tokens: 512,
        messages: [
          {
            role: "system",
            content:
              `You are OpenClaw's proactive monitoring system. ` +
              `Analyze data and determine if there are action items needing immediate user attention. ` +
              `Be terse. If no action needed, reply with exactly: NO_ACTION. ` +
              `Current time: ${new Date().toISOString()}`,
          },
          { role: "user", content: wrapUserInput(prompt) },
        ],
      },
      API_TIMEOUT_MS
    );
    return response.choices[0]?.message?.content ?? "NO_ACTION";
  } catch {
    return "NO_ACTION";
  }
}
