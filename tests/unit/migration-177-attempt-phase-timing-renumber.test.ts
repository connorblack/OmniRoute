import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The fork's 177_attempt_phase_timing collided with upstream's
// 177_provider_connection_synced_models_at and moved to 180. A database that
// recorded the fork migration as 177 must move that ledger row to 180 and then
// run upstream's 177, instead of skipping it as already applied.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-migration-177-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

let core: typeof import("../../src/lib/db/core.ts");

function columns(table: string): string[] {
  return (
    core.getDbInstance().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function ledger(version: string): string | undefined {
  const row = core
    .getDbInstance()
    .prepare("SELECT name FROM _omniroute_migrations WHERE version = ?")
    .get(version) as { name: string } | undefined;
  return row?.name;
}

before(async () => {
  core = await import("../../src/lib/db/core.ts");
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

test("a fresh install applies both migrations under their own versions", () => {
  core.getDbInstance();
  assert.equal(ledger("177"), "provider_connection_synced_models_at");
  assert.equal(ledger("180"), "attempt_phase_timing");
  assert.ok(columns("provider_connections").includes("synced_models_at"));
  assert.ok(columns("call_logs").includes("upstream_request_id"));
});

test("a database that recorded attempt_phase_timing as 177 is reconciled", () => {
  const db = core.getDbInstance();
  db.exec("ALTER TABLE provider_connections DROP COLUMN synced_models_at");
  db.prepare("DELETE FROM _omniroute_migrations WHERE version IN ('177', '180')").run();
  db.prepare(
    "INSERT INTO _omniroute_migrations (version, name) VALUES ('177', 'attempt_phase_timing')"
  ).run();
  core.resetDbInstance();

  core.getDbInstance();
  assert.equal(ledger("177"), "provider_connection_synced_models_at");
  assert.equal(ledger("180"), "attempt_phase_timing");
  assert.ok(columns("provider_connections").includes("synced_models_at"));
  assert.ok(columns("call_logs").includes("upstream_request_id"));
});
