import { describe, expect, test } from "bun:test";

import { writeGsliveSessionMeta } from "../lib/gslive_session_meta.ts";
import { buildDeskEnhancedHealth } from "../lib/desk_enhanced_health.ts";
import type { GsliveSessionHealth } from "../lib/gslive_session_health.ts";
import type { R2PipelineKpis } from "../lib/r2_pipeline_kpis.ts";

const gsliveOk = (): GsliveSessionHealth => ({
  schemaVersion: 1,
  generatedAt: "2026-11-09T00:00:00.000Z",
  authModel: {
    durable: "GSID cookie (browser-managed, HttpOnly)",
    modern: "cookie-only GET /manager-tools/*",
    legacy: "ajax.php POST needs x-gs-session from signin",
  },
  session: {
    configured: true,
    source: "keychain",
    cookieName: "GSID",
    cookieNames: ["GSID"],
  },
  probe: {
    status: "ok",
    httpStatus: 200,
    latencyMs: 40,
    checkedAt: "2026-11-09T00:00:00.000Z",
    cfMitigated: null,
    detail: "ok",
    cached: false,
  },
  surfaceMap: [],
  advisory: "ok",
});

describe("buildDeskEnhancedHealth", () => {
  test("reports degraded when R2 data is stale but publish is fresh", async () => {
    const kpis: R2PipelineKpis = {
      "f402-weblog": {
        lastModified: null,
        ageSeconds: 100,
        stale: false,
        state: "fresh",
        reason: "fresh",
        dataAgeSeconds: 200_000,
        dataStale: true,
        dataWindowToMs: 1,
      },
    };
    const payload = await buildDeskEnhancedHealth({
      port: 4020,
      hostname: "localhost",
      url: "http://localhost:4020/",
      runtime: "Bun",
      ingress: { proxied: false },
      nodeEnv: "test",
      uptimeSeconds: 10,
      now: new Date("2026-11-09T00:00:00.000Z"),
      resolveGitSha: () => "abc1234",
      readF402: () => ({
        cookieHeader: "x",
        cookieNames: ["a"],
        obtainedAtIso: "2026-11-09T00:00:00.000Z",
        expiresAtIso: "2026-11-10T00:00:00.000Z",
      }),
      readGsliveHealth: async () => gsliveOk(),
      probeR2: async () => kpis,
    });
    expect(payload.operationalStatus).toBe("ok");
    expect(payload.dataStatus).toBe("stale");
    expect(payload.status).toBe("healthy");
    expect(payload.httpStatus).toBe(200);
    expect(payload.checks.pipelines.dataStaleKeys).toEqual(["f402-weblog"]);
    expect(payload.degradedReasons.every((r) => r.kind === "data")).toBe(true);
    expect(payload.checks.pipelines.checks.weblog).toBe("stale-data");
    expect(
      payload.degradedReasons.some((r) => r.message.includes("f402-weblog")),
    ).toBe(true);
    expect(payload.degradedReasons[0]?.action).toBeDefined();
  });

  test("returns 503 when both auth planes are missing", async () => {
    const payload = await buildDeskEnhancedHealth({
      port: 4020,
      hostname: "localhost",
      url: "http://localhost:4020/",
      runtime: "Bun",
      ingress: {},
      nodeEnv: "test",
      uptimeSeconds: 1,
      readF402: () => null,
      readGsliveHealth: async () => ({
        ...gsliveOk(),
        session: { ...gsliveOk().session, configured: false, source: "none" },
        probe: {
          ...gsliveOk().probe,
          status: "unconfigured",
          httpStatus: null,
        },
      }),
      probeR2: async () => ({}),
    });
    expect(payload.operationalStatus).toBe("down");
    expect(payload.httpStatus).toBe(503);
    expect(payload.status).toBe("down");
  });

  test("GSLive auth recommends manual GSID when expired", async () => {
    const payload = await buildDeskEnhancedHealth({
      port: 4020,
      hostname: "localhost",
      url: "http://localhost:4020/",
      runtime: "Bun",
      ingress: {},
      nodeEnv: "test",
      uptimeSeconds: 1,
      readF402: () => ({
        cookieHeader: "x",
        cookieNames: ["a"],
        obtainedAtIso: "2026-11-09T00:00:00.000Z",
        expiresAtIso: "2026-11-10T00:00:00.000Z",
      }),
      readGsliveHealth: async () => ({
        ...gsliveOk(),
        probe: { ...gsliveOk().probe, status: "expired" },
      }),
      probeR2: async () => ({}),
    });
    const gslive = payload.degradedReasons.find((r) => r.kind === "auth");
    expect(gslive?.message).toContain("Cloudflare blocks auto-mint");
    expect(gslive?.action).toContain("secrets:gslive set");
    expect(payload.checks.auth.gslive.mintCapable).toBe(false);
    expect(payload.checks.auth.gslive.automintBlocked).toBe("cloudflare");
  });

  test("surfaces GSLive identity from session metadata file", async () => {
    const prevMeta = Bun.env.GSLIVE_SESSION_META_FILE;
    const metaPath = `${import.meta.dir}/../scratch/desk-health-gslive-meta.json`;
    Bun.env.GSLIVE_SESSION_META_FILE = metaPath;
    try {
      await writeGsliveSessionMeta({
        adminUserName: "NOLAROSE",
        partner: 118,
      });
      const payload = await buildDeskEnhancedHealth({
        port: 4020,
        hostname: "localhost",
        url: "http://localhost:4020/",
        runtime: "Bun",
        ingress: {},
        nodeEnv: "test",
        uptimeSeconds: 1,
        readF402: () => ({
          cookieHeader: "x",
          cookieNames: ["a"],
          obtainedAtIso: "2026-11-09T00:00:00.000Z",
          expiresAtIso: "2026-11-10T00:00:00.000Z",
        }),
        readGsliveHealth: async () => gsliveOk(),
        probeR2: async () => ({}),
      });
      expect(payload.checks.auth.gslive.user).toBe("NOLAROSE");
      expect(payload.checks.auth.gslive.partner).toBe(118);
    } finally {
      if (prevMeta === undefined) delete Bun.env.GSLIVE_SESSION_META_FILE;
      else Bun.env.GSLIVE_SESSION_META_FILE = prevMeta;
    }
  });

  test("GSLive mint loop surfaces credential rotation remediation", async () => {
    const payload = await buildDeskEnhancedHealth({
      port: 4020,
      hostname: "localhost",
      url: "http://localhost:4020/",
      runtime: "Bun",
      ingress: {},
      nodeEnv: "test",
      uptimeSeconds: 1,
      gsliveMintFailureStreak: () => 3,
      readF402: () => ({
        cookieHeader: "x",
        cookieNames: ["a"],
        obtainedAtIso: "2026-11-09T00:00:00.000Z",
        expiresAtIso: "2026-11-10T00:00:00.000Z",
      }),
      readGsliveHealth: async () => gsliveOk(),
      probeR2: async () => ({}),
    });
    expect(payload.checks.auth.gslive.remediation).toContain(
      "secrets:gslive set",
    );
    expect(
      payload.degradedReasons.some((r) =>
        r.message.includes("mint failed repeatedly"),
      ),
    ).toBe(true);
  });

  test("bounds a hanging GSLive health probe and marks auth degraded with timeout", async () => {
    const payload = await buildDeskEnhancedHealth({
      port: 4020,
      hostname: "127.0.0.1",
      url: "http://127.0.0.1:4020/",
      runtime: "Bun",
      ingress: {},
      nodeEnv: "test",
      uptimeSeconds: 1,
      gsliveHealthTimeoutMs: 25,
      readF402: () => ({
        cookieHeader: "x",
        cookieNames: ["a"],
        obtainedAtIso: "2026-11-09T00:00:00.000Z",
        expiresAtIso: "2026-11-10T00:00:00.000Z",
      }),
      readGsliveHealth: () => new Promise(() => {}),
      hasF402MintCredentials: async () => false,
      probeR2: async () => ({}),
    });
    expect(payload.checks.auth.gslive.status).toBe("degraded");
    expect(payload.checks.auth.gslive.source).toBe("timeout");
    expect(
      payload.degradedReasons.some((r) => r.message.includes("timed out")),
    ).toBe(true);
  });
});
