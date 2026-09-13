import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "../../open-sse/services/combo/attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-lock-scope-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "gemini-lock-scope-test-secret";

const fallback = await import("../../open-sse/services/accountFallback.ts");
const { executeTargetAttempt } =
  await import("../../open-sse/services/combo/executeTargetAttempt.ts");
const { dispatchWithCooldownRetry } =
  await import("../../open-sse/services/combo/comboAttemptLoop.ts");
const { evaluateExecuteTargetGates } =
  await import("../../open-sse/services/combo/executeTargetGates.ts");
const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");

function target(connectionId: string, model = "gemini-2.5-pro"): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: connectionId,
    executionKey: connectionId,
    modelStr: `gemini/${model}`,
    provider: "gemini",
    providerId: null,
    connectionId,
    weight: 1,
    label: null,
  };
}

function state(targets: ResolvedComboTarget[]): AttemptLoopState {
  return {
    orderedTargets: targets,
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map(targets.map((_, index) => [index, new AbortController()])),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    observeFailure() {},
  };
}

function deps(
  handleSingleModelWithTimeout: AttemptLoopDeps["handleSingleModelWithTimeout"]
): AttemptLoopDeps {
  return {
    strategy: "priority",
    combo: { name: "gemini-lock-scope", models: [] },
    config: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    settings: {
      modelLockout: {
        enabled: true,
        errorCodes: [429, 503],
        baseCooldownMs: 120_000,
        maxCooldownMs: 1_800_000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    },
    resilienceSettings: {
      providerCooldown: { enabled: false },
    } as AttemptLoopDeps["resilienceSettings"],
    sticky: { targets: [], messageHash: null, stuck: false },
    effectiveSessionId: null,
    preScreenMap: new Map(),
    quotaCutoffResetWindowConfig: {} as AttemptLoopDeps["quotaCutoffResetWindowConfig"],
    maxRetries: 0,
    traceInvocationId: "gemini-lock-scope-attempt",
    clientRequestedStream: false,
    handleSingleModelWithTimeout,
    body: { messages: [{ role: "user", content: "hi" }] },
    startTime: Date.now(),
    releaseStickyPinOnFailure() {},
    clearStaleLKGP() {},
  };
}

async function createGeminiConnection(name: string) {
  return providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    name,
    apiKey: `key-${name}`,
    isActive: true,
    testStatus: "active",
  });
}

test.beforeEach(() => {
  fallback.clearAllModelLockouts();
});

test.after(() => {
  fallback.clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("one Gemini AI Studio 503 locks that model across sibling keys exactly once", async () => {
  const connectionA = await createGeminiConnection("ai-studio-a");
  const connectionB = await createGeminiConnection("ai-studio-b");
  const modelM = "gemini-2.5-pro";
  const modelN = "gemini-2.5-flash";
  const firstTarget = target(connectionA.id, modelM);
  const loopState = state([firstTarget, target(connectionB.id, modelM)]);
  let upstreamAttempts = 0;

  await dispatchWithCooldownRetry({
    state: loopState,
    deps: deps(async () => {
      upstreamAttempts += 1;
      if (upstreamAttempts === 1) {
        await auth.markAccountUnavailable(
          connectionA.id,
          503,
          "upstream service unavailable",
          "gemini",
          modelM,
          null,
          auth.buildExhaustionOptions("gemini-503", {
            headers: { "retry-after": "600" },
          })
        );
        return new Response(
          JSON.stringify({
            error: { message: "upstream service unavailable", type: "server_error" },
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "x-omniroute-selected-connection-id": String(connectionA.id),
            },
          }
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-omniroute-selected-connection-id": String(connectionB.id),
        },
      });
    }),
    extra: {
      maxSetRetries: 0,
      setRetryDelayMs: 0,
      comboTimeoutMs: 5_000,
      comboStartTime: Date.now(),
      comboCooldownWaitEnabled: false,
      comboCooldownAttempt: { current: 0 },
      comboCooldownBudgetLeftMs: { current: 0 },
      evaluateGates: evaluateExecuteTargetGates,
      executeAttempt: executeTargetAttempt,
    },
  });

  const modelMSelection = await auth.getProviderCredentials("gemini", null, null, modelM);
  const modelNSelection = await auth.getProviderCredentials("gemini", null, null, modelN);
  const modelMLockout = fallback.getModelLockoutInfo("gemini", connectionA.id, modelM);
  assert.deepEqual(
    {
      upstreamAttempts,
      failureCount: modelMLockout?.failureCount,
      retryHintHonored: (modelMLockout?.remainingMs ?? 0) > 590_000,
      siblingLockedForM: fallback.isModelLocked("gemini", connectionB.id, modelM),
      connectionALockedForN: fallback.isModelLocked("gemini", connectionA.id, modelN),
      connectionBLockedForN: fallback.isModelLocked("gemini", connectionB.id, modelN),
      modelMUnavailable: "allRateLimited" in modelMSelection && modelMSelection.allRateLimited,
      modelNAvailable: !("allRateLimited" in modelNSelection && modelNSelection.allRateLimited),
    },
    {
      upstreamAttempts: 1,
      failureCount: 1,
      retryHintHonored: true,
      siblingLockedForM: true,
      connectionALockedForN: false,
      connectionBLockedForN: false,
      modelMUnavailable: true,
      modelNAvailable: true,
    }
  );

  assert.equal(
    fallback
      .getAllModelLockouts()
      .some(
        (entry) =>
          entry.provider === "gemini" &&
          entry.connectionId === "*" &&
          entry.model === modelM &&
          entry.failureCount === 1
      ),
    true
  );

  const recoveryTarget = target(String(connectionB.id), modelM);
  await executeTargetAttempt({
    index: 0,
    state: state([recoveryTarget]),
    deps: deps(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-omniroute-selected-connection-id": String(connectionB.id),
          },
        })
    ),
    targetForAttempt: recoveryTarget,
    profile: {},
    protectedPriorityTarget: false,
  });
  assert.equal(fallback.isModelLocked("gemini", String(connectionA.id), modelM), false);
});

test("Gemini recovery clears provider scope without clearing a live connection scope", async () => {
  const connectionA = await createGeminiConnection("ai-studio-mixed-scope-a");
  const connectionB = await createGeminiConnection("ai-studio-mixed-scope-b");
  const model = "gemini-2.5-pro";

  await auth.markAccountUnavailable(connectionA.id, 429, "rate limited", "gemini", model);
  await auth.markAccountUnavailable(
    connectionA.id,
    503,
    "upstream service unavailable",
    "gemini",
    model
  );

  const recoveryTarget = target(connectionA.id, model);
  await executeTargetAttempt({
    index: 0,
    state: state([recoveryTarget]),
    deps: deps(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-omniroute-selected-connection-id": String(connectionA.id),
          },
        })
    ),
    targetForAttempt: recoveryTarget,
    profile: {},
    protectedPriorityTarget: false,
  });

  assert.equal(fallback.isModelLocked("gemini", connectionA.id, model), true);
  assert.equal(fallback.isModelLocked("gemini", connectionB.id, model), false);
});

test("Gemini AI Studio 429 remains scoped to one connection and model", async () => {
  const connectionA = await createGeminiConnection("ai-studio-429-a");
  const connectionB = await createGeminiConnection("ai-studio-429-b");

  await auth.markAccountUnavailable(
    connectionA.id,
    429,
    "quota exceeded",
    "gemini",
    "gemini-2.5-pro"
  );

  assert.equal(fallback.isModelLocked("gemini", connectionA.id, "gemini-2.5-pro"), true);
  assert.equal(fallback.isModelLocked("gemini", connectionB.id, "gemini-2.5-pro"), false);
});
