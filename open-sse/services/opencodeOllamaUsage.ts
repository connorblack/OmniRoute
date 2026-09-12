import { sanitizeErrorMessage } from "../utils/error.ts";

type JsonRecord = Record<string, unknown>;
type UsageQuota = {
  used: number;
  total: number;
  remaining?: number;
  remainingPercentage?: number;
  resetAt: string | null;
  unlimited: boolean;
  displayName?: string;
  details?: Array<{ name: string; used: number }>;
  currency?: string;
};

const OLLAMA_CLOUD_USAGE_URL =
  process.env.OMNIROUTE_OLLAMA_CLOUD_USAGE_URL ?? "https://ollama.com/settings";
const OLLAMA_CLOUD_SESSION_COOKIE = "__Secure-session";

type OllamaUsageWindow = { usagePercent: number; resetAt: string | null };
// The 2026-08-19 ollama.com/settings redesign replaced the session+weekly
// tracks with a single monthly meter denominated in dollars. `currency` and
// `segments` only ever populate on that monthly window.
type OllamaMonthlyWindow = OllamaUsageWindow & {
  currency?: string;
  segments?: Array<{ name: string; used: number }>;
};
type OllamaCloudUsage = {
  session?: OllamaUsageWindow;
  weekly?: OllamaUsageWindow;
  monthly?: OllamaMonthlyWindow;
  planTier?: string | null;
};
type OllamaCloudConfig =
  { state: "configured"; cookie: string } | { state: "invalid"; error: string } | { state: "none" };

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPercentage(value: unknown): number {
  return Math.max(0, Math.min(100, toNumber(value, 0)));
}
function getProviderSpecificString(data: JsonRecord | undefined, keys: string[]): string {
  const obj = toRecord(data);
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
function resolveOllamaCloudConfig(providerSpecificData?: JsonRecord): OllamaCloudConfig {
  const cookie =
    process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE?.trim() ||
    process.env.OLLAMA_USAGE_COOKIE?.trim() ||
    process.env.OLLAMA_CLOUD_USAGE_COOKIE?.trim() ||
    getProviderSpecificString(providerSpecificData, [
      "ollamaUsageCookie",
      "ollamaCloudUsageCookie",
      "ollamaCloudCookie",
      "usageCookie",
      "cookie",
    ]);
  if (!cookie) return { state: "none" };
  if (cookie.includes("\r") || cookie.includes("\n")) {
    return { state: "invalid", error: "Ollama Cloud cookie contains invalid CRLF characters." };
  }
  return { state: "configured", cookie };
}

function normalizeOllamaCloudCookie(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith(`${OLLAMA_CLOUD_SESSION_COOKIE.toLowerCase()}=`)
    ? trimmed.slice(OLLAMA_CLOUD_SESSION_COOKIE.length + 1).trim()
    : trimmed;
}

function extractOllamaUsagePercent(trackHtml: string): number | null {
  const tagHeader = trackHtml.match(/^[^>]*/)?.[0] ?? "";
  const ariaMatch = tagHeader.match(/(\d+(?:\.\d+)?)%\s*used/);
  if (ariaMatch) {
    const pct = toNumber(ariaMatch[1], Number.NaN);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) return pct;
  }
  const style = tagHeader.match(/style="([^"]*)"/)?.[1] ?? "";
  const pct = toNumber(style.match(/(?:^|;)\s*width\s*:\s*([0-9.]+)%/)?.[1], Number.NaN);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

// The inner fill div's width (e.g. `style="width: 69.3%; "` on the child of
// `data-usage-track`) always renders before any `data-usage-segment` button,
// so the first width match in the whole track segment is the overall meter
// fill, not one model's slice of it.
function extractInnerWidthPercent(trackHtml: string): number | null {
  const pct = toNumber(trackHtml.match(/style="[^"]*width\s*:\s*([0-9.]+)%/)?.[1], Number.NaN);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

// Monthly usage is reported in dollars, e.g.
// aria-label="Monthly usage $207.95 of $300 used". Percent is derived from
// those two amounts so the rest of the pipeline (which is percent/threshold
// based) doesn't need to know about currency.
function extractMonthlyDollarPercent(
  ariaLabel: string
): { percent: number; currency: string } | null {
  const match = ariaLabel.match(/\$([0-9][0-9,]*(?:\.[0-9]+)?)\s+of\s+\$([0-9][0-9,]*(?:\.[0-9]+)?)\s+used/i);
  if (!match) return null;
  const used = toNumber(match[1].replace(/,/g, ""), Number.NaN);
  const total = toNumber(match[2].replace(/,/g, ""), Number.NaN);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return { percent: toPercentage((used / total) * 100), currency: "USD" };
}

function extractOllamaUsageSegments(trackHtml: string): Array<{ name: string; used: number }> {
  const segments: Array<{ name: string; used: number }> = [];
  const buttonRegex = /<button\b[^>]*data-usage-segment[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = buttonRegex.exec(trackHtml))) {
    const tag = match[0];
    const model = tag.match(/data-model="([^"]*)"/)?.[1];
    const requests = toNumber(tag.match(/data-requests="([^"]*)"/)?.[1], Number.NaN);
    if (model && Number.isFinite(requests)) segments.push({ name: model, used: requests });
  }
  return segments;
}

// Backward-compatible with the pre-redesign markup (`class="local-time"
// data-time="..."`), and robust to the redesign dropping that class: the
// reset caption is the first `data-time` attribute after the meter, so a
// bare fallback still lands on the right element.
function extractResetTime(text: string): string | null {
  const classScoped = text.match(/class="[^"]*local-time[^"]*"[^>]*data-time="([^"]*)"/);
  if (classScoped) return classScoped[1] || null;
  return text.match(/data-time="([^"]*)"/)?.[1] || null;
}

function extractMonthlyWindow(trackHtml: string): OllamaMonthlyWindow | null {
  const tagHeader = trackHtml.match(/^[^>]*/)?.[0] ?? "";
  const ariaLabel = tagHeader.match(/aria-label="([^"]*)"/)?.[1] ?? "";
  const dollarResult = extractMonthlyDollarPercent(ariaLabel);
  const percent = dollarResult
    ? dollarResult.percent
    : (extractOllamaUsagePercent(trackHtml) ?? extractInnerWidthPercent(trackHtml));
  if (percent === null) return null;

  const segments = extractOllamaUsageSegments(trackHtml);
  return {
    usagePercent: percent,
    resetAt: extractResetTime(trackHtml),
    ...(dollarResult ? { currency: dollarResult.currency } : {}),
    ...(segments.length > 0 ? { segments } : {}),
  };
}

function extractOllamaPlanTier(html: string): string | null {
  return html.match(/class="[^"]*capitalize[^"]*"[^>]*>([^<]*)</)?.[1]?.trim() || null;
}

function parseOllamaCloudSettingsHtml(html: string): OllamaCloudUsage | null {
  const parts = html.split(/\bdata-usage-track\b/);
  if (parts.length < 2) return null;
  const planTier = extractOllamaPlanTier(html);

  // A single `data-usage-track` means the 2026-08-19+ single monthly-meter
  // layout; two means the pre-redesign session+weekly layout.
  if (parts.length === 2) {
    const monthly = extractMonthlyWindow(parts[1]);
    return monthly ? { monthly, planTier } : null;
  }

  const sessionPercent = extractOllamaUsagePercent(parts[1]);
  const weeklyPercent = parts[2] ? extractOllamaUsagePercent(parts[2]) : null;
  if (sessionPercent === null && weeklyPercent === null) return null;
  return {
    ...(sessionPercent !== null
      ? { session: { usagePercent: sessionPercent, resetAt: extractResetTime(parts[1]) } }
      : {}),
    ...(weeklyPercent !== null
      ? { weekly: { usagePercent: weeklyPercent, resetAt: extractResetTime(parts[2]) } }
      : {}),
    planTier,
  };
}

async function fetchOllamaCloudUsageFromSettings(
  config: Extract<OllamaCloudConfig, { state: "configured" }>
) {
  const response = await fetch(OLLAMA_CLOUD_USAGE_URL, {
    redirect: "manual",
    headers: {
      Accept: "text/html",
      Cookie: `${OLLAMA_CLOUD_SESSION_COOKIE}=${normalizeOllamaCloudCookie(config.cookie)}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/152.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    return { usage: null, message: "Ollama Cloud authentication expired. Refresh the cookie." };
  }
  if (!response.ok)
    return { usage: null, message: `Ollama Cloud settings error (${response.status}).` };
  const usage = parseOllamaCloudSettingsHtml(await response.text());
  return {
    usage,
    message: usage ? undefined : "Ollama Cloud settings page did not contain usage quota tracks.",
  };
}

const OLLAMA_QUOTA_WINDOW_DISPLAY_NAMES = {
  session: "Session",
  weekly: "Weekly",
  monthly: "Monthly",
} as const;

function buildOllamaUsageQuota(
  window: OllamaUsageWindow | OllamaMonthlyWindow,
  displayName: string
): UsageQuota {
  const pct = toPercentage(window.usagePercent);
  const quota: UsageQuota = {
    used: pct,
    total: 100,
    remaining: Math.max(0, 100 - pct),
    remainingPercentage: Math.max(0, 100 - pct),
    resetAt: window.resetAt,
    unlimited: false,
    displayName,
  };
  if ("currency" in window && window.currency) quota.currency = window.currency;
  if ("segments" in window && window.segments && window.segments.length > 0) {
    quota.details = window.segments.map((segment) => ({ name: segment.name, used: segment.used }));
  }
  return quota;
}

export async function getOllamaCloudUsage(providerSpecificData?: JsonRecord) {
  const config = resolveOllamaCloudConfig(providerSpecificData);
  if (config.state === "none") {
    return {
      message:
        "Ollama Cloud quota requires OLLAMA_USAGE_COOKIE. Copy the __Secure-session cookie from ollama.com/settings.",
    };
  }
  if (config.state === "invalid") return { message: config.error };

  try {
    const result = await fetchOllamaCloudUsageFromSettings(config);
    if (!result.usage) return { message: result.message || "Ollama Cloud quota data unavailable." };
    const quotas: Record<string, UsageQuota> = {};
    for (const key of ["session", "weekly", "monthly"] as const) {
      const quota = result.usage[key];
      if (!quota) continue;
      quotas[key] = buildOllamaUsageQuota(quota, OLLAMA_QUOTA_WINDOW_DISPLAY_NAMES[key]);
    }
    return {
      plan: result.usage.planTier ? `Ollama Cloud ${result.usage.planTier}` : "Ollama Cloud",
      quotas,
    };
  } catch (error) {
    return { message: `Ollama Cloud quota error: ${sanitizeErrorMessage(error)}` };
  }
}
