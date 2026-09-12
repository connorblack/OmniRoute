import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression: GET /api/usage/call-logs?combo=<name> returned the same
// newest-N rows for every one of 41 live combo names, including rows from
// other combos, because buildCallLogFilterSql() only asked "does this row
// have a combo" (`combo_name IS NOT NULL`) and never compared the name the
// caller passed in.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-combo-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100000";

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");

function insertCallLog(row: Record<string, unknown>) {
  const db = core.getDbInstance();
  db.prepare(
    `
    INSERT INTO call_logs (
      id, timestamp, method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, cache_source, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary
    )
    VALUES (
      @id, @timestamp, @method, @path, @status, @model, @requested_model, @provider, @account,
      @connection_id, @duration, @tokens_in, @tokens_out, @cache_source, @source_format, @target_format,
      @api_key_id, @api_key_name, @combo_name, @combo_step_id, @combo_execution_key,
      @error_summary, @detail_state, @artifact_relpath, @artifact_size_bytes, @artifact_sha256,
      @has_request_body, @has_response_body, @has_pipeline_details, @request_summary
    )
  `
  ).run({
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    requested_model: null,
    provider: "openai",
    account: null,
    connection_id: null,
    duration: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_source: "upstream",
    source_format: null,
    target_format: null,
    api_key_id: null,
    api_key_name: null,
    combo_name: null,
    combo_step_id: null,
    combo_execution_key: null,
    error_summary: null,
    detail_state: "none",
    artifact_relpath: null,
    artifact_size_bytes: null,
    artifact_sha256: null,
    has_request_body: 0,
    has_response_body: 0,
    has_pipeline_details: 0,
    request_summary: null,
    ...row,
  });
}

test.before(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  insertCallLog({ id: "log_00", timestamp: "2026-05-22T10:00:00.000Z", combo_name: null });
  insertCallLog({
    id: "log_01",
    timestamp: "2026-05-22T10:01:00.000Z",
    combo_name: "pool/subagent",
  });
  insertCallLog({
    id: "log_02",
    timestamp: "2026-05-22T10:02:00.000Z",
    combo_name: "pool/claude-fable-5",
  });
  insertCallLog({
    id: "log_03",
    timestamp: "2026-05-22T10:03:00.000Z",
    combo_name: "pool/subagent",
  });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("combo=<name> returns only rows for that exact combo", async () => {
  const rows = await callLogs.getCallLogs({ combo: "pool/subagent", limit: 5000 });
  assert.deepEqual(
    rows.map((r: { id: string }) => r.id).sort(),
    ["log_01", "log_03"]
  );
});

test("combo=<name> for a different combo returns a disjoint set", async () => {
  const rows = await callLogs.getCallLogs({ combo: "pool/claude-fable-5", limit: 5000 });
  assert.deepEqual(
    rows.map((r: { id: string }) => r.id),
    ["log_02"]
  );
});

test("combo=<name> with no matching rows returns empty, not the newest page", async () => {
  const rows = await callLogs.getCallLogs({ combo: "pool/does-not-exist", limit: 5000 });
  assert.deepEqual(rows, []);
});

test("combo=1 keeps its presence-flag meaning (any combo assigned)", async () => {
  const rows = await callLogs.getCallLogs({ combo: "1", limit: 5000 });
  assert.deepEqual(
    rows.map((r: { id: string }) => r.id).sort(),
    ["log_01", "log_02", "log_03"]
  );
});

test("no combo filter returns every row, unfiltered", async () => {
  const rows = await callLogs.getCallLogs({ limit: 5000 });
  assert.equal(rows.length, 4);
});
