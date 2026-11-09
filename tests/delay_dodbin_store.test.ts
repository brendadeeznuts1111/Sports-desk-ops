import { describe, expect, test } from "bun:test";
import {
  constructCustomerPackedHandle32,
  unpackCustomerPackedHandle32,
  serializeDelayDodbin,
  deserializeDelayDodbin,
  StaleSnapshotPoisonedError,
  InvalidCustomerSpineMappingError,
  STREAM_PROVENANCE_MASKS,
} from "../lib/delay_dodbin_store.ts";
import {
  Rsk06DelayRecommender,
  deriveDelayArenaCapacity,
  verifyDelayBitsetInvariants,
} from "../lib/rsk06_delay_recommender.ts";

describe("Delay DODBIN Binary Store & Bit-31 Poison Gate", () => {
  test("constructCustomerPackedHandle32 packs and unpacks 20-bit rowIndex and flags", () => {
    const handle = constructCustomerPackedHandle32(12345, {
      delayTier: 3, // 12s
      vipShield: true,
      agentIdx: 42,
      gen: 1,
      spineMaxRows: 100000,
    });

    const unpacked = unpackCustomerPackedHandle32(handle);
    expect(unpacked.rowIndex).toBe(12345);
    expect(unpacked.delayTier).toBe(3);
    expect(unpacked.vipShield).toBe(true);
    expect(unpacked.agentIdx).toBe(42);
    expect(unpacked.gen).toBe(1);
  });

  test("constructCustomerPackedHandle32 rejects out-of-boundary rowIndex", () => {
    expect(() =>
      constructCustomerPackedHandle32(-1, { spineMaxRows: 10000 }),
    ).toThrow(InvalidCustomerSpineMappingError);

    expect(() =>
      constructCustomerPackedHandle32(10001, { spineMaxRows: 10000 }),
    ).toThrow(InvalidCustomerSpineMappingError);

    expect(
      () => constructCustomerPackedHandle32(0x100000), // 21st bit set
    ).toThrow(InvalidCustomerSpineMappingError);
  });

  test("serializes and deserializes preserving watermark stream provenance", () => {
    const wordCount = 4;
    const tier1 = new Uint32Array(wordCount);
    const tier2 = new Uint32Array(wordCount);
    const tier3 = new Uint32Array(wordCount);
    const vip = new Uint32Array(wordCount);

    tier1[0] = 0x00000001;
    tier2[0] = 0x00000002;
    tier3[0] = 0x00000004;
    vip[0] = 0x00000008;

    const streamProvenanceMask =
      STREAM_PROVENANCE_MASKS.EP09_GSLIVE_118 |
      STREAM_PROVENANCE_MASKS.EP03_BET_TICKER;

    const bytes = serializeDelayDodbin({
      customerCount: 4,
      rowCapacity: 128,
      asOfEpochDays: 20765,
      watermarks: {
        gsliveLastBetGroupIdNumeric: 319775995,
        f402LastWagerNumber: 89571514,
        streamProvenanceMask,
      },
      isPoisoned: false,
      tier1Words32: tier1,
      tier2Words32: tier2,
      tier3Words32: tier3,
      shieldedVipWords32: vip,
    });

    const deserialized = deserializeDelayDodbin(bytes);
    expect(deserialized.header.magic).toBe(0x53444f44);
    expect(deserialized.header.watermarks.gsliveLastBetGroupIdNumeric).toBe(
      319775995,
    );
    expect(deserialized.header.watermarks.f402LastWagerNumber).toBe(89571514);
    expect(deserialized.header.watermarks.streamProvenanceMask).toBe(
      streamProvenanceMask,
    );
    expect(deserialized.header.asOfEpochDays).toBe(20765);
    expect(deserialized.header.isPoisoned).toBe(false);

    expect(deserialized.tier1Words32[0]).toBe(0x00000001);
    expect(deserialized.tier2Words32[0]).toBe(0x00000002);
    expect(deserialized.tier3Words32[0]).toBe(0x00000004);
    expect(deserialized.shieldedVipWords32[0]).toBe(0x00000008);
  });

  test("Bit-31 poison gate fails closed with StaleSnapshotPoisonedError", () => {
    const wordCount = 2;
    const tier1 = new Uint32Array(wordCount);
    const tier2 = new Uint32Array(wordCount);
    const tier3 = new Uint32Array(wordCount);
    const vip = new Uint32Array(wordCount);

    const poisonedBytes = serializeDelayDodbin({
      customerCount: 1,
      rowCapacity: 64,
      asOfEpochDays: 20765,
      watermarks: {
        gsliveLastBetGroupIdNumeric: 100,
        f402LastWagerNumber: 200,
        streamProvenanceMask: STREAM_PROVENANCE_MASKS.EP09_GSLIVE_118,
      },
      isPoisoned: true, // sets STALE_SNAPSHOT_POISON_BIT (0x80000000)
      tier1Words32: tier1,
      tier2Words32: tier2,
      tier3Words32: tier3,
      shieldedVipWords32: vip,
    });

    expect(() => deserializeDelayDodbin(poisonedBytes)).toThrow(
      StaleSnapshotPoisonedError,
    );
  });
});

describe("RSK-06 Delay Recommender & Capacity Derivation", () => {
  test("deriveDelayArenaCapacity derives wordCount32 with 64-word granularity", () => {
    const audit1 = deriveDelayArenaCapacity(10);
    expect(audit1.liveObservedCandidateCount).toBe(10);
    expect(audit1.growthHeadroomCount).toBe(64);
    expect(audit1.derivedDelayArenaCapacity).toBe(128);
    expect(audit1.wordCount32).toBe(4); // 128 / 32

    const audit2 = deriveDelayArenaCapacity(500);
    expect(audit2.liveObservedCandidateCount).toBe(500);
    expect(audit2.growthHeadroomCount).toBe(125); // 500 >>> 2
    expect(audit2.derivedDelayArenaCapacity).toBe(640); // ceil(625 / 64) * 64
    expect(audit2.wordCount32).toBe(20);
  });

  test("verifyDelayBitsetInvariants passes for disjoint tiers and fails on overlap", () => {
    const audit = deriveDelayArenaCapacity(32);
    const t1 = new Uint32Array(audit.wordCount32);
    const t2 = new Uint32Array(audit.wordCount32);
    const t3 = new Uint32Array(audit.wordCount32);
    const vip = new Uint32Array(audit.wordCount32);

    t1[0] = 0x01;
    t2[0] = 0x02;
    t3[0] = 0x04;
    vip[0] = 0x08;

    expect(() =>
      verifyDelayBitsetInvariants(t1, t2, t3, vip, audit),
    ).not.toThrow();

    // Overlap T1 and T2 -> throws
    t2[0] = 0x01;
    expect(() => verifyDelayBitsetInvariants(t1, t2, t3, vip, audit)).toThrow();

    // Overlap T1 and VIP -> throws
    t2[0] = 0x02;
    vip[0] = 0x01;
    expect(() => verifyDelayBitsetInvariants(t1, t2, t3, vip, audit)).toThrow();
  });

  test("Rsk06DelayRecommender evaluates candidates and populates disjoint tiers", () => {
    const recommender = new Rsk06DelayRecommender();
    const candidates = [
      {
        rowIndex: 0,
        customerLogin: "SNIPER1",
        leafAgent: "CUB22HR",
        inPlayVelocityScore: 10,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.95, // -> T1 (12s)
        syndicateTwinConfirmed: false,
      },
      {
        rowIndex: 1,
        customerLogin: "TWIN2",
        leafAgent: "CUB22HR",
        inPlayVelocityScore: 2,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.5,
        syndicateTwinConfirmed: true, // -> T2 (11s)
      },
      {
        rowIndex: 2,
        customerLogin: "SHARP3",
        leafAgent: "CUB22HR",
        inPlayVelocityScore: 3,
        isVipShielded: false,
        currentDelaySeconds: 5,
        oddsSnipeConfidence: 0.7, // -> T3 (10s)
        syndicateTwinConfirmed: false,
      },
      {
        rowIndex: 3,
        customerLogin: "VIP4",
        leafAgent: "CUB22HR",
        inPlayVelocityScore: 15,
        isVipShielded: true, // -> VIP Shielded
        currentDelaySeconds: 7,
        oddsSnipeConfidence: 0.99,
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

    expect(result.gsliveWatermarkBetGroupId).toBe(319775995);
    expect(result.f402WatermarkWagerNumber).toBe(89571514);

    const inspected = Bun.inspect(result);
    expect(inspected).toContain("DelayEvaluationReport");
    expect(inspected).toContain("CapacityAudit (WM-2)");
    expect(inspected).toContain("GSLive_GID=319775995");
    expect(inspected).toContain("F402_Wager=89571514");

    const recommenderInspect = Bun.inspect(recommender);
    expect(recommenderInspect).toContain("Rsk06DelayRecommender");
    expect(recommenderInspect).toContain("cloud.fantasy402.com");
  });

  test("Bun.inspect.custom formatters render DODBIN snapshots and handles", () => {
    const wordCount = 4;
    const tier1 = new Uint32Array(wordCount);
    const tier2 = new Uint32Array(wordCount);
    const tier3 = new Uint32Array(wordCount);
    const vip = new Uint32Array(wordCount);
    tier1[0] = 0x01;

    const bytes = serializeDelayDodbin({
      customerCount: 1,
      rowCapacity: 128,
      asOfEpochDays: 20765,
      watermarks: {
        gsliveLastBetGroupIdNumeric: 319775995,
        f402LastWagerNumber: 89571514,
        streamProvenanceMask: STREAM_PROVENANCE_MASKS.EP09_GSLIVE_118,
      },
      tier1Words32: tier1,
      tier2Words32: tier2,
      tier3Words32: tier3,
      shieldedVipWords32: vip,
    });

    const snapshot = deserializeDelayDodbin(bytes);
    const plain = Bun.inspect(snapshot, { colors: false });
    expect(plain).toContain("DelayDodbinSnapshot");
    expect(plain).toContain("GSLive_GID=319775995 (EP09)");
    expect(plain).toContain("F402_Wager=89571514 (EP03)");
    expect(plain).toContain("T1(12s)=1");

    const colored = Bun.inspect(snapshot, { colors: true });
    expect(colored).toContain("\x1b[1mDelayDodbinSnapshot\x1b[22m");
  });
});
