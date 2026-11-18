/**
 * Network options shared by the F402 puller and the protocol matrix probe: host override, DNS
 * prefetch, Bun's DNS cache TTL, IP family and HTTP version. Precedence is flag > env > default.
 *
 * The DNS cache TTL and the IP family are Bun launch settings, not runtime APIs: Bun reads
 * `BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS` and `BUN_FEATURE_FLAG_DISABLE_IPV4/6` once, at the first
 * DNS use (src/runtime/dns_jsc/dns.rs `get_max_dns_time_to_live_seconds`, `get_hints`), and a later
 * `process.env` write is ignored. When the requested values differ from the launch environment the
 * CLI runs itself again once with them set ({@link relaunchForBunNetworkEnv}). See
 * docs/runbooks/f402_session_refresh.md "Transport and protocols".
 */

import {
  F402_HTTP_VERSION_ENV,
  F402FetchSessionConfigError,
  type F402FetchSessionPool,
  type F402HttpVersion,
  parseF402HttpVersion,
} from "./f402_fetch_sessions.ts";
import { readDnsCacheStats } from "./preflight.ts";

export const F402_HOST_ENV = "F402_HOST";
export const F402_DNS_PREFETCH_ENV = "F402_DNS_PREFETCH";
export const F402_DNS_CACHE_TTL_ENV = "F402_DNS_CACHE_TTL_SECONDS";
export const F402_IP_FAMILY_ENV = "F402_IP_FAMILY";
export const F402_NET_RELAUNCHED_ENV = "F402_NET_RELAUNCHED";

export const BUN_DNS_TTL_ENV = "BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS";
export const BUN_DISABLE_IPV4_ENV = "BUN_FEATURE_FLAG_DISABLE_IPV4";
export const BUN_DISABLE_IPV6_ENV = "BUN_FEATURE_FLAG_DISABLE_IPV6";
export const BUN_DEFAULT_DNS_TTL_SECONDS = 30;
const MAX_DNS_TTL_SECONDS = 0xffff_ffff;

export const F402_IP_FAMILIES = ["auto", "4", "6"] as const;
export type F402IpFamily = (typeof F402_IP_FAMILIES)[number];

export class F402NetOptionsError extends Error {
  readonly option: string;

  constructor(option: string, message: string) {
    super(`${option}: ${message}`);
    this.name = "F402NetOptionsError";
    this.option = option;
  }
}

export const F402_NET_ARG_OPTIONS = {
  host: { type: "string" },
  "dns-prefetch": { type: "boolean", default: false },
  "no-dns-prefetch": { type: "boolean", default: false },
  "dns-cache-ttl": { type: "string" },
  family: { type: "string" },
  "http-version": { type: "string" },
  verbose: { type: "boolean", default: false },
} as const;

export const F402_NET_USAGE = `Network (flag > env > default):
  --host <hostname>        Replace the host of the base URL; scheme and port are kept (${F402_HOST_ENV})
  --dns-prefetch           Prefetch each origin's host once before its first request (default; ${F402_DNS_PREFETCH_ENV}=1)
  --no-dns-prefetch        Skip the prefetch (${F402_DNS_PREFETCH_ENV}=0)
  --dns-cache-ttl <s>      Bun DNS cache lifetime in whole seconds, Bun default ${BUN_DEFAULT_DNS_TTL_SECONDS} (${F402_DNS_CACHE_TTL_ENV}); set at launch, so the CLI reruns itself once
  --family <auto|4|6>      IP family for fetch connections, prefetch and lookups (${F402_IP_FAMILY_ENV}); set at launch, like the TTL
  --http-version <auto|1.1|2>  HTTP version for F402 fetch sessions (${F402_HTTP_VERSION_ENV}); 2 needs https
  --verbose                Print the network options and Bun.dns.getCacheStats() as JSON on stderr`;

export interface F402NetOptions {
  readonly host: string | null;
  readonly dnsPrefetch: boolean;
  readonly dnsCacheTtlSeconds: number | null;
  readonly family: F402IpFamily;
  readonly httpVersion: F402HttpVersion;
  readonly verbose: boolean;
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function parseF402Host(value: string, option = "--host"): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new F402NetOptionsError(option, "is empty");
  if (/[\s/\\@?#%]/.test(trimmed)) {
    throw new F402NetOptionsError(
      option,
      `must be a bare hostname with no scheme, path, credentials, query or fragment, got ${JSON.stringify(trimmed)}`,
    );
  }
  const bracketed = trimmed.startsWith("[") && trimmed.endsWith("]");
  if (!bracketed && trimmed.includes(":")) {
    throw new F402NetOptionsError(
      option,
      `must not carry a port or scheme (the port comes from the base URL; write an IPv6 address as [addr]), got ${JSON.stringify(trimmed)}`,
    );
  }
  if (trimmed.length > 253) {
    throw new F402NetOptionsError(option, "is longer than 253 characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${trimmed}`);
  } catch {
    throw new F402NetOptionsError(
      option,
      `is not a valid hostname: ${JSON.stringify(trimmed)}`,
    );
  }
  if (parsed.hostname !== trimmed.toLowerCase()) {
    throw new F402NetOptionsError(
      option,
      `is not a canonical ASCII hostname (got ${JSON.stringify(trimmed)}, URL reads ${JSON.stringify(parsed.hostname)})`,
    );
  }
  return parsed.hostname;
}

export function applyHostOverride(
  baseUrl: string,
  host: string | null,
): string {
  if (host === null) return baseUrl;
  const url = new URL(baseUrl);
  url.hostname = host;
  return url.origin;
}

function parseBooleanEnv(value: string, option: string): boolean {
  const lowered = value.trim().toLowerCase();
  if (lowered === "1" || lowered === "true") return true;
  if (lowered === "0" || lowered === "false") return false;
  throw new F402NetOptionsError(
    option,
    `must be 1, 0, true or false, got ${JSON.stringify(value)}`,
  );
}

export function parseDnsCacheTtl(
  value: string,
  option = "--dns-cache-ttl",
): number {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "off") {
    throw new F402NetOptionsError(
      option,
      "Bun's DNS cache cannot be turned off; 0 is the shortest lifetime (an entry expires once it is over 0 whole seconds old)",
    );
  }
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > MAX_DNS_TTL_SECONDS) {
    throw new F402NetOptionsError(
      option,
      `must be a whole number of seconds from 0 to ${MAX_DNS_TTL_SECONDS}, got ${JSON.stringify(value)}`,
    );
  }
  return Number(trimmed);
}

export function parseIpFamily(
  value: string,
  option = "--family",
): F402IpFamily {
  const trimmed = value.trim();
  if ((F402_IP_FAMILIES as readonly string[]).includes(trimmed)) {
    return trimmed as F402IpFamily;
  }
  throw new F402NetOptionsError(
    option,
    `must be one of ${F402_IP_FAMILIES.join(", ")}, got ${JSON.stringify(value)}`,
  );
}

function parseHttpVersionOption(
  value: string,
  option: string,
): F402HttpVersion {
  try {
    return parseF402HttpVersion(value);
  } catch (error) {
    if (error instanceof F402FetchSessionConfigError) {
      throw new F402NetOptionsError(
        option,
        `must be one of auto, 1.1, 2, got ${JSON.stringify(value)}`,
      );
    }
    throw error;
  }
}

export function resolveF402NetOptions(
  values: Record<string, unknown>,
  env: Env = Bun.env,
): F402NetOptions {
  if (values["dns-prefetch"] === true && values["no-dns-prefetch"] === true) {
    throw new F402NetOptionsError(
      "--dns-prefetch",
      "cannot be combined with --no-dns-prefetch",
    );
  }

  const hostFlag = nonEmpty(values.host);
  const hostEnv = nonEmpty(env[F402_HOST_ENV]);
  const host =
    hostFlag !== undefined
      ? parseF402Host(hostFlag)
      : hostEnv !== undefined
        ? parseF402Host(hostEnv, F402_HOST_ENV)
        : null;

  const prefetchEnv = nonEmpty(env[F402_DNS_PREFETCH_ENV]);
  const dnsPrefetch =
    values["no-dns-prefetch"] === true
      ? false
      : values["dns-prefetch"] === true
        ? true
        : prefetchEnv !== undefined
          ? parseBooleanEnv(prefetchEnv, F402_DNS_PREFETCH_ENV)
          : true;

  const ttlFlag = nonEmpty(values["dns-cache-ttl"]);
  const ttlEnv = nonEmpty(env[F402_DNS_CACHE_TTL_ENV]);
  const dnsCacheTtlSeconds =
    ttlFlag !== undefined
      ? parseDnsCacheTtl(ttlFlag)
      : ttlEnv !== undefined
        ? parseDnsCacheTtl(ttlEnv, F402_DNS_CACHE_TTL_ENV)
        : null;

  const familyFlag = nonEmpty(values.family);
  const familyEnv = nonEmpty(env[F402_IP_FAMILY_ENV]);
  const family =
    familyFlag !== undefined
      ? parseIpFamily(familyFlag)
      : familyEnv !== undefined
        ? parseIpFamily(familyEnv, F402_IP_FAMILY_ENV)
        : "auto";

  const versionFlag = nonEmpty(values["http-version"]);
  const versionEnv = nonEmpty(env[F402_HTTP_VERSION_ENV]);
  const httpVersion =
    versionFlag !== undefined
      ? parseHttpVersionOption(versionFlag, "--http-version")
      : versionEnv !== undefined
        ? parseHttpVersionOption(versionEnv, F402_HTTP_VERSION_ENV)
        : "auto";

  return {
    host,
    dnsPrefetch,
    dnsCacheTtlSeconds,
    family,
    httpVersion,
    verbose: values.verbose === true,
  };
}

function bunFlagOn(value: string | undefined): boolean {
  const lowered = value?.trim().toLowerCase();
  return lowered === "1" || lowered === "true";
}

/** The IP family Bun's resolver uses for fetch, as `get_hints` derives it from the launch env. */
export function effectiveBunFamily(env: Env = Bun.env): F402IpFamily {
  if (bunFlagOn(env[BUN_DISABLE_IPV6_ENV])) return "4";
  if (bunFlagOn(env[BUN_DISABLE_IPV4_ENV])) return "6";
  return "auto";
}

export function effectiveBunDnsTtlSeconds(env: Env = Bun.env): number {
  const raw = env[BUN_DNS_TTL_ENV]?.trim();
  return raw !== undefined &&
    /^\d+$/.test(raw) &&
    Number(raw) <= MAX_DNS_TTL_SECONDS
    ? Number(raw)
    : BUN_DEFAULT_DNS_TTL_SECONDS;
}

/**
 * The launch env changes needed for `options`, or null when the current launch env already
 * matches. `--family auto` leaves any Bun family flag the operator launched with in place.
 */
export function bunNetworkEnvChanges(
  options: F402NetOptions,
  env: Env = Bun.env,
): Record<string, string | undefined> | null {
  const changes: Record<string, string | undefined> = {};
  if (
    options.dnsCacheTtlSeconds !== null &&
    env[BUN_DNS_TTL_ENV]?.trim() !== String(options.dnsCacheTtlSeconds)
  ) {
    changes[BUN_DNS_TTL_ENV] = String(options.dnsCacheTtlSeconds);
  }
  if (options.family !== "auto" && effectiveBunFamily(env) !== options.family) {
    changes[BUN_DISABLE_IPV6_ENV] = options.family === "4" ? "1" : undefined;
    changes[BUN_DISABLE_IPV4_ENV] = options.family === "6" ? "1" : undefined;
  }
  return Object.keys(changes).length === 0 ? null : changes;
}

export interface RelaunchDeps {
  readonly env?: Env;
  readonly argv?: readonly string[];
  readonly spawn?: (cmd: string[], env: Env) => Promise<number>;
}

async function spawnInherit(cmd: string[], env: Env): Promise<number> {
  const proc = Bun.spawn(cmd, {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

/**
 * Runs this CLI once more with Bun's DNS TTL / family launch env set, and returns its exit code;
 * returns null when the current process already has them. Call before any DNS use.
 */
export async function relaunchForBunNetworkEnv(
  options: F402NetOptions,
  deps: RelaunchDeps = {},
): Promise<number | null> {
  const env = deps.env ?? Bun.env;
  const changes = bunNetworkEnvChanges(options, env);
  if (changes === null) return null;
  if (env[F402_NET_RELAUNCHED_ENV] === "1") {
    throw new F402NetOptionsError(
      "--dns-cache-ttl/--family",
      `the relaunched process still lacks ${Object.keys(changes).join(", ")}`,
    );
  }
  const childEnv: Env = { ...env, [F402_NET_RELAUNCHED_ENV]: "1" };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const argv = deps.argv ?? [
    process.execPath,
    ...process.execArgv,
    Bun.main,
    ...process.argv.slice(2),
  ];
  return await (deps.spawn ?? spawnInherit)([...argv], childEnv);
}

export function applyF402NetOptions(
  options: F402NetOptions,
  pool: F402FetchSessionPool,
): void {
  pool.configure({
    httpVersion: options.httpVersion,
    dnsPrefetch: options.dnsPrefetch,
  });
}

export interface F402NetReport {
  readonly kind: "f402-net";
  readonly host: string | null;
  readonly dnsPrefetch: boolean;
  readonly dnsCacheTtlSeconds: number;
  readonly family: F402IpFamily;
  readonly httpVersion: F402HttpVersion;
  readonly dnsCacheStats: Record<string, number> | null;
}

export function f402NetReport(
  options: F402NetOptions,
  env: Env = Bun.env,
): F402NetReport {
  return {
    kind: "f402-net",
    host: options.host,
    dnsPrefetch: options.dnsPrefetch,
    dnsCacheTtlSeconds: effectiveBunDnsTtlSeconds(env),
    family: effectiveBunFamily(env),
    httpVersion: options.httpVersion,
    dnsCacheStats: readDnsCacheStats() ?? null,
  };
}
