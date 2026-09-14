import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-8779-agy-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const model = await import("../../open-sse/services/model.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedOnly(provider: string) {
  await resetStorage();
  await providersDb.createProviderConnection({
    provider,
    authType: "oauth",
    email: `${provider}@example.test`,
    accessToken: `tok-${provider}`,
    isActive: true,
    testStatus: "active",
    priority: 1,
  });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("agy and antigravity prefixes retain distinct provider identities", () => {
  const agy = model.parseModel("agy/gemini-3-pro");
  assert.equal(agy.provider, "agy");
  assert.equal(agy.providerAlias, "agy");

  const antigravity = model.parseModel("antigravity/gemini-3-pro");
  assert.equal(antigravity.provider, "antigravity");
  assert.equal(antigravity.providerAlias, "antigravity");
});

test("an agy request finds only agy credentials", async () => {
  await seedOnly("agy");
  assert.ok(await auth.getProviderCredentials("agy"));
  assert.equal(await auth.getProviderCredentials("antigravity"), null);
});

test("an antigravity request finds only antigravity credentials", async () => {
  await seedOnly("antigravity");
  assert.ok(await auth.getProviderCredentials("antigravity"));
  assert.equal(await auth.getProviderCredentials("agy"), null);
});

test("the identity boundary does not affect unrelated providers", async () => {
  await seedOnly("agy");
  assert.equal(await auth.getProviderCredentials("gemini"), null);
});
