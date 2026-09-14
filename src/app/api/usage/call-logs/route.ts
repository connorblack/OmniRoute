import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCallLogs } from "@/lib/usageDb";
import { getCompletedDetails, getPendingById } from "@/lib/usage/usageHistory";
import { getProviderConnections } from "@/lib/db/providers";
import { getProviderNodes } from "@/models";
import { matchesSearch } from "@/shared/utils/turkishText";

type CallLogListRowsInput = {
  logs: any[];
  connections: any[];
  providerDisplayNames?: Map<string, string>;
  pendingDetails: Iterable<any>;
  completedDetails: Iterable<any>;
  now?: number;
};

type CallLogCursor = {
  timestamp: string;
  id: string;
};

function compareCallLogRows(a: any, b: any): number {
  const priority = rowPriority(a) - rowPriority(b);
  if (priority !== 0) return priority;
  const timestamp = rowTimestampMs(b) - rowTimestampMs(a);
  if (timestamp !== 0) return timestamp;
  return String(b?.id || "").localeCompare(String(a?.id || ""));
}

export function encodeCallLogCursor(cursor: CallLogCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCallLogCursor(value: string): CallLogCursor {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).timestamp !== "string" ||
    !Number.isFinite(Date.parse((parsed as Record<string, string>).timestamp)) ||
    typeof (parsed as Record<string, unknown>).id !== "string" ||
    !(parsed as Record<string, string>).id
  ) {
    throw new Error("Invalid call-log cursor");
  }
  return {
    timestamp: (parsed as Record<string, string>).timestamp,
    id: (parsed as Record<string, string>).id,
  };
}

export function finalizeCallLogPage(rows: any[], limit: number) {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 200;
  const ordered = [...rows].sort(compareCallLogRows);
  const items = ordered.slice(0, boundedLimit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      ordered.length > boundedLimit && last
        ? encodeCallLogCursor({ timestamp: String(last.timestamp), id: String(last.id) })
        : null,
  };
}

function rowTimestampMs(row: any): number {
  const value = Date.parse(String(row?.timestamp || ""));
  return Number.isFinite(value) ? value : 0;
}

function rowPriority(row: any): number {
  if (row?.active) return 0;
  if (row?.completed) return 1;
  return 2;
}

/**
 * Applies the active filter predicates to a single merged call-log row.
 *
 * `getCallLogs()` already filters the persisted DB rows server-side, but the
 * in-memory entries (active/pending + recently-completed) are merged in by
 * `buildCallLogListRows()` and would otherwise bypass every filter except
 * `correlationId`. Running the same predicates over the merged rows closes that
 * gap. It is idempotent for DB rows (they already satisfy the predicate) while
 * correctly excluding in-memory rows that do not match.
 *
 * That idempotence is the contract, and it is only worth as much as the two
 * predicates agree: a row the SQL WHERE accepted must survive this function, so
 * every clause here has to be at least as wide as its counterpart in
 * `buildCallLogFilterSql()` (src/lib/usage/callLogs.ts). Where it was narrower,
 * the query returned the right rows and this pass deleted them again with nothing
 * logged -- see the apiKey and combo clauses below.
 */
export function rowMatchesFilter(row: any, filter: Record<string, any>): boolean {
  if (!filter) return true;

  if (filter.status === "error") {
    if (!(Number(row?.status) >= 400 || Boolean(row?.error))) return false;
  } else if (filter.status === "ok") {
    if (!(Number(row?.status) >= 200 && Number(row?.status) < 300)) return false;
  } else if (
    typeof filter.status === "number" ||
    (typeof filter.status === "string" && !isNaN(Number(filter.status)))
  ) {
    if (Number(row?.status) !== Number(filter.status)) return false;
  }

  if (
    filter.model &&
    !matchesSearch(row?.model || "", String(filter.model)) &&
    !matchesSearch(row?.requestedModel || "", String(filter.model))
  ) {
    return false;
  }
  if (filter.provider && !matchesSearch(row?.provider || "", String(filter.provider))) {
    return false;
  }
  if (filter.account && !matchesSearch(row?.account || "", String(filter.account))) {
    return false;
  }
  if (
    filter.apiKey &&
    !matchesSearch(row?.apiKeyName || "", String(filter.apiKey)) &&
    !matchesSearch(row?.apiKeyId || "", String(filter.apiKey))
  ) {
    return false;
  }
  if (filter.combo) {
    // Mirror buildCallLogFilterSql(): "1"/true is the presence sentinel (any
    // combo assigned), any other value is an exact combo name match.
    if (filter.combo === "1" || filter.combo === true) {
      if (row?.comboName == null) return false;
    } else if (String(row?.comboName ?? "") !== String(filter.combo)) {
      return false;
    }
  }
  if (
    filter.correlationId &&
    !matchesSearch(row?.correlationId || "", String(filter.correlationId))
  ) {
    return false;
  }
  if (filter.search) {
    const term = String(filter.search);
    const haystack = [
      row?.model,
      row?.requestedModel,
      row?.provider,
      row?.providerDisplay,
      row?.account,
      row?.apiKeyName,
      row?.apiKeyId,
      row?.comboName,
      row?.comboStepId,
      row?.comboExecutionKey,
      row?.correlationId,
      row?.error,
      row?.path,
      row?.status == null ? null : String(row.status),
    ]
      .filter(Boolean)
      .join(" ");
    if (!matchesSearch(haystack, term)) return false;
  }

  return true;
}

export function buildCallLogListRows({
  logs,
  connections,
  providerDisplayNames = new Map<string, string>(),
  pendingDetails,
  completedDetails,
  now = Date.now(),
}: CallLogListRowsInput): any[] {
  const connectionNames = new Map(
    connections.map((connection: any) => [
      connection.id,
      connection.displayName || connection.name || connection.email || connection.id,
    ])
  );
  const getProviderDisplay = (providerId: unknown): string | null => {
    if (typeof providerId !== "string" || providerId.length === 0) return null;
    return providerDisplayNames.get(providerId) || null;
  };

  // Include active (in-flight) requests from the pending-by-id map
  // so they appear in the logs grid alongside persisted entries.
  const activeEntries: any[] = [];
  const persistedIds = new Set(logs.map((log: any) => log.id).filter(Boolean));

  for (const detail of pendingDetails) {
    if (persistedIds.has(detail.id)) continue;
    activeEntries.push({
      id: detail.id,
      timestamp: new Date(detail.startedAt).toISOString(),
      method: "",
      path: detail.clientEndpoint || "",
      status: 0,
      model: detail.model,
      requestedModel: null,
      provider: detail.provider,
      providerDisplay: getProviderDisplay(detail.provider),
      account: connectionNames.get(detail.connectionId || "") || detail.connectionId || "unknown",
      connectionId: detail.connectionId,
      duration: Math.max(0, now - detail.startedAt),
      tokens: { in: 0, out: 0 },
      cacheSource: null,
      sourceFormat: null,
      targetFormat: null,
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      error: null,
      correlationId: detail.correlationId || null,
      active: true,
    });
  }

  const pendingIds = new Set(activeEntries.map((entry) => entry.id));
  const completedEntries: any[] = [];
  for (const detail of completedDetails) {
    if (persistedIds.has(detail.id) || pendingIds.has(detail.id)) continue;
    const completedAt = typeof detail.completedAt === "number" ? detail.completedAt : null;
    const duration =
      typeof detail.durationMs === "number" && Number.isFinite(detail.durationMs)
        ? detail.durationMs
        : Math.max(0, (completedAt ?? now) - detail.startedAt);
    completedEntries.push({
      id: detail.id,
      timestamp: new Date(detail.startedAt).toISOString(),
      method: "",
      path: detail.clientEndpoint || "",
      status: typeof detail.status === "number" ? detail.status : detail.error ? 502 : 200,
      model: detail.model,
      requestedModel: null,
      provider: detail.provider,
      providerDisplay: getProviderDisplay(detail.provider),
      account: connectionNames.get(detail.connectionId || "") || detail.connectionId || "unknown",
      connectionId: detail.connectionId,
      duration,
      tokens: { in: 0, out: 0 },
      cacheSource: null,
      sourceFormat: null,
      targetFormat: null,
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      error: detail.error || null,
      correlationId: detail.correlationId || null,
      active: false,
      completed: true,
      completedAt: completedAt ? new Date(completedAt).toISOString() : null,
      detailState: "in-memory",
    });
  }

  return [...activeEntries, ...completedEntries, ...logs].sort(compareCallLogRows);
}

export async function GET(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;

    const { searchParams } = new URL(request.url);

    const filter: Record<string, any> = {};
    if (searchParams.get("status")) filter.status = searchParams.get("status");
    if (searchParams.get("model")) filter.model = searchParams.get("model");
    if (searchParams.get("provider")) filter.provider = searchParams.get("provider");
    if (searchParams.get("account")) filter.account = searchParams.get("account");
    if (searchParams.get("apiKey")) filter.apiKey = searchParams.get("apiKey");
    if (searchParams.get("combo")) filter.combo = searchParams.get("combo");
    if (searchParams.get("search")) filter.search = searchParams.get("search");
    if (searchParams.get("correlationId")) filter.correlationId = searchParams.get("correlationId");
    const requestedLimit = Math.min(
      5000,
      Math.max(1, Number.parseInt(searchParams.get("limit") || "200", 10) || 200)
    );
    const cursorValue = searchParams.get("cursor");
    const includeActive = searchParams.get("includeActive") === "1";
    if (cursorValue && includeActive) {
      return NextResponse.json(
        { error: "Cursor pagination does not include active requests" },
        { status: 400 }
      );
    }
    if (cursorValue) {
      try {
        const cursor = decodeCallLogCursor(cursorValue);
        filter.beforeTimestamp = cursor.timestamp;
        filter.beforeId = cursor.id;
      } catch {
        return NextResponse.json({ error: "Invalid call-log cursor" }, { status: 400 });
      }
    } else if (searchParams.get("offset")) {
      filter.offset = Number.parseInt(searchParams.get("offset") || "0", 10);
    }
    filter.limit = requestedLimit + 1;
    if (searchParams.get("excludeTests") === "1") filter.excludeTests = true;

    const [logs, connections, providerNodes] = await Promise.all([
      getCallLogs(filter),
      getProviderConnections(),
      getProviderNodes(),
    ]);
    const providerDisplayNames = new Map<string, string>(
      (Array.isArray(providerNodes) ? providerNodes : []).flatMap((node: any) => {
        if (typeof node?.id !== "string" || node.id.length === 0) return [];
        const label =
          (typeof node?.name === "string" && node.name.trim().length > 0
            ? node.name.trim()
            : typeof node?.prefix === "string" && node.prefix.trim().length > 0
              ? node.prefix.trim()
              : "") || null;
        return label ? [[node.id, label] as const] : [];
      })
    );

    const rows = buildCallLogListRows({
      logs,
      connections,
      providerDisplayNames,
      pendingDetails: includeActive ? getPendingById().values() : [],
      completedDetails: includeActive ? getCompletedDetails().values() : [],
    });

    const filtered = rows.filter((row: any) => rowMatchesFilter(row, filter));
    const page = finalizeCallLogPage(filtered, requestedLimit);
    return NextResponse.json(page.items, {
      headers: page.nextCursor ? { "x-omniroute-next-cursor": page.nextCursor } : undefined,
    });
  } catch (error) {
    console.error("[API ERROR] /api/usage/call-logs failed:", error);
    return NextResponse.json({ error: "Failed to fetch call logs" }, { status: 500 });
  }
}
