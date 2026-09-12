// Unit tests for the OMNIROUTE_PROXIED_LAN_CIDRS opt-in in src/server/authz/peerContext.ts:
// a request forwarded by a local reverse proxy is LAN only when the proxy-appended
// client IP is inside a configured CIDR and no Cloudflare edge header is present.
import test from "node:test";
import assert from "node:assert/strict";

import type { PolicyContext } from "../../../src/server/authz/context.ts";

const { isPrivateLanRequest, isTrustedProxiedLanClient } =
  await import("../../../src/server/authz/peerContext.ts");
const { PEER_IP_HEADER, VIA_PROXY_HEADER } = await import("../../../src/server/authz/headers.ts");

const TOKEN = "proxied-lan-test-token";
const CIDRS = "10.0.1.1/32,100.64.0.0/10";
const TRAEFIK = "10.0.10.8";
const ORIGINAL_TOKEN = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
const ORIGINAL_CIDRS = process.env.OMNIROUTE_PROXIED_LAN_CIDRS;

test.after(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  else process.env.OMNIROUTE_PEER_STAMP_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_CIDRS === undefined) delete process.env.OMNIROUTE_PROXIED_LAN_CIDRS;
  else process.env.OMNIROUTE_PROXIED_LAN_CIDRS = ORIGINAL_CIDRS;
});

function xff(value: string, extra: Record<string, string> = {}) {
  return new Headers({ "x-forwarded-for": value, ...extra });
}

function stampedCtx(peer: string, viaProxy: boolean, headers: Record<string, string> = {}) {
  return {
    request: {
      headers: new Headers({
        [PEER_IP_HEADER]: `${TOKEN}|${peer}`,
        [VIA_PROXY_HEADER]: `${TOKEN}|${viaProxy ? "1" : "0"}`,
        ...headers,
      }),
    },
  } as unknown as PolicyContext;
}

test("proxied LAN is off when no CIDRs are configured", () => {
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("10.0.1.1"), ""), false);
});

test("the proxy-appended client inside a configured CIDR is LAN", () => {
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("10.0.1.1"), CIDRS), true);
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("100.113.61.33"), CIDRS), true);
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("::ffff:10.0.1.1"), CIDRS), true);
});

test("only the rightmost X-Forwarded-For entry counts", () => {
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("10.0.1.1, 203.0.113.9"), CIDRS), false);
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("203.0.113.9, 10.0.1.1"), CIDRS), true);
});

test("a request that came through Cloudflare is never LAN", () => {
  for (const name of ["cf-connecting-ip", "cf-ray", "cdn-loop"]) {
    const headers = xff("10.0.1.1", { [name]: "cloudflare" });
    assert.equal(isTrustedProxiedLanClient(TRAEFIK, headers, CIDRS), false, name);
  }
});

test("the proxy itself must be a loopback or private-LAN peer", () => {
  assert.equal(isTrustedProxiedLanClient("203.0.113.1", xff("10.0.1.1"), CIDRS), false);
  assert.equal(isTrustedProxiedLanClient(null, xff("10.0.1.1"), CIDRS), false);
});

test("malformed CIDRs and non-IPv4 clients never match", () => {
  assert.equal(
    isTrustedProxiedLanClient(TRAEFIK, xff("10.0.1.1"), "10.0.1.1/33,not-a-cidr"),
    false
  );
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff("fd7a:115c:a1e0::1"), CIDRS), false);
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, xff(""), CIDRS), false);
  assert.equal(isTrustedProxiedLanClient(TRAEFIK, new Headers(), CIDRS), false);
});

test("isPrivateLanRequest accepts a proxied request only through the opt-in", () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = TOKEN;
  const tailnet = { "x-forwarded-for": "10.0.1.1" };

  delete process.env.OMNIROUTE_PROXIED_LAN_CIDRS;
  assert.equal(isPrivateLanRequest(stampedCtx(TRAEFIK, true, tailnet)), false);

  process.env.OMNIROUTE_PROXIED_LAN_CIDRS = CIDRS;
  assert.equal(isPrivateLanRequest(stampedCtx(TRAEFIK, true, tailnet)), true);
  assert.equal(
    isPrivateLanRequest(stampedCtx(TRAEFIK, true, { ...tailnet, "cf-ray": "8f00-MIA" })),
    false
  );
});

test("isPrivateLanRequest keeps the direct-peer behavior", () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = TOKEN;
  process.env.OMNIROUTE_PROXIED_LAN_CIDRS = CIDRS;
  assert.equal(isPrivateLanRequest(stampedCtx("192.168.1.5", false)), true);
  assert.equal(isPrivateLanRequest(stampedCtx("203.0.113.9", false)), false);
});
