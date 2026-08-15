/**
 * cursorAcp — ACP (Agent Client Protocol) transport for the `cursor` provider.
 *
 * This is an alternative transport for the SAME provider, not a second one:
 * `src/lib/acp/registry.ts` already frames ACP as "an alternative to the HTTP
 * proxy method" and maps agents onto existing providers via `providerAlias`.
 * A connection opts in with `providerSpecificData.transport = "acp"`; anything
 * else keeps the protobuf/HTTP path in executors/cursor.ts.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * api2.cursor.sh rejects the 5-series model ids OmniRoute sends over HTTP.
 * Driving the locally-installed agent through `acpx` sidesteps that, because
 * the agent only ever sees ids it advertised itself.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * No credential is injected. cursor-agent authenticates from its own store —
 * `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` on Linux — which is the very
 * file `src/lib/cursor/tokenExtractor.ts::tryAgentAuth()` already imports into
 * the cursor connection. Same identity, so the connection's testStatus and
 * expiry stay meaningful; ACP simply does not need the bearer on the wire.
 *
 * ── Model ids ───────────────────────────────────────────────────────────────
 * There is no bespoke mapping here. Cursor's canonical model representation is
 * `RequestedModel { model_id, parameters[] }`, and `resolveRequestedModel()`
 * (utils/cursorAgentProtobuf.ts) already decomposes the flattened, effort-
 * suffixed client id into it:
 *
 *   "claude-opus-4-8-high" -> { model_id: "claude-opus-4-8", [effort=high] }
 *   "gpt-5.5-high"         -> { model_id: "gpt-5.5",         [reasoning=high] }
 *   "auto"                 -> { model_id: "default",         [] }
 *
 * ACP's bracket id is that same structure serialised as a string:
 *
 *   claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]
 *
 * So selection is: decompose with the existing resolver, then match the base
 * against what the agent advertised.
 *
 * ── The real transport limit ────────────────────────────────────────────────
 * The agent's ACP adapter accepts ONLY its advertised parameterisations — one
 * canonical set per base model. `session/set_config_option` with a constructed
 * combination is refused by the AGENT (ACP -32602), not merely by acpx:
 *
 *   claude-sonnet-5  advertises effort=high
 *   claude-opus-4-7  advertises effort=xhigh
 *
 * The HTTP path can carry arbitrary `effort`/`reasoning` in
 * RequestedModel.parameters; ACP cannot. When a request asks for a parameter
 * value the agent did not advertise we FAIL with the advertised alternative
 * named, rather than silently substituting — an effort downgrade is a quality
 * and cost change the caller did not ask for.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { resolveRequestedModel } from "../utils/cursorAgentProtobuf.ts";

export type CursorAcpModel = {
  /** Fully-qualified advertised id, e.g. `claude-sonnet-5[thinking=true,...]`. */
  acpModelId: string;
  /** Base id, e.g. `claude-sonnet-5`. Matches RequestedModel.model_id. */
  baseId: string;
  /** Advertised parameters, parsed from the bracket. */
  parameters: Record<string, string>;
  /** Display name as advertised. */
  name: string;
};

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 30_000;

let cache: { models: CursorAcpModel[]; fetchedAt: number } | null = null;
let inFlight: Promise<CursorAcpModel[]> | null = null;

// ─── Environment ─────────────────────────────────────────────────────────────

export function resolveAcpxBin(): string {
  const envBin = (process.env.ACPX_BIN || process.env.CLI_ACPX_BIN || "").trim();
  if (envBin) return envBin;
  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".bun", "bin", "acpx"),
    path.join(home, ".local", "bin", "acpx"),
    "/usr/local/bin/acpx",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "acpx.cmd" : "acpx";
}

/**
 * A neutral, non-repo working directory.
 *
 * cursor-agent loads AGENTS.md / rules / skills from its cwd, so running it
 * inside a checkout silently prepends that repo's instructions to every
 * completion. A router must be context-free.
 */
export function resolveCursorAcpCwd(): string {
  const configured = (process.env.CURSOR_ACP_CWD || "").trim();
  const dir = configured || path.join(os.tmpdir(), "omniroute-cursor-acp");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort — spawn surfaces a real failure */
  }
  return dir;
}

/**
 * Scoped XDG override for the spawned agent only.
 *
 * Setting XDG_CONFIG_HOME globally would relocate every other CLI's config
 * (codex, claude, droid and openclaw share the config home), so deployments
 * that mount cursor's credential outside the container user's $HOME set
 * CURSOR_ACP_CONFIG_HOME instead. AGENT_CLI_CREDENTIAL_STORE is passed through
 * untouched: forcing `file` would break a macOS developer whose working
 * credential lives in the Keychain.
 */
export function cursorAcpChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const configHome = (process.env.CURSOR_ACP_CONFIG_HOME || "").trim();
  if (configHome) env.XDG_CONFIG_HOME = configHome;
  return env;
}

// ─── Advertised model parsing ────────────────────────────────────────────────

export function parseAcpModelId(acpModelId: string): {
  baseId: string;
  parameters: Record<string, string>;
} {
  const open = acpModelId.indexOf("[");
  if (open === -1) return { baseId: acpModelId, parameters: {} };
  const baseId = acpModelId.slice(0, open);
  const inner = acpModelId.slice(open + 1, acpModelId.lastIndexOf("]"));
  const parameters: Record<string, string> = {};
  for (const pair of inner.split(",")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    parameters[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { baseId, parameters };
}

function findAvailableModels(node: unknown): unknown[] | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAvailableModels(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.availableModels)) return rec.availableModels;
    for (const value of Object.values(rec)) {
      const found = findAvailableModels(value);
      if (found) return found;
    }
  }
  return null;
}

export function parseAdvertisedModels(raw: unknown[]): CursorAcpModel[] {
  const models: CursorAcpModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const acpModelId = typeof rec.modelId === "string" ? rec.modelId : "";
    if (!acpModelId || seen.has(acpModelId)) continue;
    seen.add(acpModelId);
    const { baseId, parameters } = parseAcpModelId(acpModelId);
    models.push({
      acpModelId,
      baseId,
      parameters,
      name: typeof rec.name === "string" && rec.name ? rec.name : baseId,
    });
  }
  return models;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Spawn acpx, read frames until the advertised list arrives, then kill.
 *
 * ACP returns `availableModels` in the `session/new` RESULT, which lands before
 * generation starts, so this costs no completion. `acpx cursor sessions new`
 * cannot serve the same purpose: it performs the handshake but prints only its
 * own record, and the frame log under ~/.acpx/sessions/ is not written until a
 * prompt actually runs.
 */
function spawnDiscovery(timeoutMs: number, signal?: AbortSignal | null): Promise<CursorAcpModel[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveAcpxBin(), buildCursorAcpArgs(null, resolveCursorAcpCwd()), {
        env: cursorAcpChildEnv(),
        stdio: ["pipe", "pipe", "ignore"],
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    const settle = (models: CursorAcpModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!child.killed) child.kill("SIGKILL");
      resolve(models);
    };
    const onAbort = () => settle([]);
    const timer = setTimeout(() => settle([]), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        settle([]);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdin?.on("error", () => {});
    try {
      child.stdin?.write("x");
      child.stdin?.end();
    } catch {
      /* ignore — close/error handlers settle */
    }

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line || !line.includes("availableModels")) continue;
        try {
          const advertised = findAvailableModels(JSON.parse(line));
          if (advertised) {
            settle(parseAdvertisedModels(advertised));
            return;
          }
        } catch {
          /* partial or non-JSON line — keep reading */
        }
      }
    });

    child.on("error", () => settle([]));
    child.on("close", () => settle([]));
  });
}

export async function getCursorAcpModels(options?: {
  signal?: AbortSignal | null;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<CursorAcpModel[]> {
  const now = Date.now();
  if (!options?.forceRefresh && cache && now - cache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cache.models;
  }
  if (inFlight) return inFlight;

  inFlight = spawnDiscovery(options?.timeoutMs ?? DISCOVERY_TIMEOUT_MS, options?.signal)
    .then((models) => {
      if (models.length > 0) cache = { models, fetchedAt: Date.now() };
      return models;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

// ─── Model selection ─────────────────────────────────────────────────────────

export type CursorAcpModelResolution =
  { ok: true; acpModelId: string } | { ok: false; error: string };

/** `strictNullChecks: false` needs an explicit predicate to narrow the false branch. */
export function isCursorAcpModelFailure(
  resolution: CursorAcpModelResolution
): resolution is Extract<CursorAcpModelResolution, { ok: false }> {
  return !resolution.ok;
}

/**
 * Map a client model id onto an advertised ACP id.
 *
 * Decomposition is delegated to `resolveRequestedModel` so ACP and the protobuf
 * wire agree on what a model id means — including `auto` -> `default`, which is
 * why no auto-specific branch appears here.
 *
 * The resolved value is forwarded into a child-process argv, so a leading "-"
 * is rejected outright: acpx would otherwise parse it as a flag.
 */
export function resolveCursorAcpModel(
  model: unknown,
  advertised: CursorAcpModel[]
): CursorAcpModelResolution {
  const requested = typeof model === "string" ? model.trim() : "";

  if (advertised.length === 0) {
    return {
      ok: false,
      error:
        "Cursor ACP transport could not read the agent's model list. Check that `acpx` is on " +
        "PATH and the Cursor agent CLI is installed and authenticated (`cursor-agent status`).",
    };
  }
  if (requested.startsWith("-")) {
    return { ok: false, error: `Invalid Cursor model "${requested}": must not start with "-".` };
  }

  // An exact advertised id passes straight through.
  const exact = advertised.find((m) => m.acpModelId === requested);
  if (exact) return { ok: true, acpModelId: exact.acpModelId };

  if (!requested) return { ok: true, acpModelId: advertised[0].acpModelId };

  const { modelId: baseId, parameters } = resolveRequestedModel(requested);
  const candidate = advertised.find((m) => m.baseId === baseId);
  if (!candidate) {
    return {
      ok: false,
      error:
        `Cursor model "${requested}" is not available over the ACP transport. ` +
        `The agent advertises: ${advertised.map((m) => m.baseId).join(", ")}.`,
    };
  }

  // The agent accepts only its advertised parameterisation (ACP -32602
  // otherwise), so a differing request is an error rather than a silent
  // downgrade — effort is a quality and cost dimension.
  for (const param of parameters) {
    const advertisedValue = candidate.parameters[param.id];
    if (advertisedValue !== undefined && advertisedValue !== param.value) {
      return {
        ok: false,
        error:
          `Cursor model "${requested}" requests ${param.id}=${param.value}, but the agent only ` +
          `advertises ${param.id}=${advertisedValue} for ${baseId} over ACP ` +
          `(${candidate.acpModelId}). Use that model, or route this connection over the HTTP ` +
          `transport, which can carry arbitrary ${param.id} values.`,
      };
    }
  }

  return { ok: true, acpModelId: candidate.acpModelId };
}

// ─── argv ────────────────────────────────────────────────────────────────────

/**
 * Build the acpx argv. `acpModelId` MUST already be validated against the live
 * advertised list. The capability flags are load-bearing security settings:
 * ACP is an agent protocol, so at its defaults the agent reads files and runs
 * shell commands on the router host under third-party prompt text. A
 * chat-completions endpoint must expose it as a model, not an agent.
 */
export function buildCursorAcpArgs(acpModelId: string | null, cwd: string): string[] {
  return [
    "--deny-all",
    "--no-fs",
    "--no-terminal",
    "--allowed-tools",
    "",
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    cwd,
    ...(acpModelId ? ["--model", acpModelId] : []),
    "cursor",
    "exec",
    "-f",
    "-",
  ];
}

/** Test seam — drop the cached catalog. */
export function __resetCursorAcpModelCache(): void {
  cache = null;
  inFlight = null;
}
