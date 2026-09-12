import { timingSafeEqual } from "node:crypto";

import { getLegacyCliTokenSync, getMachineTokenSync } from "../../lib/machineToken";
import type { PolicyContext } from "./context";
import { CLI_TOKEN_HEADER, PEER_IP_HEADER, VIA_PROXY_HEADER } from "./headers";
import { resolveStampedPeer, resolveStampedViaProxy } from "./peerStamp";
import { classifyHostLocality, isLoopbackHost, isPrivateLanHost } from "./routeGuard";

/**
 * Peer-locality + local-CLI-token helpers shared by the route policies.
 *
 * Extracted from `policies/management.ts` because the PUBLIC policy
 * needs the very same CLI-token verdict: `runAuthzPipeline` strips
 * CLI_TOKEN_HEADER from the forwarded headers for EVERY route class, so a route
 * handler can only learn that a local CLI authenticated from the subject stamp
 * the policy produced. Without this, a PUBLIC-classified route that still calls
 * `requireManagementAuth()` (e.g. GET /api/monitoring/health) can never see the
 * local CLI as a management principal.
 */

export function requestPeerAddress(ctx: PolicyContext): string | null {
  // The Next proxy runtime exposes no socket/.ip, so the only trustworthy
  // locality signal is the token-stamped PEER_IP_HEADER our custom server writes
  // from the real TCP peer (scripts/dev/peer-stamp.mjs). We NEVER read the Host
  // header here — it is client-controlled and spoofable. Absent/forged stamp →
  // null → isLoopbackRequest/isPrivateLanRequest return false → fail closed.
  const stamped = resolveStampedPeer(
    ctx.request.headers?.get?.(PEER_IP_HEADER) ?? null,
    process.env.OMNIROUTE_PEER_STAMP_TOKEN
  );
  if (stamped) return stamped;
  // Non-proxy callers (tests / direct Node) may carry a real socket peer.
  return ctx.request.ip ?? ctx.request.socket?.remoteAddress ?? null;
}

/**
 * True when the inbound TCP request carried forwarding headers
 * (`x-forwarded-for` / `x-real-ip`), as stamped by the custom Node server. When
 * set, the socket peer is the reverse-proxy hop, not the end-user — so a
 * loopback / private-LAN socket must NOT be trusted as local (Hard Rules #15 +
 * #17, port of decolua/9router da667836). Token-validated; an attacker who
 * knows the header name but not the per-process token cannot influence it.
 */
export function isViaProxyRequest(ctx: PolicyContext): boolean {
  return resolveStampedViaProxy(
    ctx.request.headers?.get?.(VIA_PROXY_HEADER) ?? null,
    process.env.OMNIROUTE_PEER_STAMP_TOKEN
  );
}

export function isLoopbackRequest(ctx: PolicyContext): boolean {
  if (isViaProxyRequest(ctx)) return false;
  const peerAddress = requestPeerAddress(ctx);
  return peerAddress ? isLoopbackHost(peerAddress) : false;
}

// Cloudflare adds these at its edge and a client cannot strip them, so a request
// carrying any of them came through Cloudflare (e.g. a Cloudflare Tunnel into the
// same local proxy) and is never treated as LAN.
const CLOUDFLARE_EDGE_HEADERS = ["cf-connecting-ip", "cf-ray", "cdn-loop"];

function ipv4ToNumber(ip: string): number | null {
  const octets = ip.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) {
    return null;
  }
  return octets.reduce((acc, o) => acc * 256 + Number(o), 0);
}

function inIPv4Cidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw = "32"] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipNum = ipv4ToNumber(ip);
  const baseNum = ipv4ToNumber(base);
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const blockSize = 2 ** (32 - bits);
  return Math.floor(ipNum / blockSize) === Math.floor(baseNum / blockSize);
}

/**
 * Operator opt-in for a reverse proxy on a trusted network (e.g. Traefik on a
 * tailnet-only host). A request forwarded by a loopback / private-LAN proxy
 * counts as LAN when the client address the proxy appended (the rightmost
 * X-Forwarded-For entry) is inside OMNIROUTE_PROXIED_LAN_CIDRS (comma-separated
 * IPv4 CIDRs) and no Cloudflare edge header is present. Earlier X-Forwarded-For
 * entries are client-supplied and ignored. Unset: proxied requests are never LAN.
 */
export function isTrustedProxiedLanClient(
  proxyPeer: string | null,
  headers: Pick<Headers, "get"> | undefined,
  cidrs = process.env.OMNIROUTE_PROXIED_LAN_CIDRS ?? ""
): boolean {
  const ranges = cidrs
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (ranges.length === 0 || classifyHostLocality(proxyPeer) === "remote") return false;
  if (CLOUDFLARE_EDGE_HEADERS.some((name) => headers?.get?.(name))) return false;
  const hops = (headers?.get?.("x-forwarded-for") ?? "").split(",");
  const client = hops[hops.length - 1].trim().replace(/^::ffff:/i, "");
  return ranges.some((cidr) => inIPv4Cidr(client, cidr));
}

// Owner-authorized (2026-05-30): allow LOCAL_ONLY *paths* from a trusted private
// LAN, based on the real socket peer IP (not spoofable). Does NOT relax the
// CLI-token gate, which stays strictly loopback. Behind a reverse proxy the
// apparent LAN IP is the proxy, not the end-user (see isViaProxyRequest above),
// so a proxied request is LAN only through isTrustedProxiedLanClient.
export function isPrivateLanRequest(ctx: PolicyContext): boolean {
  const peerAddress = requestPeerAddress(ctx);
  if (!peerAddress) return false;
  if (isViaProxyRequest(ctx)) return isTrustedProxiedLanClient(peerAddress, ctx.request.headers);
  return isPrivateLanHost(peerAddress);
}

/** Strictly-loopback machine-token check (constant-time). */
export function hasValidLoopbackCliToken(ctx: PolicyContext): boolean {
  if (process.env.OMNIROUTE_DISABLE_CLI_TOKEN === "true") return false;
  if (!isLoopbackRequest(ctx)) return false;
  const headers = ctx.request.headers;
  const provided = headers.get(CLI_TOKEN_HEADER);
  if (!provided) return false;
  const expectedTokens = [getMachineTokenSync(), getLegacyCliTokenSync()].filter(Boolean);
  return expectedTokens.some((expected) => {
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  });
}

/** The subject a validated local CLI request is stamped with. */
export const LOCAL_CLI_SUBJECT = Object.freeze({
  kind: "management_key" as const,
  id: "cli",
  label: "local-cli-token",
});
