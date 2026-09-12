/**
 * Mux (coder/mux) installer adapter for the ServiceSupervisor framework.
 *
 * Mux (https://github.com/coder/mux) is a local agent-orchestration daemon
 * ("AI agent orchestration") published on npm as the `mux` package, with a
 * documented headless server mode: `mux server --host <host> --port <port>`.
 * It is installed the same way as 9Router — `npm install` into a
 * DATA_DIR-scoped directory via `runNpm` (Hard Rule #13: no shell
 * interpolation, array args + `env` option only) — never a git-clone+build.
 *
 * Binary location: resolved from node_modules/mux/package.json's "bin" field
 * (mux@0.28.5+ is a thin compat package — bin: {"mux": "bin/mux.js"} — with no
 * dist/ of its own), falling back to the legacy
 * node_modules/mux/dist/cli/index.js path for older installs.
 * Data dir:         $DATA_DIR/services/mux/data  (MUX_HOME — mux's own state)
 * DB row:            version_manager WHERE tool = 'mux'
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db/core";
import { upsertVersionManagerTool } from "@/lib/db/versionManager";
import { runNpm, InstallError } from "./utils";

export const MUX_PACKAGE = "mux";
export const MUX_DEFAULT_PORT = 8322;
export const MUX_INSTALL_DIR = path.join(DATA_DIR, "services", "mux");

export interface InstallResult {
  installedVersion: string;
  installPath: string;
  durationMs: number;
}

export interface SpawnArgs {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

// In-memory latest-version cache, 1h TTL — mirrors ninerouter.ts.
let latestVersionCache: { value: string; expiresAt: number } | null = null;
const VERSION_CACHE_TTL_MS = 3_600_000;

function getInstalledPkgPath(): string {
  return path.join(MUX_INSTALL_DIR, "node_modules", "mux", "package.json");
}

/**
 * Resolve the mux CLI entry point from its installed package.json "bin"
 * field (string form, or object form under the "mux" key), relative to
 * the package dir. Falls back to the legacy dist/cli/index.js path when
 * package.json is missing or has no usable bin — mux versions before
 * 0.28.5 shipped a real dist/ build with no "bin" entry of their own.
 */
export function resolveMuxBinPath(packageDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { bin?: string | Record<string, string> };
    const bin = pkg.bin;
    const binRelPath =
      typeof bin === "string" ? bin : bin && typeof bin === "object" ? bin.mux : undefined;
    if (typeof binRelPath === "string" && binRelPath.length > 0) {
      return path.join(packageDir, binRelPath);
    }
  } catch {
    // fall through to legacy path
  }
  return path.join(packageDir, "dist", "cli", "index.js");
}

function getServerPath(): string {
  return resolveMuxBinPath(path.join(MUX_INSTALL_DIR, "node_modules", "mux"));
}

export async function getInstalledVersion(): Promise<string | null> {
  try {
    const raw = fs.readFileSync(getInstalledPkgPath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function getLatestVersion(): Promise<string | null> {
  if (latestVersionCache && latestVersionCache.expiresAt > Date.now()) {
    return latestVersionCache.value;
  }
  try {
    const { stdout } = await runNpm(["view", MUX_PACKAGE, "version"], { timeoutMs: 30_000 });
    const version = stdout.trim();
    if (version) {
      latestVersionCache = { value: version, expiresAt: Date.now() + VERSION_CACHE_TTL_MS };
    }
    return version || null;
  } catch {
    return null;
  }
}

/**
 * Download and install Mux from npm.
 * Upserts the version_manager row with tool='mux'.
 */
export async function install(version = "latest"): Promise<InstallResult> {
  const startMs = Date.now();

  // Create install dir + minimal package.json (idempotent) — same shape as ninerouter.ts.
  fs.mkdirSync(MUX_INSTALL_DIR, { recursive: true });
  const hostPkgPath = path.join(MUX_INSTALL_DIR, "package.json");
  if (!fs.existsSync(hostPkgPath)) {
    fs.writeFileSync(
      hostPkgPath,
      JSON.stringify(
        { name: "omniroute-mux-host", version: "0.0.0", private: true, dependencies: {} },
        null,
        2
      ),
      "utf8"
    );
  }

  await runNpm(
    ["install", `${MUX_PACKAGE}@${version}`, "--omit=dev", "--no-audit", "--no-fund"],
    // `--prefix` is passed via `prefix` (→ npm_config_prefix env) instead of an
    // argv path so an install dir with spaces survives the Windows shell (#5379).
    { cwd: MUX_INSTALL_DIR, prefix: MUX_INSTALL_DIR }
  );

  const installedVersion = await getInstalledVersion();
  if (!installedVersion) {
    throw new InstallError(
      "Could not read installed version from node_modules/mux/package.json",
      "Mux instalado mas versão não pôde ser lida.",
      500
    );
  }

  await upsertVersionManagerTool({
    tool: "mux",
    installedVersion,
    binaryPath: getServerPath(),
    status: "stopped",
    port: MUX_DEFAULT_PORT,
  });

  // Invalidate cache so next getLatestVersion() re-fetches
  latestVersionCache = null;

  return {
    installedVersion,
    installPath: MUX_INSTALL_DIR,
    durationMs: Date.now() - startMs,
  };
}

export async function update(): Promise<InstallResult> {
  return install("latest");
}

export async function uninstall(): Promise<void> {
  const nmDir = path.join(MUX_INSTALL_DIR, "node_modules");
  if (fs.existsSync(nmDir)) {
    fs.rmSync(nmDir, { recursive: true, force: true });
  }
  await upsertVersionManagerTool({
    tool: "mux",
    status: "not_installed",
    installedVersion: null,
    binaryPath: null,
  });
}

/**
 * Build spawn args for ServiceSupervisor.start().
 *
 * Mux binds to 127.0.0.1 explicitly (never 0.0.0.0) — the dashboard route is
 * already loopback-gated (Hard Rule #17), and this is defense-in-depth since
 * Mux orchestrates AI agents that can execute shell commands on the host.
 * The bearer token is passed via `MUX_SERVER_AUTH_TOKEN` (mux's documented env
 * form), never as a CLI arg, so it never appears in `ps`/process listings.
 */
export function resolveSpawnArgs(apiKey: string, port: number): SpawnArgs {
  const serverPath = getServerPath();
  // MUX_ROOT is mux's documented override for its home/config/data directory
  // (defaults to ~/.mux otherwise) — scope it under DATA_DIR like every other
  // embedded service instead of leaking into the OS-user home directory.
  const muxRoot = path.join(MUX_INSTALL_DIR, "data");
  fs.mkdirSync(muxRoot, { recursive: true });

  return {
    command: process.execPath,
    args: [serverPath, "server", "--host", "127.0.0.1", "--port", String(port)],
    env: {
      ...process.env,
      NODE_ENV: "production",
      MUX_ROOT: muxRoot,
      MUX_SERVER_AUTH_TOKEN: apiKey,
    },
    cwd: MUX_INSTALL_DIR,
  };
}
