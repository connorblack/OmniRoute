import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-cache-8728-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const readCache = await import("../../src/lib/db/readCache.ts");
const catalogCache = await import("../../src/app/api/v1/models/catalogCache.ts");

function request() {
  return new Request("http://localhost/v1/models");
}

function payload(body: string, status = 200): catalogCache.CatalogPayload {
  return {
    body,
    headers: { "content-type": "application/json" },
    status,
    cacheTTL: 60_000,
  };
}

async function resolve(build: (request: Request) => Promise<catalogCache.CatalogPayload>) {
  return catalogCache.resolveCachedCatalogResponse(
    request(),
    { corsHeaders: {}, diagnosticHeaders: {} },
    build
  );
}

test.beforeEach(() => {
  catalogCache.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("ordinary TTL expiry serves the last success within the bounded stale window", async () => {
  const initial = await resolve(async () => payload("old"));
  assert.equal(await initial.text(), "old");
  catalogCache.__expireCatalogCacheForTest(1000);

  const staleResponses = await Promise.all(
    Array.from({ length: 5 }, () => resolve(async () => payload("new")))
  );

  assert.deepEqual(
    await Promise.all(staleResponses.map((response) => response.text())),
    Array(5).fill("old")
  );
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), 1);

  await catalogCache.__flushCatalogBackgroundRefreshForTest();

  const refreshed = await resolve(async () => payload("unexpected"));
  assert.equal(await refreshed.text(), "new");
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), 2);
});

test("an error payload stops being replayed once it ages past the stale window", async () => {
  const first = await resolve(async () => payload("temporary failure", 503));
  assert.equal(first.status, 503);
  assert.equal(await first.text(), "temporary failure");

  const withinTtl = await resolve(async () => payload("recovered"));
  assert.equal(withinTtl.status, 503);
  assert.equal(await withinTtl.text(), "temporary failure");

  catalogCache.__expireCatalogCacheForTest(catalogCache.CATALOG_STALE_WHILE_REVALIDATE_MS + 1000);
  const rebuilt = await resolve(async () => payload("recovered"));
  assert.equal(rebuilt.status, 200);
  assert.equal(await rebuilt.text(), "recovered");
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), 2);
});

test("failed background refresh retains the prior successful snapshot and permits retry", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal(await (await resolve(async () => payload("old"))).text(), "old");
  catalogCache.__expireCatalogCacheForTest();

  assert.equal(
    await (
      await resolve(async () => {
        throw new Error("temporary failure");
      })
    ).text(),
    "old"
  );
  await catalogCache.__flushCatalogBackgroundRefreshForTest();

  assert.equal(await (await resolve(async () => payload("new"))).text(), "old");
  await catalogCache.__flushCatalogBackgroundRefreshForTest();

  assert.equal(await (await resolve(async () => payload("unused"))).text(), "new");
});

test("hard invalidation drops snapshots, detaches old work, and guards old-generation writeback", async () => {
  let resolveOld!: (value: catalogCache.CatalogPayload) => void;
  const oldPayload = new Promise<catalogCache.CatalogPayload>((resolvePromise) => {
    resolveOld = resolvePromise;
  });
  let currentBuildStarted = false;
  let resolveCurrent!: (value: catalogCache.CatalogPayload) => void;
  const currentPayload = new Promise<catalogCache.CatalogPayload>((resolvePromise) => {
    resolveCurrent = resolvePromise;
  });

  const oldRequest = resolve(async () => oldPayload);
  await Promise.resolve();

  readCache.invalidateModelCatalogCache();
  const currentRequest = resolve(async () => {
    currentBuildStarted = true;
    return currentPayload;
  });
  await Promise.resolve();

  assert.equal(currentBuildStarted, true, "the first post-write read must start a current build");

  resolveCurrent(payload("current"));
  assert.equal(await (await currentRequest).text(), "current");

  resolveOld(payload("old"));
  assert.equal(await (await oldRequest).text(), "old");

  const cached = await resolve(async () => payload("unexpected"));
  assert.equal(await cached.text(), "current", "old completion must not overwrite current cache");
  assert.equal(catalogCache.__getCatalogBuilderRunsForTest(), 2);
});

test("hard invalidation clears a completed snapshot and makes the next read block", async () => {
  assert.equal(await (await resolve(async () => payload("old"))).text(), "old");
  readCache.invalidateModelCatalogCache();

  let resolveCurrent!: (value: catalogCache.CatalogPayload) => void;
  const currentPayload = new Promise<catalogCache.CatalogPayload>((resolvePromise) => {
    resolveCurrent = resolvePromise;
  });
  let settled = false;
  const next = resolve(async () => currentPayload).then((response) => {
    settled = true;
    return response;
  });

  await Promise.resolve();
  assert.equal(settled, false, "post-write reads may block and must not serve the old snapshot");

  resolveCurrent(payload("current"));
  assert.equal(await (await next).text(), "current");
});
