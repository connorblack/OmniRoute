import test from "node:test";
import assert from "node:assert/strict";

import { getModelInfoCore } from "../../open-sse/services/model.ts";

test("cross-proxy aliases normalize to canonical model ids without bypassing local aliases", async () => {
  const localAliasWins = await getModelInfoCore("gpt-oss:120b", {
    "gpt-oss:120b": "openai/gpt-4o",
  });
  assert.deepEqual(localAliasWins, {
    provider: "openai",
    model: "gpt-4o",
    extendedContext: false,
  });

  const crossProxyAlias = await getModelInfoCore("gpt-oss:120b", {});
  assert.equal(crossProxyAlias.model, "gpt-oss-120b");
  if (crossProxyAlias.errorType === "ambiguous_model") {
    assert.equal(crossProxyAlias.provider, null);
  } else {
    // If an active connection exists, it dynamically resolves the provider
    assert.ok(typeof crossProxyAlias.provider === "string");
  }
});

test("slashful canonical model ids are treated as exact model ids when provider pairing is invalid", async () => {
  const slashfulCanonical = await getModelInfoCore("openai/gpt-oss-120b", {});
  assert.equal(slashfulCanonical.model, "openai/gpt-oss-120b");
  if (slashfulCanonical.errorType === "ambiguous_model") {
    assert.equal(slashfulCanonical.provider, null);
  } else {
    assert.ok(typeof slashfulCanonical.provider === "string");
  }
});

test("explicit OpenAI provider routes can preserve catalog-lagging OpenAI model ids", async () => {
  assert.deepEqual(await getModelInfoCore("openai/gpt-4o-mini", {}), {
    provider: "openai",
    model: "gpt-4o-mini",
    extendedContext: false,
  });
});

test("explicit provider routes can still normalize cross-proxy model dialects", async () => {
  const explicitProviderCompat = await getModelInfoCore("nvidia/gpt-oss:120b", {});
  assert.deepEqual(explicitProviderCompat, {
    provider: "nvidia",
    model: "openai/gpt-oss-120b",
    extendedContext: false,
  });

  const aliasTargetCompat = await getModelInfoCore("sf-qwen", {
    "sf-qwen": { provider: "siliconflow", model: "qwen3-coder:480b" },
  });
  assert.deepEqual(aliasTargetCompat, {
    provider: "siliconflow",
    model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    extendedContext: false,
  });
});

test("Kiro Claude Code-style model aliases resolve without polluting the visible catalog", async () => {
  assert.deepEqual(await getModelInfoCore("kr/claude-opus-4-7", {}), {
    provider: "kiro",
    model: "claude-opus-4.7",
    extendedContext: false,
  });

  assert.deepEqual(await getModelInfoCore("kiro/claude-sonnet-4-6", {}), {
    provider: "kiro",
    model: "claude-sonnet-4.6",
    extendedContext: false,
  });
});

test("ollama-cloud native colon-form ids are not rewritten by the cross-proxy dialect table (#regression)", async () => {
  // Ollama Cloud's own catalog uses the colon form ("gpt-oss:120b"), which is also
  // a CROSS_PROXY_MODEL_ALIASES source key added for NVIDIA NIM's dialect. Applying
  // that global rewrite regardless of destination provider turned a valid Ollama
  // Cloud request into "gpt-oss-120b", an id Ollama Cloud's live catalog never had,
  // and every chat completion 404'd as "not available in the active live catalog".
  assert.deepEqual(await getModelInfoCore("ollamacloud/gpt-oss:120b", {}), {
    provider: "ollama-cloud",
    model: "gpt-oss:120b",
    extendedContext: false,
  });

  assert.deepEqual(await getModelInfoCore("ollama-cloud/gpt-oss:120b", {}), {
    provider: "ollama-cloud",
    model: "gpt-oss:120b",
    extendedContext: false,
  });

  // gpt-oss:20b was never in CROSS_PROXY_MODEL_ALIASES, but it exercises the same
  // native-id guard and must keep passing through untouched.
  assert.deepEqual(await getModelInfoCore("ollamacloud/gpt-oss:20b", {}), {
    provider: "ollama-cloud",
    model: "gpt-oss:20b",
    extendedContext: false,
  });
});

