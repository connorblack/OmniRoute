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

/**
 * Authenticate the way the CLI does.
 *
 * A fresh deployment has no API key yet, so a bearer token cannot be the
 * primary path — bootstrap must work on an empty database. The management
 * policy accepts a machine-derived CLI token when the request also comes from
 * loopback, and the server recomputes that token in-process from the same
 * machine id. Because this script runs inside the app container, the ids match
 * and no secret has to be minted, stored, or injected.
 *
 * Reuses the CLI's own helper rather than reimplementing the derivation, so
 * the two cannot drift apart.
 */
let cliTokenHeader = null;
async function getCliTokenHeader() {
  if (cliTokenHeader !== null) return cliTokenHeader;
  try {
    const mod = await import(join(REPO_ROOT, "bin", "cli", "utils", "cliToken.mjs"));
    const token = await mod.getCliToken();
    // The helper needs `node-machine-id`, which is a CLI dependency and is NOT
    // present in the production standalone image — it returns "" there, so this
    // path is unavailable in a container and we fall through to session login.
    cliTokenHeader = token ? { [mod.CLI_TOKEN_HEADER]: token } : {};
  } catch {
    cliTokenHeader = {};
  }
  return cliTokenHeader;
}

/**
 * Session login with the seeded admin password.
 *
 * A fresh instance answers 401 on every management route, including
 * /api/keys — so no API key can be minted remotely, and there is no
 * credential-free window to exploit. The supported seam is INITIAL_PASSWORD,
 * which the image uses to set the initial dashboard password on first boot.
 * The provisioner injects it from a secret store, so nothing is hand-entered.
 *
 * Requires JWT_SECRET to be configured; without it the login route returns 500
 * by design, which is a far clearer failure than a mystery 401.
 */
let sessionCookie = null;
async function getSessionCookie() {
  if (sessionCookie !== null) return sessionCookie;
  const password = process.env.OMNIROUTE_BOOTSTRAP_PASSWORD || process.env.INITIAL_PASSWORD || "";
  if (!password) {
    sessionCookie = "";
    return sessionCookie;
  }
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    sessionCookie =
      res.ok && setCookie.length ? setCookie.map((c) => c.split(";")[0]).join("; ") : "";
    if (!sessionCookie) log(`login: HTTP ${res.status} — continuing unauthenticated`);
  } catch (err) {
    log(`login failed: ${err.message}`);
    sessionCookie = "";
  }
  return sessionCookie;
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await getCliTokenHeader()),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...((await getSessionCookie()) ? { Cookie: await getSessionCookie() } : {}),
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

/**
 * Sections that GET /api/settings surfaces but does NOT own.
 *
 * PATCH /api/settings answers 200 for these and persists nothing, so they must
 * be routed to the endpoint that actually writes them. Discovered the hard way:
 * a fresh instance reported "5 change(s)" while two of them silently no-opped.
 */
const SECTION_ROUTES = {
  // Takes the sections bare. Note its schema is strict: derived read-only
  // fields returned by GET (waitForCooldown.maxRetryWaitMs/budgetMs) are
  // rejected on write, so site-config.json must not declare them.
  resilienceSettings: { route: "/api/resilience", wrap: null },
  // Expects the section WRAPPED. Sending it bare returns 400 "Nothing to
  // update" — a 400 that reads like a validation error but actually means
  // "none of these keys are mine".
  comboDefaults: { route: "/api/settings/combo-defaults", wrap: "comboDefaults" },
};

/** GET shape mirrors the write shape, so unwrap before comparing. */
function readSection(body, wrap) {
  return wrap ? (body?.[wrap] ?? body) : body;
}

async function applySection(key, spec, value) {
  const { route, wrap } = spec;
  const { body: before } = await call(route);
  if (subsetMatches(readSection(before, wrap), value)) {
    skipped += 1;
    log(`${key}: already correct`);
    return;
  }
  log(`${key}: updating via ${route}`);
  if (DRY_RUN) return;
  const payload = wrap ? { [wrap]: value } : value;
  const res = await call(route, { method: "PATCH", body: JSON.stringify(payload) });
  if (!res.ok) {
    throw new Error(
      `${key} PATCH ${route} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`
    );
  }
  const { body: after } = await call(route);
  if (!subsetMatches(readSection(after, wrap), value)) {
    throw new Error(`${key} did not persist via ${route} despite HTTP ${res.status}`);
  }
  changed += 1;
}

async function applySettings(desired) {
  if (!desired || !Object.keys(desired).length) return;

  for (const [key, spec] of Object.entries(SECTION_ROUTES)) {
    if (desired[key] === undefined) continue;
    await applySection(key, spec, desired[key]);
  }

  const { body: current } = await call("/api/settings");
  const diff = {};
  for (const [key, value] of Object.entries(desired)) {
    if (SECTION_ROUTES[key]) continue; // handled above by its owning route
    if (subsetMatches(current?.[key], value)) continue;
    diff[key] = value;
  }
  const plainKeys = Object.keys(desired).filter((k) => !SECTION_ROUTES[k]);
  if (!Object.keys(diff).length) {
    skipped += plainKeys.length;
    if (plainKeys.length) log(`settings: already correct (${plainKeys.length} keys)`);
    return;
  }
  log(`settings: updating ${Object.keys(diff).join(", ")}`);
  if (DRY_RUN) return;
  await patchAndVerify(diff);
}

/**
 * Write, then read back and confirm the value actually stuck.
 *
 * PATCH /api/settings answers 200 for keys it does not own — `comboDefaults`
 * and `resilienceSettings` are served by that GET but written through their
 * own routes — so a write can report success and change nothing. Trusting the
 * status code made this script log "5 change(s)" against a fresh instance
 * where two of them silently no-opped, which is precisely the
 * looks-healthy-but-is-wrong outcome it exists to prevent.
 */
async function patchAndVerify(diff) {
  const res = await call("/api/settings", { method: "PATCH", body: JSON.stringify(diff) });
  if (!res.ok) {
    throw new Error(
      `settings PATCH failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`
    );
  }

  const { body: after } = await call("/api/settings");
  const unpersisted = Object.entries(diff)
    .filter(([key, value]) => !subsetMatches(after?.[key], value))
    .map(([key]) => key);

  changed += Object.keys(diff).length - unpersisted.length;
  if (unpersisted.length) {
    throw new Error(
      `settings did not persist despite HTTP 200: ${unpersisted.join(", ")}. ` +
        `These keys are readable via GET /api/settings but owned by another route — ` +
        `remove them from site-config.json or apply them through their own endpoint.`
    );
  }
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
