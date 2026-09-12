import test from "node:test";
import assert from "node:assert/strict";

const { updateResilienceSchema } = await import("../../src/shared/validation/schemas/settings.ts");

test("the resilience save accepts the request queue exactly as GET /api/resilience returns it", () => {
  const requestQueue = {
    autoEnableApiKeyProviders: true,
    requestsPerMinute: 35,
    minTimeBetweenRequestsMs: 0,
    concurrentRequests: 5,
    globalConcurrentRequests: 0,
    maxWaitMs: 300000,
    executionMaxWaitMs: 600000,
    maxQueueDepth: 2000,
  };
  assert.equal(updateResilienceSchema.safeParse({ requestQueue }).success, true);
});

test("globalConcurrentRequests must be an integer from 0 to 100000", () => {
  for (const value of [-1, 1.5, 100_001]) {
    const result = updateResilienceSchema.safeParse({
      requestQueue: { globalConcurrentRequests: value },
    });
    assert.equal(result.success, false, String(value));
  }
  assert.equal(
    updateResilienceSchema.safeParse({ requestQueue: { globalConcurrentRequests: 8 } }).success,
    true
  );
});
