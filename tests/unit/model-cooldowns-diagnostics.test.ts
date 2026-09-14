import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cooldown-diagnostics-"));
process.env.DATA_DIR = dataDir;
process.env.INITIAL_PASSWORD = "cooldown-diagnostics-password";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/resilience/model-cooldowns/route.ts");
const resilienceRoute = await import("../../src/app/api/resilience/route.ts");
const fallback = await import("../../open-sse/services/accountFallback.ts");
const slowStart = await import("../../open-sse/services/slowStartCooldown.ts");

const fixtureCredential = ["fixture", "credential"].join("-");

const policy = {
  enabled: true,
  providers: ["nvidia"],
  thresholdMs: 60_000,
  failuresBeforeCooldown: 3,
  observationWindowMs: 600_000,
  cooldownStepsMs: [300_000, 600_000, 900_000],
};

async function request(method = "GET", body?: unknown) {
  return route[method as "GET" | "DELETE"](
    await makeManagementSessionRequest("http://localhost/api/resilience/model-cooldowns", {
      method,
      ...(body === undefined ? {} : { body }),
    })
  );
}

test.before(async () => {
  await settings.updateSettings({ requireLogin: true, password: "" });
});

test.beforeEach(async () => {
  fallback.clearAllModelLockouts();
  slowStart.clearSlowStartState();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(dataDir, { recursive: true });
  await settings.updateSettings({ requireLogin: true, password: "" });
});

test.after(() => {
  fallback.clearAllModelLockouts();
  slowStart.clearSlowStartState();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("cooldown diagnostics retain account scope, expiry, family, and slow-start state", async () => {
  const connection = await providers.createProviderConnection({
    provider: "nvidia",
    authType: "apikey",
    name: "NVIDIA key 3",
    apiKey: fixtureCredential,
    isActive: true,
  });
  const connectionId = String(Reflect.get(connection as object, "id"));
  slowStart.recordSlowStartObservation(
    {
      kind: "headers",
      provider: "nvidia",
      connectionId,
      model: "nemotron-3-ultra",
      upstreamHeadersMs: 90_000,
      requestToHeadersMs: 91_000,
      upstreamStatus: 200,
      outcomeSource: "upstream",
      upstreamLifecycleStatus: "fulfilled",
      upstreamRequestId: "nvcf-test",
    },
    policy,
    Date.now()
  );
  fallback.lockModel("nvidia", connectionId, "nemotron-3-ultra", "slow_start", 60_000, {});

  const response = await request();
  assert.equal(response.status, 200);
  const body = await response.json();
  const item = body.items.find(
    (row: { provider: string; connectionId: string }) =>
      row.provider === "nvidia" && row.connectionId === connectionId
  );
  assert.ok(item);
  assert.equal(item.accountLabel, "NVIDIA key 3");
  assert.equal(item.scope, "connection-model");
  assert.equal(item.modelFamily, null);
  assert.match(item.lockedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(item.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  const state = body.slowStartStates.find(
    (row: { provider: string; connectionId: string }) =>
      row.provider === "nvidia" && row.connectionId === connectionId
  );
  assert.ok(state);
  assert.equal(state.accountLabel, "NVIDIA key 3");
  assert.equal(state.slowCount, 1);
  assert.equal(state.escalationLevel, 0);
});

test("GET /api/resilience opt-in exposes slow-start policy and scoped state", async () => {
  await settings.updateSettings({
    modelLockout: {
      enabled: true,
      errorCodes: [502, 503],
      failureThreshold: 3,
      baseCooldownMs: 60_000,
      maxCooldownMs: 900_000,
      slowStart: policy,
    },
  });
  slowStart.recordSlowStartObservation(
    {
      kind: "headers",
      provider: "nvidia",
      connectionId: "nvidia-key-observed",
      model: "nemotron-3-ultra",
      upstreamHeadersMs: 90_000,
      requestToHeadersMs: 91_000,
      upstreamStatus: 200,
      outcomeSource: "upstream",
      upstreamLifecycleStatus: "fulfilled",
      upstreamRequestId: "nvcf-observed",
    },
    policy
  );

  const response = await resilienceRoute.GET(
    new Request("http://localhost/api/resilience?include=slowStart")
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.slowStart.policy, policy);
  assert.equal(body.slowStart.states.length, 1);
  assert.equal(body.slowStart.states[0].connectionId, "nvidia-key-observed");
  assert.equal(body.slowStart.states[0].model, "nemotron-3-ultra");

  const defaultResponse = await resilienceRoute.GET(new Request("http://localhost/api/resilience"));
  const defaultBody = await defaultResponse.json();
  assert.equal("slowStart" in defaultBody, false);
});

test("DELETE clears only the selected connection-model lockout", async () => {
  for (const connectionId of ["nvidia-key-a", "nvidia-key-b"]) {
    await providers.createProviderConnection({
      id: connectionId,
      provider: "nvidia",
      authType: "apikey",
      name: connectionId,
      apiKey: fixtureCredential,
      isActive: true,
    });
    fallback.lockModel("nvidia", connectionId, "nemotron-3-ultra", "slow_start", 60_000, {});
  }

  const response = await request("DELETE", {
    provider: "nvidia",
    connectionId: "nvidia-key-a",
    model: "nemotron-3-ultra",
  });
  assert.equal(response.status, 200);
  assert.equal(fallback.isModelLocked("nvidia", "nvidia-key-a", "nemotron-3-ultra"), false);
  assert.equal(fallback.isModelLocked("nvidia", "nvidia-key-b", "nemotron-3-ultra"), true);
});
