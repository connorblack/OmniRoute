// Test-only DATA_DIR isolation.
//
// Loaded via `node --import ./tests/_setup/isolateDataDir.ts` from the test/mutation
// invocations (package.json test scripts, stryker.conf.json tap.nodeArgs, the
// quality.yml TIA step, and the CI test jobs) — NEVER from production. It MUST stay
// out of open-sse/utils/setupPolyfill.ts, which is also imported by production
// (bin/omniroute.mjs, proxyFetch.ts, proxyDispatcher.ts) where redirecting DATA_DIR
// would point the live SQLite DB at a throwaway temp dir.
//
// Why: node:test spawns a process per test file and Stryker spawns one per sandbox,
// but every process resolves DATA_DIR to the SAME default (~/.omniroute) when the env
// var is unset (see src/lib/dataPaths.ts::resolveDataDir). Concurrent processes then
// open the SAME on-disk storage.sqlite, causing cross-file state races: SQLite lock
// contention that hangs `test:unit` under high `--test-concurrency`, and the
// non-deterministic baseline that forced Stryker to `concurrency: 1`.
//
// Giving each process its own DATA_DIR under the OS temp dir removes the shared file,
// so concurrent test processes never collide. Tests that set DATA_DIR explicitly keep
// winning — this only fills in an isolated default when none was chosen.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// File logger worker threads can outlive a test's temporary DATA_DIR cleanup and then
// raise ENOENT/ENOTEMPTY after the test has already passed. Keep the global test default
// console-only; tests that cover file logging explicitly set APP_LOG_TO_FILE themselves.
process.env.APP_LOG_TO_FILE ||= "false";

// Best-effort cleanup so a long suite run does not leak hundreds of temp dirs.
function removeOnExit(dir: string): void {
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore — the OS reaps its temp dir eventually.
    }
  });
}

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-"));
  removeOnExit(process.env.DATA_DIR);
}

// Developer-machine guard: unit tests must pass the same on a contributor's laptop as on
// a clean CI runner. A contributor's shell carries real provider keys, an OmniRoute
// client key and config-dir relocations, and their home holds real CLI configs
// (~/.config/opencode/opencode.jsonc). Product code reads all of these, so unit tests
// asserting "no provider configured" or "default config path" failed only locally.
// Each unit-test process gets an empty temp HOME and none of those variables; a test that
// needs one sets it after this module has run. Integration and live suites keep the
// ambient environment because they opt into real credentials (OMNIROUTE_API_KEY) on purpose.
const CONFIG_HOME_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLI_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLIPROXYAPI_CONFIG_DIR",
  "CODEX_CHATGPT_WEB_HOME",
  "CODEX_HOME",
  "DEVIN_AGENTIC_HOME",
  "GROK_HOME",
  "HERMES_HOME",
  "QODER_CLI_CONFIG_DIR",
  "QWEN_HOME",
];
const CREDENTIAL_VARIABLE = /_API_KEY$/;
const UNIT_TESTS_DIR = `${path.sep}tests${path.sep}unit${path.sep}`;

const runsUnitTests = process.argv
  .slice(1)
  .some((arg) => path.resolve(arg).includes(UNIT_TESTS_DIR));

if (runsUnitTests) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-home-"));
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  removeOnExit(home);

  for (const name of Object.keys(process.env)) {
    if (CONFIG_HOME_VARIABLES.includes(name) || CREDENTIAL_VARIABLE.test(name)) {
      delete process.env[name];
    }
  }
}

// System-trust guard: the suite must NEVER mutate the OS trust store. On a
// persistent self-hosted runner the cert-flow integration test installed a fake
// 105-byte PEM into /usr/local/share/ca-certificates and update-ca-certificates
// baked it into the bundle, breaking ALL system TLS on the VM (2026-07-05).
// installCert/uninstallCert/installTproxyCa/uninstallTproxyCa no-op under this.
process.env.OMNIROUTE_SKIP_SYSTEM_TRUST = "1";

// Browser-spawn guard: the Adobe Firefly session warm (adobeFireflySession.ts)
// spawns the SYSTEM Chrome with --remote-debugging-port whenever a test reaches it
// without a valid user JWT — which any mocked-fetch test does by construction.
// Per-call-site allowBrowserRefresh/tryBrowser flags are not enough: the warm is also
// reachable indirectly via client/handler paths, so the guard must be global.
// ||= (not =) so a browser-path integration test can still opt back in.
process.env.ADOBE_FIREFLY_BROWSER_REFRESH ||= "0";

// DNS-write guard: the suite must NEVER mutate /etc/hosts. Tests that exercise
// the real MITM path call addDNSEntries(); this env var makes it a no-op.
process.env.OMNIROUTE_SKIP_DNS_WRITE = "1";
