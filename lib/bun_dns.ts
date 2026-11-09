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
import { promises as nodeDns } from "node:dns";

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

export interface ResolverLatencyMetric {
  readonly backend: DnsResolverBackend;
  readonly samplesMs: readonly number[];
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly addresses: readonly string[];
}

export interface ResolverBenchmarkResult {
  readonly hostname: string;
  readonly timestamp: string;
  readonly metrics: readonly ResolverLatencyMetric[];
  readonly fastestBackend: DnsResolverBackend;
  readonly speedupFactor: number;
}

export interface ReverseDnsClassification {
  readonly ipAddress: string;
  readonly hostnames: readonly string[];
  readonly primaryHostname: string | null;
  readonly isDatacenterOrCloud: boolean;
  readonly isVpnOrProxySuspicious: boolean;
  readonly organization: string;
}

export interface DnsRecordSet {
  readonly hostname: string;
  readonly aRecords: readonly string[];
  readonly aaaaRecords: readonly string[];
  readonly mxRecords: ReadonlyArray<{ exchange: string; priority: number }>;
  readonly txtRecords: readonly string[][];
  readonly cnameRecords: readonly string[];
  readonly timestamp: string;
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

/**
 * Benchmarks resolution latency between resolver backends ("c-ares" vs "system" vs "libc")
 * for high-frequency trading and low-latency betting operations.
 */
export async function benchmarkResolverLatency(
  hostname: string,
  backends: readonly DnsResolverBackend[] = ["c-ares", "system"],
  sampleCount: number = 3,
): Promise<ResolverBenchmarkResult> {
  const metrics: ResolverLatencyMetric[] = [];

  for (const backend of backends) {
    const samples: number[] = [];
    let addresses: string[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const t0 = performance.now();
      try {
        const records = await dns.lookup(hostname, { backend });
        const elapsed = performance.now() - t0;
        samples.push(Math.round(elapsed * 1000) / 1000);
        addresses = records.map((r) => r.address);
      } catch {
        const elapsed = performance.now() - t0;
        samples.push(Math.round(elapsed * 1000) / 1000);
      }
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const minMs = sorted[0] ?? 0;
    const maxMs = sorted[sorted.length - 1] ?? 0;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const meanMs =
      sorted.length > 0 ? Math.round((sum / sorted.length) * 1000) / 1000 : 0;
    const p50Ms = sorted[Math.floor(sorted.length * 0.5)] ?? minMs;
    const p99Ms = sorted[Math.floor(sorted.length * 0.99)] ?? maxMs;

    metrics.push({
      backend,
      samplesMs: samples,
      minMs,
      maxMs,
      meanMs,
      p50Ms,
      p99Ms,
      addresses,
    });
  }

  const sortedMetrics = [...metrics].sort((a, b) => a.meanMs - b.meanMs);
  const fastest = sortedMetrics[0] ?? { backend: "system", meanMs: 1 };
  const slowest = sortedMetrics[sortedMetrics.length - 1] ?? {
    backend: "system",
    meanMs: 1,
  };
  const speedup =
    fastest.meanMs > 0
      ? Math.round((slowest.meanMs / fastest.meanMs) * 10) / 10
      : 1.0;

  return {
    hostname,
    timestamp: new Date().toISOString(),
    metrics,
    fastestBackend: fastest.backend,
    speedupFactor: Math.max(1.0, speedup),
  };
}

/**
 * Performs reverse DNS verification and hosting/proxy classification on incoming bettor IP addresses.
 */
export async function classifyIpAddress(
  ipAddress: string,
): Promise<ReverseDnsClassification> {
  let hostnames: string[] = [];
  try {
    hostnames = await nodeDns.reverse(ipAddress);
  } catch {
    // Reverse resolution may fail for unmapped IP literals
  }

  const primaryHostname = hostnames[0] ?? null;
  const combinedHostText = hostnames.join(" ").toLowerCase();

  let isDatacenterOrCloud = false;
  let isVpnOrProxySuspicious = false;
  let organization = "Residential/Unknown ISP";

  if (
    combinedHostText.includes("amazonaws.com") ||
    combinedHostText.includes("aws")
  ) {
    isDatacenterOrCloud = true;
    organization = "Amazon Web Services (AWS)";
  } else if (
    combinedHostText.includes("cloudflare") ||
    combinedHostText.includes("1.1.1.1") ||
    combinedHostText.includes("one.one.one.one")
  ) {
    isDatacenterOrCloud = true;
    organization = "Cloudflare Edge";
  } else if (
    combinedHostText.includes("google") ||
    combinedHostText.includes("1e100.net")
  ) {
    isDatacenterOrCloud = true;
    organization = "Google Cloud Platform";
  } else if (combinedHostText.includes("digitalocean")) {
    isDatacenterOrCloud = true;
    organization = "DigitalOcean VPS";
  } else if (
    combinedHostText.includes("hetzner") ||
    combinedHostText.includes("your-server.de")
  ) {
    isDatacenterOrCloud = true;
    organization = "Hetzner Online";
  } else if (combinedHostText.includes("ovh")) {
    isDatacenterOrCloud = true;
    organization = "OVHcloud";
  }

  if (
    combinedHostText.includes("vpn") ||
    combinedHostText.includes("proxy") ||
    combinedHostText.includes("tor") ||
    combinedHostText.includes("relay") ||
    combinedHostText.includes("exit")
  ) {
    isVpnOrProxySuspicious = true;
  }

  return {
    ipAddress,
    hostnames,
    primaryHostname,
    isDatacenterOrCloud,
    isVpnOrProxySuspicious,
    organization,
  };
}

/**
 * Resolves standard DNS resource records (A, AAAA, MX, TXT, CNAME) using Bun's native methods.
 */
export async function resolveDnsRecordSet(
  hostname: string,
): Promise<DnsRecordSet> {
  let aRecords: string[] = [];
  let aaaaRecords: string[] = [];
  let mxRecords: Array<{ exchange: string; priority: number }> = [];
  let txtRecords: string[][] = [];
  let cnameRecords: string[] = [];

  try {
    aRecords = await nodeDns.resolve(hostname, "A");
  } catch {}
  try {
    aaaaRecords = await nodeDns.resolve(hostname, "AAAA");
  } catch {}
  try {
    mxRecords = (await nodeDns.resolveMx(hostname)) as Array<{
      exchange: string;
      priority: number;
    }>;
  } catch {}
  try {
    txtRecords = (await nodeDns.resolveTxt(hostname)) as string[][];
  } catch {}
  try {
    cnameRecords = await nodeDns.resolveCname(hostname);
  } catch {}

  return {
    hostname,
    aRecords,
    aaaaRecords,
    mxRecords,
    txtRecords,
    cnameRecords,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Continuous background DNS cache warmer for mission-critical trading and betting desk operations.
 */
export class ContinuousDnsWarmingManager {
  private timer: Timer | null = null;
  private isRunning = false;

  constructor(
    private readonly hosts: readonly HostTarget[] = SPORTSDESK_CORE_HOSTS,
    private readonly intervalMs: number = 20_000,
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    // Initial warmup
    prefetchSportsDeskEndpoints(this.hosts);
    this.timer = setInterval(() => {
      prefetchSportsDeskEndpoints(this.hosts);
    }, this.intervalMs);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public active(): boolean {
    return this.isRunning;
  }
}
