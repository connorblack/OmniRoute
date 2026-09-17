import { getRuntimeProviderProfile } from "@omniroute/open-sse/services/accountFallback.ts";
import { getCircuitBreaker, isLocalStreamLifecycleError } from "../../shared/utils/circuitBreaker";
import { classify429FromError, type FailureKind } from "../../shared/utils/classify429";
import { resolveUseUpstream429BreakerHints } from "../../shared/utils/providerHints";
import * as log from "../utils/logger";

export type ProviderBreakerProfile = {
  circuitBreakerThreshold?: number;
  circuitBreakerReset?: number;
  failureThreshold?: number;
  degradationThreshold?: number;
  resetTimeoutMs?: number;
  useUpstream429BreakerHints?: boolean;
};

/** The whole-provider circuit breaker, configured from the provider's runtime profile. */
export async function getProviderCircuitBreaker(
  provider: string,
  profile?: ProviderBreakerProfile | null
) {
  const providerProfile: ProviderBreakerProfile =
    profile ?? (await getRuntimeProviderProfile(provider));
  // Issue #2100 follow-up: opt-in upstream 429 hint trust per provider.
  const useHints429 = resolveUseUpstream429BreakerHints(
    provider,
    providerProfile.useUpstream429BreakerHints
  );
  return getCircuitBreaker(provider, {
    failureThreshold: providerProfile.failureThreshold ?? providerProfile.circuitBreakerThreshold,
    degradationThreshold: providerProfile.degradationThreshold,
    resetTimeout: providerProfile.resetTimeoutMs ?? providerProfile.circuitBreakerReset,
    // #4602: a local WS-bridge "Controller is already closed" throw is not an
    // upstream outage — keep it from tripping the whole-provider breaker.
    isFailure: (e) => !isLocalStreamLifecycleError(e),
    onStateChange: (name: string, from: string, to: string) =>
      log.info("CIRCUIT", `${name}: ${from} → ${to}`),
    ...(useHints429
      ? {
          cooldownByKind: {
            rate_limit: 60_000,
            quota_exhausted: 3_600_000,
          } satisfies Partial<Record<FailureKind, number>>,
          classifyError: classify429FromError,
        }
      : {}),
  });
}
