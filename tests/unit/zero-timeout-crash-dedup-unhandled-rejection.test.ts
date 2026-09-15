import { test } from "node:test";
import assert from "node:assert/strict";
import { deduplicate, clearInflight } from "../../open-sse/services/requestDedup.ts";

/**
 * Regression for the zero-timeout production crash: a failed upstream
 * attempt (e.g. FETCH_TIMEOUT_MS=0 aborting on the next timer tick, or any
 * other single request failure — reproduced here directly with a rejecting
 * fn) must never crash the process.
 *
 * deduplicate() creates `sharedPromise` and stores it in the in-flight map so
 * a *concurrent duplicate* request can join it via `await existing`. The
 * first (non-duplicate) caller never awaits `sharedPromise` itself — it
 * awaits fn() directly and manually resolve()s/reject()s the deferred pair.
 * When fn() rejects and no concurrent duplicate ever joined, reject(err) on
 * an unobserved promise is an unhandledRejection: Node considers the promise
 * unhandled even though the *same* error is correctly thrown to this call's
 * own awaiter (which is why chatCore's normal error handling/logging still
 * runs — see [ProxyEgress] status=error in the reported crash log — while a
 * second, independent unhandledRejection fires and kills the process).
 *
 * This drives the exact real path: a single (non-duplicate) deduplicate()
 * call whose fn() rejects with the same TimeoutError shape the zero-timeout
 * bug produces, and asserts no unhandledRejection is emitted.
 */
test("deduplicate(): a rejecting fn with no concurrent duplicate must not produce an unhandledRejection", async () => {
  clearInflight();

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    const timeoutError = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError"
    );

    await assert.rejects(
      () => deduplicate(`zero-timeout-crash-${Date.now()}`, () => Promise.reject(timeoutError)),
      (err: unknown) => err === timeoutError
    );

    // Give the microtask/macrotask queue a full turn so a real
    // unhandledRejection (fired on the next tick after the promise settles
    // with no handler attached) has a chance to be observed by the listener
    // above before the test asserts on `unhandled`.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.deepEqual(
    unhandled,
    [],
    `expected no unhandledRejection, got: ${unhandled.map((e) => (e instanceof Error ? e.message : String(e))).join(", ")}`
  );
});

test("deduplicate(): a concurrent duplicate still observes the same rejection as before (behavior preserved)", async () => {
  clearInflight();
  const hash = `zero-timeout-crash-dup-${Date.now()}`;
  const err = new Error("upstream failed");

  const [first, second] = await Promise.allSettled([
    deduplicate(hash, () => Promise.reject(err)),
    deduplicate(hash, () => Promise.reject(new Error("should never run — joins first"))),
  ]);

  assert.equal(first.status, "rejected");
  assert.equal(second.status, "rejected");
  if (first.status === "rejected") assert.equal(first.reason, err);
  if (second.status === "rejected") assert.equal(second.reason, err);
});
