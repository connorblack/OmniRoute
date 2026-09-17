/**
 * A stand-in for the single-model chat handler that combo tests pass to
 * handleComboChat. It keeps the part of chat.ts the combo relies on: AUTH
 * refuses a connection whose model is locked with the model_cooldown body, and
 * every upstream failure is recorded by AUTH's markAccountUnavailable against
 * the connection that served it. Combo targets stay unpinned.
 */
import { createProviderConnection } from "../../../src/lib/db/providers.ts";
import { markAccountUnavailable } from "../../../src/sse/services/auth.ts";
import {
  getModelLockoutInfo,
  getRuntimeProviderProfile,
} from "../../../open-sse/services/accountFallback.ts";

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function okResponse() {
  return jsonResponse(200, { id: "ok", choices: [{ message: { content: "recovered" } }] });
}

export function rateLimitResponse(
  retryAfterMs: number,
  { status = 429, message = `rate limited (${status})` }: { status?: number; message?: string } = {}
) {
  const retryAfter = new Date(Date.now() + retryAfterMs).toISOString();
  return jsonResponse(status, { error: { message }, retryAfter }, { "retry-after": retryAfter });
}

// buildModelCooldownBody's shape (open-sse/utils/error.ts): the retry hint is
// nested under `error`, not the top-level `retryAfter`.
export function modelCooldownResponse(model: string, retryAfterMs: number) {
  return jsonResponse(429, {
    error: {
      message: `All credentials for model ${model} are cooling down`,
      type: "rate_limit_error",
      code: "model_cooldown",
      model,
      reset_seconds: Math.max(Math.ceil(retryAfterMs / 1000), 1),
      retry_after: new Date(Date.now() + retryAfterMs).toISOString(),
    },
  });
}

function splitModel(modelStr: string) {
  const slash = modelStr.indexOf("/");
  return { provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) };
}

type AuthMarkOptions = {
  /**
   * chat.ts keeps a combo's rate-limit 429 out of the DB and locks the model
   * instead; every other failure persists connection state.
   */
  persistUnavailableState?: boolean;
};

export async function recordAuthFailure(
  connectionId: string,
  modelStr: string,
  response: Response,
  { persistUnavailableState = response.status !== 429 }: AuthMarkOptions = {}
) {
  const { provider, model } = splitModel(modelStr);
  const profile = { ...(await getRuntimeProviderProfile(provider)), useUpstreamRetryHints: true };
  await markAccountUnavailable(
    connectionId,
    response.status,
    await response.clone().text(),
    provider,
    model,
    profile as never,
    { persistUnavailableState, isCombo: true, headers: response.headers }
  );
}

export async function authBackedHandler(
  providers: string[],
  upstream: (modelStr: string, callsForModel: number) => Response,
  markOptions: (modelStr: string) => AuthMarkOptions = () => ({})
) {
  const connectionIds = new Map<string, string>();
  for (const provider of providers) {
    const connection = await createProviderConnection({
      provider,
      name: `${provider}-combo-test`,
      authType: "apikey",
      apiKey: "sk-combo-test",
      isActive: true,
      testStatus: "active",
    });
    connectionIds.set(provider, connection.id as string);
  }
  const dispatches: string[] = [];
  const upstreamCalls: string[] = [];
  const handleSingleModel = async (_body: unknown, modelStr: string) => {
    dispatches.push(modelStr);
    const { provider, model } = splitModel(modelStr);
    const connectionId = connectionIds.get(provider);
    if (!connectionId) throw new Error(`no seeded connection for ${provider}`);
    const lock = getModelLockoutInfo(provider, connectionId, model);
    if (lock && lock.remainingMs > 0) return modelCooldownResponse(model, lock.remainingMs);
    upstreamCalls.push(modelStr);
    const response = upstream(modelStr, upstreamCalls.filter((m) => m === modelStr).length);
    if (response.status >= 400) {
      await recordAuthFailure(connectionId, modelStr, response, markOptions(modelStr));
    }
    return response;
  };
  return { connectionIds, dispatches, handleSingleModel, upstreamCalls };
}
