import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-rl-queue-timeout-lockout-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-rl-lockout-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { getModelLockoutInfo, isModelLocked } =
  await import("../../open-sse/services/accountFallback.ts");

function createLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

async function seedConnection(provider: string, overrides: any = {}): Promise<any> {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey || `sk-test-${Math.random().toString(16).slice(2, 8)}`,
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: null,
    backoffLevel: overrides.backoffLevel || 0,
    providerSpecificData: overrides.providerSpecificData || {},
  });
}

function errorResponseWithoutConnectionId(status: number) {
  return new Response(JSON.stringify({ error: { message: "Local queue timeout" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponseWithConnectionId(status: number, connectionId: string) {
  return new Response(JSON.stringify({ error: { message: "Local queue timeout" } }), {
    status,
    headers: {
      "content-type": "application/json",
      "X-OmniRoute-Selected-Connection-Id": connectionId,
    },
  });
}

test.afterEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("RATE_LIMIT_QUEUE_TIMEOUT leaves model lockout to AUTH with or without the connection header", async () => {
  const provider = "openai";
  const model = "gpt-4";
  const connection = await seedConnection(provider);
  const connectionId = connection.id;

  const customSettings = {
    modelLockout: {
      enabled: true,
      errorCodes: [502, 520],
      baseCooldownMs: 3000,
      maxCooldownMs: 5000,
      maxBackoffSteps: 10,
      useExponentialBackoff: true,
    },
  };

  async function runComboTwice(respond: () => Response) {
    let dispatches = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await handleComboChat({
        body: {},
        combo: {
          name: "test-combo",
          strategy: "priority",
          models: [`${provider}/${model}`],
          config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
        },
        handleSingleModel: async () => {
          dispatches += 1;
          return respond();
        },
        isModelAvailable: async () => true,
        log: createLog() as any,
        settings: customSettings,
        allCombos: null,
      });
      statuses.push(res.status);
    }
    return { dispatches, statuses };
  }

  // 2b903bc7c: a missing header used to lock the whole target under "", which
  // blocked every connection of the provider for the next request.
  const withoutHeader = await runComboTwice(() => errorResponseWithoutConnectionId(502));
  assert.equal(isModelLocked(provider, "", model), false, 'no whole-target lock under ""');
  assert.equal(isModelLocked(provider, connectionId, model), false);
  assert.deepEqual(withoutHeader.statuses, [502, 502]);
  assert.equal(withoutHeader.dispatches, 2, "the next request still reaches AUTH");

  // A local queue timeout never reached the upstream; the combo records no lock
  // for the selected connection either, and AUTH owns any lock it deserves.
  const withHeader = await runComboTwice(() => errorResponseWithConnectionId(502, connectionId));
  assert.equal(isModelLocked(provider, connectionId, model), false);
  assert.equal(getModelLockoutInfo(provider, connectionId, model), null);
  assert.equal(isModelLocked(provider, "", model), false);
  assert.deepEqual(withHeader.statuses, [502, 502]);
  assert.equal(withHeader.dispatches, 2, "the next request still reaches AUTH");
});
