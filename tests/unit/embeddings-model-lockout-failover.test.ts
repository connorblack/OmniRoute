import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-embed-failover-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "embed-failover-test-secret";

const realFetch = globalThis.fetch;
let upstreamFetch: typeof globalThis.fetch = realFetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  upstreamFetch(input, init)) as typeof globalThis.fetch;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { runEmbeddingWithFailover } = await import("../../src/lib/embeddings/failover.ts");
const { runWithDirectFetchContext } = await import("../../open-sse/utils/proxyFetch.ts");
const { reserveGeminiRequest, settleGeminiRequest } =
  await import("../../open-sse/services/geminiRateLimitTracker.ts");

const MODEL = "gemini-embedding-2-preview";
const MODEL_GA = "gemini-embedding-2";
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
    const body = JSON.parse(String(init?.body ?? "{}"));
    const payload = Array.isArray(body.requests)
      ? { embeddings: body.requests.map(() => ({ values: [0.1, 0.2, 0.3] })) }
      : { embedding: { values: [0.1, 0.2, 0.3] } };
    return new Response(JSON.stringify(payload), {
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

function fakeBreaker(open = false) {
  const calls = { success: 0, failure: 0 };
  return {
    calls,
    breaker: {
      canExecute: () => !open,
      getRetryAfterMs: () => 30_000,
      _onSuccess: () => {
        calls.success++;
      },
      _onFailure: () => {
        calls.failure++;
      },
    },
  };
}

const NO_WAIT = {
  enabled: true,
  maxRetries: 2,
  maxRetryWaitSec: 5,
  maxRetryWaitMs: 5_000,
  budgetMs: 10_000,
};

test("embedding with an exhausted Gemini budget on the first key goes straight to the next key", async () => {
  const a = await seedGemini("gemini-budget-a", 1);
  await seedGemini("gemini-budget-b", 2);
  for (let i = 0; i < 10; i++) {
    const handle = reserveGeminiRequest(a, MODEL_GA, Date.now() - 70_000 * (i + 1), 100);
    settleGeminiRequest(handle, { upstreamStatus: 200 }, Date.now() - 70_000 * (i + 1));
  }
  const upstream = mockGeminiUpstream(new Set());
  try {
    const { createEmbeddingResponse } = await import("../../src/lib/embeddings/service.ts");
    const res = await runWithDirectFetchContext(() =>
      createEmbeddingResponse({ model: `gemini/${MODEL_GA}`, input: ["one", "two"] }, {})
    );
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(upstream.keys, ["gemini-budget-b"]);
  } finally {
    upstream.restore();
  }
});

test("failover stops on a non-account failure and guards against a repeated pick", async () => {
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
    }),
    { provider: "test", breaker: fakeBreaker().breaker, retrySettings: NO_WAIT }
  );
  assert.deepEqual(selections, [[], ["a"]]);
  assert.equal((outcome.credentials as { connectionId: string }).connectionId, "b");
  assert.equal(outcome.result?.status, 400);

  const repeated = await runEmbeddingWithFailover(
    async () => ({ connectionId: "a" }),
    async () => ({ success: false, status: 429, retryWithNextConnection: true }),
    { provider: "test", breaker: fakeBreaker().breaker, retrySettings: NO_WAIT }
  );
  assert.equal(repeated.result?.status, 429);

  const none = await runEmbeddingWithFailover(
    async () => null,
    async () => ({ success: true }),
    { provider: "test", breaker: fakeBreaker().breaker, retrySettings: NO_WAIT }
  );
  assert.equal(none.credentials, null);
  assert.equal(none.result, null);
});

test("an open provider breaker rejects before selecting a connection", async () => {
  let selected = false;
  const outcome = await runEmbeddingWithFailover(
    async () => {
      selected = true;
      return { connectionId: "a" };
    },
    async () => ({ success: true }),
    { provider: "test", breaker: fakeBreaker(true).breaker, retrySettings: NO_WAIT }
  );
  assert.equal(selected, false);
  assert.equal(outcome.response?.status, 503);
});

test("when every connection is cooling down the request waits and starts over", async () => {
  let round = 0;
  const { breaker, calls } = fakeBreaker();
  const outcome = await runEmbeddingWithFailover(
    async (exclude) => {
      if (exclude.length > 0) {
        return { allRateLimited: true, retryAfter: new Date(Date.now() + 50).toISOString() };
      }
      return { connectionId: "a" };
    },
    async () => {
      round++;
      return round === 1
        ? { success: false, status: 429, retryWithNextConnection: true }
        : { success: true };
    },
    { provider: "test", breaker, retrySettings: NO_WAIT }
  );
  assert.equal(round, 2);
  assert.equal(outcome.result?.success, true);
  assert.equal(calls.success, 1);
});

test("a cooldown longer than the retry budget returns the last failure", async () => {
  let runs = 0;
  const outcome = await runEmbeddingWithFailover(
    async (exclude) =>
      exclude.length > 0
        ? { allRateLimited: true, retryAfter: new Date(Date.now() + 3_600_000).toISOString() }
        : { connectionId: "a" },
    async () => {
      runs++;
      return { success: false, status: 429, retryWithNextConnection: true };
    },
    { provider: "test", breaker: fakeBreaker().breaker, retrySettings: NO_WAIT }
  );
  assert.equal(runs, 1);
  assert.equal(outcome.result?.status, 429);
});

test("a transport failure retries the same connection once, then rotates and trips the breaker", async () => {
  const used: string[] = [];
  const { breaker, calls } = fakeBreaker();
  const outcome = await runEmbeddingWithFailover(
    async (exclude) => (exclude.length === 0 ? { connectionId: "a" } : null),
    async (c) => {
      used.push(c.connectionId);
      return { success: false, status: 502, error: "fetch failed: ECONNRESET" };
    },
    { provider: "test", breaker, retrySettings: NO_WAIT }
  );
  assert.deepEqual(used, ["a", "a"]);
  assert.equal(outcome.result?.status, 502);
  assert.equal(calls.failure, 1);
});

test("a local limiter failure rotates without tripping the provider breaker", async () => {
  const { breaker, calls } = fakeBreaker();
  const outcome = await runEmbeddingWithFailover(
    async (exclude) => (exclude.length === 0 ? { connectionId: "a" } : null),
    async () => ({
      success: false,
      status: 504,
      retryWithNextConnection: true,
      localRateLimit: true,
    }),
    { provider: "test", breaker, retrySettings: NO_WAIT }
  );
  assert.equal(outcome.result?.status, 504);
  assert.equal(calls.failure, 0);
});
