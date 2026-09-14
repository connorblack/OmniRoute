import test from "node:test";
import assert from "node:assert/strict";

function response(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Service Unavailable",
    exitCode: status >= 200 && status < 300 ? 0 : 69,
    headers: new Headers({
      "content-type": "application/json",
      "x-request-id": "remote-request-id",
    }),
    json: async () => body,
    text: async () => text,
  };
}

test("openapi try sends the request directly to the selected remote context", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedMethod = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedMethod = String(init?.method);
    return response({ items: ["nvidia"] });
  }) as typeof fetch;
  try {
    const { runOpenapiTry } = await import("../../bin/cli/commands/openapi.mjs");
    const result = await runOpenapiTry(
      "/api/providers",
      {
        method: "GET",
        query: [["provider", "nvidia"]],
        header: [],
      },
      {
        baseUrl: "https://remote.example.test",
        context: "remote",
        timeout: "120000",
      }
    );
    assert.equal(requestedUrl, "https://remote.example.test/api/providers?provider=nvidia");
    assert.equal(requestedMethod, "GET");
    assert.deepEqual(result, {
      status: 200,
      statusText: "OK",
      contentType: "application/json",
      requestId: "remote-request-id",
      body: { items: ["nvidia"] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openapi try rejects absolute targets before credentials can leave the context", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return response({});
  }) as typeof fetch;
  try {
    const { runOpenapiTry } = await import("../../bin/cli/commands/openapi.mjs");
    await assert.rejects(
      () =>
        runOpenapiTry(
          "https://other.example.test/api/providers",
          { method: "GET", query: [], header: [] },
          { baseUrl: "https://remote.example.test" }
        ),
      /relative path/i
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openapi try rejects a non-success remote response with its typed exit code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    response({ error: { message: "capacity" } }, 503)) as typeof fetch;
  try {
    const { runOpenapiTry } = await import("../../bin/cli/commands/openapi.mjs");
    await assert.rejects(
      () =>
        runOpenapiTry(
          "/api/providers",
          { method: "GET", query: [], header: [] },
          { baseUrl: "https://remote.example.test", retry: false }
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "capacity" &&
        Reflect.get(error, "exitCode") === 1
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
