import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A Gemini 429 on an embedding model is a per-model lockout on that connection
// (hasPerModelQuota). Selection only honors the lockout when it knows the model,
// and a request must rotate to the next eligible connection instead of
// returning the first connection's 429 to the client.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-embed-failover-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "embed-failover-test-secret";

// proxyFetch captures globalThis.fetch on first import, so the swap point must
// be installed before any module below loads.
const realFetch = globalThis.fetch;
let upstreamFetch: typeof globalThis.fetch = realFetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  upstreamFetch(input, init)) as typeof globalThis.fetch;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { runEmbeddingWithFailover } = await import("../../src/lib/embeddings/failover.ts");
const { runWithDirectFetchContext } = await import("../../open-sse/utils/proxyFetch.ts");

const MODEL = "gemini-embedding-2-preview";
const QUOTA_429 = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    status: "RESOURCE_EXHAUSTED",
  },
});

async function seedGemini(apiKey: string, priority: number): Promise<string> {
  const conn = await providersDb.createProviderConnection({
    provider: "gemini",
    authType: "apikey",
    apiKey,
    isActive: true,
    testStatus: "active",
    priority,
  });
  return (conn as Record<string, unknown>).id as string;
}

function mockGeminiUpstream(exhaustedKeys: Set<string>): { keys: string[]; restore: () => void } {
  const keys: string[] = [];
  upstreamFetch = (async (_url: unknown, init?: RequestInit) => {
    const key = String((init?.headers as Record<string, string>)?.["x-goog-api-key"] ?? "");
    keys.push(key);
    if (exhaustedKeys.has(key)) {
      return new Response(QUOTA_429, {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    keys,
    restore: () => {
      upstreamFetch = realFetch;
    },
  };
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("embedding 429 on the first connection rotates to the next one in the same request", async () => {
  await seedGemini("gemini-key-a", 1);
  await seedGemini("gemini-key-b", 2);
  const upstream = mockGeminiUpstream(new Set(["gemini-key-a"]));
  try {
    const { createEmbeddingResponse } = await import("../../src/lib/embeddings/service.ts");

    const first = await runWithDirectFetchContext(() =>
      createEmbeddingResponse({ model: `gemini/${MODEL}`, input: "hello" }, {})
    );
    assert.equal(first.status, 200, await first.text());
    assert.deepEqual(upstream.keys, ["gemini-key-a", "gemini-key-b"]);

    upstream.keys.length = 0;
    const second = await runWithDirectFetchContext(() =>
      createEmbeddingResponse({ model: `gemini/${MODEL}`, input: "world" }, {})
    );
    assert.equal(second.status, 200, await second.text());
    assert.deepEqual(
      upstream.keys,
      ["gemini-key-b"],
      "a connection with the model locked out must not be selected again"
    );
  } finally {
    upstream.restore();
  }
});

test("runEmbeddingWithFailover stops on a non-account failure and guards against a repeated pick", async () => {
  const selections: string[][] = [];
  const outcome = await runEmbeddingWithFailover(
    async (exclude) => {
      selections.push([...exclude]);
      return { connectionId: exclude.length === 0 ? "a" : "b" };
    },
    async (c) => ({
      success: false,
      status: c.connectionId === "a" ? 429 : 400,
      retryWithNextConnection: c.connectionId === "a",
    })
  );
  assert.deepEqual(selections, [[], ["a"]]);
  assert.equal(outcome.credentials.connectionId, "b");
  assert.equal(outcome.result?.status, 400);

  const repeated = await runEmbeddingWithFailover(
    async () => ({ connectionId: "a" }),
    async () => ({ success: false, status: 429, retryWithNextConnection: true })
  );
  assert.equal(repeated.credentials.connectionId, "a");
  assert.equal(repeated.result?.status, 429);

  const none = await runEmbeddingWithFailover(
    async () => null,
    async () => ({ success: true })
  );
  assert.equal(none.credentials, null);
  assert.equal(none.result, null);
});
