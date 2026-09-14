import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUsageHistory } from "@/lib/usageDb";

function decodeCursor(value: string | null): { timestamp: string; id: number } | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid usage-history cursor");
  const timestamp = Reflect.get(parsed, "timestamp");
  const id = Reflect.get(parsed, "id");
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("Invalid usage-history cursor");
  }
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("Invalid usage-history cursor");
  }
  return { timestamp, id };
}

function encodeCursor(row: { timestamp: string | null; id: number }): string {
  return Buffer.from(JSON.stringify({ timestamp: row.timestamp, id: row.id })).toString(
    "base64url"
  );
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      5000,
      Math.max(1, Number.parseInt(searchParams.get("limit") || "100", 10) || 100)
    );
    let cursor: ReturnType<typeof decodeCursor>;
    try {
      cursor = decodeCursor(searchParams.get("cursor"));
    } catch {
      return NextResponse.json({ error: "Invalid usage-history cursor" }, { status: 400 });
    }
    const rows = await getUsageHistory({
      provider: searchParams.get("provider") || undefined,
      model: searchParams.get("model") || undefined,
      startDate: searchParams.get("startDate") || undefined,
      endDate: searchParams.get("endDate") || undefined,
      beforeTimestamp: cursor?.timestamp,
      beforeId: cursor?.id,
      limit: limit + 1,
      sortOrder: "desc",
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last?.timestamp ? encodeCursor(last) : null;
    return NextResponse.json({ items, nextCursor });
  } catch (error) {
    console.error("Error fetching usage history:", error);
    return NextResponse.json({ error: "Failed to fetch usage history" }, { status: 500 });
  }
}
