import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

export function registerHealth(program) {
  const health = program
    .command("health")
    .description(t("health.description"))
    .option("-v, --verbose", "Show extended info (memory, breakers)")
    .option("--json", "Output as JSON")
    .option("--alerts-only", "Show only components with alerts")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const exitCode = await runHealthCommand({ ...globalOpts, ...opts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  health
    .command("components")
    .description("List health components and their status")
    .option("--alerts-only", "Show only components with alerts")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const exitCode = await runHealthComponentsCommand({ ...globalOpts, ...opts });
      if (exitCode !== 0) process.exit(exitCode);
    });

  health
    .command("watch")
    .description("Live dashboard — refresh every N seconds")
    .option("--interval <s>", "Refresh interval in seconds", "5")
    .action(async (opts, cmd) => {
      const globalOpts = cmd.optsWithGlobals();
      const interval = parseInt(opts.interval, 10) * 1000;
      process.stdout.write("\x1B[2J\x1B[0f");
      while (true) {
        process.stdout.write("\x1B[0f");
        await runHealthCommand({ ...globalOpts, verbose: true });
        await new Promise((r) => setTimeout(r, interval));
      }
    });
}

export async function runHealthCommand(opts = {}) {
  try {
    const timeout = Number.parseInt(opts.timeout, 10);
    const res = await apiFetch("/api/monitoring/health", {
      ...opts,
      retry: false,
      timeout: Number.isFinite(timeout) ? timeout : 5000,
    });
    const health = await readApiResponse(res);

    if (opts.json || opts.output === "json") {
      emit(health, opts);
      return 0;
    }

    console.log(`\n\x1b[1m\x1b[36m${t("health.title")}\x1b[0m\n`);
    console.log(t("health.status", { status: "\x1b[32mhealthy\x1b[0m" }));
    if (health.uptime) console.log(t("health.uptime", { uptime: health.uptime }));
    if (health.version) console.log(`  Version: ${health.version}`);

    if (health.activeConnections !== undefined) {
      console.log(t("health.requests", { count: health.activeConnections }));
    }

    if (health.circuitBreakers && opts.verbose) {
      console.log("\n  \x1b[1mCircuit Breakers\x1b[0m");
      const { open = 0, halfOpen = 0, closed = 0 } = health.circuitBreakers;
      console.log(`    \x1b[32m● closed\x1b[0m     ${closed}`);
      console.log(`    \x1b[33m○ half-open\x1b[0m  ${halfOpen}`);
      console.log(`    \x1b[31m○ open\x1b[0m       ${open}`);
    }

    if (opts.verbose && health.memoryUsage) {
      console.log("\n  \x1b[1mMemory\x1b[0m");
      console.log(`    RSS:        ${health.memoryUsage.rss || "N/A"}`);
      console.log(`    Heap used:  ${health.memoryUsage.heapUsed || "N/A"}`);
    }

    return 0;
  } catch (err) {
    console.error(t("common.error", { message: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

export async function runHealthComponentsCommand(opts = {}) {
  try {
    const timeout = Number.parseInt(opts.timeout, 10);
    const res = await apiFetch("/api/monitoring/health", {
      ...opts,
      retry: false,
      timeout: Number.isFinite(timeout) ? timeout : 5000,
    });
    const health = await readApiResponse(res);
    const components = health.components || health.circuitBreakers || {};
    const rows = [];
    for (const [name, info] of Object.entries(components)) {
      const status =
        typeof info === "object" ? info.state || info.status || "unknown" : String(info);
      const isAlert = status !== "closed" && status !== "ok" && status !== "healthy";
      if (opts.alertsOnly && !isAlert) continue;
      rows.push({ name, status, alert: isAlert });
    }
    if (opts.output === "json") {
      emit(rows, opts);
      return 0;
    }
    for (const row of rows) {
      const icon = row.alert ? "\x1b[33m⚠\x1b[0m" : "\x1b[32m✓\x1b[0m";
      console.log(`  ${icon} ${row.name.padEnd(24)} ${row.status}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
