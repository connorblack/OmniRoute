/**
 * Issue #2331 — Codex model alias effort suffixes
 * (`gpt-5.5-xhigh`, `-high`, `-medium`, `-low`) are the user's explicit
 * routing choice and must override a client-injected `reasoning.effort`
 * default. OpenCode auto-injects `reasoning.effort=medium` for GPT-5-family
 * requests, which used to silently mask the suffix.
 *
 * The fix is in `open-sse/executors/codex.ts`: priority is
 *   forcedEffort > modelEffort > explicitReasoning > requestReasoningEffort > fallback.
 * `forcedEffort` is an operator reasoning rule in `force` mode (#13556). It is
 * server-selected request-local context that clients cannot forge, so it
 * outranks the suffix; the suffix still outranks every client-supplied value.
 *
 * These tests exercise the effort-resolution priority directly via a
 * small re-implementation of the resolution chain so we don't have to
 * spin up the full Codex executor (which talks to upstream).
 */
import test from "node:test";
import assert from "node:assert/strict";

// Replicate the rawEffort priority chain in open-sse/executors/codex.ts so
// tests fail loudly if someone reverts the order.
type Inputs = {
  forcedEffort?: string | undefined;
  modelEffort: string | null;
  explicitReasoning: string | undefined;
  requestReasoningEffort: string | undefined;
  fallbackReasoningEffort: string | undefined;
};

function resolveEffort(i: Inputs): string | undefined {
  return (
    i.forcedEffort ||
    i.modelEffort ||
    i.explicitReasoning ||
    i.requestReasoningEffort ||
    i.fallbackReasoningEffort ||
    undefined
  );
}

test("#2331 model suffix wins over client reasoning.effort default", () => {
  const out = resolveEffort({
    modelEffort: "xhigh",
    explicitReasoning: "medium", // OpenCode default
    requestReasoningEffort: undefined,
    fallbackReasoningEffort: undefined,
  });
  assert.equal(out, "xhigh");
});

test("#13556 operator force rule wins over the model suffix", () => {
  const out = resolveEffort({
    forcedEffort: "low",
    modelEffort: "xhigh",
    explicitReasoning: "medium",
    requestReasoningEffort: undefined,
    fallbackReasoningEffort: undefined,
  });
  assert.equal(out, "low");
});

test("#2331 model suffix wins over body.reasoning_effort field too", () => {
  const out = resolveEffort({
    modelEffort: "low",
    explicitReasoning: undefined,
    requestReasoningEffort: "high",
    fallbackReasoningEffort: undefined,
  });
  assert.equal(out, "low");
});

test("#2331 without suffix, explicit client effort still works (backward compat)", () => {
  const out = resolveEffort({
    modelEffort: null,
    explicitReasoning: "high",
    requestReasoningEffort: undefined,
    fallbackReasoningEffort: "medium",
  });
  assert.equal(out, "high");
});

test("#2331 without suffix or client value, connection fallback applies", () => {
  const out = resolveEffort({
    modelEffort: null,
    explicitReasoning: undefined,
    requestReasoningEffort: undefined,
    fallbackReasoningEffort: "medium",
  });
  assert.equal(out, "medium");
});

test("#2331 no input anywhere → undefined (caller will skip body.reasoning)", () => {
  const out = resolveEffort({
    modelEffort: null,
    explicitReasoning: undefined,
    requestReasoningEffort: undefined,
    fallbackReasoningEffort: undefined,
  });
  assert.equal(out, undefined);
});

// ─── Regression check on the actual source ─────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_SRC = path.resolve(__dirname, "../../open-sse/executors/codex.ts");

test("#2331 codex.ts ranks modelEffort above every client-supplied effort", () => {
  const src = fs.readFileSync(CODEX_SRC, "utf8");

  // Anchor on the assignment so a refactor that lets a client value outrank the
  // suffix (the #2331 bug) or drops the operator force rule (#13556) trips this guard.
  const ASSIGNMENT_RE = /const\s+rawEffort\s*=\s*([\s\S]{0,400}?);/;
  const match = src.match(ASSIGNMENT_RE);
  assert.ok(match, "rawEffort assignment not found in codex.ts");

  const chain = match![1].replace(/\s+/g, " ").trim();
  const tokens = chain.split("||").map((token) => token.trim());
  assert.deepEqual(
    tokens,
    [
      "getForcedReasoningEffort(credentials)",
      "modelEffort",
      "explicitReasoning",
      "requestReasoningEffort",
      "fallbackReasoningEffort",
    ],
    `rawEffort priority chain must be forced > modelEffort > client values > fallback, got: ${chain}`
  );
});
