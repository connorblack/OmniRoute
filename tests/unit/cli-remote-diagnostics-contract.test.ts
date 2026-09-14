import test from "node:test";
import assert from "node:assert/strict";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    optsWithGlobals: () => ({
      output: "json",
      quiet: true,
      baseUrl: "https://remote.example",
      context: "production",
      timeout: "120000",
      ...overrides,
    }),
  };
}

async function captureStdout(run: () => Promise<void>) {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("friendly usage commands forward the selected remote target", async () => {
  const original = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return response({ items: [] });
  }) as typeof fetch;
  try {
    const { runUsageHistory } = await import("../../bin/cli/commands/usage.mjs");
    await captureStdout(() => runUsageHistory({ limit: 2 }, command()));
    assert.equal(new URL(requestedUrl).origin, "https://remote.example");
  } finally {
    globalThis.fetch = original;
  }
});

test("friendly usage commands reject non-success HTTP responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  globalThis.fetch = (async () => response({ error: { message: "remote failed" } }, 503)) as typeof fetch;
  process.exit = ((code?: number) => {
    throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
  }) as typeof process.exit;
  try {
    const { runUsageHistory } = await import("../../bin/cli/commands/usage.mjs");
    await assert.rejects(
      () => captureStdout(() => runUsageHistory({ limit: 2 }, command())),
      (error: Error & { status?: number; exitCode?: number }) => {
        assert.equal(error.message, "remote failed");
        assert.equal(error.status, 503);
        assert.equal(error.exitCode, 1);
        return true;
      }
    );
  } finally {
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
  }
});

test("usage logs preserve the structured call-log contract", async () => {
  const original = globalThis.fetch;
  const call = {
    id: "call-1",
    timestamp: "2026-09-14T00:00:00Z",
    provider: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    requestedModel: "sellie/extractor",
    connectionId: "connection-1",
    correlationId: "correlation-1",
    comboName: "sellie/extractor",
    comboStepId: "ultra",
    status: 503,
    duration: 30123,
    error: "capacity",
    tokens: { in: 10, out: 0, cacheRead: null, cacheWrite: null, reasoning: null },
  };
  globalThis.fetch = (async () => response([call])) as typeof fetch;
  try {
    const { runUsageLogs } = await import("../../bin/cli/commands/usage.mjs");
    const stdout = await captureStdout(() =>
      runUsageLogs({ limit: 2, search: "correlation-1" }, command())
    );
    const rows = JSON.parse(stdout);
    assert.deepEqual(rows, [call]);
  } finally {
    globalThis.fetch = original;
  }
});
