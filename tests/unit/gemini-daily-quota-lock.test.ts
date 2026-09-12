import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkFallbackError,
  recordModelLockoutFailure,
  clearAllModelLockouts,
  getModelLockoutInfo,
  retryHintBypassesMaxCooldownMs,
} from "../../open-sse/services/accountFallback.ts";
import { classifyGeminiQuotaMetricFromText } from "../../open-sse/services/geminiRateLimitTracker.ts";
import { RateLimitReason } from "../../open-sse/config/constants.ts";

const REQUESTS = "generativelanguage.googleapis.com/generate_content_free_tier_requests";
const INPUT_TOKENS =
  "generativelanguage.googleapis.com/generate_content_free_tier_input_token_count";

function gemini429(quotaId: string, quotaMetric: string, quotaValue: string, retryDelay: string) {
  const model = "gemini-3.8-flash";
  return JSON.stringify({
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. " +
        `* Quota exceeded for metric: ${quotaMetric}, limit: ${quotaValue}, model: ${model}\n` +
        `Please retry in ${retryDelay}.`,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            { quotaMetric, quotaId, quotaDimensions: { location: "global", model }, quotaValue },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  });
}

const RPD = gemini429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", REQUESTS, "20", "30s");
const RPM = gemini429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", REQUESTS, "5", "26s");
const TPM = gemini429(
  "GenerateContentInputTokensPerModelPerMinute-FreeTier",
  INPUT_TOKENS,
  "250000",
  "28s"
);
const PROFILE = { baseCooldownMs: 30_000, useUpstreamRetryHints: true, maxBackoffSteps: 10 } as any;

function pacificClock(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { hour: part("hour"), minute: part("minute") };
}

test("Google's quotaId decides the Gemini quota class", () => {
  assert.equal(classifyGeminiQuotaMetricFromText(RPD), "rpd");
  assert.equal(classifyGeminiQuotaMetricFromText(RPM), "rpm");
  assert.equal(classifyGeminiQuotaMetricFromText(TPM), "tpm");
});

test("a per-day 429 locks the model until midnight Pacific, not for the 30s retry hint", () => {
  const before = Date.now();
  const result = checkFallbackError(429, RPD, 0, "gemini-3.8-flash", "gemini", null, PROFILE);
  assert.equal(result.reason, RateLimitReason.QUOTA_EXHAUSTED);
  assert.equal(result.dailyQuotaExhausted, true);
  assert.notEqual(result.usedUpstreamRetryHint, true);
  assert.ok(
    result.cooldownMs > 60_000,
    `expected a lock to the daily reset, got ${result.cooldownMs}ms`
  );
  assert.ok(result.cooldownMs <= 25 * 3_600_000, `lock longer than a day: ${result.cooldownMs}ms`);
  assert.equal(result.quotaResetHintMs, result.cooldownMs);
  assert.deepEqual(pacificClock(before + result.cooldownMs + 500), { hour: 0, minute: 0 });
});

test("the daily lock is not clamped by a 30-minute operator cap", () => {
  clearAllModelLockouts();
  const result = checkFallbackError(429, RPD, 0, "gemini-3.8-flash", "gemini", null, PROFILE);
  const lock = recordModelLockoutFailure(
    "gemini",
    "conn-rpd",
    "gemini-3.8-flash",
    "quota_exhausted",
    429,
    0,
    PROFILE,
    {
      exactCooldownMs:
        result.usedUpstreamRetryHint === true
          ? result.cooldownMs
          : (result.quotaResetHintMs ?? null),
      maxCooldownMs: 1_800_000,
      exactCooldownIsUpstreamReset: retryHintBypassesMaxCooldownMs(result.retryHintSource),
    }
  );
  assert.equal(lock.cooldownMs, result.quotaResetHintMs);
  const info = getModelLockoutInfo("gemini", "conn-rpd", "gemini-3.8-flash");
  assert.ok(
    info && info.remainingMs > result.cooldownMs - 5_000,
    "lock should last until the reset"
  );
  clearAllModelLockouts();
});

test("per-minute request and token 429s keep Google's short retry hint", () => {
  const rpm = checkFallbackError(429, RPM, 0, "gemini-3.8-flash", "gemini", null, PROFILE);
  assert.equal(rpm.reason, RateLimitReason.RATE_LIMIT_EXCEEDED);
  assert.ok(
    rpm.cooldownMs >= 20_000 && rpm.cooldownMs <= 30_000,
    `RPM cooldown ${rpm.cooldownMs}ms`
  );
  const tpm = checkFallbackError(429, TPM, 0, "gemini-3.8-flash", "gemini", null, PROFILE);
  assert.equal(tpm.reason, RateLimitReason.RATE_LIMIT_EXCEEDED);
  assert.ok(
    tpm.cooldownMs >= 20_000 && tpm.cooldownMs <= 32_000,
    `TPM cooldown ${tpm.cooldownMs}ms`
  );
});
