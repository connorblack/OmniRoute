import test from "node:test";
import assert from "node:assert/strict";

// Regression guard for the Claude->Gemini translation of Gemma 4 models.
// gemma-4-* returns 400 "Thinking budget is not supported for this model" for any
// thinkingBudget, and 400 "Thinking level is not supported for this model" for any
// thinkingLevel other than "minimal". Before this fix, an explicit turn-it-down
// request (Claude thinking disabled, a zero budget_tokens, or Claude Code's
// output_config.effort "none") was silently dropped, leaving Gemma 4's default
// thinking ON — a short/small max_tokens request then burns the whole output
// budget on thought tokens and returns empty text (finishReason MAX_TOKENS).
const { claudeToGeminiRequest } = await import(
  "../../open-sse/translator/request/claude-to-gemini.ts"
);

test("gemma-4 model: thinking disabled maps to thinkingLevel minimal (no thinkingBudget)", () => {
  const result = claudeToGeminiRequest(
    "gemma-4-31b-it",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "disabled" },
    },
    false
  );

  assert.deepEqual(result.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: thinking enabled with a zero budget maps to thinkingLevel minimal", () => {
  const result = claudeToGeminiRequest(
    "gemma-4-31b-it",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 0 },
    },
    false
  );

  assert.deepEqual(result.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: output_config.effort none maps to thinkingLevel minimal", () => {
  const result = claudeToGeminiRequest(
    "gemma-4-31b-it",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      output_config: { effort: "none" },
    },
    false
  );

  assert.deepEqual(result.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
});

test("gemma-4 model: thinking enabled with a nonzero budget still produces no thinkingConfig", () => {
  const result = claudeToGeminiRequest(
    "gemma-4-31b-it",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 4096 },
    },
    false
  );

  assert.equal(
    result.generationConfig.thinkingConfig,
    undefined,
    "gemma-4 models must never receive a numeric thinkingBudget (Google returns 400)"
  );
});

test("gemma-4 model: no thinking param at all produces no thinkingConfig", () => {
  const result = claudeToGeminiRequest(
    "gemma-4-31b-it",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
    false
  );

  assert.equal(result.generationConfig.thinkingConfig, undefined);
});

test("non-gemma gemini model: thinking enabled with a zero budget keeps the numeric off-switch (unaffected by the gemma-4 branch)", () => {
  const result = claudeToGeminiRequest(
    "gemini-3.8-flash",
    {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "enabled", budget_tokens: 0 },
    },
    false
  );

  assert.deepEqual(result.generationConfig.thinkingConfig, {
    thinkingBudget: 0,
    includeThoughts: true,
  });
});
