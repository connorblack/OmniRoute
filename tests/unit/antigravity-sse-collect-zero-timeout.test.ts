import { test } from "node:test";
import assert from "node:assert/strict";

test("collectStreamToResponse treats FETCH_TIMEOUT_MS=0 as disabled instead of an immediate timeout", async () => {
  const originalTimeoutEnv = process.env.FETCH_TIMEOUT_MS;
  process.env.FETCH_TIMEOUT_MS = "0";
  try {
    const { AntigravityExecutor } = await import(
      `../../open-sse/executors/antigravity.ts?case=zero-timeout-${Date.now()}`
    );
    const executor = new AntigravityExecutor();

    const chunk = new TextEncoder().encode(
      `data: ${JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
        },
      })}\n\n`
    );
    const reads = [chunk];
    const fakeReader = {
      read: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            const value = reads.shift();
            resolve(value ? { done: false, value } : { done: true, value: undefined });
          }, 20)
        ),
      releaseLock: () => {},
    };
    const response = {
      status: 200,
      statusText: "OK",
      body: { getReader: () => fakeReader, cancel: () => Promise.resolve() },
    } as unknown as Response;

    const result = await executor.collectStreamToResponse(
      response,
      "gemini-3.1-flash-lite",
      "https://example.invalid/sse",
      {},
      {},
      null,
      null
    );

    assert.equal(result.response.status, 200, "a body slower than one timer tick must not become a 504");
    const payload = await result.response.json();
    assert.equal(payload.choices[0].message.content, "hello");
  } finally {
    if (originalTimeoutEnv === undefined) delete process.env.FETCH_TIMEOUT_MS;
    else process.env.FETCH_TIMEOUT_MS = originalTimeoutEnv;
  }
});
