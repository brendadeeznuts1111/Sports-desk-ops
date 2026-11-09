import { describe, expect, test } from "bun:test";
import {
  Rsk06DelayRecommender,
  type CandidateAccountTelemetry,
} from "../lib/rsk06_delay_recommender.ts";
import { Fantasy402ManagerWorker } from "../lib/f402_manager.ts";
import {
  deserializeDelayDodbin,
  serializeDelayDodbin,
  STREAM_PROVENANCE_MASKS,
  DODBIN_MAGIC,
} from "../lib/delay_dodbin_store.ts";

describe("Live Stream CLI Delay Evaluation & Clamp Dispatch Integration", () => {
  test("evaluates sharp live stream candidates into disjoint delay tiers and VIP shield", () => {
    const recommender = new Rsk06DelayRecommender();
    const candidates: CandidateAccountTelemetry[] = [
      {
        rowIndex: 0,
        customerLogin: "GX195", // Apex Spread Sniper
        leafAgent: "GOLD22",
        inPlayVelocityScore: 8,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.95, // -> T1 (12s)
        syndicateTwinConfirmed: false,
      },
      {
        rowIndex: 1,
        customerLogin: "AT811", // Syndicate Probe
        leafAgent: "ATEAM",
        inPlayVelocityScore: 2,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.85,
        syndicateTwinConfirmed: true, // -> T2 (11s)
      },
      {
        rowIndex: 2,
        customerLogin: "NJD500", // High-CLV Whale
        leafAgent: "NOLAJHR",
        inPlayVelocityScore: 4,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.7, // -> T3 (10s)
        syndicateTwinConfirmed: false,
      },
      {
        rowIndex: 3,
        customerLogin: "ABN18", // Signal Donor
        leafAgent: "ADRIANBRAN",
        inPlayVelocityScore: 10,
        isVipShielded: true, // -> VIP Shielded (never clamped)
        currentDelaySeconds: 0,
        oddsSnipeConfidence: 0.9,
        syndicateTwinConfirmed: false,
      },
    ];

    const result = recommender.evaluateRecommendations({
      candidates,
      gsliveLastBetGroupIdNumeric: 319775995,
      f402LastWagerNumber: 89571514,
    });

    expect(result.tier1Count).toBe(1);
    expect(result.tier2Count).toBe(1);
    expect(result.tier3Count).toBe(1);
    expect(result.shieldedVipCount).toBe(1);
    expect(result.audit.liveObservedCandidateCount).toBe(4);
    expect(result.audit.derivedDelayArenaCapacity).toBe(128); // 64-word chunk boundary

    // Verify binary DODBIN serialization
    const bytes = serializeDelayDodbin({
      customerCount: candidates.length,
      rowCapacity: result.audit.derivedDelayArenaCapacity,
      asOfEpochDays: 20765,
      watermarks: {
        gsliveLastBetGroupIdNumeric: result.gsliveWatermarkBetGroupId,
        f402LastWagerNumber: result.f402WatermarkWagerNumber,
        streamProvenanceMask:
          STREAM_PROVENANCE_MASKS.EP09_GSLIVE_118 |
          STREAM_PROVENANCE_MASKS.EP03_BET_TICKER,
      },
      tier1Words32: result.tier1Words32,
      tier2Words32: result.tier2Words32,
      tier3Words32: result.tier3Words32,
      shieldedVipWords32: result.shieldedVipWords32,
    });

    const deserialized = deserializeDelayDodbin(bytes);
    expect(deserialized.header.magic).toBe(DODBIN_MAGIC);
    expect(deserialized.header.watermarks.gsliveLastBetGroupIdNumeric).toBe(
      319775995,
    );
    expect(deserialized.header.watermarks.f402LastWagerNumber).toBe(89571514);
  });

  test("dispatches defensive delay clamps through rate-limited Fantasy402ManagerWorker", async () => {
    const dispatchedCalls: Array<{ url: string; body: string }> = [];

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      dispatchedCalls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ Result: { Result: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const worker = new Fantasy402ManagerWorker();
    const recommender = new Rsk06DelayRecommender(worker);

    const candidates: CandidateAccountTelemetry[] = [
      {
        rowIndex: 0,
        customerLogin: "GX195",
        leafAgent: "GOLD22",
        inPlayVelocityScore: 10,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.95,
        syndicateTwinConfirmed: false,
      },
    ];

    const result = recommender.evaluateRecommendations({
      candidates,
      gsliveLastBetGroupIdNumeric: 0,
      f402LastWagerNumber: 123456,
    });

    const clampResults = await recommender.dispatchRecommendedClamps(
      result,
      candidates,
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(clampResults.length).toBe(1);
    expect(clampResults[0]!.success).toBe(true);
    expect(clampResults[0]!.delayApplied).toBe("12");
    expect(clampResults[0]!.targetUrl).toContain("cloud.fantasy402.com");
    expect(dispatchedCalls.length).toBe(1);
    expect(dispatchedCalls[0]!.body).toContain("GX195");
    expect(dispatchedCalls[0]!.body).toContain("12");
  });
});
