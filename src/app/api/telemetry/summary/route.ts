import { NextResponse } from "next/server";
import { buildTelemetryPayload } from "@/lib/monitoring/observability";
import { getTelemetryEvents, getTelemetrySummary } from "@/shared/utils/requestTelemetry";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

function parseWindowMs(searchParams: URLSearchParams): number {
  const explicit = Number.parseInt(searchParams.get("windowMs") || "", 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(searchParams.get("period") || "");
  if (!match) return 300000;
  const value = Number(match[1]);
  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return value * multiplier;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const windowMs = parseWindowMs(searchParams);
    if (searchParams.get("format") === "jsonl") {
      const events = getTelemetryEvents(windowMs);
      const body = events.map((event) => JSON.stringify(event)).join("\n");
      return new Response(body ? `${body}\n` : "", {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "x-omniroute-event-count": String(events.length),
        },
      });
    }

    const summary = getTelemetrySummary(windowMs);
    const { getQuotaMonitorSummary } = await import("@omniroute/open-sse/services/quotaMonitor.ts");
    const { getActiveSessions } = await import("@omniroute/open-sse/services/sessionManager.ts");
    const quotaMonitorSummary = getQuotaMonitorSummary();
    const activeSessions = getActiveSessions();
    const payload = buildTelemetryPayload({
      summary,
      quotaMonitorSummary,
      activeSessions,
    });
    const totalRequests = payload.totalRequests || 0;
    return NextResponse.json({
      ...payload,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      activeConnections: activeSessions.length,
      errorRate:
        totalRequests > 0 ? (quotaMonitorSummary.errors / Math.max(totalRequests, 1)) * 100 : 0,
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
