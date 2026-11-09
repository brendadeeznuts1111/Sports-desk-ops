/**
 * @file lib/bun_dns.ts
 * @description Bun Native DNS Runtime & Cache Optimization Engine (Bun v1.4+).
 *
 * Implements:
 *  - DNS Prefetching for SportsDesk & Fantasy402 critical network hosts
 *  - Resolver Backend Selection ("c-ares" | "system" | "getaddrinfo" | "libc")
 *  - Real-time DNS Cache Telemetry via Bun's native dns.getCacheStats()
 *  - Zero-latency connection warming for Telegram bot, Cloudflare R2, and Portal APIs
 *
 * @see https://bun.com/docs/runtime/networking/dns
 */

import { dns } from "bun";

export type DnsResolverBackend = "c-ares" | "system" | "getaddrinfo" | "libc";

export interface HostTarget {
  readonly hostname: string;
  readonly port: number;
  readonly serviceName: string;
}

/**
 * Mission-critical SportsDesk network targets for DNS prefetching.
 */
export const SPORTSDESK_CORE_HOSTS: readonly HostTarget[] = [
  {
    hostname: "fantasy402.com",
    port: 443,
    serviceName: "Fantasy402 Manager Portal",
  },
  {
    hostname: "pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
    port: 443,
    serviceName: "Cloudflare R2 Public Gateway",
  },
  {
    hostname: "api.telegram.org",
    port: 443,
    serviceName: "Telegram Bot API (@demodevdeskbot)",
  },
  {
    hostname: "desk.bookdeskops.com",
    port: 443,
    serviceName: "SportsDesk VPS & Manager Desk",
  },
  {
    hostname: "clob.polymarket.com",
    port: 443,
    serviceName: "Polymarket CLOB Trading API",
  },
  {
    hostname: "gamma-api.polymarket.com",
    port: 443,
    serviceName: "Polymarket Gamma Markets API",
  },
] as const;

export interface DnsCacheTelemetry {
  readonly cacheHitsCompleted: number;
  readonly cacheHitsInflight: number;
  readonly cacheMisses: number;
  readonly size: number;
  readonly errors: number;
  readonly totalCount: number;
  readonly hitRatePercent: number;
  readonly defaultTtlSeconds: number;
}

/**
 * Prefetches DNS entries across all core SportsDesk external services to warm
 * Bun's 256-entry LRU DNS cache before operational HTTP requests.
 */
export function prefetchSportsDeskEndpoints(
  hosts: readonly HostTarget[] = SPORTSDESK_CORE_HOSTS,
): number {
  let count = 0;
  for (const target of hosts) {
    try {
      dns.prefetch(target.hostname, target.port);
      count++;
    } catch {
      // Non-fatal prefetch failure
    }
  }
  return count;
}

/**
 * Captures real-time DNS cache statistics from Bun's native networking subsystem.
 */
export function getDnsTelemetry(): DnsCacheTelemetry {
  const stats = dns.getCacheStats();
  const hits = stats.cacheHitsCompleted + stats.cacheHitsInflight;
  const hitRatePercent =
    stats.totalCount > 0
      ? Math.round((hits / stats.totalCount) * 1000) / 10
      : 0.0;

  const defaultTtlSeconds =
    Number(process.env.BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS) || 30;

  return {
    cacheHitsCompleted: stats.cacheHitsCompleted,
    cacheHitsInflight: stats.cacheHitsInflight,
    cacheMisses: stats.cacheMisses,
    size: stats.size,
    errors: stats.errors,
    totalCount: stats.totalCount,
    hitRatePercent,
    defaultTtlSeconds,
  };
}

export interface DnsLookupRecord {
  readonly address: string;
  readonly family: 4 | 6 | number;
  readonly ttl?: number;
}

/**
 * Resolves a hostname using an explicit Bun DNS resolver backend.
 * Default on macOS/Windows is "system"; on Linux default is "c-ares".
 */
export async function lookupHost(
  hostname: string,
  backend: DnsResolverBackend = "system",
): Promise<readonly DnsLookupRecord[]> {
  try {
    const records = await dns.lookup(hostname, { backend });
    return records;
  } catch (err) {
    throw new Error(
      `DNS lookup failed for ${hostname} using backend ${backend}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Resolves the primary IP address for a host using Bun's native dns.lookup().
 *
 * @example
 * ```ts
 * const [{ address }] = await dns.lookup("example.com", { backend: "system" });
 * ```
 */
export async function resolvePrimaryAddress(
  hostname: string,
  backend: DnsResolverBackend = "system",
): Promise<string | null> {
  const records = await lookupHost(hostname, backend);
  return records[0]?.address ?? null;
}

/**
 * Formats DNS telemetry as a Markdown table for dashboards or terminal output.
 */
export function formatDnsTelemetryMarkdown(): string {
  const telemetry = getDnsTelemetry();
  return (
    `### 🌐 Bun Native DNS Cache & Networking Telemetry\n\n` +
    `| Metric | Value | Reference / Notes |\n` +
    `|:---|:---:|:---|\n` +
    `| **Cache Size** | \`${telemetry.size} / 256 entries\` | Max capacity: 256 concurrent entries |\n` +
    `| **Hit Rate** | \`${telemetry.hitRatePercent}%\` | Shared across \`fetch()\`, \`Bun.connect\`, HTTP client |\n` +
    `| **Cache Hits (Completed)** | \`${telemetry.cacheHitsCompleted}\` | Cached zero-latency lookups |\n` +
    `| **Cache Hits (Inflight)** | \`${telemetry.cacheHitsInflight}\` | Simultaneous connections joined into 1 lookup |\n` +
    `| **Cache Misses** | \`${telemetry.cacheMisses}\` | Network DNS queries dispatched |\n` +
    `| **Errors** | \`${telemetry.errors}\` | Connection / resolution failures |\n` +
    `| **Cache TTL** | \`${telemetry.defaultTtlSeconds}s\` | Configurable via \`$BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS\` |\n`
  );
}
