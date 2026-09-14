import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllModelLockouts,
  clearModelLock,
  isModelLocked,
} from "../../open-sse/services/accountFallback.ts";
import {
  classifyAttemptOutcomeSource,
  clearSlowStartState,
  getSlowStartStates,
  recordSlowStartObservation,
} from "../../open-sse/services/slowStartCooldown.ts";
import { resolveModelLockoutSettings } from "../../src/lib/resilience/modelLockoutSettings.ts";
import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";

const policy = {
  enabled: true,
  providers: ["nvidia"],
  thresholdMs: 60000,
  failuresBeforeCooldown: 3,
  observationWindowMs: 600000,
  cooldownStepsMs: [300000, 600000, 900000],
};

const observation = {
  provider: "nvidia",
  connectionId: "key-3",
  model: "nemotron-3-ultra",
  upstreamHeadersMs: 90000,
  requestToHeadersMs: 92000,
  status: 200,
  outcomeSource: "upstream" as const,
  upstreamLifecycleStatus: "fulfilled",
  upstreamRequestId: "nvcf-1",
};

test.beforeEach(() => {
  clearSlowStartState();
  clearAllModelLockouts();
});

test("response provenance keeps NVIDIA, relay, and client outcomes separate", () => {
  assert.equal(
    classifyAttemptOutcomeSource({
      status: 503,
      transport: "relay",
      upstreamLifecycleStatus: "errored",
      upstreamRequestId: "nvcf-1",
    }),
    "upstream"
  );
  assert.equal(
    classifyAttemptOutcomeSource({
      status: 502,
      transport: "relay",
      upstreamLifecycleStatus: null,
      upstreamRequestId: null,
    }),
    "relay"
  );
  assert.equal(
    classifyAttemptOutcomeSource({
      status: 499,
      transport: null,
      upstreamLifecycleStatus: null,
      upstreamRequestId: null,
    }),
    "client"
  );
  assert.equal(
    classifyAttemptOutcomeSource({
      status: 500,
      transport: null,
      upstreamLifecycleStatus: null,
      upstreamRequestId: null,
    }),
    "local"
  );
});

test("three slow upstream starts cool only that provider key and model", () => {
  assert.equal(recordSlowStartObservation(observation, policy, 1000).kind, "observed");
  assert.equal(recordSlowStartObservation(observation, policy, 2000).kind, "observed");
  const decision = recordSlowStartObservation(observation, policy, 3000);

  assert.deepEqual(decision, {
    kind: "cooled",
    cooldownMs: 300000,
    escalationLevel: 1,
    slowCount: 3,
  });
  assert.equal(isModelLocked("nvidia", "key-3", "nemotron-3-ultra"), true);
  assert.equal(isModelLocked("nvidia", "key-4", "nemotron-3-ultra"), false);
  assert.equal(isModelLocked("nvidia", "key-3", "nemotron-3-super"), false);
});

test("relay and client outcomes never train NVIDIA slow-start state", () => {
  for (const outcomeSource of ["relay", "client"] as const) {
    const decision = recordSlowStartObservation({ ...observation, outcomeSource }, policy, 1000);
    assert.equal(decision.kind, "ignored");
  }
  assert.deepEqual(getSlowStartStates(1000), []);
});

test("a fast upstream start clears pending slow observations", () => {
  recordSlowStartObservation(observation, policy, 1000);
  recordSlowStartObservation(observation, policy, 2000);
  const decision = recordSlowStartObservation(
    { ...observation, upstreamHeadersMs: 10000 },
    policy,
    3000
  );
  assert.equal(decision.kind, "observed");
  assert.equal(decision.slowCount, 0);
  assert.equal(isModelLocked("nvidia", "key-3", "nemotron-3-ultra"), false);
});

test("later trips step through the configured cooldown schedule", () => {
  for (const now of [1000, 2000, 3000]) recordSlowStartObservation(observation, policy, now);
  clearModelLock("nvidia", "key-3", "nemotron-3-ultra");
  for (const now of [304000, 305000]) recordSlowStartObservation(observation, policy, now);
  const decision = recordSlowStartObservation(observation, policy, 306000);
  assert.equal(decision.kind, "cooled");
  assert.equal(decision.cooldownMs, 600000);
  assert.equal(decision.escalationLevel, 2);
});

test("slow observations outside the rolling window do not accumulate", () => {
  recordSlowStartObservation(observation, policy, 1000);
  recordSlowStartObservation(observation, policy, 700000);
  const states = getSlowStartStates(700000);
  assert.equal(states[0].slowCount, 1);
  assert.equal(isModelLocked("nvidia", "key-3", "nemotron-3-ultra"), false);
});

test("settings API accepts the complete slow-start tuning policy", () => {
  const slowStart = {
    enabled: true,
    providers: ["nvidia"],
    thresholdMs: 120000,
    failuresBeforeCooldown: 4,
    observationWindowMs: 900000,
    cooldownStepsMs: [300000, 600000, 900000],
  };
  const result = updateSettingsSchema.safeParse({
    modelLockout: { slowStart },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.modelLockout?.slowStart, slowStart);
});

test("model lockout settings normalize the tunable slow-start policy", () => {
  const settings = resolveModelLockoutSettings({
    modelLockout: {
      slowStart: {
        enabled: true,
        providers: ["nvidia"],
        thresholdMs: 120000,
        failuresBeforeCooldown: 4,
        observationWindowMs: 900000,
        cooldownStepsMs: [300000, 600000, 900000],
      },
    },
  });

  assert.deepEqual(settings.slowStart, {
    enabled: true,
    providers: ["nvidia"],
    thresholdMs: 120000,
    failuresBeforeCooldown: 4,
    observationWindowMs: 900000,
    cooldownStepsMs: [300000, 600000, 900000],
  });
});
