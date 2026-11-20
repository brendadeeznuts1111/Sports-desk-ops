import { describe, expect, test } from "bun:test";

import {
  bootstrapSealedR2Client,
  PreflightError,
  type DnsCacheStatsSnapshot,
  type PreflightErrorCode,
} from "../lib/runtime_preflight.ts";
import { SealedR2ManifestClient } from "../lib/sealed_r2_manifest_client.ts";

function inspectHidden(value: unknown): string {
  return Bun.inspect(value, {
    showHidden: true,
    depth: null,
  } as unknown as NonNullable<Parameters<typeof Bun.inspect>[1]>);
}

const VALID_R2_ENV: Record<string, string> = {
  R2_BUCKET: "sportsdesk-ops-reports",
  R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "AKIA_CANARY_PREFLIGHT_01",
  R2_SECRET_ACCESS_KEY: "SECRET_CANARY_PREFLIGHT_99887766",
};

const HEALTHY_DNS: DnsCacheStatsSnapshot = {
  cacheHitsCompleted: 90,
  cacheHitsInflight: 5,
  cacheMisses: 4,
  size: 12,
  errors: 1,
  totalCount: 100, // 100 bps (1%)
};

function expectPreflightError(
  fn: () => unknown,
  code: PreflightErrorCode,
  exitCode: number,
): void {
  try {
    fn();
    expect.unreachable(`Expected ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(PreflightError);
    expect((err as PreflightError).code).toBe(code);
    expect((err as PreflightError).exitCode).toBe(exitCode);
  }
}

describe("bootstrapSealedR2Client preflight gates", () => {
  test("passes all gates and returns a frozen report and SealedR2ManifestClient", () => {
    const { report, client } = bootstrapSealedR2Client({
      env: VALID_R2_ENV,
      getDnsCacheStats: () => HEALTHY_DNS,
    });

    expect(report.sealedGlobalS3).toBe(true);
    expect(report.dnsCache.errorRatioBps).toBe(100);
    expect(client).toBeInstanceOf(SealedR2ManifestClient);
    expect(client.bucket).toBe("sportsdesk-ops-reports");
    expect(client.endpointHost).toBe("example.r2.cloudflarestorage.com");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(client)).toBe(true);

    const inspected = inspectHidden(client);
    expect(inspected).not.toContain(VALID_R2_ENV.R2_ACCESS_KEY_ID);
    expect(inspected).not.toContain(VALID_R2_ENV.R2_SECRET_ACCESS_KEY);
    expect(JSON.stringify(client)).not.toContain(
      VALID_R2_ENV.R2_SECRET_ACCESS_KEY,
    );
    expect(JSON.stringify(report)).not.toContain(VALID_R2_ENV.R2_ACCESS_KEY_ID);
  });

  test("Bun.S3Client inspect redacts the sealed credentials", () => {
    const { client } = bootstrapSealedR2Client({
      env: VALID_R2_ENV,
      getDnsCacheStats: () => HEALTHY_DNS,
    });
    const opened = client.s3Client();
    const inspected = inspectHidden(opened);
    expect(inspected).not.toContain(VALID_R2_ENV.R2_ACCESS_KEY_ID);
    expect(inspected).not.toContain(VALID_R2_ENV.R2_SECRET_ACCESS_KEY);
    expect(JSON.stringify(opened)).not.toContain(
      VALID_R2_ENV.R2_SECRET_ACCESS_KEY,
    );
  });

  test("fails closed with ERR_CF_TOKEN_BLEED_10000 when CLOUDFLARE_API_TOKEN coexists with R2 creds", () => {
    expectPreflightError(
      () =>
        bootstrapSealedR2Client({
          env: {
            ...VALID_R2_ENV,
            CLOUDFLARE_API_TOKEN: "cf_pages_token_bleed",
          },
          getDnsCacheStats: () => HEALTHY_DNS,
        }),
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  });

  test("fails closed with ERR_CF_TOKEN_BLEED_10000 on implicit AWS_* or S3_* env vars", () => {
    expectPreflightError(
      () =>
        bootstrapSealedR2Client({
          env: {
            ...VALID_R2_ENV,
            AWS_ACCESS_KEY_ID: "AKIA_IMPLICIT_AWS",
          },
          getDnsCacheStats: () => HEALTHY_DNS,
        }),
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  });

  test("permits AWS_* when allowAwsFallbackEnv is set and still redacts those keys", () => {
    const { report, client } = bootstrapSealedR2Client({
      env: {
        ...VALID_R2_ENV,
        AWS_ACCESS_KEY_ID: "AKIA_ALLOWED_AWS_01",
        AWS_SECRET_ACCESS_KEY: "SECRET_ALLOWED_AWS_998877",
      },
      allowAwsFallbackEnv: true,
      getDnsCacheStats: () => HEALTHY_DNS,
    });

    expect(report.sealedGlobalS3).toBe(true);
    const inspected = inspectHidden(client);
    expect(inspected).not.toContain("AKIA_ALLOWED_AWS_01");
    expect(inspected).not.toContain("SECRET_ALLOWED_AWS_998877");
    expect(JSON.stringify(client)).not.toContain("SECRET_ALLOWED_AWS_998877");
  });

  test("fails closed with ERR_CF_R2_ENV_MISSING when R2 credentials are incomplete", () => {
    expectPreflightError(
      () =>
        bootstrapSealedR2Client({
          env: { R2_ENDPOINT: "https://example.r2.cloudflarestorage.com" },
          getDnsCacheStats: () => HEALTHY_DNS,
        }),
      "ERR_CF_R2_ENV_MISSING",
      78,
    );
  });

  test("accepts a DNS error ratio at the 500 bps ceiling", () => {
    const atCeiling: DnsCacheStatsSnapshot = {
      ...HEALTHY_DNS,
      errors: 5,
      totalCount: 100,
    };
    const { report } = bootstrapSealedR2Client({
      env: VALID_R2_ENV,
      getDnsCacheStats: () => atCeiling,
    });
    expect(report.dnsCache.errorRatioBps).toBe(500);
  });

  test("fails closed with ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE when DNS error ratio exceeds 500 bps", () => {
    const degradedDns: DnsCacheStatsSnapshot = {
      ...HEALTHY_DNS,
      errors: 6,
      totalCount: 100, // 600 bps (6%)
    };

    expectPreflightError(
      () =>
        bootstrapSealedR2Client({
          env: VALID_R2_ENV,
          getDnsCacheStats: () => degradedDns,
        }),
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      75,
    );
  });

  test("fails closed with ERR_INSP_SECRET_REDACTION_LEAK if a secret appears in the endpoint hostname", () => {
    expectPreflightError(
      () =>
        bootstrapSealedR2Client({
          env: {
            ...VALID_R2_ENV,
            R2_ENDPOINT: `https://${VALID_R2_ENV.R2_ACCESS_KEY_ID}.r2.cloudflarestorage.com`,
          },
          getDnsCacheStats: () => HEALTHY_DNS,
        }),
      "ERR_INSP_SECRET_REDACTION_LEAK",
      77,
    );
  });

  test("fails closed with ERR_INSP_SECRET_REDACTION_LEAK on an unredacted Bearer token", () => {
    expectPreflightError(
      () =>
        bootstrapSealedR2Client({
          env: VALID_R2_ENV,
          bucket: "Bearer leaktoken",
          getDnsCacheStats: () => HEALTHY_DNS,
        }),
      "ERR_INSP_SECRET_REDACTION_LEAK",
      77,
    );
  });

  test("uses R2_BUCKET_NAME when R2_BUCKET is unset", () => {
    const { client } = bootstrapSealedR2Client({
      env: {
        R2_BUCKET_NAME: "desk-archive",
        R2_ENDPOINT: VALID_R2_ENV.R2_ENDPOINT,
        R2_ACCESS_KEY_ID: VALID_R2_ENV.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: VALID_R2_ENV.R2_SECRET_ACCESS_KEY,
      },
      getDnsCacheStats: () => HEALTHY_DNS,
    });
    expect(client.bucket).toBe("desk-archive");
  });
});
