import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-attempt-timing-migration-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("attempt timing migration adds durable routing signal columns", () => {
  const db = core.getDbInstance();
  const columns = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
  const expected = [
    "upstream_headers_ms",
    "ttft_ms",
    "outcome_source",
    "upstream_status",
    "upstream_request_id",
    "upstream_lifecycle_status",
  ];
  const callLogColumns = columns("call_logs");
  for (const name of expected) assert.ok(callLogColumns.has(name), `call_logs.${name}`);
  const usageColumns = columns("usage_history");
  for (const name of expected.filter((name) => name !== "ttft_ms")) {
    assert.ok(usageColumns.has(name), `usage_history.${name}`);
  }

  const indexes = db.prepare("PRAGMA index_list(call_logs)").all() as Array<{ name: string }>;
  assert.ok(indexes.some((index) => index.name === "idx_cl_provider_connection_model_time"));
});
