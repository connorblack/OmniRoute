import type { RegistryEntry } from "../../shared.ts";

/**
 * Cursor via the local agent CLI (`cursor-agent acp`, driven by `acpx`).
 *
 * Distinct from the `cursor` provider, which posts to api2.cursor.sh: this one
 * spawns the agent CLI on the router host and speaks ACP over stdio. Auth is
 * delegated entirely to `cursor-agent login` — OmniRoute stores no credential
 * for this connection.
 *
 * `models` is intentionally EMPTY and `passthroughModels` is on. Cursor's
 * lineup is account-scoped and changes without a CLI release, so the catalog is
 * discovered live from the agent on every cache miss
 * (services/cursorCliModels.ts) rather than baked in here, where it would be
 * wrong for somebody the day it shipped. The executor validates every requested
 * model against that live list before it reaches the child process argv.
 */
export const cursor_cliProvider: RegistryEntry = {
  id: "cursor-cli",
  alias: "ccli",
  format: "openai",
  executor: "cursor-cli",
  baseUrl: "acpx://cursor/acp",
  authType: "none",
  authHeader: "none",
  passthroughModels: true,
  defaultContextLength: 200000,
  models: [],
};
