import test from "node:test";
import assert from "node:assert/strict";

import { resolveRelayFetchTimeoutMs } from "../../open-sse/utils/proxyFetch.ts";

test("relay timeout defaults to the caller-owned deadline", () => {
  assert.equal(resolveRelayFetchTimeoutMs(undefined), null);
  assert.equal(resolveRelayFetchTimeoutMs(""), null);
});

test("explicit relay timeout is configurable beyond the old 29-second cap", () => {
  assert.equal(resolveRelayFetchTimeoutMs("120000"), 120000);
  assert.equal(resolveRelayFetchTimeoutMs("invalid"), null);
  assert.equal(resolveRelayFetchTimeoutMs("0"), null);
});
