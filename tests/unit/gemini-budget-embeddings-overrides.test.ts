import test from "node:test";
import assert from "node:assert/strict";
import {
  reserveGeminiRequest,
  settleGeminiRequest,
  getGeminiBudgetBlock,
  resetGeminiBudgetLedgerForTests,
  setGeminiLedgerSeedSourceForTests,
} from "../../open-sse/services/geminiRateLimitTracker.ts";
import {
  clearConnectionRateLimitOverrides,
  setConnectionRateLimitOverrides,
} from "../../open-sse/services/connectionRateLimitOverrides.ts";

const FIXED_NOW = Date.UTC(2024, 6, 15, 19, 0, 0);
const EMBED = "gemini-embedding-2";

function settleBatch(connectionId: string, units: number, nowMs: number, status = 200) {
  const handle = reserveGeminiRequest(connectionId, EMBED, nowMs, units);
  settleGeminiRequest(handle, { upstreamStatus: status }, nowMs);
}

test.beforeEach(() => {
  resetGeminiBudgetLedgerForTests();
  setGeminiLedgerSeedSourceForTests(() => []);
  clearConnectionRateLimitOverrides();
});

test("a batch embedding reservation counts one request per content toward RPM", () => {
  settleBatch("free", 99, FIXED_NOW);
  assert.equal(getGeminiBudgetBlock("free", EMBED, FIXED_NOW + 1), null);
  settleBatch("free", 1, FIXED_NOW + 2);
  assert.equal(getGeminiBudgetBlock("free", EMBED, FIXED_NOW + 3)?.window, "rpm");
});

test("in-flight batch units count before they settle and release on 429", () => {
  const handle = reserveGeminiRequest("free", EMBED, FIXED_NOW, 100);
  assert.equal(getGeminiBudgetBlock("free", EMBED, FIXED_NOW + 1)?.window, "rpm");
  settleGeminiRequest(handle, { upstreamStatus: 429 }, FIXED_NOW + 2);
  assert.equal(getGeminiBudgetBlock("free", EMBED, FIXED_NOW + 3), null);
});

test("gemini-embedding-2 uses the free-tier 1000 RPD budget", () => {
  for (let minute = 0; minute < 10; minute++) {
    settleBatch("free", 100, FIXED_NOW + minute * 61_000);
  }
  assert.equal(getGeminiBudgetBlock("free", EMBED, FIXED_NOW + 11 * 61_000)?.window, "rpd");
});

test("connection overrides replace the free-tier registry; unset fields are unlimited", () => {
  setConnectionRateLimitOverrides("paid", { rpm: 3000 });
  for (let minute = 0; minute < 10; minute++) {
    settleBatch("paid", 100, FIXED_NOW + minute * 61_000);
  }
  settleBatch("paid", 500, FIXED_NOW + 11 * 61_000);
  assert.equal(getGeminiBudgetBlock("paid", EMBED, FIXED_NOW + 11 * 61_000 + 1), null);
  settleBatch("paid", 2500, FIXED_NOW + 11 * 61_000 + 2);
  assert.equal(getGeminiBudgetBlock("paid", EMBED, FIXED_NOW + 11 * 61_000 + 3)?.window, "rpm");
});

test("override-only budgets gate models the registry does not know", () => {
  setConnectionRateLimitOverrides("paid", { rpd: 2 });
  assert.equal(getGeminiBudgetBlock("paid", "some-future-model", FIXED_NOW), null);
  const a = reserveGeminiRequest("paid", "some-future-model", FIXED_NOW);
  settleGeminiRequest(a, { upstreamStatus: 200 }, FIXED_NOW);
  const b = reserveGeminiRequest("paid", "some-future-model", FIXED_NOW + 1);
  settleGeminiRequest(b, { upstreamStatus: 200 }, FIXED_NOW + 1);
  assert.equal(getGeminiBudgetBlock("paid", "some-future-model", FIXED_NOW + 2)?.window, "rpd");
});

test("maxConcurrent alone does not replace the free-tier registry", () => {
  setConnectionRateLimitOverrides("free", { maxConcurrent: 4 });
  settleBatch("free", 100, FIXED_NOW);
  assert.equal(getGeminiBudgetBlock("free", EMBED, FIXED_NOW + 1)?.window, "rpm");
});
