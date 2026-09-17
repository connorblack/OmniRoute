import { errorResponse, providerCircuitOpenResponse } from "@omniroute/open-sse/utils/error.ts";
import { getCachedSettings } from "@/lib/db/readCache";
import { isProviderBreakerFailureStatus } from "@/sse/handlers/chatPredicates";
import {
  getCooldownAwareRetryDecision,
  resolveCooldownAwareRetrySettings,
  waitForCooldownAwareRetry,
  type CooldownAwareRetrySettings,
} from "@/sse/services/cooldownAwareRetry";
import { getProviderCircuitBreaker } from "@/sse/services/providerCircuitBreaker";
import {
  isRetryablePreOutputTransportError,
  sameAccountTransportRetryDelayMs,
  shouldRetrySameAccountTransport,
} from "@/sse/services/sameAccountTransportRetry";
import * as log from "@/sse/utils/logger";

type EmbeddingAttempt = {
  success: boolean;
  status?: number;
  error?: string;
  retryWithNextConnection?: boolean;
  localRateLimit?: boolean;
};

type ProviderBreaker = {
  canExecute(): boolean;
  getRetryAfterMs(): number;
  _onSuccess(): void;
  _onFailure(): void;
};

export type EmbeddingFailoverOptions = {
  provider: string;
  model?: string | null;
  signal?: AbortSignal | null;
  breaker?: ProviderBreaker;
  retrySettings?: CooldownAwareRetrySettings;
};

export type EmbeddingFailoverOutcome<C, R> = {
  credentials: C | null;
  result: R | null;
  response?: Response;
};

type SelectionFailure = { allRateLimited?: boolean; retryAfter?: unknown };

function isRoutable<C>(credentials: C): credentials is NonNullable<C> {
  return (
    credentials != null &&
    typeof credentials === "object" &&
    !("allRateLimited" in credentials) &&
    !("allExpired" in credentials)
  );
}

function connectionIdOf(credentials: object): string | null {
  const id = (credentials as { connectionId?: unknown }).connectionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function tripsProviderBreaker(result: EmbeddingAttempt): boolean {
  return (
    !result.success &&
    !result.localRateLimit &&
    typeof result.status === "number" &&
    isProviderBreakerFailureStatus(result.status)
  );
}

/**
 * One embedding request with the resilience the chat path applies: the
 * provider circuit breaker, rotation across connections while a failure is
 * account-scoped, one same-account retry for a pre-output transport failure,
 * and a cooldown-aware wait when every connection is rate limited.
 */
export async function runEmbeddingWithFailover<C, R extends EmbeddingAttempt>(
  select: (excludeConnectionIds: string[]) => Promise<C>,
  run: (credentials: NonNullable<C>) => Promise<R>,
  options: EmbeddingFailoverOptions
): Promise<EmbeddingFailoverOutcome<C, R>> {
  const { provider, model, signal = null } = options;
  const breaker = options.breaker ?? (await getProviderCircuitBreaker(provider));
  if (!breaker.canExecute()) {
    const retryAfterSec = Math.max(Math.ceil(breaker.getRetryAfterMs() / 1000), 1);
    log.warn("CIRCUIT", `Circuit breaker OPEN for ${provider}, rejecting embedding request`);
    return {
      credentials: null,
      result: null,
      response: providerCircuitOpenResponse(provider, retryAfterSec),
    };
  }
  const retrySettings =
    options.retrySettings ??
    resolveCooldownAwareRetrySettings(await getCachedSettings().catch(() => ({})));
  let retryBudgetLeftMs = retrySettings.budgetMs;
  let last: { credentials: C; result: R } | null = null;

  for (let requestAttempt = 0; ; requestAttempt++) {
    const excludeConnectionIds: string[] = [];
    const transportRetries = new Map<string, number>();
    let credentials = await select(excludeConnectionIds);

    while (isRoutable(credentials)) {
      const connectionId = connectionIdOf(credentials);
      if (connectionId && excludeConnectionIds.includes(connectionId)) break;
      const result = await run(credentials);
      last = { credentials, result };
      if (result.success) {
        breaker._onSuccess();
        return last;
      }
      if (!connectionId) break;

      const transportFailure = isRetryablePreOutputTransportError(result.status, result.error);
      const transportAttempt = transportRetries.get(connectionId) ?? 0;
      if (
        shouldRetrySameAccountTransport({
          status: result.status,
          errorText: result.error,
          attempt: transportAttempt,
        })
      ) {
        transportRetries.set(connectionId, transportAttempt + 1);
        if (!(await waitForCooldownAwareRetry(sameAccountTransportRetryDelayMs(), signal))) {
          return { ...last, response: errorResponse(499, "Request aborted") };
        }
        continue;
      }
      if (!result.retryWithNextConnection && !transportFailure) break;
      excludeConnectionIds.push(connectionId);
      credentials = await select(excludeConnectionIds);
    }

    const selection = credentials as SelectionFailure | null;
    const poolCoolingDown = !isRoutable(credentials) && selection?.allRateLimited === true;
    if (poolCoolingDown) {
      const decision = getCooldownAwareRetryDecision({
        retryAfter: selection.retryAfter,
        settings: retrySettings,
        attempt: requestAttempt,
        budgetLeftMs: retryBudgetLeftMs,
      });
      if (decision.shouldRetry) {
        const waitSec = Math.max(Math.ceil(decision.waitMs / 1000), 0);
        log.info(
          "COOLDOWN_RETRY",
          `${provider}/${model ?? ""} embeddings: all connections cooling down — waiting ${waitSec}s before retry ${requestAttempt + 1}/${retrySettings.maxRetries}`
        );
        if (!(await waitForCooldownAwareRetry(decision.waitMs, signal))) {
          return {
            credentials,
            result: last?.result ?? null,
            response: errorResponse(499, "Request aborted"),
          };
        }
        retryBudgetLeftMs = Math.max(0, retryBudgetLeftMs - decision.waitMs);
        continue;
      }
    }

    if (last && tripsProviderBreaker(last.result)) breaker._onFailure();
    return last ?? { credentials, result: null };
  }
}
