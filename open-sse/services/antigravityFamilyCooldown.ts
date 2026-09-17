/**
 * Persist Antigravity/agy quota cooldowns per model family (gemini vs claude)
 * on the connection row, without cooling the whole account.
 */
import { lockModel } from "./accountFallback.ts";
import { getAntigravityQuotaFamily, isAntigravityQuotaProvider } from "./antigravityQuotaFamily.ts";

type JsonRecord = Record<string, unknown>;

const FAMILY_PSD_KEY = "antigravityFamilyRateLimitedUntil";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseUntilMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

function dummyModelForFamily(family: "gemini" | "claude"): string {
  return family === "gemini" ? "gemini-family-lock" : "claude-family-lock";
}

function lockProviderFamilyModel(
  provider: string,
  connectionId: string,
  model: string,
  reason: string,
  cooldownMs: number
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  lockModel(provider, connectionId, model, reason, cooldownMs);
}

export async function persistAntigravityFamilyCooldown(params: {
  provider?: string;
  connectionId: string;
  model: string;
  rateLimitedUntil: string;
}): Promise<JsonRecord | null> {
  if (!params.model.trim()) return null;
  const family = getAntigravityQuotaFamily(params.model);
  if (family === "other") return null;

  const { getProviderConnectionById, updateProviderConnection } =
    await import("@/lib/db/providers");
  const conn = (await getProviderConnectionById(params.connectionId)) as {
    provider?: string;
    providerSpecificData?: JsonRecord | null;
  } | null;
  const connectionProvider = conn?.provider ?? "";
  if (!conn || !isAntigravityQuotaProvider(connectionProvider)) return null;
  if (params.provider && params.provider !== connectionProvider) return null;

  const psd = asRecord(conn.providerSpecificData);
  const untils = asRecord(psd[FAMILY_PSD_KEY]);
  const existingMs = parseUntilMs(untils[family]);
  const nextMs = parseUntilMs(params.rateLimitedUntil);
  if (!Number.isFinite(nextMs)) return psd;
  if (Number.isFinite(existingMs) && existingMs > Date.now() && existingMs >= nextMs) {
    lockProviderFamilyModel(
      connectionProvider,
      params.connectionId,
      params.model,
      "quota_exhausted",
      existingMs - Date.now()
    );
    return psd;
  }

  const nextPsd: JsonRecord = {
    ...psd,
    [FAMILY_PSD_KEY]: { ...untils, [family]: params.rateLimitedUntil },
  };
  await updateProviderConnection(params.connectionId, { providerSpecificData: nextPsd });
  lockProviderFamilyModel(
    connectionProvider,
    params.connectionId,
    params.model,
    "quota_exhausted",
    Math.max(0, nextMs - Date.now())
  );
  return nextPsd;
}

/** Fire-and-forget family PSD write. RPM/burst 429s must pass reason !== quota_exhausted. */
export function persistAntigravityFamilyCooldownIfQuota(params: {
  provider?: string | null;
  connectionId: string;
  model?: string | null;
  cooldownMs: number;
  reason?: string | null;
}): void {
  if (!isAntigravityQuotaProvider(params.provider)) return;
  if (!params.model?.trim() || params.cooldownMs <= 0) return;
  if (params.reason != null && params.reason !== "quota_exhausted") return;
  void persistAntigravityFamilyCooldown({
    provider: params.provider || undefined,
    connectionId: params.connectionId,
    model: params.model,
    rateLimitedUntil: new Date(Date.now() + params.cooldownMs).toISOString(),
  }).catch(() => {});
}

export async function persistAntigravityPreflightFamilyLock(params: {
  provider: string;
  connectionId: string;
  model: string;
  unavailableUntil: string;
}): Promise<void> {
  await persistAntigravityFamilyCooldown({
    provider: params.provider,
    connectionId: params.connectionId,
    model: params.model,
    rateLimitedUntil: params.unavailableUntil,
  });
}

export function rehydrateAntigravityFamilyLocks(
  provider: string,
  connectionId: string,
  providerSpecificData: JsonRecord | null | undefined
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  const untils = asRecord(asRecord(providerSpecificData)[FAMILY_PSD_KEY]);
  const now = Date.now();
  for (const family of ["gemini", "claude"] as const) {
    const untilMs = parseUntilMs(untils[family]);
    if (!Number.isFinite(untilMs) || untilMs <= now) continue;
    const model = dummyModelForFamily(family);
    const remainingMs = untilMs - now;
    lockProviderFamilyModel(provider, connectionId, model, "quota_exhausted", remainingMs);
  }
}

export function rehydrateAntigravityFamilyLocksForConnections(
  provider: string,
  connections: Array<{ id: string; providerSpecificData?: unknown }>
): void {
  if (!isAntigravityQuotaProvider(provider)) return;
  for (const conn of connections) {
    rehydrateAntigravityFamilyLocks(
      provider,
      conn.id,
      conn.providerSpecificData as JsonRecord | null | undefined
    );
  }
}

/**
 * Quota lock for executor quota exhaustion: the model's family, or the exact
 * model when it belongs to neither family. Returns false when the model is
 * absent or the connection is not an Antigravity/agy row.
 */
export async function markAntigravityModelQuotaExhausted(
  connectionId: string,
  retryAfterMs: number,
  model?: string | null
): Promise<boolean> {
  if (!model) return false;
  if (getAntigravityQuotaFamily(model) === "other") {
    const { getProviderConnectionById } = await import("@/lib/db/providers");
    const conn = (await getProviderConnectionById(connectionId)) as { provider?: string } | null;
    const provider = conn?.provider;
    if (!provider || !isAntigravityQuotaProvider(provider)) return false;
    lockModel(provider, connectionId, model, "quota_exhausted", retryAfterMs);
    return true;
  }
  const providerSpecificData = await persistAntigravityFamilyCooldown({
    connectionId,
    model,
    rateLimitedUntil: new Date(Date.now() + retryAfterMs).toISOString(),
  });
  return providerSpecificData !== null;
}
