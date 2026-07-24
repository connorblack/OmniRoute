import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchCursorAgentModels,
  humanizeCursorModelId,
  parseCursorAgentModels,
} from "../../src/lib/providerModels/cursorAgent";

test("parseCursorAgentModels returns every reported id including auto and composer-*", () => {
  const text =
    "Cannot use this model: --help. Available models: auto, composer-2, composer-2-fast, gpt-5.3-codex-low, claude-opus-4-7-thinking-high, kimi-k2.5";
  assert.deepEqual(parseCursorAgentModels(text), [
    "auto",
    "composer-2",
    "composer-2-fast",
    "gpt-5.3-codex-low",
    "claude-opus-4-7-thinking-high",
    "kimi-k2.5",
  ]);
});

test("parseCursorAgentModels deduplicates and trims", () => {
  assert.deepEqual(parseCursorAgentModels("Available models: a, a , b"), ["a", "b"]);
});

test("parseCursorAgentModels returns [] when the marker is missing", () => {
  assert.deepEqual(parseCursorAgentModels("nothing here"), []);
});

test("humanizeCursorModelId pretty-prints common patterns", () => {
  assert.equal(humanizeCursorModelId("auto"), "Auto (Server Picks)");
  assert.equal(humanizeCursorModelId("composer-2-fast"), "Composer 2 Fast");
  assert.equal(humanizeCursorModelId("gpt-5.3-codex-low"), "GPT 5.3 Codex Low");
  assert.equal(humanizeCursorModelId("gpt-5.5-extra-high-fast"), "GPT 5.5 Extra High Fast");
  // Collapses claude-opus-4-7-* version pattern into 4.7
  assert.equal(
    humanizeCursorModelId("claude-opus-4-7-thinking-high"),
    "Claude Opus 4.7 Thinking High"
  );
  assert.equal(
    humanizeCursorModelId("claude-opus-4-8-thinking-high-fast"),
    "Claude Opus 4.8 Thinking High Fast"
  );
  assert.equal(humanizeCursorModelId("claude-fable-5-thinking-xhigh"), "Claude Fable 5 Thinking XHigh");
  assert.equal(humanizeCursorModelId("claude-sonnet-5-max"), "Claude Sonnet 5 Max");
  assert.equal(humanizeCursorModelId("kimi-k2.5"), "Kimi K2.5");
  assert.equal(humanizeCursorModelId("gemini-3.1-pro"), "Gemini 3.1 Pro");
  assert.equal(humanizeCursorModelId("claude-4-sonnet-thinking"), "Claude 4 Sonnet Thinking");
  // Grok 4.5 uses infix -fast- (unlike GPT's trailing -fast)
  assert.equal(humanizeCursorModelId("grok-4.5-medium"), "Grok 4.5 Medium");
  assert.equal(humanizeCursorModelId("grok-4.5-fast-medium"), "Grok 4.5 Fast Medium");
  assert.equal(humanizeCursorModelId("grok-4.5-xhigh"), "Grok 4.5 XHigh");
  assert.equal(humanizeCursorModelId("grok-4.5-fast-xhigh"), "Grok 4.5 Fast XHigh");
});

test("fetchCursorAgentModels passes --trust so an untrusted cwd still lists models", async () => {
  // Regression: cursor-agent gates on workspace trust BEFORE parsing --model, so
  // without --trust it prints "⚠ Workspace Trust Required" instead of the model
  // list from any directory the user has not interactively trusted — which is
  // every directory on a non-interactive host (a container's cwd is never
  // trusted). The probe then died with the useless
  // "cursor-agent did not return an 'Available models:' line".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-agent-args-"));
  const argvLog = path.join(dir, "argv.txt");
  const fake = path.join(dir, "cursor-agent");

  // Stand-in for the real binary: records its argv, then mimics cursor-agent's
  // actual behaviour of reporting the model list on stderr with a non-zero exit.
  fs.writeFileSync(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}
echo "Cannot use this model: --help. Available models: auto, composer-2" >&2
exit 1
`
  );
  fs.chmodSync(fake, 0o755);

  try {
    const models = await fetchCursorAgentModels({ binary: fake, timeoutMs: 10000 });
    assert.deepEqual(
      models.map((m) => m.id),
      ["auto", "composer-2"]
    );

    const argv = fs.readFileSync(argvLog, "utf8").split("\n").filter(Boolean);
    assert.ok(argv.includes("--trust"), `expected --trust in argv, got: ${argv.join(" ")}`);
    // --trust must precede --model: cursor-agent evaluates the trust gate first.
    assert.ok(
      argv.indexOf("--trust") < argv.indexOf("--model"),
      `--trust must come before --model, got: ${argv.join(" ")}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
