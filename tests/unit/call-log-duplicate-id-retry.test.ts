import test from "node:test";
import assert from "node:assert/strict";
import { getDbInstance } from "../../src/lib/db/core.ts";
import { saveCallLog, getCallLogs } from "../../src/lib/usage/callLogs.ts";

// trackPendingRequest (src/lib/usage/usageHistory.ts) intentionally reuses ONE
// pending-request id across every attempt that shares a correlationId --
// combo fallbacks, zeroLatencyOptimizationsEnabled hedged racing targets, and
// stream-recovery retries all pass that same id straight through as
// `entry.id`. Two attempts finishing with the same id used to race an INSERT
// into call_logs (TEXT PRIMARY KEY): the loser threw
// "UNIQUE constraint failed: call_logs.id" and its row -- a real, separately
// billable provider call -- was silently dropped (only console.error'd).
test("saveCallLog keeps both rows when two attempts share the same id (combo fallback/hedge)", async () => {
  const db = getDbInstance();
  const sharedId = `test-shared-pending-${Date.now()}`;

  await saveCallLog({
    id: sharedId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "first-attempt-model",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 10, out: 5 },
    correlationId: "test-shared-correlation-id",
  });

  // Second attempt for the same client request (a fallback target, or a
  // hedged concurrent target) reuses the exact same id, same as production.
  await saveCallLog({
    id: sharedId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "second-attempt-model",
    provider: "test-provider",
    duration: 200,
    tokens: { in: 20, out: 15 },
    correlationId: "test-shared-correlation-id",
  });

  const rows = db
    .prepare(
      "SELECT id, model FROM call_logs WHERE correlation_id = ? ORDER BY model"
    )
    .all("test-shared-correlation-id") as Array<{ id: string; model: string }>;

  assert.equal(rows.length, 2, "both attempts must persist their own row, none silently dropped");
  assert.deepEqual(
    rows.map((r) => r.model),
    ["first-attempt-model", "second-attempt-model"]
  );

  const firstRow = rows.find((r) => r.model === "first-attempt-model")!;
  const secondRow = rows.find((r) => r.model === "second-attempt-model")!;
  assert.equal(firstRow.id, sharedId, "the first attempt keeps the shared pending id");
  assert.notEqual(
    secondRow.id,
    sharedId,
    "the colliding attempt gets a freshly minted id instead of losing its row"
  );

  const logs = await getCallLogs({ limit: 10 });
  const foundIds = new Set(logs.map((l: { id: string }) => l.id));
  assert.ok(foundIds.has(firstRow.id));
  assert.ok(foundIds.has(secondRow.id));

  db.prepare("DELETE FROM call_logs WHERE correlation_id = ?").run(
    "test-shared-correlation-id"
  );
});
