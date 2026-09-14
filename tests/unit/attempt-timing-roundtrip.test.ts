import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-attempt-timing-roundtrip-"));
process.env.DATA_DIR = dataDir;

const core = await import("../../src/lib/db/core.ts");
const { saveCallLog, getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const { saveRequestUsage, getUsageHistory } = await import("../../src/lib/usageDb.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("attempt timing and provenance survive both persistence paths", async () => {
  const common = {
    upstreamHeadersMs: 42,
    requestToHeadersMs: 57,
    outcomeSource: "upstream",
    upstreamStatus: 503,
    upstreamRequestId: "nvcf-test-request",
    upstreamLifecycleStatus: "errored",
  };

  await saveCallLog({
    id: "call-timing",
    timestamp: "2026-09-14T01:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 503,
    provider: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    connectionId: "connection-3",
    duration: 63,
    terminalMs: 63,
    ttftMs: 57,
    ...common,
  });

  const [call] = await getCallLogs({ limit: 1 });
  assert.equal(call.id, "call-timing");
  assert.equal(call.upstreamHeadersMs, 42);
  assert.equal(call.requestToHeadersMs, 57);
  assert.equal(call.terminalMs, 63);
  assert.equal(call.ttftMs, 57);
  assert.equal(call.outcomeSource, "upstream");
  assert.equal(call.upstreamStatus, 503);
  assert.equal(call.upstreamRequestId, "nvcf-test-request");
  assert.equal(call.upstreamLifecycleStatus, "errored");

  await saveRequestUsage({
    provider: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    connectionId: "connection-3",
    status: "503",
    success: false,
    latencyMs: 63,
    timeToFirstTokenMs: 57,
    timestamp: "2026-09-14T01:00:00.000Z",
    ...common,
  });

  const [usage] = await getUsageHistory({ provider: "nvidia", limit: 1 });
  assert.equal(usage.upstreamHeadersMs, 42);
  assert.equal(usage.requestToHeadersMs, 57);
  assert.equal(usage.outcomeSource, "upstream");
  assert.equal(usage.upstreamStatus, 503);
  assert.equal(usage.upstreamRequestId, "nvcf-test-request");
  assert.equal(usage.upstreamLifecycleStatus, "errored");

  await saveCallLog({
    id: "call-relay-timeout",
    timestamp: "2026-09-14T01:01:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 502,
    provider: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    connectionId: "connection-3",
    duration: 25000,
    terminalMs: 25000,
    ttftMs: null,
    upstreamHeadersMs: null,
    requestToHeadersMs: null,
    outcomeSource: "relay",
    upstreamStatus: null,
    upstreamRequestId: null,
    upstreamLifecycleStatus: null,
  });
  const [relayCall] = await getCallLogs({ limit: 1 });
  assert.equal(relayCall.id, "call-relay-timeout");
  assert.equal(relayCall.ttftMs, null);
  assert.equal(relayCall.upstreamHeadersMs, null);
  assert.equal(relayCall.upstreamStatus, null);
  assert.equal(relayCall.outcomeSource, "relay");

  await saveRequestUsage({
    provider: "nvidia",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    connectionId: "connection-3",
    status: "502",
    success: false,
    latencyMs: 25000,
    timeToFirstTokenMs: null,
    timestamp: "2026-09-14T01:01:00.000Z",
    upstreamHeadersMs: null,
    requestToHeadersMs: null,
    outcomeSource: "relay",
    upstreamStatus: null,
    upstreamRequestId: null,
    upstreamLifecycleStatus: null,
  });
  const [relayUsage] = await getUsageHistory({
    provider: "nvidia",
    limit: 1,
    sortOrder: "desc",
  });
  assert.equal(relayUsage.timeToFirstTokenMs, null);
  assert.equal(relayUsage.upstreamHeadersMs, null);
  assert.equal(relayUsage.upstreamStatus, null);
  assert.equal(relayUsage.outcomeSource, "relay");
});
