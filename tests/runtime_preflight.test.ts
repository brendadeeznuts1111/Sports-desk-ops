import { describe, expect, test } from "bun:test";

import {
  PINNED_TLS_CIPHERS,
  PreflightError,
  verifyAndPinTlsCiphers,
  type DnsCacheStatsSnapshot,
  type PreflightErrorCode,
} from "../lib/runtime_preflight.ts";

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

interface Scenario {
  readonly env: Record<string, string | undefined>;
  readonly bucket?: string;
  readonly allowAwsFallbackEnv?: boolean;
  readonly dns?: DnsCacheStatsSnapshot;
  readonly lockForeignS3?: boolean;
  readonly openS3?: boolean;
  readonly tlsCiphers?: string;
  readonly pinTlsCiphers?: boolean;
}

interface IsolatedOk {
  readonly status: "ok";
  readonly sealedGlobalS3: boolean;
  readonly errorRatioBps: number;
  readonly bucket: string;
  readonly endpointHost: string;
  readonly frozenReport: boolean;
  readonly frozenClient: boolean;
  readonly clientIsSealed: boolean;
  readonly clientInspect: string;
  readonly clientJson: string;
  readonly reportJson: string;
  readonly openedInspect: string | null;
  readonly openedJson: string | null;
  readonly activeCiphers: string | null;
  readonly tlsPinned: boolean;
  readonly tls13Count: number;
  readonly aeadCount: number;
  readonly totalAllowedSuites: number;
}

interface IsolatedErr {
  readonly status: "error";
  readonly code: PreflightErrorCode;
  readonly exitCode: number;
}

function runIsolated(scenario: Scenario): IsolatedOk | IsolatedErr {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      new URL("./runtime_preflight_isolated.ts", import.meta.url).pathname,
      JSON.stringify(scenario),
    ],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: Bun.env.HOME ?? "",
    },
  });
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) {
    throw new Error(`isolated preflight crashed (${proc.exitCode}): ${stderr}`);
  }
  return JSON.parse(new TextDecoder().decode(proc.stdout)) as
    IsolatedOk | IsolatedErr;
}

function expectIsolatedError(
  scenario: Scenario,
  code: PreflightErrorCode,
  exitCode: number,
): void {
  const result = runIsolated(scenario);
  expect(result.status).toBe("error");
  if (result.status !== "error") return;
  expect(result.code).toBe(code);
  expect(result.exitCode).toBe(exitCode);
}

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
    const result = runIsolated({ env: VALID_R2_ENV, dns: HEALTHY_DNS });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.sealedGlobalS3).toBe(true);
    expect(result.errorRatioBps).toBe(100);
    expect(result.clientIsSealed).toBe(true);
    expect(result.bucket).toBe("sportsdesk-ops-reports");
    expect(result.endpointHost).toBe("example.r2.cloudflarestorage.com");
    expect(result.frozenReport).toBe(true);
    expect(result.frozenClient).toBe(true);
    expect(result.clientInspect).not.toContain(VALID_R2_ENV.R2_ACCESS_KEY_ID);
    expect(result.clientInspect).not.toContain(
      VALID_R2_ENV.R2_SECRET_ACCESS_KEY,
    );
    expect(result.clientJson).not.toContain(VALID_R2_ENV.R2_SECRET_ACCESS_KEY);
    expect(result.reportJson).not.toContain(VALID_R2_ENV.R2_ACCESS_KEY_ID);
  });

  test("Bun.S3Client inspect redacts the sealed credentials", () => {
    const result = runIsolated({
      env: VALID_R2_ENV,
      dns: HEALTHY_DNS,
      openS3: true,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.openedInspect).not.toContain(VALID_R2_ENV.R2_ACCESS_KEY_ID);
    expect(result.openedInspect).not.toContain(
      VALID_R2_ENV.R2_SECRET_ACCESS_KEY,
    );
    expect(result.openedJson).not.toContain(VALID_R2_ENV.R2_SECRET_ACCESS_KEY);
  });

  test("fails closed with ERR_CF_TOKEN_BLEED_10000 when CLOUDFLARE_API_TOKEN coexists with R2 creds", () => {
    expectIsolatedError(
      {
        env: { ...VALID_R2_ENV, CLOUDFLARE_API_TOKEN: "cf_pages_token_bleed" },
        dns: HEALTHY_DNS,
      },
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  });

  test("fails closed with ERR_CF_TOKEN_BLEED_10000 on implicit AWS_* or S3_* env vars", () => {
    expectIsolatedError(
      {
        env: { ...VALID_R2_ENV, AWS_ACCESS_KEY_ID: "AKIA_IMPLICIT_AWS" },
        dns: HEALTHY_DNS,
      },
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  });

  test("permits AWS_* when allowAwsFallbackEnv is set and still redacts those keys", () => {
    const result = runIsolated({
      env: {
        ...VALID_R2_ENV,
        AWS_ACCESS_KEY_ID: "AKIA_ALLOWED_AWS_01",
        AWS_SECRET_ACCESS_KEY: "SECRET_ALLOWED_AWS_998877",
      },
      allowAwsFallbackEnv: true,
      dns: HEALTHY_DNS,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sealedGlobalS3).toBe(true);
    expect(result.clientInspect).not.toContain("AKIA_ALLOWED_AWS_01");
    expect(result.clientInspect).not.toContain("SECRET_ALLOWED_AWS_998877");
    expect(result.clientJson).not.toContain("SECRET_ALLOWED_AWS_998877");
  });

  test("fails closed with ERR_CF_R2_ENV_MISSING when R2 credentials are incomplete", () => {
    expectIsolatedError(
      {
        env: { R2_ENDPOINT: "https://example.r2.cloudflarestorage.com" },
        dns: HEALTHY_DNS,
      },
      "ERR_CF_R2_ENV_MISSING",
      78,
    );
  });

  test("accepts a DNS error ratio at the 500 bps ceiling", () => {
    const result = runIsolated({
      env: VALID_R2_ENV,
      dns: { ...HEALTHY_DNS, errors: 5, totalCount: 100 },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.errorRatioBps).toBe(500);
  });

  test("fails closed with ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE when DNS error ratio exceeds 500 bps", () => {
    expectIsolatedError(
      {
        env: VALID_R2_ENV,
        dns: { ...HEALTHY_DNS, errors: 6, totalCount: 100 },
      },
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      75,
    );
  });

  test("fails closed with ERR_INSP_SECRET_REDACTION_LEAK if a secret appears in the endpoint hostname", () => {
    expectIsolatedError(
      {
        env: {
          ...VALID_R2_ENV,
          R2_ENDPOINT: `https://${VALID_R2_ENV.R2_ACCESS_KEY_ID}.r2.cloudflarestorage.com`,
        },
        dns: HEALTHY_DNS,
      },
      "ERR_INSP_SECRET_REDACTION_LEAK",
      77,
    );
  });

  test("fails closed with ERR_INSP_SECRET_REDACTION_LEAK on an unredacted Bearer token", () => {
    expectIsolatedError(
      {
        env: VALID_R2_ENV,
        bucket: "Bearer leaktoken",
        dns: HEALTHY_DNS,
      },
      "ERR_INSP_SECRET_REDACTION_LEAK",
      77,
    );
  });

  test("fails closed when the raw F402_BEARER_TOKEN value is on a public field", () => {
    const token = "f402_raw_bearer_canary_01";
    expectIsolatedError(
      {
        env: { ...VALID_R2_ENV, F402_BEARER_TOKEN: token },
        bucket: token,
        dns: HEALTHY_DNS,
      },
      "ERR_INSP_SECRET_REDACTION_LEAK",
      77,
    );
  });

  test("keeps a raw F402_BEARER_TOKEN out of inspect when it is only in env", () => {
    const token = "f402_raw_bearer_canary_01";
    const result = runIsolated({
      env: { ...VALID_R2_ENV, F402_BEARER_TOKEN: token },
      dns: HEALTHY_DNS,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.clientInspect).not.toContain(token);
    expect(result.clientJson).not.toContain(token);
    expect(result.reportJson).not.toContain(token);
  });

  test("fails closed with ERR_BUN_S3_SEAL_FAILED when Bun.s3 cannot be replaced", () => {
    expectIsolatedError(
      { env: VALID_R2_ENV, dns: HEALTHY_DNS, lockForeignS3: true },
      "ERR_BUN_S3_SEAL_FAILED",
      77,
    );
  });

  test("uses R2_BUCKET_NAME when R2_BUCKET is unset", () => {
    const result = runIsolated({
      env: {
        R2_BUCKET_NAME: "desk-archive",
        R2_ENDPOINT: VALID_R2_ENV.R2_ENDPOINT ?? "",
        R2_ACCESS_KEY_ID: VALID_R2_ENV.R2_ACCESS_KEY_ID ?? "",
        R2_SECRET_ACCESS_KEY: VALID_R2_ENV.R2_SECRET_ACCESS_KEY ?? "",
      },
      dns: HEALTHY_DNS,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.bucket).toBe("desk-archive");
  });

  test("pins tls.DEFAULT_CIPHERS to TLS 1.3 and forward-secret AEAD suites", () => {
    const result = runIsolated({
      env: VALID_R2_ENV,
      dns: HEALTHY_DNS,
      tlsCiphers: "DEFAULT",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.activeCiphers).toBe(PINNED_TLS_CIPHERS);
    expect(result.tlsPinned).toBe(true);
    expect(result.tls13Count).toBe(3);
    expect(result.aeadCount).toBe(6);
    expect(result.totalAllowedSuites).toBe(9);
  });

  test("fails closed with ERR_TLS_WEAK_CIPHER_SUITE on CBC, RC4, or @SECLEVEL=0 when pinTlsCiphers is false", () => {
    expectIsolatedError(
      {
        env: VALID_R2_ENV,
        dns: HEALTHY_DNS,
        tlsCiphers: `${PINNED_TLS_CIPHERS}:ECDHE-RSA-AES256-SHA384`,
        pinTlsCiphers: false,
      },
      "ERR_TLS_WEAK_CIPHER_SUITE",
      77,
    );

    expectPreflightError(
      () =>
        verifyAndPinTlsCiphers(
          { DEFAULT_CIPHERS: `${PINNED_TLS_CIPHERS}:@SECLEVEL=0` },
          false,
        ),
      "ERR_TLS_WEAK_CIPHER_SUITE",
      77,
    );
  });

  test("fails closed when a required TLS 1.3 suite is missing", () => {
    expectPreflightError(
      () =>
        verifyAndPinTlsCiphers(
          {
            DEFAULT_CIPHERS:
              "TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES256-GCM-SHA384",
          },
          false,
        ),
      "ERR_TLS_WEAK_CIPHER_SUITE",
      77,
    );
  });

  test("does not replace Bun.s3 in the suite process", () => {
    expect(Bun.s3).toBeInstanceOf(Bun.S3Client);
    const file = Bun.s3.file("missing.txt");
    expect(typeof file.stat).toBe("function");
    expect(Number.isNaN(file.size)).toBe(true);
  });
});
