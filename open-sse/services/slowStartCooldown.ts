import { lockExactModel } from "./accountFallback.ts";
import type { SlowStartCooldownSettings } from "../../src/lib/resilience/modelLockoutSettings";

export type AttemptOutcomeSource = "upstream" | "relay" | "local" | "client";

export type SlowStartObservation = {
  kind: "headers";
  provider: string;
  connectionId: string;
  model: string;
  upstreamHeadersMs: number;
  requestToHeadersMs: number;
  upstreamStatus: number;
  outcomeSource: AttemptOutcomeSource;
  upstreamLifecycleStatus: string | null;
  upstreamRequestId: string | null;
};

export type TerminalWithoutHeadersObservation = {
  kind: "terminal_without_headers";
  provider: string;
  connectionId: string;
  model: string;
  upstreamHeadersMs: null;
  requestToHeadersMs: null;
  upstreamStatus: null;
  terminalStatus: number;
  outcomeSource: Exclude<AttemptOutcomeSource, "upstream">;
  upstreamLifecycleStatus: null;
  upstreamRequestId: null;
};

export type AttemptObservation = SlowStartObservation | TerminalWithoutHeadersObservation;

export type SlowStartDecision =
  | { kind: "ignored"; reason: string }
  | { kind: "observed"; slowCount: number }
  | { kind: "cooled"; cooldownMs: number; escalationLevel: number; slowCount: number };

type SlowStartState = {
  provider: string;
  connectionId: string;
  model: string;
  slowObservations: number[];
  escalationLevel: number;
  lastTripAt: number | null;
  cooldownUntil: number | null;
  lastObservationAt: number;
  lastUpstreamHeadersMs: number;
  lastStatus: number;
  lastLifecycleStatus: string | null;
  lastUpstreamRequestId: string | null;
};

const states = new Map<string, SlowStartState>();

function stateKey(provider: string, connectionId: string, model: string): string {
  return `${provider}\u001f${connectionId}\u001f${model}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function classifyAttemptOutcomeSource(input: {
  status: number;
  transport?: string | null;
  upstreamLifecycleStatus?: string | null;
  upstreamRequestId?: string | null;
}): AttemptOutcomeSource {
  if (input.status === 499) return "client";
  if (input.upstreamLifecycleStatus || input.upstreamRequestId) return "upstream";
  if (normalize(input.transport || "") === "relay") return "relay";
  return "local";
}

export type UpstreamHeaderEvent = {
  provider: string;
  connectionId: string;
  model: string;
  requestStartedAt: number;
  upstreamStartedAt: number;
  headersAt: number;
  status: number;
  transport?: string | null;
  upstreamRequestId?: string | null;
  upstreamLifecycleStatus?: string | null;
};

export function observeUpstreamHeaders(
  event: UpstreamHeaderEvent,
  policy: SlowStartCooldownSettings
): { observation: SlowStartObservation; decision: SlowStartDecision } {
  const observation: SlowStartObservation = {
    kind: "headers",
    provider: event.provider,
    connectionId: event.connectionId,
    model: event.model,
    upstreamHeadersMs: Math.max(0, event.headersAt - event.upstreamStartedAt),
    requestToHeadersMs: Math.max(0, event.headersAt - event.requestStartedAt),
    upstreamStatus: event.status,
    outcomeSource: classifyAttemptOutcomeSource(event),
    upstreamRequestId: event.upstreamRequestId || null,
    upstreamLifecycleStatus: event.upstreamLifecycleStatus || null,
  };
  return {
    observation,
    decision: recordSlowStartObservation(observation, policy, event.headersAt),
  };
}

export function observeTerminalWithoutHeaders(event: {
  provider: string;
  connectionId: string;
  model: string;
  terminalStatus: number;
  outcomeSource: Exclude<AttemptOutcomeSource, "upstream">;
}): TerminalWithoutHeadersObservation {
  return {
    kind: "terminal_without_headers",
    provider: event.provider,
    connectionId: event.connectionId,
    model: event.model,
    upstreamHeadersMs: null,
    requestToHeadersMs: null,
    upstreamStatus: null,
    terminalStatus: event.terminalStatus,
    outcomeSource: event.outcomeSource,
    upstreamLifecycleStatus: null,
    upstreamRequestId: null,
  };
}

function pruneObservations(
  state: SlowStartState,
  policy: SlowStartCooldownSettings,
  nowMs: number
) {
  const cutoff = nowMs - policy.observationWindowMs;
  state.slowObservations = state.slowObservations.filter((observedAt) => observedAt >= cutoff);
  if (
    state.lastTripAt !== null &&
    nowMs - state.lastTripAt > policy.observationWindowMs + Math.max(...policy.cooldownStepsMs)
  ) {
    state.escalationLevel = 0;
    state.lastTripAt = null;
  }
  if (state.cooldownUntil !== null && state.cooldownUntil <= nowMs) state.cooldownUntil = null;
}

export function recordSlowStartObservation(
  observation: SlowStartObservation,
  policy: SlowStartCooldownSettings,
  nowMs = Date.now()
): SlowStartDecision {
  if (!policy.enabled) return { kind: "ignored", reason: "disabled" };
  if (observation.outcomeSource !== "upstream") {
    return { kind: "ignored", reason: `outcome_source:${observation.outcomeSource}` };
  }

  const provider = normalize(observation.provider);
  const connectionId = observation.connectionId.trim();
  const model = normalize(observation.model);
  if (!provider || !connectionId || !model) return { kind: "ignored", reason: "missing_scope" };
  if (!policy.providers.map(normalize).includes(provider)) {
    return { kind: "ignored", reason: "provider_not_configured" };
  }
  if (!Number.isFinite(observation.upstreamHeadersMs) || observation.upstreamHeadersMs < 0) {
    return { kind: "ignored", reason: "invalid_timing" };
  }

  const key = stateKey(provider, connectionId, model);
  const state = states.get(key) || {
    provider,
    connectionId,
    model,
    slowObservations: [],
    escalationLevel: 0,
    lastTripAt: null,
    cooldownUntil: null,
    lastObservationAt: nowMs,
    lastUpstreamHeadersMs: observation.upstreamHeadersMs,
    lastStatus: observation.upstreamStatus,
    lastLifecycleStatus: observation.upstreamLifecycleStatus || null,
    lastUpstreamRequestId: observation.upstreamRequestId || null,
  };
  pruneObservations(state, policy, nowMs);
  state.lastObservationAt = nowMs;
  state.lastUpstreamHeadersMs = observation.upstreamHeadersMs;
  state.lastStatus = observation.upstreamStatus;
  state.lastLifecycleStatus = observation.upstreamLifecycleStatus || null;
  state.lastUpstreamRequestId = observation.upstreamRequestId || null;

  if (state.cooldownUntil !== null) {
    states.set(key, state);
    return { kind: "ignored", reason: "cooldown_active" };
  }

  const isCapacityFailure =
    observation.upstreamLifecycleStatus?.toLowerCase() === "errored" &&
    (observation.upstreamStatus === 503 || observation.upstreamStatus === 504);
  if (observation.upstreamHeadersMs <= policy.thresholdMs && !isCapacityFailure) {
    state.slowObservations = [];
    states.set(key, state);
    return { kind: "observed", slowCount: 0 };
  }

  state.slowObservations.push(nowMs);
  const slowCount = state.slowObservations.length;
  if (slowCount < policy.failuresBeforeCooldown) {
    states.set(key, state);
    return { kind: "observed", slowCount };
  }

  const escalationLevel = Math.min(state.escalationLevel + 1, policy.cooldownStepsMs.length);
  const cooldownMs = policy.cooldownStepsMs[escalationLevel - 1];
  state.escalationLevel = escalationLevel;
  state.lastTripAt = nowMs;
  state.cooldownUntil = nowMs + cooldownMs;
  state.slowObservations = [];
  states.set(key, state);
  lockExactModel(provider, connectionId, model, "slow_start", cooldownMs);
  return { kind: "cooled", cooldownMs, escalationLevel, slowCount };
}

export function getSlowStartStates(nowMs = Date.now()) {
  return [...states.values()]
    .map((state) => ({
      provider: state.provider,
      connectionId: state.connectionId,
      model: state.model,
      slowCount: state.slowObservations.filter((observedAt) => observedAt <= nowMs).length,
      escalationLevel: state.escalationLevel,
      cooldownUntil: state.cooldownUntil,
      lastObservationAt: state.lastObservationAt,
      lastUpstreamHeadersMs: state.lastUpstreamHeadersMs,
      lastStatus: state.lastStatus,
      lastLifecycleStatus: state.lastLifecycleStatus,
      lastUpstreamRequestId: state.lastUpstreamRequestId,
    }))
    .sort((left, right) => right.lastObservationAt - left.lastObservationAt);
}

export function clearSlowStartState(): void {
  states.clear();
}
