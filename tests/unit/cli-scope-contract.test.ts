import test from "node:test";
import assert from "node:assert/strict";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    exitCode: status >= 200 && status < 300 ? 0 : 69,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("status labels workstation state as local", async () => {
  const { collectStatus } = await import("../../bin/cli/commands/status.mjs");
  const result = await collectStatus({ verbose: false });
  assert.equal(result.scope, "local");
  assert.ok("database" in result);
  assert.ok(!("health" in result));
});

test("status remote reads the selected gateway and excludes workstation paths", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return response({ status: "healthy", activeConnections: 7 });
  }) as typeof fetch;
  try {
    const { collectStatus } = await import("../../bin/cli/commands/status.mjs");
    const result = await collectStatus({
      remote: true,
      baseUrl: "https://remote.example.test",
      context: "remote",
      timeout: "120000",
    });
    assert.equal(requestedUrl, "https://remote.example.test/api/monitoring/health");
    assert.equal(result.scope, "remote");
    assert.equal(result.target, "https://remote.example.test");
    assert.deepEqual(result.health, { status: "healthy", activeConnections: 7 });
    assert.ok(!("dataDir" in result));
    assert.ok(!("database" in result));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote doctor runs gateway checks without reading workstation state", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    if (String(url).endsWith("/api/monitoring/health")) {
      return response({ status: "healthy", circuitBreakers: { open: 0 } });
    }
    if (String(url).endsWith("/api/usage/provider-limits")) {
      return response({ caches: {} });
    }
    return response([]);
  }) as typeof fetch;
  try {
    const { collectRemoteDoctorChecks } = await import("../../bin/cli/commands/doctor.mjs");
    const result = await collectRemoteDoctorChecks({
      baseUrl: "https://remote.example.test",
      context: "remote",
      timeout: "120000",
    });
    assert.equal(result.scope, "remote");
    assert.equal(result.target, "https://remote.example.test");
    assert.equal(result.summary.fail, 0);
    assert.ok(requested.some((url) => url.endsWith("/api/monitoring/health")));
    assert.ok(requested.some((url) => url.endsWith("/api/usage/provider-limits")));
    assert.ok(requested.some((url) => url.endsWith("/api/resilience/model-cooldowns")));
    assert.ok(!("dataDir" in result));
    assert.ok(!("dbPath" in result));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
