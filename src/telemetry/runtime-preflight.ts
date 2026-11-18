/**
 * @file src/telemetry/runtime-preflight.ts
 * @description Startup preflight for the Bun-native pipeline: binding checks, Cloudflare token
 * isolation, DNS cache error ratio, a redaction canary, and the AEAD-only TLS 1.2 cipher pin.
 * Depends only on Bun globals, `node:tls`, and `lib/bun_dns.ts`; no contracts or CLI code.
 */

import tls from "node:tls";
import { inspect as nodeInspect } from "node:util";
import { getDnsTelemetry, type DnsCacheTelemetry } from "../../lib/bun_dns.ts";
import {
  BUN_CI_GOVERNOR_LANE,
  BUN_CI_GOVERNOR_R2_KEY,
  encodePreflightErrorFrame256B,
  type LaneR2Key,
  type PreflightErrorCode,
} from "./skill-error-frame.ts";

/** Throws when a raw secret appears in formatted output. */
export function assertNoSecretLeak(
  formatted: string,
  rawSecrets: readonly string[],
): void {
  for (const secret of rawSecrets) {
    if (secret !== "" && formatted.includes(secret)) {
      throw new Error(
        "ERR_INSP_SECRET_REDACTION_LEAK: Raw credential detected in formatted output",
      );
    }
  }
  if (
    /(?:Bearer\s+[A-Za-z0-9._-]+|GSLIVE_SESSION_ID=[^\s\]]+)/.test(formatted)
  ) {
    throw new Error(
      "ERR_INSP_SECRET_REDACTION_LEAK: Auth header or session pattern leaked",
    );
  }
}

/** Cloudflare Pages and R2 tokens must never share a process/token scope. */
export function assertCloudflareTokenIsolation(): void {
  if (Bun.env.CLOUDFLARE_API_TOKEN && Bun.env.CLOUDFLARE_R2_API_TOKEN) {
    throw new Error(
      "ERR_CF_TOKEN_BLEED_10000: CLOUDFLARE_API_TOKEN and CLOUDFLARE_R2_API_TOKEN cannot coexist in R2 scope",
    );
  }
}

/**
 * TLS 1.2 suites left after the pin: ECDHE key exchange with GCM or ChaCha20-Poly1305 only.
 * TLS 1.3 suites are configured separately and stay on. Measured 2026-11-18 on 1.4.4 against a
 * local TLS 1.2 server: both `fetch` and `Bun.S3Client` read `tls.DEFAULT_CIPHERS`
 * (tests/runtime_preflight_tls_ciphers.test.ts).
 */
export const AEAD_TLS12_CIPHERS = [
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
].join(":");

/**
 * Sets the process-wide TLS 1.2 cipher list for every later `fetch` and `Bun.S3Client` call and
 * returns the TLS 1.2 part read back. The getter always prepends the `TLS_*` (1.3) suites.
 */
export function pinAeadTls12Ciphers(): string {
  tls.DEFAULT_CIPHERS = AEAD_TLS12_CIPHERS;
  const tls12 = tls.DEFAULT_CIPHERS.split(":")
    .filter((suite) => !suite.startsWith("TLS_"))
    .join(":");
  if (tls12 !== AEAD_TLS12_CIPHERS) {
    throw new Error(
      "ERR_BUN_RUNTIME_SURFACE: tls.DEFAULT_CIPHERS did not keep the AEAD-only TLS 1.2 list",
    );
  }
  return tls12;
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
  readonly tokenIsolation: "isolated";
  readonly awsFallbackEnvPresent: boolean;
  readonly dnsCache: DnsCacheTelemetry & { readonly errorRatioBps: number };
  /**
   * Bun's own S3Client inspector prints `accessKeyId`/`secretAccessKey` as `"[REDACTED]"`.
   * This is the canary result, not a seal: preflight must not mutate the shared `Bun.s3`.
   */
  readonly globalS3InspectRedacted: boolean;
  readonly tls12Ciphers: string;
}

const PREFLIGHT_SECRET_ENV_NAMES = [
  "F402_AUTH_JWT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
  "DATABASE_URL",
] as const;

/**
 * Startup guard: verify the native bindings the pipeline needs, enforce Cloudflare token
 * isolation, pin AEAD-only TLS 1.2 ciphers, audit DNS cache errors, and run a redaction canary.
 * No network I/O.
 */
export function runRuntimePreflightAudit(options?: {
  readonly maxDnsErrorRatioBps?: number;
  readonly dnsTelemetry?: DnsCacheTelemetry;
}): RuntimePreflightReport {
  const bindings = {
    s3: typeof Bun.s3,
    S3Client: typeof Bun.S3Client,
    SQL: typeof Bun.SQL,
    sql: typeof Bun.sql,
    secretsGet: typeof Bun.secrets?.get,
    dnsGetCacheStats: typeof Bun.dns?.getCacheStats,
  } as const;

  if (
    bindings.S3Client !== "function" ||
    bindings.secretsGet !== "function" ||
    bindings.dnsGetCacheStats !== "function"
  ) {
    throw new Error(
      `ERR_BUN_RUNTIME_SURFACE: required native bindings missing (${JSON.stringify(bindings)})`,
    );
  }

  assertCloudflareTokenIsolation();
  const tls12Ciphers = pinAeadTls12Ciphers();

  const telemetry = options?.dnsTelemetry ?? getDnsTelemetry();
  const errorRatioBps =
    telemetry.totalCount > 0
      ? Math.round((telemetry.errors / telemetry.totalCount) * 10_000)
      : 0;
  const maxBps = options?.maxDnsErrorRatioBps ?? 500;
  if (errorRatioBps > maxBps) {
    throw new Error(
      `ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE: DNS cache error ratio ${errorRatioBps} bps exceeds ${maxBps} bps`,
    );
  }

  const activeSecrets = PREFLIGHT_SECRET_ENV_NAMES.map(
    (name) => Bun.env[name] ?? "",
  ).filter((value) => value !== "");

  const globalS3 =
    typeof Bun.s3 === "object" && Bun.s3 !== null ? Bun.s3 : null;
  if (globalS3 !== null) {
    assertNoSecretLeak(
      Bun.inspect(globalS3, { depth: Infinity }),
      activeSecrets,
    );
    assertNoSecretLeak(
      nodeInspect(globalS3, { showHidden: true, depth: null }),
      activeSecrets,
    );
  }

  const report: RuntimePreflightReport = Object.freeze({
    bunVersion: Bun.version,
    bindings,
    tokenIsolation: "isolated",
    awsFallbackEnvPresent: Boolean(
      Bun.env.AWS_ACCESS_KEY_ID || Bun.env.S3_ACCESS_KEY_ID,
    ),
    dnsCache: Object.freeze({ ...telemetry, errorRatioBps }),
    globalS3InspectRedacted: true,
    tls12Ciphers,
  });

  assertNoSecretLeak(JSON.stringify(report), activeSecrets);
  return report;
}

/**
 * Fail-closed startup wrapper: on any preflight failure, publish one 256-byte frame through the
 * injected lane flusher and exit with the class-specific code (75 transient, 77 terminal).
 */
export async function runPreflightOrExit(
  telemetrySab: SharedArrayBuffer,
  slot1Offset: number,
  flushLaneIpc: (frame: Uint8Array, r2Key: LaneR2Key) => Promise<void>,
  deps?: {
    readonly runPreflight?: () => Promise<RuntimePreflightReport>;
    readonly exit?: (code: number) => never;
  },
): Promise<RuntimePreflightReport> {
  try {
    return await (deps?.runPreflight ?? (() => runRuntimePreflightAudit()))();
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    let code: PreflightErrorCode = "ERR_INSP_SECRET_REDACTION_LEAK";
    let safeDetail =
      "Secret or token pattern detected during startup preflight";

    if (rawMsg.startsWith("ERR_CF_TOKEN_BLEED_10000")) {
      code = "ERR_CF_TOKEN_BLEED_10000";
      safeDetail =
        "Conflicting CLOUDFLARE_API_TOKEN and R2/AWS credentials in env";
    } else if (rawMsg.startsWith("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE")) {
      code = "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE";
      safeDetail = rawMsg.slice(0, 95); // numeric counters only; never echoes secrets
    }

    const encoded = encodePreflightErrorFrame256B(
      telemetrySab,
      slot1Offset,
      code,
      safeDetail,
    );

    try {
      await flushLaneIpc(encoded.frame, BUN_CI_GOVERNOR_R2_KEY);
    } catch (flushErr) {
      console.error(
        `[${BUN_CI_GOVERNOR_LANE}] ERR_TELEMETRY_FLUSH_FAILED: ${
          flushErr instanceof Error ? flushErr.message : String(flushErr)
        }`,
      );
    }

    console.error(
      `[${BUN_CI_GOVERNOR_LANE}] ${code} (u16=0x${encoded.errorCodeU16
        .toString(16)
        .padStart(4, "0")}, exit=${encoded.exitCode})`,
    );
    const exit =
      deps?.exit ?? ((exitCode: number): never => process.exit(exitCode));
    return exit(encoded.exitCode);
  }
}
