import test from "node:test";
import assert from "node:assert/strict";

const usage = await import("../../open-sse/services/usage.ts");
const { USAGE_SUPPORTED_PROVIDERS } = await import("../../src/shared/constants/providers.ts");

test("USAGE_SUPPORTED_PROVIDERS includes ollama-cloud", () => {
  assert.ok(
    (USAGE_SUPPORTED_PROVIDERS as string[]).includes("ollama-cloud"),
    "ollama-cloud must be in the usage-supported providers allowlist"
  );
});

test("USAGE_FETCHER_PROVIDERS includes ollama-cloud (#7026)", () => {
  // getUsageForProvider's switch handles `case "ollama-cloud"`, and the array's doc comment
  // requires it to stay in sync with that switch. If it drifts, registerGenericQuotaFetchers
  // never registers a preflight quota fetcher for ollama-cloud even though the scraper exists.
  assert.ok(
    (usage.USAGE_FETCHER_PROVIDERS as readonly string[]).includes("ollama-cloud"),
    "ollama-cloud is handled by getUsageForProvider's switch and must be listed in USAGE_FETCHER_PROVIDERS"
  );
});

test("registerGenericQuotaFetchers wires a preflight quota fetcher for ollama-cloud (#7026)", async () => {
  const { registerGenericQuotaFetchers } = await import(
    "../../open-sse/services/genericQuotaFetcher.ts"
  );
  const { getQuotaFetcher } = await import("../../open-sse/services/quotaPreflight.ts");
  registerGenericQuotaFetchers();
  assert.ok(
    getQuotaFetcher("ollama-cloud"),
    "a generic quota fetcher must be registered for ollama-cloud after registerGenericQuotaFetchers()"
  );
});

test("getUsageForProvider returns helpful message when Ollama Cloud has no usage cookie", async () => {
  const originalCookie = process.env.OLLAMA_USAGE_COOKIE;
  const originalOmniCookie = process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
  delete process.env.OLLAMA_USAGE_COOKIE;
  delete process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;

  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return new Response("unexpected", { status: 500 });
  };

  try {
    const result = (await usage.getUsageForProvider({
      id: "ollama-cloud-no-cookie",
      provider: "ollama-cloud",
      apiKey: "ollama-chat-key",
    })) as { message?: string };

    assert.equal(called, false, "settings scrape must not run without a cookie");
    assert.match(result.message ?? "", /Ollama Cloud/);
    assert.match(result.message ?? "", /OLLAMA_USAGE_COOKIE/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.OLLAMA_USAGE_COOKIE;
    else process.env.OLLAMA_USAGE_COOKIE = originalCookie;
    if (originalOmniCookie === undefined) delete process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
    else process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = originalOmniCookie;
  }
});

test("getUsageForProvider scrapes Ollama Cloud settings quota", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.OLLAMA_USAGE_COOKIE;
  const originalOmniCookie = process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
  delete process.env.OLLAMA_USAGE_COOKIE;
  process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = "__Secure-session=test-cookie";

  let requestUrl = "";
  let requestHeaders: Headers | null = null;
  let redirectMode: RequestRedirect | undefined;

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers as HeadersInit | undefined);
    redirectMode = init?.redirect;
    return new Response(
      [
        '<span class="capitalize">pro</span>',
        '<div data-usage-track aria-label="34% used" style="width: 34%"></div>',
        '<span class="local-time" data-time="2026-06-22T15:00:00.000Z"></span>',
        '<div data-usage-track style="width: 67%"></div>',
        '<span class="local-time" data-time="2026-06-29T15:00:00.000Z"></span>',
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } }
    );
  };

  try {
    const result = (await usage.getUsageForProvider({
      id: "ollama-cloud-settings",
      provider: "ollama-cloud",
      apiKey: "ollama-chat-key",
    })) as {
      plan?: string | null;
      quotas?: Record<string, { used: number; total: number; remainingPercentage: number }>;
    };

    assert.equal(requestUrl, "https://ollama.com/settings");
    assert.equal(requestHeaders?.get("Cookie"), "__Secure-session=test-cookie");
    assert.equal(redirectMode, "manual");
    assert.equal(result.plan, "Ollama Cloud pro");
    assert.deepEqual(Object.keys(result.quotas ?? {}), ["session", "weekly"]);
    assert.equal(result.quotas!.session.used, 34);
    assert.equal(result.quotas!.session.remainingPercentage, 66);
    assert.equal(result.quotas!.weekly.used, 67);
    assert.equal(result.quotas!.weekly.remainingPercentage, 33);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.OLLAMA_USAGE_COOKIE;
    else process.env.OLLAMA_USAGE_COOKIE = originalCookie;
    if (originalOmniCookie === undefined) delete process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
    else process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = originalOmniCookie;
  }
});

test("getUsageForProvider keeps Ollama Cloud reset times aligned to usage tracks", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.OLLAMA_USAGE_COOKIE;
  const originalOmniCookie = process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
  delete process.env.OLLAMA_USAGE_COOKIE;
  process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = "test-cookie";

  globalThis.fetch = async () =>
    new Response(
      [
        '<span class="local-time" data-time="2026-01-01T00:00:00.000Z"></span>',
        '<div data-usage-track aria-label="34% used" style="width: 1%">',
        '<span class="local-time" data-time="2026-06-22T15:00:00.000Z"></span>',
        "</div>",
        '<div data-usage-track style="width: 67%">',
        '<span style="width: 1%"></span>',
        '<span class="local-time" data-time="2026-06-29T15:00:00.000Z"></span>',
        "</div>",
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } }
    );

  try {
    const result = (await usage.getUsageForProvider({
      id: "ollama-cloud-aligned-times",
      provider: "ollama-cloud",
      apiKey: "ollama-chat-key",
    })) as {
      quotas?: Record<string, { used: number; resetAt: string | null }>;
    };

    assert.equal(result.quotas!.session.used, 34);
    assert.equal(result.quotas!.session.resetAt, "2026-06-22T15:00:00.000Z");
    assert.equal(result.quotas!.weekly.used, 67);
    assert.equal(result.quotas!.weekly.resetAt, "2026-06-29T15:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.OLLAMA_USAGE_COOKIE;
    else process.env.OLLAMA_USAGE_COOKIE = originalCookie;
    if (originalOmniCookie === undefined) delete process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
    else process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = originalOmniCookie;
  }
});

test("getUsageForProvider reports expired Ollama Cloud cookies on redirect", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.OLLAMA_USAGE_COOKIE;
  process.env.OLLAMA_USAGE_COOKIE = "expired-cookie";

  globalThis.fetch = async () =>
    new Response("", {
      status: 302,
      headers: { location: "/signin" },
    });

  try {
    const result = (await usage.getUsageForProvider({
      id: "ollama-cloud-redirect",
      provider: "ollama-cloud",
      apiKey: "ollama-chat-key",
    })) as { message?: string };

    assert.match(result.message ?? "", /authentication expired/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.OLLAMA_USAGE_COOKIE;
    else process.env.OLLAMA_USAGE_COOKIE = originalCookie;
  }
});

test("getUsageForProvider parses the redesigned single monthly-meter settings page (post-2026-08-19)", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.OLLAMA_USAGE_COOKIE;
  const originalOmniCookie = process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
  delete process.env.OLLAMA_USAGE_COOKIE;
  process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = "test-cookie";

  // Trimmed fixture modeled on the real ollama.com/settings redesign: one
  // `data-usage-track` with a dollar-denominated aria-label, the fill
  // percentage on the inner child div, per-model `data-usage-segment`
  // buttons, and a reset caption right after the meter.
  globalThis.fetch = async () =>
    new Response(
      [
        '<h2><span>Included usage</span>',
        '<span class="capitalize">max</span></h2>',
        "<div>",
        '<div class="flex justify-between mb-2"><span>Monthly usage</span><span>$207.95 of $300 used</span></div>',
        '<div data-usage-meter>',
        '<div data-usage-bubble aria-hidden="true"><span data-usage-model></span><span data-usage-requests></span></div>',
        '<div data-usage-track aria-label="Monthly usage $207.95 of $300 used">',
        '<div style="width: 69.3%; ">',
        '<button type="button" style="width: 0.2%; background: #22c55e" data-usage-segment data-model="gemma4:31b" data-requests="127" aria-label="gemma4:31b: 127 requests"></button>',
        '<button type="button" style="width: 24.8%; background: #4f46e5" data-usage-segment data-model="deepseek-v4-flash:0731" data-requests="13376" aria-label="deepseek-v4-flash:0731: 13376 requests"></button>',
        "</div>",
        "</div>",
        "</div>",
        '<div data-time="2026-10-08T06:24:07Z">Resets in 3 weeks.</div>',
        "</div>",
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } }
    );

  try {
    const result = (await usage.getUsageForProvider({
      id: "ollama-cloud-monthly",
      provider: "ollama-cloud",
      apiKey: "ollama-chat-key",
    })) as {
      plan?: string;
      quotas?: Record<
        string,
        {
          used: number;
          total: number;
          remainingPercentage: number;
          resetAt: string | null;
          displayName?: string;
          currency?: string;
          details?: Array<{ name: string; used: number }>;
        }
      >;
    };

    assert.equal(result.plan, "Ollama Cloud max");
    assert.deepEqual(Object.keys(result.quotas ?? {}), ["monthly"]);

    const monthly = result.quotas!.monthly;
    // 207.95 / 300 * 100, rounded to match the observed 69.3% fill.
    assert.ok(Math.abs(monthly.used - 69.316666) < 0.01, `expected ~69.32, got ${monthly.used}`);
    assert.equal(monthly.total, 100);
    assert.ok(Math.abs(monthly.remainingPercentage - 30.683333) < 0.01);
    assert.equal(monthly.resetAt, "2026-10-08T06:24:07Z");
    assert.equal(monthly.displayName, "Monthly");
    assert.equal(monthly.currency, "USD");
    assert.deepEqual(monthly.details, [
      { name: "gemma4:31b", used: 127 },
      { name: "deepseek-v4-flash:0731", used: 13376 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.OLLAMA_USAGE_COOKIE;
    else process.env.OLLAMA_USAGE_COOKIE = originalCookie;
    if (originalOmniCookie === undefined) delete process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE;
    else process.env.OMNIROUTE_OLLAMA_USAGE_COOKIE = originalOmniCookie;
  }
});

test("getUsageForProvider falls back to the inner width when the monthly aria-label has no dollar amounts", async () => {
  const originalFetch = globalThis.fetch;
  const originalCookie = process.env.OLLAMA_USAGE_COOKIE;
  process.env.OLLAMA_USAGE_COOKIE = "test-cookie";

  globalThis.fetch = async () =>
    new Response(
      [
        '<span class="capitalize">free</span>',
        '<div data-usage-track aria-label="Monthly usage">',
        '<div style="width: 42.5%; ">',
        '<button type="button" style="width: 10%" data-usage-segment data-model="qwen3:8b" data-requests="9"></button>',
        "</div>",
        "</div>",
        '<div data-time="2026-11-01T00:00:00.000Z">Resets in 3 weeks.</div>',
      ].join(""),
      { status: 200, headers: { "content-type": "text/html" } }
    );

  try {
    const result = (await usage.getUsageForProvider({
      id: "ollama-cloud-monthly-width-fallback",
      provider: "ollama-cloud",
      apiKey: "ollama-chat-key",
    })) as { quotas?: Record<string, { used: number; resetAt: string | null }> };

    assert.equal(result.quotas!.monthly.used, 42.5);
    assert.equal(result.quotas!.monthly.resetAt, "2026-11-01T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCookie === undefined) delete process.env.OLLAMA_USAGE_COOKIE;
    else process.env.OLLAMA_USAGE_COOKIE = originalCookie;
  }
});
