#!/usr/bin/env node
/**
 * Provision a Coolify application for this repo from a manifest.
 *
 * Companion to apply-site-config.mjs, which handles everything OmniRoute keeps
 * in SQLite. This handles the other half — the container-level config Coolify
 * owns (build pack, ports, port mappings, storage mounts, env, deployment
 * hooks) — so a deployment is reproducible end to end instead of assembled by
 * hand and remembered by whoever assembled it.
 *
 * Splitting them this way is deliberate: this script runs OUTSIDE the
 * container against the Coolify API, while apply-site-config.mjs runs INSIDE
 * as post_deployment_command, because OmniRoute's LOCAL_ONLY routes only
 * accept a loopback peer.
 *
 * SECRETS ARE NOT IN THE MANIFEST. It lists env KEYS and where each value
 * comes from; values are resolved at apply time from the environment. A
 * manifest that carried values would be a secret store in version control.
 *
 * Usage:
 *   node scripts/bootstrap/provision-coolify-app.mjs --manifest <path> [--apply]
 *
 * Env: COOLIFY_URL, COOLIFY_TOKEN, plus any vars the manifest references.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const MANIFEST = argv.includes("--manifest")
  ? resolve(argv[argv.indexOf("--manifest") + 1])
  : resolve("config/coolify-app.json");

const COOLIFY_URL = (process.env.COOLIFY_URL || "").replace(/\/$/, "");
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || "";

const log = (m) => console.log(`[provision] ${m}`);

if (!existsSync(MANIFEST)) {
  console.error(`[provision] manifest not found: ${MANIFEST}`);
  process.exit(1);
}
if (!COOLIFY_URL || !COOLIFY_TOKEN) {
  console.error("[provision] COOLIFY_URL and COOLIFY_TOKEN are required");
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${COOLIFY_URL}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${COOLIFY_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !init.tolerate) {
    throw new Error(
      `${init.method || "GET"} ${path} -> HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  return body;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const uuid = process.env.COOLIFY_APP_UUID || manifest.appUuid;
if (!uuid) {
  console.error("[provision] set COOLIFY_APP_UUID or manifest.appUuid");
  process.exit(1);
}

/**
 * Resolve env values from the ambient environment, never the manifest.
 * A key listed but unset is reported, not silently skipped — a missing
 * value is exactly the kind of gap that produces a healthy-looking but
 * misconfigured deployment.
 */
function resolveEnv(keys) {
  const resolved = {};
  const missing = [];
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined || value === "") missing.push(key);
    else resolved[key] = value;
  }
  return { resolved, missing };
}

async function main() {
  log(`manifest: ${MANIFEST}`);
  log(`app: ${uuid}${APPLY ? "" : "  (dry-run)"}`);

  // 1) App-level config, including the post-deployment hook that chains to
  //    apply-site-config.mjs. Without the hook the DB half never runs.
  const appConfig = { ...(manifest.application || {}) };
  if (Object.keys(appConfig).length) {
    log(`application: ${Object.keys(appConfig).join(", ")}`);
    if (APPLY)
      await api(`/applications/${uuid}`, { method: "PATCH", body: JSON.stringify(appConfig) });
  }

  // 2) Env — upsert, never blind-create. Creating a key that already exists
  //    yields DUPLICATE rows with undefined precedence; a live instance was
  //    found carrying 44 rows for 34 keys this way.
  const { resolved, missing } = resolveEnv(manifest.envKeys || []);
  if (missing.length)
    log(`env: ${missing.length} key(s) unset in environment: ${missing.join(", ")}`);
  const existing = await api(`/applications/${uuid}/envs`, { tolerate: true });
  const rows = Array.isArray(existing) ? existing : existing.data || [];
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const [key, value] of Object.entries(resolved)) {
    const current = byKey.get(key);
    if (current && String(current.value) === String(value)) continue;
    log(`env: ${current ? "update" : "create"} ${key}`);
    if (!APPLY) continue;
    await api(`/applications/${uuid}/envs`, {
      method: current ? "PATCH" : "POST",
      tolerate: true,
      body: JSON.stringify({ key, value, is_preview: false }),
    });
  }

  // 3) Storage mounts — matched by mount_path so re-running is a no-op.
  const wantStorages = manifest.storages || [];
  if (wantStorages.length) {
    const have = await api(`/applications/${uuid}/storages`, { tolerate: true });
    // Coolify returns { persistent_storages: [...] } here, not a bare array or
    // { data }. Guessing the shape made this propose re-creating mounts that
    // already existed — the same duplicate-row failure the env upsert avoids.
    const haveRows = Array.isArray(have) ? have : have.persistent_storages || have.data || [];
    const mounted = new Set(haveRows.map((s) => s.mount_path));
    for (const storage of wantStorages) {
      if (mounted.has(storage.mount_path)) continue;
      log(`storage: create ${storage.name} -> ${storage.mount_path}`);
      if (!APPLY) continue;
      await api(`/applications/${uuid}/storages`, {
        method: "POST",
        tolerate: true,
        body: JSON.stringify(storage),
      });
    }
  }

  log(APPLY ? "done" : "[dry-run] nothing written. re-run with --apply.");
}

main().catch((err) => {
  console.error(`[provision] FAILED: ${err.message}`);
  process.exit(1);
});
