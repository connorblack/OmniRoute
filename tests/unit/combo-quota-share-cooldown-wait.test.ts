/**
 * TDD (integration) — quota-share combo cooldown-aware retry (Variante A),
 * exercised through handleComboChat.
 *
 * Scenarios (modelled on model-lockout-max-cooldown.test.ts):
 *  1. strategy="quota-share", single connection, model hits a 429 with a SHORT
 *     retry-after → the combo WAITS out the cooldown and re-dispatches; the 2nd
 *     pass (lock expired) returns 200 instead of propagating the 429.
 *  2. A 403 (quota_exhausted, locked until midnight) → NO wait, the 403/429 is
 *     propagated immediately (the helper's critical exclusion).
 *  3. Client abort DURING the wait → 499 "Request aborted".
 *  4. strategy="priority" (and every other strategy) also waits out a SHORT
 *     transient 429 when comboCooldownWait is enabled — same decision helper.
 *  5. comboCooldownWait disabled in settings → unchanged: 429 propagated, no wait.
 *
 * The waits use a real (short) cooldown so the real setTimeout in
 * waitForCooldownAwareRetry elapses fast and the model lock expires naturally.
 * The single-model stub (tests/unit/_helpers/authBackedComboHandler.ts) records
 * locks through AUTH the way chat.ts does. Combo targets stay unpinned, so the
 * wait has to find those locks across the provider's connections.
 *
 * Scenarios 2 and 4 assert a wall-clock ceiling and were extracted to
 * tests/unit/serial/combo-quota-share-cooldown-wait-timing.test.ts (#6803) —
 * see that file's header for why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-combo-cooldown-wait-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-combo-cooldown-wait-secret";

const core = await import("../../src/lib/db/core.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { clearAllModelLockouts, getModelLockoutInfo } =
  await import("../../open-sse/services/accountFallback.ts");
const { authBackedHandler, okResponse, rateLimitResponse, recordAuthFailure } =
  await import("./_helpers/authBackedComboHandler.ts");

function createLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// A short transient cooldown so the real wait is fast but the lock genuinely
// expires between passes.
const BASE_COOLDOWN_MS = 150;
const RETRY_AFTER_MS = 250;

function shortModelLockoutSettings() {
  return {
    modelLockout: {
      enabled: true,
      errorCodes: [403, 429],
      baseCooldownMs: BASE_COOLDOWN_MS,
      maxCooldownMs: 5000,
      maxBackoffSteps: 0,
      useExponentialBackoff: false,
    },
  };
}

function comboOf(strategy: string) {
  return {
    name: `qtSd/${strategy}-${Math.random().toString(16).slice(2, 8)}`,
    strategy,
    models: ["openai/gpt-4"],
    config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0, maxSetRetries: 0 },
  };
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  clearAllModelLockouts();
  await resetStorage();
});

test.after(async () => {
  clearAllModelLockouts();
  try {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
});

test("quota-share: short 429 cooldown → waits and re-dispatches (2nd pass 200)", async () => {
  const auth = await authBackedHandler(["openai"], (_modelStr, callsForModel) =>
    callsForModel === 1 ? rateLimitResponse(RETRY_AFTER_MS) : okResponse()
  );

  const startedAt = Date.now();
  const res = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: comboOf("quota-share"),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 200, "expected the retried dispatch to succeed with 200");
  assert.deepEqual(
    auth.dispatches,
    ["openai/gpt-4", "openai/gpt-4"],
    "expected exactly one wait+redispatch"
  );
  assert.equal(auth.upstreamCalls.length, 2, "the redispatch must reach the upstream");
  assert.ok(
    elapsed >= RETRY_AFTER_MS,
    `expected to have waited out the AUTH lock, only ${elapsed}ms elapsed`
  );
});

// NOTE: "quota-share: 403 quota_exhausted → NO wait" and "non quota-share
// (priority): 429 propagated immediately, NO wait" were extracted to
// tests/unit/serial/combo-quota-share-cooldown-wait-timing.test.ts (#6803) —
// both assert a wall-clock ceiling that flaked under CI-runner load; the
// serial dir (--test-concurrency=1) removes the intra-suite contention that
// caused it.

test("quota-share: client abort during the wait → 499", async () => {
  const controller = new AbortController();
  const auth = await authBackedHandler(["openai"], () => rateLimitResponse(RETRY_AFTER_MS));

  // Abort shortly after the request starts — within the cooldown wait window.
  setTimeout(() => controller.abort(), 50);

  const res = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: comboOf("quota-share"),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
    signal: controller.signal,
  });

  assert.equal(res.status, 499, "abort during the cooldown wait must return 499");
  assert.equal(auth.dispatches.length, 1, "an aborted wait must not re-dispatch");
});

test("quota-share with comboCooldownWait disabled → 429 propagated, NO wait", async () => {
  const auth = await authBackedHandler(["openai"], () => rateLimitResponse(RETRY_AFTER_MS));

  const res = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: comboOf("quota-share"),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: {
      ...shortModelLockoutSettings(),
      resilienceSettings: { comboCooldownWait: { enabled: false } },
    },
    allCombos: null,
  });

  assert.equal(res.status, 429, "disabled feature must propagate the 429 unchanged");
  assert.equal(auth.dispatches.length, 1, "disabled feature must NOT wait+redispatch");
  assert.ok(
    (getModelLockoutInfo("openai", auth.connectionIds.get("openai")!, "gpt-4")?.remainingMs ?? 0) >
      0,
    "the AUTH lock is live, so only the disabled setting skipped the wait"
  );
});

function defaultComboOf(
  models: string[],
  config: { maxRetries: number; maxSetRetries: number; setRetryDelayMs?: number }
) {
  return {
    name: `default-${Math.random().toString(16).slice(2, 8)}`,
    strategy: "auto",
    models,
    config: {
      auto: { explorationRate: 0 },
      retryDelayMs: 0,
      fallbackDelayMs: 0,
      ...config,
    },
  };
}

const MODEL_A = "gemini/gemma-4-31b-it";
const MODEL_B = "gemini/gemma-4-26b-a4b-it";

// #7360: the "default" combo (strategy=auto, two gemma-4 models) was crystallizing
// a 503 "all targets exhausted" ~6s after both targets hit a real Gemini TPM/RPM
// 429 (retry-after ~58s), instead of holding the request and retrying once the
// lower-cooldown target recovered. Mirrors the quota-share scenario above but with
// TWO distinct model targets and two DIFFERENT retry-after hints, to prove the
// combo (a) extends the wait to the "auto" strategy and (b) picks the target with
// the SMALLER remaining cooldown to retry, not just the first one in the list.
test("auto strategy (2 models, both rate-limited) → waits for the SHORTER cooldown, then succeeds", async () => {
  const SHORT_RETRY_AFTER_MS = 200;
  const LONG_RETRY_AFTER_MS = 3000;
  const auth = await authBackedHandler(["gemini"], (modelStr, callsForModel) => {
    if (modelStr === MODEL_A && callsForModel === 1) return rateLimitResponse(SHORT_RETRY_AFTER_MS);
    if (modelStr === MODEL_B) return rateLimitResponse(LONG_RETRY_AFTER_MS);
    return okResponse();
  });

  const startedAt = Date.now();
  const res = await handleComboChat({
    body: { model: "default" },
    combo: defaultComboOf([MODEL_A, MODEL_B], { maxRetries: 0, maxSetRetries: 0 }),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 200, "expected the combo to wait out the shorter cooldown and succeed");
  assert.deepEqual(
    auth.upstreamCalls,
    [MODEL_A, MODEL_B, MODEL_A],
    "should retry the LOWER-cooldown model (A), not wait for B's longer cooldown"
  );
  assert.ok(
    elapsed >= SHORT_RETRY_AFTER_MS,
    `expected to have waited out the shorter cooldown, only ${elapsed}ms elapsed`
  );
  assert.ok(
    elapsed < LONG_RETRY_AFTER_MS,
    `should NOT wait for the longer cooldown (waited ${elapsed}ms, B's cooldown was ${LONG_RETRY_AFTER_MS}ms)`
  );
});

// #7360 follow-up (live incident, log id 1784416706646-51): the test above uses
// maxSetRetries: 0, so it never exercises more than one setTry iteration. The
// real "default" combo config has maxSetRetries: 3 (liveGeminiShared.ts
// DEFAULT_COMBO_CONFIG), so when BOTH targets lock out on setTry 0, every later
// setTry pre-skips both — the loop must still reach the cooldown-aware wait
// instead of crystallizing a bogus "all accounts inactive" 503.
test("auto strategy with maxSetRetries > 0: both targets lock out on the FIRST setTry → still waits and succeeds, not a bogus 503", async () => {
  const SHORT_RETRY_AFTER_MS = 150;
  const auth = await authBackedHandler(["gemini"], (_modelStr, callsForModel) =>
    callsForModel === 1 ? rateLimitResponse(SHORT_RETRY_AFTER_MS) : okResponse()
  );

  const startedAt = Date.now();
  const res = await handleComboChat({
    body: { model: "default" },
    combo: defaultComboOf([MODEL_A, MODEL_B], {
      maxRetries: 0,
      maxSetRetries: 3,
      setRetryDelayMs: 5,
    }),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(
    res.status,
    200,
    `expected the combo to wait out the shared cooldown and succeed, got ${res.status} (${await res.clone().text()})`
  );
  assert.equal(auth.upstreamCalls.length, 3, `got ${JSON.stringify(auth.upstreamCalls)}`);
  assert.ok(
    elapsed >= SHORT_RETRY_AFTER_MS,
    `the set retries alone take ~15ms; ${elapsed}ms means the combo never waited`
  );
});

// Live incident (log id 1784457764961-73): with the REAL "default" combo config
// (maxRetries: 3), a plain RPM-style 429 on the FIRST dispatch enters the
// `retry < maxRetries` branch. When BOTH targets hit this on setTry 0, the loop
// must still record lastStatus and reach the cooldown-aware wait rather than a
// bogus ALL_ACCOUNTS_INACTIVE 503.
test("auto strategy with maxRetries > 0 (matches real 'default' combo config): plain 429 on first dispatch still waits and succeeds, not a bogus 503", async () => {
  const SHORT_RETRY_AFTER_MS = 150;
  const auth = await authBackedHandler(["gemini"], (_modelStr, callsForModel) =>
    callsForModel === 1 ? rateLimitResponse(SHORT_RETRY_AFTER_MS) : okResponse()
  );

  const startedAt = Date.now();
  const res = await handleComboChat({
    body: { model: "default" },
    combo: defaultComboOf([MODEL_A, MODEL_B], {
      maxRetries: 3,
      maxSetRetries: 3,
      setRetryDelayMs: 5,
    }),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(
    res.status,
    200,
    `expected the combo to wait out the shared cooldown and succeed, got ${res.status} (${await res.clone().text()})`
  );
  assert.equal(auth.upstreamCalls.length, 3, `got ${JSON.stringify(auth.upstreamCalls)}`);
  assert.ok(elapsed >= SHORT_RETRY_AFTER_MS, `only ${elapsed}ms elapsed; the combo never waited`);
});

// Live incident (log id 1784457764961-73 follow-up): the pre-dispatch "all
// credentials already cooling down" rejection (buildModelCooldownBody /
// handleNoCredentials) nests its retry hint as `error.retry_after` rather than
// the top-level `retryAfter`. Both models are already locked by AUTH from an
// earlier request, so every first dispatch gets that shape.
test("auto strategy: model_cooldown response shape (nested error.retry_after, not top-level) still waits and succeeds", async () => {
  const SHORT_RETRY_AFTER_MS = 150;
  const startedAt = Date.now();
  const auth = await authBackedHandler(["gemini"], () => okResponse());
  const connectionId = auth.connectionIds.get("gemini")!;
  for (const modelStr of [MODEL_A, MODEL_B]) {
    await recordAuthFailure(connectionId, modelStr, rateLimitResponse(SHORT_RETRY_AFTER_MS));
  }

  const res = await handleComboChat({
    body: { model: "default" },
    combo: defaultComboOf([MODEL_A, MODEL_B], {
      maxRetries: 3,
      maxSetRetries: 3,
      setRetryDelayMs: 5,
    }),
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(
    res.status,
    200,
    `expected the combo to wait out the shared cooldown and succeed, got ${res.status} (${await res.clone().text()})`
  );
  assert.ok(
    auth.dispatches.length >= 3,
    `expected both cooldown answers and a redispatch, got ${JSON.stringify(auth.dispatches)}`
  );
  assert.equal(auth.upstreamCalls.length, 1, "only the post-wait dispatch reaches the upstream");
  assert.ok(elapsed >= SHORT_RETRY_AFTER_MS, `only ${elapsed}ms elapsed; the combo never waited`);
});
