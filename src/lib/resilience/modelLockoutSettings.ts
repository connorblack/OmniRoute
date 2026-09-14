import { isAutomatedTestProcess } from "@/shared/utils/testProcess";

export interface SlowStartCooldownSettings {
  enabled: boolean;
  providers: string[];
  thresholdMs: number;
  failuresBeforeCooldown: number;
  observationWindowMs: number;
  cooldownStepsMs: number[];
}

export interface ModelLockoutSettings {
  enabled: boolean;
  errorCodes: number[];
  baseCooldownMs: number;
  maxCooldownMs: number;
  maxBackoffSteps: number;
  useExponentialBackoff: boolean;
  slowStart: SlowStartCooldownSettings;
}

export const DEFAULT_MODEL_LOCKOUT_SETTINGS: ModelLockoutSettings = {
  enabled: false,
  errorCodes: [403, 404, 429, 502, 503, 504],
  baseCooldownMs: 120_000,
  maxCooldownMs: 1_800_000,
  maxBackoffSteps: 10,
  useExponentialBackoff: true,
  slowStart: {
    enabled: false,
    providers: ["nvidia"],
    thresholdMs: 120_000,
    failuresBeforeCooldown: 3,
    observationWindowMs: 600_000,
    cooldownStepsMs: [300_000, 600_000, 900_000],
  },
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toInteger(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1";
  return fallback;
}

function toNumberArray(value: unknown, fallback: number[]): number[] {
  if (Array.isArray(value)) {
    const nums = value
      .map((v) => (typeof v === "number" ? v : Number(v)))
      .filter((n) => Number.isFinite(n) && n >= 100 && n <= 599);
    return nums.length > 0 ? nums : fallback;
  }
  return fallback;
}

function toProviderArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const providers = [...new Set(value.filter((item): item is string => typeof item === "string"))]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return providers.length > 0 ? providers : fallback;
}

function toDurationArray(value: unknown, fallback: number[], isTest: boolean): number[] {
  if (!Array.isArray(value)) return fallback;
  const min = isTest ? 0 : 5_000;
  const durations = value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= min && item <= 24 * 60 * 60 * 1000)
    .map((item) => Math.trunc(item));
  return durations.length > 0 ? durations : fallback;
}

export function resolveModelLockoutSettings(
  settings: Record<string, unknown> | null | undefined
): ModelLockoutSettings {
  const record = asRecord(settings);
  const raw = asRecord(record.modelLockout);
  const rawSlowStart = asRecord(raw.slowStart);
  const isTest = isAutomatedTestProcess();

  const baseCooldownMs = toInteger(
    raw.baseCooldownMs,
    DEFAULT_MODEL_LOCKOUT_SETTINGS.baseCooldownMs,
    {
      min: isTest ? 0 : 5_000,
      max: 600_000,
    }
  );
  const maxCooldownMs = Math.max(
    toInteger(raw.maxCooldownMs, DEFAULT_MODEL_LOCKOUT_SETTINGS.maxCooldownMs, {
      min: isTest ? 0 : 5_000,
      max: 3_600_000,
    }),
    baseCooldownMs // cap must be >= base or exponential backoff is meaningless
  );

  return {
    enabled: toBoolean(raw.enabled, DEFAULT_MODEL_LOCKOUT_SETTINGS.enabled),
    errorCodes: toNumberArray(raw.errorCodes, DEFAULT_MODEL_LOCKOUT_SETTINGS.errorCodes),
    baseCooldownMs,
    maxCooldownMs,
    maxBackoffSteps: toInteger(
      raw.maxBackoffSteps,
      DEFAULT_MODEL_LOCKOUT_SETTINGS.maxBackoffSteps,
      { min: 0, max: 20 }
    ),
    useExponentialBackoff: toBoolean(
      raw.useExponentialBackoff,
      DEFAULT_MODEL_LOCKOUT_SETTINGS.useExponentialBackoff
    ),
    slowStart: {
      enabled: toBoolean(rawSlowStart.enabled, DEFAULT_MODEL_LOCKOUT_SETTINGS.slowStart.enabled),
      providers: toProviderArray(
        rawSlowStart.providers,
        DEFAULT_MODEL_LOCKOUT_SETTINGS.slowStart.providers
      ),
      thresholdMs: toInteger(
        rawSlowStart.thresholdMs,
        DEFAULT_MODEL_LOCKOUT_SETTINGS.slowStart.thresholdMs,
        { min: isTest ? 0 : 1_000, max: 60 * 60 * 1000 }
      ),
      failuresBeforeCooldown: toInteger(
        rawSlowStart.failuresBeforeCooldown,
        DEFAULT_MODEL_LOCKOUT_SETTINGS.slowStart.failuresBeforeCooldown,
        { min: 1, max: 100 }
      ),
      observationWindowMs: toInteger(
        rawSlowStart.observationWindowMs,
        DEFAULT_MODEL_LOCKOUT_SETTINGS.slowStart.observationWindowMs,
        { min: isTest ? 0 : 10_000, max: 24 * 60 * 60 * 1000 }
      ),
      cooldownStepsMs: toDurationArray(
        rawSlowStart.cooldownStepsMs,
        DEFAULT_MODEL_LOCKOUT_SETTINGS.slowStart.cooldownStepsMs,
        isTest
      ),
    },
  };
}
