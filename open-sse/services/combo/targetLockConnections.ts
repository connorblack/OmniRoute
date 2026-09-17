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
 * Connection ids whose model locks describe a combo target after it failed.
 *
 * AUTH locks the connection that served the request, so an unpinned target's
 * lock lives under one of its provider's connections or the synthetic no-auth
 * one. The combo's own synthetic failures lock the target's connection id,
 * which is "" when the target is unpinned.
 */
export async function getTargetLockConnectionIds(
  target: LockTarget,
  log: ComboLogger
): Promise<string[]> {
  if (target.connectionId) return [target.connectionId];
  if (target.allowedConnectionIds?.length) return ["", ...target.allowedConnectionIds];

  const ids = ["", SYNTHETIC_NOAUTH_CONNECTION_ID];
  if (!target.provider) return ids;
  try {
    const connections = await getCachedProviderConnections({
      provider: resolveProviderId(target.provider),
      isActive: true,
    });
    for (const connection of connections as Array<{ id?: unknown }>) {
      if (typeof connection?.id === "string") ids.push(connection.id);
    }
  } catch (error) {
    log.warn("COMBO", "Could not load provider connections for a model-lock lookup", {
      provider: target.provider,
      err: error,
    });
  }
  return ids;
}
