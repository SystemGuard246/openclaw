/**
 * index.ts — OpenClaw entry point
 * Run: bun index.ts
 *
 * Starts the Telegram bot gateway and the heartbeat monitoring loop.
 * The gateway module initializes everything on import.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Write PID file so the service watchdog can track us
const pidPath = path.join(__dirname, "data", "openclaw.pid");
fs.mkdirSync(path.dirname(pidPath), { recursive: true });
fs.writeFileSync(pidPath, String(process.pid));

process.on("exit", () => {
  try { fs.unlinkSync(pidPath); } catch {}
});

console.log(`[openclaw] PID ${process.pid} — booting gateway...`);

// Gateway auto-starts on import (registers all commands, starts bot, starts heartbeat)
await import("./gateway.js");
