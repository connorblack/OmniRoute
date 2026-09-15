import test from "node:test";
import assert from "node:assert/strict";

// Regression for the zero-timeout production crash: AbortSignal.timeout(0)
// fires on the very next timer tick, so `AbortSignal.timeout(FETCH_TIMEOUT_MS)`
// with FETCH_TIMEOUT_MS=0 (the documented "disabled" convention — see
// src/shared/utils/runtimeTimeouts.ts getUpstreamTimeoutConfig, allowZero:true)
// aborted every long-running upstream call instantly instead of never timing
// out. withTimeoutSignal() / resolveTimeoutSignal() are the single shared
// helper every fetch call site now uses to honor that convention.

test("resolveTimeoutSignal: ms <= 0 returns null (timeout disabled)", async () => {
  const { resolveTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  assert.equal(resolveTimeoutSignal(0), null);
  assert.equal(resolveTimeoutSignal(-1), null);
  assert.equal(resolveTimeoutSignal(Number.NaN), null);
});

test("resolveTimeoutSignal: ms > 0 returns a real AbortSignal that eventually aborts", async () => {
  const { resolveTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  const signal = resolveTimeoutSignal(10);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal!.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signal!.aborted, true);
});

test("withTimeoutSignal: ms=0 with no caller signal never aborts (was: instant abort)", async () => {
  const { withTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  const signal = withTimeoutSignal(undefined, 0);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  // The historical bug fired within one timer tick (0ms). Wait well past
  // that to prove this signal is genuinely inert, not just "not yet".
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signal.aborted, false);
});

test("withTimeoutSignal: ms=0 with a caller signal returns the caller signal unchanged in behavior", async () => {
  const { withTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  const controller = new AbortController();
  const signal = withTimeoutSignal(controller.signal, 0);
  assert.equal(signal.aborted, false);
  controller.abort(new Error("caller aborted"));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).message, "caller aborted");
});

test("withTimeoutSignal: ms>0 with no caller signal aborts on timeout", async () => {
  const { withTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  const signal = withTimeoutSignal(undefined, 10);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signal.aborted, true);
});

test("withTimeoutSignal: ms>0 with a caller signal aborts on whichever fires first (timeout wins)", async () => {
  const { withTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  const controller = new AbortController();
  const signal = withTimeoutSignal(controller.signal, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signal.aborted, true);
});

test("withTimeoutSignal: ms>0 with a caller signal aborts immediately when the caller signal fires first", async () => {
  const { withTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  const controller = new AbortController();
  const signal = withTimeoutSignal(controller.signal, 60_000);
  assert.equal(signal.aborted, false);
  controller.abort(new Error("client disconnected"));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).message, "client disconnected");
});

test("withTimeoutSignal: never returns undefined, matching prior non-optional call-site typing", async () => {
  const { withTimeoutSignal } = await import("../../open-sse/executors/base.ts");
  assert.ok(withTimeoutSignal(undefined, 0) instanceof AbortSignal);
  assert.ok(withTimeoutSignal(null, 0) instanceof AbortSignal);
  assert.ok(withTimeoutSignal(undefined, 1000) instanceof AbortSignal);
});
