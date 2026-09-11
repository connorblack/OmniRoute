import test from "node:test";
import assert from "node:assert/strict";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";

const credentials = { apiKey: "sk-or-test", connectionId: "openrouter-attribution-test" };
const HERMES_REFERER = "https://hermes-agent.nousresearch.com";

test("openrouter: forwards the caller's attribution headers", () => {
  const headers = new DefaultExecutor("openrouter").buildHeaders(credentials, true, {
    "http-referer": HERMES_REFERER,
    "x-title": "Hermes Agent",
    "x-openrouter-categories": "productivity,cli-agent",
  });
  assert.equal(headers["HTTP-Referer"], HERMES_REFERER);
  assert.equal(headers["X-Title"], "Hermes Agent");
  assert.equal(headers["X-OpenRouter-Categories"], "productivity,cli-agent");
  assert.deepEqual(
    Object.keys(headers).filter((key) => key.toLowerCase() === "x-title"),
    ["X-Title"]
  );
});

test("openrouter: drops the proxy title when the caller sends only a referer", () => {
  const headers = new DefaultExecutor("openrouter").buildHeaders(credentials, true, {
    "http-referer": HERMES_REFERER,
  });
  assert.equal(headers["HTTP-Referer"], HERMES_REFERER);
  assert.equal(headers["X-Title"], undefined);
});

test("openrouter: keeps the registry attribution when the caller sends none", () => {
  const headers = new DefaultExecutor("openrouter").buildHeaders(credentials, true, {
    "user-agent": "curl/8.7.1",
  });
  assert.equal(headers["HTTP-Referer"], "https://endpoint-proxy.local");
  assert.equal(headers["X-Title"], "Endpoint Proxy");
});

test("other providers do not forward caller attribution headers", () => {
  const headers = new DefaultExecutor("openai").buildHeaders(credentials, true, {
    "http-referer": HERMES_REFERER,
  });
  assert.equal(headers["HTTP-Referer"], undefined);
});
