/**
 * Per-(connection, canonical model) Gemini free-tier budget ledger.
 *
 * Tracks RPM (sliding 60s window), TPM (sliding 60s token window), and RPD
 * (Pacific-midnight-resetting daily count) so a spent budget can be caught
 * BEFORE dispatch instead of eating a guaranteed upstream 429.
 *
 * Reservation lifecycle: `reserveGeminiRequest` counts a dispatch toward
 * RPM/RPD immediately (in-flight, before the upstream call resolves) so
 * concurrent bursts cannot overshoot; `settleGeminiRequest` then either
 * keeps it counted (2xx / non-429 4xx — Google billed it) or releases it
 * (429 / 5xx — Google did not bill it) and folds in the token usage.
 */

import { createRequire } from "node:module";
import geminiLimitsRaw from "../config/geminiRateLimits.json";
import { getConnectionRateLimitOverrides } from "./connectionRateLimitOverrides.ts";
import { nextDailyResetAtMs, zonedParts, zonedLocalToUtc } from "./dailyQuotaReset.ts";

// This module loads well before better-sqlite3's native binding and the DB
// file are guaranteed ready, and the seed read must stay synchronous (see
// defaultSeedSource) — createRequire is the portable way to get a real,
// synchronous `require` from an ES module regardless of the runtime's own
// CJS/ESM interop.
const require = createRequire(import.meta.url);

const PACIFIC_TZ = "America/Los_Angeles";
const WINDOW_MS = 60_000;
// Defensive-only: not part of the spec. Bounds how long an unsettled
// reservation can inflate RPM/RPD if a caller's outcome path never reaches
// settleGeminiRequest (e.g. an early-return before the completion sink).
const IN_FLIGHT_MAX_AGE_MS = 120_000;

type GeminiLimitEntry = { rpm: number; rpd: number; tpm: number };
type GeminiRegistryEntry = GeminiLimitEntry | { aliasOf: string };

const geminiLimits = geminiLimitsRaw as Record<string, GeminiRegistryEntry>;

function stripModelPrefix(modelId: string): string {
  // Only strip the "gemini/" provider prefix, never "gemini-" which is part
  // of the actual model name (e.g. "gemini-2.5-flash", "gemini-3.5-live-translate").
  return modelId.replace(/^gemini\//, "").trim();
}

/** Resolve a model id to its registry key, following `aliasOf` to the canonical entry. */
export function canonicalizeGeminiModel(modelId: string | null | undefined): string {
  if (!modelId) return "";
  let key = stripModelPrefix(modelId);
  const seen = new Set<string>();
  while (!seen.has(key)) {
    seen.add(key);
    const entry = geminiLimits[key];
    if (entry && "aliasOf" in entry) {
      key = entry.aliasOf;
      continue;
    }
    break;
  }
  return key;
}

function lookupFreeTierLimits(modelId: string | null | undefined): GeminiLimitEntry | null {
  const key = canonicalizeGeminiModel(modelId);
  if (!key) return null;
  const entry = geminiLimits[key];
  if (!entry || "aliasOf" in entry) return null;
  return entry;
}

const OVERRIDE_UNLIMITED = -1;

function overrideLimit(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : OVERRIDE_UNLIMITED;
}

function connectionOverrideLimits(connectionId: string): GeminiLimitEntry | null {
  const overrides = getConnectionRateLimitOverrides(connectionId);
  if (!overrides || ![overrides.rpm, overrides.rpd, overrides.tpm].some((v) => v > 0)) {
    return null;
  }
  return {
    rpm: overrideLimit(overrides.rpm),
    rpd: overrideLimit(overrides.rpd),
    tpm: overrideLimit(overrides.tpm),
  };
}

function resolveLimits(
  connectionId: string,
  modelId: string | null | undefined
): GeminiLimitEntry | null {
  return connectionOverrideLimits(connectionId) ?? lookupFreeTierLimits(modelId);
}

export function getModelRpd(modelId: string): number {
  return lookupFreeTierLimits(modelId)?.rpd ?? -1;
}

export function getModelRpm(modelId: string): number {
  return lookupFreeTierLimits(modelId)?.rpm ?? -1;
}

export function getModelTpm(modelId: string): number {
  return lookupFreeTierLimits(modelId)?.tpm ?? -1;
}

// ── Ledger ───────────────────────────────────────────────────────────────────

type LedgerEntry = {
  requestTimes: number[];
  tokenEvents: { at: number; n: number }[];
  pacificDay: string;
  dayRequests: number;
  inFlight: Map<number, { at: number; units: number }>;
};

const ledger = new Map<string, LedgerEntry>();

function ledgerKey(connectionId: string, canonicalModel: string): string {
  return `${connectionId} ${canonicalModel}`;
}

function pacificDayKey(nowMs: number): string {
  const p = zonedParts(nowMs, PACIFIC_TZ);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function currentPacificMidnightMs(nowMs: number): number {
  const p = zonedParts(nowMs, PACIFIC_TZ);
  return zonedLocalToUtc(p.year, p.month, p.day, 0, 0, 0, PACIFIC_TZ);
}

function rollDayIfNeeded(entry: LedgerEntry, nowMs: number): void {
  const day = pacificDayKey(nowMs);
  if (entry.pacificDay !== day) {
    entry.pacificDay = day;
    entry.dayRequests = 0;
  }
}

function pruneEntry(entry: LedgerEntry, nowMs: number): void {
  const windowCutoff = nowMs - WINDOW_MS;
  if (entry.requestTimes.length > 0) {
    entry.requestTimes = entry.requestTimes.filter((t) => t >= windowCutoff);
  }
  if (entry.tokenEvents.length > 0) {
    entry.tokenEvents = entry.tokenEvents.filter((e) => e.at >= windowCutoff);
  }
  if (entry.inFlight.size > 0) {
    const inFlightCutoff = nowMs - IN_FLIGHT_MAX_AGE_MS;
    for (const [id, reservation] of entry.inFlight) {
      if (reservation.at < inFlightCutoff) entry.inFlight.delete(id);
    }
  }
  rollDayIfNeeded(entry, nowMs);
}

function ensureEntry(connectionId: string, canonicalModel: string, nowMs: number): LedgerEntry {
  ensureSeeded(nowMs);
  const key = ledgerKey(connectionId, canonicalModel);
  let entry = ledger.get(key);
  if (!entry) {
    entry = {
      requestTimes: [],
      tokenEvents: [],
      pacificDay: pacificDayKey(nowMs),
      dayRequests: 0,
      inFlight: new Map(),
    };
    ledger.set(key, entry);
  }
  pruneEntry(entry, nowMs);
  return entry;
}

/** 429/5xx are never billed by Google; everything else (2xx, other 4xx) is. */
function isBilledStatus(status: number): boolean {
  if (status === 429) return false;
  if (status >= 500) return false;
  return true;
}

// ── Rehydration seam ─────────────────────────────────────────────────────────

export type GeminiCallLogSeedRow = {
  connectionId: string;
  model: string;
  status: number;
  timestampMs: number;
  tokensIn: number;
  tokensOut: number;
};

export type GeminiLedgerSeedSource = (sincePacificMidnightMs: number) => GeminiCallLogSeedRow[];

function defaultSeedSource(sincePacificMidnightMs: number): GeminiCallLogSeedRow[] {
  try {
    // Deferred require: this module loads at process start (imported by
    // accountFallback.ts/chatCore.ts), well before better-sqlite3's native
    // binding and the DB file are guaranteed ready.
    const { getDbInstance } = require("../../src/lib/db/core");
    const db = getDbInstance();
    const rows = db
      .prepare(
        `SELECT connection_id, model, status, timestamp, tokens_in, tokens_out
         FROM call_logs
         WHERE provider = 'gemini' AND connection_id IS NOT NULL AND timestamp >= ?`
      )
      .all(new Date(sincePacificMidnightMs).toISOString()) as Array<{
      connection_id: string;
      model: string | null;
      status: number | null;
      timestamp: string;
      tokens_in: number | null;
      tokens_out: number | null;
    }>;
    return rows
      .filter((r) => typeof r.model === "string" && r.model.length > 0)
      .map((r) => ({
        connectionId: r.connection_id,
        model: r.model as string,
        status: typeof r.status === "number" ? r.status : 0,
        timestampMs: Date.parse(r.timestamp),
        tokensIn: r.tokens_in ?? 0,
        tokensOut: r.tokens_out ?? 0,
      }));
  } catch (err) {
    console.warn(
      "[geminiRateLimitTracker] ledger rehydration seed failed; starting with an empty ledger",
      err
    );
    return [];
  }
}

let seedSource: GeminiLedgerSeedSource = defaultSeedSource;
let seeded = false;

/** Test-only seam: inject a fake call_logs source, or reset to the SQLite default. */
export function setGeminiLedgerSeedSourceForTests(fn: GeminiLedgerSeedSource | null): void {
  seedSource = fn ?? defaultSeedSource;
}

function ensureSeeded(nowMs: number): void {
  if (seeded) return;
  seeded = true;
  const rpmCutoff = nowMs - WINDOW_MS;
  let rows: GeminiCallLogSeedRow[];
  try {
    rows = seedSource(currentPacificMidnightMs(nowMs));
  } catch (err) {
    console.warn(
      "[geminiRateLimitTracker] ledger rehydration seed threw; starting with an empty ledger",
      err
    );
    return;
  }
  for (const row of rows) {
    if (!row.connectionId) continue;
    const canonicalModel = canonicalizeGeminiModel(row.model);
    if (!canonicalModel) continue;
    if (!isBilledStatus(row.status)) continue;
    const key = ledgerKey(row.connectionId, canonicalModel);
    let entry = ledger.get(key);
    if (!entry) {
      entry = {
        requestTimes: [],
        tokenEvents: [],
        pacificDay: pacificDayKey(nowMs),
        dayRequests: 0,
        inFlight: new Map(),
      };
      ledger.set(key, entry);
    }
    entry.dayRequests += 1;
    if (row.timestampMs >= rpmCutoff) {
      entry.requestTimes.push(row.timestampMs);
      const tokens = (row.tokensIn || 0) + (row.tokensOut || 0);
      if (tokens > 0) entry.tokenEvents.push({ at: row.timestampMs, n: tokens });
    }
  }
}

/** Test-only: drop the ledger, the seed-once latch, and any injected seed source. */
export function resetGeminiBudgetLedgerForTests(): void {
  ledger.clear();
  seeded = false;
  seedSource = defaultSeedSource;
}

// ── Reserve / settle ─────────────────────────────────────────────────────────

export type GeminiReservationHandle = {
  connectionId: string;
  canonicalModel: string;
  reservationId: number;
  reservedAt: number;
  units: number;
};

let nextReservationId = 1;

/**
 * `units` is how many requests Google bills for this call: 1 for chat, the
 * number of contents for a batch embedding call.
 */
export function reserveGeminiRequest(
  connectionId: string,
  model: string,
  nowMs: number = Date.now(),
  units: number = 1
): GeminiReservationHandle {
  const canonicalModel = canonicalizeGeminiModel(model);
  const entry = ensureEntry(connectionId, canonicalModel, nowMs);
  const reservationId = nextReservationId++;
  const billedUnits = Math.max(1, Math.floor(units));
  entry.inFlight.set(reservationId, { at: nowMs, units: billedUnits });
  return { connectionId, canonicalModel, reservationId, reservedAt: nowMs, units: billedUnits };
}

function inFlightUnits(entry: LedgerEntry): number {
  let total = 0;
  for (const reservation of entry.inFlight.values()) total += reservation.units;
  return total;
}

export type GeminiSettleOutcome = {
  upstreamStatus: number;
  tokens?: number | null;
};

export function settleGeminiRequest(
  handle: GeminiReservationHandle | null | undefined,
  outcome: GeminiSettleOutcome,
  nowMs: number = Date.now()
): void {
  if (!handle) return;
  const entry = ledger.get(ledgerKey(handle.connectionId, handle.canonicalModel));
  if (!entry) return;
  entry.inFlight.delete(handle.reservationId);
  if (!isBilledStatus(outcome.upstreamStatus)) return;
  rollDayIfNeeded(entry, nowMs);
  entry.dayRequests += handle.units;
  for (let i = 0; i < handle.units; i++) entry.requestTimes.push(handle.reservedAt);
  const tokens = outcome.tokens;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
    entry.tokenEvents.push({ at: handle.reservedAt, n: tokens });
  }
}

// ── Budget check (pre-dispatch gate) ────────────────────────────────────────

export type GeminiBudgetBlock = {
  window: "rpm" | "tpm" | "rpd";
  remainingMs: number;
};

/** Google resets free-tier requests-per-day quotas at midnight Pacific time. */
export function msUntilGeminiDailyReset(nowMs: number = Date.now()): number {
  return nextDailyResetAtMs(PACIFIC_TZ, 0, nowMs) - nowMs;
}

export function getGeminiBudgetBlock(
  connectionId: string | null | undefined,
  model: string | null | undefined,
  nowMs: number = Date.now()
): GeminiBudgetBlock | null {
  if (!connectionId || !model) return null;
  const limits = resolveLimits(connectionId, model);
  if (!limits) return null;
  const canonicalModel = canonicalizeGeminiModel(model);
  const entry = ensureEntry(connectionId, canonicalModel, nowMs);
  const resetMs = () => Math.max(0, msUntilGeminiDailyReset(nowMs));

  // 0 = no free-tier access at all; never opens up within the day.
  if (limits.rpd === 0) return { window: "rpd", remainingMs: resetMs() };
  if (limits.rpm === 0) return { window: "rpm", remainingMs: resetMs() };
  if (limits.tpm === 0) return { window: "tpm", remainingMs: resetMs() };

  if (limits.rpd > 0) {
    const used = entry.dayRequests + inFlightUnits(entry);
    if (used >= limits.rpd) return { window: "rpd", remainingMs: resetMs() };
  }

  if (limits.rpm > 0) {
    const used = entry.requestTimes.length + inFlightUnits(entry);
    if (used >= limits.rpm) {
      const times = [...entry.requestTimes, ...[...entry.inFlight.values()].map((r) => r.at)];
      const oldest = Math.min(...times);
      return { window: "rpm", remainingMs: Math.max(0, oldest + WINDOW_MS - nowMs) };
    }
  }

  if (limits.tpm > 0) {
    const used = entry.tokenEvents.reduce((sum, e) => sum + e.n, 0);
    if (used >= limits.tpm) {
      const oldest = Math.min(...entry.tokenEvents.map((e) => e.at));
      return { window: "tpm", remainingMs: Math.max(0, oldest + WINDOW_MS - nowMs) };
    }
  }

  return null;
}

// ── Text-based metric classification ─────────────────────────────────────────

/**
 * Extract which quota class ("rpd" | "rpm" | "tpm") a Gemini 429 error text
 * names, directly from Google's own metric identifier — e.g.:
 *   "Quota exceeded for metric: generativelanguage.googleapis.com/
 *    generate_content_free_tier_input_token_count, limit: 16000"
 *
 * This is authoritative (Google's own signal) and must be checked BEFORE the
 * local per-connection ledger: a request that gets REJECTED — especially the
 * first of several concurrent requests that all trip the same per-minute
 * limit before any of them completes — settles as released, so the ledger
 * can read as not-yet-exhausted at the exact moment it needs to say
 * otherwise.
 */
export function classifyGeminiQuotaMetricFromText(
  errorText: string | null | undefined
): "rpd" | "rpm" | "tpm" | null {
  if (!errorText) return null;
  const lower = errorText.toLowerCase();
  if (!lower.includes("generativelanguage.googleapis.com")) return null;
  // Only Google's quotaId (e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier) tells a
  // per-day request limit from a per-minute one; both share the _requests metric name.
  if (lower.includes("perday") || lower.includes("_per_day") || lower.includes("per day"))
    return "rpd";
  if (lower.includes("input_token_count") || lower.includes("token_count")) return "tpm";
  if (lower.includes("_requests")) {
    // Live traffic keeps only error.message, so the quotaId is gone and the limit value is
    // the only per-day signal ("limit: 20" is RPD for Flash, "limit: 5" is its RPM).
    const quota = /limit:\s*(\d+),\s*model:\s*([\w.-]+)/i.exec(errorText);
    return quota && isDailyRequestLimit(quota[2], Number(quota[1])) ? "rpd" : "rpm";
  }
  return null;
}

function isDailyRequestLimit(modelId: string, limit: number): boolean {
  const rpd = getModelRpd(modelId);
  return rpd > 0 && limit === rpd && rpd !== getModelRpm(modelId);
}
