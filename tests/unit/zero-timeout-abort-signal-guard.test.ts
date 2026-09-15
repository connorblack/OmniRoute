import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Structural regression guard for the zero-timeout production crash.
 *
 * AbortSignal.timeout(0) fires on the very next timer tick. FETCH_TIMEOUT_MS
 * (and other upstream timeout config, see src/shared/utils/runtimeTimeouts.ts
 * getUpstreamTimeoutConfig, allowZero:true) uses 0 to mean "disabled" —
 * writing `AbortSignal.timeout(FETCH_TIMEOUT_MS)` directly aborts every
 * request instantly instead of disabling the timeout the way the operator
 * intends (long-running bulk-ingest calls). Every fetch call site must go
 * through the shared `withTimeoutSignal` / `resolveTimeoutSignal` helpers in
 * open-sse/executors/base.ts instead of constructing the signal inline.
 *
 * This test greps the source tree (excluding node_modules, build output, and
 * this test file's own directory-independent fixtures) for the literal
 * banned pattern and fails if it appears anywhere outside base.ts itself
 * (which legitimately defines resolveTimeoutSignal's internal
 * AbortSignal.timeout call).
 */

const BANNED_PATTERN = "AbortSignal.timeout(FETCH_TIMEOUT_MS";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
]);

const SCAN_ROOTS = ["open-sse", "src", "bin", "scripts"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js"]);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(path.join(dir, entry.name));
  }
}

test("no source file constructs AbortSignal.timeout(FETCH_TIMEOUT_MS directly — must use withTimeoutSignal", () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(REPO_ROOT, root), files);
  }
  assert.ok(files.length > 100, `sanity check: expected to scan many files, found ${files.length}`);

  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith(".test.ts")) continue;
    const content = fs.readFileSync(file, "utf8");
    if (content.includes(BANNED_PATTERN)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `found unguarded AbortSignal.timeout(FETCH_TIMEOUT_MS in: ${offenders.join(", ")} — ` +
      "use withTimeoutSignal(signal, FETCH_TIMEOUT_MS) from open-sse/executors/base.ts instead"
  );
});
