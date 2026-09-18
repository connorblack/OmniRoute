import { test } from "node:test";
import assert from "node:assert/strict";
import { getCanonicalModelSpecId, getModelSpec } from "../../src/shared/constants/modelSpecs";

test("deepseek-v4.1 ids resolve to the v4 spec with the measured 384K output ceiling", () => {
  for (const id of [
    "deepseek-v4.1-flash",
    "ollama-cloud/deepseek-v4.1-flash",
    "DeepSeek-V4.1-Flash",
    "deepseek-v4-flash",
  ]) {
    assert.equal(getCanonicalModelSpecId(id), "deepseek-v4-flash", id);
    assert.equal(getModelSpec(id)?.maxOutputTokens, 393216, id);
    assert.equal(getModelSpec(id)?.contextWindow, 1000000, id);
  }
  for (const id of ["deepseek-v4.1-pro", "ollama-cloud/deepseek-v4.1-pro"]) {
    assert.equal(getCanonicalModelSpecId(id), "deepseek-v4-pro", id);
    assert.equal(getModelSpec(id)?.maxOutputTokens, 393216, id);
  }
});

test("the thinking cap leaves room under the output ceiling", () => {
  const spec = getModelSpec("deepseek-v4.1-flash");
  assert.ok(
    spec?.thinkingBudgetCap && spec.maxOutputTokens && spec.thinkingBudgetCap < spec.maxOutputTokens
  );
});
