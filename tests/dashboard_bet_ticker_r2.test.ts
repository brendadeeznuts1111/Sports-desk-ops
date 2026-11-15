import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentDetailService,
  createBetTickerService,
  createDevLiveWagersLoader,
  createR2PipelineService,
  isSentinelTickerWriter,
  probeDaemon4020Status,
} from "@sportsdesk-ops/backend";
import { resolveDaemon4020State } from "@sportsdesk-ops/contracts";
import { parseShortDesc } from "../lib/live_wagers.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Bet-Ticker, R2 Pipeline & Agent Detail backend services", () => {
  test("isSentinelTickerWriter detects ALERT/BLOCKED and excludes them from loadDevLiveWagers totals", async () => {
    expect(isSentinelTickerWriter("ALERT")).toBe(true);
    expect(isSentinelTickerWriter(" blocked ")).toBe(true);
    expect(isSentinelTickerWriter("Internet")).toBe(false);
    expect(isSentinelTickerWriter("GSLIVE")).toBe(false);

    const dir = makeTempDir("sd-wagers-");
    const wagersPath = join(dir, "live-wagers.json");
    writeFileSync(
      wagersPath,
      JSON.stringify({
        LIST: [
          {
            WagerNumber: 1001,
            CustomerID: "GP301",
            AgentID: "AG99",
            TicketWriter: "Internet",
            WagerType: "S",
            AmountWagered: 500,
            VolumeAmount: 500,
            ToWinAmount: 455,
            ShortDesc: "[NFL] - KC Chiefs -3 -110",
            InsertDateTime: "2026-11-12T18:00:00Z",
          },
          {
            WagerNumber: 1002,
            CustomerID: "GP301",
            AgentID: "AG99",
            TicketWriter: "ALERT",
            WagerType: "S",
            AmountWagered: 500,
            VolumeAmount: 500,
            ToWinAmount: 455,
            ShortDesc: "ALERT MIRROR KC Chiefs",
            InsertDateTime: "2026-11-12T18:00:00Z",
          },
          {
            WagerNumber: 1003,
            CustomerID: "CUST2",
            AgentID: "AG88",
            TicketWriter: "BLOCKED",
            WagerType: "M",
            AmountWagered: 200,
            VolumeAmount: 200,
            ToWinAmount: 180,
            ShortDesc: "BLOCKED MIRROR",
            InsertDateTime: "2026-11-12T18:01:00Z",
          },
        ],
      }),
    );

    const loader = createDevLiveWagersLoader({
      cwd: dir,
      candidatePaths: [wagersPath],
      loadSharpDeps: async () => ({
        parseShortDesc,
        sharpCustomerIds: new Set(["GP301"]),
      }),
    });

    const result = await loader.loadDevLiveWagersDetailed();
    expect(result.rawRowCount).toBe(3);
    expect(result.sentinelNoiseCount).toBe(2);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.ticketId).toBe("1001");
    expect(result.rows[0]?.ticketWriter).toBe("Internet");

    const payload = await loader.buildLiveWagersPayload();
    expect(payload.totalRiskUsd).toBe(500);
    expect(payload.autoExecute).toBe(false);
  });

  test("createR2PipelineService dereferences pointer rollups, checks SLA and ADR #78 dataAgeSeconds, and probes :4020", async () => {
    const fixedNow = new Date("2026-11-12T18:00:00.000Z");
    const freshModified = new Date(
      fixedNow.getTime() - 5 * 60 * 1000,
    ).toUTCString();
    const staleModified = new Date(
      fixedNow.getTime() - 2 * 3600 * 1000,
    ).toUTCString();
    const oldDataEpochSec = Math.floor(
      (fixedNow.getTime() - 30 * 3600 * 1000) / 1000,
    );

    const mockFetch = async (url: string): Promise<Response> => {
      if (url.startsWith("http://127.0.0.1:4020/")) {
        throw new Error("ECONNREFUSED");
      }
      if (url.endsWith("/f402-bet-ticker/latest.json")) {
        return new Response(
          JSON.stringify({
            generatedAt: new Date(
              fixedNow.getTime() - 5 * 60 * 1000,
            ).toISOString(),
            deskDate: "2026-11-12",
            deskHour: 12,
            watermark: "768283486",
            ticketCount: 87,
            legCount: 110,
            alertTwinCount: 25,
            orphanCount: 25,
            byChannel: [
              {
                channel: "Internet",
                ticketCount: 40,
                legCount: 50,
                canonicalVolumeCents: 120000,
              },
              {
                channel: "ALERT",
                ticketCount: 25,
                legCount: 25,
                canonicalVolumeCents: 0,
              },
            ],
            byWagerType: [{ wagerType: "S", ticketCount: 60, legCount: 60 }],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Last-Modified": freshModified,
            },
          },
        );
      }
      if (url.endsWith("/gslive-tally/latest.json")) {
        return new Response(
          JSON.stringify({
            key: "gslive-tally/2026-11-09/rollup.json",
            sha256: "abc123",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Last-Modified": staleModified,
            },
          },
        );
      }
      if (url.endsWith("/gslive-tally/2026-11-09/rollup.json")) {
        return new Response(
          JSON.stringify({
            deskDate: "2026-11-09",
            window: {
              fromEpochSec: oldDataEpochSec - 3600,
              toEpochSec: oldDataEpochSec,
            },
            totals: {
              ticketCount: 150,
              legCount: 180,
              riskCents: 500000,
              settledNetCents: -25000,
            },
            gates: { balanced: true },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Last-Modified": staleModified,
            },
          },
        );
      }
      if (url.endsWith("/f402-weblog/latest.json")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/wagers-by-state/latest.json")) {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    };

    const r2 = createR2PipelineService({
      fetchImpl: mockFetch,
      now: () => fixedNow,
    });

    const report = await r2.probeAll({ refresh: true });
    expect(report.totalCount).toBe(4);
    expect(report.freshCount).toBe(1);
    expect(report.overallStatus).toBe("stale");
    expect(report.daemon4020.online).toBe(false);

    const tickerSink = report.sinks.find((s) => s.id === "f402-bet-ticker");
    expect(tickerSink?.state).toBe("fresh");
    expect(
      tickerSink?.metrics.some(
        (m) => m.label === "Watermark" && m.value === "768283486",
      ),
    ).toBe(true);

    const tallySink = report.sinks.find((s) => s.id === "gslive-tally");
    expect(tallySink?.resolvedRollupKey).toBe(
      "gslive-tally/2026-11-09/rollup.json",
    );
    expect(tallySink?.state).toBe("stale");
    expect(tallySink?.dataStale).toBe(true);
    expect(
      tallySink?.metrics.some(
        (m) => m.label === "Desk Date" && m.value === "2026-11-09",
      ),
    ).toBe(true);

    const weblogSink = report.sinks.find((s) => s.id === "f402-weblog");
    expect(weblogSink?.state).toBe("missing");

    const wagersStateSink = report.sinks.find(
      (s) => s.id === "wagers-by-state",
    );
    expect(wagersStateSink?.state).toBe("error");

    const bridge3a = await r2.getLatestBetTickerBridge3a();
    expect(bridge3a.available).toBe(true);
    expect(bridge3a.watermark).toBe("768283486");
    expect(bridge3a.byChannel.ALERT?.volumeCents).toBe(0);
  });

  test("createBetTickerService demuxes channels & wager types, excludes sentinel volume, and filters queries", async () => {
    const dir = makeTempDir("sd-ticker-");
    const wagersPath = join(dir, "live-wagers.json");
    const pendingPath = join(dir, "live-bets.json");
    const healthPath = join(dir, "capture-health.json");

    writeFileSync(
      wagersPath,
      JSON.stringify({
        observedAt: "2026-11-12T17:55:00Z",
        LIST: [
          {
            WagerNumber: "T1",
            CustomerID: "GP301",
            AgentID: "AG99",
            TicketWriter: "Internet",
            WagerType: "S",
            AmountWagered: 500,
            VolumeAmount: 750,
            ToWinAmount: 455,
            VIP: "1",
            LiveFlag: "N",
            ShortDesc: "[NFL] - Bills -3 -110",
            InsertDateTime: "2026-11-12T17:50:00Z",
          },
          {
            WagerNumber: "T2",
            CustomerID: "CUST2",
            AgentID: "FAKEMONEY",
            TicketWriter: "GSLIVE",
            WagerType: "L",
            AmountWagered: 300,
            VolumeAmount: 300,
            ToWinAmount: 270,
            VIP: "0",
            LiveFlag: "Y",
            ShortDesc: "[NBA] - Lakers LIVE +4.5",
            InsertDateTime: "2026-11-12T17:51:00Z",
          },
          {
            WagerNumber: "T3",
            CustomerID: "GP301",
            AgentID: "AG99",
            TicketWriter: "ALERT",
            WagerType: "S",
            AmountWagered: 500,
            VolumeAmount: 500,
            ToWinAmount: 455,
            ShortDesc: "ALERT TWIN",
            InsertDateTime: "2026-11-12T17:50:01Z",
          },
        ],
      }),
    );
    writeFileSync(
      pendingPath,
      JSON.stringify({
        pendingCount: 2,
        capturedAt: "2026-11-12T17:55:00Z",
        dataSource: "Report/Pending",
        games: [
          { wagered: 80000, toWin: 72500 },
          { wagered: 20000, toWin: 19000 },
        ],
      }),
    );
    writeFileSync(
      healthPath,
      JSON.stringify({
        updatedAt: "2026-11-12T17:56:00Z",
        sources: {
          getBetTicker: {
            outcome: "ok",
            finishedAt: "2026-11-12T17:56:00Z",
            rows: 3,
          },
        },
      }),
    );

    const ticker = createBetTickerService({
      cwd: dir,
      candidatePaths: [wagersPath],
      pendingBetsPath: pendingPath,
      captureHealthPath: healthPath,
      parseShortDesc,
      getSharpCustomerIds: () => new Set(["GP301"]),
    });

    const full = await ticker.getPayload();
    expect(full.autoExecute).toBe(false);
    expect(full.localFeed.rawRowCount).toBe(3);
    expect(full.localFeed.actionableTicketCount).toBe(2);
    expect(full.localFeed.sentinelNoiseCount).toBe(1);
    expect(full.localFeed.totalWageredCents).toBe(80000);
    expect(full.localFeed.totalVolumeCents).toBe(105000);
    expect(full.localFeed.volumeDiffersCount).toBe(1);
    expect(full.localFeed.vipCount).toBe(1);
    expect(full.localFeed.liveCount).toBe(1);

    const alertBucket = full.localFeed.byWriter.find(
      (b) => b.writer === "ALERT",
    );
    expect(alertBucket?.isSentinelNoise).toBe(true);
    expect(alertBucket?.wageredCents).toBe(0);
    expect(alertBucket?.count).toBe(1);

    expect(full.pendingGames.available).toBe(true);
    expect(full.pendingGames.gameCount).toBe(2);
    expect(full.captureHealth.available).toBe(true);
    expect(full.captureHealth.status).toBe("ok");

    const filtered = await ticker.getPayload({
      writer: "GSLIVE",
      wagerType: "L",
    });
    expect(filtered.localFeed.tickets.length).toBe(1);
    expect(filtered.localFeed.tickets[0]?.ticketId).toBe("T2");
  });

  test("createAgentDetailService resolves agent hierarchy, conduit metrics, customers, and unknown agents", async () => {
    const dir = makeTempDir("sd-agents-");
    const treePath = join(dir, "agent-tree.json");
    writeFileSync(
      treePath,
      JSON.stringify({
        nodes: {
          FAKEMONEY: { l: 3, p: "NOLAWOLF", t: "Agent" },
          SUB1: { l: 4, p: "FAKEMONEY", t: "SubAgent" },
        },
      }),
    );

    const agentSvc = createAgentDetailService({
      cwd: dir,
      agentTreePath: treePath,
      getConduits: async () => [
        {
          agentId: "FAKEMONEY",
          masterAgent: "NOLAWOLF",
          handleUsd: 1200000,
          wagers: 400,
          topCustomer: "VIP1",
          concentrationPct: 88.5,
          isProxyConduit: true,
        },
      ],
      getCustomers: () => [
        {
          id: "VIP1",
          agentId: "FAKEMONEY",
          tier: "TIER_1",
          score: 9.4,
          recommendedLimitUsd: 250,
          holdPct: -4.2,
        },
      ],
      getRecentWagers: async () => [
        {
          ticketId: "W-1",
          customerId: "VIP1",
          agentId: "FAKEMONEY",
          sport: "NFL",
          betType: "Spread",
          selection: "Chiefs -3",
          riskUsd: 1100,
          toWinUsd: 1000,
          ticketWriter: "Internet",
          alertTier: "CRITICAL",
          timestamp: "12:00",
        },
      ],
    });

    const found = await agentSvc.getAgentDetail("fakemoney");
    expect(found.found).toBe(true);
    expect(found.agentId).toBe("FAKEMONEY");
    expect(found.masterAgent).toBe("NOLAWOLF");
    expect(found.childAgents).toEqual(["SUB1"]);
    expect(found.conduit30d?.isProxyConduit).toBe(true);
    expect(found.customers.length).toBe(1);
    expect(found.recentWagers.length).toBe(1);
    expect(found.autoExecute).toBe(false);

    const missing = await agentSvc.getAgentDetail("NONEXISTENT_AGENT_999");
    expect(missing.found).toBe(false);
    expect(missing.childAgents).toEqual([]);
  });

  test("probeDaemon4020Status treats HTTP 503 /health JSON as reachable degraded instead of offline", async () => {
    const fixedNow = new Date("2026-11-14T03:45:00.000Z");

    const status503 = await probeDaemon4020Status({
      now: () => fixedNow,
      fetchImpl: async () =>
        Response.json(
          {
            status: "down",
            operationalStatus: "down",
            degradedReasons: [
              {
                message: "F402 session expired",
                kind: "auth",
                severity: "error",
              },
              {
                message: "GSLive session expired (Cloudflare blocks auto-mint)",
                kind: "auth",
                severity: "error",
              },
            ],
          },
          { status: 503 },
        ),
    });
    expect(status503.online).toBe(true);
    expect(status503.state).toBe("degraded");
    expect(status503.operationalStatus).toBe("down");
    expect(status503.status).toBe(503);
    expect(status503.latencyMs).toBeGreaterThanOrEqual(1);
    expect(status503.reason).toContain("HTTP 503");
    expect(status503.reason).toContain("F402 session expired");
    expect(resolveDaemon4020State(status503)).toBe("degraded");

    const status200Degraded = await probeDaemon4020Status({
      now: () => fixedNow,
      fetchImpl: async () =>
        Response.json(
          {
            status: "degraded",
            operationalStatus: "degraded",
            degradedReasons: [
              {
                message: "R2 sink 'f402-bet-ticker' publish is stale",
                kind: "publish",
                severity: "warn",
              },
            ],
          },
          { status: 200 },
        ),
    });
    expect(status200Degraded.online).toBe(true);
    expect(status200Degraded.state).toBe("degraded");
    expect(status200Degraded.operationalStatus).toBe("degraded");
    expect(status200Degraded.reason).toContain("f402-bet-ticker");
    expect(resolveDaemon4020State(status200Degraded)).toBe("degraded");

    const status404 = await probeDaemon4020Status({
      now: () => fixedNow,
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    expect(status404.online).toBe(false);
    expect(status404.state).toBe("offline");
    expect(resolveDaemon4020State(status404)).toBe("offline");
  });
});
