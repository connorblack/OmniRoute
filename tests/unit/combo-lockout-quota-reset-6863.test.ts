// #6863: combo path model lockout must prefer a parsed reset over the base
// cooldown ladder while still respecting the operator's max for body prose.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-combo-quota-reset-6863-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-combo-quota-reset-6863";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { getModelLockoutInfo, clearAllModelLockouts, parseRetryFromErrorText } =
  await import("../../open-sse/services/accountFallback.ts");

const UPSTREAM_429_MESSAGE =
  "429: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 92h27m28s.";

function createLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

async function createConnection(provider: string, name: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `test-key-${name}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: { passthroughModels: true },
  });
}

test.beforeEach(() => {
  clearAllModelLockouts();
});

test.after(() => {
  clearAllModelLockouts();
  try {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

test("combo 429 body reset beats base cooldown but is capped by maxCooldownMs (#6863)", async () => {
  const provider = "antigravity"; // OAuth category → quota signals preserved on 429
  const model = "claude-sonnet-4.6";

  const settings = {
    modelLockout: {
      enabled: true,
      errorCodes: [429],
      baseCooldownMs: 3000,
      maxCooldownMs: 1_800_000,
      maxBackoffSteps: 10,
      useExponentialBackoff: true,
    },
  };

  await settingsDb.updateSettings(settings);
  const connection = await createConnection(provider, "quota-reset-antigravity");

  await handleComboChat({
    body: {},
    combo: {
      name: "quota-reset-combo",
      strategy: "priority",
      models: [`${provider}/${model}`],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    },
    handleSingleModel: async () => {
      await auth.markAccountUnavailable(
        connection.id,
        429,
        UPSTREAM_429_MESSAGE,
        provider,
        model,
        null,
        auth.buildExhaustionOptions("quota-reset-6863", { isCombo: true })
      );
      return new Response(JSON.stringify({ error: { message: UPSTREAM_429_MESSAGE } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-omniroute-selected-connection-id": connection.id,
        },
      });
    },
    isModelAvailable: async () => true,
    log: createLog(),
    settings,
    allCombos: null,
  });

  const parsedResetMs = parseRetryFromErrorText(UPSTREAM_429_MESSAGE);
  assert.ok(
    parsedResetMs && parsedResetMs > 90 * 3600 * 1000,
    `sanity: reset text must parse to ~92.5h, got ${parsedResetMs}`
  );

  const info = getModelLockoutInfo(provider, connection.id, model);
  assert.ok(info, "combo 429 must record a model lockout");
  // Preserve #6863 (do not fall back to ~seconds), but prose is not an
  // authoritative reset and must not bypass the operator's 30m maximum.
  assert.ok(
    info!.remainingMs > settings.modelLockout.maxCooldownMs - 5_000 &&
      info!.remainingMs <= settings.modelLockout.maxCooldownMs,
    `body reset must clamp to maxCooldownMs (${settings.modelLockout.maxCooldownMs}ms); got ${info!.remainingMs}ms`
  );
});

test("combo 429 lockout prefers a SHORT parsed reset over the subscription fallback cooldown", async () => {
  // Review follow-up on #6863: the subscription-quota branch returns
  // cooldownMs = 1h fallback when useUpstreamRetryHints is off (OAuth default),
  // while quotaResetHintMs carries the real parsed reset. A max() of the two
  // would over-lock (1h) — the lockout must follow the parsed value (~45m),
  // matching the single-model path in src/sse/services/auth.ts.
  const provider = "antigravity";
  const model = "claude-sonnet-4-6";
  const shortResetMessage =
    "429: Usage limit reached. Your Claude Pro usage limit resets in 45m0s.";

  const settings = {
    modelLockout: {
      enabled: true,
      errorCodes: [429],
      baseCooldownMs: 3000,
      maxCooldownMs: 7_200_000,
      maxBackoffSteps: 10,
      useExponentialBackoff: true,
    },
  };

  await settingsDb.updateSettings(settings);
  const connection = await createConnection(provider, "short-reset-antigravity");

  await handleComboChat({
    body: {},
    combo: {
      name: "short-reset-combo",
      strategy: "priority",
      models: [`${provider}/${model}`],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    },
    handleSingleModel: async () => {
      await auth.markAccountUnavailable(
        connection.id,
        429,
        shortResetMessage,
        provider,
        model,
        null,
        auth.buildExhaustionOptions("short-reset-6863", { isCombo: true })
      );
      return new Response(JSON.stringify({ error: { message: shortResetMessage } }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-omniroute-selected-connection-id": connection.id,
        },
      });
    },
    isModelAvailable: async () => true,
    log: createLog(),
    settings,
    allCombos: null,
  });

  const parsedResetMs = parseRetryFromErrorText(shortResetMessage);
  assert.equal(parsedResetMs, 45 * 60 * 1000, "sanity: reset text must parse to 45m");

  const info = getModelLockoutInfo(provider, connection.id, model);
  assert.ok(info, "combo 429 must record a model lockout");
  // Must be the parsed 45m — NOT the 1h subscription fallback (over-lock).
  assert.ok(
    info!.remainingMs > parsedResetMs! - 5_000 && info!.remainingMs <= parsedResetMs!,
    `lockout must follow the parsed 45m reset, not the 1h fallback; got ${info!.remainingMs}ms (~${Math.round(info!.remainingMs / 1000)}s)`
  );
});
