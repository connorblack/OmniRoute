type EmbeddingAttempt = {
  success: boolean;
  retryWithNextConnection?: boolean;
};

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

/**
 * Run one embedding request, rotating to the next eligible connection while the
 * handler reports the failure as account-scoped (per-model lockout, cooldown).
 * Every failed connection is excluded from the following selection, so the loop
 * ends when a request succeeds, the failure is not account-scoped, the selector
 * runs out of connections, or the selector returns a connection already tried.
 * When no connection is left the last upstream failure is returned; the initial
 * selection failure is returned only if nothing was ever attempted.
 */
export async function runEmbeddingWithFailover<C, R extends EmbeddingAttempt>(
  select: (excludeConnectionIds: string[]) => Promise<C>,
  run: (credentials: NonNullable<C>) => Promise<R>
): Promise<{ credentials: C; result: R | null }> {
  const excludeConnectionIds: string[] = [];
  let last: { credentials: C; result: R } | null = null;
  while (true) {
    const credentials = await select(excludeConnectionIds);
    if (!isRoutable(credentials)) return last ?? { credentials, result: null };
    const connectionId = connectionIdOf(credentials);
    if (last && connectionId && excludeConnectionIds.includes(connectionId)) return last;
    const result = await run(credentials);
    last = { credentials, result };
    if (result.success || !result.retryWithNextConnection || !connectionId) return last;
    excludeConnectionIds.push(connectionId);
  }
}
