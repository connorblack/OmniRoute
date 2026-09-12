import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllog-ids-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
// A bundler can give separate route chunks their own copy of this module, each with its own state.
const siblingCallLogs = await import(
  new URL("../../src/lib/usage/callLogs.ts?sibling-bundle", import.meta.url).href
);

test.after(async () => {
  await callLogs.closeCallLogSaves();
  await siblingCallLogs.closeCallLogSaves();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function entry(model: string) {
  return {
    timestamp: "2026-09-12T01:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model,
    provider: "openai",
    duration: 1,
  };
}

test("saveCallLog keeps both rows when two module copies log in the same millisecond", async () => {
  const realNow = Date.now;
  Date.now = () => 1_789_200_000_000;
  try {
    await callLogs.saveCallLog(entry("openai/first"));
    await siblingCallLogs.saveCallLog(entry("openai/second"));
  } finally {
    Date.now = realNow;
  }

  const logs = await callLogs.getCallLogs({ limit: 10 });
  assert.equal(logs.length, 2);
});
