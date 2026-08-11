const os = require("os");
const path = require("path");

const APP_NAME = "omniroute";

function fallbackHomeDir(env) {
  const configuredHome = env.HOME || env.USERPROFILE;
  return typeof configuredHome === "string" && configuredHome.trim()
    ? path.resolve(configuredHome)
    : os.tmpdir();
}

function safeHomeDir(env) {
  try {
    return os.homedir();
  } catch {
    return fallbackHomeDir(env);
  }
}

function normalizeConfiguredPath(dir) {
  if (typeof dir !== "string") return null;
  const trimmed = dir.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

/**
 * Resolve the standalone MITM server's state directory.
 *
 * This mirrors `src/mitm/dataDir.ts`, which the manager uses to generate the
 * server's certificate and target configuration. Keeping the two processes on
 * the same precedence rules prevents the child from looking in legacy
 * `~/.omniroute` while its manager writes to XDG_CONFIG_HOME.
 */
function resolveMitmServerDataDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || safeHomeDir(env);

  const configured = normalizeConfiguredPath(env.DATA_DIR);
  if (configured) return configured;

  if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }

  const xdgConfigHome = normalizeConfiguredPath(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return path.join(xdgConfigHome, APP_NAME);

  return path.join(homeDir, `.${APP_NAME}`);
}

module.exports = { resolveMitmServerDataDir };
