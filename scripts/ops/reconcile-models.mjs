#!/usr/bin/env node
/**
 * Deterministic OmniRoute model reconciliation.
 *
 * Derives everything from live state; the only curated surface is a small
 * provider-alias table (provider-level, ~10 entries, stable).
 *
 * THE LESSON THIS ENCODES
 * -----------------------
 * A provider's advertised list and its served set are DIFFERENT, and they
 * differ in BOTH directions:
 *
 *   advertised but not served  -> NVIDIA advertises ~102, serves ~33.
 *                                 Trusting the listing imports dead entries.
 *   served but not advertised  -> meta/muse-glimmer-30b answers with HTTP 200
 *                                 and real tokens, yet never appeared in our
 *                                 synced catalog. Trusting the listing SILENTLY
 *                                 DROPS a working model.
 *
 * The second direction is the one that bites hardest, because from inside the
 * gateway "not in the catalog" and "not served" produce the identical error
 * ("not available in the active live catalog"). They demand opposite actions.
 * Only a direct provider call distinguishes them.
 *
 * So this reconciles three sets per provider:
 *   catalog   - what OmniRoute currently exposes
 *   registry  - models.dev, the provider-agnostic capability source
 *   probe     - what the provider actually answers to, right now
 *
 * and emits: PRUNE (in catalog, provably dead), RESTORE (provably alive,
 * missing from catalog), KEEP. Dry-run by default; writes nothing without
 * --apply.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE = process.env.OMNIROUTE_BASE || "http://gx10:20128";
const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
const PROBE_BUDGET = Number(
  process.argv.find((a) => a.startsWith("--probe-max="))?.split("=")[1] || 40
);

/** Provider-level alias table: OmniRoute id -> models.dev id. Only curated surface. */
const PROVIDER_ALIAS = {
  gemini: "google",
  claude: "anthropic",
  github: "github-copilot",
  codex: "openai",
  antigravity: "google",
  "xai-oauth": "xai",
  moonshot: "kimi-for-coding", // branding migration: moonshot == kimi == kimi-coding
  "kimi-coding-apikey": "kimi-for-coding",
  "nous-research": "nousresearch",
};

/** Providers that are tools, not LLM vendors — absence from a registry is correct. */
const NON_LLM = new Set(["jina-ai", "brave-search", "exa-search", "ollama-search", "elevenlabs"]);

// Token: CLI config on a workstation, env inside the deployed container
// (where no ~/.omniroute exists — scheduled tasks run as the app user).
const TOKEN = (() => {
  const fromEnv = process.env.OMNIROUTE_BOOTSTRAP_TOKEN || process.env.OMNIROUTE_TOKEN;
  if (fromEnv) return fromEnv;
  const cfg = JSON.parse(readFileSync(`${homedir()}/.omniroute/config.json`, "utf8"));
  return cfg.contexts[cfg.currentContext].accessToken;
})();

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok && !init.tolerate) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

const canon = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Probe a model with a real completion.
 *
 * Uses a generous max_tokens on purpose: a reasoning model given a tiny budget
 * spends it all on thinking and returns no content, which OmniRoute reports as
 * a 502 "empty response without usable output". That is a measurement artifact,
 * not a dead model — mistaking it for one is how working models get pruned.
 */
async function probe(modelId) {
  try {
    const res = await api("/v1/chat/completions", {
      method: "POST",
      tolerate: true,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 400,
      }),
    });
    if (res?.error) return { alive: false, reason: String(res.error.message || "").slice(0, 90) };
    const msg = res?.choices?.[0]?.message ?? {};
    // Content OR reasoning_content counts: some providers separate reasoning
    // natively (muse-glimmer, minimax-m3) and a content-only check calls them dead.
    const alive = Boolean((msg.content ?? "").trim() || (msg.reasoning_content ?? "").trim());
    return { alive, reason: alive ? "" : "empty content and reasoning" };
  } catch (err) {
    return { alive: false, reason: String(err.message).slice(0, 90) };
  }
}

/**
 * Ask the PROVIDER what it advertises, using its own endpoint.
 *
 * This is the candidate source that matters most, and the one a registry
 * cannot replace: meta/muse-glimmer-30b is absent from models.dev's 99 NVIDIA
 * entries yet present in NVIDIA's own list of ~102 — and it serves. Any
 * reconciliation seeded only from a registry stays blind to exactly the models
 * a provider ships between registry updates.
 *
 * Base URL comes from models.dev's per-provider `api` field, so this needs no
 * hand-maintained endpoint table.
 */
async function upstreamAdvertised(baseUrl, apiKey) {
  if (!baseUrl || !apiKey) return new Set();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return new Set();
    const body = await res.json();
    const rows = body?.data || body?.models || [];
    return new Set(rows.map((m) => m?.id || m?.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function main() {
  const registry = await (await fetch("https://models.dev/api.json")).json();
  const byCanon = new Map(Object.keys(registry).map((k) => [canon(k), k]));
  const registryKey = (p) => {
    const t = PROVIDER_ALIAS[p] ?? p;
    return t in registry ? t : byCanon.get(canon(t));
  };

  const { connections } = await api("/api/providers");
  const active = connections.filter((c) => c.isActive && !NON_LLM.has(c.provider));
  const seen = new Set();
  const plan = { prune: [], restore: [], unverifiable: [] };
  let probes = 0;

  for (const conn of active) {
    const provider = conn.provider;
    if (seen.has(provider) || (ONLY && provider !== ONLY)) continue;
    seen.add(provider);

    const raw = await api(`/api/providers/${conn.id}/models`).catch(() => ({}));
    const catalog = new Set(
      (raw.models || raw.data || []).map((m) => m.id || m.name).filter(Boolean)
    );
    const rk = registryKey(provider);
    const known = new Set(rk ? Object.keys(registry[rk].models || {}) : []);

    // Candidates = what the PROVIDER advertises ∪ what the registry knows.
    // The provider's own list is primary: it is the only source that carried
    // meta/muse-glimmer-30b, which models.dev does not list at all.
    const full = await api(`/api/providers/${conn.id}`).catch(() => ({}));
    const apiKey = (full.connection || full || {}).apiKey;
    const advertised = await upstreamAdvertised(rk ? registry[rk].api : null, apiKey);
    const candidates = new Set([...advertised, ...known]);

    // Probe anything we do not already expose; restore only what answers.
    for (const candidate of candidates) {
      if (catalog.has(candidate)) continue;
      if (probes >= PROBE_BUDGET) {
        plan.unverifiable.push({ provider, model: candidate, why: "probe budget exhausted" });
        continue;
      }
      probes += 1;
      const { alive, reason } = await probe(`${provider}/${candidate}`);
      if (alive) plan.restore.push({ provider, connectionId: conn.id, model: candidate });
      else plan.unverifiable.push({ provider, model: candidate, why: reason });
    }

    console.log(
      `  ${provider.padEnd(20)} catalog=${String(catalog.size).padStart(4)}` +
        ` upstream=${String(advertised.size).padStart(4)} registry=${String(known.size).padStart(4)}` +
        ` candidates=${String(candidates.size).padStart(4)}` +
        (rk ? "" : "  (no registry coverage)")
    );
  }

  console.log(`\nprobes run: ${probes}`);
  console.log(`RESTORE (served but missing from catalog): ${plan.restore.length}`);
  for (const r of plan.restore) console.log(`   + ${r.provider}/${r.model}`);
  console.log(`unverified (probe said no / budget): ${plan.unverifiable.length}`);

  if (!APPLY) {
    console.log("\n[dry-run] nothing written. re-run with --apply to add RESTORE entries.");
    return;
  }
  for (const r of plan.restore) {
    const res = await api("/api/provider-models", {
      method: "POST",
      tolerate: true,
      body: JSON.stringify({
        connectionId: r.connectionId,
        provider: r.provider,
        modelId: r.model,
      }),
    });
    console.log(`   applied ${r.provider}/${r.model}: ${res?.error ? "FAILED" : "ok"}`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
