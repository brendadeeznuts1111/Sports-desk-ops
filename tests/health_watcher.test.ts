import { describe, expect, test } from "bun:test";

import {
  formatHealthWatcherMessage,
  runHealthWatcherTick,
  snapshotFromHealthPayload,
  type HealthWatcherState,
} from "../lib/health_watcher.ts";
import type { DeskEnhancedHealthPayload } from "../lib/desk_enhanced_health.ts";

const healthyPayload = (): DeskEnhancedHealthPayload => ({
  status: "healthy",
  operationalStatus: "ok",
  dataStatus: "stale",
  httpStatus: 200,
  timestamp: "2026-11-09T00:00:00.000Z",
  port: 4020,
  hostname: "localhost",
  url: "http://localhost:4020/",
  uptimeSeconds: 1,
  runtime: "Bun",
  ingress: {},
  nodeEnv: "test",
  version: { gitSha: null, buildTime: null, nodeEnv: "test" },
  checks: {
    daemon: "ok",
    auth: {
      f402: {
        status: "ok",
        source: "session-file",
        expiresInSeconds: 100,
        mintCapable: false,
        remediation: null,
      },
      gslive: {
        status: "ok",
        source: "keychain",
        probeStatus: 200,
        mintCapable: false,
        automintBlocked: null,
        remediation: null,
        user: null,
        partner: null,
      },
    },
    pipelines: {
      r2Fresh: 1,
      r2Total: 1,
      r2StaleKeys: [],
      dataStaleKeys: ["f402-weblog"],
      checks: {
        ticker: "ok",
        gslive: "ok",
        weblog: "stale-data",
        wagers: "missing",
      },
    },
  },
  sources: {
    auth: {
      f402: {
        status: "ok",
        source: "session-file",
        expiresInSeconds: 100,
        mintCapable: false,
        remediation: null,
      },
      gslive: {
        status: "ok",
        source: "keychain",
        probeStatus: 200,
        mintCapable: false,
        automintBlocked: null,
        remediation: null,
        user: null,
        partner: null,
      },
    },
  },
  degradedReasons: [
    {
      kind: "data",
      message: "R2 sink 'f402-weblog' has stale data (>24h)",
      severity: "warn",
    },
  ],
});

describe("health watcher", () => {
  test("formatMessage ignores data-only reasons on degraded", () => {
    const snapshot = snapshotFromHealthPayload({
      ...healthyPayload(),
      operationalStatus: "degraded",
      status: "degraded",
      degradedReasons: [
        ...healthyPayload().degradedReasons,
        {
          kind: "auth",
          message: "GSLive session expired",
          action: "set GSID manually",
          severity: "warn",
        },
      ],
    });
    const html = formatHealthWatcherMessage(snapshot, "ok");
    expect(html).toContain("System degraded");
    expect(html).toContain("GSLive session expired");
    expect(html).not.toContain("f402-weblog");
  });

  test("does not alert when operational status is unchanged", async () => {
    let saved: HealthWatcherState | null = null;
    const result = await runHealthWatcherTick({
      dryRun: true,
      loadState: async () => ({
        schemaVersion: 1,
        lastOperationalStatus: "ok",
        updatedAt: "2026-11-09T00:00:00.000Z",
      }),
      saveState: async (state) => {
        saved = state;
      },
      fetchSnapshot: async () => snapshotFromHealthPayload(healthyPayload()),
    });
    expect(result.transitioned).toBe(false);
    expect(result.alerted).toBe(false);
    expect(saved).toBeNull();
  });

  test("alerts on transition to degraded and records state", async () => {
    let saved: HealthWatcherState | undefined;
    const sends: string[] = [];
    const result = await runHealthWatcherTick({
      loadState: async () => ({
        schemaVersion: 1,
        lastOperationalStatus: "ok",
        updatedAt: "2026-11-09T00:00:00.000Z",
      }),
      saveState: async (state) => {
        saved = state;
      },
      fetchSnapshot: async () =>
        snapshotFromHealthPayload({
          ...healthyPayload(),
          operationalStatus: "degraded",
          status: "degraded",
          degradedReasons: [
            {
              kind: "publish",
              message: "ticker stale",
              action: "run bridge3a",
              severity: "warn",
            },
          ],
        }),
      sendHtml: async (_chatId, html) => {
        sends.push(html);
        return { ok: true };
      },
    });
    expect(result.transitioned).toBe(true);
    expect(result.alerted).toBe(true);
    expect(saved?.lastOperationalStatus).toBe("degraded");
    expect(sends[0]).toContain("ticker stale");
  });
});
