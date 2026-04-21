#!/usr/bin/env node
/**
 * Skill: daily-summary
 * Reads aurum-bot state and recent logs, outputs a daily summary.
 * Usage: /run daily-summary
 */

import fs from "fs";
import path from "path";

const BASE = "/home/aurumbot/aurum-bot";

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getRecentLogs(logDir, lines = 20) {
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith(".log"))
      .map(f => ({ f, mtime: fs.statSync(path.join(logDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return "No logs found.";
    const content = fs.readFileSync(path.join(logDir, files[0].f), "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "Could not read logs.";
  }
}

const state = readJson(`${BASE}/state.json`);
const logs = getRecentLogs(`${BASE}/logs`);

const summary = {
  timestamp: new Date().toISOString(),
  system: state?.system_name ?? "unknown",
  build_step: state?.build_step ?? 0,
  build_complete: state?.build_complete ?? false,
  active_business: state?.active_business ?? "unknown",
  current_ebook: state?.ebook_current_title ?? null,
  recent_log_tail: logs.slice(0, 1000),
};

console.log(JSON.stringify(summary, null, 2));
