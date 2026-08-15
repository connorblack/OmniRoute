/**
 * cursorCliModels — live model discovery for the `cursor-cli` provider.
 *
 * There is deliberately NO static model catalog here. Cursor's model lineup
 * changes without a CLI release, and the routable set is account-scoped
 * ("List available models for this account"), so any hardcoded list is wrong
 * for somebody the day it ships. The catalog is always read from the live
 * agent.
 *
 * ── Which id namespace, and why it matters ──────────────────────────────────
 * Cursor exposes the same models under two different id namespaces:
 *
 *   `cursor-agent models`   → suffix form, e.g. `claude-sonnet-5-thinking-high`
 *   ACP `session/new`       → bracket form, e.g.
 *                             `claude-sonnet-5[thinking=true,context=300k,effort=high]`
 *
 * acpx validates `--model` against the ACP-advertised list only, so the suffix
 * namespace is NOT routable through acpx even though `cursor-agent` prints it.
 * Discovery therefore reads the ACP list — the one that can actually be routed
 * — rather than the larger, more tempting `cursor-agent models` output.
 *
 * acpx resolves a bare base name against the advertised ids by prefix
 * (`claude-sonnet-5` → `claude-sonnet-5[...]`) when exactly one advertised id
 * matches, so we expose the base name as the OmniRoute-facing model id and let
 * acpx bind the parameters. Fully-qualified bracket ids are accepted too.
 *
 * ── Why discovery is cheap ──────────────────────────────────────────────────
 * ACP advertises `availableModels` in the `session/new` RESULT, which arrives
 * before any generation starts. We stream acpx's JSON-RPC frames, take the
 * model list, and kill the child immediately — no completion is billed.
 * Measured at ~1.9s cold on macOS.
 *
 * `acpx cursor sessions new` is not usable for this: it performs the handshake
 * but prints only its own session record, and the frame log under
 * ~/.acpx/sessions/ is not written until a prompt actually runs.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export type CursorCliModel = {
  /** OmniRoute-facing id — the bare base name, e.g. `claude-sonnet-5`. */
  id: string;
  /** Fully-qualified ACP id, e.g. `claude-sonnet-5[thinking=true,...]`. */
  acpModelId: string;
  /** Display name as advertised by the agent. */
  name: string;
  /** Parsed from a `context=300k` bracket param when present. */
  contextLength?: number;
};

/** Live models are cached for this long before a refresh is attempted. */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 30_000;

type CacheEntry = { models: CursorCliModel[]; fetchedAt: number };

let cache: CacheEntry | null = null;
/** De-dupes concurrent discovery so a burst of requests spawns one acpx. */
let inFlight: Promise<CursorCliModel[]> | null = null;

// ─── Binary discovery ────────────────────────────────────────────────────────

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
 * Environment for the spawned agent.
 *
 * cursor-agent resolves its credential per-platform:
 *   darwin  ~/.cursor/auth.json      (only when the file store is selected;
 *                                     the default there is the macOS keychain)
 *   linux   ${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json
 *   win32   %APPDATA%/Cursor/auth.json
 *
 * In a container the credential is mounted from the host, which usually means
 * it does NOT sit under the container user's `$HOME`. `XDG_CONFIG_HOME` is the
 * documented lever, but setting it globally on the container would also
 * relocate every other CLI's config (codex, claude, droid, openclaw all read
 * from the shared config home), so it is scoped to this child process via
 * `CURSOR_CLI_CONFIG_HOME`.
 *
 * `AGENT_CLI_CREDENTIAL_STORE` is passed through untouched rather than
 * defaulted: forcing `file` would break a macOS developer running OmniRoute
 * locally, where the working credential lives in the keychain. Containers set
 * it explicitly (see docs/providers/CURSOR-CLI.md).
 */
export function cursorCliChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const configHome = (process.env.CURSOR_CLI_CONFIG_HOME || "").trim();
  if (configHome) env.XDG_CONFIG_HOME = configHome;
  return env;
}

/**
 * A neutral, non-repo working directory for the agent.
 *
 * cursor-agent loads AGENTS.md / rules / skills from its cwd, so running it
 * inside a checkout silently prepends that repo's instructions to every
 * completion (observed: an unrelated skill's text leaking into a one-word
 * answer). A router must be context-free, so every spawn — discovery and
 * execution alike — is pinned to an empty scratch directory.
 */
export function resolveCursorCliCwd(): string {
  const configured = (process.env.CURSOR_CLI_CWD || "").trim();
  const dir = configured || path.join(os.tmpdir(), "omniroute-cursor-cli");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort — spawn surfaces a real failure */
  }
  return dir;
}

// ─── Frame parsing ───────────────────────────────────────────────────────────

/** Depth-first search for the first `availableModels` array in a JSON-RPC frame. */
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

/** `claude-sonnet-5[thinking=true,context=300k]` → `claude-sonnet-5`. */
export function baseModelId(acpModelId: string): string {
  const idx = acpModelId.indexOf("[");
  return idx === -1 ? acpModelId : acpModelId.slice(0, idx);
}

/** Read `context=300k` / `context=272k` / `context=1m` out of the bracket params. */
export function parseContextLength(acpModelId: string): number | undefined {
  const match = acpModelId.match(/context=(\d+(?:\.\d+)?)(k|m)?/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] || "").toLowerCase();
  if (unit === "m") return Math.round(value * 1_000_000);
  if (unit === "k") return Math.round(value * 1000);
  return Math.round(value);
}

export function parseAdvertisedModels(raw: unknown[]): CursorCliModel[] {
  const models: CursorCliModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const acpModelId = typeof rec.modelId === "string" ? rec.modelId : "";
    if (!acpModelId) continue;
    const id = baseModelId(acpModelId);
    // `default[]` is cursor's "Auto" router. Its base name is `default`, which
    // is meaningless as a routing id and collides with OmniRoute's own default
    // handling, so expose it under a stable, explicit name.
    const exposedId = id === "default" ? "auto" : id;
    if (!exposedId || seen.has(exposedId)) continue;
    seen.add(exposedId);
    const contextLength = parseContextLength(acpModelId);
    models.push({
      id: exposedId,
      acpModelId,
      name: typeof rec.name === "string" && rec.name ? rec.name : exposedId,
      ...(contextLength ? { contextLength } : {}),
    });
  }
  return models;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Spawn acpx, read frames until the advertised model list arrives, then kill.
 *
 * The prompt is a single character that is never generated against: we abort as
 * soon as `session/new` returns, which is strictly before generation starts.
 */
function spawnDiscovery(timeoutMs: number, signal?: AbortSignal | null): Promise<CursorCliModel[]> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        resolveAcpxBin(),
        [
          "--deny-all",
          "--no-fs",
          "--no-terminal",
          "--allowed-tools",
          "",
          "--format",
          "json",
          "--json-strict",
          "--cwd",
          resolveCursorCliCwd(),
          "cursor",
          "exec",
          "-f",
          "-",
        ],
        {
          env: cursorCliChildEnv(),
          stdio: ["pipe", "pipe", "ignore"],
          shell: process.platform === "win32",
          windowsHide: true,
        }
      );
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    const settle = (models: CursorCliModel[]) => {
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

    // A fast-exiting child turns the stdin write into an async EPIPE 'error'
    // event rather than a sync throw, so it must be handled or it crashes the
    // process.
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

/**
 * Return the live model catalog, using a short TTL cache.
 *
 * A failed discovery caches an empty result only for the duration of the
 * in-flight promise — it is retried on the next request rather than poisoning
 * the cache, since the usual cause (agent not yet authenticated) is transient.
 */
export async function getCursorCliModels(options?: {
  signal?: AbortSignal | null;
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<CursorCliModel[]> {
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

export type CursorCliModelResolution =
  | {
      ok: true;
      /** Exact advertised ACP id to place in the acpx argv. */
      acpModelId: string;
      /** OmniRoute-facing id, echoed back to the client in the response. */
      id: string;
    }
  | { ok: false; error: string };

/**
 * `strictNullChecks: false` in this workspace means a boolean-literal
 * discriminant narrows the positive branch but not the negative one, so
 * `!r.ok` alone leaves the full union. An explicit predicate narrows properly.
 */
export function isCursorCliModelFailure(
  resolution: CursorCliModelResolution
): resolution is Extract<CursorCliModelResolution, { ok: false }> {
  return !resolution.ok;
}

/**
 * Validate the requested model against the LIVE advertised list and return the
 * exact advertised ACP id to place in the acpx argv.
 *
 * This is the argument-injection boundary: the resolved value is forwarded into
 * a child process argv, so nothing that is not an exact match for a discovered
 * model may pass. A leading "-" is rejected outright so a model name can never
 * be reinterpreted by acpx as a flag.
 *
 * We always hand acpx the fully-qualified advertised id rather than the bare
 * base name. acpx *can* resolve a base name by prefix, but only when exactly
 * one advertised id matches — and it does not help at all for cursor's "Auto"
 * router, advertised as `default[]` and exposed here as `auto`, where no
 * `auto[` prefix exists. Passing the exact id sidesteps both cases.
 */
export function resolveCursorCliModel(
  model: unknown,
  models: CursorCliModel[]
): CursorCliModelResolution {
  const requested = typeof model === "string" ? model.trim() : "";

  if (models.length === 0) {
    return {
      ok: false,
      error:
        "Cursor CLI model discovery returned no models. Check that the cursor-agent CLI is " +
        "installed and authenticated (`cursor-agent status`), and that acpx is on PATH.",
    };
  }

  if (!requested) {
    return { ok: true, acpModelId: models[0].acpModelId, id: models[0].id };
  }

  if (requested.startsWith("-")) {
    return {
      ok: false,
      error: `Invalid Cursor CLI model "${requested}": model must not start with "-".`,
    };
  }

  for (const candidate of models) {
    // Accept the OmniRoute-facing base id, the display name, or the
    // fully-qualified ACP id.
    if (
      requested === candidate.id ||
      requested === candidate.name ||
      requested === candidate.acpModelId
    ) {
      return { ok: true, acpModelId: candidate.acpModelId, id: candidate.id };
    }
  }

  return {
    ok: false,
    error:
      `Unknown Cursor CLI model "${requested}". Available models: ` +
      `${models.map((m) => m.id).join(", ")}.`,
  };
}

/** Test seam — drop the cached catalog. */
export function __resetCursorCliModelCache(): void {
  cache = null;
  inFlight = null;
}
