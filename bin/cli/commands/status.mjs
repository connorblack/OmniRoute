import fs from "node:fs";
import path from "node:path";
import { apiFetch, getBaseUrl, readApiResponse } from "../api.mjs";
import { resolveDataDir, resolveStoragePath } from "../data-dir.mjs";
import { t } from "../i18n.mjs";
import { printHeading } from "../io.mjs";
import { emit } from "../output.mjs";

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function registerStatus(program) {
  program
    .command("status")
    .description("Show local installation status or explicit remote gateway status")
    .option("-v, --verbose", "Show additional details")
    .option("--remote", "Read the selected remote gateway instead of this workstation")
    .action(async (opts, cmd) => {
      const exitCode = await runStatusCommand({ ...cmd.optsWithGlobals(), ...opts });
      if (exitCode !== 0) process.exit(exitCode);
    });
}

export async function collectStatus(opts = {}) {
  if (opts.remote) {
    const timeout = Number.parseInt(opts.timeout, 10);
    const res = await apiFetch("/api/monitoring/health", {
      ...opts,
      retry: false,
      timeout: Number.isFinite(timeout) ? timeout : 5000,
    });
    return {
      scope: "remote",
      target: getBaseUrl(opts),
      health: await readApiResponse(res),
    };
  }

  const dataDir = resolveDataDir();
  const dbPath = resolveStoragePath(dataDir);
  const status = {
    scope: "local",
    version: getPackageVersion(),
    dataDir,
    database: {
      exists: fs.existsSync(dbPath),
      path: dbPath,
      size: fs.existsSync(dbPath) ? formatBytes(fs.statSync(dbPath).size) : null,
    },
    configDir: path.join(dataDir, "config"),
    configExists: fs.existsSync(path.join(dataDir, "config")),
  };

  if (opts.verbose) {
    try {
      const { detectAllTools } = await import("../../../src/lib/cli-helper/tool-detector.ts");
      const tools = await detectAllTools();
      status.tools = tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        installed: tool.installed,
        configured: tool.configured,
        version: tool.version || null,
      }));
    } catch {
      status.tools = "unavailable";
    }
  }

  return status;
}

export async function runStatusCommand(opts = {}) {
  const status = await collectStatus(opts);
  if (opts.output === "json") {
    emit(status, opts);
    return 0;
  }

  if (status.scope === "remote") {
    printHeading("OmniRoute remote status");
    process.stdout.write(`  Target: ${status.target}\n`);
    process.stdout.write(`${JSON.stringify(status.health, null, 2)}\n`);
    return 0;
  }

  printHeading("OmniRoute local status");
  process.stdout.write(`  Version:     ${status.version}\n`);
  process.stdout.write(`  Data Dir:    ${status.dataDir}\n`);
  process.stdout.write(
    `  Database:    ${status.database.exists ? "Found" : "Not found"} (${status.database.size || "N/A"})\n`
  );
  process.stdout.write(`  Config Dir:  ${status.configExists ? "Exists" : "Not found"}\n`);

  if (Array.isArray(status.tools)) {
    process.stdout.write("\n  CLI Tools:\n");
    for (const tool of status.tools) {
      const icon = tool.configured ? "✓" : tool.installed ? "~" : "✗";
      process.stdout.write(
        `    ${icon} ${tool.name.padEnd(14)} ${tool.installed ? "installed" : "not installed"}${tool.version ? ` (${tool.version})` : ""}\n`
      );
    }
  }

  return 0;
}
