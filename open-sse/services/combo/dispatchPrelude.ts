/**
 * Combo dispatch prelude — the branches `handleComboChat` evaluates BEFORE it
 * falls through to target resolution and the sequential attempt loop.
 *
 * Each `try*Dispatch` helper returns a `Response` when it owns the request, or
 * `null` to fall through to the next branch (and ultimately to the normal combo
 * machinery). The branches live here because none of them iterate targets in
 * priority order or need the failover/retry/credential-gate machinery that
 * follows — they either short-circuit to one model (context-cache pin), fan out
 * and synthesize (fusion), thread output → input (pipeline), or dispatch
 * pre-resolved runtime units (nested combo-refs in `execute` mode).
 *
 * Extracted from combo.ts as a pure move (#3501). No behaviour change.
 */
import { getCachedProviderConnections } from "../../../src/lib/db/readCache";
import { recordSessionModelUsage } from "../../../src/lib/db/contextHandoffs.ts";
import { getCircuitBreaker } from "../../../src/shared/utils/circuitBreaker";
import { fisherYatesShuffle, getNextFromDeck } from "../../../src/shared/utils/shuffleDeck";
import { normalizeRoutingStrategy } from "../../../src/shared/constants/routingStrategies.ts";
import { handleFusionChat, type FusionTuning } from "../fusion.ts";
import { getResolvedModelCapabilities } from "../modelCapabilities.ts";
import { errorResponseWithComboDiagnostics } from "../../utils/error.ts";
import { parseModel } from "../model.ts";
import { handlePipelineChat, type PipelineStep } from "../pipeline.ts";
import { resolveComboQueueDepth, resolveComboSetupConfig } from "../comboConfig.ts";
import { clampComboDepth, clampGlobalAttempts, resolveDelayMs } from "./comboPredicates.ts";
import {
  deriveRequestCompatibilityRequirements,
  isVisionIncompatibleTarget,
  resolveComboRuntimeUnits,
  resolveComboTargets,
} from "./comboStructure.ts";
import { isComboModelVisible } from "./comboVisibility.ts";
import { buildFusionHandleSingleModel, extractFusionPanelSpec } from "./fusionPanel.ts";
import { expandTargetsForAllStrategies } from "./connectionAwareExpansion.ts";
import { makeConnectionConcurrencyResolver } from "./concurrencyCaps.ts";
import * as semaphore from "../rateLimitSemaphore.ts";
import {
  expandComboSystemPromptIfPresent,
  resolveTargetFingerprint,
} from "../comboAgentMiddleware.ts";
import {
  clampStickyWeightedTargetLimit,
  getStickyRoundRobinStartIndex,
  getStickyWeightedExecutionKey,
  recordStickyRoundRobinSuccess,
  recordStickyWeightedSuccess,
  resolveComboStickyRoundRobinLimit,
  rrCounters,
} from "./rrState.ts";
import { executeRuntimeUnitCombo } from "./runtimeUnits.ts";
import {
  releaseQualityClone,
  releaseRejectedQualityResponse,
  validateResponseQuality,
} from "./validateQuality.ts";
import type {
  ComboCollectionLike,
  ComboLike,
  ComboLogger,
  ComboNestingContext,
  HandleComboChatOptions,
  HandleSingleModel,
  IsModelAvailable,
  HiddenModelsByProvider,
  NestedComboMode,
  ResolvedComboTarget,
  ResolvedComboUnit,
  SingleModelTarget,
} from "./types.ts";
import type { PerTargetAdmissionHook } from "../admission/types.ts";

type ComboSetupConfig = ReturnType<typeof resolveComboSetupConfig>;
type RunCombo = (options: HandleComboChatOptions) => Promise<Response>;

/**
 * The subset of handleComboChat's own arguments that a recursing branch has to
 * hand back to it when it dispatches a nested combo-ref.
 */
type PreludeBaseOptionArgs = {
  invocationId?: string;
  body: Record<string, unknown>;
  combo: ComboLike;
  handleSingleModel: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  log: ComboLogger;
  settings?: Record<string, unknown> | null;
  allCombos?: ComboCollectionLike;
  relayOptions?: HandleComboChatOptions["relayOptions"];
  signal?: AbortSignal | null;
  apiKeyAllowedConnections?: string[] | null;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  clientManagedResponsesContext?: boolean;
  /** #9654 Wave 2: per-target lane-aware admission probe (see HandleComboChatOptions). */
  perTargetAdmission?: PerTargetAdmissionHook | null;
  /** #10225 — defer the hard context-overflow preflight when compression is enabled. */
  deferContextOverflowWhenCompressible?: boolean;
  /** Server-side compression exclusions (#8034). */
  compressionExclusions?: import("../compression/exclusions.ts").CompressionExclusions;
  /** #10503 — request-shape facts for the target-aware deferral check (see knownContextOverflow.ts). */
  sourceFormat?: string | null;
  endpointPath?: string | null;
  requestHeaders?: Headers | Record<string, unknown> | null;
};

/** Rebuild handleComboChat's option bag verbatim for a recursive dispatch. */
function buildBaseOptions(a: PreludeBaseOptionArgs): HandleComboChatOptions {
  return {
    body: a.body,
    combo: a.combo,
    handleSingleModel: a.handleSingleModel,
    isModelAvailable: a.isModelAvailable,
    log: a.log,
    settings: a.settings,
    allCombos: a.allCombos,
    relayOptions: a.relayOptions,
    signal: a.signal,
    apiKeyAllowedConnections: a.apiKeyAllowedConnections,
    hiddenModelsByProvider: a.hiddenModelsByProvider,
    invocationId: a.invocationId,
    clientManagedResponsesContext: a.clientManagedResponsesContext,
    perTargetAdmission: a.perTargetAdmission,
    deferContextOverflowWhenCompressible: a.deferContextOverflowWhenCompressible,
    compressionExclusions: a.compressionExclusions,
    sourceFormat: a.sourceFormat,
    endpointPath: a.endpointPath,
    requestHeaders: a.requestHeaders,
  };
}

const TERMINAL_PIN_STATUSES = new Set(["credits_exhausted", "banned", "expired"]);

/**
 * Pure decision: should a context-cache pin be DROPPED because its provider has
 * DURABLY fallen? A ccp pin keeps the prompt cache warm by bypassing the combo
 * strategy — but if the pinned provider is dead (credits exhausted / banned /
 * expired, circuit-open, repeated failures, or a long rate-limit) honoring the
 * pin pounds a dead account forever with no failover (laila throttle + credits
 * incidents, 2026-06-22). A brief transient cooldown is tolerated (pin kept) so
 * an unstable provider does not churn the pin every turn. Connection-level
 * `backoffLevel` already resets on success, so `backoffLevel >= K` ≈ K
 * consecutive failures — no per-session counter needed.
 *
 * Returns true ⇒ drop the pin and use the strategy. Pure + unit-testable.
 */
export function pinIsDurablyUnhealthy(
  circuitState: string | undefined,
  connections: Array<{
    testStatus?: string | null;
    backoffLevel?: number | null;
    rateLimitedUntil?: string | null;
  }>,
  now: number,
  opts: { backoffLevel?: number; graceMs?: number } = {}
): boolean {
  if (circuitState === "OPEN") return true;
  if (!Array.isArray(connections) || connections.length === 0) return true;
  const backoffThreshold = opts.backoffLevel ?? Number(process.env.PIN_DROP_BACKOFF_LEVEL || "2");
  const graceMs = opts.graceMs ?? Number(process.env.PIN_DROP_GRACE_MS || "20000");
  // The pin survives as long as AT LEAST ONE connection is healthy or only
  // briefly cooling down — failover only when every connection is durably down.
  const anyUsable = connections.some((c) => {
    const status = typeof c.testStatus === "string" ? c.testStatus : "";
    if (TERMINAL_PIN_STATUSES.has(status)) return false;
    if (Number(c.backoffLevel ?? 0) >= backoffThreshold) return false;
    const rl = c.rateLimitedUntil ? new Date(String(c.rateLimitedUntil)).getTime() : 0;
    if (Number.isFinite(rl) && rl - now > graceMs) return false;
    return true;
  });
  return !anyUsable;
}

/**
 * Async wrapper: resolve the pinned model's provider, read its circuit state and
 * active connections, and decide via {@link pinIsDurablyUnhealthy}. Fail-open
 * (return false) on any error so a lookup bug never drops a healthy pin.
 */
async function isPinnedModelDurablyUnhealthy(pinnedModel: string): Promise<boolean> {
  try {
    const provider = parseModel(pinnedModel).provider;
    if (!provider) return false;
    const circuitState = getCircuitBreaker(provider)?.getStatus?.()?.state;
    const connections = (await getCachedProviderConnections({
      provider,
      isActive: true,
    })) as Array<{
      testStatus?: string | null;
      backoffLevel?: number | null;
      rateLimitedUntil?: string | null;
    }>;
    return pinIsDurablyUnhealthy(circuitState, connections || [], Date.now());
  } catch {
    return false;
  }
}

export function normalizeNestedComboMode(value: unknown): NestedComboMode {
  return value === "execute" ? "execute" : "flatten";
}

export function buildDefaultNesting(
  nesting: ComboNestingContext | null | undefined,
  comboName: string,
  config: ComboSetupConfig
): ComboNestingContext {
  return (
    nesting || {
      depth: 0,
      maxDepth: clampComboDepth(config.maxComboDepth),
      visitedComboNames: [comboName],
      rootComboName: comboName,
      // #11134: honor the operator-configured shared budget (clamped to the
      // hard cap) instead of the hardcoded MAX_GLOBAL_ATTEMPTS.
      attemptBudget: { count: 0, limit: clampGlobalAttempts(config.maxGlobalAttempts) },
    }
  );
}

/**
 * Decide whether the honored pin's response is good enough to return as-is.
 * Returns the response to serve it, or null to fall through to the combo
 * strategy (200-but-empty, or a transient upstream status worth failing over).
 */
async function evaluatePinnedResponse(args: {
  pinnedResult: Response;
  pinnedModel: string;
  clientRequestedStream: boolean;
  config: ComboSetupConfig;
  log: ComboLogger;
}): Promise<Response | null> {
  const { pinnedResult, pinnedModel, clientRequestedStream, config, log } = args;
  if (pinnedResult.ok) {
    let pinnedClone: Response;
    try {
      pinnedClone = pinnedResult.clone();
    } catch {
      pinnedClone = pinnedResult;
    }
    const pinnedQuality = await validateResponseQuality(
      pinnedClone,
      clientRequestedStream,
      log,
      config.responseValidation
    );
    releaseQualityClone(pinnedClone, pinnedResult, pinnedQuality);
    if (pinnedQuality.valid) return pinnedResult;
    releaseRejectedQualityResponse(pinnedClone, pinnedResult);
    log.warn(
      "COMBO",
      `Pinned model ${pinnedModel} returned 200 but failed quality check: ${pinnedQuality.reason}, falling through to combo retry/fallback`
    );
    return null;
  }
  const pinnedStatus = pinnedResult.status || 500;
  if (![408, 429, 500, 502, 503, 504].includes(pinnedStatus)) {
    return pinnedResult;
  }
  log.warn(
    "COMBO",
    `Pinned model ${pinnedModel} failed (${pinnedStatus}), falling through to combo retry/fallback`
  );
  return null;
}

export type PinnedDispatchResult = {
  /** The pin's (or a same-tier sibling's) response — return it as-is when set. */
  response: Response | null;
  /**
   * True when the pinned target's entire tier was unavailable and a
   * DIFFERENT, out-of-tier target is about to serve this turn through the
   * combo's normal strategy (the one-transient-failure-permanently-moves-
   * the-pin bug). The caller must let that fallback answer the turn WITHOUT
   * recording it as the new session pin — the next turn has to retry the
   * original pin (and its tier) rather than getting stuck on whatever
   * happened to answer once. Only meaningful when `response` is null: a
   * stale pin (name no longer in the combo at all) returns `false` here —
   * there is no tier to retry, so the fallback naturally becomes the pin,
   * same as before this fix.
   */
  suppressPinRecording: boolean;
};

/**
 * Resolve the pinned target's "tier": itself, plus any sibling targets that
 * should be tried — and may be re-pinned to — before the session falls all
 * the way through to the combo's normal strategy.
 *
 * comboStructure.ts's buildExecutionKey builds a leaf's executionKey as
 * `[...path, stepId].join(">")`, and `path` only grows when the resolver
 * descends into a combo-ref (resolveNestedComboTargets / expandRuntimeStep).
 * So a target nested under a top-level combo-ref carries that step's id as
 * the first `>`-separated segment of its executionKey; a direct (flat)
 * member's key has none. That segment is exactly the "unit"
 * tryRuntimeUnitDispatch treats as one black box when nestedComboMode is
 * "execute" — reuse it as the tier boundary. Outside execute mode a
 * combo-ref's members are flattened as ordinary independent targets (no unit
 * semantics), so the pinned target's tier is itself alone — same as a flat
 * combo.
 */
export function resolvePinnedTier(
  comboTargets: ResolvedComboTarget[],
  pinnedTarget: ResolvedComboTarget,
  nestedComboMode: NestedComboMode
): ResolvedComboTarget[] {
  if (nestedComboMode !== "execute") return [pinnedTarget];
  const sep = pinnedTarget.executionKey.indexOf(">");
  if (sep === -1) return [pinnedTarget];
  const tierPrefix = pinnedTarget.executionKey.slice(0, sep + 1);
  const siblings = comboTargets.filter(
    (t) => t.executionKey !== pinnedTarget.executionKey && t.executionKey.startsWith(tierPrefix)
  );
  return [pinnedTarget, ...siblings];
}

function findComboByName(allCombos: ComboCollectionLike | undefined, name: string): ComboLike | null {
  const list: ComboLike[] = Array.isArray(allCombos)
    ? (allCombos as ComboLike[])
    : ((allCombos as { combos?: ComboLike[] } | undefined)?.combos ?? []);
  return list.find((c) => c?.name === name) ?? null;
}

type PinnedSemaphoreGate = {
  key: string;
  maxConcurrency: number;
  timeoutMs: number;
  maxQueueSize: number;
};

async function buildSemaphoreGate(
  rrCombo: ComboLike,
  rrConfig: Record<string, unknown>,
  executionKey: string,
  connectionId: string | null
): Promise<PinnedSemaphoreGate> {
  // Mirrors roundRobinCombo.ts's own concurrency/queue resolution exactly
  // (#9158 clamp, #3872 queue depth) so a pinned attempt and a live
  // round-robin attempt for the same target share one gate.
  const baseConcurrency = Math.min(Math.max(Number(rrConfig.concurrencyPerModel ?? 3), 1), 32);
  const resolveTargetConcurrency = makeConnectionConcurrencyResolver(baseConcurrency);
  return {
    key: `combo:${rrCombo.name}:${executionKey}`,
    maxConcurrency: await resolveTargetConcurrency(connectionId),
    timeoutMs: Number(rrConfig.queueTimeoutMs ?? 30000),
    maxQueueSize: resolveComboQueueDepth(rrConfig),
  };
}

/**
 * The semaphore gate a LIVE (unpinned) round-robin dispatch of `member` would
 * use — same key format and limits roundRobinCombo.ts computes
 * (`combo:${name}:${executionKey}`, concurrencyPerModel/queueTimeoutMs/
 * queueDepth). Pinned dispatch used to bypass roundRobinCombo.ts entirely, so
 * a pinned session's in-flight request was invisible to the per-model
 * concurrency cap it enforces. Returns null when neither the combo being
 * dispatched nor the single nested tier `member` runs under is round-robin —
 * there is no gate for a pinned attempt to join.
 *
 * Resolves at most one level of nesting (the combo-ref tier `member` lives
 * directly under, matching resolvePinnedTier's own tier boundary).
 */
async function resolvePinnedRoundRobinGate(args: {
  combo: ComboLike;
  strategy: string;
  member: ResolvedComboTarget;
  allCombos?: ComboCollectionLike;
  config: ComboSetupConfig;
  settings?: Record<string, unknown> | null;
  hiddenModelsByProvider?: HiddenModelsByProvider;
}): Promise<PinnedSemaphoreGate | null> {
  const { combo, strategy, member, allCombos, config, settings, hiddenModelsByProvider } = args;
  const rootConfig = config as unknown as Record<string, unknown>;

  if (strategy === "round-robin") {
    return buildSemaphoreGate(combo, rootConfig, member.executionKey, member.connectionId);
  }

  // Not round-robin at the root — `member` may still live inside a nested
  // round-robin TIER (a combo-ref run under nestedComboMode "execute"; see
  // resolvePinnedTier).
  const sep = member.executionKey.indexOf(">");
  if (sep === -1 || !allCombos) return null;
  if (normalizeNestedComboMode(config.nestedComboMode) !== "execute") return null;

  const tierStepId = member.executionKey.slice(0, sep);
  const units = resolveComboRuntimeUnits(
    combo,
    allCombos,
    "execute",
    clampComboDepth(config.maxComboDepth),
    hiddenModelsByProvider
  );
  const tierUnit = units.find((u) => u.executionKey === tierStepId);
  if (!tierUnit || tierUnit.kind !== "combo-ref") return null;

  const nestedCombo = findComboByName(allCombos, tierUnit.comboName);
  if (!nestedCombo) return null;
  if (normalizeRoutingStrategy(nestedCombo.strategy || "priority") !== "round-robin") return null;

  // Fresh (path-less) resolution — a nested combo dispatched via `execute`
  // mode runs itself from scratch (its own handleComboChat/handleRoundRobinCombo
  // call), so its OWN executionKeys are NOT prefixed by the parent's tier step.
  const nestedTargets = resolveComboTargets(
    nestedCombo,
    allCombos,
    clampComboDepth(config.maxComboDepth),
    hiddenModelsByProvider
  );
  const localTarget = nestedTargets.find((t) => t.modelStr === member.modelStr);
  if (!localTarget) return null;

  const nestedConfig = resolveComboSetupConfig(nestedCombo, settings ?? null) as unknown as Record<
    string,
    unknown
  >;
  return buildSemaphoreGate(nestedCombo, nestedConfig, localTarget.executionKey, localTarget.connectionId);
}

/**
 * Dispatch one pinned-tier member (the pin itself, or a same-tier sibling)
 * and validate the response the same way the pinned path always has. Returns
 * the accepted Response, or null when the member should be considered failed
 * (throw, transient status, quality rejection) — the caller decides what to
 * try next.
 */
async function attemptPinnedMember(args: {
  modelStr: string;
  member: ResolvedComboTarget | null;
  body: Record<string, unknown>;
  combo: ComboLike;
  clientRequestedStream: boolean;
  config: ComboSetupConfig;
  handleSingleModelWithTimeout: HandleSingleModel;
  log: ComboLogger;
}): Promise<Response | null> {
  const {
    modelStr,
    member,
    body,
    combo,
    clientRequestedStream,
    config,
    handleSingleModelWithTimeout,
    log,
  } = args;
  let result: Response | null = null;
  try {
    // #5501: the combo system_message also expands on the pinned context path —
    // a session pin bypasses the main loop, so without this the template would
    // go literal from the second in-session request on. Target context comes
    // from the member's resolved combo target when available.
    const memberBody = expandComboSystemPromptIfPresent(body, combo, {
      modelId: modelStr,
      providerId: member && member.provider !== "unknown" ? member.provider : "",
      account:
        typeof member?.label === "string" && member.label.trim().length > 0
          ? member.label.trim()
          : "",
      fingerprint: member ? (resolveTargetFingerprint(member) ?? "") : "",
    });
    result = await handleSingleModelWithTimeout(memberBody, modelStr, {
      modelPinned: true,
    } as SingleModelTarget);
  } catch (err) {
    log.warn(
      "COMBO",
      `Pinned model ${modelStr} threw error: ${err instanceof Error ? err.message : String(err)}, trying next tier member / falling through to combo retry/fallback`
    );
    return null;
  }
  return evaluatePinnedResponse({
    pinnedResult: result,
    pinnedModel: modelStr,
    clientRequestedStream,
    config,
    log,
  });
}

/**
 * Context-cache pin routing (Fix #679), extended so one transient failure
 * cannot permanently move a session's pin, and so a pinned attempt for a
 * round-robin target is subject to the same concurrency cap an unpinned one
 * would be:
 *
 *  1. Try the pinned target. On failure/unavailability, try the OTHER
 *     members of its tier (resolvePinnedTier) — a same-tier sibling may
 *     become the new pin (`suppressPinRecording: false`).
 *  2. When the whole tier is unavailable, fall through to the combo's normal
 *     strategy for this turn only, but flag the caller to skip recording
 *     that fallback's model as the new pin (`suppressPinRecording: true`) —
 *     the next turn must retry the original pin and its tier. A flat combo
 *     (or a combo-ref not run under nestedComboMode "execute") has no tier
 *     siblings, so this degrades to "the pin alone".
 *  3. A pinned attempt for a target that belongs to a round-robin combo (or
 *     the single nested round-robin tier it runs inside) acquires that
 *     target's concurrency semaphore slot first — same key, same limits an
 *     unpinned dispatch would use — so in-flight pinned sessions count
 *     against the cap. A full/timed-out slot is treated as that member
 *     having failed (falls through to the next tier member, or to rule 2).
 *
 * The consecutive-failure auto-clear (failureTracker.ts, comboAttemptLoop.ts)
 * is unaffected by this and needs no changes: it only fires from the normal
 * attempt loop that runs AFTER this function falls through, and that loop's
 * OWN success is the only thing that calls recordSessionModelUsage again
 * (guarded by `suppressSessionPinRecording`, see executeTargetAttempt.ts) —
 * so once a streak clears the pin entirely (deleteSessionModelHistory), the
 * next turn has no pin at all and a fresh successful attempt sets one, same
 * as before this fix. Suppressing a single turn's pin-move (rule 2) never
 * suppresses the failure counter itself, so a combo that keeps failing after
 * exhausting its tier still clears via the existing threshold.
 *
 * Caller must only invoke this when a pin is present.
 */
export async function tryPinnedModelDispatch(args: {
  body: Record<string, unknown>;
  combo: ComboLike;
  pinnedModel: string;
  allCombos?: ComboCollectionLike;
  config: ComboSetupConfig;
  /** Root combo's own strategy — used only to detect the round-robin case (rule 3). */
  strategy?: string;
  /** Needed to re-pin a tier sibling (rule 1) and to resolve a nested tier's config (rule 3). */
  effectiveSessionId?: string | null;
  settings?: Record<string, unknown> | null;
  clientRequestedStream: boolean;
  handleSingleModelWithTimeout: HandleSingleModel;
  log: ComboLogger;
  hiddenModelsByProvider?: HiddenModelsByProvider;
}): Promise<PinnedDispatchResult> {
  const {
    body,
    combo,
    pinnedModel,
    allCombos,
    config,
    strategy = "priority",
    effectiveSessionId = null,
    settings = null,
    clientRequestedStream,
    handleSingleModelWithTimeout,
    log,
    hiddenModelsByProvider,
  } = args;
  // The pin is read from session_model_history (a PRIOR turn) and may name a
  // model that has since been removed from this combo, or a provider whose
  // credentials are gone. Without this guard a stale pin bypasses the strategy
  // and routes to a dead model forever — incident 2026-06-21: cli-claude-heavy
  // pinned to a deepseek connection with no active credentials → instant fail,
  // never falling through to the live targets; and combos re-pointed Opus→Sonnet
  // kept serving the old model. Validate the pin is still reachable in THIS
  // combo's resolved targets (refs flattened) before honoring it. Only validate
  // when allCombos is authoritative (non-empty) so we can resolve combo-refs;
  // the auto-combo redirect path passes an empty list and keeps prior behavior.
  const haveFullCombos = Array.isArray(allCombos) ? allCombos.length > 0 : !!allCombos;
  // Eagerly resolve the combo's targets once (used for the pin-validity check,
  // tier resolution, AND #5501 template expansion). A non-authoritative
  // allCombos (empty/missing) resolves to the combo's direct targets only —
  // same semantics as the original `!haveFullCombos ||` short-circuit, without
  // feeding `[]` to the nested resolver.
  const comboTargets = resolveComboTargets(
    combo,
    haveFullCombos ? allCombos : undefined,
    clampComboDepth(config.maxComboDepth),
    hiddenModelsByProvider
  );
  const pinInCombo = !haveFullCombos || comboTargets.some((t) => t.modelStr === pinnedModel);
  if (!pinInCombo) {
    log.warn(
      "COMBO",
      `Stale context-cache pin "${pinnedModel}" not in combo "${combo.name}" targets — dropping pin, using strategy`
    );
    return { response: null, suppressPinRecording: false };
  }

  // Honor the pin only if it (or a tier sibling) is not DURABLY down. Without
  // the health gate a pin keeps routing a session to a dead/credits-exhausted/
  // throttled account forever — incident 2026-06-22: laila stuck on a
  // throttled claude account and credits_exhausted accounts never failing
  // over. A transient cooldown is tolerated (pin kept) so an unstable
  // provider does not churn the pin.
  const pinnedTarget = comboTargets.find((t) => t.modelStr === pinnedModel) ?? null;
  const nestedComboMode = normalizeNestedComboMode(config.nestedComboMode);
  // Non-authoritative allCombos means comboTargets only has direct targets and
  // pinnedTarget may be missing even though pinInCombo was forced true above —
  // fall back to the pin alone (the original single-target behavior); tier and
  // semaphore resolution both need real target/combo structure to work with.
  const tierMembers: Array<ResolvedComboTarget | null> = pinnedTarget
    ? resolvePinnedTier(comboTargets, pinnedTarget, nestedComboMode)
    : [null];

  for (const member of tierMembers) {
    const memberModelStr = member ? member.modelStr : pinnedModel;
    const isPrimary = memberModelStr === pinnedModel;

    if (await isPinnedModelDurablyUnhealthy(memberModelStr)) {
      log.warn(
        "COMBO",
        isPrimary
          ? `Context-cache pin "${memberModelStr}" provider durably unhealthy — trying its tier before dropping the pin`
          : `Tier sibling "${memberModelStr}" provider durably unhealthy — skipping`
      );
      continue;
    }

    let release: (() => void) | null = null;
    if (member) {
      const gate = await resolvePinnedRoundRobinGate({
        combo,
        strategy,
        member,
        allCombos,
        config,
        settings,
        hiddenModelsByProvider,
      });
      if (gate) {
        try {
          release = await semaphore.acquire(gate.key, {
            maxConcurrency: gate.maxConcurrency,
            timeoutMs: gate.timeoutMs,
            maxQueueSize: gate.maxQueueSize,
          });
        } catch (err) {
          const code = (err as { code?: string } | null | undefined)?.code;
          log.warn(
            "COMBO",
            `${isPrimary ? "Pinned" : "Tier sibling"} model ${memberModelStr} round-robin slot ${
              code === "SEMAPHORE_QUEUE_FULL" ? "queue full" : "timed out"
            } — treating as unavailable`
          );
          continue;
        }
      }
    }

    try {
      log.info(
        "COMBO",
        isPrimary
          ? `Bypassing strategy — routing directly to pinned context model: ${memberModelStr}`
          : `Trying tier sibling for pinned context model: ${memberModelStr}`
      );
      const accepted = await attemptPinnedMember({
        modelStr: memberModelStr,
        member,
        body,
        combo,
        clientRequestedStream,
        config,
        handleSingleModelWithTimeout,
        log,
      });
      if (accepted) {
        if (!isPrimary && effectiveSessionId) {
          recordSessionModelUsage(
            effectiveSessionId,
            combo.name,
            memberModelStr,
            member?.provider ?? parseModel(memberModelStr).provider ?? "unknown",
            member?.connectionId ?? undefined
          );
          log.info(
            "COMBO",
            `Context cache: re-pinned within tier ${pinnedModel} -> ${memberModelStr}`
          );
        }
        return { response: accepted, suppressPinRecording: false };
      }
    } finally {
      release?.();
    }
  }

  log.warn(
    "COMBO",
    tierMembers.length > 1
      ? `Pinned target "${pinnedModel}" and its tier are all unavailable — using combo strategy for this turn without moving the pin`
      : `Pinned target "${pinnedModel}" is unavailable — using combo strategy for this turn without moving the pin`
  );
  // Fall through to the normal target iteration loop below. Every path above
  // this point that reaches here tried (and lost) at least one tier member,
  // so the caller must not let the fallback move the pin (rule 2/3) — only
  // the stale-pin early return above skips a tier attempt entirely.
  return { response: null, suppressPinRecording: true };
}

/**
 * Fusion strategy: parallel panel + judge synthesis. Handled here because it
 * neither iterates targets in order nor needs the failover/retry/credential
 * gate machinery that follows — it fans out, then synthesizes once.
 *
 * Also emits the #6455 misconfiguration warning for non-fusion combos that set
 * fusion-only config keys. Returns null for every non-fusion strategy.
 */
export async function tryFusionDispatch(args: {
  body: Record<string, unknown>;
  combo: ComboLike;
  cfg: Record<string, unknown>;
  config: ComboSetupConfig;
  strategy: string;
  allCombos?: ComboCollectionLike;
  nesting?: ComboNestingContext | null;
  handleSingleModel: HandleSingleModel;
  handleSingleModelWithTimeout: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  log: ComboLogger;
  settings?: Record<string, unknown> | null;
  relayOptions?: HandleComboChatOptions["relayOptions"];
  signal?: AbortSignal | null;
  apiKeyAllowedConnections?: string[] | null;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  perTargetAdmission?: PerTargetAdmissionHook | null;
  deferContextOverflowWhenCompressible?: boolean;
  compressionExclusions?: import("../compression/exclusions.ts").CompressionExclusions;
  sourceFormat?: string | null;
  endpointPath?: string | null;
  requestHeaders?: Headers | Record<string, unknown> | null;
  runCombo: RunCombo;
}): Promise<Response | null> {
  const { cfg, combo, config, strategy, log } = args;
  const configuredJudge = typeof cfg.judgeModel === "string" ? cfg.judgeModel : undefined;
  const judgeFusionRequirements = deriveRequestCompatibilityRequirements(args.body);
  // #3378: the judge stays in the original conversation (full history, including
  // any image_url blocks) — a judge whose vision support cannot be confirmed is
  // exactly as unsafe as an unconfirmed panel member (#8332). Drop it the same
  // way an operator-hidden judge is dropped below, so fusion falls back to a
  // (vision-confirmed) panel member instead of silently losing the image for
  // the synthesis step.
  const judgeLacksConfirmedVision =
    judgeFusionRequirements.requiresVision &&
    !!configuredJudge &&
    getResolvedModelCapabilities(configuredJudge).supportsVision !== true;
  // The panel is filtered for hidden models by resolveComboTargets, but the
  // explicit judge is a bare string that never passes through it (#8878). Drop a
  // hidden judge so fusion falls back to a surviving panel member instead of
  // dispatching a model the operator hid.
  const judgeModel =
    configuredJudge &&
    !judgeLacksConfirmedVision &&
    isComboModelVisible(configuredJudge, null, args.hiddenModelsByProvider)
      ? configuredJudge
      : undefined;
  const fusionTuning =
    cfg.fusionTuning && typeof cfg.fusionTuning === "object"
      ? (cfg.fusionTuning as FusionTuning)
      : undefined;
  if (strategy !== "fusion" && (configuredJudge || fusionTuning)) {
    log.warn(
      "COMBO",
      `Combo "${combo.name}" sets config.judgeModel/fusionTuning but strategy is "${strategy}" — these fields are only consumed by the fusion strategy and will be ignored (#6455)`
    );
  }
  if (strategy !== "fusion") return null;

  let allResolvedFusionTargets = resolveComboTargets(
    combo,
    args.allCombos,
    clampComboDepth(config.maxComboDepth),
    args.hiddenModelsByProvider
  );
  // Connection-aware expansion is opt-in. The fusion panel itself is
  // keyed by model string below (`resolvedByModelStr` keeps ONE target per
  // modelStr -- the first healthy connection), so the panel size is unchanged;
  // only each member's connectionId becomes a vetted, non-exhausted account.
  allResolvedFusionTargets = await expandTargetsForAllStrategies({
    strategy,
    targets: allResolvedFusionTargets,
    comboName: combo.name,
    config: combo.config,
    settings: args.settings as Record<string, unknown> | null | undefined,
    log,
    apiKeyAllowedConnectionIds: args.apiKeyAllowedConnections ?? null,
  });
  // #3378 (ported from upstream decolua/9router): every non-fusion combo
  // strategy runs candidates through filterTargetsByRequestCompatibility before
  // dispatch, which excludes a target whose vision support cannot be *confirmed*
  // `=== true` for an image-bearing request (#8332 — unknown is treated the same
  // as unsupported, never silently forwarded). Fusion resolved its panel via the
  // raw target list and skipped that filter entirely, so a panel member with an
  // unrecognized model id (capability lookup misses -> supportsVision !== true)
  // still received the unmodified image body while the panel silently lost a
  // "confirmed vision" voice. Apply the same exclusion here so the fusion panel
  // only fans an image request out to targets with confirmed vision support.
  const fusionRequirements = judgeFusionRequirements;
  const resolvedFusionTargets = fusionRequirements.requiresVision
    ? allResolvedFusionTargets.filter(
        (target) => !isVisionIncompatibleTarget(target, fusionRequirements)
      )
    : allResolvedFusionTargets;
  if (fusionRequirements.requiresVision && resolvedFusionTargets.length === 0) {
    log.warn(
      "COMBO",
      `Combo "${combo.name}" fusion panel has no target with confirmed vision support for this image request — every candidate was excluded (#3378)`
    );
    return errorResponseWithComboDiagnostics(
      400,
      `No target in combo ${combo.name} has confirmed vision support for this image request`,
      {
        poolSize: allResolvedFusionTargets.length,
        attempted: 0,
        excluded: allResolvedFusionTargets.map((target) => ({
          provider: target.provider,
          model: target.modelStr,
          reason: "vision",
        })),
        attemptOrder: [],
        terminalReason: "capability_mismatch",
      },
      { code: "capability_mismatch", type: "invalid_request_error" }
    );
  }
  // extractFusionPanelSpec only understands model strings / combo refs, so the
  // resolved targets have to be flattened before it runs. Keep them indexed so
  // the panel can be rehydrated below — dispatching the bare strings strips
  // `providerId` and every panel member loses its provider identity (#8878).
  const resolvedByModelStr = new Map<string, (typeof resolvedFusionTargets)[number]>();
  for (const target of resolvedFusionTargets) {
    if (!resolvedByModelStr.has(target.modelStr)) resolvedByModelStr.set(target.modelStr, target);
  }
  // Deduplicate targets by stepId / modelStr so panel size does not inflate
  // when models expand across multiple connections.
  const seenPanelKeys = new Set<string>();
  const distinctTargets: typeof resolvedFusionTargets = [];
  for (const target of resolvedFusionTargets) {
    const key = target.stepId ?? target.modelStr;
    if (!seenPanelKeys.has(key)) {
      seenPanelKeys.add(key);
      distinctTargets.push(target);
    }
  }
  const { panel: fusionPanel, comboRefUnits } = extractFusionPanelSpec(
    distinctTargets.map((target) => target.modelStr),
    combo.name,
    null
  );
  // A panel entry naming a combo ref stays a string (it is a combo name, not a
  // model); everything else regains its resolved target.
  const fusionModels = fusionPanel.map((entry) =>
    comboRefUnits.has(entry) ? entry : (resolvedByModelStr.get(entry) ?? entry)
  );
  // Untyped like the existing `nestingContext` further down — `nesting` is
  // already `ComboNestingContext | null` per HandleComboChatOptions, no new
  // import needed.
  const fusionNesting = buildDefaultNesting(args.nesting, combo.name, config);
  const fusionHandleSingleModel =
    comboRefUnits.size > 0
      ? buildFusionHandleSingleModel({
          handleSingleModel: args.handleSingleModelWithTimeout,
          comboRefUnits,
          allCombos: args.allCombos,
          nesting: fusionNesting,
          baseOptions: buildBaseOptions(args),
          runCombo: args.runCombo,
        })
      : args.handleSingleModelWithTimeout;
  return handleFusionChat({
    body: args.body,
    models: fusionModels,
    handleSingleModel: fusionHandleSingleModel,
    log,
    comboName: combo.name,
    perTargetAdmission: args.perTargetAdmission,
    judgeModel,
    tuning: fusionTuning,
  });
}

/**
 * Pipeline strategy: sequential chain — each step's output feeds the next step's
 * input, only the final step's response is returned. Handled here because it
 * neither iterates targets as fallbacks nor needs the failover/retry machinery
 * below. The step list is `combo.models` (in order); an optional per-step
 * `prompt` is read off the target object (comboModelStepInputSchema.prompt).
 */
export async function tryPipelineDispatch(args: {
  body: Record<string, unknown>;
  combo: ComboLike;
  config: ComboSetupConfig;
  strategy: string;
  settings?: Record<string, unknown> | null;
  apiKeyAllowedConnections?: string[] | null;
  allCombos?: ComboCollectionLike;
  handleSingleModelWithTimeout: HandleSingleModel;
  log: ComboLogger;
  hiddenModelsByProvider?: HiddenModelsByProvider;
}): Promise<Response | null> {
  const {
    body,
    combo,
    config,
    strategy,
    settings,
    apiKeyAllowedConnections,
    allCombos,
    handleSingleModelWithTimeout,
    log,
    hiddenModelsByProvider,
  } = args;
  if (strategy !== "pipeline") return null;
  const resolvedTargets = resolveComboTargets(
    combo,
    allCombos,
    clampComboDepth(config.maxComboDepth),
    hiddenModelsByProvider
  );
  const expanded = await expandTargetsForAllStrategies({
    strategy,
    targets: resolvedTargets,
    comboName: combo.name,
    config: combo.config,
    settings: settings as Record<string, unknown> | null | undefined,
    log,
    apiKeyAllowedConnectionIds: apiKeyAllowedConnections ?? null,
  });
  // Pipeline: each stage is one step. If a step expanded to multiple connections,
  // keep the first healthy connection for that stage.
  const seenSteps = new Set<string>();
  const pipelineTargets: typeof expanded = [];
  for (const target of expanded) {
    const key = target.stepId ?? target.modelStr;
    if (!seenSteps.has(key)) {
      seenSteps.add(key);
      pipelineTargets.push(target);
    }
  }
  const pipelineSteps: PipelineStep[] = pipelineTargets.map((target) => ({
    target,
    prompt: target.prompt,
  }));
  return handlePipelineChat({
    body,
    steps: pipelineSteps,
    handleSingleModel: handleSingleModelWithTimeout,
    log,
    comboName: combo.name,
    maxRetries: config.maxRetries ?? 0,
    retryDelayMs: resolveDelayMs(config.retryDelayMs, 1000),
  });
}

type RuntimeUnitOrdering = {
  units: ResolvedComboUnit[];
  executionStrategy: string;
  /** Non-null only for round-robin — drives the post-success sticky recording. */
  stickyLimit: number | null;
  stickyTargets: ResolvedComboUnit[];
};

/**
 * Apply the selection strategy to the resolved runtime units. Each strategy
 * reorders (never filters) the unit list so executeRuntimeUnitCombo can walk it
 * as a priority list, and round-robin additionally advances the shared rr
 * counter when stickiness is off.
 */
async function orderRuntimeUnits(args: {
  strategy: string;
  executeModeUnits: ResolvedComboUnit[];
  combo: ComboLike;
  config: ComboSetupConfig;
  settings?: Record<string, unknown> | null;
}): Promise<RuntimeUnitOrdering> {
  const { strategy, executeModeUnits, combo, config, settings } = args;
  let runtimeUnits = executeModeUnits;
  let unitExecutionStrategy = strategy;
  if (strategy === "weighted") {
    const stickyLimit = clampStickyWeightedTargetLimit(
      (config as Record<string, unknown>).stickyWeightedLimit
    );
    const stickyKey = getStickyWeightedExecutionKey(combo.name, stickyLimit);
    const stickyUnit = stickyKey
      ? runtimeUnits.find((unit) => unit.executionKey === stickyKey)
      : null;
    if (stickyUnit) {
      runtimeUnits = [
        stickyUnit,
        ...runtimeUnits.filter((unit) => unit.executionKey !== stickyUnit.executionKey),
      ];
      unitExecutionStrategy = "priority";
    }
  }
  if (strategy === "random") runtimeUnits = fisherYatesShuffle([...runtimeUnits]);
  if (strategy === "strict-random") {
    const key = await getNextFromDeck(
      `combo:${combo.name}`,
      runtimeUnits.map((unit) => unit.executionKey)
    );
    const selected = runtimeUnits.find((unit) => unit.executionKey === key) || runtimeUnits[0];
    runtimeUnits = [
      selected,
      ...runtimeUnits.filter((unit) => unit.executionKey !== selected.executionKey),
    ];
  }
  let runtimeStickyLimit: number | null = null;
  let runtimeStickyTargets: ResolvedComboUnit[] = runtimeUnits;
  if (strategy === "round-robin") {
    const perComboStickyLimit = (config as Record<string, unknown>).stickyRoundRobinLimit;
    runtimeStickyLimit = resolveComboStickyRoundRobinLimit(
      perComboStickyLimit,
      settings as Record<string, unknown> | null
    );
    const { startIndex, counter } = getStickyRoundRobinStartIndex(
      combo.name,
      runtimeUnits,
      runtimeStickyLimit
    );
    if (runtimeStickyLimit <= 1) rrCounters.set(combo.name, counter + 1);
    runtimeUnits = runtimeUnits.map(
      (_, offset) => runtimeUnits[(startIndex + offset) % runtimeUnits.length]
    );
    runtimeStickyTargets = executeModeUnits;
  }
  return {
    units: runtimeUnits,
    executionStrategy: unitExecutionStrategy,
    stickyLimit: runtimeStickyLimit,
    stickyTargets: runtimeStickyTargets,
  };
}

/**
 * Nested combo-ref dispatch in `execute` mode: when the combo references other
 * combos as black-box units AND the strategy is one of the simple selection
 * strategies, the units are ordered here and handed to executeRuntimeUnitCombo
 * instead of being flattened into the normal target list.
 *
 * Returns null when the combo has no executable combo-ref, when the mode is
 * `flatten`, or when the strategy needs the full target machinery.
 */
export async function tryRuntimeUnitDispatch(args: {
  body: Record<string, unknown>;
  combo: ComboLike;
  config: ComboSetupConfig;
  strategy: string;
  allCombos?: ComboCollectionLike;
  nesting?: ComboNestingContext | null;
  handleSingleModel: HandleSingleModel;
  handleSingleModelWithTimeout: HandleSingleModel;
  isModelAvailable?: IsModelAvailable;
  log: ComboLogger;
  settings?: Record<string, unknown> | null;
  relayOptions?: HandleComboChatOptions["relayOptions"];
  signal?: AbortSignal | null;
  apiKeyAllowedConnections?: string[] | null;
  hiddenModelsByProvider?: HiddenModelsByProvider;
  perTargetAdmission?: PerTargetAdmissionHook | null;
  deferContextOverflowWhenCompressible?: boolean;
  compressionExclusions?: import("../compression/exclusions.ts").CompressionExclusions;
  sourceFormat?: string | null;
  endpointPath?: string | null;
  requestHeaders?: Headers | Record<string, unknown> | null;
  runCombo: RunCombo;
}): Promise<Response | null> {
  const { body, combo, config, strategy, allCombos, log, settings } = args;
  const nestingContext = buildDefaultNesting(args.nesting, combo.name, config);
  const nestedComboMode = normalizeNestedComboMode(config.nestedComboMode);

  const executeModeUnits =
    nestedComboMode === "execute" && allCombos
      ? resolveComboRuntimeUnits(
          combo,
          allCombos,
          "execute",
          nestingContext.maxDepth,
          args.hiddenModelsByProvider
        )
      : [];
  const hasExecutableComboRef = executeModeUnits.some((unit) => unit.kind === "combo-ref");
  const simpleExecuteStrategies = new Set([
    "priority",
    "round-robin",
    "random",
    "strict-random",
    "weighted",
    "fill-first",
  ]);

  if (!hasExecutableComboRef || !simpleExecuteStrategies.has(strategy)) return null;

  const ordering = await orderRuntimeUnits({
    strategy,
    executeModeUnits,
    combo,
    config,
    settings,
  });
  const {
    units: runtimeUnits,
    executionStrategy: unitExecutionStrategy,
    stickyLimit: runtimeStickyLimit,
    stickyTargets: runtimeStickyTargets,
  } = ordering;

  const execution = await executeRuntimeUnitCombo({
    body,
    combo,
    strategy: unitExecutionStrategy,
    effectiveComboStrategy: strategy,
    units: runtimeUnits,
    handleSingleModel: args.handleSingleModelWithTimeout,
    isModelAvailable: args.isModelAvailable,
    log,
    config,
    settings,
    allCombos,
    signal: args.signal,
    nesting: nestingContext,
    baseOptions: buildBaseOptions(args),
    runCombo: args.runCombo,
    hiddenModelsByProvider: args.hiddenModelsByProvider,
  });
  recordRuntimeUnitStickySuccess({
    strategy,
    combo,
    config,
    execution,
    stickyLimit: runtimeStickyLimit,
    stickyTargets: runtimeStickyTargets,
  });
  return execution.response;
}

/**
 * Pin the winning unit for the next request when the strategy is sticky-capable
 * and the dispatch actually succeeded. No-op for every other strategy.
 */
function recordRuntimeUnitStickySuccess(args: {
  strategy: string;
  combo: ComboLike;
  config: ComboSetupConfig;
  execution: { response: Response; unit: ResolvedComboUnit | null };
  stickyLimit: number | null;
  stickyTargets: ResolvedComboUnit[];
}): void {
  const { strategy, combo, config, execution, stickyLimit, stickyTargets } = args;
  if (strategy === "weighted" && execution.response.ok && execution.unit) {
    const weightedLimit = clampStickyWeightedTargetLimit(
      (config as Record<string, unknown>).stickyWeightedLimit
    );
    if (weightedLimit > 1)
      recordStickyWeightedSuccess(combo.name, execution.unit.executionKey, weightedLimit);
  }
  if (
    strategy === "round-robin" &&
    execution.response.ok &&
    execution.unit &&
    stickyLimit &&
    stickyLimit > 1
  ) {
    recordStickyRoundRobinSuccess(combo.name, execution.unit, stickyLimit, stickyTargets);
  }
}
