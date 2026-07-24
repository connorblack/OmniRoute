import assert from "node:assert/strict";
import test from "node:test";

import {
  GET,
  OPTIONS,
  injectServiceModelsIntoManifest,
} from "../../../../src/app/api/v1/provider-plugin-manifest/route.ts";
import type { ServiceModel } from "../../../../src/lib/db/serviceModels.ts";
import type { ProviderPluginManifest, ProviderPluginManifestEntry } from "../../../../open-sse/config/providerPluginManifest.ts";
import { generateProviderPluginManifest } from "../../../../open-sse/config/providerPluginManifestRegistry.ts";

function getProvider(manifest: ProviderPluginManifest, id: string): ProviderPluginManifestEntry | undefined {
  return manifest.providers.find((provider) => provider.id === id);
}

function hasModel(provider: ProviderPluginManifestEntry | undefined, modelId: string): boolean {
  if (!provider) return false;
  return provider.models.some((model) => model.id === modelId);
}

function withServicePluginEntries(manifest: ProviderPluginManifest): ProviderPluginManifest {
  const providers = [...manifest.providers];

  if (!providers.some((provider) => provider.id === "9router")) {
    providers.push({
      id: "9router",
      format: "openai",
      executor: "default",
      auth: { type: "none", header: "authorization" },
      endpoints: {},
      capabilities: [],
      passthroughModels: false,
      models: [],
      sidecar: { eligible: false, reasons: [] },
    });
  }

  if (!providers.some((provider) => provider.id === "cliproxyapi")) {
    providers.push({
      id: "cliproxyapi",
      format: "openai",
      executor: "default",
      auth: { type: "none", header: "authorization" },
      endpoints: {},
      capabilities: [],
      passthroughModels: false,
      models: [],
      sidecar: { eligible: false, reasons: [] },
    });
  }

  providers.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ...manifest,
    providers,
  };
}

test("provider plugin manifest route returns JSON-safe manifest", async () => {
  const response = await GET();
  const body = (await response.json()) as ProviderPluginManifest;

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.generatedFrom, "open-sse/config/providers");
  assert.ok(body.providers.length > 100);
  assert.ok(body.providers.some((provider) => provider.id === "openai"));

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("clientSecret"), false);
});

test("provider plugin manifest route handles CORS preflight", async () => {
  const response = await OPTIONS();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "*");
});

test("provider plugin manifest route injects service models with a custom reader", async () => {
  const manifest = withServicePluginEntries(generateProviderPluginManifest());
  const withModels = await injectServiceModelsIntoManifest(
    manifest,
    (toolName: string): ServiceModel[] => {
      if (toolName === "9router") {
        return [
          { id: "gpt-test", name: "9Router Test", available: true },
          { id: "9router/chat", name: "Already namespaced", available: true },
        ];
      }
      // Keyed on the SERVICE TOOL name, which is what the sync writes to
      // key_value — the plugin id is "cliproxyapi", the tool is "cliproxy".
      if (toolName === "cliproxy") {
        return [{ id: "model-clone", name: "Cliproxy Test", available: true }];
      }
      return [];
    },
  );

  const nineRouterEntry = getProvider(withModels, "9router");
  assert.ok(nineRouterEntry);
  assert.ok(hasModel(nineRouterEntry, "9router/gpt-test"));
  assert.ok(hasModel(nineRouterEntry, "9router/chat"));

  const cliproxyEntry = getProvider(withModels, "cliproxyapi");
  assert.ok(cliproxyEntry);
  assert.ok(hasModel(cliproxyEntry, "cliproxy/model-clone"));
});

test("service model reader is keyed by tool name, not plugin id", async () => {
  // Regression: injectServiceModelsIntoManifest used to pass provider.id
  // ("cliproxyapi") to the reader, while the sync stores models under the tool
  // name ("cliproxy"). The lookup missed every time and CLIProxyAPI contributed
  // 0 models regardless of how many it had synced. 9router masked it because
  // its plugin id and tool name are identical.
  const seen: string[] = [];
  const manifest = withServicePluginEntries(generateProviderPluginManifest());

  await injectServiceModelsIntoManifest(manifest, (toolName: string): ServiceModel[] => {
    seen.push(toolName);
    return [];
  });

  assert.ok(seen.includes("cliproxy"), `reader should be called with "cliproxy", saw: ${seen.join(", ")}`);
  assert.ok(!seen.includes("cliproxyapi"), `reader must not be called with the plugin id, saw: ${seen.join(", ")}`);
});

test("provider plugin manifest route injects providers absent from upstream registry", async () => {
  const manifest = generateProviderPluginManifest();
  const withModels = await injectServiceModelsIntoManifest(
    manifest,
    (toolName: string): ServiceModel[] => {
      if (toolName === "9router") {
        return [{ id: "injected-model", name: "Runtime Model", available: true }];
      }
      if (toolName === "cliproxy") {
        return [{ id: "proxy-model", name: "Proxy Model", available: true }];
      }
      return [];
    }
  );

  const nineRouterEntry = getProvider(withModels, "9router");
  assert.ok(nineRouterEntry);
  assert.ok(hasModel(nineRouterEntry, "9router/injected-model"));
  assert.equal(nineRouterEntry.passthroughModels, true);
  assert.equal(nineRouterEntry.endpoints?.modelsUrl, "/v1/models");
  assert.equal(nineRouterEntry.format, "openai");

  const cliproxyEntry = getProvider(withModels, "cliproxyapi");
  assert.ok(cliproxyEntry);
  assert.ok(hasModel(cliproxyEntry, "cliproxy/proxy-model"));
  assert.equal(cliproxyEntry.passthroughModels, true);
  assert.equal(cliproxyEntry.endpoints?.modelsUrl, "/v1/models");
  assert.equal(cliproxyEntry.format, "openai");
});

test("provider plugin manifest route skips unavailable service models", async () => {
  const manifest = withServicePluginEntries(generateProviderPluginManifest());
  const withModels = await injectServiceModelsIntoManifest(
    manifest,
    (toolName: string): ServiceModel[] => {
      if (toolName === "9router") {
        return [
          { id: "visible", name: "9Router Visible", available: true },
          { id: "hidden", name: "9Router Hidden", available: false },
        ];
      }
      return [];
    },
  );

  const nineRouterEntry = getProvider(withModels, "9router");
  assert.ok(nineRouterEntry);
  assert.ok(hasModel(nineRouterEntry, "9router/visible"));
  assert.equal(hasModel(nineRouterEntry, "9router/hidden"), false);
});

test("provider plugin manifest route injects only when 9router exposure is enabled", async () => {
  const manifest = withServicePluginEntries(generateProviderPluginManifest());
  const withModels = await injectServiceModelsIntoManifest(
    manifest,
    (toolName: string): ServiceModel[] => {
      if (toolName === "9router") {
        return [{ id: "gpt-test", name: "9Router Test" }];
      }
      return [];
    },
    (toolName: string): boolean => (toolName === "9router" ? false : true),
  );

  const nineRouterEntry = getProvider(withModels, "9router");
  assert.ok(nineRouterEntry);
  assert.equal(hasModel(nineRouterEntry, "9router/gpt-test"), false);
});

test("provider plugin manifest route injects for cliproxy when exposure is enabled", async () => {
  const manifest = withServicePluginEntries(generateProviderPluginManifest());
  const withModels = await injectServiceModelsIntoManifest(
    manifest,
    // model reader is keyed by TOOL name ("cliproxy") ...
    (toolName: string): ServiceModel[] => {
      if (toolName === "cliproxy") {
        return [{ id: "model-clone", name: "Cliproxy Test" }];
      }
      return [];
    },
    () => true,
  );

  const cliproxyEntry = getProvider(withModels, "cliproxyapi");
  assert.ok(cliproxyEntry);
  assert.ok(hasModel(cliproxyEntry, "cliproxy/model-clone"));
});

test("provider plugin manifest route skips cliproxy models when exposure is disabled", async () => {
  const manifest = withServicePluginEntries(generateProviderPluginManifest());
  const withModels = await injectServiceModelsIntoManifest(
    manifest,
    // ... while the EXPOSURE reader is keyed by PLUGIN ID ("cliproxyapi"),
    // because injectServiceModelsIntoManifest passes provider.id to it and
    // shouldExposeServiceModels does the plugin -> tool mapping internally.
    (toolName: string): ServiceModel[] => {
      if (toolName === "cliproxy") {
        return [{ id: "model-clone", name: "Cliproxy Test" }];
      }
      return [];
    },
    (pluginId: string): boolean => (pluginId === "cliproxyapi" ? false : true),
  );

  const cliproxyEntry = getProvider(withModels, "cliproxyapi");
  assert.ok(cliproxyEntry);
  assert.equal(hasModel(cliproxyEntry, "cliproxy/model-clone"), false);
});
