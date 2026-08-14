#!/usr/bin/env node
/**
 * Idempotent site bootstrap for a self-hosted OmniRoute deployment.
 *
 * WHY THIS EXISTS
 * ---------------
 * Container-level config (env, volumes, ports) is declarative in Coolify and
 * survives redeploys. Everything OmniRoute stores in SQLite — payload rules,
 * resilience tuning, feature flags — does not exist at all on a fresh volume.
 * Applying it by hand means a new deployment silently comes up misconfigured
 * and the knowledge lives in someone's terminal history.
 *
 * This script makes that state reproducible: point a brand-new app at it via
 * Coolify's post_deployment_command and the deployment configures itself.
 *
 * Design rules:
 *   - Idempotent. Safe to run on every deploy; re-running changes nothing.
 *   - Additive by default. It sets what config/site-config.json declares and
 *     leaves everything else alone, so it never fights an operator's dashboard
 *     edits for keys it does not own.
 *   - Loopback only. It talks to 127.0.0.1, which is the one path that
 *     satisfies OmniRoute's LOCAL_ONLY route guard without widening any
 *     bypass — the guard keys on the real socket peer, and a reverse proxy
 *     that adds X-Forwarded-For is classified remote by design.
 *   - Fails loudly. A bootstrap that half-applies and exits 0 is worse than
 *     one that stops, because the deployment looks healthy while being wrong.
 *
 * Usage:
 *   node scripts/bootstrap/apply-site-config.mjs [--config <path>] [--dry-run]
 *
 * Auth: OMNIROUTE_BOOTSTRAP_TOKEN, else OMNIROUTE_ADMIN_KEY. Management routes
 * still require a credential even on loopback when REQUIRE_API_KEY is on.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const CONFIG_PATH =
  argv[argv.indexOf("--config") + 1] && argv.includes("--config")
    ? resolve(argv[argv.indexOf("--config") + 1])
    : join(REPO_ROOT, "config", "site-config.json");

const PORT = process.env.PORT || process.env.DASHBOARD_PORT || "20128";
const BASE = process.env.OMNIROUTE_BOOTSTRAP_BASE || `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.OMNIROUTE_BOOTSTRAP_TOKEN || process.env.OMNIROUTE_ADMIN_KEY || "";
const READY_TIMEOUT_MS = Number(process.env.OMNIROUTE_BOOTSTRAP_TIMEOUT_MS || 180_000);

let changed = 0;
let skipped = 0;
const log = (msg) => console.log(`[bootstrap] ${msg}`);

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Wait for the server to answer before touching config.
 *
 * post_deployment_command can fire while the app is still starting; writing
 * into a half-initialised instance is how you get partially-applied state.
 */
async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr = "not started";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/system/version`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok || res.status === 401) return; // 401 = up, just gated
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`OmniRoute did not become ready within ${READY_TIMEOUT_MS}ms (${lastErr})`);
}

/** Deep-equality on the subset we declare, so re-runs are no-ops. */
function subsetMatches(actual, desired) {
  if (desired === null || typeof desired !== "object") return actual === desired;
  if (Array.isArray(desired)) return JSON.stringify(actual) === JSON.stringify(desired);
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(desired).every(([k, v]) => subsetMatches(actual[k], v));
}

async function applySettings(desired) {
  if (!desired || !Object.keys(desired).length) return;
  const { body: current } = await call("/api/settings");
  const diff = {};
  for (const [key, value] of Object.entries(desired)) {
    if (subsetMatches(current?.[key], value)) continue;
    diff[key] = value;
  }
  if (!Object.keys(diff).length) {
    skipped += Object.keys(desired).length;
    log(`settings: already correct (${Object.keys(desired).length} keys)`);
    return;
  }
  log(`settings: updating ${Object.keys(diff).join(", ")}`);
  if (DRY_RUN) return;
  const res = await call("/api/settings", { method: "PATCH", body: JSON.stringify(diff) });
  if (!res.ok)
    throw new Error(
      `settings PATCH failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`
    );
  changed += Object.keys(diff).length;
}

/**
 * Payload rules are replace-semantics: the PUT overwrites the whole document,
 * so the config file must carry every rule the site wants, not just new ones.
 */
async function applyPayloadRules(desired) {
  if (!desired) return;
  const { body: current } = await call("/api/settings/payload-rules");
  if (JSON.stringify(current) === JSON.stringify(desired)) {
    skipped += 1;
    log("payload-rules: already correct");
    return;
  }
  log(
    `payload-rules: applying (default=${desired.default?.length ?? 0} override=${desired.override?.length ?? 0} filter=${desired.filter?.length ?? 0})`
  );
  if (DRY_RUN) return;
  const res = await call("/api/settings/payload-rules", {
    method: "PUT",
    body: JSON.stringify(desired),
  });
  if (!res.ok) throw new Error(`payload-rules PUT failed: HTTP ${res.status}`);
  changed += 1;
}

async function main() {
  if (!existsSync(CONFIG_PATH)) {
    log(`no site config at ${CONFIG_PATH} — nothing to apply`);
    return;
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  log(`config: ${CONFIG_PATH}`);
  log(`target: ${BASE}${DRY_RUN ? " (dry-run)" : ""}`);

  await waitForReady();
  log("server ready");

  await applySettings(config.settings);
  await applyPayloadRules(config.payloadRules);

  log(`done: ${changed} change(s), ${skipped} already-correct`);
}

main().catch((err) => {
  console.error(`[bootstrap] FAILED: ${err.message}`);
  process.exit(1);
});
