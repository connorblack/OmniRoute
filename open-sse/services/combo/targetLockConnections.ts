import { isModelLocked } from "../accountFallback.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "../autoCombo/resilienceCandidateFilter.ts";
import { getCachedProviderConnections } from "../../../src/lib/db/readCache";
import { resolveProviderId } from "../../../src/shared/constants/providers.ts";
import type { ComboLogger } from "./types.ts";

type LockTarget = {
  provider?: string | null;
  connectionId?: string | null;
  allowedConnectionIds?: string[] | null;
};

/**
 * Where a combo target's model locks live.
 *
 * `targetIds` lock the whole target: the pinned connection, or for an unpinned
 * target the combo's own synthetic "" lock and, without an allowlist, the
 * no-auth connection. `connectionIds` are the real connections AUTH may pick;
 * each lock there blocks only that connection.
 */
type TargetLockScope = { targetIds: string[]; connectionIds: string[] };

async function getTargetLockScope(target: LockTarget, log: ComboLogger): Promise<TargetLockScope> {
  if (target.connectionId) return { targetIds: [target.connectionId], connectionIds: [] };
  if (target.allowedConnectionIds?.length) {
    return { targetIds: [""], connectionIds: target.allowedConnectionIds };
  }

  const targetIds = ["", SYNTHETIC_NOAUTH_CONNECTION_ID];
  if (!target.provider) return { targetIds, connectionIds: [] };
  const connectionIds: string[] = [];
  try {
    const connections = await getCachedProviderConnections({
      provider: resolveProviderId(target.provider),
      isActive: true,
    });
    for (const connection of connections as Array<{ id?: unknown }>) {
      if (typeof connection?.id === "string") connectionIds.push(connection.id);
    }
  } catch (error) {
    log.warn("COMBO", "Could not load provider connections for a model-lock lookup", {
      provider: target.provider,
      err: error,
    });
  }
  return { targetIds, connectionIds };
}

/** Every connection id that can hold a model lock for the target. */
export async function getTargetLockConnectionIds(
  target: LockTarget,
  log: ComboLogger
): Promise<string[]> {
  const { targetIds, connectionIds } = await getTargetLockScope(target, log);
  return [...targetIds, ...connectionIds];
}

/** True when no connection is left to serve the model for this target. */
export async function isTargetModelLocked(
  target: LockTarget,
  provider: string,
  model: string,
  log: ComboLogger
): Promise<boolean> {
  const { targetIds, connectionIds } = await getTargetLockScope(target, log);
  const locked = (connectionId: string) => isModelLocked(provider, connectionId, model);
  return targetIds.some(locked) || (connectionIds.length > 0 && connectionIds.every(locked));
}
