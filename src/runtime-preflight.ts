/**
 * @file src/runtime-preflight.ts
 * @description Extended runtime preflight entrypoint: wraps
 * `src/telemetry/runtime-preflight.ts` with opt-in `sealGlobalBunS3`,
 * TLS 1.3 AEAD cipher pinning verification, and lazy `Bun.file` `TypeError`
 * contract checks.
 */

import tls from "node:tls";
import { inspect as nodeInspect } from "node:util";
import type { DnsCacheTelemetry } from "../lib/bun_dns.ts";
import {
  assertCloudflareTokenIsolation,
  assertNoSecretLeak,
  runPreflightOrExit,
  runRuntimePreflightAudit as runTelemetryPreflightAudit,
  type RuntimePreflightReport,
} from "./telemetry/runtime-preflight.ts";

export {
  assertCloudflareTokenIsolation,
  assertNoSecretLeak,
  runPreflightOrExit,
  type RuntimePreflightReport,
};

/** Canonical TLS 1.3 AEAD ciphers required by runtime preflight. */
export const PINNED_TLS13_CIPHERS = [
  "tls_aes_256_gcm_sha384",
  "tls_aes_128_gcm_sha256",
  "tls_chacha20_poly1305_sha256",
] as const;

export const TLS13_CIPHER_STRING =
  "TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256";

export interface SealGlobalBunS3Result {
  readonly sealed: boolean;
  readonly frozenInstance: boolean;
  readonly lockedBinding: boolean;
  readonly inspectRedacted: true;
}

export interface Tls13CipherPinReport {
  readonly cipherString: string;
  readonly verifiedCiphers: readonly string[];
}

export interface LazyBunFileTypeErrorReport {
  readonly checkedInputs: readonly string[];
  readonly allThrewTypeError: true;
}

export interface ExtendedRuntimePreflightReport extends RuntimePreflightReport {
  readonly tls13Ciphers: Tls13CipherPinReport;
  readonly lazyBunFileTypeErrors: LazyBunFileTypeErrorReport;
  readonly s3Sealed: boolean;
}

/**
 * Inspect-canary and seal the global `Bun.s3` binding and instance so runtime
 * callers cannot reassign `Bun.s3` or mutate its properties.
 */
export function sealGlobalBunS3(
  rawSecrets: readonly string[] = [],
): SealGlobalBunS3Result {
  if (typeof Bun.s3 !== "object" || Bun.s3 === null) {
    throw new Error("ERR_BUN_S3_MISSING: global Bun.s3 is not an object");
  }

  assertNoSecretLeak(Bun.inspect(Bun.s3, { depth: Infinity }), rawSecrets);
  assertNoSecretLeak(
    nodeInspect(Bun.s3, { showHidden: true, depth: null }),
    rawSecrets,
  );

  if (Object.isExtensible(Bun.s3)) {
    Object.freeze(Bun.s3);
  }

  const desc = Object.getOwnPropertyDescriptor(Bun, "s3");
  if (desc?.writable) {
    Object.defineProperty(Bun, "s3", {
      value: Bun.s3,
      writable: false,
    });
  }

  const lockedBinding =
    Object.getOwnPropertyDescriptor(Bun, "s3")?.writable === false;
  const frozenInstance = Object.isFrozen(Bun.s3);

  return Object.freeze({
    sealed: frozenInstance && lockedBinding,
    frozenInstance,
    lockedBinding,
    inspectRedacted: true,
  });
}

/**
 * Verify that the runtime OpenSSL/BoringSSL stack exposes all pinned TLS 1.3
 * AEAD cipher suites.
 */
export function verifyTls13CipherPinning(
  requiredCiphers: readonly string[] = PINNED_TLS13_CIPHERS,
): Tls13CipherPinReport {
  const available = new Set(tls.getCiphers().map((c) => c.toLowerCase()));
  const missing = requiredCiphers.filter(
    (cipher) => !available.has(cipher.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new Error(
      `ERR_TLS13_CIPHER_PIN_MISSING: missing required TLS 1.3 cipher(s): ${missing.join(", ")}`,
    );
  }

  return Object.freeze({
    cipherString: TLS13_CIPHER_STRING,
    verifiedCiphers: Object.freeze([...requiredCiphers]),
  });
}

/**
 * Verify that invalid non-path/non-fd inputs to `Bun.file(...)` fail fast with
 * a synchronous `TypeError` instead of deferring to async I/O.
 */
export function verifyLazyBunFileTypeErrors(): LazyBunFileTypeErrorReport {
  const probes: ReadonlyArray<readonly [label: string, value: unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
  ];

  for (const [label, value] of probes) {
    let threwTypeError = false;
    try {
      Bun.file(value as never);
    } catch (err) {
      threwTypeError = err instanceof TypeError;
    }
    if (!threwTypeError) {
      throw new Error(
        `ERR_LAZY_BUN_FILE_TYPEERROR: Bun.file(${label}) did not throw TypeError synchronously`,
      );
    }
  }

  return Object.freeze({
    checkedInputs: Object.freeze(probes.map(([label]) => label)),
    allThrewTypeError: true,
  });
}

/**
 * Run the full runtime preflight audit: native bindings, Cloudflare token
 * isolation, DNS cache error ratio, redaction canary, TLS 1.3 cipher pinning,
 * lazy `Bun.file` `TypeError` contract, and optional `Bun.s3` sealing.
 */
export function runRuntimePreflightAudit(options?: {
  readonly maxDnsErrorRatioBps?: number;
  readonly dnsTelemetry?: DnsCacheTelemetry;
  readonly requiredTls13Ciphers?: readonly string[];
  readonly sealS3?: boolean;
}): ExtendedRuntimePreflightReport {
  const baseReport = runTelemetryPreflightAudit(options);
  const tls13Ciphers = verifyTls13CipherPinning(options?.requiredTls13Ciphers);
  const lazyBunFileTypeErrors = verifyLazyBunFileTypeErrors();

  const s3Sealed = options?.sealS3
    ? sealGlobalBunS3().sealed
    : Object.isFrozen(Bun.s3) &&
      Object.getOwnPropertyDescriptor(Bun, "s3")?.writable === false;

  return Object.freeze({
    ...baseReport,
    tls13Ciphers,
    lazyBunFileTypeErrors,
    s3Sealed,
  });
}
