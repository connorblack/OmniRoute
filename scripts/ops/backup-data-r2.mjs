#!/usr/bin/env node
/**
 * SQLite-safe backup of the gateway's data directory to Cloudflare R2.
 *
 * Designed to run INSIDE the deployed container as a Coolify scheduled task,
 * so it uses only what the image already has: node, better-sqlite3 (the app's
 * own driver), zlib, and fetch. No aws-cli, no S3 keypair — objects go
 * through Cloudflare's own REST API with the account API token.
 *
 * What it backs up: every top-level *.sqlite / *.db in DATA_DIR. The live DB
 * runs in WAL mode, so a file copy would tear; `VACUUM INTO` produces a
 * consistent point-in-time snapshot without blocking writers. call_logs/ is
 * deliberately NOT here — 2.3G of append-only per-day logs does not belong in
 * a 3-hourly cycle; give it its own slower task if it earns one.
 *
 * Unchanged files are skipped via an mtime+size state file, so the static
 * snapshots that live next to the real DB are shipped once, not every cycle.
 *
 * Keys:  omniroute/<file>/<UTC-stamp>.gz   (history)
 *        omniroute/<file>/latest.gz        (stable pointer)
 *
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BACKUP_BUCKET,
 *      DATA_DIR (default /app/data)
 *
 * Loud by design: any failure exits non-zero so the scheduled-task history
 * shows red instead of a silently rotting backup chain.
 */
import { createRequire } from "node:module";
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET = process.env.R2_BACKUP_BUCKET;
const STATE_PATH = join(DATA_DIR, ".r2-backup-state.json");

const log = (m) => console.log(`[backup] ${m}`);
if (!ACCT || !TOKEN || !BUCKET) {
  console.error("[backup] CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_BACKUP_BUCKET are required");
  process.exit(1);
}

// The app's own driver — resolved from the deployed node_modules.
const require_ = createRequire("/app/package.json");
const Database = require_("better-sqlite3");

async function putObject(key, bytes) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCT}` +
    `/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/gzip" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`PUT ${key} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+/, "Z");
  const state = loadState();
  const files = readdirSync(DATA_DIR).filter(
    (f) => /\.(sqlite|db)$/.test(f) && !/-(wal|shm)$/.test(f)
  );
  if (!files.length) { console.error(`[backup] no database files found in ${DATA_DIR}`); process.exit(1); }

  let shipped = 0, skipped = 0;
  for (const file of files) {
    const src = join(DATA_DIR, file);
    const st = statSync(src);
    const sig = `${st.mtimeMs}:${st.size}`;
    if (state[file] === sig) { skipped += 1; log(`${file}: unchanged, skipped`); continue; }

    const tmp = join(DATA_DIR, `.backup-tmp-${file}`);
    try { unlinkSync(tmp); } catch {}
    const db = new Database(src, { readonly: true });
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally { db.close(); }

    const gz = gzipSync(readFileSync(tmp));
    unlinkSync(tmp);
    await putObject(`omniroute/${file}/${stamp}.gz`, gz);
    await putObject(`omniroute/${file}/latest.gz`, gz);
    state[file] = sig;
    shipped += 1;
    log(`${file}: ${(st.size / 1e6).toFixed(1)}MB -> ${(gz.length / 1e6).toFixed(1)}MB gz, shipped`);
  }

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  log(`done: ${shipped} shipped, ${skipped} unchanged`);
}

main().catch((err) => { console.error(`[backup] FAILED: ${err.message}`); process.exit(1); });
