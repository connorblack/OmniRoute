/**
 * CursorCliExecutor unit tests.
 *
 * Following tests/unit/auggie-executor.test.ts: rather than mocking
 * node:child_process (fragile under ESM without --experimental-vm-modules),
 * these tests point `ACPX_BIN` at small real, disposable shell scripts that
 * emit canned ACP JSON-RPC frames. No live acpx or cursor-agent binary is
 * required or touched — CI never needs a Cursor subscription.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  CursorCliExecutor,
  buildCursorCliArgs,
  buildCursorCliPrompt,
  mapStopReason,
  translateCursorCliFrame,
} = await import("@omniroute/open-sse/executors/cursor-cli");

const {
  __resetCursorCliModelCache,
  baseModelId,
  getCursorCliModels,
  isCursorCliModelFailure,
  parseContextLength,
  resolveCursorCliModel,
} = await import("@omniroute/open-sse/services/cursorCliModels");

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cursor-cli-test-"));

const SONNET_ACP_ID = "claude-sonnet-5[thinking=true,context=300k,effort=high]";

/** The `session/new` result frame, which is where ACP advertises models. */
const SESSION_NEW_FRAME = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    sessionId: "test-session",
    models: {
      currentModelId: SONNET_ACP_ID,
      availableModels: [
        { modelId: "default[]", name: "Auto" },
        { modelId: SONNET_ACP_ID, name: "claude-sonnet-5" },
        { modelId: "gpt-5.6-sol[context=272k,reasoning=medium]", name: "gpt-5.6-sol" },
      ],
    },
  },
});

/**
 * The user's own prompt also travels on the wire inside the `session/prompt`
 * REQUEST. It must never be echoed back as assistant output.
 */
const PROMPT_ECHO_FRAME = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "session/prompt",
  params: {
    sessionId: "test-session",
    prompt: [{ type: "text", text: "ECHOED_PROMPT_TEXT" }],
  },
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

/** Write an executable shell script and return its absolute path. */
function writeFakeBin(name: string, script: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return p;
}

/**
 * A fake acpx that records its argv, drains stdin, and replays frames.
 * Returns the script path plus the path it writes its argv to.
 */
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
    const content = choices?.[0]?.delta?.content;
    if (content) out += content;
  }
  return out;
}

const ORIGINAL_ACPX_BIN = process.env.ACPX_BIN;

test.beforeEach(() => {
  __resetCursorCliModelCache();
});

test.after(() => {
  if (ORIGINAL_ACPX_BIN === undefined) delete process.env.ACPX_BIN;
  else process.env.ACPX_BIN = ORIGINAL_ACPX_BIN;
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── id parsing ──────────────────────────────────────────────────────────────

test("baseModelId strips bracket parameters", () => {
  assert.equal(baseModelId(SONNET_ACP_ID), "claude-sonnet-5");
  assert.equal(baseModelId("gemini-3-flash[]"), "gemini-3-flash");
  assert.equal(baseModelId("sonnet"), "sonnet");
});

test("parseContextLength understands k/m suffixes and absence", () => {
  assert.equal(parseContextLength(SONNET_ACP_ID), 300_000);
  assert.equal(parseContextLength("gpt-5.6-sol[context=272k]"), 272_000);
  assert.equal(parseContextLength("claude-opus-4-8[context=1m]"), 1_000_000);
  assert.equal(parseContextLength("gemini-3-flash[]"), undefined);
});

// ─── prompt flattening ───────────────────────────────────────────────────────

test("buildCursorCliPrompt flattens system/user/assistant turns with role tags", () => {
  const prompt = buildCursorCliPrompt([
    { role: "system", content: "Be terse." },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "how are you?" },
  ]);
  assert.equal(
    prompt,
    "[System]\nBe terse.\n\n[User]\nhi\n\n[Assistant]\nhello\n\n[User]\nhow are you?"
  );
});

test("buildCursorCliPrompt flattens array content blocks and skips empty turns", () => {
  const prompt = buildCursorCliPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "part1 " },
        { type: "text", text: "part2" },
      ],
    },
    { role: "user", content: "" },
    { role: "user", content: [] },
  ]);
  assert.equal(prompt, "[User]\npart1 part2");
});

test("buildCursorCliPrompt never returns an empty prompt", () => {
  assert.equal(buildCursorCliPrompt([]), "(empty)");
});

// ─── frame translation ───────────────────────────────────────────────────────

test("translateCursorCliFrame maps agent_message_chunk to text", () => {
  assert.deepEqual(translateCursorCliFrame(JSON.parse(chunkFrame("hi"))), {
    kind: "text",
    text: "hi",
  });
});

test("translateCursorCliFrame maps agent_thought_chunk to thought", () => {
  assert.deepEqual(
    translateCursorCliFrame(JSON.parse(chunkFrame("thinking", "agent_thought_chunk"))),
    { kind: "thought", text: "thinking" }
  );
});

test("translateCursorCliFrame maps a stopReason result to done", () => {
  assert.deepEqual(translateCursorCliFrame(JSON.parse(stopFrame())), {
    kind: "done",
    finishReason: "stop",
  });
});

test("translateCursorCliFrame ignores the session/prompt echo of the user's text", () => {
  // Regression: matching on any `text` field would replay the prompt as output.
  assert.equal(translateCursorCliFrame(JSON.parse(PROMPT_ECHO_FRAME)), null);
});

test("translateCursorCliFrame ignores the session/new result (no stopReason)", () => {
  assert.equal(translateCursorCliFrame(JSON.parse(SESSION_NEW_FRAME)), null);
});

test("translateCursorCliFrame surfaces JSON-RPC errors", () => {
  assert.deepEqual(
    translateCursorCliFrame({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } }),
    { kind: "error", message: "boom" }
  );
});

test("mapStopReason maps ACP stop reasons to OpenAI finish reasons", () => {
  assert.equal(mapStopReason("end_turn"), "stop");
  assert.equal(mapStopReason("max_tokens"), "length");
  assert.equal(mapStopReason("refusal"), "content_filter");
  assert.equal(mapStopReason("cancelled"), "stop");
  assert.equal(mapStopReason(undefined), "stop");
});

// ─── argv construction ───────────────────────────────────────────────────────

test("buildCursorCliArgs pins the agent to pure-model mode", () => {
  const args = buildCursorCliArgs(SONNET_ACP_ID, "/tmp/neutral");
  // These flags are load-bearing: they stop a chat request from getting
  // filesystem and shell access on the router host.
  for (const flag of ["--deny-all", "--no-fs", "--no-terminal", "--allowed-tools"]) {
    assert.ok(args.includes(flag), `expected ${flag} in argv`);
  }
  assert.equal(args[args.indexOf("--model") + 1], SONNET_ACP_ID);
  assert.equal(args[args.indexOf("--cwd") + 1], "/tmp/neutral");
  assert.deepEqual(args.slice(-4), ["cursor", "exec", "-f", "-"]);
});

// ─── live discovery ──────────────────────────────────────────────────────────

test("getCursorCliModels discovers models from the advertised list", async () => {
  const { bin } = writeFakeAcpx("acpx-discover", [SESSION_NEW_FRAME, chunkFrame("x"), stopFrame()]);
  process.env.ACPX_BIN = bin;

  const models = await getCursorCliModels({ forceRefresh: true });
  assert.equal(models.length, 3);
  // `default[]` is cursor's Auto router; it is exposed under a usable id.
  assert.equal(models[0].id, "auto");
  assert.equal(models[0].acpModelId, "default[]");
  assert.equal(models[1].id, "claude-sonnet-5");
  assert.equal(models[1].acpModelId, SONNET_ACP_ID);
  assert.equal(models[1].contextLength, 300_000);
});

test("getCursorCliModels caches and does not respawn", async () => {
  const { bin, argvFile } = writeFakeAcpx("acpx-cache", [SESSION_NEW_FRAME, stopFrame()]);
  process.env.ACPX_BIN = bin;

  await getCursorCliModels({ forceRefresh: true });
  const firstMtime = fs.statSync(argvFile).mtimeMs;
  await getCursorCliModels();
  assert.equal(fs.statSync(argvFile).mtimeMs, firstMtime, "cache hit should not respawn acpx");
});

test("getCursorCliModels returns empty when the binary is missing", async () => {
  process.env.ACPX_BIN = path.join(TMP_DIR, "does-not-exist-acpx");
  assert.deepEqual(await getCursorCliModels({ forceRefresh: true }), []);
});

// ─── model resolution ────────────────────────────────────────────────────────

const FIXTURE_MODELS = [
  { id: "auto", acpModelId: "default[]", name: "Auto" },
  { id: "claude-sonnet-5", acpModelId: SONNET_ACP_ID, name: "claude-sonnet-5" },
];

test("resolveCursorCliModel accepts the base id and returns the exact ACP id", () => {
  const r = resolveCursorCliModel("claude-sonnet-5", FIXTURE_MODELS);
  assert.ok(!isCursorCliModelFailure(r));
  assert.equal(r.acpModelId, SONNET_ACP_ID);
  assert.equal(r.id, "claude-sonnet-5");
});

test("resolveCursorCliModel maps auto to the advertised default router", () => {
  // Regression: `auto` has no `auto[` prefix among advertised ids, so relying on
  // acpx's prefix resolution instead of the exact id would fail to route.
  const r = resolveCursorCliModel("auto", FIXTURE_MODELS);
  assert.ok(!isCursorCliModelFailure(r));
  assert.equal(r.acpModelId, "default[]");
});

test("resolveCursorCliModel accepts a fully-qualified ACP id", () => {
  const r = resolveCursorCliModel(SONNET_ACP_ID, FIXTURE_MODELS);
  assert.ok(!isCursorCliModelFailure(r));
  assert.equal(r.acpModelId, SONNET_ACP_ID);
});

test("resolveCursorCliModel defaults to the first model when none is requested", () => {
  const r = resolveCursorCliModel("", FIXTURE_MODELS);
  assert.ok(!isCursorCliModelFailure(r));
  assert.equal(r.id, "auto");
});

test("resolveCursorCliModel rejects flag smuggling", () => {
  // The resolved value lands in a child-process argv, so a leading "-" would be
  // parsed by acpx as an option.
  const r = resolveCursorCliModel("--approve-all", FIXTURE_MODELS);
  assert.ok(isCursorCliModelFailure(r));
  assert.match(r.error, /must not start with/);
});

test("resolveCursorCliModel rejects an undiscovered model", () => {
  const r = resolveCursorCliModel("gpt-9", FIXTURE_MODELS);
  assert.ok(isCursorCliModelFailure(r));
  assert.match(r.error, /Unknown Cursor CLI model/);
});

test("resolveCursorCliModel explains an empty catalog rather than passing it through", () => {
  const r = resolveCursorCliModel("claude-sonnet-5", []);
  assert.ok(isCursorCliModelFailure(r));
  assert.match(r.error, /discovery returned no models/);
});

// ─── execute ─────────────────────────────────────────────────────────────────

test("execute (non-streaming) returns a chat.completion body", async () => {
  const { bin } = writeFakeAcpx("acpx-nonstream", [
    SESSION_NEW_FRAME,
    PROMPT_ECHO_FRAME,
    chunkFrame("Hello"),
    chunkFrame(" world"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {} as never,
  });

  assert.equal(response.status, 200);
  const json = (await response.json()) as Record<string, never>;
  assert.equal(json.object, "chat.completion");
  // The client-facing id is echoed, not the bracket-parameterized ACP id.
  assert.equal(json.model, "claude-sonnet-5");
  assert.equal(json.choices[0].message.content, "Hello world");
  assert.equal(json.choices[0].finish_reason, "stop");
});

test("execute (streaming) emits role, deltas, finish_reason and [DONE]", async () => {
  const { bin } = writeFakeAcpx("acpx-stream", [
    SESSION_NEW_FRAME,
    PROMPT_ECHO_FRAME,
    chunkFrame("STREAM"),
    chunkFrame("_OK"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: true,
    credentials: {} as never,
  });

  const raw = await response.clone().text();
  const events = await readSseEvents(response);
  assert.equal(sseText(events), "STREAM_OK");
  assert.ok(raw.trimEnd().endsWith("data: [DONE]"), "stream must terminate with [DONE]");

  const first = events[0] as { choices: { delta: { role?: string } }[] };
  assert.equal(first.choices[0].delta.role, "assistant");
  const last = events[events.length - 1] as { choices: { finish_reason?: string }[] };
  assert.equal(last.choices[0].finish_reason, "stop");
});

test("execute does not echo the user's prompt back as assistant output", async () => {
  const { bin } = writeFakeAcpx("acpx-echo", [
    SESSION_NEW_FRAME,
    PROMPT_ECHO_FRAME,
    chunkFrame("real answer"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {} as never,
  });
  const json = (await response.json()) as Record<string, never>;
  assert.equal(json.choices[0].message.content, "real answer");
  assert.ok(!String(json.choices[0].message.content).includes("ECHOED_PROMPT_TEXT"));
});

test("execute forwards the exact advertised ACP id to acpx", async () => {
  const { bin, argvFile } = writeFakeAcpx("acpx-argv", [
    SESSION_NEW_FRAME,
    chunkFrame("ok"),
    stopFrame(),
  ]);
  process.env.ACPX_BIN = bin;

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {} as never,
  });
  await response.text();

  const argv = fs.readFileSync(argvFile, "utf8").split("\n");
  const modelIdx = argv.indexOf("--model");
  assert.notEqual(modelIdx, -1, "--model must be present in argv");
  assert.equal(argv[modelIdx + 1], SONNET_ACP_ID);
});

test("execute rejects an unknown model with 400 before spawning", async () => {
  const { bin } = writeFakeAcpx("acpx-badmodel", [SESSION_NEW_FRAME, stopFrame()]);
  process.env.ACPX_BIN = bin;

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "no-such-model",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {} as never,
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unknown Cursor CLI model/);
});

test("execute surfaces a missing acpx binary as an actionable error", async () => {
  process.env.ACPX_BIN = path.join(TMP_DIR, "missing-acpx-binary");

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {} as never,
  });
  // Discovery cannot run without the binary, so the catalog is empty and the
  // request fails with the discovery guidance rather than a raw ENOENT.
  assert.equal(response.status, 400);
  assert.match(await response.text(), /discovery returned no models/);
});

test("execute reports a non-zero acpx exit instead of an empty completion", async () => {
  // Discovery succeeds against a working fake, then the run fails.
  const { bin: goodBin } = writeFakeAcpx("acpx-warm", [SESSION_NEW_FRAME, stopFrame()]);
  process.env.ACPX_BIN = goodBin;
  await getCursorCliModels({ forceRefresh: true });

  const failing = writeFakeBin("acpx-fail", "cat > /dev/null\necho 'boom' >&2\nexit 3");
  process.env.ACPX_BIN = failing;

  const executor = new CursorCliExecutor();
  const { response } = await executor.execute({
    model: "claude-sonnet-5",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: {} as never,
  });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /exited with code 3/);
});
