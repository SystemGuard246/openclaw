/**
 * api-resilience.ts — Circuit breaker + retry for Groq API calls.
 * Wraps client.chat.completions.create() with:
 *   - Configurable timeout via AbortController
 *   - Exponential backoff retry (3 attempts)
 *   - Circuit breaker: CLOSED → DEGRADED (≥5 failures) → OPEN (≥10)
 *   - Auto-recovery: OPEN → CLOSED after 5 minutes of no calls
 */

import OpenAI from "openai";

// ── Circuit breaker state ─────────────────────────────────────────────────────

type CBState = "CLOSED" | "DEGRADED" | "OPEN";

let cbState: CBState = "CLOSED";
let failureCount = 0;
let lastFailureAt = 0;
let openedAt = 0;

const DEGRADED_THRESHOLD = 5;
const OPEN_THRESHOLD = 10;
const RECOVERY_MS = 5 * 60 * 1000; // 5 minutes before attempting recovery

function recordSuccess(): void {
  failureCount = 0;
  if (cbState !== "CLOSED") {
    console.log(`[api-resilience] Circuit breaker recovered → CLOSED`);
    cbState = "CLOSED";
  }
}

function recordFailure(): void {
  failureCount++;
  lastFailureAt = Date.now();
  if (failureCount >= OPEN_THRESHOLD && cbState !== "OPEN") {
    cbState = "OPEN";
    openedAt = Date.now();
    console.error(`[api-resilience] Circuit breaker OPEN — ${failureCount} consecutive failures`);
  } else if (failureCount >= DEGRADED_THRESHOLD && cbState === "CLOSED") {
    cbState = "DEGRADED";
    console.warn(`[api-resilience] Circuit breaker DEGRADED — ${failureCount} failures`);
  }
}

function isCallAllowed(): boolean {
  if (cbState === "CLOSED" || cbState === "DEGRADED") return true;
  // OPEN: allow a probe call after RECOVERY_MS
  if (Date.now() - openedAt >= RECOVERY_MS) {
    cbState = "DEGRADED";
    failureCount = DEGRADED_THRESHOLD;
    console.log(`[api-resilience] Circuit breaker probe allowed (OPEN → DEGRADED)`);
    return true;
  }
  return false;
}

export function getCircuitBreakerState(): { state: CBState; failures: number } {
  return { state: cbState, failures: failureCount };
}

// ── Resilient create wrapper ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function resilientCreate(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<OpenAI.ChatCompletion> {
  if (!isCallAllowed()) {
    throw new Error(`API circuit breaker is OPEN — too many recent failures. Retry in ${Math.ceil((RECOVERY_MS - (Date.now() - openedAt)) / 1000)}s.`);
  }

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await client.chat.completions.create(
        params,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      recordSuccess();
      return response;
    } catch (err: unknown) {
      clearTimeout(timer);
      lastErr = err;

      const isAbort = err instanceof Error && err.name === "AbortError";
      const statusCode = (err as { status?: number }).status ?? 0;
      const isRetryable = isAbort || RETRYABLE_STATUS.has(statusCode);

      if (!isRetryable) {
        recordFailure();
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = 500 * Math.pow(2, attempt - 1); // 500ms, 1000ms
        console.warn(`[api-resilience] Attempt ${attempt}/${MAX_RETRIES} failed (${isAbort ? "timeout" : `HTTP ${statusCode}`}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  recordFailure();
  throw lastErr;
}
