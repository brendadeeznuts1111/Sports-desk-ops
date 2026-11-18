import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect as nodeInspect } from "node:util";
import { S3Client } from "bun";
import { createDashboardApi } from "@sportsdesk-ops/api";
import { createR2PipelineService } from "@sportsdesk-ops/backend";
import {
  parseDashboardWsSignal,
  type R2PipelineApiResponse,
} from "@sportsdesk-ops/contracts";
import { buildAutomationsSnapshot } from "../lib/automations_status.ts";
import {
  assertCloudflareTokenIsolation,
  assertNoSecretLeak,
  createR2Client,
  Fantasy402ApiClient,
  readGsliveTicketVerifyArtifact,
  runGsliveTicketVerification,
  runRuntimePreflightAudit,
  summarizeTicketPayload,
} from "../scripts/verify-gslive-tickets.ts";
import type { DnsCacheTelemetry } from "../lib/bun_dns.ts";

const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_REGION",
] as const;

const mutableEnv = Bun.env as Record<string, string | undefined>;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  savedEnv.set(key, mutableEnv[key]);
}

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

describe("assertNoSecretLeak", () => {
  test("passes on redacted output and ignores empty strings", () => {
    expect(() =>
      assertNoSecretLeak("S3Client { accessKeyId: '[REDACTED len=12]' }", [
        "",
        "raw-secret-123",
      ]),
    ).not.toThrow();
  });

  test("throws when a raw secret, Bearer token, or GSLIVE_SESSION_ID leaks", () => {
    expect(() =>
      assertNoSecretLeak("leaked raw-secret-123 here", ["raw-secret-123"]),
    ).toThrow("ERR_INSP_SECRET_REDACTION_LEAK");

    expect(() =>
      assertNoSecretLeak("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc", []),
    ).toThrow("ERR_INSP_SECRET_REDACTION_LEAK");

    expect(() =>
      assertNoSecretLeak("cookie GSLIVE_SESSION_ID=sess_xyz", []),
    ).toThrow("ERR_INSP_SECRET_REDACTION_LEAK");
  });
});

describe("Fantasy402ApiClient", () => {
  test("rejects BILLY666 or empty agentId", () => {
    expect(
      () =>
        new Fantasy402ApiClient({
          baseUrl: "https://example.invalid",
          agentId: "BILLY666",
          agentOwner: "BILLY666",
          jwt: "secret-jwt-token-value",
        }),
    ).toThrow("ERR_F402_MASTER_AGENT_FORBIDDEN");

    expect(
      () =>
        new Fantasy402ApiClient({
          baseUrl: "https://example.invalid",
          agentId: "",
          agentOwner: "OWNER1",
          jwt: "secret-jwt-token-value",
        }),
    ).toThrow("ERR_F402_MASTER_AGENT_FORBIDDEN");
  });

  test("keeps #jwt in true ES #private slot and redacts inspect/JSON", () => {
    const rawJwt = "eyJhbGciOiJIUzI1NiJ9.super_secret_payload.sig";
    const client = new Fantasy402ApiClient({
      baseUrl: "https://example.invalid/",
      agentId: "LEAF101",
      agentOwner: "MASTER100",
      jwt: rawJwt,
    });

    expect(client.baseUrl).toBe("https://example.invalid");
    expect(Object.keys(client)).not.toContain("jwt");
    expect(Object.getOwnPropertyNames(client)).not.toContain("jwt");
    expect(Reflect.ownKeys(client)).not.toContain("jwt");
    expect(Object.getOwnPropertyDescriptors(client)).not.toHaveProperty("jwt");

    const rawInspect = nodeInspect(client, {
      showHidden: true,
      customInspect: false,
      getters: true,
    });
    expect(rawInspect).not.toContain(rawJwt);

    const bunInspected = Bun.inspect(client, { depth: Infinity });
    const nodeInspected = nodeInspect(client, {
      showHidden: true,
      depth: null,
    });
    const json = JSON.stringify(client);

    for (const output of [bunInspected, nodeInspected, json]) {
      expect(output).not.toContain(rawJwt);
      expect(output).toContain(`[REDACTED len=${rawJwt.length} sha256:`);
    }

    expect(client[Bun.inspect.custom](-1, {}, nodeInspect)).toBe(
      "[Fantasy402ApiClient]",
    );
  });

  test("postForm sends auth header, strips BOM, and evicts stale token on 401/HTML trap", async () => {
    const rawJwt = "jwt_live_test_999";
    let lastAuth = "";
    let mode: "bom-json" | "html-trap" | "unauthorized" = "bom-json";
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(init?.headers);
      lastAuth = headers.get("authorization") ?? "";
      if (mode === "unauthorized") {
        return new Response("Unauthorized", { status: 401 });
      }
      if (mode === "html-trap") {
        return new Response("  \n<html>login</html>", { status: 200 });
      }
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const payload = new TextEncoder().encode('  {"ok":true,"count":2}');
      const body = new Uint8Array(bom.length + payload.length);
      body.set(bom, 0);
      body.set(payload, bom.length);
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const client = new Fantasy402ApiClient({
        baseUrl: "http://127.0.0.1:4020",
        agentId: "LEAF101",
        agentOwner: "MASTER100",
        jwt: rawJwt,
      });

      const ok = await client.postForm<{ ok: boolean; count: number }>(
        "/cloud/api/Manager/getBetReport",
        { week: "0" },
      );
      expect(ok).toEqual({ ok: true, count: 2 });
      expect(lastAuth).toBe(`Bearer ${rawJwt}`);

      mode = "html-trap";
      await expect(
        client.postForm("/cloud/api/Manager/getBetReport", {}),
      ).rejects.toThrow("ERR_F402_HTML_LOGIN_TRAP_200");
      expect(JSON.stringify(client)).toContain("<UNSET>");

      const client401 = new Fantasy402ApiClient({
        baseUrl: "http://127.0.0.1:4020",
        agentId: "LEAF101",
        agentOwner: "MASTER100",
        jwt: "jwt_401_test",
      });
      mode = "unauthorized";
      await expect(
        client401.postForm("/cloud/api/Manager/getBetReport", {}),
      ).rejects.toThrow("ERR_F402_HTTP_401");
      expect(JSON.stringify(client401)).toContain("<UNSET>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createR2Client", () => {
  test("enforces token bleed guard and missing auth guard", () => {
    mutableEnv.CLOUDFLARE_API_TOKEN = "cf_pages_tok";
    mutableEnv.CLOUDFLARE_R2_API_TOKEN = "cf_r2_tok";
    expect(() => createR2Client()).toThrow("ERR_CF_TOKEN_BLEED_10000");

    delete mutableEnv.CLOUDFLARE_API_TOKEN;
    delete mutableEnv.CLOUDFLARE_R2_API_TOKEN;
    delete mutableEnv.R2_ACCESS_KEY_ID;
    delete mutableEnv.R2_SECRET_ACCESS_KEY;
    delete mutableEnv.AWS_ACCESS_KEY_ID;
    delete mutableEnv.AWS_SECRET_ACCESS_KEY;
    expect(() => createR2Client()).toThrow("ERR_R2_AUTH_MISSING");
  });

  test("returns frozen config with closure getters and sealed S3Client inspection", () => {
    const ak = "AKIA_TEST_KEY_ID_001";
    const sk = "SECRET_TEST_KEY_VALUE_002";
    delete mutableEnv.CLOUDFLARE_API_TOKEN;
    delete mutableEnv.CLOUDFLARE_R2_API_TOKEN;
    mutableEnv.R2_ACCESS_KEY_ID = ak;
    mutableEnv.R2_SECRET_ACCESS_KEY = sk;
    mutableEnv.R2_BUCKET = "test-bucket";
    mutableEnv.R2_ENDPOINT = "https://example.r2.invalid";
    mutableEnv.R2_REGION = "enam";

    const { client, config } = createR2Client();

    expect(client).toBeInstanceOf(S3Client);
    expect(typeof client.file).toBe("function");
    expect(typeof client.write).toBe("function");

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.keys(config)).not.toContain("accessKeyId");
    expect(Object.keys(config)).not.toContain("secretAccessKey");
    expect(config.accessKeyId).toBe(ak);
    expect(config.secretAccessKey).toBe(sk);

    const akDesc = Object.getOwnPropertyDescriptor(config, "accessKeyId");
    expect(akDesc?.enumerable).toBe(false);
    expect(akDesc?.configurable).toBe(false);
    expect(akDesc?.value).toBeUndefined();

    for (const formatted of [
      Bun.inspect(config, { depth: Infinity }),
      nodeInspect(config, { showHidden: true, depth: null }),
      JSON.stringify(config),
      Bun.inspect(client, { depth: Infinity }),
      nodeInspect(client, { showHidden: true, depth: null }),
      JSON.stringify(client),
      Bun.inspect({ client, config }, { depth: Infinity }),
    ]) {
      expect(formatted).not.toContain(ak);
      expect(formatted).not.toContain(sk);
      expect(formatted).toContain("[REDACTED len=");
    }

    expect(config[Bun.inspect.custom](-1, {}, nodeInspect)).toBe(
      "[R2ClientConfig]",
    );
    const s3Custom = Reflect.get(client, Bun.inspect.custom) as (
      depth: number,
      options: Record<string, unknown>,
      inspect: typeof nodeInspect,
    ) => string;
    expect(s3Custom(-1, {}, nodeInspect)).toBe("[S3Client]");
  });
});

describe("runRuntimePreflightAudit", () => {
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

  test("verifies bindings and reports clean DNS telemetry without mutating Bun.s3", () => {
    delete mutableEnv.CLOUDFLARE_API_TOKEN;
    delete mutableEnv.CLOUDFLARE_R2_API_TOKEN;
    mutableEnv.R2_ACCESS_KEY_ID = "AKIA_PREFLIGHT_ID_001";
    mutableEnv.R2_SECRET_ACCESS_KEY = "secret-preflight-value-002";

    const globalS3 =
      typeof Bun.s3 === "object" && Bun.s3 !== null ? Bun.s3 : null;
    const beforeSymbols =
      globalS3 === null ? 0 : Object.getOwnPropertySymbols(globalS3).length;

    const report = runRuntimePreflightAudit({
      dnsTelemetry: { ...zeroDns, totalCount: 1_000, cacheMisses: 1_000 },
    });

    expect(report.bunVersion).toBe(Bun.version);
    expect(report.bindings.S3Client).toBe("function");
    expect(report.tokenIsolation).toBe("isolated");
    expect(report.dnsCache.errorRatioBps).toBe(0);
    expect(report.globalS3InspectRedacted).toBe(true);
    if (globalS3 !== null) {
      expect(Object.getOwnPropertySymbols(globalS3).length).toBe(beforeSymbols);
    }
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

describe("GSLive ticket verification, automations & dashboard integration", () => {
  test("summarizeTicketPayload excludes ALERT/BLOCKED noise and sums integer cents", () => {
    const totals = summarizeTicketPayload({
      LIST: [
        {
          TicketWriter: "Internet",
          AmountWagered: 250,
          VolumeAmount: 250,
          ToWinAmount: 227.27,
        },
        {
          TicketWriter: "GSLIVE",
          AmountWagered: 100,
          VolumeAmount: 150,
          ToWinAmount: 90.91,
        },
        {
          TicketWriter: "ALERT",
          AmountWagered: 250,
          VolumeAmount: 250,
          ToWinAmount: 227.27,
        },
        {
          TicketWriter: "BLOCKED",
          AmountWagered: 100,
          VolumeAmount: 100,
          ToWinAmount: 90,
        },
      ],
    });

    expect(totals).toEqual({
      totalRows: 4,
      actionableTickets: 2,
      sentinelNoiseCount: 2,
      volumeMismatchCount: 1,
      totalWageredCents: 35_000,
      totalVolumeCents: 40_000,
      totalToWinCents: 31_818,
    });
  });

  test("runGsliveTicketVerification writes sanitized receipt, populates buildAutomationsSnapshot, and wires API + UI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gslive-verify-"));
    try {
      const fixturePath = join(dir, "tickets.json");
      const outPath = join(dir, "verify-out.json");
      const bridgeStatePath = join(dir, "bridge-state.json");
      writeFileSync(
        fixturePath,
        JSON.stringify({
          LIST: [
            {
              TicketWriter: "Internet",
              AmountWagered: 500,
              VolumeAmount: 500,
              ToWinAmount: 454.55,
            },
            {
              TicketWriter: "ALERT",
              AmountWagered: 500,
              VolumeAmount: 500,
              ToWinAmount: 454.55,
            },
          ],
        }),
      );
      writeFileSync(
        bridgeStatePath,
        JSON.stringify({
          updatedAt: "2026-11-15T20:00:00.000Z",
          jobs: [
            {
              id: "bridge3c",
              label: "GSLive tally (3c)",
              ok: true,
              durationMs: 412,
            },
          ],
          alerts: [],
          snapshots: {},
          lastAlertsBySchedule: {},
        }),
      );

      const summary = await runGsliveTicketVerification({
        fromPath: fixturePath,
        outPath,
        now: () => new Date("2026-11-15T20:30:00.000Z"),
      });

      expect(summary.available).toBe(true);
      expect(summary.mode).toBe("fixture");
      expect(summary.canaryPassed).toBe(true);
      expect(summary.clientSealed).toBe(true);
      expect(summary.actionableTickets).toBe(1);
      expect(summary.sentinelNoiseCount).toBe(1);
      expect(readGsliveTicketVerifyArtifact(outPath)).toEqual(summary);

      const automations = buildAutomationsSnapshot({
        env: { F402_AGENT_ID: "LEAF101" },
        bridgeStatePath,
        ticketVerifyPath: outPath,
        now: () => new Date("2026-11-15T20:31:00.000Z"),
      });

      const verifySched = automations.schedules.find(
        (s) => s.id === "sched_gslive_tickets_verify_30m",
      );
      expect(verifySched).toBeDefined();
      expect(verifySched?.owner).toBe("daemon");
      expect(verifySched?.gateReady).toBe(true);
      expect(verifySched?.lastTriggeredAt).toBe("2026-11-15T20:30:00.000Z");
      expect(automations.bridgeJobs).toHaveLength(1);
      expect(automations.ticketVerification?.actionableTickets).toBe(1);
      expect(
        parseDashboardWsSignal(
          JSON.stringify({
            type: "topic-event",
            topic: "dashboard",
            event: "automations-updated",
            timestamp: "2026-11-15T20:30:00.000Z",
          }),
        ),
      ).toEqual({ kind: "automations-updated" });

      const r2Service = createR2PipelineService({
        publicBase: "https://pub.example.r2.dev",
        fetchImpl: async (url) => {
          if (url.startsWith("http://127.0.0.1:4020/")) {
            return new Response(JSON.stringify({ status: "ok" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({ generatedAt: "2026-11-15T20:30:00.000Z" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "last-modified": "Sun, 15 Nov 2026 20:30:00 GMT",
              },
            },
          );
        },
        getAutomationsSnapshot: () => automations,
      });

      const api = createDashboardApi({
        auth: {
          login: () => Response.json({ ok: false }, { status: 401 }),
          logout: () => Response.json({ ok: true }),
          me: () => Response.json({ authenticated: false }),
        },
        getHealthPayload: async () => ({ ok: true }),
        loadDashboardMarkdown: async () => null,
        dns: {
          getTelemetryPayload: () => ({}),
          benchmark: async () => ({}),
          classifyIp: async () => ({}),
        },
        customers: {
          getCohortReport: async () => ({ versionStamp: "v1", payload: {} }),
          getProfile: async () => null,
          getRating: async () => null,
        },
        execTerminal: async () => ({}),
        rankings: {
          getAll: async () => ({
            generatedAtIso: "2026-11-15T20:31:00.000Z",
            payload: {},
          }),
          getConduits: async () => [],
        },
        getLiveWagersPayload: async () => ({}),
        getTiersConfig: async () => ({}),
        alerts: {
          sweepOnce: async () => ({}),
          list: () => [],
          ack: async () => false,
          retry: async () => null,
          getShiftSummary: () => ({}),
        },
        getTaxonomyCatalog: () => ({}),
        runShadowPricing: async () => ({}),
        getBuildMatrix: async () => ({
          targets: [],
          generatedAt: "2026-11-15T20:31:00.000Z",
        }),
        getR2PipelinePayload: (opts) => r2Service.probeAll(opts),
        getAutomationsPayload: () => automations,
        runGsliveTicketVerify: async (opts) => {
          expect(opts?.dryRun).toBe(true);
          return summary;
        },
      });

      const automationsRes = await api.fetch(
        new Request("http://127.0.0.1:4022/api/automations"),
      );
      expect(automationsRes.status).toBe(200);
      const automationsBody =
        (await automationsRes.json()) as typeof automations;
      expect(automationsBody.ticketVerification?.canaryPassed).toBe(true);

      const verifyRes = await api.fetch(
        new Request("http://127.0.0.1:4022/api/gslive/verify-tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: true }),
        }),
      );
      expect(verifyRes.status).toBe(200);
      const verifyBody = (await verifyRes.json()) as {
        ok: boolean;
        summary: typeof summary;
      };
      expect(verifyBody.ok).toBe(true);
      expect(verifyBody.summary.actionableTickets).toBe(1);

      const r2Res = await api.fetch(
        new Request("http://127.0.0.1:4022/api/r2/pipeline?refresh=1"),
      );
      const r2Payload = (await r2Res.json()) as R2PipelineApiResponse;
      expect(r2Payload.automations?.ticketVerification?.canaryPassed).toBe(
        true,
      );
      expect(
        r2Payload.automations?.schedules.some(
          (s) => s.id === "sched_gslive_tickets_verify_30m",
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
