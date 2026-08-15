/**
 * Cursor ACP transport unit tests.
 *
 * Following tests/unit/auggie-executor.test.ts: rather than mocking
 * node:child_process (fragile under ESM without --experimental-vm-modules),
 * these point `ACPX_BIN` at disposable shell scripts that emit canned ACP
 * JSON-RPC frames. No live acpx or cursor-agent binary is required — CI never
 * needs a Cursor subscription.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  buildCursorAcpArgs,
  parseAcpModelId,
  parseAdvertisedModels,
  getCursorAcpModels,
  isCursorAcpModelFailure,
  resolveCursorAcpModel,
  __resetCursorAcpModelCache,
} = await import("@omniroute/open-sse/services/cursorAcp");

const { buildCursorAcpPrompt, executeCursorAcp, mapStopReason, translateCursorAcpFrame } =
  await import("@omniroute/open-sse/services/cursorAcpTransport");

const { isCursorAcpTransport } = await import("@omniroute/open-sse/executors/cursor");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cursor-acp-test-"));

const SONNET = "claude-sonnet-5[thinking=true,context=300k,effort=high]";
const OPUS_47 = "claude-opus-4-7[thinking=true,context=300k,effort=xhigh,fast=false]";

const SESSION_NEW_FRAME = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    sessionId: "test-session",
    models: {
      currentModelId: SONNET,
      availableModels: [
        { modelId: "default[]", name: "Auto" },
        { modelId: SONNET, name: "claude-sonnet-5" },
        { modelId: OPUS_47, name: "claude-opus-4-7" },
        { modelId: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", name: "gpt-5.6-sol" },
      ],
    },
  },
});

/** The caller's prompt travels on the wire too — it must never be echoed back. */
const PROMPT_ECHO_FRAME = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "session/prompt",
  params: { sessionId: "test-session", prompt: [{ type: "text", text: "ECHOED_PROMPT_TEXT" }] },
});

function chunkFrame(text: string, kind = "agent_message_chunk"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "test-session",
      update: { sessionUpdate: kind, content: { type: "text", text } },
    },
  });
}

function stopFrame(stopReason = "end_turn"): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { stopReason } });
}

function writeFakeBin(name: string, script: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return p;
}

function writeFakeAcpx(name: string, frames: string[]): { bin: string; argvFile: string } {
  const argvFile = path.join(TMP_DIR, `${name}.argv`);
  const echoes = frames.map((f) => `printf '%s\\n' ${JSON.stringify(f)}`).join("\n");
  const bin = writeFakeBin(
    name,
    [`printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`, "cat > /dev/null", echoes].join("\n")
  );
  return { bin, argvFile };
}

async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

function sseText(events: Record<string, unknown>[]): string {
  let out = "";
  for (const e of events) {
    const choices = (e as { choices?: { delta?: { content?: string } }[] }).choices;
    if (choices?.[0]?.delta?.content) out += choices[0].delta.content;
  }
  return out;
}

const ORIGINAL_ACPX_BIN = process.env.ACPX_BIN;

test.beforeEach(() => {
  __resetCursorAcpModelCache();
});

test.after(() => {
  if (ORIGINAL_ACPX_BIN === undefined) delete process.env.ACPX_BIN;
  else process.env.ACPX_BIN = ORIGINAL_ACPX_BIN;
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── transport selection ─────────────────────────────────────────────────────

test("isCursorAcpTransport only opts in on an explicit acp transport", () => {
  assert.equal(isCursorAcpTransport({ providerSpecificData: { transport: "acp" } }), true);
  assert.equal(isCursorAcpTransport({ providerSpecificData: { transport: "ACP" } }), true);
  // Default must stay on the HTTP/protobuf path so existing connections are
  // untouched by this feature.
  assert.equal(isCursorAcpTransport({ providerSpecificData: {} }), false);
  assert.equal(isCursorAcpTransport({ providerSpecificData: { transport: "http" } }), false);
  assert.equal(isCursorAcpTransport({}), false);
  assert.equal(isCursorAcpTransport(null), false);
});

// ─── advertised id parsing ───────────────────────────────────────────────────

test("parseAcpModelId splits the base id from its parameters", () => {
  assert.deepEqual(parseAcpModelId(SONNET), {
    baseId: "claude-sonnet-5",
    parameters: { thinking: "true", context: "300k", effort: "high" },
  });
  assert.deepEqual(parseAcpModelId("gemini-3-flash[]"), {
    baseId: "gemini-3-flash",
    parameters: {},
  });
  assert.deepEqual(parseAcpModelId("sonnet"), { baseId: "sonnet", parameters: {} });
});

test("parseAdvertisedModels keeps the base id alongside the full ACP id", () => {
  const models = parseAdvertisedModels(JSON.parse(SESSION_NEW_FRAME).result.models.availableModels);
  assert.equal(models.length, 4);
  assert.equal(models[0].baseId, "default");
  assert.equal(models[1].baseId, "claude-sonnet-5");
  assert.equal(models[1].acpModelId, SONNET);
});

// ─── model selection (via the shared resolver) ───────────────────────────────

const ADVERTISED = parseAdvertisedModels(
  JSON.parse(SESSION_NEW_FRAME).result.models.availableModels
);

test("resolveCursorAcpModel maps a flattened effort suffix onto the advertised id", () => {
  // resolveRequestedModel decomposes this to { claude-sonnet-5, effort=high },
  // which matches what the agent advertises.
  const r = resolveCursorAcpModel("claude-sonnet-5-high", ADVERTISED);
  assert.ok(!isCursorAcpModelFailure(r));
  assert.equal(r.acpModelId, SONNET);
});

test("resolveCursorAcpModel maps auto through the shared resolver's default", () => {
  // No auto-specific branch exists in the ACP code: resolveRequestedModel
  // already returns model_id "default" for "auto".
  const r = resolveCursorAcpModel("auto", ADVERTISED);
  assert.ok(!isCursorAcpModelFailure(r));
  assert.equal(r.acpModelId, "default[]");
});

test("resolveCursorAcpModel accepts a bare base id", () => {
  const r = resolveCursorAcpModel("claude-sonnet-5", ADVERTISED);
  assert.ok(!isCursorAcpModelFailure(r));
  assert.equal(r.acpModelId, SONNET);
});

test("resolveCursorAcpModel accepts a fully-qualified advertised id", () => {
  const r = resolveCursorAcpModel(OPUS_47, ADVERTISED);
  assert.ok(!isCursorAcpModelFailure(r));
  assert.equal(r.acpModelId, OPUS_47);
});

test("resolveCursorAcpModel refuses an effort the agent did not advertise", () => {
  // The agent answers ACP -32602 for a constructed parameterisation, so this
  // must fail loudly rather than silently downgrade xhigh -> high.
  const r = resolveCursorAcpModel("claude-sonnet-5-xhigh", ADVERTISED);
  assert.ok(isCursorAcpModelFailure(r));
  assert.match(r.error, /requests effort=xhigh/);
  assert.match(r.error, /advertises effort=high/);
  assert.match(r.error, /HTTP transport/);
});

test("resolveCursorAcpModel routes a model whose advertised effort IS xhigh", () => {
  const r = resolveCursorAcpModel("claude-opus-4-7-xhigh", ADVERTISED);
  assert.ok(!isCursorAcpModelFailure(r));
  assert.equal(r.acpModelId, OPUS_47);
});

test("resolveCursorAcpModel rejects an unadvertised base model", () => {
  const r = resolveCursorAcpModel("gpt-9", ADVERTISED);
  assert.ok(isCursorAcpModelFailure(r));
  assert.match(r.error, /not available over the ACP transport/);
});

test("resolveCursorAcpModel rejects flag smuggling", () => {
  const r = resolveCursorAcpModel("--approve-all", ADVERTISED);
  assert.ok(isCursorAcpModelFailure(r));
  assert.match(r.error, /must not start with/);
});

test("resolveCursorAcpModel explains an empty catalog", () => {
  const r = resolveCursorAcpModel("claude-sonnet-5", []);
  assert.ok(isCursorAcpModelFailure(r));
  assert.match(r.error, /could not read the agent's model list/);
});

// ─── argv ────────────────────────────────────────────────────────────────────

test("buildCursorAcpArgs pins the agent to pure-model mode", () => {
  const args = buildCursorAcpArgs(SONNET, "/tmp/neutral");
  for (const flag of ["--deny-all", "--no-fs", "--no-terminal", "--allowed-tools"]) {
    assert.ok(args.includes(flag), `expected ${flag} in argv`);
  }
  assert.equal(args[args.indexOf("--model") + 1], SONNET);
  assert.equal(args[args.indexOf("--cwd") + 1], "/tmp/neutral");
  assert.deepEqual(args.slice(-4), ["cursor", "exec", "-f", "-"]);
});

test("buildCursorAcpArgs omits --model for discovery", () => {
  assert.ok(!buildCursorAcpArgs(null, "/tmp/neutral").includes("--model"));
});

// ─── prompt + frames ─────────────────────────────────────────────────────────

test("buildCursorAcpPrompt flattens turns with role tags", () => {
  assert.equal(
    buildCursorAcpPrompt([
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ]),
    "[System]\nBe terse.\n\n[User]\nhi"
  );
});

test("translateCursorAcpFrame ignores the session/prompt echo of the caller's text", () => {
  assert.equal(translateCursorAcpFrame(JSON.parse(PROMPT_ECHO_FRAME)), null);
});

test("translateCursorAcpFrame ignores the session/new result", () => {
  assert.equal(translateCursorAcpFrame(JSON.parse(SESSION_NEW_FRAME)), null);
});

test("translateCursorAcpFrame maps chunks, thoughts, stop and errors", () => {
  assert.deepEqual(translateCursorAcpFrame(JSON.parse(chunkFrame("hi"))), {
    kind: "text",
    text: "hi",
  });
  assert.deepEqual(
    translateCursorAcpFrame(JSON.parse(chunkFrame("think", "agent_thought_chunk"))),
    { kind: "thought", text: "think" }
  );
  assert.deepEqual(translateCursorAcpFrame(JSON.parse(stopFrame())), {
    kind: "done",
    finishReason: "stop",
  });
  assert.deepEqual(translateCursorAcpFrame({ error: { message: "boom" } }), {
    kind: "error",
    message: "boom",
  });
});

test("mapStopReason maps ACP stop reasons to OpenAI finish reasons", () => {
  assert.equal(mapStopReason("end_turn"), "stop");
  assert.equal(mapStopReason("max_tokens"), "length");
  assert.equal(mapStopReason("refusal"), "content_filter");
});

// ─── discovery ───────────────────────────────────────────────────────────────

test("getCursorAcpModels discovers the advertised list", async () => {
  const { bin } = writeFakeAcpx("acpx-discover", [SESSION_NEW_FRAME, chunkFrame("x"), stopFrame()]);
  process.env.ACPX_BIN = bin;
  const models = await getCursorAcpModels({ forceRefresh: true });
  assert.equal(models.length, 4);
  assert.equal(models[1].acpModelId, SONNET);
});

test("getCursorAcpModels caches and does not respawn", async () => {
  const { bin, argvFile } = writeFakeAcpx("acpx-cache", [SESSION_NEW_FRAME, stopFrame()]);
  process.env.ACPX_BIN = bin;
  await getCursorAcpModels({ forceRefresh: true });
  const first = fs.statSync(argvFile).mtimeMs;
  await getCursorAcpModels();
  assert.equal(fs.statSync(argvFile).mtimeMs, first, "cache hit should not respawn acpx");
});

test("getCursorAcpModels returns empty when the binary is missing", async () => {
  process.env.ACPX_BIN = path.join(TMP_DIR, "does-not-exist");
  assert.deepEqual(await getCursorAcpModels({ forceRefresh: true }), []);
});

// ─── execute ─────────────────────────────────────────────────────────────────

test("executeCursorAcp (non-streaming) returns a chat.completion body", async () => {
  const { bin } = writeFakeAcpx("acpx-nonstream", [
    SESSION_NEW_FRAME,
    PROMPT_ECHO_FRAME,
    chunkFrame("Hello"),
    chunkFrame(" world"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const { response } = await executeCursorAcp({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
  });
  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, never>;
  assert.equal(json.object, "chat.completion");
  // The caller-facing id is echoed, not the bracket-parameterised ACP id.
  assert.equal(json.model, "claude-sonnet-5");
  assert.equal(json.choices[0].message.content, "Hello world");
  assert.ok(!String(json.choices[0].message.content).includes("ECHOED_PROMPT_TEXT"));
});

test("executeCursorAcp (streaming) emits role, deltas, finish_reason and [DONE]", async () => {
  const { bin } = writeFakeAcpx("acpx-stream", [
    SESSION_NEW_FRAME,
    chunkFrame("STREAM"),
    chunkFrame("_OK"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const { response } = await executeCursorAcp({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
  });
  const raw = await response.clone().text();
  const events = await readSseEvents(response);
  assert.equal(sseText(events), "STREAM_OK");
  assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
  const first = events[0] as { choices: { delta: { role?: string } }[] };
  assert.equal(first.choices[0].delta.role, "assistant");
});

test("executeCursorAcp forwards the exact advertised ACP id to acpx", async () => {
  const { bin, argvFile } = writeFakeAcpx("acpx-argv", [
    SESSION_NEW_FRAME,
    chunkFrame("ok"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const { response } = await executeCursorAcp({
    model: "claude-sonnet-5-high",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
  });
  await response.text();
  const argv = fs.readFileSync(argvFile, "utf8").split("\n");
  assert.equal(argv[argv.indexOf("--model") + 1], SONNET);
});

test("executeCursorAcp rejects an unadvertised parameterisation with 400", async () => {
  const { bin } = writeFakeAcpx("acpx-badparam", [SESSION_NEW_FRAME, stopFrame()]);
  process.env.ACPX_BIN = bin;

  const { response } = await executeCursorAcp({
    model: "claude-sonnet-5-xhigh",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /advertises effort=high/);
});

test("executeCursorAcp reports a non-zero acpx exit instead of an empty completion", async () => {
  const { bin: good } = writeFakeAcpx("acpx-warm", [SESSION_NEW_FRAME, stopFrame()]);
  process.env.ACPX_BIN = good;
  await getCursorAcpModels({ forceRefresh: true });

  process.env.ACPX_BIN = writeFakeBin("acpx-fail", "cat > /dev/null\necho boom >&2\nexit 3");
  const { response } = await executeCursorAcp({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
  });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /exited with code 3/);
});
