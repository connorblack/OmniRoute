import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeQuotaProvider } from "../../src/shared/contracts/quota.ts";

test("quota contract preserves unknown instead of inventing 100 percent remaining", () => {
  assert.deepEqual(
    sanitizeQuotaProvider({
      name: "NVIDIA key 3",
      provider: "nvidia",
      connectionId: "connection-3",
      quotaUsed: null,
      quotaTotal: null,
      percentRemaining: null,
      resetAt: null,
      tokenStatus: "valid",
      quotaStatus: "unknown",
      queuePressure: { queued: 2, running: 3, executing: 1 },
    }),
    {
      name: "NVIDIA key 3",
      provider: "nvidia",
      connectionId: "connection-3",
      quotaUsed: null,
      quotaTotal: null,
      percentRemaining: null,
      resetAt: null,
      tokenStatus: "valid",
      quotaStatus: "unknown",
      queuePressure: { queued: 2, running: 3, executing: 1 },
    }
  );
});

test("quota contract derives a known percentage only from a real limit", () => {
  const value = sanitizeQuotaProvider({
    name: "provider",
    provider: "example",
    connectionId: "connection",
    quotaUsed: 25,
    quotaTotal: 100,
    resetAt: null,
    tokenStatus: "valid",
  });
  assert.equal(value.quotaStatus, "known");
  assert.equal(value.percentRemaining, 75);
});

test("usage quota projection keeps unknown values null", async () => {
  const { toQuotaRows } = await import("../../bin/cli/commands/usage.mjs");
  assert.deepEqual(
    toQuotaRows({
      providers: [
        {
          provider: "nvidia",
          connectionId: "connection-3",
          quotaUsed: null,
          quotaTotal: null,
          percentRemaining: null,
          resetAt: null,
          quotaStatus: "unknown",
        },
      ],
    }),
    [
      {
        provider: "nvidia",
        connectionId: "connection-3",
        limit: null,
        used: null,
        remaining: null,
        resetAt: null,
        state: "unknown",
      },
    ]
  );
});
