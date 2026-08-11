import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);
const { resolveMitmServerDataDir } = requireCjs("../../src/mitm/_internal/dataDir.cjs") as {
  resolveMitmServerDataDir: (options?: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
  }) => string;
};

test("standalone MITM resolver gives DATA_DIR precedence over XDG_CONFIG_HOME", () => {
  const root = path.join(path.sep, "tmp", "omniroute-mitm-data-dir");
  const actual = resolveMitmServerDataDir({
    env: {
      DATA_DIR: path.join(root, "explicit"),
      XDG_CONFIG_HOME: path.join(root, "xdg"),
    },
    homeDir: path.join(root, "home"),
    platform: "darwin",
  });

  assert.equal(actual, path.join(root, "explicit"));
});

test("standalone MITM resolver uses XDG_CONFIG_HOME on macOS/Linux", () => {
  const root = path.join(path.sep, "tmp", "omniroute-mitm-xdg");
  const actual = resolveMitmServerDataDir({
    env: { XDG_CONFIG_HOME: path.join(root, "config") },
    homeDir: path.join(root, "home"),
    platform: "darwin",
  });

  assert.equal(actual, path.join(root, "config", "omniroute"));
});

test("standalone MITM resolver preserves platform fallback paths", () => {
  const root = path.join(path.sep, "tmp", "omniroute-mitm-fallback");

  assert.equal(
    resolveMitmServerDataDir({
      env: {},
      homeDir: path.join(root, "home"),
      platform: "linux",
    }),
    path.join(root, "home", ".omniroute")
  );
  assert.equal(
    resolveMitmServerDataDir({
      env: { APPDATA: path.join(root, "app-data") },
      homeDir: path.join(root, "home"),
      platform: "win32",
    }),
    path.join(root, "app-data", "omniroute")
  );
});
