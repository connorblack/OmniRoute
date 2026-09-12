import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as toolDetector from "../../../src/lib/cli-helper/tool-detector.ts";

// The Hermes tool detector honors a HERMES_HOME env var (#3628) and only falls
// back to the default ~/.hermes/config.yaml path when it is unset. CI runs with
// HERMES_HOME unset, but this suite can also run inside a Hermes Agent session
// that exports HERMES_HOME, which redirects the detected config path and breaks
// the ".hermes/config.yaml" assertion below. Unset it so the test is hermetic
// and matches CI regardless of the ambient runtime.
delete process.env.HERMES_HOME;

describe("tool-detector", () => {
  before(() => {
    // Install mock exec implementation for deterministic testing
    // @ts-expect-error - internal test hook
    toolDetector.__setExecFileImpl(async (cmd) => {
      if (cmd === "opencode") {
        return { stdout: "v1.0.0\n" };
      }
      if (cmd === "hermes") {
        return { stdout: "v0.75.3\n" };
      }
      if (cmd === "openclaw") {
        return { stdout: "v0.3.1\n" };
      }
      if (cmd === "which") {
        return { stdout: "/usr/local/bin/opencode\n" };
      }
      throw new Error("Command not found");
    });
  });

  describe("detectTool", () => {
    it("returns null for unknown tool id", async () => {
      const result = await toolDetector.detectTool("unknown-tool-xyz");
      assert.strictEqual(result, null);
    });

    it("returns DetectedTool object for installed tool", async () => {
      const result = await toolDetector.detectTool("opencode");
      assert.ok(result !== null);
      assert.strictEqual(result!.id, "opencode");
      assert.strictEqual(result!.name, "OpenCode");
      assert.strictEqual(result!.installed, true);
      assert.strictEqual(result!.version, "1.0.0");
      assert.ok(result!.configPath.includes(".config/opencode"));
      assert.strictEqual(typeof result!.configured, "boolean");
    });

    it("returns DetectedTool object for Hermes with the Hermes config path", async () => {
      const result = await toolDetector.detectTool("hermes");
      assert.ok(result !== null);
      assert.strictEqual(result!.id, "hermes");
      assert.strictEqual(result!.name, "Hermes");
      assert.strictEqual(result!.installed, true);
      assert.strictEqual(result!.version, "0.75.3");
      assert.ok(result!.configPath.includes(".hermes/config.yaml"));
      assert.strictEqual(typeof result!.configured, "boolean");
    });

    // Regression test for #2833 — openclaw was missing from TOOLS array
    it("returns DetectedTool object for openclaw with the openclaw config path", async () => {
      const result = await toolDetector.detectTool("openclaw");
      assert.ok(result !== null, "detectTool('openclaw') must not return null");
      assert.strictEqual(result!.id, "openclaw");
      assert.strictEqual(result!.name, "OpenClaw");
      assert.strictEqual(result!.installed, true);
      assert.strictEqual(result!.version, "0.3.1");
      assert.ok(
        result!.configPath.includes(".openclaw/openclaw.json"),
        `expected configPath to include '.openclaw/openclaw.json', got: ${result!.configPath}`
      );
      assert.strictEqual(typeof result!.configured, "boolean");
    });

    it("normalizes the legacy kilocode id to the canonical kilo target", async () => {
      const result = await toolDetector.detectTool("kilocode");
      assert.ok(result !== null);
      assert.strictEqual(result!.id, "kilo");
      assert.strictEqual(result!.name, "Kilo Code");
      assert.ok(result!.configPath.includes(".local/share/kilo/auth.json"));
    });
  });

  describe("detectAllTools", () => {
    it("returns array (may be empty if tools not installed)", async () => {
      const tools = await toolDetector.detectAllTools();
      assert.ok(Array.isArray(tools));
      // All items must pass shape check
      for (const t of tools) {
        assert.ok(t.id);
        assert.ok(t.name);
        assert.strictEqual(typeof t.installed, "boolean");
        assert.ok("configPath" in t);
        assert.ok("configured" in t);
      }
    });

    // Regression test for #2833 — openclaw must appear in detectAllTools()
    it("includes openclaw in the detected tools list", async () => {
      const tools = await toolDetector.detectAllTools();
      const openclaw = tools.find((t) => t.id === "openclaw");
      assert.ok(
        openclaw !== undefined,
        "detectAllTools() must include an entry with id='openclaw'"
      );
      assert.strictEqual(openclaw!.name, "OpenClaw");
      assert.ok(
        openclaw!.configPath.includes(".openclaw/openclaw.json"),
        `expected configPath to include '.openclaw/openclaw.json', got: ${openclaw!.configPath}`
      );
    });
  });

  describe("configured — public base URL (gateway), not just localhost:20128", () => {
    let configHome: string;
    let previousConfigHome: string | undefined;
    let previousPublicBaseUrl: string | undefined;

    before(() => {
      previousConfigHome = process.env.CLI_CONFIG_HOME;
      previousPublicBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
      configHome = path.join(os.homedir(), "tmp-cli-config-home-tool-detector-test");
      fs.mkdirSync(path.join(configHome, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(configHome, ".claude", "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.dev.sellie.ai" } })
      );
      process.env.CLI_CONFIG_HOME = configHome;
      process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.dev.sellie.ai";
    });

    after(() => {
      if (previousConfigHome === undefined) delete process.env.CLI_CONFIG_HOME;
      else process.env.CLI_CONFIG_HOME = previousConfigHome;
      if (previousPublicBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
      else process.env.NEXT_PUBLIC_BASE_URL = previousPublicBaseUrl;
      fs.rmSync(configHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it("reports configured=true when the config points at the gateway's public base URL", async () => {
      const result = await toolDetector.detectTool("claude");
      assert.ok(result !== null);
      assert.strictEqual(result!.configured, true);
    });
  });

  describe("hermes-agent roles — omni-route provider and gateway base_url", () => {
    let hermesHome: string;
    let previousHermesHome: string | undefined;
    let previousPublicBaseUrl: string | undefined;

    before(() => {
      previousHermesHome = process.env.HERMES_HOME;
      previousPublicBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
      hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hermes-home-"));
      fs.writeFileSync(
        path.join(hermesHome, "config.yaml"),
        [
          "model:",
          "  default: some-model",
          "  provider: omni-route",
          "  base_url: https://gateway.dev.sellie.ai/v1",
          "",
        ].join("\n")
      );
      process.env.HERMES_HOME = hermesHome;
      process.env.NEXT_PUBLIC_BASE_URL = "https://gateway.dev.sellie.ai";
    });

    after(() => {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHermesHome;
      if (previousPublicBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
      else process.env.NEXT_PUBLIC_BASE_URL = previousPublicBaseUrl;
      fs.rmSync(hermesHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it("marks the default role as usingOmniRoute for provider omni-route + gateway base_url", async () => {
      const result = await toolDetector.detectTool("hermes-agent");
      assert.ok(result !== null);
      assert.ok(result!.hermesAgentRoles, "expected hermesAgentRoles to be populated");
      assert.strictEqual(result!.hermesAgentRoles!.default.usingOmniRoute, true);
    });
  });
});
