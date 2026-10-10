/**
 * `request.completed` and `request.failed` webhook events must fire for every way a request is
 * served, exactly once per client request.
 *
 * They used to be sent only from the generic combo attempt loop (`executeTargetAttempt` /
 * `comboAttemptLoop`). Round-robin combos (`roundRobinCombo.ts`), priority combos that execute
 * nested combo references (`runtimeUnits.ts`) and direct model calls (`handleSingleModelChat`)
 * never reached it, so a webhook subscribed to those events saw no traffic from them.
 *
 * Each case drives the real `handleChat` pipeline against a real webhook row and a loopback
 * receiver, and asserts on what the receiver was sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

// The receiver listens on loopback, which the webhook URL guard blocks unless the operator opts in.
const ORIGINAL_ALLOW_PRIVATE_URLS = process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";

const harness = await createChatPipelineHarness("webhook-request-events");
const { buildOpenAIResponse, buildRequest, combosDb, handleChat, resetStorage, seedConnection } =
  harness;
const webhooksDb = await import("../../src/lib/db/webhooks.ts");

type Delivery = { event: string; data: Record<string, unknown> };

const COMPLETED_KEYS = [
  "account",
  "accountId",
  "combo",
  "fallbackCount",
  "latencyMs",
  "model",
  "provider",
];
const FAILED_KEYS = ["combo", "fallbackCount", "latencyMs", "reason"];

let receiver: http.Server | null = null;
let deliveries: Delivery[] = [];

async function startReceiver(): Promise<void> {
  deliveries = [];
  receiver = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(raw) as { event: string; data: Record<string, unknown> };
      deliveries.push({ event: parsed.event, data: parsed.data });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver!.listen(0, "127.0.0.1", resolve));
  const { port } = receiver.address() as AddressInfo;
  webhooksDb.createWebhook({
    url: `http://127.0.0.1:${port}/hook`,
    events: ["request.completed", "request.failed"],
  });
}

async function stopReceiver(): Promise<void> {
  if (!receiver) return;
  const server = receiver;
  receiver = null;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Webhook delivery is fire-and-forget: wait for the expected count, then for any stray extras. */
async function settledDeliveries(expected: number): Promise<Delivery[]> {
  const deadline = Date.now() + 3000;
  while (deliveries.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return [...deliveries];
}

function chat(model: string) {
  return handleChat(
    buildRequest({ body: { model, stream: false, messages: [{ role: "user", content: "hi" }] } })
  );
}

function upstreamOk() {
  globalThis.fetch = async () => buildOpenAIResponse("hello", "gpt-4o-mini");
}

function upstreamFails(status = 503) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "upstream refused" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

function assertSingle(sent: Delivery[], event: string, keys: string[]): Delivery {
  assert.deepEqual(
    sent.map((d) => d.event),
    [event],
    `expected exactly one ${event}, got ${JSON.stringify(sent)}`
  );
  assert.deepEqual(Object.keys(sent[0].data).sort(), keys);
  assert.equal(typeof sent[0].data.latencyMs, "number");
  assert.equal(typeof sent[0].data.fallbackCount, "number");
  return sent[0];
}

test.beforeEach(async () => {
  await resetStorage();
  harness.BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await startReceiver();
});

test.afterEach(async () => {
  await stopReceiver();
  await resetStorage();
});

test.after(async () => {
  if (ORIGINAL_ALLOW_PRIVATE_URLS === undefined) {
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  } else {
    process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = ORIGINAL_ALLOW_PRIVATE_URLS;
  }
  await harness.cleanup();
});

async function createRoundRobinCombo(name: string, models: string[]) {
  await combosDb.createCombo({
    name,
    strategy: "round-robin",
    config: { maxRetries: 0, retryDelayMs: 0, disableSessionStickiness: true },
    models,
  });
}

test("round-robin combo: a successful request sends one request.completed", async () => {
  const connection = await seedConnection("openai", { apiKey: "sk-openai-rr-ok" });
  await createRoundRobinCombo("wh-rr-ok", ["openai/gpt-4o-mini"]);
  upstreamOk();

  const response = await chat("wh-rr-ok");
  assert.equal(response.status, 200);

  const event = assertSingle(await settledDeliveries(1), "request.completed", COMPLETED_KEYS);
  assert.equal(event.data.combo, "wh-rr-ok");
  assert.equal(event.data.provider, "openai");
  assert.equal(event.data.model, "openai/gpt-4o-mini");
  assert.equal(event.data.accountId, connection.id);
  assert.equal(event.data.fallbackCount, 0);
});

test("round-robin combo: a failed request sends one request.failed", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-rr-fail" });
  await createRoundRobinCombo("wh-rr-fail", ["openai/gpt-4o-mini"]);
  upstreamFails();

  const response = await chat("wh-rr-fail");
  assert.equal(response.ok, false);

  const event = assertSingle(await settledDeliveries(1), "request.failed", FAILED_KEYS);
  assert.equal(event.data.combo, "wh-rr-fail");
  assert.equal(event.data.reason, `HTTP_${response.status}`);
});

async function createExecuteModeParent(name: string, steps: unknown[]) {
  await combosDb.createCombo({
    name,
    strategy: "priority",
    config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
    models: steps,
  });
}

test("priority combo running a nested combo reference: success is counted once", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-nested-ok" });
  await combosDb.createCombo({
    name: "wh-child-ok",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["openai/gpt-4o-mini"],
  });
  await createExecuteModeParent("wh-parent-ok", [{ kind: "combo-ref", comboName: "wh-child-ok" }]);
  upstreamOk();

  const response = await chat("wh-parent-ok");
  assert.equal(response.status, 200);

  const event = assertSingle(await settledDeliveries(1), "request.completed", COMPLETED_KEYS);
  assert.equal(event.data.model, "openai/gpt-4o-mini");
});

test("priority combo running a nested combo reference: a model unit that serves after the child fails sends one request.completed", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-nested-mixed" });
  await seedConnection("anthropic", { apiKey: "sk-ant-nested-mixed" });
  await createRoundRobinCombo("wh-child-mixed", ["anthropic/claude-3-5-sonnet-20241022"]);
  await createExecuteModeParent("wh-parent-mixed", [
    { kind: "combo-ref", comboName: "wh-child-mixed" },
    "openai/gpt-4o-mini",
  ]);
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.includes("anthropic") ? new Response("{}", { status: 503 }) : buildOpenAIResponse();
  };

  const response = await chat("wh-parent-mixed");
  assert.equal(response.status, 200);

  const event = assertSingle(await settledDeliveries(1), "request.completed", COMPLETED_KEYS);
  assert.equal(event.data.combo, "wh-parent-mixed");
  assert.equal(event.data.model, "openai/gpt-4o-mini");
});

test("priority combo running a nested combo reference: a failure is counted once, not by the child as well", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-nested-fail" });
  await createRoundRobinCombo("wh-child-fail", ["openai/gpt-4o-mini"]);
  await createExecuteModeParent("wh-parent-fail", [
    { kind: "combo-ref", comboName: "wh-child-fail" },
  ]);
  upstreamFails();

  const response = await chat("wh-parent-fail");
  assert.equal(response.ok, false);

  const event = assertSingle(await settledDeliveries(1), "request.failed", FAILED_KEYS);
  assert.equal(event.data.combo, "wh-parent-fail");
});

test("direct model call: a successful request sends one request.completed", async () => {
  const connection = await seedConnection("openai", { apiKey: "sk-openai-direct-ok" });
  upstreamOk();

  const response = await chat("openai/gpt-4o-mini");
  assert.equal(response.status, 200);

  const event = assertSingle(await settledDeliveries(1), "request.completed", COMPLETED_KEYS);
  assert.equal(event.data.combo, "");
  assert.equal(event.data.provider, "openai");
  assert.equal(event.data.model, "openai/gpt-4o-mini");
  assert.equal(event.data.accountId, connection.id);
  assert.equal(event.data.fallbackCount, 0);
});

test("direct model call: a failed request sends one request.failed", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-direct-fail" });
  // A 4xx is final. A 5xx would put the lone connection into the 3 x 3s cooldown-retry wait.
  upstreamFails(400);

  const response = await chat("openai/gpt-4o-mini");
  assert.equal(response.ok, false);

  const event = assertSingle(await settledDeliveries(1), "request.failed", FAILED_KEYS);
  assert.equal(event.data.combo, "");
  assert.equal(event.data.reason, `HTTP_${response.status}`);
});
