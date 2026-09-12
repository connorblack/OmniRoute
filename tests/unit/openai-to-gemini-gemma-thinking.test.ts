import test from "node:test";
import assert from "node:assert/strict";

// Regression guard for the OpenAI→Gemini translation of Gemma models.
// claude-to-gemini.ts already guards against sending `thinkingConfig` for
// gemma-4-* models (Gemma does not support it — Vertex returns 400:
// "Thinking budget is not supported for this model"). openai-to-gemini.ts
// lacked the same guard, so OpenAI-shape clients hitting a vertex
// `gemma-4-*` model still triggered the 400.
// Port of the thinkingConfig-guard half of decolua/9router#2480 (the
// signature-replay half of that PR is out of scope and NOT ported here).
const { openaiToGeminiRequest } = await import(
  "../../open-sse/translator/request/openai-to-gemini.ts"
);

type GeminiRequestResult = {
  generationConfig?: { thinkingConfig?: unknown };
};

test("gemma-4 model: reasoning_effort does NOT produce a thinkingConfig", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.equal(
    result.generationConfig?.thinkingConfig,
    undefined,
    "gemma-4 models must never receive thinkingConfig (Vertex returns 400)"
  );
});

test("gemma-4 model: Claude-style thinking.budget_tokens does NOT produce a thinkingConfig", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.equal(
    result.generationConfig?.thinkingConfig,
    undefined,
    "gemma-4 models must never receive thinkingConfig even via the Claude-shape thinking field"
  );
});

test("non-gemma gemini model: reasoning_effort STILL produces a thinkingConfig (no regression)", () => {
  const result = openaiToGeminiRequest(
    "gemini-2.5-flash",
    {
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.ok(
    result.generationConfig?.thinkingConfig,
    "non-gemma Gemini models must keep receiving thinkingConfig"
  );
});
test("gemma-4 model: reasoning_effort none maps to thinkingLevel minimal (no thinkingBudget)", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.deepEqual(result.generationConfig?.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: reasoning_effort minimal also maps to thinkingLevel minimal", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "minimal",
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.deepEqual(result.generationConfig?.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: Claude-shape thinking disabled maps to thinkingLevel minimal", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.deepEqual(result.generationConfig?.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: Claude-shape thinking enabled with a zero budget maps to thinkingLevel minimal", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 0 },
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.deepEqual(result.generationConfig?.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: no reasoning param at all still produces no thinkingConfig", () => {
  const result = openaiToGeminiRequest(
    "gemma-4-31b-it",
    {
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.equal(result.generationConfig?.thinkingConfig, undefined);
});

test("non-gemma gemini model: reasoning_effort none keeps the numeric thinkingBudget off-switch (unaffected by the gemma-4 branch)", () => {
  const result = openaiToGeminiRequest(
    "gemini-3.8-flash",
    {
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
      stream: false,
    },
    false
  ) as GeminiRequestResult;

  assert.deepEqual(result.generationConfig?.thinkingConfig, {
    thinkingBudget: 0,
    includeThoughts: false,
  });
});
