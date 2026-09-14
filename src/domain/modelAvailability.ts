import {
  getAllModelLockouts,
  clearModelLock,
  type ModelLockoutInfo,
} from "@omniroute/open-sse/services/accountFallback";
import {
  clearSlowStartModel,
  clearSlowStartScope,
  clearSlowStartState,
} from "@omniroute/open-sse/services/slowStartCooldown";

export type AvailabilityReportItem = Pick<
  ModelLockoutInfo,
  "scope" | "provider" | "model" | "reason" | "remainingMs" | "failureCount" | "lockedAt" | "until"
> & {
  connectionId: string;
};

export function getAvailabilityReport(): AvailabilityReportItem[] {
  return getAllModelLockouts().map((entry) => ({
    scope: entry.scope,
    provider: entry.provider,
    model: entry.model,
    connectionId: entry.connectionId,
    reason: entry.reason,
    remainingMs: entry.remainingMs,
    failureCount: entry.failureCount,
    lockedAt: entry.lockedAt,
    until: entry.until,
  }));
}

export function clearModelConnectionUnavailability(
  provider: string,
  connectionId: string,
  model: string
): boolean {
  const lockCleared = clearModelLock(provider, connectionId, model);
  const stateCleared = clearSlowStartScope(provider, connectionId, model);
  return lockCleared || stateCleared;
}

export function clearModelUnavailability(provider: string, model: string): boolean {
  const all = getAllModelLockouts();
  const matching = all.filter((e) => e.provider === provider && e.model === model);
  let cleared = clearSlowStartModel(provider, model) > 0;
  for (const entry of matching) {
    if (clearModelLock(provider, entry.connectionId, model)) cleared = true;
  }
  return cleared;
}

export function resetAllAvailability(): void {
  const all = getAllModelLockouts();
  for (const entry of all) {
    clearModelLock(entry.provider, entry.connectionId, entry.model);
  }
  clearSlowStartState();
}
