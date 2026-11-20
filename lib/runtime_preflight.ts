/**
 * @file runtime_preflight.ts
 * @description Fail-closed bootstrap for a sealed Cloudflare R2 client.
 *
 * Gates, in order:
 *  1. Native bindings (`Bun.S3Client`, `Bun.dns.getCacheStats`) — exit 69
 *  2. Pages token must not coexist with R2 credentials — exit 77
 *  3. Implicit `AWS_*` / `S3_*` env blocked unless opted in — exit 77
 *  4. `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — exit 78
 *  5. Seal ambient `Bun.s3` before any client is constructed — exit 77 if it cannot
 *  5b. Pin `tls.DEFAULT_CIPHERS` to TLS 1.3 and TLS 1.2 AEAD suites — exit 77
 *  6. DNS cache error ratio at most 500 bps (5%) — exit 75
 *  7. Inspect and JSON surfaces must not contain active secrets — exit 77
 */

import tls from "node:tls";
import {
  SealedR2ManifestClient,
  sealGlobalBunS3,
} from "./sealed_r2_manifest_client.ts";
import type { R2ManifestClient } from "./r2_manifest_loader.ts";

export type PreflightErrorCode =
  | "ERR_SPAWN_BINARY_NOT_FOUND"
  | "ERR_CF_TOKEN_BLEED_10000"
  | "ERR_CF_R2_ENV_MISSING"
  | "ERR_BUN_S3_SEAL_FAILED"
  | "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE"
  | "ERR_TLS_WEAK_CIPHER_SUITE"
  | "ERR_INSP_SECRET_REDACTION_LEAK";

export class PreflightError extends Error {
  readonly code: PreflightErrorCode;
  readonly exitCode: number;

  constructor(code: PreflightErrorCode, exitCode: number, message: string) {
    super(`${code}: ${message}`);
    this.name = "PreflightError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface DnsCacheStatsSnapshot {
  readonly cacheHitsCompleted: number;
  readonly cacheHitsInflight: number;
  readonly cacheMisses: number;
  readonly size: number;
  readonly errors: number;
  readonly totalCount: number;
}

export interface TlsCipherPolicySnapshot {
  readonly pinned: boolean;
  readonly tls13Suites: readonly string[];
  readonly aeadSuites: readonly string[];
  readonly totalAllowedSuites: number;
}

/** Default-import surface. `import * as tls` is read-only and throws on assignment. */
export interface MutableTlsSurface {
  DEFAULT_CIPHERS: string;
}

export interface RuntimePreflightReport {
  readonly bunVersion: string;
  readonly bindings: {
    readonly s3: string;
    readonly S3Client: string;
    readonly SQL: string;
    readonly sql: string;
    readonly secretsGet: string;
    readonly dnsGetCacheStats: string;
  };
  readonly dnsCache: {
    readonly size: number;
    readonly totalCount: number;
    readonly hits: number;
    readonly misses: number;
    readonly errors: number;
    readonly errorRatioBps: number;
  };
  readonly tlsCiphers: TlsCipherPolicySnapshot;
  readonly sealedGlobalS3: boolean;
}

export interface PreflightOptions {
  /** Override environment source (defaults to Bun.env). */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Override bucket name (defaults to env.R2_BUCKET ?? env.R2_BUCKET_NAME ?? "sportsdesk-ops-reports"). */
  readonly bucket?: string | undefined;
  /** Permit ambient AWS_* / S3_* env vars. Default: false. */
  readonly allowAwsFallbackEnv?: boolean | undefined;
  /** Maximum permitted DNS cache error ratio in basis points. Default: 500 (5%). */
  readonly maxDnsErrorRatioBps?: number | undefined;
  /** Pin tls.DEFAULT_CIPHERS to PINNED_TLS_CIPHERS before verification. Default: true. */
  readonly pinTlsCiphers?: boolean | undefined;
  /** Injectable node:tls surface for deterministic unit tests. */
  readonly tlsSurface?: MutableTlsSurface | undefined;
  /** Injectable DNS stats reader for deterministic unit tests. */
  readonly getDnsCacheStats?: (() => DnsCacheStatsSnapshot) | undefined;
  /** Injectable R2 transport for zero-network unit tests. */
  readonly transport?: R2ManifestClient | undefined;
}

export interface PreflightResult {
  readonly report: RuntimePreflightReport;
  readonly client: SealedR2ManifestClient;
}

const BEARER_OR_COOKIE_LEAK_RE =
  /(?:Bearer\s+(?!\[REDACTED_SECRET\]|REDACTED\b)[A-Za-z0-9._-]+|GSLIVE_SESSION_ID=(?!\[REDACTED_SECRET\]|REDACTED\b)[^\s\]"']+)/;

/**
 * `depth: null` is unlimited at runtime. Bun's `BunInspectOptions.depth` is
 * typed as `number`, and `showHidden` is accepted by the runtime.
 */
function inspectLeakSurface(value: unknown): string {
  return Bun.inspect(value, {
    showHidden: true,
    depth: null,
  } as unknown as NonNullable<Parameters<typeof Bun.inspect>[1]>);
}

const REQUIRED_TLS13_SUITES = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
] as const;

const APPROVED_TLS12_AEAD_SUITES = [
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
] as const;

const EXPLICIT_TLS_EXCLUSIONS = [
  "!aNULL",
  "!eNULL",
  "!EXPORT",
  "!DES",
  "!3DES",
  "!RC4",
  "!MD5",
  "!PSK",
  "!SRP",
  "!CAMELLIA",
  "!CBC",
] as const;

export const PINNED_TLS_CIPHERS: string = [
  ...REQUIRED_TLS13_SUITES,
  ...APPROVED_TLS12_AEAD_SUITES,
  ...EXPLICIT_TLS_EXCLUSIONS,
].join(":");

const TLS13_ALLOWLIST = new Set<string>(REQUIRED_TLS13_SUITES);
const TLS12_AEAD_ALLOWLIST = new Set<string>(APPROVED_TLS12_AEAD_SUITES);
const WEAK_SECLEVEL_RE = /^@SECLEVEL=[01]$/i;

export function verifyAndPinTlsCiphers(
  tlsTarget: MutableTlsSurface = tls,
  pin = true,
): TlsCipherPolicySnapshot {
  if (pin) {
    tlsTarget.DEFAULT_CIPHERS = PINNED_TLS_CIPHERS;
  }

  const active = tlsTarget.DEFAULT_CIPHERS;
  if (typeof active !== "string" || active.trim().length === 0) {
    throw new PreflightError(
      "ERR_TLS_WEAK_CIPHER_SUITE",
      77,
      "tls.DEFAULT_CIPHERS is empty or non-string",
    );
  }

  const tokens = active
    .split(":")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const tls13Suites: string[] = [];
  const aeadSuites: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("!") || token.startsWith("-")) {
      continue;
    }
    if (WEAK_SECLEVEL_RE.test(token)) {
      throw new PreflightError(
        "ERR_TLS_WEAK_CIPHER_SUITE",
        77,
        `Forbidden OpenSSL security level directive "${token}" in tls.DEFAULT_CIPHERS`,
      );
    }
    if (TLS13_ALLOWLIST.has(token)) {
      tls13Suites.push(token);
      continue;
    }
    if (TLS12_AEAD_ALLOWLIST.has(token)) {
      aeadSuites.push(token);
      continue;
    }
    throw new PreflightError(
      "ERR_TLS_WEAK_CIPHER_SUITE",
      77,
      `Unapproved or non-AEAD cipher suite "${token}" in tls.DEFAULT_CIPHERS`,
    );
  }

  for (let i = 0; i < REQUIRED_TLS13_SUITES.length; i++) {
    const required = REQUIRED_TLS13_SUITES[i]!;
    if (!tls13Suites.includes(required)) {
      throw new PreflightError(
        "ERR_TLS_WEAK_CIPHER_SUITE",
        77,
        `Missing required TLS 1.3 suite "${required}" in tls.DEFAULT_CIPHERS`,
      );
    }
  }

  return Object.freeze({
    pinned: pin && active === PINNED_TLS_CIPHERS,
    tls13Suites: Object.freeze(tls13Suites),
    aeadSuites: Object.freeze(aeadSuites),
    totalAllowedSuites: tls13Suites.length + aeadSuites.length,
  });
}

const DEFAULT_BUCKET = "sportsdesk-ops-reports";

function collectActiveSecrets(
  env: Record<string, string | undefined>,
): readonly string[] {
  return [
    env.F402_BEARER_TOKEN,
    env.F402_AUTH_JWT,
    env.GSLIVE_SESSION_ID,
    env.R2_ACCESS_KEY_ID,
    env.R2_SECRET_ACCESS_KEY,
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.S3_ACCESS_KEY_ID,
    env.S3_SECRET_ACCESS_KEY,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_R2_API_TOKEN,
    env.DATABASE_URL,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function assertNoSecretLeak(
  surface: string,
  label: string,
  secrets: readonly string[],
): void {
  const plain = Bun.stripANSI(surface);
  for (const secret of secrets) {
    if (plain.includes(secret)) {
      throw new PreflightError(
        "ERR_INSP_SECRET_REDACTION_LEAK",
        77,
        `Raw secret leaked into ${label}`,
      );
    }
  }
  if (BEARER_OR_COOKIE_LEAK_RE.test(plain)) {
    throw new PreflightError(
      "ERR_INSP_SECRET_REDACTION_LEAK",
      77,
      `Unredacted Bearer/session token pattern detected in ${label}`,
    );
  }
}

function readLiveDnsCacheStats(): DnsCacheStatsSnapshot {
  const stats = Bun.dns.getCacheStats();
  return {
    cacheHitsCompleted: stats.cacheHitsCompleted,
    cacheHitsInflight: stats.cacheHitsInflight,
    cacheMisses: stats.cacheMisses,
    size: stats.size,
    errors: stats.errors,
    totalCount: stats.totalCount,
  };
}

export function bootstrapSealedR2Client(
  options: PreflightOptions = {},
): PreflightResult {
  const env = options.env ?? Bun.env;

  // Gate 1: Native runtime bindings
  const bindings = Object.freeze({
    s3: typeof Bun.s3,
    S3Client: typeof Bun.S3Client,
    SQL: typeof Bun.SQL,
    sql: typeof Bun.sql,
    secretsGet: typeof Bun.secrets?.get,
    dnsGetCacheStats: typeof Bun.dns?.getCacheStats,
  });

  if (
    bindings.S3Client !== "function" ||
    bindings.dnsGetCacheStats !== "function"
  ) {
    throw new PreflightError(
      "ERR_SPAWN_BINARY_NOT_FOUND",
      69,
      `Unsupported Bun runtime surface (${JSON.stringify(bindings)})`,
    );
  }

  // Gate 2: r2.env vs pages.env token isolation
  const hasCfPagesToken = Boolean(env.CLOUDFLARE_API_TOKEN);
  const hasR2ScopedCreds = Boolean(
    env.CLOUDFLARE_R2_API_TOKEN ||
    env.R2_ACCESS_KEY_ID ||
    env.R2_SECRET_ACCESS_KEY,
  );
  if (hasCfPagesToken && hasR2ScopedCreds) {
    throw new PreflightError(
      "ERR_CF_TOKEN_BLEED_10000",
      77,
      "CLOUDFLARE_API_TOKEN cannot coexist with R2 credentials; isolate r2.env vs pages.env",
    );
  }

  // Gate 3: Block implicit AWS_* / S3_* fallback env vars
  const hasImplicitAwsEnv = Boolean(
    env.AWS_ACCESS_KEY_ID ||
    env.AWS_SECRET_ACCESS_KEY ||
    env.S3_ACCESS_KEY_ID ||
    env.S3_SECRET_ACCESS_KEY,
  );
  if (!options.allowAwsFallbackEnv && hasImplicitAwsEnv) {
    throw new PreflightError(
      "ERR_CF_TOKEN_BLEED_10000",
      77,
      "Implicit AWS_*/S3_* env vars detected; unset them and load r2.env explicitly",
    );
  }

  // Gate 4: Validate required R2 credentials
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new PreflightError(
      "ERR_CF_R2_ENV_MISSING",
      78,
      "R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set in r2.env",
    );
  }

  // Gate 5: Seal ambient Bun.s3 singleton before client construction.
  // A false result means the singleton stayed credential-capable. Do not continue.
  const sealedGlobalS3 = sealGlobalBunS3();
  if (!sealedGlobalS3) {
    throw new PreflightError(
      "ERR_BUN_S3_SEAL_FAILED",
      77,
      "Bun.s3 could not be sealed; refusing to construct a client",
    );
  }

  // Gate 5b: Pin and verify TLS 1.3 + AEAD-only cipher suites.
  // Re-reads DEFAULT_CIPHERS after the write so a dropped assignment fails closed.
  const tlsCiphers = verifyAndPinTlsCiphers(
    options.tlsSurface ?? tls,
    options.pinTlsCiphers ?? true,
  );

  // Gate 6: Live DNS cache health check
  const stats = (options.getDnsCacheStats ?? readLiveDnsCacheStats)();
  const errorRatioBps =
    stats.totalCount > 0
      ? Math.round((stats.errors / stats.totalCount) * 10_000)
      : 0;
  const maxBps = options.maxDnsErrorRatioBps ?? 500;

  if (errorRatioBps > maxBps) {
    throw new PreflightError(
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      75,
      `DNS cache error ratio ${errorRatioBps} bps exceeds ceiling of ${maxBps} bps`,
    );
  }

  const report: RuntimePreflightReport = Object.freeze({
    bunVersion: Bun.version,
    bindings,
    dnsCache: Object.freeze({
      size: stats.size,
      totalCount: stats.totalCount,
      hits: stats.cacheHitsCompleted + stats.cacheHitsInflight,
      misses: stats.cacheMisses,
      errors: stats.errors,
      errorRatioBps,
    }),
    tlsCiphers,
    sealedGlobalS3,
  });

  // Construct sealed client (freezes the instance and hides creds in #private)
  const client = new SealedR2ManifestClient({
    bucket:
      options.bucket ?? env.R2_BUCKET ?? env.R2_BUCKET_NAME ?? DEFAULT_BUCKET,
    endpoint,
    accessKeyId,
    secretAccessKey,
    sealGlobalS3: false,
    transport: options.transport,
  });

  // Gate 7: Zero-leak redaction canary across all inspect/JSON surfaces
  const activeSecrets = collectActiveSecrets(env);
  assertNoSecretLeak(
    JSON.stringify(report),
    "preflightReport.json",
    activeSecrets,
  );
  assertNoSecretLeak(
    inspectLeakSurface(Bun.s3),
    "Bun.s3.inspect",
    activeSecrets,
  );
  assertNoSecretLeak(
    inspectLeakSurface(client),
    "SealedR2ManifestClient.inspect",
    activeSecrets,
  );
  assertNoSecretLeak(
    JSON.stringify(client),
    "SealedR2ManifestClient.json",
    activeSecrets,
  );

  return Object.freeze({ report, client });
}

if (import.meta.main) {
  try {
    const { report } = bootstrapSealedR2Client();
    console.log(JSON.stringify(report));
  } catch (error) {
    if (error instanceof PreflightError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    throw error;
  }
}
