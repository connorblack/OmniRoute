export type ConnectionRateLimitOverrides = Record<string, number>;

const overridesByConnection = new Map<string, ConnectionRateLimitOverrides>();

export function getConnectionRateLimitOverrides(
  connectionId: string | null | undefined
): ConnectionRateLimitOverrides | undefined {
  return connectionId ? overridesByConnection.get(connectionId) : undefined;
}

export function setConnectionRateLimitOverrides(
  connectionId: string,
  overrides: ConnectionRateLimitOverrides | null | undefined
): void {
  if (overrides) overridesByConnection.set(connectionId, overrides);
  else overridesByConnection.delete(connectionId);
}

export function clearConnectionRateLimitOverrides(): void {
  overridesByConnection.clear();
}
