/**
 * skills.ts — Skill executor for OpenClaw
 * Skills are single-file JS, Python, or shell scripts in /skills/
 * Args passed via SKILL_ARGS env var as JSON.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logAudit } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, "skills");

export interface SkillResult {
  ok: boolean;
  output: string;
  exitCode: number;
}

function resolveSkill(name: string): { file: string; interpreter: string } | null {
  const candidates = [
    { ext: ".js",  interpreter: "node" },
    { ext: ".ts",  interpreter: "bun"  },
    { ext: ".py",  interpreter: "python3" },
    { ext: ".sh",  interpreter: "bash" },
  ];
  for (const { ext, interpreter } of candidates) {
    const file = path.join(SKILLS_DIR, `${name}${ext}`);
    if (fs.existsSync(file)) return { file, interpreter };
  }
  // Exact filename
  const exact = path.join(SKILLS_DIR, name);
  if (fs.existsSync(exact)) {
    const ext = path.extname(name);
    const interp = ext === ".py" ? "python3" : ext === ".sh" ? "bash" : ext === ".ts" ? "bun" : "node";
    return { file: exact, interpreter: interp };
  }
  return null;
}

export function listSkills(): string[] {
  try {
    return fs.readdirSync(SKILLS_DIR)
      .filter((f) => f.match(/\.(js|ts|py|sh)$/) && !f.startsWith("_"));
  } catch {
    return [];
  }
}

export async function runSkill(
  skillName: string,
  args: Record<string, unknown> = {},
  chatId?: string
): Promise<SkillResult> {
  const resolved = resolveSkill(skillName);
  if (!resolved) {
    return { ok: false, output: `Skill not found: ${skillName}`, exitCode: 127 };
  }

  const { file, interpreter } = resolved;
  const argsJson = JSON.stringify(args);

  try {
    const proc = Bun.spawn([interpreter, file], {
      env: { ...process.env, SKILL_ARGS: argsJson },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(argsJson);
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const output = (stdout + stderr).trim();
    logAudit(chatId ?? null, skillName, `${interpreter} ${file}`, exitCode);
    return { ok: exitCode === 0, output, exitCode };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg, exitCode: 1 };
  }
}
