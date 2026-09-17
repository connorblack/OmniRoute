// Regression guard for tests/_setup/isolateDataDir.ts — the test-only module that
// gives each test process its own DATA_DIR so concurrent test files never share the
// on-disk SQLite DB. Removing or breaking it brings back the cross-file state races
// (the `test:unit` hang under high concurrency and the non-deterministic Stryker
// baseline that forced concurrency: 1).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function dataDirFromChild(envDataDir: string | undefined): string {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/_setup/isolateDataDir.ts",
      "-e",
      "console.log(process.env.DATA_DIR ?? '')",
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      // Pass DATA_DIR through verbatim; an empty string means "unset" for the module's
      // `if (!process.env.DATA_DIR)` guard.
      env: { ...process.env, DATA_DIR: envDataDir ?? "" },
    }
  );
  return result.stdout.trim().split("\n").pop() ?? "";
}

test("isolateDataDir assigns a unique temp DATA_DIR when none is set", () => {
  const a = dataDirFromChild(undefined);
  const b = dataDirFromChild(undefined);

  assert.ok(a.startsWith(os.tmpdir()), `expected a temp dir under ${os.tmpdir()}, got ${a}`);
  assert.match(a, /omniroute-test-/, `expected the omniroute-test- prefix, got ${a}`);
  assert.notEqual(a, b, "two processes must each get their own DATA_DIR");
});

test("isolateDataDir respects an explicitly set DATA_DIR", () => {
  const explicit = "/tmp/omniroute-explicit-fixture";
  assert.equal(dataDirFromChild(explicit), explicit);
});

const DEVELOPER_HOME = path.join(os.tmpdir(), "developer-home");
const DEVELOPER_ENV = {
  HOME: DEVELOPER_HOME,
  XDG_CONFIG_HOME: path.join(DEVELOPER_HOME, ".config"),
  CLI_CONFIG_HOME: DEVELOPER_HOME,
  OMNIROUTE_API_KEY: "sk-developer-omniroute",
  JINA_API_KEY: "jina-developer-key",
  OMNIROUTE_TEST_BASE: "http://127.0.0.1:20128",
};

function environmentSeenBy(testFile: string) {
  const script = `console.log(JSON.stringify({
    home: require("node:os").homedir(),
    xdg: process.env.XDG_CONFIG_HOME ?? null,
    cliHome: process.env.CLI_CONFIG_HOME ?? null,
    omnirouteKey: process.env.OMNIROUTE_API_KEY ?? null,
    jinaKey: process.env.JINA_API_KEY ?? null,
    testBase: process.env.OMNIROUTE_TEST_BASE ?? null,
  }))`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", "./tests/_setup/isolateDataDir.ts", "-e", script, testFile],
    { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, ...DEVELOPER_ENV } }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

test("unit tests never see the developer's home, config dirs, or API keys", () => {
  const seen = environmentSeenBy(path.join("tests", "unit", "isolate-datadir.test.ts"));

  assert.notEqual(seen.home, DEVELOPER_HOME);
  assert.match(path.basename(seen.home), /^omniroute-test-home-/);
  assert.equal(seen.xdg, null);
  assert.equal(seen.cliHome, null);
  assert.equal(seen.omnirouteKey, null);
  assert.equal(seen.jinaKey, null);
  assert.equal(seen.testBase, DEVELOPER_ENV.OMNIROUTE_TEST_BASE);
});

test("integration suites keep the ambient credentials they opt into", () => {
  const seen = environmentSeenBy(path.join("tests", "integration", "live.test.ts"));

  assert.equal(seen.home, DEVELOPER_ENV.HOME);
  assert.equal(seen.xdg, DEVELOPER_ENV.XDG_CONFIG_HOME);
  assert.equal(seen.omnirouteKey, DEVELOPER_ENV.OMNIROUTE_API_KEY);
  assert.equal(seen.jinaKey, DEVELOPER_ENV.JINA_API_KEY);
});
