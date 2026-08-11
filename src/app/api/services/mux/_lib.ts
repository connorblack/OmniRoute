/**
 * Shared helpers for /api/services/mux/* route handlers.
 * Creates a supervisor on demand if bootstrap hasn't registered one yet.
 */

import { getSupervisor, registerSupervisor } from "@/lib/services/registry";
import { ServiceSupervisor } from "@/lib/services/ServiceSupervisor";
import { resolveSpawnArgs, MUX_DEFAULT_PORT } from "@/lib/services/installers/mux";
import { getOrCreateApiKey } from "@/lib/services/apiKey";

const TOOL = "mux";
const PORT = parseInt(process.env.MUX_SERVICE_PORT ?? String(MUX_DEFAULT_PORT), 10);

export async function getOrInitSupervisor(): Promise<ServiceSupervisor> {
  const existing = getSupervisor(TOOL);
  if (existing) return existing;

  const apiKey = await getOrCreateApiKey(TOOL);

  const sup = new ServiceSupervisor({
    tool: TOOL,
    port: PORT,
    spawnArgs: () => resolveSpawnArgs(apiKey, PORT),
    healthUrl: () => `http://127.0.0.1:${PORT}/health`,
    healthIntervalMs: 5_000,
    stopTimeoutMs: 15_000,
    logsBufferBytes: 5_242_880,
    // #6205 parity with bootstrapEmbeddedServices(): these services bind a
    // FIXED port, so probe before spawning. Without this, pressing Start while
    // an instance is already listening spawns a duplicate that dies with
    // EADDRINUSE, the UI reports the useless "Fast crash (exited with code 0)",
    // and the healthy process is orphaned (status/pid overwritten with the dead
    // one). Whichever factory registers the supervisor first wins, and the
    // dashboard polls /status, so this on-demand path usually wins the race —
    // which is exactly how the guard got bypassed in practice.
    probeBeforeSpawn: true,
  });

  registerSupervisor(sup);
  return sup;
}
