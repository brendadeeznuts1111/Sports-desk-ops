import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoundedStampCache,
  computeCustomersCohortPayload,
  createCachedJsonReader,
  createCustomerRowFinder,
  createDevLiveWagersLoader,
  DashboardHealthTracker,
  DashboardMarkdownCache,
  FALLBACK_DEV_WAGERS,
  isDashboardAuthRequired,
  parseFiniteNumber,
  parseRepriceMode,
  parseRouterAuditMode,
  projectLiveWagerRow,
} from "@sportsdesk-ops/backend";

const SCRATCH = mkdtempSync(path.join(tmpdir(), "sd-backend-ws-"));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("@sportsdesk-ops/backend workspace services", () => {
  test("BoundedStampCache & createCachedJsonReader invalidate when mtime/size changes", async () => {
    const cache = new BoundedStampCache<number>(2);
    cache.set("a", "10:1", 100);
    cache.set("b", "10:1", 200);
    expect(cache.getIfFresh("a", "10:1")).toBe(100);
    expect(cache.getIfFresh("a", "11:1")).toBeUndefined();
    cache.set("c", "10:1", 300);
    expect(cache.size).toBe(1);

    const filePath = path.join(SCRATCH, "cached.json");
    writeFileSync(filePath, JSON.stringify({ seq: 1 }));
    const reader = createCachedJsonReader(8);

    const first = await reader.readCachedJson<{ seq: number }>(filePath);
    expect(first?.value.seq).toBe(1);

    // Update file content so size/mtime changes
    writeFileSync(
      filePath,
      JSON.stringify({ seq: 2, note: "updated-stamp-size" }),
    );
    const second = await reader.readCachedJson<{ seq: number }>(filePath);
    expect(second?.value.seq).toBe(2);
    expect(second?.stamp).not.toBe(first?.stamp);

    expect(
      await reader.readCachedJson(path.join(SCRATCH, "missing.json")),
    ).toBeNull();
  });

  test("query parsers and auth environment gating match dashboard contracts", () => {
    expect(parseFiniteNumber(" -135 ")).toBe(-135);
    expect(parseFiniteNumber("NaN")).toBeUndefined();
    expect(parseFiniteNumber("")).toBeUndefined();
    expect(parseRepriceMode("floor")).toBe("floor");
    expect(parseRepriceMode("exact")).toBe("exact");
    expect(parseRepriceMode("invalid")).toBeUndefined();
    expect(parseRouterAuditMode("enforced_lockout")).toBe("enforced_lockout");
    expect(parseRouterAuditMode("other")).toBeUndefined();

    expect(isDashboardAuthRequired({ NODE_ENV: "production" })).toBe(true);
    expect(
      isDashboardAuthRequired({
        NODE_ENV: "production",
        SPORTSDESK_AUTH_DISABLED: "1",
      }),
    ).toBe(false);
    expect(isDashboardAuthRequired({ NODE_ENV: "development" })).toBe(false);
    expect(
      isDashboardAuthRequired({
        NODE_ENV: "development",
        SPORTSDESK_AUTH_REQUIRED: "1",
      }),
    ).toBe(true);
  });

  test("projectLiveWagerRow classifies CRITICAL/STEAM/LATENCY/RECREATIONAL with autoExecute: false", async () => {
    const deps = {
      parseShortDesc: (raw: unknown) => ({
        isLive: String(raw).includes("[LIVE]"),
        legs: [{ sport: "NFL", game: "Bills @ Chiefs", pick: "Under 47.5" }],
      }),
      sharpCustomerIds: new Set(["GP301"]),
    };

    const sharpRow = projectLiveWagerRow(
      { CustomerID: "gp301", AmountWagered: 500, WagerNumber: "W-1" },
      0,
      deps,
    );
    expect(sharpRow.alertTier).toBe("CRITICAL");
    expect(sharpRow.maxRecommendedStake).toBe(250);
    expect(sharpRow.autoExecute).toBe(false);

    const steamRow = projectLiveWagerRow(
      { CustomerID: "REC9", AmountWagered: 6000, clvCents: 6.5 },
      1,
      deps,
    );
    expect(steamRow.alertTier).toBe("STEAM");
    expect(steamRow.maxRecommendedStake).toBe(500);
    expect(steamRow.autoExecute).toBe(false);

    const liveRow = projectLiveWagerRow(
      {
        CustomerID: "REC9",
        AmountWagered: 200,
        ShortDesc: "[LIVE] Team A",
      },
      2,
      deps,
    );
    expect(liveRow.alertTier).toBe("LATENCY");
    expect(liveRow.autoExecute).toBe(false);

    const wagerFile = path.join(SCRATCH, "live-wagers.json");
    writeFileSync(
      wagerFile,
      JSON.stringify({ LIST: [{ CustomerID: "GP301", AmountWagered: 1200 }] }),
    );
    const loader = createDevLiveWagersLoader({
      cwd: SCRATCH,
      candidatePaths: [wagerFile],
      loadSharpDeps: async () => deps,
    });
    const payload = await loader.buildLiveWagersPayload();
    expect(payload.autoExecute).toBe(false);
    expect(payload.wagers.length).toBe(1);
    expect(payload.criticalSteamCount).toBe(1);
    expect(payload.provenance.kind).toBe("capture");
    expect(payload.provenance.sourcePath).toBe("live-wagers.json");
    expect(payload.provenance.sourcePath).not.toContain(SCRATCH);

    const fixtureDir = path.join(SCRATCH, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const fixtureWagerFile = path.join(fixtureDir, "live-wagers.partial.json");
    writeFileSync(
      fixtureWagerFile,
      JSON.stringify({ LIST: [{ CustomerID: "REC9", AmountWagered: 200 }] }),
    );
    const fixtureLoader = createDevLiveWagersLoader({
      cwd: SCRATCH,
      candidatePaths: [fixtureWagerFile],
      loadSharpDeps: async () => deps,
    });
    const fixturePayload = await fixtureLoader.buildLiveWagersPayload();
    expect(fixturePayload.provenance.kind).toBe("fixture");
    expect(fixturePayload.provenance.sourcePath).toBe(
      "fixtures/live-wagers.partial.json",
    );

    const emptyLoader = createDevLiveWagersLoader({
      cwd: SCRATCH,
      candidatePaths: [path.join(SCRATCH, "does-not-exist.json")],
      loadSharpDeps: async () => deps,
    });
    const fallback = await emptyLoader.buildLiveWagersPayload();
    expect(fallback.autoExecute).toBe(false);
    expect(fallback.wagers.length).toBe(FALLBACK_DEV_WAGERS.length);
    expect(fallback.provenance.kind).toBe("fallback");
    expect(fallback.provenance.sourcePath).toBeNull();
  });

  test("createCustomerRowFinder & computeCustomersCohortPayload aggregate dynamically", async () => {
    const enrichedPath = path.join(SCRATCH, "enriched.json");
    const profilesPath = path.join(SCRATCH, "profiles.json");
    writeFileSync(
      enrichedPath,
      JSON.stringify([{ customer_id: "GP301", tier: "T1" }]),
    );
    writeFileSync(
      profilesPath,
      JSON.stringify({ profiles: [{ customerId: "RF2003", tier: "REC" }] }),
    );

    const { findCustomerRow } = createCustomerRowFinder<{
      customer_id?: string;
      tier?: string;
    }>({
      enrichedPaths: [enrichedPath],
      profilesPath,
    });

    expect((await findCustomerRow(" gp301 "))?.tier).toBe("T1");
    expect((await findCustomerRow("rf2003"))?.tier).toBe("REC");
    expect(await findCustomerRow("UNKNOWN")).toBeNull();

    const cohorts = computeCustomersCohortPayload({
      backtestLeaderboard: [{ customer: "gp301" }, { customer: "NEW_1" }],
      fixtures: [{ customer_id: "FIX_1" }, { customer_id: "GP301" }],
      keyNumberBuyerIds: ["GP301", "KN_2"],
      hookSyndicateIds: ["SYN_1"],
    });
    expect(cohorts.cohorts).toEqual({
      backtestCount: 2,
      keyNumberSharpsCount: 2,
      hookSyndicateCount: 1,
      fixtureCount: 2,
      fullBookSpecCount: 2,
      uniqueSurveillanceCount: 5,
    });
    expect(cohorts.provenance.kind).toBe("fixture");

    const captureCohorts = computeCustomersCohortPayload({
      backtestLeaderboard: [{ customer: "gp301" }],
      fixtures: [{ customer_id: "FIX_1" }],
      localBookRows: [{ customer_id: "GP301" }, { customer_id: "BOOK_ONLY_1" }],
      keyNumberBuyerIds: ["GP301"],
      hookSyndicateIds: [],
    });
    expect(captureCohorts.cohorts.fullBookSpecCount).toBe(2);
    expect(captureCohorts.cohorts.uniqueSurveillanceCount).toBe(3);
    expect(captureCohorts.provenance.kind).toBe("capture");
    expect(captureCohorts.provenance.sourcePath).toBe(
      "enriched_customers_full.json",
    );

    const emptyCohorts = computeCustomersCohortPayload({
      backtestLeaderboard: [],
      fixtures: [],
      keyNumberBuyerIds: [],
      hookSyndicateIds: [],
    });
    expect(emptyCohorts.provenance.kind).toBe("unavailable");
  });

  test("DashboardHealthTracker throttles probes by interval", async () => {
    let clock = 1_000;
    let dbProbes = 0;
    let cleanups = 0;
    let alertReads = 0;

    const tracker = new DashboardHealthTracker({
      dbProbeMs: 5_000,
      sweepMs: 300_000,
      alertProbeMs: 15_000,
      isDbConfigured: () => true,
      probeDb: async () => {
        dbProbes++;
      },
      cleanupSessions: async () => {
        cleanups++;
        return 2;
      },
      getAlertMetrics: () => {
        alertReads++;
        return { status: "ok", dead: 0, backlog: 0 };
      },
      getPort: () => 4022,
      now: () => clock,
    });

    const first = await tracker.sample();
    expect(first.status).toBe("ok");
    expect(first.db).toBe("connected");
    expect(first.purgedSessions).toBe(2);
    expect(dbProbes).toBe(1);
    expect(cleanups).toBe(1);

    clock += 2_000;
    await tracker.sample();
    expect(dbProbes).toBe(1);
    expect(cleanups).toBe(1);

    clock += 4_000;
    await tracker.sample();
    expect(dbProbes).toBe(2);
    expect(cleanups).toBe(1);
    expect(alertReads).toBe(2); // constructor + initial sample
  });

  test("DashboardMarkdownCache renders local markdown and handles missing files", async () => {
    const mdPath = path.join(SCRATCH, "dashboard.md");
    writeFileSync(mdPath, "# SportsDesk\n\nLive **check**");
    const cache = new DashboardMarkdownCache(mdPath);

    const rendered = await cache.load();
    expect(rendered?.markdown).toContain("# SportsDesk");
    expect(rendered?.html).toContain("<h1");

    const missingCache = new DashboardMarkdownCache(
      path.join(SCRATCH, "missing.md"),
    );
    expect(await missingCache.load()).toBeNull();
  });
});
