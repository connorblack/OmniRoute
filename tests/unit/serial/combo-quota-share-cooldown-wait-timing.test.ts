/**
 * tests/unit/serial/combo-quota-share-cooldown-wait-timing.test.ts
 *
 * Extracted from tests/unit/combo-quota-share-cooldown-wait.test.ts (#6803).
 *
 * The quota_exhausted scenario below asserts a wall-clock ceiling
 * (`elapsed < 10000`) around a handleComboChat() call that also performs real
 * SQLite I/O (test.beforeEach does fs.rmSync+fs.mkdirSync +
 * core.resetDbInstance()). Under CI-runner CPU/IO contention (multiple
 * concurrent sibling shard jobs) this ceiling can be exceeded even though the
 * functional behavior (no wait, single dispatch) is correct — this is a "did
 * NOT wait out a cooldown" ceiling, not a behavior-under-test assertion, so it
 * is timing-sensitive by nature.
 *
 * Running these in tests/unit/serial/ (--test-concurrency=1, see
 * package.json's test:unit:serial) removes the intra-suite parallelism that
 * was the dominant source of contention, matching the repo's established
 * remedy pattern for this class of test.
 *
 * The non-quota-share (priority) scenario was UPDATED for the "universal
 * cooldown-aware retry" change: comboCooldownWait is no longer gated on
 * `strategy === "quota-share"` — every combo strategy now waits out a SHORT
 * transient 429 and re-dispatches via the same resolveComboCooldownWaitDecision
 * path (real model-lockout reason + allow-list). It used to assert the
 * OPPOSITE (immediate propagation, no wait) — that assertion is now testing
 * dead behavior, so it was rewritten to assert the new intended behavior
 * instead of being deleted or weakened.
 *
 * Locks come from AUTH, as in production: the single-model stub
 * (tests/unit/_helpers/authBackedComboHandler.ts) records each upstream failure
 * through markAccountUnavailable against the connection that served it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-combo-cooldown-wait-timing-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-combo-cooldown-wait-timing-secret";

const core = await import("../../../src/lib/db/core.ts");
const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { clearAllModelLockouts, getModelLockoutInfo } =
  await import("../../../open-sse/services/accountFallback.ts");
const { authBackedHandler, okResponse, rateLimitResponse } =
  await import("../_helpers/authBackedComboHandler.ts");

function createLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

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

test("quota-share: 403 quota_exhausted → NO wait, error propagated immediately", async () => {
  const auth = await authBackedHandler(["openai"], () =>
    rateLimitResponse(RETRY_AFTER_MS, { status: 403 })
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

  assert.notEqual(res.status, 200, "quota_exhausted must not be retried into a success");
  // The real signal that the cooldown wait did NOT fire: a single upstream
  // dispatch (no redispatch).
  assert.equal(auth.dispatches.length, 1, "quota_exhausted must NOT trigger a wait+redispatch");
  // Widened from 1500ms (#6803): the primary signal is the single dispatch
  // above; this ceiling is a secondary sanity check that we didn't wait out a
  // real quota_exhausted lock, generous enough for CI-runner contention.
  assert.ok(
    elapsed < 10000,
    `quota_exhausted must not wait out a cooldown, but ${elapsed}ms elapsed`
  );
});

test("non quota-share (priority): short 429 cooldown → waits and re-dispatches (2nd pass 200)", async () => {
  // Exercises the shared resolveComboCooldownWaitDecision path with the lock
  // reason AUTH recorded.
  const auth = await authBackedHandler(["openai"], (_modelStr, callsForModel) =>
    callsForModel === 1 ? rateLimitResponse(RETRY_AFTER_MS) : okResponse()
  );

  const startedAt = Date.now();
  const res = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: { ...comboOf("priority"), name: "priority-combo" },
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 200, "expected the retried dispatch to succeed with 200");
  assert.equal(auth.upstreamCalls.length, 2, "expected exactly one wait+redispatch");
  assert.ok(
    elapsed >= RETRY_AFTER_MS - 50,
    `expected to have waited out the cooldown, only ${elapsed}ms elapsed`
  );
});

test("non quota-share (priority): a quota_exhausted lock drives the decision with a SHORT wait → NO wait (the reason allow-list is the PRIMARY barrier; the maxWaitMs ceiling does NOT cover this)", async () => {
  // THE regression guard for the two-barrier policy documented in
  // comboCooldownRetry.ts ("SECURITY — quota_exhausted must be excluded" /
  // "The small maxWaitMs ceiling is the second barrier").
  //
  // Barrier 1 = the reason allow-list. Barrier 2 = the maxWaitMs ceiling.
  // This scenario is engineered so ONLY barrier 1 can stop the wait:
  //   - AUTH persists the openai 429 as connection state, so it contributes a
  //     retry-after hint (opens the cooldown-wait decision) WITHOUT a
  //     competing model lock.
  //   - The Gemini 429 names a spent quota, so AUTH records the only model
  //     lock in play: `quota_exhausted`, shortened to the upstream hint. It is
  //     the lock resolveComboCooldownWaitDecision picks.
  //   - The resulting wait is SHORT (well under maxWaitMs=5000), so barrier 2
  //     lets it through. Only the allow-list can reject it.
  const QUOTA_RETRY_AFTER_MS = 1500;
  const auth = await authBackedHandler(
    ["openai", "gemini"],
    (modelStr) =>
      modelStr === "openai/gpt-4"
        ? rateLimitResponse(RETRY_AFTER_MS)
        : rateLimitResponse(QUOTA_RETRY_AFTER_MS, {
            message: "Quota exceeded for quota metric 'Generate Content API requests per day'",
          }),
    (modelStr) => ({ persistUnavailableState: modelStr === "openai/gpt-4" })
  );

  const res = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: {
      name: "priority-quota-exhausted-short-wait",
      strategy: "priority",
      models: ["openai/gpt-4", "gemini/gemini-2.5-flash"],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0, maxSetRetries: 0 },
    },
    handleSingleModel: auth.handleSingleModel,
    isModelAvailable: async () => true,
    log: createLog() as never,
    settings: shortModelLockoutSettings(),
    allCombos: null,
  });

  const openaiLock = getModelLockoutInfo("openai", auth.connectionIds.get("openai")!, "gpt-4");
  const geminiLock = getModelLockoutInfo(
    "gemini",
    auth.connectionIds.get("gemini")!,
    "gemini-2.5-flash"
  );
  assert.equal(openaiLock, null, "the openai 429 must not compete with a model lock");
  assert.equal(geminiLock?.reason, "quota_exhausted");
  assert.ok(
    (geminiLock?.remainingMs ?? Infinity) < 5000,
    "the quota_exhausted lock is short enough to pass the maxWaitMs ceiling"
  );
  assert.notEqual(res.status, 200, "a quota_exhausted lock must not be waited into a success");
  // Deterministic proof (no wall-clock dependency): each target is dispatched
  // EXACTLY ONCE. Had the wait fired, the whole set loop would re-run.
  assert.deepEqual(
    auth.dispatches,
    ["openai/gpt-4", "gemini/gemini-2.5-flash"],
    "a quota_exhausted lock must NOT trigger a wait+redispatch, even when the wait would be short enough to clear the maxWaitMs ceiling"
  );
});

test("non quota-share (priority) with comboCooldownWait disabled → 429 propagated, NO wait", async () => {
  const auth = await authBackedHandler(["openai"], () => rateLimitResponse(RETRY_AFTER_MS));

  const res = await handleComboChat({
    body: { model: "openai/gpt-4" },
    combo: { ...comboOf("priority"), name: "priority-combo-disabled" },
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
});
