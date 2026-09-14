import test from "node:test";
import assert from "node:assert/strict";

import { runLogsCommand } from "../../bin/cli/commands/logs.mjs";

test("logs returns nonzero when the remote stream cannot be opened", async () => {
  const code = await runLogsCommand({
    baseUrl: "http://127.0.0.1:9",
    timeout: "100",
    output: "json",
  });
  assert.notEqual(code, 0);
});
