import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-stable-"));
process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100000";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const route = await import("../../src/app/api/usage/call-logs/route.ts");

function insert(id: string, timestamp: string) {
  core
    .getDbInstance()
    .prepare(
      `INSERT INTO call_logs
       (id, timestamp, method, path, status, model, provider, duration, tokens_in, tokens_out)
       VALUES (?, ?, 'POST', '/v1/chat/completions', 200, 'model', 'provider', 10, 1, 1)`
    )
    .run(id, timestamp);
}

test.before(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(dataDir, { recursive: true });
  insert("a", "2026-09-14T10:05:00.000Z");
  insert("b", "2026-09-14T10:04:00.000Z");
  insert("c", "2026-09-14T10:04:00.000Z");
  insert("d", "2026-09-14T10:03:00.000Z");
  insert("e", "2026-09-14T10:02:00.000Z");
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("call-log cursor stays stable when a newer row arrives", async () => {
  const first = await callLogs.getCallLogs({ limit: 2 });
  assert.deepEqual(first.map((row: { id: string }) => row.id), ["a", "c"]);

  insert("z", "2026-09-14T10:06:00.000Z");
  const second = await callLogs.getCallLogs({
    limit: 2,
    beforeTimestamp: first[1].timestamp,
    beforeId: first[1].id,
  });

  assert.deepEqual(second.map((row: { id: string }) => row.id), ["b", "d"]);
});

test("merged call-log rows prefer persisted state over a stale pending row", () => {
  const rows = route.buildCallLogListRows({
    logs: [{ id: "same", timestamp: "2026-09-14T10:00:00.000Z", status: 503 }],
    connections: [],
    pendingDetails: [
      {
        id: "same",
        startedAt: Date.parse("2026-09-14T09:59:00.000Z"),
        model: "model",
        provider: "provider",
      },
    ],
    completedDetails: [],
    now: Date.parse("2026-09-14T10:01:00.000Z"),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 503);
  assert.equal(rows[0].active, undefined);
});

test("final call-log page applies one limit after merging and returns a cursor", () => {
  const rows = [
    { id: "a", timestamp: "2026-09-14T10:05:00.000Z" },
    { id: "c", timestamp: "2026-09-14T10:04:00.000Z" },
    { id: "b", timestamp: "2026-09-14T10:04:00.000Z" },
  ];
  const page = route.finalizeCallLogPage(rows, 2);
  assert.deepEqual(page.items.map((row: { id: string }) => row.id), ["a", "c"]);
  assert.equal(typeof page.nextCursor, "string");
  assert.deepEqual(route.decodeCallLogCursor(page.nextCursor), {
    timestamp: "2026-09-14T10:04:00.000Z",
    id: "c",
  });
});
