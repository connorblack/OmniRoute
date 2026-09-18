/**
 * Production incident 2026-09-17 (ollama-cloud / combo pool/rag-long):
 * OmniRoute's OWN request-queue limits surfaced as HTTP 502 `server_error`, so the
 * resilience layer counted them as upstream provider failures — model lockout
 * escalating 3s → 96s, then `Circuit breaker OPEN for ollama-cloud`, then
 * `503 all targets were skipped by pre-dispatch filters` for real client traffic.
 *
 * Root cause: `runNonStreamingProviderLeg`'s catch is a SECOND classification path
 * next to chatCore's streaming catch, and it never consulted the local-limiter
 * provenance — it hard-defaulted every non-abort throw to 502 with no `errorCode`,
 * which is exactly the shape every downstream resilience gate reads.
 *
 * These tests drive the REAL `withRateLimit` (Bottleneck, no mocks) to mint the real
 * branded errors, push them through the real leg, and assert the real public gates:
 *   - `isComboRequestScopedFailure` / `shouldRecordProviderBreakerFailure` (breaker)
 *   - `shouldSkipConnDisable` (connection cooldown + model lockout via
 *     `markAccountUnavailable`)
 *   - `getProviderBreakerState` (no recorded failure)
 * Same seam `tests/unit/combo/combo-target-timeout-standards.test.ts` uses for the
 * already-correct `combo_target_timeout` local timer.
 */
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-local-limit-class-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "local-limit-classification-secret";

const rateLimitManager = await import("../../open-sse/services/rateLimitManager.ts");
const { __setProviderDefaultRateLimitsForTests } =
  await import("../../open-sse/services/providerDefaultRateLimit.ts");
const {
  getTrustedLocalRateLimitError,
  getTrustedLocalRateLimitResponse,
  LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
  RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
} = await import("../../open-sse/services/rateLimitManager/errors.ts");
const { runNonStreamingProviderLeg } =
  await import("../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts");
const { isComboRequestScopedFailure, shouldRecordProviderBreakerFailure, shouldSkipConnDisable } =
  await import("../../open-sse/services/combo/comboPredicates.ts");
const { getProviderBreakerState, recordProviderFailure } =
  await import("../../open-sse/services/accountFallback.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const resilienceSettings = await import("../../src/lib/resilience/settings.ts");

const PROVIDER = "ollama-cloud";
const MODEL = "deepseek-v4.1-flash";

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  resetAllCircuitBreakers();
  await rateLimitManager.__resetRateLimitManagerForTests();
  __setProviderDefaultRateLimitsForTests(null);
});

afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  __setProviderDefaultRateLimitsForTests(null);
  resetAllCircuitBreakers();
});

/** Run one provider leg whose wire send throws `error` — the production shape. */
async function legFor(error: unknown) {
  const result = await runNonStreamingProviderLeg({
    phase: "initial",
    sourceBody: { messages: [{ role: "user", content: "ping" }] },
    allowAccountRotation: true,
    allowModelFallback: true,
    provider: PROVIDER,
    model: MODEL,
    effectiveModel: MODEL,
    connectionId: "conn-local-limit",
    executeProviderRequest: async () => {
      throw error;
    },
    setRequestWireState: noop,
    log,
  });
  assert.equal(result.kind, "error", "a thrown wire send must produce an error leg result");
  return result.result;
}

/**
 * The exact composition the combo attempt loop applies to a failed target
 * (`executeTargetAttempt.ts` → `isScopedFailure` → `shouldRecordProviderBreakerFailure`).
 */
function comboGates(result: {
  status: number;
  error?: string;
  errorCode?: string;
  errorType?: string;
  response: Response;
}) {
  const structuredError = { code: result.errorCode, type: result.errorType };
  const requestScopedFailure = isComboRequestScopedFailure(
    result.response,
    result.error || "",
    structuredError
  );
  return {
    requestScopedFailure,
    recordsBreakerFailure: shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: result.status,
      sameProviderNext: false,
      requestScopedFailure,
      error: result.error,
    }),
    // `shouldSkipConnDisable` is the gate src/sse/handlers/chat.ts consults before
    // calling markAccountUnavailable() (connection cooldown + model lockout).
    skipsConnectionCooldown: shouldSkipConnDisable(result, false, false, PROVIDER),
  };
}

/** Mint the real queue-budget rejection: concurrency 1, second job has a tiny budget. */
async function realQueueBudgetError(): Promise<unknown> {
  const conn = "queue-budget-conn";
  rateLimitManager.enableRateLimitProtection(conn);
  rateLimitManager.refreshConnectionRateLimits(conn, { maxConcurrent: 1 });

  const occupied = rateLimitManager.withRateLimit(
    PROVIDER,
    conn,
    MODEL,
    () => new Promise((resolve) => setTimeout(() => resolve("first"), 250)),
    null,
    5_000
  );
  await wait(20);

  let caught: unknown;
  try {
    await rateLimitManager.withRateLimit(
      PROVIDER,
      conn,
      MODEL,
      async () => "second",
      null,
      30 // remaining queue budget — expires while queued behind the first job
    );
    assert.fail("second concurrent job must hit the queue budget");
  } catch (error) {
    caught = error;
  }
  await occupied.catch(() => {});
  await wait(40);
  return caught;
}

/** Mint the real Bottleneck execution-expiration rejection. */
async function realExecutionExpiryError(): Promise<unknown> {
  const conn = "execution-expiry-conn";
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    executionMaxWaitMs: 40,
  });
  rateLimitManager.enableRateLimitProtection(conn);

  try {
    await rateLimitManager.withRateLimit(
      PROVIDER,
      conn,
      MODEL,
      () => wait(400).then(() => "never"),
      null,
      5_000
    );
    assert.fail("the job must exceed the execution expiration");
  } catch (error) {
    return error;
  }
}

test("queue-budget rejection is a 503 local limit, never a provider failure", async () => {
  const queueError = await realQueueBudgetError();
  assert.equal(
    getTrustedLocalRateLimitError(queueError)?.code,
    LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
    "withRateLimit must brand its own queue-budget rejection"
  );

  const result = await legFor(queueError);

  assert.equal(result.status, 503, "OmniRoute's queue budget maps to 503, not the 502 default");
  assert.equal(result.errorCode, LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE);
  assert.ok(
    getTrustedLocalRateLimitResponse(result.response),
    "the leg's error response must carry local-limiter provenance for the combo loop"
  );

  const gates = comboGates(result);
  assert.equal(gates.requestScopedFailure, true, "must be request-scoped inside the combo loop");
  assert.equal(gates.recordsBreakerFailure, false, "must not trip the provider circuit breaker");
  assert.equal(
    gates.skipsConnectionCooldown,
    true,
    "must not cool the connection / lock the model"
  );
  assert.equal(
    getProviderBreakerState(PROVIDER)?.failureCount ?? 0,
    0,
    "no provider breaker failure may be recorded for our own backpressure"
  );
});

test("execution-expiration rejection is a 504 local limit, never a provider failure", async () => {
  const executionError = await realExecutionExpiryError();
  assert.equal(
    getTrustedLocalRateLimitError(executionError)?.code,
    RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
    "withRateLimit must brand its own execution-expiration rejection"
  );

  const result = await legFor(executionError);

  assert.equal(result.status, 504, "the local execution backstop maps to 504, not 502");
  assert.equal(result.errorCode, RATE_LIMIT_EXECUTION_TIMEOUT_CODE);
  assert.ok(getTrustedLocalRateLimitResponse(result.response));

  const gates = comboGates(result);
  assert.equal(gates.requestScopedFailure, true);
  assert.equal(gates.recordsBreakerFailure, false);
  assert.equal(gates.skipsConnectionCooldown, true);
  assert.equal(getProviderBreakerState(PROVIDER)?.failureCount ?? 0, 0);
});

test("code-only local-limit error is still classified when WeakMap provenance is missing", async () => {
  // Defensive fallback: an OmniRoute local-limit code with no WeakMap entry (a
  // duplicated module instance, a re-thrown copy, an IPC hop) must still be
  // classified as ours rather than falling through to the 502 provider default.
  const orphaned = Object.assign(new Error("Request exceeded queue budget maxWaitMs=15000ms"), {
    code: LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
  });
  assert.equal(
    getTrustedLocalRateLimitError(orphaned),
    null,
    "fixture must not carry trusted WeakMap provenance"
  );

  const result = await legFor(orphaned);
  assert.equal(result.status, 503);
  assert.equal(result.errorCode, LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE);

  const gates = comboGates(result);
  assert.equal(gates.requestScopedFailure, true);
  assert.equal(gates.recordsBreakerFailure, false);
  assert.equal(gates.skipsConnectionCooldown, true);
});

test("a genuine upstream fetch failure still counts as a provider failure", async () => {
  // Guard rail: the fix must not blanket-exempt 5xx throws. An ordinary transport
  // error keeps the 502 default and keeps feeding the breaker.
  const result = await legFor(new Error("fetch failed"));

  assert.equal(result.status, 502);
  const gates = comboGates(result);
  assert.equal(gates.requestScopedFailure, false);
  assert.equal(gates.recordsBreakerFailure, true);
  assert.equal(gates.skipsConnectionCooldown, false);

  recordProviderFailure(PROVIDER, log, "conn-local-limit", null);
  assert.ok((getProviderBreakerState(PROVIDER)?.failureCount ?? 0) >= 1);
});
