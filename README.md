# OpenClaw

**Persistent AI agent operating system — Telegram bot with 14 specialized agents, autonomous self-improvement, and human-in-the-loop security.**

Built on Bun + Grammy.js + Groq API (Llama 3.3-70b).

---

## What it does

OpenClaw is an always-on Telegram bot that:
- Routes messages to the right specialist agent automatically (keyword-first, LLM fallback)
- Runs proactive background health checks on a schedule
- Executes local shell skills with a typed ACL
- Self-monitors and self-improves every 6 hours — generates TypeScript patches, validates them, and either auto-commits (safe) or sends you an approval prompt (medium/high risk)
- Maintains per-user conversation history, long-term memories, and rate limits in SQLite

---

## Architecture

```
index.ts          Entry point — starts gateway + heartbeat
gateway.ts        Telegram bot — auth, 16 commands, HITL, burst protection
orchestrator.ts   14-agent router + pipeline engine
brain.ts          Direct Claude API path (non-agent queries)
heartbeat.ts      8 cron checks — watchdog, disk, briefings, logs
security.ts       Rate limiting (burst + hourly), HITL tokens, input validation
hitl-crypto.ts    32-byte base64url HITL tokens with timestamp
db.ts             SQLite layer — all tables, WAL mode
doctor.ts         9-point health check (bun run doctor.ts)
improvement-cycle.ts  6-hour self-improvement loop
self-reflection-journal.ts  JSONL log of every improvement cycle
config.ts         Config loader from aurum.config.json / env
skills.ts         Typed skill registry
```

---

## Agents (14)

| Agent | Slug | Role |
|-------|------|------|
| SEO Specialist | `seo-specialist` | Audits, keyword research, meta tags, competitor analysis |
| Operations Manager | `ops-manager` | Reports, task routing, pipeline status, scheduling |
| Content Writer | `content-writer` | Blog posts, threads, email campaigns, repurposing |
| Customer Support | `customer-support` | Tickets, complaints, FAQ responses, escalation |
| DevOps Engineer | `devops` | System health, crash recovery, log analysis |
| Marcus | `marcus` | Chief orchestrator — strategy, goal decomposition, pipeline oversight |
| Iris | `iris` | Trend scout — market intelligence, signal detection, research synthesis |
| Finn | `finn` | Lead hunter — prospect research, outreach drafting, ICP qualification |
| Victor | `victor` | Sales strategist — proposals, objection handling, negotiation |
| Aria | `aria` | Brand voice — content strategy, copywriting, editorial planning |
| Sterling | `sterling` | Capital tracker — cash flow, burn rate, runway modeling |
| Solomon | `solomon` | CEO coach — strategic decisions, leadership, OKRs |
| Sage | `sage` | Wellness guardian — energy, sleep, stress, sustainable performance |
| Improver | `improver` | Self-evolution engine — scans logs, proposes and commits TypeScript fixes |

Routing is two-stage: keyword bank first (zero LLM cost), then Llama 3.1-8b classification fallback. Each agent has a dedicated `agents/<slug>/SOUL.md` with role constraints.

---

## Commands

| Command | Access | Description |
|---------|--------|-------------|
| `/start` | All | Welcome + AI disclosure |
| `/help` | All | Command reference |
| `/ask <text>` | All | General Claude query (no agent routing) |
| `/agent <slug> <text>` | All | Direct message to a specific agent |
| `/pipeline <name> <input>` | All | Run a pre-built multi-agent pipeline |
| `/skill <name> [args]` | All | Execute a skill (shell command, etc.) |
| `/confirm <token>` | All | Approve a pending HITL action |
| `/cancel <token>` | All | Cancel a pending HITL action |
| `/memory` | All | List long-term facts remembered for your session |
| `/forget` | All | Clear long-term memories |
| `/status` | All | System status + rate limit info |
| `/journal [hours]` | All | Recent self-improvement cycle entries |
| `/doctor` | Admin | Full 9-point health check |
| `/improver` | Admin | Trigger self-improvement cycle immediately |
| `/run <cmd>` | Admin | Execute shell command (HITL-gated for medium/high risk) |
| `/config <key> <value>` | Admin | Set configuration values |

---

## Pre-built Pipelines

| Pipeline | Agents | Description |
|----------|--------|-------------|
| `blog-post` | SEO → Content | SEO brief → full blog post |
| `daily-briefing` | Ops | Morning briefing (150 words) |
| `repurpose` | Content | One piece → X thread + LinkedIn + email teaser |

---

## Self-Improvement Loop

Every 6 hours (00:00, 06:00, 12:00, 18:00 UTC):

1. Scans `audit_log` + `heartbeat_log` for the past 6 hours
2. Detects problems: auth failures (>10), rate-limit bursts (>30), skill failures (>5), heartbeat errors (>3)
3. If no problems — brainstorms a capability enhancement instead
4. Calls Improver agent to generate a TypeScript fix with structured output
5. Validates syntax: writes temp file → `bun --print import()` → deletes
6. Confidence gate: rejects proposals below 8/10
7. Risk categorization:
   - `safe` + passed validation → auto-commit (`git add -u`, never adds untracked files)
   - `medium`/`high` or failed validation → queues HITL prompt, notifies via Telegram
8. Logs full reasoning to `logs/self-reflection-journal.jsonl`
9. Writes summary row to `heartbeat_log` for `/status` visibility

Critical files (`security.ts`, `gateway.ts`, `hitl-crypto.ts`, `db.ts`) are always treated as high-risk regardless of Improver's self-assessment.

---

## Security

| Control | Implementation |
|---------|---------------|
| Allowlist auth | `TELEGRAM_ALLOWED_IDS` checked on every message before anything runs |
| Rate limiting — hourly | SQLite-backed sliding window, 30 calls/hr, survives restarts |
| Rate limiting — burst | In-memory, 5 calls/60s per user |
| HITL tokens | 32-byte `crypto.randomBytes(32)` base64url, 5-minute TTL, stored in SQLite |
| Prompt injection | All user input wrapped in `<user_message>` XML tags + explicit system prompt instruction |
| AI disclosure | Mandatory first-message disclosure, per-user tracking in SQLite |
| Input validation | Max 8192 chars, null byte stripping, empty check |
| Audit log | Every skill call logged to `audit_log` (truncated at 500 chars, never logs raw content) |
| Secret protection | System prompt instructs: never reveal API keys, tokens, env contents, or file paths |
| Auto-commit gate | `git add -u` only (never stages untracked files like `.env`) |

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- A Telegram bot token ([BotFather](https://t.me/BotFather))
- Groq API key (free tier available at [console.groq.com](https://console.groq.com))
- Your Telegram chat ID

### Install

```bash
git clone https://github.com/SystemGuard246/openclaw.git
cd openclaw
bun install
```

### Configure

Create `.env` in the repo root:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_IDS=your_chat_id_here
ADMIN_IDS=your_chat_id_here
GROQ_API_KEY=your_groq_key_here
OWNER_CHAT_ID=your_chat_id_here
```

### Run

```bash
# Foreground
bun run index.ts

# Health check
bun run doctor.ts

# Background (with logs)
bash start.sh --background

# Stop
bash stop.sh
```

### Systemd (optional)

```bash
sudo bash install_service.sh
```

---

## Persistence

All state lives in `data/openclaw.db` (SQLite, WAL mode):

| Table | Contents |
|-------|---------|
| `sessions` | chatId, username, message count |
| `messages` | Full conversation history (90-day retention) |
| `memories` | Long-term facts per session |
| `heartbeat_log` | Cron check results + self-reflection summaries |
| `audit_log` | Every skill execution |
| `rate_limit` | Per-user request timestamps |
| `pending_actions` | HITL tokens awaiting confirmation |
| `config` | Per-chatId settings (e.g., desktop_control) |
| `disclosures` | AI disclosure delivery tracking |

Self-improvement cycle logs: `logs/self-reflection-journal.jsonl`

---

## Build Status

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Gateway + auth + rate limiting | ✅ |
| 1 | SQLite persistence | ✅ |
| 1 | Agent routing (keyword + LLM) | ✅ |
| 1 | 5 core agents | ✅ |
| 1 | Pre-built pipelines | ✅ |
| 2 | Heartbeat monitoring (8 checks) | ✅ |
| 2 | HITL confirmation system | ✅ |
| 2 | Shell skill + ACL | ✅ |
| 2 | Doctor health check | ✅ |
| 3 | 9 named specialist agents | ✅ |
| 3 | HITL crypto tokens (256-bit) | ✅ |
| 3 | Burst rate protection | ✅ |
| 3 | Prompt injection hardening | ✅ |
| 5A | Self-improvement loop (6h cron) | ✅ |
| 5A | Self-reflection journal (JSONL) | ✅ |
| 5A | Syntax validation gate | ✅ |
| 5A | Risk categorization + HITL gate | ✅ |
| 5A | Auto-commit (safe proposals) | ✅ |
