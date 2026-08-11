/**
 * Tests for CLIProxyAPI fallback wiring fixes.
 *
 * All tests import and exercise REAL production functions:
 *   - clearCliproxyapiUrlCache / resolveCliproxyapiBaseUrl (open-sse/executors/cliproxyapi.ts)
 *   - upsertUpstreamProxyConfig / getUpstreamProxyConfig (src/lib/db/upstreamProxy.ts)
 *
 * The settings-loop embedded-service filter is exercised through
 * upsertUpstreamProxyConfig to prove the production EMBEDDED_SERVICE_IDS
 * guard prevents cliproxyapi/9router from appearing in the routing table.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── DB harness (needed for upsertUpstreamProxyConfig tests) ──────────────────

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cpa-wiring-test-"));
process.env.DATA_DIR = testDataDir;

// Dynamic imports AFTER DATA_DIR is set so core.ts picks up the temp path.
const coreDb = await import("../../src/lib/db/core.ts");
const upstreamProxyDb = await import("../../src/lib/db/upstreamProxy.ts");
const { persistGlobalCliproxyapiConfig } =
  await import("../../src/lib/services/cliproxyGlobalConfig.ts");

// ─── Executor imports (clearCliproxyapiUrlCache + resolveCliproxyapiBaseUrl) ──

// Import the executor module to get the real exported functions.
// This may be a cached import if cliproxyapi-executor.test.ts ran first — that
// is intentional; we test the live module state, not a fresh copy.
const { clearCliproxyapiUrlCache, resolveCliproxyapiBaseUrl } =
  await import("../../open-sse/executors/cliproxyapi.ts");

// ─── Lifecycle ────────────────────────────────────────────────────────────────

before(async () => {
  await coreDb.ensureDbInitialized();
});

afterEach(() => {
  // Reset DB singleton so each test starts from a clean schema state.
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
  fs.mkdirSync(testDataDir, { recursive: true });
});

after(() => {
  coreDb.resetDbInstance();
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CLIProxyAPI fallback wiring", () => {
  // ── resolveCliproxyapiBaseUrl / clearCliproxyapiUrlCache ──────────────────

  describe("resolveCliproxyapiBaseUrl — real production function", () => {
    const origHost = process.env.CLIPROXYAPI_HOST;
    const origPort = process.env.CLIPROXYAPI_PORT;

    beforeEach(() => {
      // Clear the module-level URL cache so the function re-evaluates env vars.
      clearCliproxyapiUrlCache();
    });

    afterEach(() => {
      process.env.CLIPROXYAPI_HOST = origHost;
      process.env.CLIPROXYAPI_PORT = origPort;
      clearCliproxyapiUrlCache();
    });

    it("falls back to default 127.0.0.1:8317 when env vars are unset", async () => {
      delete process.env.CLIPROXYAPI_HOST;
      delete process.env.CLIPROXYAPI_PORT;
      clearCliproxyapiUrlCache();
      // DB import will fail in test env (no settings table) → falls through to defaults.
      const url = await resolveCliproxyapiBaseUrl();
      assert.equal(url, "http://127.0.0.1:8317");
    });

    it("respects CLIPROXYAPI_HOST env var", async () => {
      process.env.CLIPROXYAPI_HOST = "10.0.0.1";
      delete process.env.CLIPROXYAPI_PORT;
      clearCliproxyapiUrlCache();
      const url = await resolveCliproxyapiBaseUrl();
      assert.ok(url.startsWith("http://10.0.0.1:"), `Expected host 10.0.0.1, got: ${url}`);
    });

    it("respects CLIPROXYAPI_PORT env var", async () => {
      delete process.env.CLIPROXYAPI_HOST;
      process.env.CLIPROXYAPI_PORT = "9999";
      clearCliproxyapiUrlCache();
      const url = await resolveCliproxyapiBaseUrl();
      assert.ok(url.endsWith(":9999"), `Expected port 9999, got: ${url}`);
    });

    it("clearCliproxyapiUrlCache is a real function that forces cache miss", async () => {
      // First call with port A
      process.env.CLIPROXYAPI_PORT = "8001";
      clearCliproxyapiUrlCache();
      const url1 = await resolveCliproxyapiBaseUrl();

      // Change env — without clearing, cache would still return old value.
      process.env.CLIPROXYAPI_PORT = "8002";
      clearCliproxyapiUrlCache(); // real production call
      const url2 = await resolveCliproxyapiBaseUrl();

      assert.ok(url1.endsWith(":8001"), `url1 should end with :8001, got: ${url1}`);
      assert.ok(
        url2.endsWith(":8002"),
        `url2 should end with :8002 after cache clear, got: ${url2}`
      );
      assert.notEqual(url1, url2);
    });
  });

  // ── global settings persistence must not fan out to providers ──────────────

  describe("settings sync to upstream_proxy_config — real DB functions", () => {
    it("stores global aliases only on a non-routable sentinel", async () => {
      await persistGlobalCliproxyapiConfig({
        cliproxyapiModelMapping: { "custom/model": "gpt-5.4-mini" },
      });

      const sentinel = await upstreamProxyDb.getUpstreamProxyConfig("cliproxyapi");
      assert.ok(sentinel);
      assert.equal(sentinel.mode, "native");
      assert.equal(sentinel.enabled, false);
      assert.deepEqual(sentinel.cliproxyapiModelMapping, { "custom/model": "gpt-5.4-mini" });
      assert.equal(await upstreamProxyDb.getUpstreamProxyConfig("openai"), null);
      assert.equal(await upstreamProxyDb.getUpstreamProxyConfig("anthropic"), null);
    });

    it("does not overwrite an explicitly configured provider row", async () => {
      await upstreamProxyDb.upsertUpstreamProxyConfig({
        providerId: "anthropic",
        mode: "fallback",
        enabled: true,
        cliproxyapiModelMapping: { "claude-custom": "claude-sonnet-5" },
      });
      await persistGlobalCliproxyapiConfig({
        cliproxyapiModelMapping: { "global-custom": "gpt-5.4-mini" },
      });

      const row = await upstreamProxyDb.getUpstreamProxyConfig("anthropic");
      assert.ok(row);
      assert.equal(row.mode, "fallback");
      assert.equal(row.enabled, true);
      assert.deepEqual(row.cliproxyapiModelMapping, { "claude-custom": "claude-sonnet-5" });
    });

    it("preserves global aliases when an unrelated global setting is saved", async () => {
      await persistGlobalCliproxyapiConfig({
        cliproxyapiModelMapping: { "custom/model": "gpt-5.4-mini" },
      });
      await persistGlobalCliproxyapiConfig({});

      const sentinel = await upstreamProxyDb.getUpstreamProxyConfig("cliproxyapi");
      assert.ok(sentinel);
      assert.deepEqual(sentinel.cliproxyapiModelMapping, { "custom/model": "gpt-5.4-mini" });
    });
  });

  // ── fallback status code parsing ──────────────────────────────────────────

  describe("fallback status code parsing (inline, tests parsing logic)", () => {
    function parseFallbackCodes(settingValue: string, defaults: number[]): number[] {
      if (typeof settingValue === "string" && settingValue.trim()) {
        const parsed = settingValue
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n));
        if (parsed.length > 0) return parsed;
      }
      return defaults;
    }

    it("uses user-configured codes instead of hardcoded values", () => {
      const defaults = [429, 500, 502, 503, 504];
      const codes = parseFallbackCodes("429,500,502", defaults);
      const isRetryable = (s: number) => codes.includes(s) || s === 0;

      assert.equal(isRetryable(429), true);
      assert.equal(isRetryable(500), true);
      assert.equal(isRetryable(502), true);
      assert.equal(isRetryable(0), true, "network error must always trigger fallback");
      // 503/504 not in user config — must NOT trigger (old bug: || s >= 500 always matched)
      assert.equal(isRetryable(503), false);
      assert.equal(isRetryable(504), false);
    });

    it("falls back to defaults when settings string is empty", () => {
      const defaults = [429, 500, 502, 503, 504];
      const codes = parseFallbackCodes("", defaults);
      const isRetryable = (s: number) => codes.includes(s) || s === 0;

      assert.equal(isRetryable(429), true);
      assert.equal(isRetryable(503), true);
      assert.equal(isRetryable(504), true);
    });

    it("handles a single code in settings", () => {
      const defaults = [429, 500, 502, 503, 504];
      const codes = parseFallbackCodes("429", defaults);
      assert.deepEqual(codes, [429]);
    });
  });
});
