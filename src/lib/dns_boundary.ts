/**
 * @file src/lib/dns_boundary.ts
 * @description L1–L3 Bun.dns boundaries:
 *   - L1: Hostname normalization, syntax/zone-ID rejection, and strict IP-family lookup
 *   - L2: Safe Bun.dns.prefetch port/host validation and SSRF/egress IP scope filtering
 *   - L3: Bun.dns.getCacheStats() telemetry validation, error-ratio/pressure gates, and TTL validation
 */

import { isIP } from "node:net";

export type DnsBoundaryErrorCode =
  | "ERR_DNS_INVALID_HOSTNAME"
  | "ERR_DNS_IPV6_ZONE_FORBIDDEN"
  | "ERR_DNS_LOOKUP_FAILED"
  | "ERR_DNS_LOOKUP_TIMEOUT"
  | "ERR_DNS_FAMILY_MISMATCH"
  | "ERR_DNS_INVALID_PORT"
  | "ERR_DNS_EGRESS_IP_FORBIDDEN"
  | "ERR_DNS_INVALID_TTL"
  | "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE"
  | "ERR_DNS_CACHE_PRESSURE";

export type DnsIpFamily = 4 | 6;
export type DnsLookupBackend = "c-ares" | "system" | "getaddrinfo" | "libc";

export interface RawDnsLookupRecord {
  readonly address: string;
  readonly family: number;
  readonly ttl?: number;
}

export type DnsLookupFn = (
  hostname: string,
  options: {
    readonly family: DnsIpFamily;
    readonly backend: DnsLookupBackend;
  },
) => Promise<readonly RawDnsLookupRecord[]>;

export interface StrictDnsLookupOptions {
  readonly family: DnsIpFamily;
  readonly backend?: DnsLookupBackend;
  readonly timeoutMs?: number;
  readonly lookupFn?: DnsLookupFn;
}

export interface StrictDnsLookupRecord {
  readonly address: string;
  readonly family: DnsIpFamily;
  readonly ttl: number;
}

export type IpAddressScope =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "cgnat"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "documentation"
  | "benchmark";

export const DNS_CACHE_CAPACITY = 256 as const;
export const DEFAULT_DNS_TTL_SECONDS = 30 as const;
export const MAX_DNS_TTL_SECONDS = 86_400 as const;

export interface DnsCacheStatsSnapshot {
  readonly cacheHitsCompleted: number;
  readonly cacheHitsInflight: number;
  readonly cacheMisses: number;
  readonly size: number;
  readonly errors: number;
  readonly totalCount: number;
}

export interface DnsTtlValidationOptions {
  readonly minSeconds?: number;
  readonly maxSeconds?: number;
  readonly fallbackSeconds?: number;
}

export interface DnsCacheHealthOptions {
  readonly maxErrorRatioBps?: number;
  readonly minSamplesForErrorGate?: number;
  readonly maxOccupancyBps?: number;
  readonly capacity?: number;
  readonly stats?: DnsCacheStatsSnapshot;
}

export interface DnsCacheHealthReport {
  readonly stats: DnsCacheStatsSnapshot;
  readonly cacheHitsTotal: number;
  readonly classifiedRequests: number;
  readonly hitRateBps: number;
  readonly errorRatioBps: number;
  readonly occupancyBps: number;
  readonly capacity: number;
}

export class DnsBoundaryError extends Error {
  readonly code: DnsBoundaryErrorCode;

  constructor(
    code: DnsBoundaryErrorCode,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "DnsBoundaryError";
    this.code = code;
  }
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const ALL_DIGITS_RE = /^\d+$/;
const FORBIDDEN_HOST_CHARS_RE = /[\s/?#@[\]\\]/;
const IPV6_HEXTET_RE = /^[0-9a-f]{1,4}$/i;

function hasAsciiControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * L1: Validate and normalize a hostname or bare IP literal before passing it to `Bun.dns`.
 * Rejects schemes, ports, brackets, whitespace, control characters, malformed IPv4 literals, and IPv6 zone IDs.
 */
export function assertCleanHostname(rawHost: string): string {
  if (typeof rawHost !== "string" || rawHost === "") {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      "Hostname must be a non-empty string",
    );
  }

  if (rawHost.includes("%")) {
    throw new DnsBoundaryError(
      "ERR_DNS_IPV6_ZONE_FORBIDDEN",
      "IPv6 zone identifiers are forbidden",
    );
  }

  if (
    hasAsciiControlChar(rawHost) ||
    rawHost !== rawHost.trim() ||
    rawHost.includes("://") ||
    FORBIDDEN_HOST_CHARS_RE.test(rawHost)
  ) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Invalid hostname syntax: ${rawHost}`,
    );
  }

  const ipVersion = isIP(rawHost);
  if (ipVersion === 4) {
    return rawHost;
  }
  if (ipVersion === 6) {
    return rawHost.toLowerCase();
  }

  if (rawHost.includes(":")) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Ports and unbracketed colons are invalid in hostname: ${rawHost}`,
    );
  }

  const stripped = rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost;
  if (
    stripped === "" ||
    stripped.length > 253 ||
    stripped.startsWith(".") ||
    stripped.endsWith(".") ||
    stripped.includes("..")
  ) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Invalid hostname length or dot placement: ${rawHost}`,
    );
  }

  const labels = stripped.split(".");
  for (const label of labels) {
    if (!DNS_LABEL_RE.test(label)) {
      throw new DnsBoundaryError(
        "ERR_DNS_INVALID_HOSTNAME",
        `Invalid DNS label "${label}" in hostname: ${rawHost}`,
      );
    }
  }

  const finalLabel = labels[labels.length - 1];
  if (finalLabel === undefined || ALL_DIGITS_RE.test(finalLabel)) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Final DNS label cannot be numeric-only: ${rawHost}`,
    );
  }

  return stripped.toLowerCase();
}

/**
 * L1: Resolve a clean hostname via `Bun.dns.lookup` while enforcing the requested IP family.
 */
export async function lookupStrictFamily(
  hostname: string,
  options: StrictDnsLookupOptions,
): Promise<readonly StrictDnsLookupRecord[]> {
  const cleanHost = assertCleanHostname(hostname);

  if (options.family !== 4 && options.family !== 6) {
    throw new DnsBoundaryError(
      "ERR_DNS_FAMILY_MISMATCH",
      `Unsupported IP family: ${String(options.family)}`,
    );
  }

  const backend: DnsLookupBackend = options.backend ?? "system";
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new DnsBoundaryError(
      "ERR_DNS_LOOKUP_FAILED",
      `Invalid lookup timeoutMs: ${String(timeoutMs)}`,
    );
  }

  const doLookup: DnsLookupFn =
    options.lookupFn ?? ((host, opts) => Bun.dns.lookup(host, opts));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rawRecords: readonly RawDnsLookupRecord[];

  try {
    const lookupPromise = doLookup(cleanHost, {
      family: options.family,
      backend,
    });
    lookupPromise.catch(() => {});

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new DnsBoundaryError(
              "ERR_DNS_LOOKUP_TIMEOUT",
              `DNS lookup timed out after ${timeoutMs}ms for ${cleanHost}`,
            ),
          );
        }, timeoutMs);
      });
      rawRecords = await Promise.race([lookupPromise, timeoutPromise]);
    } else {
      rawRecords = await lookupPromise;
    }
  } catch (err) {
    if (err instanceof DnsBoundaryError) {
      throw err;
    }
    throw new DnsBoundaryError(
      "ERR_DNS_LOOKUP_FAILED",
      `DNS lookup failed for ${cleanHost}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  const matched: StrictDnsLookupRecord[] = [];
  for (const rec of rawRecords) {
    const address = String(rec.address);
    if (rec.family === options.family && isIP(address) === options.family) {
      matched.push({
        address,
        family: options.family,
        ttl: typeof rec.ttl === "number" ? rec.ttl : 0,
      });
    }
  }

  if (rawRecords.length === 0) {
    throw new DnsBoundaryError(
      "ERR_DNS_LOOKUP_FAILED",
      `No IPv${options.family} records resolved for ${cleanHost}`,
    );
  }

  if (matched.length === 0) {
    throw new DnsBoundaryError(
      "ERR_DNS_FAMILY_MISMATCH",
      `Resolved records for ${cleanHost} did not match requested IPv${options.family} family`,
    );
  }

  return matched;
}

/**
 * L2: Validate an integer TCP/UDP port in the valid 1..65535 range before `Bun.dns.prefetch`.
 */
export function assertCleanPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_PORT",
      `Port must be an integer between 1 and 65535, got ${String(port)}`,
    );
  }
  return port;
}

/**
 * L2: Validate hostname and port boundaries before invoking `Bun.dns.prefetch`.
 */
export function prefetchHostSafe(
  hostname: string,
  port = 443,
  prefetchFn?: (host: string, port: number) => void,
): { readonly hostname: string; readonly port: number } {
  const cleanHost = assertCleanHostname(hostname);
  const cleanPort: number = assertCleanPort(port);
  if (prefetchFn !== undefined) {
    prefetchFn(cleanHost, cleanPort);
  } else {
    Bun.dns.prefetch(cleanHost, cleanPort);
  }
  return { hostname: cleanHost, port: cleanPort };
}

function parseIpv4Octets(
  addr: string,
): readonly [number, number, number, number] | null {
  if (isIP(addr) !== 4) return null;
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  const d = Number(parts[3]);
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d)
  ) {
    return null;
  }
  return [a, b, c, d];
}

function classifyIpv4Octets(
  a: number,
  b: number,
  c: number,
  _d: number,
): IpAddressScope {
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return "documentation";
  }
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const tokens = side.split(":");
  const out: number[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined || tok === "") return null;
    if (tok.includes(".")) {
      if (i !== tokens.length - 1) return null;
      const octets = parseIpv4Octets(tok);
      if (octets === null) return null;
      out.push(((octets[0] & 0xff) << 8) | (octets[1] & 0xff));
      out.push(((octets[2] & 0xff) << 8) | (octets[3] & 0xff));
      continue;
    }
    if (!IPV6_HEXTET_RE.test(tok)) return null;
    out.push(Number.parseInt(tok, 16));
  }

  return out;
}

function parseIpv6Hextets(addr: string): Uint16Array | null {
  if (isIP(addr) !== 6) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  if (halves.length === 1) {
    const whole = parseIpv6Side(halves[0] ?? "");
    if (whole === null || whole.length !== 8) return null;
    return Uint16Array.from(whole);
  }

  const left = parseIpv6Side(halves[0] ?? "");
  const right = parseIpv6Side(halves[1] ?? "");
  if (left === null || right === null) return null;
  const zeroCount = 8 - (left.length + right.length);
  if (zeroCount <= 0) return null;

  const out = new Uint16Array(8);
  let idx = 0;
  for (const val of left) {
    out[idx] = val;
    idx += 1;
  }
  idx += zeroCount;
  for (const val of right) {
    out[idx] = val;
    idx += 1;
  }
  return out;
}

function classifyHextetPairAsIpv4(hi: number, lo: number): IpAddressScope {
  return classifyIpv4Octets(
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  );
}

function classifyIpv6Hextets(h: Uint16Array): IpAddressScope {
  const h0 = h[0] ?? 0;
  const h1 = h[1] ?? 0;
  const h2 = h[2] ?? 0;
  const h3 = h[3] ?? 0;
  const h4 = h[4] ?? 0;
  const h5 = h[5] ?? 0;
  const h6 = h[6] ?? 0;
  const h7 = h[7] ?? 0;

  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0 &&
    h6 === 0 &&
    h7 === 0
  ) {
    return "unspecified";
  }

  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0 &&
    h6 === 0 &&
    h7 === 1
  ) {
    return "loopback";
  }

  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0xffff
  ) {
    return classifyHextetPairAsIpv4(h6, h7);
  }

  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0xffff &&
    h5 === 0
  ) {
    return classifyHextetPairAsIpv4(h6, h7);
  }

  if (
    h0 === 0x0064 &&
    h1 === 0xff9b &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0
  ) {
    return classifyHextetPairAsIpv4(h6, h7);
  }

  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return "reserved";
  }

  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) {
    return "reserved";
  }

  if (h0 === 0x2001 && h1 === 0x0db8) {
    return "documentation";
  }

  if (h0 === 0x2001 && h1 === 0x0002 && h2 === 0) {
    return "benchmark";
  }

  if (h0 === 0x2002) {
    const embeddedScope = classifyHextetPairAsIpv4(h1, h2);
    if (embeddedScope !== "public") {
      return embeddedScope;
    }
  }

  if ((h0 & 0xfe00) === 0xfc00) return "private";
  if ((h0 & 0xffc0) === 0xfe80) return "link_local";
  if ((h0 & 0xffc0) === 0xfec0) return "private";
  if ((h0 & 0xff00) === 0xff00) return "multicast";

  return "public";
}

/**
 * L2: Classify the routing/egress scope of an IPv4 or IPv6 literal, including embedded IPv4 transitions.
 */
export function classifyIpScope(address: string): IpAddressScope {
  const clean = assertCleanHostname(address);
  const ipVersion = isIP(clean);

  if (ipVersion === 4) {
    const octets = parseIpv4Octets(clean);
    if (octets === null) {
      throw new DnsBoundaryError(
        "ERR_DNS_INVALID_HOSTNAME",
        `Malformed IPv4 literal: ${address}`,
      );
    }
    return classifyIpv4Octets(octets[0], octets[1], octets[2], octets[3]);
  }

  if (ipVersion === 6) {
    const hextets = parseIpv6Hextets(clean);
    if (hextets === null) {
      throw new DnsBoundaryError(
        "ERR_DNS_INVALID_HOSTNAME",
        `Malformed IPv6 literal: ${address}`,
      );
    }
    return classifyIpv6Hextets(hextets);
  }

  throw new DnsBoundaryError(
    "ERR_DNS_INVALID_HOSTNAME",
    `Expected bare IP literal, got "${address}"`,
  );
}

/**
 * L2: Enforce that a literal IP address is globally routable (`"public"` scope).
 */
export function assertPublicIp(address: string): string {
  const clean = assertCleanHostname(address);
  const scope = classifyIpScope(clean);
  if (scope !== "public") {
    throw new DnsBoundaryError(
      "ERR_DNS_EGRESS_IP_FORBIDDEN",
      `IP address ${clean} is in forbidden egress scope "${scope}"`,
    );
  }
  return clean;
}

/**
 * L2: Perform a strict-family lookup and fail closed if any resolved address is non-public.
 */
export async function lookupPublicStrictFamily(
  hostname: string,
  options: StrictDnsLookupOptions,
): Promise<readonly StrictDnsLookupRecord[]> {
  const records = await lookupStrictFamily(hostname, options);
  for (const rec of records) {
    assertPublicIp(rec.address);
  }
  return records;
}

/**
 * L3: Validate a DNS cache TTL value in seconds (`BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS` boundary).
 */
export function assertValidDnsTtlSeconds(
  raw: string | number | undefined,
  options?: DnsTtlValidationOptions,
): number {
  const minSeconds = options?.minSeconds ?? 1;
  const maxSeconds = options?.maxSeconds ?? MAX_DNS_TTL_SECONDS;
  const fallbackSeconds = options?.fallbackSeconds ?? DEFAULT_DNS_TTL_SECONDS;

  if (
    !Number.isInteger(minSeconds) ||
    minSeconds < 1 ||
    !Number.isInteger(maxSeconds) ||
    maxSeconds < minSeconds ||
    !Number.isInteger(fallbackSeconds) ||
    fallbackSeconds < minSeconds ||
    fallbackSeconds > maxSeconds
  ) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_TTL",
      `Invalid TTL bounds: min=${String(minSeconds)}, max=${String(maxSeconds)}, fallback=${String(fallbackSeconds)}`,
    );
  }

  if (raw === undefined) {
    return fallbackSeconds;
  }

  let parsed: number;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!ALL_DIGITS_RE.test(trimmed)) {
      throw new DnsBoundaryError(
        "ERR_DNS_INVALID_TTL",
        `DNS TTL must be an integer string, got "${raw}"`,
      );
    }
    parsed = Number(trimmed);
  } else if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new DnsBoundaryError(
        "ERR_DNS_INVALID_TTL",
        `DNS TTL must be an integer, got ${String(raw)}`,
      );
    }
    parsed = raw;
  } else {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_TTL",
      `Unsupported DNS TTL value: ${String(raw)}`,
    );
  }

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minSeconds ||
    parsed > maxSeconds
  ) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_TTL",
      `DNS TTL ${parsed}s is outside allowed range [${minSeconds}, ${maxSeconds}]`,
    );
  }

  return parsed;
}

function readNonNegativeIntStat(
  obj: Record<string, unknown>,
  key: keyof DnsCacheStatsSnapshot,
): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DnsBoundaryError(
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      `Invalid DNS cache stat "${key}": ${String(value)}`,
    );
  }
  return value;
}

/**
 * L3: Read and validate a `Bun.dns.getCacheStats()` snapshot as non-negative integers.
 */
export function readDnsCacheStatsBoundary(
  getStats?: () => unknown,
): DnsCacheStatsSnapshot {
  const raw = (getStats ?? (() => Bun.dns.getCacheStats()))();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DnsBoundaryError(
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      `Expected Bun.dns.getCacheStats() object, got ${String(raw)}`,
    );
  }

  const record = raw as Record<string, unknown>;
  return Object.freeze({
    cacheHitsCompleted: readNonNegativeIntStat(record, "cacheHitsCompleted"),
    cacheHitsInflight: readNonNegativeIntStat(record, "cacheHitsInflight"),
    cacheMisses: readNonNegativeIntStat(record, "cacheMisses"),
    size: readNonNegativeIntStat(record, "size"),
    errors: readNonNegativeIntStat(record, "errors"),
    totalCount: readNonNegativeIntStat(record, "totalCount"),
  });
}

/**
 * L3: Evaluate DNS cache telemetry against error-ratio (bps) and cache-occupancy pressure thresholds.
 */
export function assertDnsCacheHealthy(
  options?: DnsCacheHealthOptions,
): DnsCacheHealthReport {
  const stats =
    options?.stats !== undefined
      ? readDnsCacheStatsBoundary(() => options.stats)
      : readDnsCacheStatsBoundary();

  const capacity = options?.capacity ?? DNS_CACHE_CAPACITY;
  const maxErrorRatioBps = options?.maxErrorRatioBps ?? 500;
  const minSamplesForErrorGate = options?.minSamplesForErrorGate ?? 1;
  const maxOccupancyBps = options?.maxOccupancyBps ?? 10_000;

  const cacheHitsTotal = stats.cacheHitsCompleted + stats.cacheHitsInflight;
  const classifiedRequests = cacheHitsTotal + stats.cacheMisses;
  const hitRateBps =
    classifiedRequests > 0
      ? Math.round((cacheHitsTotal / classifiedRequests) * 10_000)
      : 0;
  const errorRatioBps =
    stats.totalCount > 0
      ? Math.min(10_000, Math.round((stats.errors / stats.totalCount) * 10_000))
      : 0;
  const occupancyBps =
    capacity > 0 ? Math.round((stats.size / capacity) * 10_000) : 0;

  if (
    stats.totalCount >= minSamplesForErrorGate &&
    errorRatioBps > maxErrorRatioBps
  ) {
    throw new DnsBoundaryError(
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      `DNS cache error ratio ${errorRatioBps} bps exceeds ${maxErrorRatioBps} bps (${stats.errors}/${stats.totalCount})`,
    );
  }

  if (stats.size > capacity || occupancyBps > maxOccupancyBps) {
    throw new DnsBoundaryError(
      "ERR_DNS_CACHE_PRESSURE",
      `DNS cache occupancy ${stats.size}/${capacity} (${occupancyBps} bps) exceeds ${maxOccupancyBps} bps`,
    );
  }

  return Object.freeze({
    stats,
    cacheHitsTotal,
    classifiedRequests,
    hitRateBps,
    errorRatioBps,
    occupancyBps,
    capacity,
  });
}
