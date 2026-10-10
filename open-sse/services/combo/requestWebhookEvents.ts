/**
 * Webhook fan-out for request outcomes. Every dispatch path (the combo attempt loop, round-robin,
 * nested runtime units and direct model calls) sends `request.completed` / `request.failed`
 * through these functions so the payload shape stays identical across them.
 */
import { notifyWebhookEvent } from "../../../src/lib/webhookDispatcher.ts";
import type { ComboNestingContext } from "./types.ts";

export type RequestCompletedInput = {
  /** Combo that served the request; empty for a direct (non-combo) model call. */
  combo: string;
  provider: string;
  model: string;
  /** Operator-facing account label of the target, when it has one. */
  label?: unknown;
  connectionId?: string | null;
  latencyMs: number;
  fallbackCount: number;
};

export type RequestFailedInput = {
  /** Combo that failed; empty for a direct (non-combo) model call. */
  combo: string;
  reason: string;
  latencyMs: number;
  fallbackCount: number;
  /**
   * A combo running as a nested combo reference does not own the request: its parent can still
   * serve it from the next unit. Only the outermost combo reports the failure.
   */
  nesting?: ComboNestingContext | null;
};

export function failureReasonForStatus(status: number): string {
  return `HTTP_${status}`;
}

/** Best-effort and non-blocking: safe to call on the response path. */
export function notifyRequestCompleted(input: RequestCompletedInput): void {
  notifyWebhookEvent("request.completed", {
    combo: input.combo,
    provider: input.provider,
    model: input.model,
    account:
      typeof input.label === "string" && input.label.trim().length > 0 ? input.label.trim() : "",
    accountId: input.connectionId ?? "",
    latencyMs: input.latencyMs,
    fallbackCount: input.fallbackCount,
  });
}

/** Best-effort and non-blocking: safe to call on the response path. */
export function notifyRequestFailed(input: RequestFailedInput): void {
  if (input.nesting && input.nesting.depth > 0) return;
  notifyWebhookEvent("request.failed", {
    combo: input.combo,
    reason: input.reason,
    latencyMs: input.latencyMs,
    fallbackCount: input.fallbackCount,
  });
}
