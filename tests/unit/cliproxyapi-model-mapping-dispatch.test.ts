/**
 * Regression tests for #6876 — `cliproxyapiModelMapping` was persisted by the
 * dashboard (`upstream_proxy_config.cliproxyapi_model_mapping`) but never
 * consulted at request-dispatch time: the mapped model never made it onto the
 * outbound CLIProxyAPI wire request.
 *
 * All tests exercise REAL production functions end-to-end:
 *   - upsertUpstreamProxyConfig (src/lib/db/upstreamProxy.ts)
 *   - resolveExecutorWithProxy (open-sse/handlers/chatCore/executorProxy.ts)
 *   - CliproxyapiExecutor.execute (open-sse/executors/cliproxyapi.ts)
 * `globalThis.fetch` is stubbed only to capture the outbound wire body.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-6876-model-mapping-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const upstreamProxyDb = await import("../../src/lib/db/upstreamProxy.ts");
const { resolveExecutorWithProxy } =
  await import("../../open-sse/handlers/chatCore/executorProxy.ts");
const { clearUpstreamProxyConfigCache } =
  await import("../../open-sse/handlers/chatCore/comboContextCache.ts");

before(async () => {
  await coreDb.ensureDbInitialized();
});

afterEach(() => {
  clearUpstreamProxyConfigCache();
});

after(() => {
  coreDb.resetDbInstance();
  if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
});

type ExecuteInput = {
  model: string;
  body: unknown;
  stream: boolean;
  credentials: unknown;
};

type ExecutorLike = { execute: (input: ExecuteInput) => Promise<unknown> };

async function captureFetchBody(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | null = null;
  const originalFetch = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(capturedBody, "executor should have issued a fetch call");
  return capturedBody as Record<string, unknown>;
}

describe("#6876 — cliproxyapiModelMapping applied at dispatch", () => {
  it("forwards the MAPPED model to CLIProxyAPI in cliproxyapi (passthrough) mode", async () => {
    await upstreamProxyDb.upsertUpstreamProxyConfig({
      providerId: "anthropic-mapped-passthrough",
      mode: "cliproxyapi",
      enabled: true,
      cliproxyapiModelMapping: { "claude-3-opus": "claude-3-opus-mapped" },
    });

    const executor = await resolveExecutorWithProxy(
      "anthropic-mapped-passthrough",
      undefined,
      null
    );
    assert.equal(
      (executor as { provider?: string }).provider,
      "cliproxyapi",
      "sanity: provider should route through the cliproxyapi executor"
    );

    const capturedBody = await captureFetchBody(() =>
      (executor as ExecutorLike).execute({
        model: "claude-3-opus",
        body: { model: "claude-3-opus", messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "test-key" },
      })
    );

    assert.equal(
      capturedBody.model,
      "claude-3-opus-mapped",
      `expected mapped model "claude-3-opus-mapped" to be forwarded upstream, got unmapped "${capturedBody.model}"`
    );
  });

  it("converts a Gemini-native mapped request to CLIProxyAPI's OpenAI wire format", async () => {
    await upstreamProxyDb.upsertUpstreamProxyConfig({
      providerId: "gemini-mapped-passthrough",
      mode: "cliproxyapi",
      enabled: true,
      cliproxyapiModelMapping: { "gemini-fallback-alias": "gemini-3-flash" },
    });

    const executor = await resolveExecutorWithProxy("gemini-mapped-passthrough", undefined, null);
    let executorResult: unknown;
    const capturedBody = await captureFetchBody(async () => {
      executorResult = await (executor as ExecutorLike).execute({
        model: "gemini-fallback-alias",
        body: {
          model: "gemini-fallback-alias",
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 32 },
          systemInstruction: { role: "system", parts: [{ text: "Be brief" }] },
        },
        stream: false,
        credentials: {},
      });
      return executorResult;
    });

    assert.equal(capturedBody.model, "gemini-3-flash");
    assert.ok(Array.isArray(capturedBody.messages));
    assert.equal(capturedBody.contents, undefined);
    assert.equal(capturedBody.generationConfig, undefined);
    assert.equal(capturedBody.systemInstruction, undefined);
    assert.equal((executorResult as { responseFormat?: string }).responseFormat, "openai");
  });

  it("does NOT remap the model when no mapping is configured (no regression)", async () => {
    await upstreamProxyDb.upsertUpstreamProxyConfig({
      providerId: "anthropic-no-mapping",
      mode: "cliproxyapi",
      enabled: true,
    });

    const executor = await resolveExecutorWithProxy("anthropic-no-mapping", undefined, null);

    const capturedBody = await captureFetchBody(() =>
      (executor as ExecutorLike).execute({
        model: "claude-3-opus",
        body: { model: "claude-3-opus", messages: [{ role: "user", content: "hi" }] },
        stream: false,
        credentials: { apiKey: "test-key" },
      })
    );

    assert.equal(capturedBody.model, "claude-3-opus", "unmapped model must pass through unchanged");
  });
});
