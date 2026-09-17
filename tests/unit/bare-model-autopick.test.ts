import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bare-autopick-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getModelInfoCore } = await import("../../open-sse/services/model.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("gpt-oss-120b-medium is ambiguous between antigravity and agy without an active connection", async () => {
  const info = (await getModelInfoCore("gpt-oss-120b-medium", null)) as Record<string, unknown>;

  assert.equal(info.provider, null);
  assert.equal(info.errorType, "ambiguous_model");
  assert.deepEqual(info.candidateProviders, ["antigravity", "agy"]);
});

test("unprefixed model with no active providers falls back to ambiguous_model when multiple distinct providers exist", async () => {
  const info = (await getModelInfoCore("gpt-oss-120b", null)) as Record<string, unknown>;

  assert.equal(info.provider, null);
  assert.equal(info.errorType, "ambiguous_model");
  assert.ok(Array.isArray(info.candidateProviders));
  assert.ok((info.candidateProviders as unknown[]).length > 1);
});

test("gpt-oss-120b-medium auto-picks antigravity when only antigravity has an active connection", async () => {
  await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name: "bare-autopick-antigravity",
    isActive: true,
    testStatus: "active",
  });

  const info = (await getModelInfoCore("gpt-oss-120b-medium", null)) as Record<string, unknown>;

  assert.equal(info.provider, "antigravity");
  assert.equal(info.model, "gpt-oss-120b-medium");
  assert.equal(info.errorType, undefined);
});
