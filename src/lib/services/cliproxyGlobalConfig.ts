import { getUpstreamProxyConfig, upsertUpstreamProxyConfig } from "@/lib/db/upstreamProxy";

export interface GlobalCliproxyapiConfig {
  cliproxyapiModelMapping?: Record<string, string>;
}

/**
 * Persist global CLIProxyAPI metadata without creating routing rules for every
 * active provider. Provider routing is an explicit opt-in through that
 * provider's upstream_proxy_config row.
 *
 * The cliproxyapi row is storage-only. Keeping it disabled/native prevents the
 * embedded provider from recursively falling back to itself.
 */
export async function persistGlobalCliproxyapiConfig({
  cliproxyapiModelMapping,
}: GlobalCliproxyapiConfig) {
  const existing =
    cliproxyapiModelMapping === undefined ? await getUpstreamProxyConfig("cliproxyapi") : null;
  return upsertUpstreamProxyConfig({
    providerId: "cliproxyapi",
    mode: "native",
    enabled: false,
    cliproxyapiModelMapping: cliproxyapiModelMapping ?? existing?.cliproxyapiModelMapping ?? null,
  });
}
