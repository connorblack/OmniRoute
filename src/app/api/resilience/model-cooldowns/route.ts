import { NextResponse } from "next/server";
import { z } from "zod";
import {
  clearModelConnectionUnavailability,
  clearModelUnavailability,
  getAvailabilityReport,
  resetAllAvailability,
} from "@/domain/modelAvailability";
import { getProviderConnections } from "@/lib/db/providers";
import {
  getAntigravityQuotaFamily,
  isAntigravityQuotaProvider,
} from "@omniroute/open-sse/services/antigravityQuotaFamily";
import { getSlowStartStates } from "@omniroute/open-sse/services/slowStartCooldown";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const deleteCooldownSchema = z
  .object({
    provider: z.string().optional(),
    connectionId: z.string().optional(),
    model: z.string().optional(),
    all: z.boolean().optional(),
  })
  .passthrough();

function getErrorMessage(error: unknown, fallback: string): string {
  return sanitizeErrorMessage(error) || fallback;
}

function connectionField(connection: object, key: string): unknown {
  return Reflect.get(connection, key);
}

function connectionLabels(connections: object[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const connection of connections) {
    const id = connectionField(connection, "id");
    if (typeof id !== "string" || !id) continue;
    const name = connectionField(connection, "name");
    const email = connectionField(connection, "email");
    labels.set(
      id,
      typeof name === "string" && name.trim()
        ? name
        : typeof email === "string" && email.trim()
          ? email
          : id
    );
  }
  return labels;
}

function modelFamily(provider: string, model: string): string | null {
  if (model.startsWith("family:")) return model.slice("family:".length) || null;
  if (!isAntigravityQuotaProvider(provider)) return null;
  const family = getAntigravityQuotaFamily(model);
  return family === "other" ? null : family;
}

function accountLabel(labels: Map<string, string>, connectionId: string): string {
  return connectionId === "*" ? "All connections" : (labels.get(connectionId) ?? connectionId);
}

function expiresAt(until: number | null): string | null {
  return until !== null && Number.isFinite(until) ? new Date(until).toISOString() : null;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const connections = await getProviderConnections({}, undefined, undefined, [
      "id",
      "name",
      "email",
    ]);
    const labels = connectionLabels(connections);
    const now = Date.now();
    const states = getSlowStartStates(now);
    const stateByScope = new Map(
      states.map((state) => [
        `${state.provider}\u001f${state.connectionId}\u001f${state.model}`,
        state,
      ])
    );
    const items = getAvailabilityReport()
      .map((item) => ({
        ...item,
        lockedAtMs: item.lockedAt,
        lockedAt: new Date(item.lockedAt).toISOString(),
        accountLabel: accountLabel(labels, item.connectionId),
        modelFamily: modelFamily(item.provider, item.model),
        expiresAt: expiresAt(item.until),
        slowStartState:
          stateByScope.get(`${item.provider}\u001f${item.connectionId}\u001f${item.model}`) ?? null,
      }))
      .sort((a, b) => b.remainingMs - a.remainingMs);
    const slowStartStates = states.map((state) => ({
      ...state,
      accountLabel: accountLabel(labels, state.connectionId),
      modelFamily: modelFamily(state.provider, state.model),
      cooldownRemainingMs:
        state.cooldownUntil === null ? 0 : Math.max(0, state.cooldownUntil - now),
      expiresAt: expiresAt(state.cooldownUntil),
    }));
    return NextResponse.json({ items, slowStartStates });
  } catch (error: unknown) {
    console.error("[API] GET /api/resilience/model-cooldowns error:", error);
    return NextResponse.json(
      { error: getErrorMessage(error, "Failed to load cooldowns") },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const rawBody = await request.json().catch(() => ({}));
    const validation = validateBody(deleteCooldownSchema, rawBody);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;

    if (body.all) {
      resetAllAvailability();
      return NextResponse.json({ ok: true, clearedAll: true });
    }

    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!provider || !model) {
      return NextResponse.json({ error: "provider and model are required" }, { status: 400 });
    }

    const removed = connectionId
      ? clearModelConnectionUnavailability(provider, connectionId, model)
      : clearModelUnavailability(provider, model);
    return NextResponse.json({
      ok: true,
      removed,
      scope: connectionId ? "connection-model" : "provider-model",
    });
  } catch (error: unknown) {
    console.error("[API] DELETE /api/resilience/model-cooldowns error:", error);
    return NextResponse.json(
      { error: getErrorMessage(error, "Failed to clear cooldown") },
      { status: 500 }
    );
  }
}
