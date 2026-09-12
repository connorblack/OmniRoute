#!/usr/bin/env node
/**
 * Consistent local snapshot of the gateway DB for Coolify's volume backup.
 *
 * Coolify's volume backup tars DATA_DIR while the app writes, which can catch
 * the WAL-mode storage.sqlite mid-write. This writes a `VACUUM INTO` copy to
 * DATA_DIR/snapshots/storage.sqlite shortly before that backup runs. It uses
 * the app's own better-sqlite3, so the image needs no sqlite3 CLI, and the
 * subdirectory keeps the copy out of backup-data-r2.mjs, which ships only
 * top-level *.sqlite files.
 *
 * Runs as a Coolify scheduled task inside the omniroute container and exits
 * non-zero on any failure so the task history shows it.
 */
import { createRequire } from "node:module";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const SOURCE = join(DATA_DIR, "storage.sqlite");
const TARGET = join(DATA_DIR, "snapshots", "storage.sqlite");
const TMP = `${TARGET}.tmp`;

const Database = createRequire("/app/package.json")("better-sqlite3");

mkdirSync(join(DATA_DIR, "snapshots"), { recursive: true });
rmSync(TMP, { force: true });

const source = new Database(SOURCE, { readonly: true, fileMustExist: true });
try {
  source.prepare("VACUUM INTO ?").run(TMP);
} finally {
  source.close();
}

const copy = new Database(TMP, { readonly: true });
const check = copy.pragma("quick_check", { simple: true });
copy.close();
if (check !== "ok") {
  rmSync(TMP, { force: true });
  console.error(`[snapshot] quick_check failed: ${check}`);
  process.exit(1);
}

renameSync(TMP, TARGET);
console.log(`[snapshot] ${TARGET} ${(statSync(TARGET).size / 1048576).toFixed(1)}MB`);
