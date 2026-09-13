import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  HandleSingleModel,
  SingleModelTarget,
} from "../../open-sse/services/combo/types.ts";
import { createComboSchema } from "../../src/shared/validation/schemas/combo.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-account-hedge-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const coreDb = await import("../../src/lib/db/core.ts");
const providerConnections = await import("../../src/lib/db/providers.ts");
const { handleComboChat } = await import("../../open-sse/services/combo.ts");

test.after(() => {
  coreDb.resetDbInstance();
});

async function seedConnections(provider: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const connection = await providerConnections.createProviderConnection({
      name: `${provider}-${index + 1}`,
      provider,
      apiKey: `test-key-${index + 1}`,
    });
    ids.push(connection.id);
  }
  return ids;
}

function makeTarget(provider: string, model: string, connectionId?: string) {
  return {
    id: randomUUID(),
    type: "model" as const,
    model: `${provider}/${model}`,
    providerId: provider,
    dynamicAccount: connectionId === undefined,
    enabled: true,
    ...(connectionId === undefined ? {} : { allowedConnectionIds: [connectionId] }),
  };
}

function makeRequest(model: string): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "test" }] }),
  });
}

function makeResponse(label: string, status = 200): Response {
  const body =
    status >= 200 && status < 300
      ? { choices: [{ message: { content: label } }] }
      : { error: { message: label, type: "server_error" } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function responseContent(response: Response): Promise<string> {
  const body = await response.json();
  return body.choices[0].message.content;
}

function targetConnectionId(target: SingleModelTarget | undefined): string | null {
  if (!target || !("connectionId" in target)) return null;
  return target.connectionId ?? target.allowedConnectionIds?.[0] ?? null;
}

function makeDeps(model: string, combo: Record<string, unknown>, handleSingleModel: HandleSingleModel) {
  return {
    req: makeRequest(model),
    body: { model, messages: [{ role: "user", content: "test" }] },
    apiKeyRecord: { id: "test-key-id" },
    clientInfo: { client: "test", version: null },
    log: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    model,
    combo,
    handleSingleModel,
    isModelAvailable: async () => ({ available: true }),
  };
}

test("connection-aware hedging expands a no-quota provider into distinct accounts", async () => {
  const provider = "nvidia";
  await seedConnections(provider, 2);
  const model = "deepseek";
  const calls: Array<string | null> = [];

  const response = await handleComboChat(
    makeDeps(
      "test/no-quota",
      {
        id: randomUUID(),
        name: "test/no-quota",
        strategy: "random",
        models: [makeTarget(provider, model)],
        config: {
          maxRetries: 0,
          zeroLatencyOptimizationsEnabled: true,
          hedging: true,
          hedgeDelayMs: 5,
          connectionAwareExpansion: true,
        },
      },
      async (_body, _model, target) => {
        const connectionId = targetConnectionId(target);
        calls.push(connectionId);
        if (calls.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return makeResponse("slow");
        }
        return makeResponse("fast");
      }
    )
  );

  const content = await responseContent(response);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((connectionId) => connectionId !== null));
  assert.notEqual(calls[0], calls[1]);
  assert.equal(content, "fast");
});

test("maxParallelTargets bounds hedges and reuses a slot after a failed backup", async () => {
  const providers = Array.from({ length: 3 }, () => `hedge-cap-${randomUUID()}`);
  const connectionIds: string[] = [];
  for (const provider of providers) {
    const [connectionId] = await seedConnections(provider, 1);
    connectionIds.push(connectionId);
  }
  const model = "deepseek";
  let active = 0;
  let maxActive = 0;
  const calls: string[] = [];

  const response = await handleComboChat(
    makeDeps(
      "test/hedge-cap",
      {
        id: randomUUID(),
        name: "test/hedge-cap",
        strategy: "priority",
        models: providers.map((provider, index) => {
          const connectionId = connectionIds[index];
          assert.ok(connectionId);
          return makeTarget(provider, model, connectionId);
        }),
        config: {
          maxRetries: 0,
          zeroLatencyOptimizationsEnabled: true,
          hedging: true,
          hedgeDelayMs: 5,
          maxParallelTargets: 2,
        },
      },
      async (_body, _model, target) => {
        const connectionId = targetConnectionId(target);
        assert.ok(connectionId);
        calls.push(connectionId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (connectionId === connectionIds[0]) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return makeResponse("slow");
          }
          if (connectionId === connectionIds[1]) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return makeResponse("failed", 502);
          }
          return makeResponse("fast");
        } finally {
          active -= 1;
        }
      }
    )
  );

  assert.equal(await responseContent(response), "fast");
  assert.deepEqual(calls, connectionIds);
  assert.equal(maxActive, 2);
});

test("maxParallelTargets rejects non-positive values at the combo boundary", () => {
  const parsed = createComboSchema.safeParse({
    name: `hedge-schema-${randomUUID()}`,
    strategy: "priority",
    models: ["provider/model"],
    config: {
      hedging: true,
      maxParallelTargets: 0,
    },
  });

  assert.equal(parsed.success, false);
});
