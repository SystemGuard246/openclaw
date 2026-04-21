# OpenClaw — Feature Roadmap

**Current version:** v1.0 (Phases 1-3 complete)  
**Target:** Production-grade autonomous agent OS for founder operations  
**Engineering capacity:** 1 engineer  
**Total remaining:** ~16 weeks to SOTA Level 3

---

## Current State — What's Live Right Now

| Phase | Feature | Status | Notes |
|-------|---------|--------|-------|
| 1 | Gateway + allowlist auth | ✅ Live | Grammy.js, SQLite-backed |
| 1 | Per-user rate limiting (hourly) | ✅ Live | Survives restarts |
| 1 | 14-agent routing (keyword + LLM) | ✅ Live | Zero-cost keyword path first |
| 1 | Pre-built pipelines (blog-post, repurpose) | ✅ Live | Multi-step agent chains |
| 2 | Heartbeat monitoring (8 cron checks) | ✅ Live | Proactive alerts |
| 2 | HITL confirmation (32-byte tokens) | ✅ Live | 5-min TTL |
| 2 | Shell skill + typed ACL | ✅ Live | 18 allowed binaries |
| 2 | Doctor health check | ✅ Live | 9-point diagnostics |
| 3 | Burst rate protection (5/min) | ✅ Live | In-memory sliding window |
| 3 | Per-command rate limits | ✅ Live | agent:20/hr, shell:3/day |
| 3 | Mandate enforcement (8 agents) | ✅ Live | Pre + post execution |
| 3 | Secret scanner | ✅ Live | 8 pattern types |
| 3 | API resilience (circuit breaker) | ✅ Live | CLOSED/DEGRADED/OPEN |
| 3 | Audit logger + /audit command | ✅ Live | SQL-backed, 7-day default |
| 5A | Self-improvement loop (6h cron) | ✅ Live | Auto-commit for safe proposals |
| 5A | Self-reflection journal (JSONL) | ✅ Live | Full reasoning logged |

---

## Phase 4 — Core Execution Engine

**Timeline:** 2-3 weeks  
**Prerequisite:** None (builds on existing pipeline runner)  
**What it unlocks:** Multi-step autonomous workflows that don't require you to babysit each step

### The Problem It Solves

Right now, a pipeline runs agents in a fixed sequence. Real tasks are messier — you need branching, retries, parallel steps, and the ability to pause and resume. Phase 4 turns OpenClaw from a chatbot into a workflow engine.

### Key Components

**DAG-based task planner (`automation/dag-planner.ts`)**
- Marcus decomposes a goal into a directed acyclic graph of subtasks
- Each node: agent, prompt template, dependencies, success criteria
- Persisted to SQLite so workflows survive restarts

**Autonomous coordinator (`automation/coordinator.ts`)**
- Walks the DAG, executes ready nodes in parallel where possible
- Handles retry logic (up to 3 attempts per node)
- Escalates to HITL if a node fails after all retries

**Result tracker (`automation/result-store.ts`)**
- Appends each step's output to `data/workflow-results.jsonl`
- Status: `pending | running | done | failed | blocked`

**Example use case — AV market discovery:**
```
/pipeline discover-av-market "autonomous vehicle logistics startups in Europe"

→ Iris: scan 15 web sources for companies matching ICP
→ Finn: qualify each company against ICP criteria (parallel)  
→ Victor: draft personalized outreach for top 5 (parallel)
→ Marcus: produce ranked briefing + recommended next action
→ [HITL] Send outreach? /confirm token
```

### Success Metrics
- A 4-step pipeline completes end-to-end without manual intervention
- Individual step failure triggers retry, not full pipeline abort
- `/status` shows live workflow progress
- All outputs persisted — no data lost on restart

---

## Phase 5B — Adaptive Planning

**Timeline:** 2 weeks  
**Prerequisite:** Phase 4 (DAG planner must exist)  
**What it unlocks:** The system handles unexpected results by replanning, not failing

### The Problem It Solves

DAGs are brittle — they assume the world matches the plan. If Iris finds zero companies matching the ICP, the pipeline fails. Adaptive planning gives the orchestrator a fallback: analyze what went wrong, generate an alternate plan, and continue.

### Key Components

**Failure analyzer (`automation/failure-analyzer.ts`)**
- Called when a DAG node fails after all retries
- Sends the failure context to Marcus: "step X failed because Y. What should we do next?"
- Returns: `retry_with_modified_prompt | skip_and_continue | replan | escalate_to_human`

**Dynamic replanner (`automation/replanner.ts`)**
- If Marcus says `replan`: generates a new subgraph to replace the failed node
- Uses Monte Carlo Tree Search (MCTS) for decisions with >3 options and >1h stakes
- MCTS implementation: lightweight, ~200 lines, no external dependencies

**Configuration**

```json
{
  "adaptivePlanning": {
    "enabled": true,
    "maxReplanAttempts": 2,
    "escalateAfterMs": 3600000
  }
}
```

### Success Metrics
- Pipeline with one intentionally broken step recovers and completes
- Replan reasoning logged to self-reflection journal
- No replan loops (max 2 attempts before escalation)

---

## SOTA Level 1 — Better Reasoning

**Timeline:** 1 week  
**Prerequisite:** None (model swap, minimal code change)  
**What it unlocks:** 2x better decision quality for complex strategic questions

### The Change

Swap Groq Llama for Claude Opus 4.7 on high-stakes agent calls (Solomon, Marcus, Victor decisions). Keep Groq for routine calls (content writing, SEO, ops).

```typescript
// orchestrator.ts — model routing
function selectModel(agent: AgentDef, messageLength: number): string {
  const highStakesSlugs = ["solomon", "marcus", "victor", "sterling"];
  if (highStakesSlugs.includes(agent.slug) && messageLength > 100) {
    return "claude-opus-4-7";  // Anthropic API
  }
  return "llama-3.3-70b-versatile";  // Groq
}
```

This requires adding `ANTHROPIC_API_KEY` to `.env` and a second API client in `orchestrator.ts`.

### Cost Impact

| Call type | Model | Cost |
|-----------|-------|------|
| Routing/classification | Llama 3.1-8b (Groq) | ~$0 (free tier) |
| Content/SEO/support | Llama 3.3-70b (Groq) | ~$0 (free tier) |
| Strategic/financial | Claude Opus 4.7 | ~$0.015/1K tokens |

At 10 strategic queries/day: ~$2-5/day. Acceptable for founder use.

### Success Metrics
- Solomon gives multi-step strategic answers with explicit confidence labels
- Marcus produces DAGs with 5+ nodes for complex goals
- Victor handles multi-round negotiation roleplays without losing context

---

## SOTA Level 2 — Knowledge Systems

**Timeline:** 2 weeks  
**Prerequisite:** SOTA Level 1 (better base reasoning)  
**What it unlocks:** Agents use real-time data instead of training knowledge cutoffs

### Key Components

**Web search integration (`automation/web-search.ts`)**
- Tavily or Brave Search API (both have free tiers)
- Iris automatically searches before answering trend questions
- Results injected into context with source URLs

**RAG pipeline (`automation/rag.ts`)**
- Index your documents (pitch deck, product specs, past decisions) into SQLite using vector embeddings via [Bun-compatible sqlite-vss](https://github.com/asg017/sqlite-vss)
- Agents retrieve relevant chunks before responding
- Memory now includes document context, not just conversation facts

**Live data connectors (`automation/connectors/`)**
- `github.ts` — PR status, open issues (read-only, no auth tokens stored)
- `calendar.ts` — reads ICS file or Google Calendar (read-only)
- `finance.ts` — reads `data/revenue.csv` for Sterling's context

### Success Metrics
- Iris cites sources in every market intelligence response
- Solomon references your actual pitch deck when coaching on fundraising
- Sterling reads live revenue data, not hardcoded examples

---

## SOTA Level 3 — Explainability

**Timeline:** 1 week  
**Prerequisite:** SOTA Level 2  
**What it unlocks:** Every decision is auditable — ready for investor review or regulatory scrutiny

### Key Components

**Decision logger (`automation/decision-log.ts`)**
- Wraps every agent response: captures the question, retrieved context, reasoning chain, confidence, and final answer
- Stored in `data/decisions.jsonl`
- Format: structured JSON that can be exported to CSV for auditors

**Reasoning chain extractor**
- Ask agents to output `[REASONING: ...]` tags (similar to existing `[REMEMBER: ...]`)
- Stripped from user-facing reply but stored in decision log

**`/explain <decision_id>` command**
- Shows the full reasoning chain for any past decision
- Output: sources used, confidence level, alternative options considered

**Compliance report generator**
- `/compliance-report 30` — Markdown summary of all decisions in 30 days
- Includes: agent used, question category, confidence distribution, HITL escalations

### Success Metrics
- Every decision by Solomon or Marcus has a logged reasoning chain
- `/explain` returns the full context for any decision in the last 30 days
- Compliance report exports cleanly to PDF (via `pandoc`)

---

## Beyond — Research-Grade Self-Evolution

**Not scheduled — depends on Phases 4-5B + SOTA 1-3 being stable.**

These are tracked for awareness, not immediate execution:

| Feature | Value | Effort |
|---------|-------|--------|
| Benchmarking vs. competitors | Know if we're regressing | 2 weeks |
| Adversarial red-teaming (automated) | Find security gaps before attackers do | 3 weeks |
| Multi-agent debate for decisions | Higher-quality strategic answers | 3 weeks |
| Fine-tuned routing model | Eliminate LLM fallback latency entirely | 4 weeks |
| Cross-session learning (federated) | Agents share learnings across sessions | 6 weeks |

---

## Recommended Implementation Order

```
Phase 4 (Execution Engine)    — Weeks 1-3
  ↓ enables multi-step automation
Phase 5B (Adaptive Planning)  — Weeks 4-5
  ↓ makes Phase 4 robust to failures
SOTA Level 1 (Better Models)  — Week 6
  ↓ improves decision quality before adding data
SOTA Level 2 (Knowledge)      — Weeks 7-8
  ↓ agents now have real data + better reasoning
SOTA Level 3 (Explainability) — Week 9
  ↓ everything is auditable

Total: 9 weeks to full SOTA stack
```

**Don't skip the order.** Level 2 (knowledge) on top of weak reasoning (Level 0) wastes good data on bad decisions. Better reasoning (Level 1) first means the knowledge retrieval actually gets used well.

---

## Dependencies

```
Phase 4 ─────────────────────────────────────────► Phase 5B
                                                       │
SOTA L1 ──────────────────────────────────────────────┤
                                                       │
SOTA L2 (needs L1 for quality) ───────────────────────┤
                                                       │
SOTA L3 (needs L2 for data) ──────────────────────────►  Full Stack
```

**Hard dependencies:**
- Phase 5B requires Phase 4 (no DAG = no replanning)
- SOTA L2 requires SOTA L1 (don't waste real data on weak models)
- SOTA L3 requires SOTA L2 (can't explain decisions that don't use sources)

**Soft dependencies (can run in parallel):**
- Phase 5B and SOTA L1 can be developed simultaneously
- SOTA L2 connectors can be built while L1 model swap is being tested

---

## Success Metrics Per Phase

| Phase | Metric | Target |
|-------|--------|--------|
| Phase 4 | 4-step pipeline end-to-end completion rate | > 90% |
| Phase 5B | Failed pipeline recovery rate | > 80% |
| SOTA L1 | Solomon answer quality score (human eval) | > 7/10 |
| SOTA L2 | Iris responses with cited sources | 100% |
| SOTA L3 | Decisions with full reasoning chain logged | 100% |

---

## Team Capacity Estimate (1 Engineer)

| Phase | Weeks | Risk | Notes |
|-------|-------|------|-------|
| Phase 4 | 2-3 | Medium | DAG schema design is the hardest part |
| Phase 5B | 2 | Low | Built on Phase 4 primitives |
| SOTA L1 | 1 | Low | Mostly config + client swap |
| SOTA L2 | 2 | Medium | Web search APIs have rate limits to manage |
| SOTA L3 | 1 | Low | Mostly schema + logging wiring |
| **Total** | **8-9** | | With 1 week buffer built in |

**Estimated total: 10 weeks for full SOTA stack.**  
Buffer for production issues, refactoring, and testing: add 20% = **12 weeks.**
