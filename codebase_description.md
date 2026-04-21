# Codebase Description — OpenClaw + Aurum
Generated: 2026-04-07

---

## Overview

Two separate systems live on this machine:

| System | Path | Language | Purpose |
|--------|------|----------|---------|
| **OpenClaw** | `/home/aurumbot/openclaw/` | TypeScript (Bun) | Persistent AI agent — Telegram bot powered by Claude |
| **Aurum** | `/home/aurumbot/Aurum/` | Python 3 | Autonomous business engine — runs a digital product company |

They are related but independent. OpenClaw monitors Aurum's state and can notify you via Telegram when something needs attention. Aurum runs on cron and does the actual content/business work.

---

## System 1: OpenClaw

**What it is:** An always-on Telegram bot that routes your messages to one of five specialized AI agents, runs proactive background checks on schedules, and can execute local skills (shell commands, desktop control). Built on Bun + Grammy.js + Anthropic SDK.

**Entry point:** `index.ts` → starts `gateway.ts` (bot) + `heartbeat.ts` (cron jobs)

### Files

#### `gateway.ts` (473 lines)
The Telegram bot. Everything the user types flows through here.

- Auth middleware: every message checked against `TELEGRAM_ALLOWED_IDS` whitelist before processing
- 16 commands implemented: `/start`, `/help`, `/ask`, `/agent`, `/pipeline`, `/skill`, `/confirm`, `/cancel`, `/memory`, `/forget`, `/status`, `/doctor`, `/run`, `/config`, `/desktop`, `/clear`
- Per-user rate limiting: 30 calls/hour, enforced before any AI call, survives bot restarts (SQLite-backed)
- Human-in-the-loop (HITL): any destructive/high-risk action requires explicit `/confirm <token>` before executing
- AI disclosure: first message to any user appends a statement that they are talking to an AI
- Input validation: max 8192 chars, null byte stripping, chat ID format check
- Admin-only commands: `/doctor`, high-risk `/run` calls restricted to `ADMIN_IDS`

#### `brain.ts` (143 lines)
The Anthropic API layer. Called when a user message needs a Claude response.

- Loads `soul/SOUL.md`, `soul/IDENTITY.md`, `soul/SECURITY.md` into every system prompt
- Injects SQLite-persisted long-term memories (facts) per user into system prompt
- Wraps all user input in `<user_message>` XML tags (prompt injection protection)
- 30-second AbortController timeout on every API call
- Extracts `[REMEMBER: fact]` tags from Claude responses and saves them to SQLite
- Tracks whether each user has received AI disclosure; sends it once on first response
- Model: uses whatever `ANTHROPIC_API_KEY` is set in `.env`

#### `orchestrator.ts` (252 lines)
Multi-agent router and pipeline engine.

**Five agents registered:**
- `seo-specialist` — SEO audits, keyword research, meta tags, competitor analysis
- `ops-manager` — Business reports, task routing, pipeline status, operations
- `content-writer` — Blog posts, social threads, ebook chapters, email campaigns
- `customer-support` — Support tickets, FAQ responses, complaint handling
- `devops` — System health, crash recovery, log analysis, infrastructure

**Routing (two-stage):**
1. Keyword matching against each agent's bank (no LLM cost for obvious queries)
2. If no keyword match → Haiku classifies which agent best fits the message
3. Falls back to general brain.ts if still ambiguous

**Per-agent isolation:** Each agent has its own conversation history in SQLite keyed by `chatId:agentSlug`. Asking the SEO agent a question does not pollute the DevOps agent's context.

**Pre-built pipelines:**
- `blog-post`: SEO Specialist → Content Writer
- `daily-briefing`: Ops Manager → DevOps
- `repurpose`: Content Writer → SEO Specialist

Each agent's system prompt is assembled from: a hardcoded AI disclosure statement + `soul/SOUL.md` + the agent's own `agents/<slug>/SOUL.md`.

#### `heartbeat.ts` (265 lines)
The autonomous monitoring loop. This is what makes OpenClaw proactive rather than reactive. Eight cron checks:

| Schedule | Check | What it does |
|----------|-------|--------------|
| Every 5 min | Service watchdog | Checks if the Aurum `health_server.py` on port 8765 is responding |
| Every 15 min | Aurum bot state | Reads `state.json`, asks Claude if pipeline is stalled or needs intervention |
| Every 30 min | System logs | Reads most recent log file, looks for errors/crashes, notifies if found |
| Every hour | Disk space | Checks disk usage, warns if >85% |
| Hourly :05 | Calendar | (placeholder — reads a calendar file if present) |
| 06:00 daily | Morning briefing | Ops Manager agent composes a daily briefing, sends to owner |
| 09:00 daily | Content opportunities | Content Writer agent generates content ideas for the day |
| 23:00 daily | EOD summary | Ops Manager composes end-of-day summary |

Each check logs to `heartbeat_log` table in SQLite. Notifications only sent if something actually needs attention (result != `"NO_ACTION"`).

#### `security.ts` (234 lines)
Central security enforcement. Every other module imports from here.

- `checkUserRateLimit(chatId)` — SQLite-backed 30/hr limit, returns `{allowed, remaining}`
- `validateMessage(text)` — Length check, null byte strip, empty check
- `wrapUserInput(text)` — Wraps in `<user_message>` XML tags
- `requireConfirmation(chatId, description, risk, payload)` — Creates a 5-minute expiring HITL token stored in SQLite
- `resolveConfirmation(id, chatId)` — Validates token, returns payload if valid
- `cancelAction(id, chatId)` — Removes pending token
- `getSkillRisk(skillName)` — Returns `low | medium | high` risk level for a skill
- `isDesktopControlEnabled(chatId)` — Checks SQLite config table for opt-in flag
- `pruneOldMessages()` — Deletes messages older than 90 days
- `AI_DISCLOSURE` — Standard disclosure text prepended to first interaction

#### `db.ts` (136 lines)
SQLite via `bun:sqlite`. WAL mode for concurrent access. All tables created on startup.

**Tables:**
- `sessions` — chatId, username, first_seen
- `messages` — chatId, role, content, created_at (90-day retention)
- `memories` — chatId, fact, tags, created_at (long-term facts)
- `heartbeat_log` — check_name, result, created_at
- `audit_log` — chatId, command, detail, created_at
- `rate_limit` — chatId, ts (rolling window)
- `pending_actions` — HITL tokens with expiry
- `config` — key-value store per chatId (e.g., desktop_control enabled)
- `disclosures` — tracks which chatIds have received AI disclosure

Graceful close on `SIGTERM`/`SIGINT`.

#### `doctor.ts` (148 lines)
System health checker. Run manually or triggered via `/doctor` command.

Nine checks: env vars set, database writable, soul files present, agents directory present, skills directory present, Anthropic API key set, Grammy package available, rate limit table functional, heartbeat table functional.

Run `bun run doctor.ts --fix` to auto-repair where possible. Exits with code 0 (all pass) or 1 (failures).

#### `skills/shell.js`
Executes shell commands with safety hardening:
- Uses `spawn(argv_array, {shell: false})` — no string interpolation, no shell expansion
- 18 allowed binaries (exact match): `ls`, `cat`, `pwd`, `echo`, `date`, `df`, `free`, `ps`, `top`, `grep`, `find`, `wc`, `head`, `tail`, `git`, `npm`, `bun`, `python3`
- Per-argument blocklist: rejects args containing `..`, `~`, `/etc/`, `/root/`, `rm`, `sudo`, `chmod`, etc.
- All executions logged to audit_log

#### `skills/desktop-control.py`
PyAutoGUI + OpenCV integration for mouse/keyboard automation. Double-gated:
1. Gateway TypeScript checks SQLite config `desktop_control = enabled` for that chatId
2. Python script checks the same SQLite table before any action
- `FAILSAFE = True` (move mouse to corner to abort)
- 1-second pause between actions
- All actions written to audit_log before execution

#### `soul/` directory
- `SOUL.md` — Core behavioral rules: Parse→Reason→Act→Log loop, AI disclosure mandate, prohibitions on autonomous publish/transact/delete
- `IDENTITY.md` — Who OpenClaw is, purpose, values
- `SECURITY.md` — Documents all 22 implemented security controls

#### `agents/<slug>/SOUL.md` (5 files)
Each agent has its own soul file with: role description, keyword bank used for routing, behavioral constraints specific to that agent.

#### `.env`
Contains: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_IDS` (your chat ID), `ANTHROPIC_API_KEY` (blank — add yours).

**OpenClaw startup:**
- `index.ts` — entry point. Writes PID file, then imports `gateway.js` which auto-starts the bot and heartbeat.
- `start.sh --background` — starts in background, logs to `logs/openclaw.log`
- `stop.sh` — kills by PID file
- `openclaw.service` — systemd unit file. Install with `bash install_service.sh` (requires sudo).
- `install_service.sh` — copies service file, enables, starts. Run once on a fresh machine.
- Ollama/local model integration is not wired into the TypeScript side (only in Aurum's Python agents)

---

## System 2: Aurum

**What it is:** An autonomous business execution engine. Five AI agents run on cron, write ebook content, do market research, plan SaaS tech specs, score quality, and report back to you daily. You interact via Telegram or by reading reports. Nothing publishes without your approval.

**Current active business:** Ebooks on autonomous vehicles/robotics (TrailMind series)
**Secondary project:** BookWise — a PDF-to-flashcard SaaS

### Directory Structure

```
/home/aurumbot/Aurum/
├── agents/          # Five Python agents
├── finance/         # revenue_log.csv, expense_log.csv
├── gateway/         # Telegram bot (pure Python, no npm)
├── knowledge/       # business_brain.md
├── logs/            # All agent logs, errors, critic scores
├── outputs/         # Permanent output storage
│   ├── bookwise/    # Vera's SaaS specs
│   ├── ebooks/      # Nova's chapter drafts (permanent copy)
│   ├── linkedin/    # Nova's LinkedIn posts
│   ├── listings/    # Nova's Gumroad listings
│   ├── market/      # Griffin's market scout reports
│   └── research/    # Griffin's chapter research
├── queue/
│   ├── REVIEW/      # Files waiting for your approval
│   └── PUBLISH/     # Approved files ready to go live
├── reports/         # Atlas's daily reports
├── voice/           # master_voice.md — Rhitik's writing voice
├── watchdog/        # Raspberry Pi monitor
├── health_server.py # HTTP health endpoint on port 8765
└── state.json       # Master system state
```

### `state.json`
The central state file. All agents read and write it. Key fields:
- `ebook_current_title` — which book is actively being written
- `ebook_chapter_index` — which chapter Nova writes next (auto-increments)
- `ebook_chapters` — chapter list per book (currently only TrailMind has chapters defined)
- `ebook_titles` — 8 books queued (TrailMind through The Offroad Autonomy Stack)
- `bookwise_task_queue` — 7 SaaS tasks for Vera to work through
- `bookwise_queue_index` — which task Vera picks up next
- `tasks_completed_today` — reset every night by Atlas
- `flags_for_rhitik` — max 3 items, calm tone, with next actions
- `agent_controls` — enable/disable each agent without touching crontab

### Agents

#### `agents/nova.py` (276 lines) — CMO
Writes all content. The only agent that calls the Claude API.

**Three modes:**
- `chapter` — writes a full ebook chapter (800+ words) for the current book/chapter index
- `listing` — writes a Gumroad product listing (tagline, description, bullet points, price)
- `linkedin` — writes a LinkedIn post (no emojis, no "excited to share", soft CTA)

**Quality loop:**
1. Calls Claude API via `urllib` (model: `claude-sonnet-4-20250514`)
2. Runs critic check via `ollama mistral` (locally)
3. If rejected → rewrites once (second Claude call)
4. If rejected again → flags in `state.json` for Rhitik, saves anyway
5. Saves to `queue/REVIEW/` (always) + `outputs/<type>/` (permanent copy)
6. Advances `ebook_chapter_index` in state after writing a chapter

**Guardrails hard-coded:**
- Never publishes autonomously
- Never contacts real people
- Never makes financial transactions
- All output to `queue/REVIEW` only

#### `agents/vera.py` (156 lines) — CTO
Writes technical specs for the BookWise SaaS product.

- Reads `bookwise_task_queue[bookwise_queue_index]` from state
- Calls `ollama deepseek-coder` via subprocess
- Falls back to a structured placeholder spec if ollama is unavailable
- Advances `bookwise_queue_index` after each task
- Saves to `outputs/bookwise/`

Currently 7 tasks queued: landing page copy, React component map, FastAPI endpoint spec, database schema, pricing strategy, onboarding flow, support documentation.

#### `agents/griffin.py` (213 lines) — CSO
Contrarian strategic analyst. Applies Burry/Templeton/Klarman/Eisman lenses.

**Two modes:**
- `research` — 3 non-obvious bullet insights on the current chapter topic (for Nova to reference)
- `market_scout` — full competitive intelligence report: 5 competitors, pricing gap, title recommendation, missing angle, strategic priority

Uses `ollama llama3`. Has detailed hardcoded fallback outputs if ollama is unavailable (not empty stubs — real useful content).

Saves to `outputs/research/` and `outputs/market/`.

#### `agents/atlas.py` (251 lines) — COO
The chief of staff. Handles all notifications and reporting. No AI model — pure logic.

**Two modes:**
- `briefing` — 3-line Pushover push at 06:00: tasks done, queue count, weekly revenue
- `report` — full daily report written to `reports/YYYY-MM-DD_report.md`:
  - What ran today
  - Files produced
  - Review queue contents
  - Revenue (weekly + monthly from CSV)
  - Flags (max 3)
  - Book progress (chapter X of Y, percentage)
  - Tomorrow's focus
  
After writing the report: resets `tasks_completed_today` and `flags_for_rhitik` in state. Sends an evening Pushover push.

Uses `urllib` only (no external HTTP library). Reads `PUSHOVER_TOKEN` and `PUSHOVER_USER` from env.

#### `agents/critic.py` (143 lines) — Board Advisor
Quality gate. Called by Nova after generating content. Never calls Claude API.

- Uses `ollama mistral` exclusively
- Scores three dimensions each 1-10: `PUBLISH_QUALITY`, `VOICE_CONSISTENCY`, `COMPLETENESS`
- Threshold: 7/10 on all three to approve
- Returns `(approved: bool, response: str)`
- Logs every score to dated `logs/YYYY-MM-DD_critic.md`
- Fallbacks for: ollama not installed, empty response, timeout — all auto-approve with a note

Can also be called standalone: `python3 critic.py <file_path> [task_type]`

#### `agents/improver.py` (132 lines) — Monthly Optimizer
Runs on the 1st of each month at 03:00.

- Reads last 30 days of critic logs
- Reads top 10 revenue rows
- Loops all 5 agents, asks `ollama llama3` for one specific, concrete improvement each
- Writes a dated report to `logs/YYYY-MM-DD_improver.md`
- Output format per agent: IMPROVEMENT paragraph + REVISED PROMPT ADDITION (text to add to that agent's system prompt)

Operators action required: if a good improvement is suggested, you manually add it to the agent's code.

### `gateway/aurum_gateway.py` (253 lines)
Pure Python Telegram bot (no npm, no grammy, no external packages). Long-polling.

**Five commands:**
- `/approve <filename>` — moves file from `queue/REVIEW/` to `queue/PUBLISH/`
- `/queue` — lists all files waiting in `queue/REVIEW/`
- `/status` — returns today's report (or most recent if today's not yet generated)
- `/revenue` — returns week and month totals computed live from `revenue_log.csv`
- `/health` — returns summary from `state.json` (system name, last run, book, chapter, agent status)

All commands logged to dated `logs/YYYY-MM-DD_gateway.md`. Unauthorized chat IDs receive "Unauthorized." and nothing else. Auth via `TELEGRAM_ALLOWED_IDS` env var.

### `health_server.py` (62 lines)
Lightweight HTTP server on port 8765. `GET /health` returns JSON payload from `state.json`:
```json
{
  "status": "ok",
  "system": "Aurum",
  "timestamp": "...",
  "build_step": true,
  "last_run": "...",
  "active_business": "ebooks",
  "chapter_index": 0,
  "revenue_this_month": 0
}
```
Returns 500 with error detail if `state.json` is unreadable. Default request logging suppressed.

### `watchdog/watchdog.py` (114 lines)
Designed to run on a Raspberry Pi, not this machine.

- Pings `GET /health` on port 8765 every 15 minutes
- 1 failure: logged, no alert
- 2 consecutive failures (30 min down): sends Pushover emergency alert with IP, failure count, timestamp, SSH hint
- Logs all pings to `watchdog_log.csv`

Config in `watchdog_config.json` (template, needs real values). Full deployment README included.

### `knowledge/business_brain.md`
~1700 chars. Business principles injected into Nova and Vera system prompts:
- Pricing psychology (value anchoring, $19-$49 ebook range)
- Distribution strategy (Gumroad first, then own site)
- Capital efficiency rules (no spend without revenue signal)
- Moat thinking (niche technical authority)
- LLC/finance rules (Mercury bank, Stripe/Gumroad, no personal account mixing)

### `voice/master_voice.md`
~1900 chars. Rhitik's writing voice guide:
- Direct, specific, technical. No hype. No filler.
- Cognitive profile section (autistic, ADHD, anxiety) with system protection rules
- Max 3 flags per day, calm tone, never pressuring
- Defines what "voice match" means for the Critic to score against

### `finance/`
- `revenue_log.csv` — headers: `date,product,platform,amount,source`
- `expense_log.csv` — headers: `date,item,amount,category,tax_deductible`

Both currently empty (pre-revenue). Atlas and Griffin read revenue_log.csv. Manual data entry required.

### Crontab (9 entries installed)
```
06:00 daily    atlas briefing       → Morning Pushover push
08:00 daily    nova chapter         → Write next ebook chapter
09:00 daily    griffin research     → Research insights for chapter
10:00 daily    vera                 → Write next BookWise tech spec
11:00 daily    nova listing         → Write Gumroad listing
14:00 daily    nova linkedin        → Write LinkedIn post
18:00 daily    atlas report         → Full daily report + evening push
10:00 Sunday   griffin market_scout → Weekly competitive analysis
03:00 1st/mo   improver             → Monthly agent optimization
```

---

## What Is NOT Built / Gaps

### OpenClaw gaps
1. **No `ANTHROPIC_API_KEY` set** in `.env` — Claude responses disabled until you add it.
2. **No ollama integration** in TypeScript — local models only available to Aurum's Python agents.
3. **Systemd requires sudo** — run `bash install_service.sh` once you have sudo access or ask your sysadmin.

### Aurum gaps
1. **No startup scripts** — Components 18 (`launch/aurum_startup.sh`, `launch/aurum_check.sh`) were not written.
2. **No `.env` file** — Component 19 not completed. `ANTHROPIC_API_KEY`, `PUSHOVER_TOKEN`, `PUSHOVER_USER` not written to `Aurum/.env`.
3. **No `~/.bashrc` source** — env vars not available to cron jobs without explicit env in each cron entry.
4. **Ollama not installed** — All three local model agents (`vera`, `griffin`, `critic`) fall back to hardcoded outputs. Download requires curl (not on this machine).
5. **No `queue/REVIEW/`, `queue/PUBLISH/`, `logs/`, `reports/`, `outputs/` directories confirmed** — Some may not exist, which would crash agents on first run.
6. **`ebook_chapters` only has TrailMind** — The other 7 books have no chapter lists defined in `state.json`. Nova would write "Introduction" for all of them.
7. **No final integration test** — Component 20 (the `python3` assertion script + `logs/build_complete.md`) not run.
8. **Revenue and expense logs are empty** — Atlas revenue reports will show $0.00 until you log sales.
9. **`watchdog_config.json` has placeholder values** — Needs real ThinkPad IP + Pushover keys before deploying to Pi.
10. **Gumroad/Stripe not integrated** — Revenue logging is manual CSV entry.
11. **BookWise has no code** — Vera writes specs, but the actual SaaS product does not exist yet.

### Infrastructure gaps
- **pip not on PATH** — Installed to `~/.local/bin/pip` but `~/.bashrc` does not export this.
- **`anthropic` Python package installed** but `schedule` package may not be confirmed.
- **No `ANTHROPIC_API_KEY` anywhere** — Both systems require it and it is blank in both `.env` files.

---

## Quick Status Summary

| Component | Status |
|-----------|--------|
| OpenClaw index.ts (entry point) | Built |
| OpenClaw gateway.ts | Built |
| OpenClaw brain.ts | Built, needs API key |
| OpenClaw orchestrator.ts | Built |
| OpenClaw heartbeat.ts | Built, paths corrected |
| OpenClaw security.ts | Built |
| OpenClaw db.ts | Built |
| OpenClaw doctor.ts | Built (9/9 pass) |
| OpenClaw shell skill | Built |
| OpenClaw desktop skill | Built |
| OpenClaw agent souls (5) | Built |
| OpenClaw start/stop scripts | Built |
| OpenClaw systemd service | Built (sudo to install) |
| Aurum nova.py | Built |
| Aurum vera.py | Built |
| Aurum griffin.py | Built |
| Aurum atlas.py | Built |
| Aurum critic.py | Built |
| Aurum improver.py | Built |
| Aurum gateway (Telegram) | Built |
| Aurum health_server.py | Built |
| Aurum watchdog | Built (needs config) |
| Aurum crontab | Installed (9 entries) |
| Aurum state.json | Built |
| Aurum voice + brain docs | Built |
| Aurum finance CSVs | Built (empty) |
| Aurum .env | NOT BUILT |
| Aurum startup scripts | NOT BUILT |
| Aurum directory structure | PARTIALLY (logs/ etc. may be missing) |
| Aurum final integration test | NOT RUN |
| Ollama installed | NO |
| pip on PATH | Partial (~/.local/bin) |
