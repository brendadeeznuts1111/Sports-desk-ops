import { afterEach, describe, expect, test } from "bun:test";
import type { DnsCacheTelemetry } from "../lib/bun_dns.ts";
import {
  PINNED_TLS13_CIPHERS,
  runRuntimePreflightAudit,
  sealGlobalBunS3,
  TLS13_CIPHER_STRING,
  verifyLazyBunFileTypeErrors,
  verifyTls13CipherPinning,
} from "../src/runtime-preflight.ts";

const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

const mutableEnv = Bun.env as Record<string, string | undefined>;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, mutableEnv[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) {
      delete mutableEnv[key];
    } else {
      mutableEnv[key] = prev;
    }
  }
});

const zeroDns: DnsCacheTelemetry = {
  cacheHitsCompleted: 0,
  cacheHitsInflight: 0,
  cacheMisses: 0,
  size: 0,
  errors: 0,
  totalCount: 0,
  hitRatePercent: 0,
  cacheHitsTotal: 0,
  classifiedRequests: 0,
  unclassifiedRequests: 0,
  cacheHitRatePercent: 0,
  defaultTtlSeconds: 30,
};

describe("src/runtime-preflight", () => {
  test("verifyTls13CipherPinning verifies all pinned TLS 1.3 AEAD ciphers", () => {
    const report = verifyTls13CipherPinning();
    expect(report.cipherString).toBe(TLS13_CIPHER_STRING);
    expect(report.verifiedCiphers).toEqual([...PINNED_TLS13_CIPHERS]);
  });

  test("verifyTls13CipherPinning fails closed on missing cipher", () => {
    expect(() =>
      verifyTls13CipherPinning(["tls_nonexistent_cipher_xyz"]),
    ).toThrow("ERR_TLS13_CIPHER_PIN_MISSING");
  });

  test("verifyLazyBunFileTypeErrors confirms synchronous TypeError on invalid inputs", () => {
    const report = verifyLazyBunFileTypeErrors();
    expect(report.allThrewTypeError).toBe(true);
    expect(report.checkedInputs).toEqual(["null", "undefined", "object"]);
  });

  test("runRuntimePreflightAudit runs base + TLS 1.3 + lazy Bun.file checks", () => {
    delete mutableEnv.CLOUDFLARE_API_TOKEN;
    delete mutableEnv.CLOUDFLARE_R2_API_TOKEN;
    const report = runRuntimePreflightAudit({ dnsTelemetry: zeroDns });
    expect(report.tokenIsolation).toBe("isolated");
    expect(report.tls13Ciphers.verifiedCiphers).toEqual([
      ...PINNED_TLS13_CIPHERS,
    ]);
    expect(report.lazyBunFileTypeErrors.allThrewTypeError).toBe(true);
  });

  test("sealGlobalBunS3 seals Bun.s3 idempotently and rejects leaked secrets", () => {
    expect(() => sealGlobalBunS3(["S3Client"])).toThrow(
      "ERR_INSP_SECRET_REDACTION_LEAK",
    );

    const first = sealGlobalBunS3();
    expect(first.sealed).toBe(true);
    expect(first.frozenInstance).toBe(true);
    expect(first.lockedBinding).toBe(true);
    expect(first.inspectRedacted).toBe(true);

    const second = sealGlobalBunS3();
    expect(second.sealed).toBe(true);

    const report = runRuntimePreflightAudit({
      dnsTelemetry: zeroDns,
      sealS3: true,
    });
    expect(report.s3Sealed).toBe(true);
  });
});
