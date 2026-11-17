import { afterEach, describe, expect, test } from "bun:test";
import {
  assertCloudflareTokenIsolation,
  runRuntimePreflightAudit,
} from "../src/telemetry/runtime-preflight.ts";
import type { DnsCacheTelemetry } from "../lib/bun_dns.ts";

const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
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
  defaultTtlSeconds: 30,
};

describe("runRuntimePreflightAudit", () => {
  test("verifies bindings and reports clean DNS telemetry", () => {
    delete mutableEnv.CLOUDFLARE_API_TOKEN;
    delete mutableEnv.CLOUDFLARE_R2_API_TOKEN;
    mutableEnv.R2_ACCESS_KEY_ID = "AKIA_PREFLIGHT_ID_001";
    mutableEnv.R2_SECRET_ACCESS_KEY = "secret-preflight-value-002";

    const report = runRuntimePreflightAudit({
      dnsTelemetry: { ...zeroDns, totalCount: 1_000, cacheMisses: 1_000 },
    });

    expect(report.bunVersion).toBe(Bun.version);
    expect(report.bindings.S3Client).toBe("function");
    expect(report.bindings.secretsGet).toBe("function");
    expect(report.bindings.dnsGetCacheStats).toBe("function");
    expect(report.tokenIsolation).toBe("isolated");
    expect(report.dnsCache.errorRatioBps).toBe(0);
    expect(report.globalS3InspectRedacted).toBe(true);
  });

  test("fails closed when the DNS cache error ratio exceeds the cap", () => {
    expect(() =>
      runRuntimePreflightAudit({
        dnsTelemetry: { ...zeroDns, totalCount: 1_000, errors: 60 },
      }),
    ).toThrow("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE");
  });

  test("fails closed when Cloudflare Pages and R2 tokens coexist", () => {
    mutableEnv.CLOUDFLARE_API_TOKEN = "cf_pages_token";
    mutableEnv.CLOUDFLARE_R2_API_TOKEN = "cf_r2_token";
    expect(() => assertCloudflareTokenIsolation()).toThrow(
      "ERR_CF_TOKEN_BLEED_10000",
    );
    expect(() => runRuntimePreflightAudit({ dnsTelemetry: zeroDns })).toThrow(
      "ERR_CF_TOKEN_BLEED_10000",
    );
  });
});
