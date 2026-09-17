/**
 * The combo's same-model retry skips a transient failure only when the target
 * has no usable connection left. An unpinned target (no selected-connection
 * header on the failure) keeps retrying while any of its provider's
 * connections can still serve the model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-combo-retry-lock-guard-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-combo-retry-lock-guard-secret";

const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { clearAllModelLockouts, isModelLocked } =
  await import("../../open-sse/services/accountFallback.ts");
const { jsonResponse, okResponse, rateLimitResponse, recordAuthFailure } =
  await import("./_helpers/authBackedComboHandler.ts");

const MODEL = "openai/gpt-4";
const LOCK_MS = 60_000;

async function seedConnections(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const connection = await createProviderConnection({
      provider: "openai",
      name: `retry-guard-${i}`,
      authType: "apikey",
      apiKey: `sk-retry-guard-${i}`,
      isActive: true,
      testStatus: "active",
    });
    ids.push(connection.id as string);
  }
  return ids;
}

async function runTransientFailureOnce() {
  let dispatches = 0;
  const res = await handleComboChat({
    body: { model: MODEL },
    combo: {
      name: `retry-guard-${Math.random().toString(16).slice(2, 8)}`,
      strategy: "priority",
      models: [MODEL],
      config: { maxRetries: 1, retryDelayMs: 0, fallbackDelayMs: 0, maxSetRetries: 0 },
    },
    handleSingleModel: async () => {
      dispatches += 1;
      return dispatches === 1
        ? jsonResponse(502, { error: { message: "upstream hiccup" } })
        : okResponse();
    },
    isModelAvailable: async () => true,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    settings: {},
    allCombos: null,
  });
  return { dispatches, status: res.status };
}

test.beforeEach(() => {
  clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  clearAllModelLockouts();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a transient 502 is retried while another connection can still serve the model", async () => {
  const [locked, free] = await seedConnections(2);
  await recordAuthFailure(locked, MODEL, rateLimitResponse(LOCK_MS));
  assert.equal(isModelLocked("openai", locked, "gpt-4"), true);
  assert.equal(isModelLocked("openai", free, "gpt-4"), false);

  const { dispatches, status } = await runTransientFailureOnce();

  assert.equal(dispatches, 2, "one locked key must not cancel the same-model retry");
  assert.equal(status, 200);
});

test("a transient 502 is not retried when every connection has the model locked", async () => {
  const ids = await seedConnections(2);
  for (const id of ids) {
    await recordAuthFailure(id, MODEL, rateLimitResponse(LOCK_MS));
    assert.equal(isModelLocked("openai", id, "gpt-4"), true);
  }

  const { dispatches, status } = await runTransientFailureOnce();

  assert.equal(dispatches, 1, "no connection can serve the retry");
  assert.equal(status, 502);
});
