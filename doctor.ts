/**
 * doctor.ts — Health check and auto-fix for OpenClaw
 * Run: bun run doctor.ts
 * Or trigger via Telegram: /doctor
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

const checks: CheckResult[] = [];

function check(name: string, fn: () => string) {
  try {
    const msg = fn();
    checks.push({ name, ok: true, message: msg });
  } catch (e: unknown) {
    checks.push({ name, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
}

// ── Health checks ─────────────────────────────────────────────────────────────

check("env_file", () => {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env not found — copy .env.example");
  const env = fs.readFileSync(envPath, "utf8");
  const missing: string[] = [];
  if (!env.includes("TELEGRAM_BOT_TOKEN=") || env.includes("TELEGRAM_BOT_TOKEN=your_")) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.includes("GROQ_API_KEY=") || env.includes("GROQ_API_KEY=your_") || !process.env.GROQ_API_KEY) missing.push("GROQ_API_KEY");
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(", ")}`);
  return ".env OK";
});

check("bun_runtime", () => {
  const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (r.error) throw new Error("bun not found in PATH");
  return `bun ${r.stdout.trim()}`;
});

check("node_runtime", () => {
  const r = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (r.error) throw new Error("node not found");
  return `node ${r.stdout.trim()}`;
});

check("groq_sdk", () => {
  const pkg = path.join(__dirname, "node_modules", "openai", "package.json");
  if (!fs.existsSync(pkg)) throw new Error("openai package not installed — run: bun install");
  const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
  return `openai (Groq-compatible) ${p.version}`;
});

check("grammy", () => {
  const pkg = path.join(__dirname, "node_modules", "grammy", "package.json");
  if (!fs.existsSync(pkg)) throw new Error("grammy not installed — run: bun install");
  const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
  return `grammy ${p.version}`;
});

check("database", () => {
  const dbPath = path.join(__dirname, "data", "openclaw.db");
  if (!fs.existsSync(dbPath)) return "DB will be created on first run";
  const stat = fs.statSync(dbPath);
  return `DB OK (${(stat.size / 1024).toFixed(1)} KB)`;
});

check("skills_dir", () => {
  const skillsDir = path.join(__dirname, "skills");
  if (!fs.existsSync(skillsDir)) throw new Error("skills/ missing — run: mkdir -p skills");
  const count = fs.readdirSync(skillsDir).filter((f) => f.match(/\.(js|ts|py|sh)$/)).length;
  return `${count} skill(s) loaded`;
});

check("soul_files", () => {
  const soulDir = path.join(__dirname, "soul");
  const required = ["SOUL.md", "IDENTITY.md", "SECURITY.md"];
  const missing = required.filter((f) => !fs.existsSync(path.join(soulDir, f)));
  if (missing.length) throw new Error(`Missing soul files: ${missing.join(", ")}`);
  return "SOUL.md, IDENTITY.md, SECURITY.md OK";
});

check("claude_code_cli", () => {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return "claude CLI not in PATH (optional)";
  return `claude ${r.stdout.trim()}`;
});

// ── Auto-fix ──────────────────────────────────────────────────────────────────

async function autoFix() {
  console.log("\n[doctor] Attempting auto-fix...");

  // Missing node_modules
  const nm = path.join(__dirname, "node_modules");
  if (!fs.existsSync(nm) || !fs.existsSync(path.join(nm, "grammy"))) {
    console.log("  → Running bun install...");
    execSync("bun install", { cwd: __dirname, stdio: "inherit" });
  }

  // Missing .env
  const envPath = path.join(__dirname, ".env");
  const examplePath = path.join(__dirname, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log("  → Copied .env.example → .env (fill in your tokens)");
  }

  // Missing dirs
  for (const dir of ["data", "skills", "soul", "heartbeat/checks"]) {
    const p = path.join(__dirname, dir);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      console.log(`  → Created ${dir}/`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

export function doctorReport(): string {
  const lines: string[] = ["OpenClaw Doctor Report", "═".repeat(40)];
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.message}`);
  }
  const failed = checks.filter((c) => !c.ok);
  lines.push("═".repeat(40));
  lines.push(failed.length === 0 ? "All checks passed." : `${failed.length} check(s) failed.`);
  return lines.join("\n");
}

// Run as standalone
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const fix = process.argv.includes("--fix");
  if (fix) await autoFix();
  console.log(doctorReport());
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
