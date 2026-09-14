import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-history-route-"));
process.env.DATA_DIR = dataDir;

const core = await import("../../src/lib/db/core.ts");
const usage = await import("../../src/lib/usage/usageHistory.ts");
const route = await import("../../src/app/api/usage/history/route.ts");

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(dataDir, { recursive: true });
  await usage.saveRequestUsage({
    provider: "nvidia",
    model: "ultra",
    connectionId: "key-1",
    tokens: { input: 10, output: 5 },
    latencyMs: 40000,
    timeToFirstTokenMs: 30000,
    timestamp: "2026-09-14T10:00:00.000Z",
  });
  await usage.saveRequestUsage({
    provider: "agy",
    model: "gemini",
    connectionId: "agy-1",
    tokens: { input: 20, output: 8 },
    latencyMs: 2000,
    timeToFirstTokenMs: 500,
    timestamp: "2026-09-14T10:01:00.000Z",
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("usage history returns bounded provider-specific records with TTFT", async () => {
  const response = await route.GET(
    new Request("http://localhost/api/usage/history?provider=nvidia&limit=1")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].provider, "nvidia");
  assert.equal(body.items[0].connectionId, "key-1");
  assert.equal(body.items[0].timeToFirstTokenMs, 30000);
  assert.equal(body.nextCursor, null);
});
