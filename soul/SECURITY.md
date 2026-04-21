# SECURITY.md — Implemented Controls

## Authentication
- Telegram chat ID whitelist enforced (TELEGRAM_ALLOWED_IDS required — bot exits if unset)
- Admin-only commands: /doctor, /run high-risk, /enable-desktop-control
- All unauthorized access attempts logged

## Input Security
- Max message length: 8,192 characters
- Max skill args: 10,000 characters
- Null bytes stripped from all input
- Prompt injection protection: user input wrapped in XML tags before LLM
- Chat ID validated as numeric (no path traversal via chat ID)
- Shell skill uses argument arrays, never shell=True (no shell injection)

## Rate Limiting
- Per-user: 30 API calls per hour (SQLite-backed, survives restarts)
- API call timeout: 30 seconds

## Human-in-the-Loop (HITL)
High-risk and critical actions require explicit /confirm <id>:
- Running "high" risk skills (shell, desktop-control)
- Enabling desktop control
- Deleting conversation history
- Any financial/publishing/destructive action

HITL tokens expire after 5 minutes.

## Data Privacy
- Conversation history: auto-purged after 90 days
- Memories: user-clearable via /forget
- History: user-deletable via /delete-history + confirm
- No user data shared between chat sessions
- Audit log: all commands recorded (no secrets in log entries)

## Secret Protection
- .env excluded from git (.gitignore)
- data/ and *.db excluded from git
- Secrets never returned to users in error messages
- Error responses use opaque reference IDs (not stack traces)
- Shell skill args checked against sensitive path patterns

## Desktop Control
- Disabled by default
- Requires: admin status + /enable-desktop-control + /confirm
- Enforced at both gateway and skill level (belt + suspenders)
- All actions audited to SQLite
- PyAutoGUI FAILSAFE=True (move to top-left corner to abort)
- 1-second minimum between actions (human-speed)
- Max text input: 500 chars; max scroll: 10 clicks; max hotkey: 4 keys

## Auth Attempt Tracking (NEW)
- Unauthorized access attempts are counted per chat_id in SQLite
- After 5 failures within 15 minutes: temporary block (15 min)
- Auth failure counter reset on first successful authorization

## Preemptive Security Principles

### Assume Hostile Input
Every message from Telegram is treated as potentially adversarial until:
1. Chat ID is in ALLOWED_IDS
2. Message passes length and null-byte checks
3. Input is wrapped in XML tags before any LLM call

No "trusted" user message is passed raw to the model.

### Defense in Depth
Security is enforced at multiple layers:
- Gateway: auth, rate limit, input validation
- Security module: HITL, confirmation tokens
- Brain: XML tag wrapping prevents delimiter injection
- Soul files: ethical constraints baked into every prompt
- Skill layer: per-skill risk classification + arg validation

### Minimal Exposure
- No stack traces to users (opaque error IDs only)
- No credential values in any log, reply, or error message
- No PII stored beyond what is necessary for session continuity

### Audit Everything
- Every command → audit.md
- Every security event → security.md
- Every HITL action → SQLite pending_actions with chat_id

### Fail Closed
- If TELEGRAM_BOT_TOKEN missing → process.exit(1)
- If ALLOWED_IDS missing → process.exit(1)
- If skill not in risk map → default "medium" (requires HITL)
- If confirmation expired → abort, do not execute

## What Is Always Blocked
- Exposing API keys, tokens, .env contents in any reply
- Running commands not in the shell skill whitelist
- Taking destructive/irreversible actions without confirmation
- Sending messages to chat IDs not in ALLOWED_IDS
- Path traversal in any argument (../)
- Shell=True subprocess execution
- Claiming to be human when directly asked
- Prompt injection attempts ("ignore previous instructions" patterns)
