import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A key's saved rate-limit overrides are its real budget. They load lazily, so
// an embedding request that arrives before any chat request (right after a
// deploy) must load them before choosing a key; otherwise a billed key is
// judged by the free-tier table and skipped.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-embed-ratelimit-init-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "embed-ratelimit-init-secret";

const realFetch = globalThis.fetch;
const keysUsed: string[] = [];
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  keysUsed.push(String((init?.headers as Record<string, string>)?.["x-goog-api-key"] ?? ""));
  return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof globalThis.fetch;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { runWithDirectFetchContext } = await import("../../open-sse/utils/proxyFetch.ts");
const tracker = await import("../../open-sse/services/geminiRateLimitTracker.ts");
const rateLimits = await import("../../open-sse/services/rateLimitManager.ts");

const MODEL = "gemini-embedding-2";

test.after(async () => {
  globalThis.fetch = realFetch;
  await rateLimits.__resetRateLimitManagerForTests();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a key's saved overrides apply to embeddings before any chat request has run", async () => {
  const paid = (await providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    apiKey: "gemini-paid-key",
    isActive: true,
    testStatus: "active",
    priority: 1,
    rateLimitOverrides: { rpm: 3000, tpm: 1_000_000 },
  })) as { id: string };
  await providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    apiKey: "gemini-free-key",
    isActive: true,
    testStatus: "active",
    priority: 2,
  });
  const now = Date.now();
  tracker.setGeminiLedgerSeedSourceForTests(() =>
    Array.from({ length: 1500 }, (_, i) => ({
      connectionId: paid.id,
      model: `gemini/${MODEL}`,
      status: 200,
      timestampMs: now - 120_000 - i,
      tokensIn: 0,
      tokensOut: 0,
    }))
  );

  const { createEmbeddingResponse } = await import("../../src/lib/embeddings/service.ts");
  const [first, second] = await runWithDirectFetchContext(() =>
    Promise.all([
      createEmbeddingResponse({ model: `gemini/${MODEL}`, input: "one" }, {}),
      createEmbeddingResponse({ model: `gemini/${MODEL}`, input: "two" }, {}),
    ])
  );
  assert.equal(first.status, 200, await first.text());
  assert.equal(second.status, 200, await second.text());
  assert.deepEqual(keysUsed, ["gemini-paid-key", "gemini-paid-key"]);
});
