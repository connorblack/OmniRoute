import test from "node:test";
import assert from "node:assert/strict";
import {
  reserveGeminiRequest,
  settleGeminiRequest,
  getGeminiBudgetBlock,
  canonicalizeGeminiModel,
  resetGeminiBudgetLedgerForTests,
  setGeminiLedgerSeedSourceForTests,
  type GeminiCallLogSeedRow,
} from "../../open-sse/services/geminiRateLimitTracker.ts";
import {
  isModelLocked,
  getModelLockoutInfo,
  clearAllModelLockouts,
} from "../../open-sse/services/accountFallback.ts";
import { RateLimitReason } from "../../open-sse/config/constants.ts";

// A fixed, DST-unambiguous instant: 2024-07-15 12:00:00 Pacific Daylight Time.
const FIXED_NOW = Date.UTC(2024, 6, 15, 19, 0, 0);

function settleOk(connectionId: string, model: string, nowMs: number, tokens?: number) {
  const handle = reserveGeminiRequest(connectionId, model, nowMs);
  settleGeminiRequest(handle, { upstreamStatus: 200, tokens }, nowMs);
}

function pacificClockAt(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { hour: part("hour"), minute: part("minute"), second: part("second") };
}

test.beforeEach(() => {
  resetGeminiBudgetLedgerForTests();
  setGeminiLedgerSeedSourceForTests(() => []);
  clearAllModelLockouts();
});

// ── Isolation ────────────────────────────────────────────────────────────────

test("two keys are tracked independently", () => {
  for (let i = 0; i < 5; i++) settleOk("conn-a", "gemini-3.8-flash", FIXED_NOW + i);
  assert.ok(getGeminiBudgetBlock("conn-a", "gemini-3.8-flash", FIXED_NOW + 10));
  assert.equal(getGeminiBudgetBlock("conn-b", "gemini-3.8-flash", FIXED_NOW + 10), null);
});

// ── RPM ──────────────────────────────────────────────────────────────────────

test("5 RPM blocks the 6th reservation within 60s and frees once the oldest ages out", () => {
  // gemini-3.8-flash: rpm=5
  for (let i = 0; i < 5; i++) settleOk("conn-rpm", "gemini-3.8-flash", FIXED_NOW + i);
  const block = getGeminiBudgetBlock("conn-rpm", "gemini-3.8-flash", FIXED_NOW + 10);
  assert.equal(block?.window, "rpm");
  assert.ok(block!.remainingMs > 0 && block!.remainingMs <= 60_000);

  // Still blocked just before the oldest (FIXED_NOW+0) ages out.
  assert.ok(getGeminiBudgetBlock("conn-rpm", "gemini-3.8-flash", FIXED_NOW + 59_999));
  // Freed once it does.
  assert.equal(getGeminiBudgetBlock("conn-rpm", "gemini-3.8-flash", FIXED_NOW + 60_001), null);
});

test("in-flight reservations count toward the RPM budget before they settle", () => {
  for (let i = 0; i < 5; i++) reserveGeminiRequest("conn-inflight", "gemini-3.8-flash", FIXED_NOW);
  const block = getGeminiBudgetBlock("conn-inflight", "gemini-3.8-flash", FIXED_NOW + 1);
  assert.equal(block?.window, "rpm");
});

test("429 and 503 settlements release the reservation instead of counting it", () => {
  for (let i = 0; i < 4; i++) settleOk("conn-release", "gemini-3.8-flash", FIXED_NOW + i);
  const h429 = reserveGeminiRequest("conn-release", "gemini-3.8-flash", FIXED_NOW + 5);
  settleGeminiRequest(h429, { upstreamStatus: 429 }, FIXED_NOW + 5);
  assert.equal(getGeminiBudgetBlock("conn-release", "gemini-3.8-flash", FIXED_NOW + 6), null);

  const h503 = reserveGeminiRequest("conn-release", "gemini-3.8-flash", FIXED_NOW + 6);
  settleGeminiRequest(h503, { upstreamStatus: 503 }, FIXED_NOW + 6);
  assert.equal(getGeminiBudgetBlock("conn-release", "gemini-3.8-flash", FIXED_NOW + 7), null);

  // A real (billed) 5th request now DOES trip the RPM budget.
  settleOk("conn-release", "gemini-3.8-flash", FIXED_NOW + 7);
  assert.ok(getGeminiBudgetBlock("conn-release", "gemini-3.8-flash", FIXED_NOW + 8));
});

// ── RPD ──────────────────────────────────────────────────────────────────────

test("20 RPD blocks until Pacific midnight, remainingMs correct on a DST-safe fixed timestamp", () => {
  // gemini-3.8-flash: rpd=20. Space requests > 60s apart so RPM never trips first.
  for (let i = 0; i < 20; i++) {
    settleOk("conn-rpd", "gemini-3.8-flash", FIXED_NOW + i * 61_000);
  }
  const nowMs = FIXED_NOW + 20 * 61_000;
  const block = getGeminiBudgetBlock("conn-rpd", "gemini-3.8-flash", nowMs);
  assert.equal(block?.window, "rpd");
  const resetInstant = pacificClockAt(nowMs + block!.remainingMs);
  assert.deepEqual(resetInstant, { hour: 0, minute: 0, second: 0 });
});

// ── TPM ──────────────────────────────────────────────────────────────────────

test("250K TPM blocks once settled tokens reach the limit", () => {
  // gemini-3.8-flash: tpm=250000
  settleOk("conn-tpm", "gemini-3.8-flash", FIXED_NOW, 250_001);
  const block = getGeminiBudgetBlock("conn-tpm", "gemini-3.8-flash", FIXED_NOW + 1);
  assert.equal(block?.window, "tpm");
  assert.equal(getGeminiBudgetBlock("conn-tpm-other", "gemini-3.8-flash", FIXED_NOW + 1), null);
});

// ── Aliases ──────────────────────────────────────────────────────────────────

test("gemini-flash-latest shares the gemini-3.8-flash bucket", () => {
  assert.equal(canonicalizeGeminiModel("gemini-flash-latest"), "gemini-3.8-flash");
  for (let i = 0; i < 5; i++) settleOk("conn-alias", "gemini-3.8-flash", FIXED_NOW + i);
  const block = getGeminiBudgetBlock("conn-alias", "gemini-flash-latest", FIXED_NOW + 6);
  assert.equal(block?.window, "rpm");
});

test("gemini-3.1-flash-lite-preview aliases gemini-3.1-flash-lite", () => {
  assert.equal(canonicalizeGeminiModel("gemini-3.1-flash-lite-preview"), "gemini-3.1-flash-lite");
  // rpm=15
  for (let i = 0; i < 15; i++) settleOk("conn-preview", "gemini-3.1-flash-lite-preview", FIXED_NOW + i);
  const block = getGeminiBudgetBlock("conn-preview", "gemini-3.1-flash-lite", FIXED_NOW + 16);
  assert.equal(block?.window, "rpm");
});

test("unknown model has no local limit", () => {
  for (let i = 0; i < 1000; i++) {
    settleOk("conn-unknown", "gemini-totally-unknown-model", FIXED_NOW + i);
  }
  assert.equal(
    getGeminiBudgetBlock("conn-unknown", "gemini-totally-unknown-model", FIXED_NOW + 1001),
    null
  );
});

// ── accountFallback gate wiring ────────────────────────────────────────────

test("isModelLocked/getModelLockoutInfo derive from the ledger for a spent Gemini budget", () => {
  for (let i = 0; i < 5; i++) settleOk("conn-lock", "gemini-3.8-flash", FIXED_NOW + i);
  assert.equal(isModelLocked("gemini", "conn-lock", "gemini-3.8-flash"), true);
  const info = getModelLockoutInfo("gemini", "conn-lock", "gemini-3.8-flash");
  assert.equal(info?.reason, RateLimitReason.RATE_LIMIT_EXCEEDED);
  assert.ok(info!.remainingMs > 0);

  assert.equal(isModelLocked("gemini", "conn-other", "gemini-3.8-flash"), false);
  assert.equal(getModelLockoutInfo("gemini", "conn-other", "gemini-3.8-flash"), null);
});

test("isModelLocked reports a spent RPD budget with the quota-exhausted reason", () => {
  for (let i = 0; i < 20; i++) {
    settleOk("conn-lock-rpd", "gemini-3.8-flash", FIXED_NOW + i * 61_000);
  }
  const nowMs = FIXED_NOW + 20 * 61_000;
  assert.equal(isModelLocked("gemini", "conn-lock-rpd", "gemini-3.8-flash"), true);
  const info = getModelLockoutInfo("gemini", "conn-lock-rpd", "gemini-3.8-flash");
  assert.equal(info?.reason, RateLimitReason.QUOTA_EXHAUSTED);
});

// ── Rehydration ──────────────────────────────────────────────────────────────

test("rehydration seeds dayRequests/RPM/TPM per (connection, canonical model) and ignores 429/5xx rows", () => {
  const midnight = Date.UTC(2024, 6, 15, 7, 0, 0); // 2024-07-15 00:00 PDT
  const rows: GeminiCallLogSeedRow[] = [
    // 18 prior billed requests earlier today for conn-seed / gemini-3.8-flash, well
    // outside the 60s window.
    ...Array.from({ length: 18 }, (_, i) => ({
      connectionId: "conn-seed",
      model: "gemini-3.8-flash",
      status: 200,
      timestampMs: midnight + i * 1800_000,
      tokensIn: 0,
      tokensOut: 0,
    })),
    // A 429 and a 500 earlier today — must NOT count toward dayRequests.
    {
      connectionId: "conn-seed",
      model: "gemini-3.8-flash",
      status: 429,
      timestampMs: midnight + 18 * 1800_000,
      tokensIn: 0,
      tokensOut: 0,
    },
    {
      connectionId: "conn-seed",
      model: "gemini-3.8-flash",
      status: 500,
      timestampMs: midnight + 18 * 1800_000,
      tokensIn: 0,
      tokensOut: 0,
    },
    // An alias row (gemini-flash-latest) in the last 60s — should fold into the same bucket.
    {
      connectionId: "conn-seed",
      model: "gemini-flash-latest",
      status: 200,
      timestampMs: FIXED_NOW - 1000,
      tokensIn: 100,
      tokensOut: 50,
    },
    // A different connection must stay isolated.
    {
      connectionId: "conn-seed-other",
      model: "gemini-3.8-flash",
      status: 200,
      timestampMs: midnight,
      tokensIn: 0,
      tokensOut: 0,
    },
  ];
  setGeminiLedgerSeedSourceForTests(() => rows);

  // 18 seeded + 1 aliased billed row = 19 dayRequests; the 20th (real-time) request trips RPD.
  settleOk("conn-seed", "gemini-3.8-flash", FIXED_NOW);
  const block = getGeminiBudgetBlock("conn-seed", "gemini-3.8-flash", FIXED_NOW + 1);
  assert.equal(block?.window, "rpd");

  assert.equal(getGeminiBudgetBlock("conn-seed-other", "gemini-3.8-flash", FIXED_NOW + 1), null);
});

test("rehydration seeding is fail-open when the seed source throws", () => {
  setGeminiLedgerSeedSourceForTests(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => getGeminiBudgetBlock("conn-fail-open", "gemini-3.8-flash", FIXED_NOW));
  assert.equal(getGeminiBudgetBlock("conn-fail-open", "gemini-3.8-flash", FIXED_NOW), null);
});
