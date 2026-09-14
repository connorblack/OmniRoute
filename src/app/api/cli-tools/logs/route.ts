/**
 * CLI Log Stream API — GET /api/cli-tools/logs
 *
 * Reads the application log file and returns matching entries.
 * Called by the CLI `omniroute logs` command via
 * `src/lib/cli-helper/log-streamer.ts`.
 *
 * Query params:
 *   - follow: boolean — kept for forward-compat; ignored in this
 *       implementation (streaming follow-mode is handled client-side
 *       by the log-streamer's ReadableStream).
 *   - filter: comma-separated strings — entries whose `component`,
 *       `module`, or `msg` fields match ANY token are included.
 *       Case-insensitive substring match.
 *   - limit: max number of entries to return — default 500, max 2000.
 *
 * Auth: Tier 3 MANAGEMENT — requireCliToolsAuth (same shared guard as all
 *   other /api/cli-tools/* routes).
 *
 * Note: this route reads logs only and spawns no child processes,
 * so it does NOT require isLocalOnlyPath() classification.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { getAppLogFilePath } from "@/lib/logEnv";
import { requireCliToolsAuth } from "@/lib/api/requireCliToolsAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

// Map pino numeric levels to string levels
const NUMERIC_LEVEL_MAP: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LOG_LEVELS = new Set(Object.values(NUMERIC_LEVEL_MAP));

function parseLevel(raw: string | number): string {
  if (typeof raw === "number") {
    return NUMERIC_LEVEL_MAP[raw] || "info";
  }
  return String(raw).toLowerCase();
}

function stringifyLogValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

/**
 * GET /api/cli-tools/logs
 */
export async function GET(request: NextRequest) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);

    // `follow` is accepted for forward-compat but not used server-side;
    // the CLI's ReadableStream already handles reconnection client-side.
    const _follow = searchParams.get("follow") === "true";

    // Comma-separated filter tokens (e.g. "router,oauth")
    const filterRaw = searchParams.get("filter") || "";
    const filterTokens = filterRaw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const rawLimit = parseInt(searchParams.get("limit") || "500", 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500, 2000);
    const requestIdFilter = searchParams.get("requestId");
    const apiKeyFilter = searchParams.get("apiKey");
    const comboFilter = searchParams.get("combo");
    const statusFilter = searchParams.get("status");
    const durationMin = Number(searchParams.get("durationMin"));
    const durationMax = Number(searchParams.get("durationMax"));
    const hasDurationMin = searchParams.has("durationMin") && Number.isFinite(durationMin);
    const hasDurationMax = searchParams.has("durationMax") && Number.isFinite(durationMax);

    const logPath = getAppLogFilePath();

    if (!existsSync(logPath)) {
      return NextResponse.json([], { status: 200 });
    }

    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const entries: Record<string, unknown>[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;

        // Filter by time (last 1 hour)
        const ts = entry.time || entry.timestamp;
        if (ts) {
          const entryTime = new Date(ts as string | number).getTime();
          if (entryTime < oneHourAgo) continue;
        }

        // Normalize fields
        entry.level = parseLevel(entry.level as string | number);
        entry.msg = stringifyLogValue(entry.msg ?? entry.message ?? "");
        entry.message = stringifyLogValue(entry.message ?? entry.msg);
        if (entry.component !== undefined) entry.component = stringifyLogValue(entry.component);
        if (entry.module !== undefined) entry.module = stringifyLogValue(entry.module);

        // Normalize timestamp field
        if (entry.time && !entry.timestamp) {
          entry.timestamp = entry.time;
        }

        // Apply filter tokens — entry is included if ANY token matches
        // component, module, or msg (case-insensitive substring)
        if (filterTokens.length > 0) {
          const haystack = [
            String(entry.component || ""),
            String(entry.module || ""),
            String(entry.tag || ""),
            String(entry.msg || ""),
          ]
            .join(" ")
            .toLowerCase();

          const matches = filterTokens.some((token) =>
            LOG_LEVELS.has(token) ? entry.level === token : haystack.includes(token)
          );
          if (!matches) continue;
        }

        if (requestIdFilter) {
          const requestIds = [
            entry.requestId,
            entry.request_id,
            entry.correlationId,
            entry.correlation_id,
            entry.traceId,
          ]
            .map(stringifyLogValue)
            .join(" ");
          if (!requestIds.includes(requestIdFilter)) continue;
        }
        if (apiKeyFilter) {
          const apiKeys = [entry.apiKey, entry.api_key, entry.apiKeyId, entry.apiKeyName, entry.key]
            .map(stringifyLogValue)
            .join(" ");
          if (!apiKeys.includes(apiKeyFilter)) continue;
        }
        if (comboFilter) {
          const combos = [entry.combo, entry.comboName, entry.combo_name]
            .map(stringifyLogValue)
            .join(" ");
          if (!combos.includes(comboFilter)) continue;
        }
        if (statusFilter) {
          const status = stringifyLogValue(entry.status ?? entry.statusCode ?? entry.status_code);
          if (!status.startsWith(statusFilter)) continue;
        }
        if (hasDurationMin || hasDurationMax) {
          const duration = Number(
            entry.durationMs ?? entry.duration ?? entry.latencyMs ?? entry.latency
          );
          if (!Number.isFinite(duration)) continue;
          if (hasDurationMin && duration < durationMin) continue;
          if (hasDurationMax && duration > durationMax) continue;
        }

        entries.push(entry);
      } catch {
        // Skip unparseable lines
      }
    }

    // Return last N entries (most recent)
    const result = entries.slice(-limit);

    return NextResponse.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: sanitizeErrorMessage(message) || "Failed to read logs" },
      { status: 500 }
    );
  }
}
