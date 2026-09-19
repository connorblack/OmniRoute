import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rerank-tailnet-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
const { createProviderNode, createProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { POST } = await import("../../src/app/api/v1/rerank/route.ts");

async function addNode(prefix: string, baseUrl: string) {
  const now = new Date().toISOString();
  await createProviderNode({
    id: prefix,
    name: prefix,
    type: "openai",
    prefix,
    baseUrl,
    createdAt: now,
    updatedAt: now,
  });
  await createProviderConnection({
    id: `conn-${prefix}`,
    provider: prefix,
    authType: "apikey",
    name: prefix,
    apiKey: "test-token",
    createdAt: now,
    updatedAt: now,
  });
  invalidateDbCache("nodes");
  invalidateDbCache("connections");
}

function rerank(model: string) {
  return POST(
    new Request("http://localhost:20128/api/v1/rerank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, query: "q", documents: ["a", "b"] }),
    }),
    {} as Record<string, unknown>
  );
}

test.describe("Local rerank provider nodes on the tailnet", () => {
  const originalFetch = globalThis.fetch;
  let fetched: string[] = [];

  test.beforeEach(() => {
    fetched = [];
    globalThis.fetch = async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
  });

  test.after(() => {
    globalThis.fetch = originalFetch;
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("routes to a MagicDNS *.ts.net host", async () => {
    await addNode("magicdns", "https://jina-rerank.example.ts.net/v1");
    const res = await rerank("magicdns/jina-reranker-v3.5");
    assert.equal(res.status, 200);
    assert.deepEqual(fetched, ["https://jina-rerank.example.ts.net/v1/rerank"]);
  });

  test("routes to a tailnet 100.64.0.0/10 address", async () => {
    await addNode("tailip", "http://100.71.136.144/v1");
    const res = await rerank("tailip/jina-reranker-v3.5");
    assert.equal(res.status, 200);
    assert.deepEqual(fetched, ["http://100.71.136.144/v1/rerank"]);
  });

  test("still refuses public and non-tailnet 100.x hosts", async () => {
    await addNode("public", "http://203.0.113.10/v1");
    await addNode("cgnatedge", "http://100.128.0.1/v1");
    for (const model of ["public/some-reranker", "cgnatedge/some-reranker"]) {
      const res = await rerank(model);
      assert.equal(res.status, 400, model);
    }
    assert.deepEqual(fetched, []);
  });
});
