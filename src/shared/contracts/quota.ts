import { toNumberOrNull } from "@/shared/utils/numeric";

export type QuotaTokenStatus = "valid" | "expiring" | "expired" | "refreshing";
export type QuotaStatus = "known" | "unknown" | "cooldown";

export type QuotaQueuePressure = {
  queued: number;
  running: number;
  executing: number;
};

type QuotaProviderBase = {
  name: string;
  provider: string;
  connectionId: string;
  resetAt: string | null;
  tokenStatus: QuotaTokenStatus;
  queuePressure: QuotaQueuePressure;
};

export type QuotaProviderEntry =
  | (QuotaProviderBase & {
      quotaStatus: "known";
      quotaUsed: number;
      quotaTotal: number;
      percentRemaining: number;
    })
  | (QuotaProviderBase & {
      quotaStatus: "unknown" | "cooldown";
      quotaUsed: null;
      quotaTotal: null;
      percentRemaining: null;
    });

export interface QuotaResponseMeta {
  generatedAt: string;
  filters: {
    provider: string | null;
    connectionId: string | null;
  };
  totalProviders: number;
}

export interface QuotaResponse {
  providers: QuotaProviderEntry[];
  meta: QuotaResponseMeta;
}

function field(source: object, key: string): unknown {
  return Reflect.get(source, key);
}

function record(value: unknown): object {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTokenStatus(value: unknown): QuotaTokenStatus {
  switch (value) {
    case "expiring":
    case "expired":
    case "refreshing":
      return value;
    default:
      return "valid";
  }
}

function normalizeQueuePressure(value: unknown): QuotaQueuePressure {
  const source = record(value);
  const read = (key: string) => Math.max(0, toNumberOrNull(field(source, key)) ?? 0);
  return {
    queued: read("queued"),
    running: read("running"),
    executing: read("executing"),
  };
}

function normalizeQuotaStatus(value: unknown): QuotaStatus | null {
  return value === "known" || value === "unknown" || value === "cooldown" ? value : null;
}

export function sanitizeQuotaProvider(input: unknown): QuotaProviderEntry {
  const source = record(input);
  const rawProvider = field(source, "provider");
  const provider = typeof rawProvider === "string" ? rawProvider : "unknown";
  const rawName = field(source, "name");
  const name = typeof rawName === "string" && rawName.trim() ? rawName : provider;
  const rawConnectionId = field(source, "connectionId");
  const connectionId =
    typeof rawConnectionId === "string" && rawConnectionId.trim() ? rawConnectionId : "unknown";
  const rawResetAt = field(source, "resetAt");
  const resetAt = typeof rawResetAt === "string" && rawResetAt.trim() ? rawResetAt : null;
  const tokenStatus = normalizeTokenStatus(field(source, "tokenStatus"));
  const queuePressure = normalizeQueuePressure(field(source, "queuePressure"));

  const quotaTotalValue = toNumberOrNull(field(source, "quotaTotal"));
  const quotaStatus =
    normalizeQuotaStatus(field(source, "quotaStatus")) ??
    (quotaTotalValue !== null && quotaTotalValue > 0 ? "known" : "unknown");

  if (quotaStatus !== "known" || quotaTotalValue === null || quotaTotalValue <= 0) {
    return {
      name,
      provider,
      connectionId,
      quotaUsed: null,
      quotaTotal: null,
      percentRemaining: null,
      resetAt,
      tokenStatus,
      quotaStatus: quotaStatus === "cooldown" ? "cooldown" : "unknown",
      queuePressure,
    };
  }

  const quotaUsed = clamp(toNumberOrNull(field(source, "quotaUsed")) ?? 0, 0, quotaTotalValue);
  return {
    name,
    provider,
    connectionId,
    quotaUsed,
    quotaTotal: quotaTotalValue,
    percentRemaining: clamp(((quotaTotalValue - quotaUsed) / quotaTotalValue) * 100, 0, 100),
    resetAt,
    tokenStatus,
    quotaStatus: "known",
    queuePressure,
  };
}

export function normalizeQuotaResponse(
  raw: unknown,
  filters: { provider?: string | null; connectionId?: string | null } = {}
): QuotaResponse {
  const source = record(raw);
  const sourceProviders = field(source, "providers");
  const providersRaw = Array.isArray(sourceProviders)
    ? sourceProviders
    : Array.isArray(raw)
      ? raw
      : [];
  const providers = providersRaw.map((entry) => sanitizeQuotaProvider(entry));

  const sourceMeta = record(field(source, "meta"));
  const sourceFilters = record(field(sourceMeta, "filters"));
  const metaProvider = field(sourceFilters, "provider");
  const metaConnection = field(sourceFilters, "connectionId");
  const providerFilter =
    filters.provider ??
    (typeof metaProvider === "string" && metaProvider.trim() ? metaProvider : null);
  const connectionFilter =
    filters.connectionId ??
    (typeof metaConnection === "string" && metaConnection.trim() ? metaConnection : null);
  const rawGeneratedAt = field(sourceMeta, "generatedAt");
  const generatedAt =
    typeof rawGeneratedAt === "string" && rawGeneratedAt.trim()
      ? rawGeneratedAt
      : new Date().toISOString();

  return {
    providers,
    meta: {
      generatedAt,
      filters: {
        provider: providerFilter || null,
        connectionId: connectionFilter || null,
      },
      totalProviders: providers.length,
    },
  };
}
