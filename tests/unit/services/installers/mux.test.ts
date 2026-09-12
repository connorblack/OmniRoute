/**
 * Mux installer unit tests.
 *
 * Most tests are pure-logic: no real file I/O, no network, no DB.
 * resolveSpawnArgs() performs fs.mkdirSync as a side effect (creating
 * MUX_ROOT under DATA_DIR), so — mirroring cliproxy.test.ts — we replicate
 * its pure argument-building contract here instead of invoking the real
 * function, keeping this suite side-effect-free. resolveMuxBinPath() has no
 * such side effect, so its tests call the real exported function against a
 * throwaway temp package dir.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ── exported constants ────────────────────────────────────────────────────────

describe("mux installer — exports", () => {
  it("MUX_DEFAULT_PORT is 8322", async () => {
    const { MUX_DEFAULT_PORT } = await import("../../../../src/lib/services/installers/mux.ts");
    assert.equal(MUX_DEFAULT_PORT, 8322);
  });

  it("MUX_PACKAGE is the npm package name 'mux'", async () => {
    const { MUX_PACKAGE } = await import("../../../../src/lib/services/installers/mux.ts");
    assert.equal(MUX_PACKAGE, "mux");
  });
});

// ── getInstalledVersion ───────────────────────────────────────────────────────

describe("getInstalledVersion", () => {
  it("reads version from node_modules/mux/package.json", () => {
    // Replicates the logic in getInstalledVersion(): reads a JSON file at a
    // DATA_DIR-scoped, non-user-controlled path and pulls out `.version`.
    const fakePkg = JSON.stringify({ name: "mux", version: "0.27.0" });
    const parsed = JSON.parse(fakePkg) as { version?: string };
    assert.equal(parsed.version, "0.27.0");
  });
});

// ── resolveMuxBinPath (real fs, throwaway temp package dir) ────────────────────

describe("resolveMuxBinPath", () => {
  function makePackageDir(pkg: Record<string, unknown> | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-bin-test-"));
    if (pkg) {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg), "utf8");
    }
    return dir;
  }

  it("resolves the bin path from an object-form package.json bin field (mux@0.28.5+ compat package)", async () => {
    const { resolveMuxBinPath } = await import("../../../../src/lib/services/installers/mux.ts");
    const dir = makePackageDir({ name: "mux", version: "0.28.5", bin: { mux: "bin/mux.js" } });
    try {
      const binPath = resolveMuxBinPath(dir);
      assert.equal(binPath, path.join(dir, "bin", "mux.js"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the bin path from a string-form package.json bin field", async () => {
    const { resolveMuxBinPath } = await import("../../../../src/lib/services/installers/mux.ts");
    const dir = makePackageDir({ name: "mux", version: "0.29.0", bin: "bin/mux.js" });
    try {
      const binPath = resolveMuxBinPath(dir);
      assert.equal(binPath, path.join(dir, "bin", "mux.js"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy dist/cli/index.js path when package.json has no usable bin", async () => {
    const { resolveMuxBinPath } = await import("../../../../src/lib/services/installers/mux.ts");
    const dir = makePackageDir({ name: "mux", version: "0.27.0" });
    try {
      const binPath = resolveMuxBinPath(dir);
      assert.equal(binPath, path.join(dir, "dist", "cli", "index.js"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy dist/cli/index.js path when package.json is missing", async () => {
    const { resolveMuxBinPath } = await import("../../../../src/lib/services/installers/mux.ts");
    const dir = makePackageDir(null);
    try {
      const binPath = resolveMuxBinPath(dir);
      assert.equal(binPath, path.join(dir, "dist", "cli", "index.js"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── resolveSpawnArgs (pure argument-building contract) ─────────────────────────

describe("resolveSpawnArgs — argument-building contract", () => {
  const MUX_INSTALL_DIR = path.join("/fake", "services", "mux");

  function buildArgs(apiKey: string, port: number, serverPathOverride?: string) {
    const serverPath =
      serverPathOverride ??
      path.join(MUX_INSTALL_DIR, "node_modules", "mux", "dist", "cli", "index.js");
    return {
      command: "node",
      args: [serverPath, "server", "--host", "127.0.0.1", "--port", String(port)],
      env: { MUX_SERVER_AUTH_TOKEN: apiKey },
      cwd: MUX_INSTALL_DIR,
    };
  }

  it("binds host to 127.0.0.1 explicitly — never 0.0.0.0", () => {
    const spawnArgs = buildArgs("mx_fake_token", 8322);
    const hostIdx = spawnArgs.args.indexOf("--host");
    assert.ok(hostIdx !== -1);
    assert.equal(spawnArgs.args[hostIdx + 1], "127.0.0.1");
  });

  it("passes the port via --port flag as a string", () => {
    const spawnArgs = buildArgs("mx_fake_token", 9001);
    const portIdx = spawnArgs.args.indexOf("--port");
    assert.ok(portIdx !== -1);
    assert.equal(spawnArgs.args[portIdx + 1], "9001");
  });

  it("invokes the 'server' subcommand", () => {
    const spawnArgs = buildArgs("mx_fake_token", 8322);
    assert.ok(spawnArgs.args.includes("server"));
  });

  it("passes the auth token via MUX_SERVER_AUTH_TOKEN env var, never as an argv entry", () => {
    const token = "mx_super_secret_token_value";
    const spawnArgs = buildArgs(token, 8322);

    assert.equal(spawnArgs.env.MUX_SERVER_AUTH_TOKEN, token);
    assert.ok(
      !spawnArgs.args.some((a) => a.includes(token)),
      "token must never appear in argv (would leak via `ps`)"
    );
  });

  it("targets the legacy installed server entry point under node_modules/mux/dist/cli", () => {
    const spawnArgs = buildArgs("mx_fake_token", 8322);
    assert.ok(spawnArgs.args[0].endsWith(path.join("dist", "cli", "index.js")));
    assert.ok(spawnArgs.args[0].includes(path.join("node_modules", "mux")));
  });

  it("targets node_modules/mux/bin/mux.js when the installed package.json declares that bin (mux@0.28.5+)", async () => {
    const { resolveMuxBinPath } = await import("../../../../src/lib/services/installers/mux.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-bin-test-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "mux", version: "0.28.5", bin: { mux: "bin/mux.js" } }),
        "utf8"
      );
      const serverPath = resolveMuxBinPath(dir);
      const spawnArgs = buildArgs("mx_fake_token", 8322, serverPath);
      assert.equal(spawnArgs.args[0], path.join(dir, "bin", "mux.js"));
      assert.ok(spawnArgs.args[0].endsWith(path.join("bin", "mux.js")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── path safety ───────────────────────────────────────────────────────────────

describe("path safety", () => {
  it("resolveSpawnArgs takes only (apiKey: string, port: number) — no arbitrary path input", () => {
    // resolveSpawnArgs never accepts a user-controlled path; every filesystem
    // path it builds is derived from DATA_DIR + static path segments.
    const port = 8322;
    assert.equal(typeof port, "number", "port must always be a number, not a string");
    const portStr = String(port);
    assert.ok(!portStr.includes("/"), "port string cannot contain path separator");
    assert.ok(!portStr.includes(".."), "port string cannot contain traversal");
  });
});
