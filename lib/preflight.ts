/**
 * @file lib/preflight.ts
 * @description Name resolution and TLS reachability check before a capture run.
 *
 * Without it, a DNS failure surfaces as a WebView `navigate` error or a `fetch` rejection, which
 * reads like a portal problem. This distinguishes "the name does not resolve" from "the handshake
 * failed" from "the page did not load".
 */

import { type TlsProvenance, probeTls } from "./tls_provenance.ts";

export interface DnsAnswer {
  readonly address: string;
  readonly family: number;
  readonly ttl: number;
}

export interface PreflightResult {
  readonly host: string;
  readonly port: number;
  readonly dns: readonly DnsAnswer[];
  readonly tls: TlsProvenance | null;
  readonly ok: boolean;
  readonly error: string | null;
  readonly dnsPrefetched?: boolean;
  readonly dnsCacheStats?: Record<string, number>;
}

/**
 * Pre-warm Bun's DNS cache before WebView navigate / fetch (see bun.com/docs/runtime/networking/dns).
 *
 * `Bun.dns.prefetch` throws `RangeError` for a non-integer or out-of-range port
 * (measured on Bun 1.4.4: `443.5`, `65536`, `-1`, `NaN`, `Infinity` throw; `0`,
 * `1` and `65535` are accepted). Prefetching is best-effort, so an unusable port
 * is skipped rather than propagated — port `0` is accepted by Bun but means
 * nothing to a prefetch, so it is skipped too.
 */
export function prefetchDns(host: string, port = 443): void {
  const trimmed = host.trim();
  if (trimmed === "") return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  Bun.dns.prefetch(trimmed, port);
}

export function readDnsCacheStats(): Record<string, number> | undefined {
  try {
    const stats = Bun.dns.getCacheStats?.();
    if (typeof stats !== "object" || stats === null) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * DNS prefetch + optional fetch.preconnect for HTTPS capture bases.
 */
export function warmCaptureNetwork(baseUrl: string): {
  host: string;
  port: number;
} {
  const parsed = new URL(baseUrl);
  const port =
    parsed.port !== ""
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
  prefetchDns(parsed.hostname, port);
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    try {
      fetch.preconnect(parsed.origin);
    } catch {
      // preconnect is best-effort
    }
  }
  return { host: parsed.hostname, port };
}

export async function resolveHost(host: string): Promise<DnsAnswer[]> {
  const answers = await Bun.dns.lookup(host);
  return answers.map((answer) => ({
    address: String(answer.address),
    family: Number(answer.family),
    ttl: Number(answer.ttl),
  }));
}

export async function preflight(
  host: string,
  options: {
    port?: number;
    timeoutMs?: number;
    skipDnsPrefetch?: boolean;
  } = {},
): Promise<PreflightResult> {
  const port = options.port ?? 443;
  if (!options.skipDnsPrefetch) prefetchDns(host, port);
  const dnsCacheStats = readDnsCacheStats();
  let dns: DnsAnswer[] = [];
  try {
    dns = await resolveHost(host);
  } catch (error) {
    return {
      host,
      port,
      dns: [],
      tls: null,
      ok: false,
      error: `DNS lookup failed for ${host}: ${(error as Error).message}`,
      dnsPrefetched: !options.skipDnsPrefetch,
      ...(dnsCacheStats ? { dnsCacheStats } : {}),
    };
  }

  try {
    const tls = await probeTls({
      host,
      port,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    return {
      host,
      port,
      dns,
      tls,
      ok: true,
      error: null,
      dnsPrefetched: !options.skipDnsPrefetch,
      ...(dnsCacheStats ? { dnsCacheStats } : {}),
    };
  } catch (error) {
    return {
      host,
      port,
      dns,
      tls: null,
      ok: false,
      error: `TLS handshake failed for ${host}:${port}: ${(error as Error).message}`,
      dnsPrefetched: !options.skipDnsPrefetch,
      ...(dnsCacheStats ? { dnsCacheStats } : {}),
    };
  }
}

export function formatPreflight(result: PreflightResult): string {
  if (!result.ok) return `preflight: ${result.error ?? "failed"}`;
  const tls = result.tls;
  const addresses = result.dns.map((answer) => answer.address).join(", ");
  return [
    `preflight: ${result.host}:${result.port} resolves (${result.dns.length} address(es): ${addresses})`,
    tls === null
      ? "  tls: not probed"
      : `  tls: ${tls.tlsVersion} ${tls.cipher.name} · authorized=${tls.authorized} · ${tls.connectMs} ms`,
  ].join("\n");
}
