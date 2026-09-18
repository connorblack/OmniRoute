export const RATE_LIMIT_EXECUTION_TIMEOUT_CODE = "RATE_LIMIT_EXECUTION_TIMEOUT";
export const RATE_LIMIT_QUEUE_FULL_CODE = "RATE_LIMIT_QUEUE_FULL";
export const RATE_LIMIT_QUEUE_WEDGED_CODE = "RATE_LIMIT_QUEUE_WEDGED";
export const LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE = "RATE_LIMIT_QUEUE_TIMEOUT";

export type LocalRateLimitErrorCode =
  | typeof RATE_LIMIT_EXECUTION_TIMEOUT_CODE
  | typeof RATE_LIMIT_QUEUE_FULL_CODE
  | typeof RATE_LIMIT_QUEUE_WEDGED_CODE;

export type TrustedLocalRateLimitErrorCode =
  LocalRateLimitErrorCode | typeof LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE;

export interface TrustedLocalRateLimitFailure {
  code: TrustedLocalRateLimitErrorCode;
  status: 429 | 503 | 504;
}

const localRateLimitErrors = new WeakMap<object, TrustedLocalRateLimitFailure>();
const localRateLimitResponses = new WeakMap<Response, TrustedLocalRateLimitFailure>();

function getStatusForCode(code: TrustedLocalRateLimitErrorCode): 429 | 503 | 504 {
  switch (code) {
    case RATE_LIMIT_QUEUE_FULL_CODE:
      return 429;
    case RATE_LIMIT_EXECUTION_TIMEOUT_CODE:
      return 504;
    case RATE_LIMIT_QUEUE_WEDGED_CODE:
    case LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE:
      return 503;
  }
}

/**
 * Brand an error created by OmniRoute's local limiter. The WeakMap identity,
 * not the public code string, is the trusted provenance signal.
 */
export function markLocalRateLimitError<T extends Error>(
  error: T,
  code: TrustedLocalRateLimitErrorCode
): T & { code: TrustedLocalRateLimitErrorCode; status: 429 | 503 | 504 } {
  const failure = Object.freeze({ code, status: getStatusForCode(code) });
  localRateLimitErrors.set(error, failure);
  const branded = error as T & {
    code: TrustedLocalRateLimitErrorCode;
    status: 429 | 503 | 504;
  };
  branded.code = failure.code;
  branded.status = failure.status;
  return branded;
}

export function getTrustedLocalRateLimitError(error: unknown): TrustedLocalRateLimitFailure | null {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  return localRateLimitErrors.get(error as object) ?? null;
}

const LOCAL_RATE_LIMIT_ERROR_CODES: readonly TrustedLocalRateLimitErrorCode[] = [
  RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
  RATE_LIMIT_QUEUE_FULL_CODE,
  RATE_LIMIT_QUEUE_WEDGED_CODE,
  LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
];

/**
 * Canonicalize a `code` string that claims to be one of OmniRoute's own local
 * limiter codes. Case-insensitive because the same code travels both as the raw
 * `error.code` (upper) and through `buildErrorBody`'s lowercase public-identifier
 * vocabulary before the combo loop reads it back off the response body.
 */
export function canonicalLocalRateLimitCode(code: unknown): TrustedLocalRateLimitErrorCode | null {
  if (typeof code !== "string") return null;
  const upper = code.toUpperCase();
  return LOCAL_RATE_LIMIT_ERROR_CODES.find((known) => known === upper) ?? null;
}

/** True when `code` names one of OmniRoute's own local request-queue limits. */
export function isLocalRateLimitErrorCode(code: unknown): boolean {
  return canonicalLocalRateLimitCode(code) !== null;
}

/**
 * Resolve local-limiter provenance for an error. The WeakMap identity set by
 * `markLocalRateLimitError` is the PRIMARY signal and is checked first; the
 * `error.code` string is only a fallback.
 *
 * Why the string fallback is safe even though a provider body could carry the same
 * code: the fallback is strictly de-escalating. Everything it unlocks EXEMPTS the
 * provider from resilience penalties (no connection cooldown, no model lockout, no
 * circuit-breaker failure) and remaps the status to one WE choose from
 * `getStatusForCode` — a provider body can never use it to fabricate a success, to
 * cool a rival connection, or to pick its own HTTP status. The worst a spoofing
 * provider achieves is declining to be cooled down after its own failure, which
 * costs it the retry it just wasted. The WeakMap stays primary precisely so genuine
 * provenance is never merely string-deep.
 */
export function resolveLocalRateLimitFailure(error: unknown): TrustedLocalRateLimitFailure | null {
  const trusted = getTrustedLocalRateLimitError(error);
  if (trusted) return trusted;
  if (!error || typeof error !== "object") return null;
  const code = canonicalLocalRateLimitCode((error as { code?: unknown }).code);
  if (!code) return null;
  return Object.freeze({ code, status: getStatusForCode(code) });
}

/**
 * Return the public fields for a local limiter failure without its low-level
 * Bottleneck cause, which must remain server-side diagnostic context.
 */
export function getClientSafeLocalRateLimitError(
  error: unknown
): (TrustedLocalRateLimitFailure & { message: string }) | null {
  const failure = resolveLocalRateLimitFailure(error);
  if (!failure) return null;
  return {
    ...failure,
    message: error instanceof Error ? error.message : "Local rate-limit failure",
  };
}

/**
 * Transfer trusted local provenance from a branded error to its generated
 * internal Response. Provider-controlled bodies and headers cannot set this.
 */
export function markTrustedLocalRateLimitResponse(response: Response, error: unknown): Response {
  const failure = resolveLocalRateLimitFailure(error);
  if (failure) localRateLimitResponses.set(response, failure);
  return response;
}

export function getTrustedLocalRateLimitResponse(
  response: Response
): TrustedLocalRateLimitFailure | null {
  return localRateLimitResponses.get(response) ?? null;
}

/** Preserve trusted provenance when an internal response wrapper must allocate. */
export function inheritTrustedLocalRateLimitResponse(source: Response, target: Response): Response {
  const failure = localRateLimitResponses.get(source);
  if (failure) localRateLimitResponses.set(target, failure);
  return target;
}
