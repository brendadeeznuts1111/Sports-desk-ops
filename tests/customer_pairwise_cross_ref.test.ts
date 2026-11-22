import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { R2PreconditionFailedError } from "../lib/r2_s3_client.ts";
import {
  R2_BUCKET,
  SYNDICATE_RINGS_MANIFEST_KEY,
  WAGERS_BY_STATE_MANIFEST_KEY,
  assertPairwiseCrossRefLivePreflight,
  executePairwiseCrossRefFromR2,
  resolveR2Endpoint,
  type PairwiseR2Reader,
} from "../packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts";
import {
  BRIDGE_R2_SINK_SPECS,
  CANONICAL_R2_SINK_SPECS,
  STAGE_4_LEDGER_PUBLISH_SNAPSHOT,
  evaluateCanonicalR2ManifestStaleness,
  normalizeStrongETag,
  promoteCanonicalManifestWithCas,
  publishEdgeTopologyManifestToR2,
  publishOpsSupervisorManifestToR2,
  syncCanonicalGovernanceManifestsToR2,
  verifyCanonicalR2Manifests,
  writeContentAddressedChunkWithRetry,
  type CasR2ClientLike,
} from "../packages/sportsdesk-ops/src/lib/r2_manifest_cas.ts";
import { publishWagersByStateSnapshotToR2 } from "../scripts/publish_wagers_snapshot.ts";
import {
  LEG_FLAG_IS_ALT_SPREAD_PLUS_5000,
  LEG_FLAG_IS_LIVE_INPLAY,
  LIVE_WAGER_TYPE_CODE3,
  OVERLAP_DIFFERENT_MARKET,
  OVERLAP_OPPOSITE_SIDE,
  OVERLAP_SAME_SIDE,
  PAIRWISE_OVERLAP_SOA_ROW_BYTES,
  PAIRWISE_SOA_CHUNK_MAGIC,
  PAIRWISE_SOA_CHUNK_VERSION,
  PAIRWISE_SOA_HEADER_BYTES,
  PAIRWISE_WAGER_SOA_ROW_BYTES,
  PairwiseOverlapColumnStore,
  PairwiseWagerColumnStore,
  REGIME_LIVE_IN_PLAY,
  REGIME_PREGAME,
  SOURCE_BRIDGE_IDS,
  asLineHundredths,
  encodePairwiseSoAChunk,
  evaluateColumnarPairwiseCrossRef,
  hashCustomerLogin64Stride2,
  hydratePairwiseColumnStoreFromSoAChunk,
  normalizeCanonicalRotation20,
  packSubSportComboKey15,
  parseAsBasisPoints,
  parseAsCents,
  parseDualSurfaceBetGroupToken,
  parseFixedPointDecimalToBigInt,
  readEpochMs64Stride2,
  unpackSubSportComboKey15,
  writeEpochMs64Stride2,
} from "../src/lib/customer_pairwise_cross_ref.ts";

const ROOT = resolve(import.meta.dir, "..");
const RETIRED_ENV_KEYS = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

function makeLiveEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const key of RETIRED_ENV_KEYS) delete env[key];
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_R2_API_TOKEN;
  env.R2_ACCESS_KEY_ID = "test-r2-access";
  env.R2_SECRET_ACCESS_KEY = "test-r2-secret";
  env.R2_ENDPOINT = "https://r2.sportsdesk.test";
  return env;
}

function createInMemoryCasR2Client(
  initialObjects?: ReadonlyMap<string, Uint8Array>,
): {
  readonly client: CasR2ClientLike & PairwiseR2Reader;
  readonly objects: Map<string, Uint8Array>;
  readonly etags: Map<string, string>;
  readonly conditionalPuts: Array<{
    readonly key: string;
    readonly ifMatch?: string;
    readonly ifNoneMatch?: string;
  }>;
  readonly simulateConcurrentRaceOnKey: (key: string) => void;
} {
  const objects = new Map<string, Uint8Array>(initialObjects);
  const etags = new Map<string, string>();
  const raceKeys = new Set<string>();
  const conditionalPuts: Array<{
    readonly key: string;
    readonly ifMatch?: string;
    readonly ifNoneMatch?: string;
  }> = [];

  const computeEtag = (bytes: Uint8Array): string => {
    const h = new Bun.CryptoHasher("sha256");
    h.update(bytes);
    return `"${h.digest("hex").slice(0, 16)}"`;
  };

  for (const [k, v] of objects) {
    etags.set(k, computeEtag(v));
  }

  const client: CasR2ClientLike & PairwiseR2Reader = {
    async headEtag(key: string) {
      return etags.get(key) ?? null;
    },
    async write(key: string, data: Uint8Array | string) {
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      objects.set(key, bytes);
      etags.set(key, computeEtag(bytes));
      return bytes.byteLength;
    },
    async writeWithMetadata(key: string, data: Uint8Array | string, opts = {}) {
      conditionalPuts.push({
        key,
        ...(opts.ifMatch === undefined ? {} : { ifMatch: opts.ifMatch }),
        ...(opts.ifNoneMatch === undefined
          ? {}
          : { ifNoneMatch: opts.ifNoneMatch }),
      });
      if (raceKeys.delete(key)) {
        const winnerBytes = new TextEncoder().encode('{"race":"winner"}');
        objects.set(key, winnerBytes);
        etags.set(key, computeEtag(winnerBytes));
        throw new R2PreconditionFailedError(key);
      }
      const existingEtag = etags.get(key);
      if (opts.ifNoneMatch === "*" && existingEtag !== undefined) {
        throw new R2PreconditionFailedError(key);
      }
      if (opts.ifMatch !== undefined && opts.ifMatch !== existingEtag) {
        throw new R2PreconditionFailedError(key);
      }
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      objects.set(key, bytes);
      etags.set(key, computeEtag(bytes));
      return bytes.byteLength;
    },
    file(key: string) {
      return {
        async text() {
          const buf = objects.get(key);
          if (!buf) throw new Error(`NoSuchKey: ${key}`);
          return new TextDecoder().decode(buf);
        },
        async bytes() {
          const buf = objects.get(key);
          if (!buf) throw new Error(`NoSuchKey: ${key}`);
          return buf;
        },
      };
    },
    async stat(key: string) {
      const buf = objects.get(key);
      if (!buf) throw new Error(`NoSuchKey: ${key}`);
      return { etag: etags.get(key), size: buf.byteLength };
    },
  };

  return {
    client,
    objects,
    etags,
    conditionalPuts,
    simulateConcurrentRaceOnKey(key: string) {
      raceKeys.add(key);
    },
  };
}

function createInMemoryR2Reader(
  objects: ReadonlyMap<string, Uint8Array>,
): PairwiseR2Reader {
  return {
    file(key: string) {
      return {
        async text() {
          const buf = objects.get(key);
          if (!buf) throw new Error(`NoSuchKey: ${key}`);
          return new TextDecoder().decode(buf);
        },
        async bytes() {
          const buf = objects.get(key);
          if (!buf) throw new Error(`NoSuchKey: ${key}`);
          return buf;
        },
      };
    },
  };
}

describe("src/lib/customer_pairwise_cross_ref primitives & contiguous SoA layout", () => {
  test("parseFixedPointDecimalToBigInt handles Unicode half-point, commas, signs, and padding", () => {
    expect(parseFixedPointDecimalToBigInt("-3.5", 2)).toBe(-350n);
    expect(parseFixedPointDecimalToBigInt("+7½", 2)).toBe(750n);
    expect(parseFixedPointDecimalToBigInt("-½", 2)).toBe(-50n);
    expect(parseFixedPointDecimalToBigInt("1,250.5", 2)).toBe(125050n);
    expect(parseFixedPointDecimalToBigInt(100, 2)).toBe(10000n);
    expect(parseFixedPointDecimalToBigInt("", 2)).toBe(0n);
  });

  test("normalizeCanonicalRotation20 collapses [5000..5999] and [9000..9999] and bounds 20-bit range", () => {
    expect(normalizeCanonicalRotation20(451)).toEqual({
      canonicalRot20: 451,
      flagMask32: 0,
    });
    expect(normalizeCanonicalRotation20(5451)).toEqual({
      canonicalRot20: 451,
      flagMask32: LEG_FLAG_IS_ALT_SPREAD_PLUS_5000,
    });
    expect(normalizeCanonicalRotation20(9451)).toEqual({
      canonicalRot20: 451,
      flagMask32: LEG_FLAG_IS_LIVE_INPLAY,
    });
    expect(() => normalizeCanonicalRotation20(-1)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => normalizeCanonicalRotation20(0x100000)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
  });

  test("parseDualSurfaceBetGroupToken and hashCustomerLogin64Stride2 normalize surfaces identically", () => {
    expect(parseDualSurfaceBetGroupToken("M.G80012345")).toBe(80012345n);
    expect(parseDualSurfaceBetGroupToken("G80012345")).toBe(80012345n);
    expect(parseDualSurfaceBetGroupToken("80012345")).toBe(80012345n);

    const words = new Uint32Array(4);
    hashCustomerLogin64Stride2("player_TTN97", words, 0);
    hashCustomerLogin64Stride2("  ttn97  ", words, 2);
    expect(words[0]).toBe(words[2]);
    expect(words[1]).toBe(words[3]);
  });

  test("PairwiseWagerColumnStore & PairwiseOverlapColumnStore allocate contiguous ArrayBuffer slabs with stride-2 Uint32 timestamp words", () => {
    const store = new PairwiseWagerColumnStore(5);
    expect(store.alignedCapacity).toBe(8);
    expect(store.buffer.byteLength).toBe(8 * PAIRWISE_WAGER_SOA_ROW_BYTES);
    expect(store.placedAtEpochMs32WordsCol).toBeInstanceOf(Uint32Array);
    expect(store.placedAtEpochMs32WordsCol.length).toBe(16);

    for (const col of [
      store.stakeCentsI64Col,
      store.loginKey32WordsCol,
      store.betGroupOrWagerId32WordsCol,
      store.placedAtEpochMs32WordsCol,
      store.canonicalRot20Col,
      store.lineHundredthsI32Col,
      store.oddsAmericanI32Col,
      store.flagsBitSet32Col,
      store.packedComboKey15Col,
      store.concurrentEventAccountCountU16Col,
      store.sourceBridgeU8Col,
      store.sideCodeU8Col,
    ]) {
      expect(col.buffer).toBe(store.buffer);
    }

    const words = new Uint32Array(4);
    writeEpochMs64Stride2(1_763_262_000_450, words, 0);
    writeEpochMs64Stride2(1_763_262_000_450n, words, 2);
    expect(readEpochMs64Stride2(words, 0)).toBe(1_763_262_000_450);
    expect(readEpochMs64Stride2(words, 2)).toBe(1_763_262_000_450);

    const overlaps = new PairwiseOverlapColumnStore(5);
    expect(overlaps.alignedCapacity).toBe(8);
    expect(overlaps.buffer.byteLength).toBe(8 * PAIRWISE_OVERLAP_SOA_ROW_BYTES);
    expect(overlaps.lagMsU32Col).toBeInstanceOf(Uint32Array);
    for (const col of [
      overlaps.canonicalRot20Col,
      overlaps.rowIndexACol,
      overlaps.rowIndexBCol,
      overlaps.lagMsU32Col,
      overlaps.packedComboKey15Col,
      overlaps.overlapKindU8Col,
      overlaps.regimeMask2U8Col,
      overlaps.initiatorCodeU8Col,
      overlaps.flagsU8Col,
    ]) {
      expect(col.buffer).toBe(overlaps.buffer);
    }
  });

  test("contiguous SoA binary chunk round-trip preserves stride-2 ms epoch words, stakeCentsI64, and bridge guards", () => {
    const src = new PairwiseWagerColumnStore(8);
    const key = packSubSportComboKey15(3, LIVE_WAGER_TYPE_CODE3, 0, 0);
    const tsMs = 1_763_262_000_450;

    expect(
      src.appendLeg(
        "BILLY666",
        101n,
        9451,
        key,
        asLineHundredths(-350),
        -115,
        125_075n,
        tsMs,
        SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
        1,
        0,
        9,
      ),
    ).toBe(0);

    // STAGE1_DROP is ignored
    expect(
      src.appendLeg(
        "ALERT_ROW",
        102n,
        451,
        key,
        asLineHundredths(-350),
        -110,
        parseAsCents(5000),
        tsMs,
        SOURCE_BRIDGE_IDS.INGEST_STAGE1_DROP,
        0,
      ),
    ).toBe(-1);

    const chunk = encodePairwiseSoAChunk(src);
    const view = new DataView(
      chunk.buffer,
      chunk.byteOffset,
      PAIRWISE_SOA_HEADER_BYTES,
    );
    expect(view.getUint32(0, true)).toBe(PAIRWISE_SOA_CHUNK_MAGIC);
    expect(view.getUint32(4, true)).toBe(PAIRWISE_SOA_CHUNK_VERSION);
    expect(view.getUint32(8, true)).toBe(1);
    expect(view.getUint32(12, true)).toBe(4);
    expect(chunk.byteLength).toBe(
      PAIRWISE_SOA_HEADER_BYTES + 4 * PAIRWISE_WAGER_SOA_ROW_BYTES,
    );

    const dst = new PairwiseWagerColumnStore(8);
    const hydrated = hydratePairwiseColumnStoreFromSoAChunk(
      chunk,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      dst,
    );
    expect(hydrated).toBe(1);
    expect(dst.canonicalRot20Col[0]).toBe(451);
    expect(dst.packedComboKey15Col[0]).toBe(key);
    expect(unpackSubSportComboKey15(dst.packedComboKey15Col[0]!)).toEqual({
      subSportCode6: 3,
      wagerTypeCode3: LIVE_WAGER_TYPE_CODE3,
      periodCode4: 0,
      marketKindCode2: 0,
    });
    expect(dst.lineHundredthsI32Col[0]).toBe(-350);
    expect(dst.oddsAmericanI32Col[0]).toBe(-115);
    expect(dst.stakeCentsI64Col[0]).toBe(125_075n);
    expect(dst.readPlacedAtEpochMs(0)).toBe(tsMs);
    expect(dst.concurrentEventAccountCountU16Col[0]).toBe(9);
    expect(dst.flagsBitSet32Col[0]).toBe(LEG_FLAG_IS_LIVE_INPLAY);

    // Bridge contamination guard on mismatched expectedBridgeId2
    const mismatchDst = new PairwiseWagerColumnStore(8);
    expect(() =>
      hydratePairwiseColumnStoreFromSoAChunk(
        chunk,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        mismatchDst,
      ),
    ).toThrow(/ERR_BRIDGE_CHANNEL_CONTAMINATION/);
  });
});

describe("evaluateColumnarPairwiseCrossRef follower deduplication & dual-regime", () => {
  test("deduplicates leader re-bets so each follower ticket binds once to closest preceding leader wager (10000ms)", () => {
    const store = new PairwiseWagerColumnStore(8);
    const key17410 = 17410 as ReturnType<typeof packSubSportComboKey15>;
    const t0 = 1_763_262_000_000;

    // rowIndexA: 0 and rowIndexA: 1 on same (canonicalRot20=889598, packedComboKey15=17410)
    expect(
      store.appendLeg(
        "C001",
        1n,
        889598,
        key17410,
        asLineHundredths(-350),
        -110,
        10_000n,
        t0 + 10_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        1,
      ),
    ).toBe(0);
    expect(
      store.appendLeg(
        "C001",
        2n,
        889598,
        key17410,
        asLineHundredths(-350),
        -110,
        15_000n,
        t0 + 20_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        1,
      ),
    ).toBe(1);
    // rowIndexB: 2 follows at +10,000ms after rowIndexA: 1 (and +20,000ms after rowIndexA: 0)
    expect(
      store.appendLeg(
        "C002",
        3n,
        889598,
        key17410,
        asLineHundredths(-350),
        -110,
        10_000n,
        t0 + 30_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        1,
      ),
    ).toBe(2);
    // Separate C002-only event (catalogEvents=2)
    expect(
      store.appendLeg(
        "C002",
        4n,
        889599,
        key17410,
        asLineHundredths(-150),
        -110,
        10_000n,
        t0 + 40_000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        0,
      ),
    ).toBe(3);

    const res = evaluateColumnarPairwiseCrossRef(store, "C001", "C002");
    expect(res.totalWagersA).toBe(2);
    expect(res.totalWagersB).toBe(2);
    expect(res.catalogDistinctEvents).toBe(2);
    expect(res.sharedEventsCount).toBe(1);
    expect(res.sameSideCount).toBe(1);
    expect(res.pregameFollowsAtoB).toBe(1);
    expect(res.pregameFollowsBtoA).toBe(0);
    expect(res.minSameSideLagMsU32).toBe(10_000);
    expect(res.avgSameSideLagMsU32).toBe(10_000);
    expect(res.overlapStore.length).toBe(1);
    expect(res.overlapStore.lagMsU32Col[0]).toBe(10_000);
    expect(res.overlaps).toEqual([
      {
        canonicalRot20: 889598,
        packedComboKey15: key17410,
        rowIndexA: 1,
        rowIndexB: 2,
        lagMsU32: 10_000,
        overlapKind: OVERLAP_SAME_SIDE,
        regimeMask2: REGIME_PREGAME,
        initiatorCode: "CUSTOMER_A",
        lineSigMatch: true,
        broadcastSurgeSuppressed: false,
      },
    ]);
  });

  test("deduplicates B-to-A follower binds and avoids false reverse follow when A led first", () => {
    const store = new PairwiseWagerColumnStore(8);
    const key = packSubSportComboKey15(1, 0, 0, 0);
    const t0 = 1_763_262_050_000;

    // Rot 501: B leads twice (t+1000, t+2500), A follows once (t+4000) -> 1 B->A at 1500ms
    store.appendLeg(
      "CUST_B",
      1n,
      501,
      key,
      asLineHundredths(-250),
      -110,
      10_000n,
      t0 + 1_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "CUST_B",
      2n,
      501,
      key,
      asLineHundredths(-250),
      -110,
      10_000n,
      t0 + 2_500,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "CUST_A",
      3n,
      501,
      key,
      asLineHundredths(-250),
      -110,
      10_000n,
      t0 + 4_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );

    // Rot 502: A leads (t+10000), B follows (t+12000), then A tops up (t+13500).
    // A0 preceded B0, so A1 must NOT count as B->A follow!
    store.appendLeg(
      "CUST_A",
      4n,
      502,
      key,
      asLineHundredths(-400),
      -110,
      10_000n,
      t0 + 10_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );
    store.appendLeg(
      "CUST_B",
      5n,
      502,
      key,
      asLineHundredths(-400),
      -110,
      10_000n,
      t0 + 12_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );
    store.appendLeg(
      "CUST_A",
      6n,
      502,
      key,
      asLineHundredths(-400),
      -110,
      10_000n,
      t0 + 13_500,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );

    const res = evaluateColumnarPairwiseCrossRef(store, "CUST_A", "CUST_B");
    expect(res.sameSideCount).toBe(2);
    expect(res.pregameApiBotFollowsBtoA).toBe(1);
    expect(res.pregameApiBotFollowsAtoB).toBe(1);
    expect(res.minSameSideLagMsU32).toBe(1_500);
    expect(res.avgSameSideLagMsU32).toBe(1_750);
    expect(res.overlapStore.length).toBe(2);
  });

  test("detects LIVE_IN_PLAY <= 1,500ms follows across half-point tick moves and suppresses broadcast surges (> 8 accounts)", () => {
    const store = new PairwiseWagerColumnStore(32);
    const liveKey = packSubSportComboKey15(3, LIVE_WAGER_TYPE_CODE3, 0, 0);
    const baseMs = 1_763_262_000_000;

    for (let i = 0; i < 3; i++) {
      const rot = 9100 + i;
      const t = baseMs + i * 10_000;
      store.appendLeg(
        "CUST_A",
        BigInt(1000 + i),
        rot,
        liveKey,
        asLineHundredths(-350),
        -110,
        50_000n,
        t,
        SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
        1,
        0,
        2,
      );
      store.appendLeg(
        "CUST_B",
        BigInt(2000 + i),
        rot,
        liveKey,
        asLineHundredths(-450),
        -110,
        50_000n,
        t + 850,
        SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
        1,
        0,
        2,
      );
    }

    // Broadcast-surge event with 11 distinct accounts within 3,000ms -> suppressed
    store.appendLeg(
      "CUST_A",
      1099n,
      9500,
      liveKey,
      asLineHundredths(-250),
      -110,
      50_000n,
      baseMs + 50_000,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      1,
      0,
      11,
    );
    store.appendLeg(
      "CUST_B",
      2099n,
      9500,
      liveKey,
      asLineHundredths(-250),
      -110,
      50_000n,
      baseMs + 50_600,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      1,
      0,
      11,
    );

    const res = evaluateColumnarPairwiseCrossRef(store, "CUST_A", "CUST_B");
    expect(res.sameSideCount).toBe(4);
    expect(res.suppressedBroadcastSurgeCount).toBe(1);
    expect(res.liveBotFollowsAtoB).toBe(3);
    expect(res.liveBotFollowsBtoA).toBe(0);
    expect(res.customerALeadShareBps).toBe(parseAsBasisPoints(10_000, true));
    expect(res.inferredRoleB).toBe("COPY_FOLLOWER");
    expect(res.overlaps[0]?.regimeMask2).toBe(REGIME_LIVE_IN_PLAY);
    expect(res.overlaps[0]?.lineSigMatch).toBe(true);
    expect(res.overlaps[0]?.lagMsU32).toBe(850);
    expect(res.overlaps[3]?.broadcastSurgeSuppressed).toBe(true);
  });

  test("enforces PREGAME line-sensitivity, separates OPPOSITE_SIDE / DIFFERENT_MARKET, and computes true catalog bAbsentParticipationBps", () => {
    const store = new PairwiseWagerColumnStore(32);
    const pregameSpreadKey = packSubSportComboKey15(1, 0, 0, 0);
    const pregameTotalKey = packSubSportComboKey15(1, 0, 0, 1);
    const baseMs = 1_763_262_100_000;

    store.appendLeg(
      "ALPHA",
      1n,
      101,
      pregameSpreadKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "BETA",
      2n,
      101,
      pregameSpreadKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs + 2_400,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );

    store.appendLeg(
      "ALPHA",
      3n,
      102,
      pregameSpreadKey,
      asLineHundredths(-700),
      -110,
      10_000n,
      baseMs + 20_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "BETA",
      4n,
      102,
      pregameSpreadKey,
      asLineHundredths(700),
      -110,
      10_000n,
      baseMs + 30_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );

    store.appendLeg(
      "ALPHA",
      5n,
      103,
      pregameSpreadKey,
      asLineHundredths(-250),
      -110,
      10_000n,
      baseMs + 40_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "BETA",
      6n,
      103,
      pregameTotalKey,
      asLineHundredths(4450),
      -110,
      10_000n,
      baseMs + 45_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      0,
    );

    store.appendLeg(
      "BETA",
      7n,
      104,
      pregameSpreadKey,
      asLineHundredths(-150),
      -110,
      10_000n,
      baseMs + 50_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    for (let r = 105; r <= 110; r++) {
      store.appendLeg(
        `OTHER_${r}`,
        BigInt(r),
        r,
        pregameSpreadKey,
        asLineHundredths(-110),
        -110,
        10_000n,
        baseMs + r * 1000,
        SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
        0,
      );
    }

    const res = evaluateColumnarPairwiseCrossRef(store, "ALPHA", "BETA");
    expect(res.catalogDistinctEvents).toBe(10);
    expect(res.distinctEventsA).toBe(3);
    expect(res.distinctEventsB).toBe(4);
    expect(res.sharedEventsCount).toBe(3);
    expect(res.sameSideCount).toBe(1);
    expect(res.oppositeSideCount).toBe(1);
    expect(res.differentMarketCount).toBe(1);
    expect(res.pregameApiBotFollowsAtoB).toBe(1);
    expect(res.pregameFollowsAtoB).toBe(1);
    expect(res.customerALeadShareBps).toBe(parseAsBasisPoints(10_000, true));
    expect(res.bPresentParticipationBps).toBe(parseAsBasisPoints(10_000, true));
    expect(res.bAbsentParticipationBps).toBe(parseAsBasisPoints(1_429, true));
    expect(res.liftRatioBps).toBe(parseAsBasisPoints(8_571, true));
    expect(res.overlaps.map((o) => o.overlapKind)).toEqual([
      OVERLAP_SAME_SIDE,
      OVERLAP_OPPOSITE_SIDE,
      OVERLAP_DIFFERENT_MARKET,
    ]);
    expect(res.overlaps[0]?.regimeMask2).toBe(REGIME_PREGAME);
  });

  test("supports multi-bridge stores and bridgeFilter isolation", () => {
    const store = new PairwiseWagerColumnStore(8);
    const pregameKey = packSubSportComboKey15(1, 0, 0, 0);
    const liveKey = packSubSportComboKey15(1, LIVE_WAGER_TYPE_CODE3, 0, 0);
    const baseMs = 1_763_262_200_000;

    store.appendLeg(
      "A1",
      1n,
      201,
      pregameKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "B1",
      2n,
      201,
      pregameKey,
      asLineHundredths(-300),
      -110,
      10_000n,
      baseMs + 2_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "A1",
      3n,
      9202,
      liveKey,
      asLineHundredths(-150),
      -110,
      10_000n,
      baseMs + 5_000,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      0,
    );
    store.appendLeg(
      "B1",
      4n,
      9202,
      liveKey,
      asLineHundredths(-250),
      -110,
      10_000n,
      baseMs + 5_500,
      SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
      0,
    );

    const all = evaluateColumnarPairwiseCrossRef(store, "A1", "B1", {
      bridgeFilter: "ALL",
    });
    expect(all.sharedEventsCount).toBe(2);
    expect(all.sameSideCount).toBe(2);

    const onlyF402 = evaluateColumnarPairwiseCrossRef(store, "A1", "B1", {
      bridgeFilter: SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
    });
    expect(onlyF402.sharedEventsCount).toBe(1);
    expect(onlyF402.pregameApiBotFollowsAtoB).toBe(1);

    const onlyGsLive = evaluateColumnarPairwiseCrossRef(store, "A1", "B1", {
      bridgeFilter: SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C,
    });
    expect(onlyGsLive.sharedEventsCount).toBe(1);
    expect(onlyGsLive.liveBotFollowsAtoB).toBe(1);
  });
});

describe("sportsdesk-fraud cross-ref governance & R2 lineage envelope", () => {
  test("assertPairwiseCrossRefLivePreflight enforces ERR_OPS_LOCAL_JSON_FORBIDDEN, retired keys, token bleed, and R2 creds", () => {
    const okEnv = makeLiveEnv();

    for (const badArgv of [
      ["C001", "C002", "--input", "live.json"],
      ["C001", "C002", "--input=foo.bin"],
      ["C001", "C002", "--file", "/tmp/wagers.json"],
      ["C001", "C002", "tests/fixtures/fraud/live-wagers.json"],
      ["C001", "C002", "scratch/wagers.sqlite"],
      ["C001", "C002", "scratch/spine.dodbin"],
    ]) {
      expect(() => assertPairwiseCrossRefLivePreflight(badArgv, okEnv)).toThrow(
        /ERR_OPS_LOCAL_JSON_FORBIDDEN/,
      );
    }

    for (const retiredKey of RETIRED_ENV_KEYS) {
      expect(() =>
        assertPairwiseCrossRefLivePreflight(["C001", "C002"], {
          ...okEnv,
          [retiredKey]: "1",
        }),
      ).toThrow(`ERR_DOD_LEGACY_FALLBACK_REMOVED: ${retiredKey}`);
    }

    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], {
        ...okEnv,
        CLOUDFLARE_R2_API_TOKEN: "r2",
        CLOUDFLARE_API_TOKEN: "cf",
      }),
    ).toThrow(/ERR_CF_TOKEN_BLEED_10000/);

    const missingR2 = makeLiveEnv();
    delete missingR2.R2_ACCESS_KEY_ID;
    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], missingR2),
    ).toThrow(/ERR_CF_R2_CREDENTIALS_MISSING/);

    const accountDerived = makeLiveEnv();
    delete accountDerived.R2_ENDPOINT;
    accountDerived.CLOUDFLARE_ACCOUNT_ID = "7a470541a704caaf91e71efccc78fd36";
    expect(resolveR2Endpoint(accountDerived)).toBe(
      "https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com",
    );
    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], accountDerived),
    ).not.toThrow();

    expect(() =>
      assertPairwiseCrossRefLivePreflight(["C001", "C002"], okEnv),
    ).not.toThrow();
  });

  test("executePairwiseCrossRefFromR2 hydrates in-memory R2 manifests + SoA chunk and stamps full 9-field R2 lineage envelope", async () => {
    const store = new PairwiseWagerColumnStore(8);
    const key = packSubSportComboKey15(1, 0, 0, 0);
    const baseMs = 1_763_262_300_000;

    store.appendLeg(
      "C001",
      1n,
      889598,
      key,
      asLineHundredths(-350),
      -110,
      20_000n,
      baseMs + 10_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "C001",
      2n,
      889598,
      key,
      asLineHundredths(-350),
      -110,
      30_000n,
      baseMs + 20_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );
    store.appendLeg(
      "C002",
      3n,
      889598,
      key,
      asLineHundredths(-350),
      -110,
      25_000n,
      baseMs + 30_000,
      SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB,
      1,
    );

    const chunkBytes = encodePairwiseSoAChunk(store);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(chunkBytes);
    const chunkSha256 = hasher.digest("hex");
    const chunkKey = `chunks/wagers-by-state/${chunkSha256}.bin`;

    const r2Objects = new Map<string, Uint8Array>([
      [
        WAGERS_BY_STATE_MANIFEST_KEY,
        new TextEncoder().encode(
          JSON.stringify({
            domain: "[Ops & Governance]",
            sink_id: "wagers-by-state",
            r2_bucket: R2_BUCKET,
            generation_u32: 19,
            merkle_root_sha256: chunkSha256,
            watermark_cursor: "wm-19:3",
            data_window_max_epoch_ms: baseMs + 30_000,
            r2_published_at_epoch_ms: baseMs + 31_000,
            chunk_key: chunkKey,
            circuit_state: "CLOSED",
          }),
        ),
      ],
      [
        SYNDICATE_RINGS_MANIFEST_KEY,
        new TextEncoder().encode(
          JSON.stringify({
            domain: "[DOD Spine]",
            r2_bucket: R2_BUCKET,
            manifest_key: SYNDICATE_RINGS_MANIFEST_KEY,
            generation_u32: 7,
            spine_generation_u32: 19,
            merkle_root_sha256: "f".repeat(64),
            r2_published_at_epoch_ms: baseMs + 31_500,
            active_edge_count_u32: 4,
            ring_count_u32: 1,
            rings: [],
          }),
        ),
      ],
      [chunkKey, chunkBytes],
    ]);

    const payload = await executePairwiseCrossRefFromR2({
      r2: createInMemoryR2Reader(r2Objects),
      customerA: "C001",
      customerB: "C002",
    });

    // All 9 mandatory R2 Lineage Envelope fields
    expect(payload.domain).toBe("[Ops & Governance]");
    expect(payload.sink_id).toBe("wagers-by-state");
    expect(payload.r2_bucket).toBe(R2_BUCKET);
    expect(payload.generation_u32).toBe(19);
    expect(payload.merkle_root_sha256).toBe(chunkSha256);
    expect(payload.watermark_cursor).toBe("wm-19:3");
    expect(payload.data_window_max_epoch_ms).toBe(baseMs + 30_000);
    expect(payload.r2_published_at_epoch_ms).toBe(baseMs + 31_000);
    expect(payload.circuit_state).toBe("CLOSED");
    expect(payload.unresolved_gap_cents).toBe("0");

    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe("cross-ref");
    expect(payload.success).toBe(true);
    expect(typeof payload.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.generatedAt))).toBe(false);
    expect(payload.manifests.wagersByState.key).toBe(
      WAGERS_BY_STATE_MANIFEST_KEY,
    );
    expect(payload.manifests.syndicateRings.key).toBe(
      SYNDICATE_RINGS_MANIFEST_KEY,
    );
    expect(payload.manifests.syndicateRings.ring_count_u32).toBe(1);

    expect(payload.analysis.sameSideCount).toBe(1);
    expect(payload.analysis.pregameFollowsAtoB).toBe(1);
    expect(payload.analysis.minSameSideLagMsU32).toBe(10_000);
    expect(payload.analysis.overlaps[0]?.lagMsU32).toBe(10_000);
    expect("overlapStore" in payload.analysis).toBe(false);
    expect("sources" in payload).toBe(false);

    // Non-zero unresolved_gap_cents trips ERR_OPS_RECONCILIATION_GAP (exit 65, zero retries)
    const gappedObjects = new Map(r2Objects);
    gappedObjects.set(
      WAGERS_BY_STATE_MANIFEST_KEY,
      new TextEncoder().encode(
        JSON.stringify({
          domain: "[Ops & Governance]",
          sink_id: "wagers-by-state",
          r2_bucket: R2_BUCKET,
          generation_u32: 19,
          merkle_root_sha256: chunkSha256,
          watermark_cursor: "wm-19:3",
          data_window_max_epoch_ms: baseMs + 30_000,
          r2_published_at_epoch_ms: baseMs + 31_000,
          chunk_key: chunkKey,
          circuit_state: "CLOSED",
          unresolved_gap_cents: "250",
        }),
      ),
    );
    let capturedErr: unknown = null;
    try {
      await executePairwiseCrossRefFromR2({
        r2: createInMemoryR2Reader(gappedObjects),
        customerA: "C001",
        customerB: "C002",
      });
    } catch (err) {
      capturedErr = err;
    }
    expect(capturedErr).toBeInstanceOf(Error);
    expect((capturedErr as { message: string }).message).toContain(
      "ERR_OPS_RECONCILIATION_GAP",
    );
    expect((capturedErr as { exitCode?: number }).exitCode).toBe(65);
  });

  test("executePairwiseCrossRefFromR2 fails closed without .json fallback and rejects poisoned syndicate-rings", async () => {
    const emptyR2 = createInMemoryR2Reader(
      new Map<string, Uint8Array>([
        ["live-wagers/latest.json", new TextEncoder().encode('{"LIST":[]}')],
        [
          "wagers-by-state/latest.json",
          new TextEncoder().encode('{"schemaVersion":2}'),
        ],
      ]),
    );
    let missingErr: unknown = null;
    try {
      await executePairwiseCrossRefFromR2({
        r2: emptyR2,
        customerA: "TACO323",
        customerB: "TACO166",
      });
    } catch (err) {
      missingErr = err;
    }
    expect(missingErr).toBeInstanceOf(Error);
    expect((missingErr as Error).message).toContain("ERR_R2_SINK_BACKPRESSURE");
    expect((missingErr as { exitCode?: number }).exitCode).toBe(65);

    const poisonedR2 = createInMemoryR2Reader(
      new Map<string, Uint8Array>([
        [
          WAGERS_BY_STATE_MANIFEST_KEY,
          new TextEncoder().encode(
            JSON.stringify({
              domain: "[Ops & Governance]",
              sink_id: "wagers-by-state",
              r2_bucket: R2_BUCKET,
              generation_u32: 1,
              merkle_root_sha256: "a".repeat(64),
              watermark_cursor: "wm-1:1",
              data_window_max_epoch_ms: 1_763_262_300_000,
              r2_published_at_epoch_ms: 1_763_262_301_000,
              chunk_key: "chunks/missing.bin",
              circuit_state: "CLOSED",
              unresolved_gap_cents: "0",
            }),
          ),
        ],
        [
          SYNDICATE_RINGS_MANIFEST_KEY,
          new TextEncoder().encode(
            JSON.stringify({
              domain: "[DOD Spine]",
              r2_bucket: R2_BUCKET,
              manifest_key: SYNDICATE_RINGS_MANIFEST_KEY,
              generation_u32: 1,
              spine_generation_u32: 1,
              merkle_root_sha256: "b".repeat(64),
              data_window_max_epoch_ms: 1_763_262_300_000,
              r2_published_at_epoch_ms: 1_763_262_301_000,
              poison_bit: 1,
              circuit_state: "OPEN",
              unresolved_gap_cents: "0",
              active_edge_count_u32: 0,
              ring_count_u32: 0,
              rings: [],
            }),
          ),
        ],
      ]),
    );
    let poisonErr: unknown = null;
    try {
      await executePairwiseCrossRefFromR2({
        r2: poisonedR2,
        customerA: "TACO323",
        customerB: "TACO166",
      });
    } catch (err) {
      poisonErr = err;
    }
    expect(poisonErr).toBeInstanceOf(Error);
    expect((poisonErr as Error).message).toContain("poison_bit=1");
    expect((poisonErr as { exitCode?: number }).exitCode).toBe(65);
  });

  test("a failed GS Live capture preserves summary bytes while the ticker advances; a recovered empty book updates both", async () => {
    const dir = mkdtempSync(join(tmpdir(), "combined-publisher-"));
    try {
      const summaryPath = join(dir, "summary.json");
      const key = "wagers-by-state/latest.json";
      const previous = new TextEncoder().encode('{"previous":true}');
      const r2 = createInMemoryCasR2Client(new Map([[key, previous]]));
      const metadata = new Map<string, Readonly<Record<string, string>>>();
      const write = r2.client.writeWithMetadata.bind(r2.client);
      const client = {
        ...r2.client,
        writeWithMetadata: ((key, bytes, opts) => {
          if (opts?.metadata) metadata.set(key, opts.metadata);
          return write(key, bytes, opts);
        }) satisfies typeof write,
      };
      const nowMs = Date.parse("2026-11-22T08:45:00.000Z");
      const capturedAt = new Date(nowMs).toISOString();
      const ticker = {
        observedAt: capturedAt,
        LIST: [
          {
            CustomerID: "TEST",
            WagerNumber: 1,
            ShortDesc: "S:Football #547 Test",
            InsertDateTime: "2026-11-22 02:40:00.000",
            TicketWriter: "Internet",
            AmountWagered: 10,
          },
        ],
      };
      const options = {
        client,
        env: { ...makeLiveEnv(), GIT_SHA: "a".repeat(40) },
        nowMs,
        summaryPath,
        liveTickerDoc: ticker,
      };
      // Even an unreadable leftover from the failed capture must not block ticker publication.
      writeFileSync(summaryPath, "{invalid");
      const first = await publishWagersByStateSnapshotToR2({
        ...options,
        tickerOnly: true,
      });
      expect(first.hydratedRows).toBe(1);
      expect(first.legacySummaryUpdated).toBe(false);
      expect(r2.objects.get(key)).toBe(previous);
      expect(r2.conditionalPuts.some((put) => put.key === key)).toBe(false);
      expect(r2.objects.has(first.chunkKey)).toBe(true);
      expect(first.watermark_cursor).toBe(
        first.merkle_root_sha256.slice(0, 16) + ":1",
      );

      writeFileSync(
        summaryPath,
        JSON.stringify({
          source: {
            kind: "live-ajax.php",
            capturedAt,
            fromEpochSec: nowMs / 1000 - 3600,
            toEpochSec: nowMs / 1000,
          },
          window: { observedEnd: null },
          totals: { legs: 0 },
        }),
      );
      const second = await publishWagersByStateSnapshotToR2(options);
      expect(second.generation_u32).toBe(first.generation_u32 + 1);
      expect(second.prevETag).toBe(first.newETag);
      expect(second.legacySummaryUpdated).toBe(true);
      const moduleBytes = await Bun.file(
        resolve(ROOT, "scripts/publish_wagers_snapshot.ts"),
      ).arrayBuffer();
      for (const output of [key, WAGERS_BY_STATE_MANIFEST_KEY]) {
        expect(metadata.get(output)).toMatchObject({
          "publisher-module-sha256": Bun.SHA256.hash(moduleBytes, "hex"),
          "publisher-reported-commit": "a".repeat(40),
        });
      }
      expect(JSON.parse(await r2.client.file(key).text())).toMatchObject({
        capturedAt,
        window: { observedEnd: null, toMs: nowMs },
        totals: { legs: 0 },
        staleness: { stale: false },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["recent capture of an old window", 0, 3, "source.toEpochSec", true],
    ["old capture republished today", 3, 0, "source.capturedAt", true],
    ["quiet book through today", 0, 0, "source.capturedAt", false],
  ] as const)(
    "%s uses source coverage for freshness",
    async (_label, captureDays, windowDays, basis, stale) => {
      const dir = mkdtempSync(join(tmpdir(), "wager-coverage-"));
      try {
        const nowMs = Date.parse("2026-11-22T08:45:00.000Z");
        const dayMs = 86_400_000;
        const capturedAt = new Date(nowMs - captureDays * dayMs).toISOString();
        const requestEndMs = nowMs - windowDays * dayMs;
        const observedEnd = new Date(nowMs - 10 * dayMs).toISOString();
        const summaryPath = join(dir, "summary.json");
        writeFileSync(
          summaryPath,
          JSON.stringify({
            source: {
              kind: "live-ajax.php",
              capturedAt,
              toEpochSec: requestEndMs / 1000,
            },
            window: { observedEnd },
            totals: { legs: 1 },
          }),
        );
        const { client } = createInMemoryCasR2Client();
        await publishWagersByStateSnapshotToR2({
          client,
          env: makeLiveEnv(),
          nowMs,
          summaryPath,
          liveTickerDoc: {
            observedAt: new Date(nowMs).toISOString(),
            LIST: [],
          },
        });
        const summary = JSON.parse(
          await client.file("wagers-by-state/latest.json").text(),
        );
        expect(summary).toMatchObject({
          capturedAt,
          window: {
            observedEnd,
            toMs: Math.min(Date.parse(capturedAt), requestEndMs),
          },
          staleness: { timestampBasis: basis, stale },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("publishWagersByStateSnapshotToR2 enforces If-None-Match/If-Match CAS, 0 rebases on 412 (exit 74), and zero unresolved_gap_cents (exit 65)", async () => {
    const casHarness = createInMemoryCasR2Client();
    const okEnv = makeLiveEnv();
    const tickerDoc = {
      observedAt: "2026-11-17T20:10:00.001Z",
      LIST: [
        {
          WagerNumber: 769271281,
          CustomerID: "TACO323   ",
          Login: "TACO323",
          AmountWagered: 1500,
          InsertDateTime: "2026-11-17 14:56:05.157",
          TicketWriter: "Internet",
          ShortDesc:
            "P.Basketball #547 Pistons  12 -150 - buying 2 For Game Basketball #548 Knicks/Raptors O 212&#189; -110 - For Game",
        },
        {
          WagerNumber: 769271503,
          CustomerID: "TACO166   ",
          Login: "TACO166",
          AmountWagered: 1600,
          InsertDateTime: "2026-11-17 14:56:45.157",
          TicketWriter: "Internet",
          ShortDesc:
            "P.Basketball #547 Pistons +12 -110 - For Game Basketball #548 Knicks/Raptors U 212½ -110 - For Game",
        },
        {
          WagerNumber: 769270980,
          CustomerID: "TACO166   ",
          Login: "TACO166",
          AmountWagered: 11000,
          InsertDateTime: "2026-11-17 14:57:00.000",
          TicketWriter: "ALERT",
          ShortDesc: "S:Basketball #547 Pistons +12 -110 - For Game",
        },
      ],
    };

    // gen=1: uses If-None-Match: "*" and promotes both wagers-by-state and initial syndicate-rings
    const gen1 = await publishWagersByStateSnapshotToR2({
      client: casHarness.client,
      env: okEnv,
      liveTickerDoc: tickerDoc,
    });
    expect(gen1.generation_u32).toBe(1);
    expect(gen1.prevETag).toBeNull();
    expect(gen1.newETag).not.toBeNull();
    expect(gen1.chunkKey).toMatch(/^chunks\/[0-9a-f]{64}\.bin$/);
    expect(gen1.generationKey).toMatch(
      /^generations\/wagers-by-state\/gen-1-[0-9a-f]{16}$/,
    );
    expect(gen1.data_window_max_epoch_ms).toBe(
      Date.parse("2026-11-17T19:56:45.157Z"),
    );
    expect(gen1.syndicateRingsInitialized).toBe(true);
    expect(casHarness.conditionalPuts[0]).toEqual({
      key: WAGERS_BY_STATE_MANIFEST_KEY,
      ifNoneMatch: "*",
    });
    expect(casHarness.conditionalPuts[1]).toEqual({
      key: SYNDICATE_RINGS_MANIFEST_KEY,
      ifNoneMatch: "*",
    });

    // cross-ref reads purely from promoted manifests + SoA chunk (zero .json fallback)
    const payload = await executePairwiseCrossRefFromR2({
      r2: casHarness.client,
      customerA: "TACO323",
      customerB: "TACO166",
    });
    expect(payload.circuit_state).toBe("CLOSED");
    expect(payload.unresolved_gap_cents).toBe("0");
    expect(payload.generation_u32).toBe(1);
    expect(payload.data_window_max_epoch_ms).toBe(
      Date.parse("2026-11-17T19:56:45.157Z"),
    );
    expect(payload.manifests.syndicateRings.poison_bit).toBe(0);
    expect(payload.manifests.syndicateRings.circuit_state).toBe("CLOSED");
    expect(payload.hydratedRows).toBe(4);
    expect(payload.analysis.sameSideCount).toBe(1);
    expect(payload.analysis.oppositeSideCount).toBe(1);
    expect(payload.analysis.pregameFollowsAtoB).toBe(1);
    expect(payload.analysis.minSameSideLagMsU32).toBe(40_000);

    // gen=2: promotes with strict If-Match: gen1.newETag
    const gen2 = await publishWagersByStateSnapshotToR2({
      client: casHarness.client,
      env: okEnv,
      liveTickerDoc: tickerDoc,
    });
    expect(gen2.generation_u32).toBe(2);
    expect(gen2.prevETag).toBe(gen1.newETag);
    expect(gen2.syndicateRingsInitialized).toBe(false);
    expect(casHarness.conditionalPuts[2]).toEqual({
      key: WAGERS_BY_STATE_MANIFEST_KEY,
      ifMatch: gen1.newETag!,
    });

    // Weak R2 ETag prefixes (W/"...") normalize to strong ETag comparison
    expect(normalizeStrongETag('W/"abc123"')).toBe('"abc123"');
    expect(normalizeStrongETag("   ")).toBeNull();

    // Zero rebases on HTTP 412 -> ERR_R2_MANIFEST_CAS_REJECTED (exit 74)
    const putsBeforeRace = casHarness.conditionalPuts.length;
    const casRaceClient = createInMemoryCasR2Client(casHarness.objects);
    casRaceClient.simulateConcurrentRaceOnKey(WAGERS_BY_STATE_MANIFEST_KEY);
    let casErr: unknown = null;
    try {
      await promoteCanonicalManifestWithCas({
        client: casRaceClient.client,
        sinkId: "wagers-by-state",
        manifestKey: WAGERS_BY_STATE_MANIFEST_KEY,
        prevETag: gen2.newETag!,
        nextGenerationU32: 3,
        merkleRootSha256: gen2.merkle_root_sha256,
        manifest: { generation_u32: 3 },
        unresolvedGapCents: "0",
      });
    } catch (err) {
      casErr = err;
    }
    expect(casErr).toBeInstanceOf(Error);
    expect((casErr as Error).message).toContain("ERR_R2_MANIFEST_CAS_REJECTED");
    expect((casErr as { exitCode?: number }).exitCode).toBe(74);
    expect(casRaceClient.conditionalPuts).toHaveLength(1);
    expect(casHarness.conditionalPuts).toHaveLength(putsBeforeRace);

    // Pre-promotion non-zero unresolved_gap_cents -> ERR_OPS_RECONCILIATION_GAP (exit 65) leaving gen=2 intact
    let gapErr: unknown = null;
    try {
      await publishWagersByStateSnapshotToR2({
        client: casHarness.client,
        env: okEnv,
        unresolvedGapCents: "250",
        liveTickerDoc: tickerDoc,
      });
    } catch (err) {
      gapErr = err;
    }
    expect(gapErr).toBeInstanceOf(Error);
    expect((gapErr as Error).message).toContain("ERR_OPS_RECONCILIATION_GAP");
    expect((gapErr as { exitCode?: number }).exitCode).toBe(65);
    const intactLatest = JSON.parse(
      await casHarness.client.file(WAGERS_BY_STATE_MANIFEST_KEY).text(),
    ) as { generation_u32: number };
    expect(intactLatest.generation_u32).toBe(2);

    // Token bleed guard -> ERR_CF_TOKEN_BLEED_10000 (exit 77)
    let tokenErr: unknown = null;
    try {
      await publishWagersByStateSnapshotToR2({
        client: casHarness.client,
        env: {
          ...okEnv,
          CLOUDFLARE_R2_API_TOKEN: "r2",
          CLOUDFLARE_API_TOKEN: "cf",
        },
        liveTickerDoc: tickerDoc,
      });
    } catch (err) {
      tokenErr = err;
    }
    expect(tokenErr).toBeInstanceOf(Error);
    expect((tokenErr as Error).message).toContain("ERR_CF_TOKEN_BLEED_10000");
    expect((tokenErr as { exitCode?: number }).exitCode).toBe(77);
  });

  test("bun x --no-install sportsdesk-fraud cross-ref enforces --help, ERR_OPS_LOCAL_JSON_FORBIDDEN (exit 78), and preflight gates", () => {
    const helpProc = Bun.spawnSync(
      [
        process.execPath,
        "x",
        "--no-install",
        "sportsdesk-fraud",
        "cross-ref",
        "--help",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(helpProc.exitCode).toBe(0);
    expect(helpProc.stdout.toString()).toContain("sportsdesk-fraud cross-ref");

    const localJsonProc = Bun.spawnSync(
      [
        process.execPath,
        "x",
        "--no-install",
        "sportsdesk-fraud",
        "cross-ref",
        "C001",
        "C002",
        "--input",
        "live.json",
        "--json",
      ],
      {
        cwd: ROOT,
        env: makeLiveEnv(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(localJsonProc.exitCode).toBe(78);
    expect(localJsonProc.stderr.toString()).toContain(
      "ERR_OPS_LOCAL_JSON_FORBIDDEN",
    );

    const bleedEnv = {
      ...makeLiveEnv(),
      CLOUDFLARE_R2_API_TOKEN: "r2",
      CLOUDFLARE_API_TOKEN: "cf",
    };
    const bleedProc = Bun.spawnSync(
      [
        process.execPath,
        "x",
        "--no-install",
        "sportsdesk-fraud",
        "cross-ref",
        "C001",
        "C002",
        "--json",
      ],
      {
        cwd: ROOT,
        env: bleedEnv,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(bleedProc.exitCode).toBe(77);
    expect(bleedProc.stderr.toString()).toContain("ERR_CF_TOKEN_BLEED_10000");
  });

  test("CANONICAL_R2_SINK_SPECS registers ops-supervisor & edge-topology with dual-clock verify, staleness, and If-Match CAS", async () => {
    expect(CANONICAL_R2_SINK_SPECS["wagers-by-state"].manifestKey).toBe(
      WAGERS_BY_STATE_MANIFEST_KEY,
    );
    expect(CANONICAL_R2_SINK_SPECS["syndicate-rings"].manifestKey).toBe(
      SYNDICATE_RINGS_MANIFEST_KEY,
    );
    expect(CANONICAL_R2_SINK_SPECS["ops-supervisor"]).toMatchObject({
      sinkId: "ops-supervisor",
      manifestKey: "manifests/ops-supervisor/latest",
      generationPrefix: "generations/ops-supervisor",
      lane: "ops-control-plane",
      skillOrdinalU8: 16,
      domain: "[Ops & Governance]",
      r2Bucket: R2_BUCKET,
    });
    expect(CANONICAL_R2_SINK_SPECS["edge-topology"]).toMatchObject({
      sinkId: "edge-topology",
      manifestKey: "manifests/edge-topology/latest",
      generationPrefix: "generations/edge-topology",
      lane: "ops-edge-ci",
      skillOrdinalU8: 4,
      r2Region: "ENAM",
      domain: "[Ops & Governance]",
      r2Bucket: R2_BUCKET,
    });

    const casHarness = createInMemoryCasR2Client();
    const okEnv = makeLiveEnv();
    const baseMs = Date.parse("2026-11-17T20:00:00.000Z");

    // Publish wagers-by-state + initial syndicate-rings first
    await publishWagersByStateSnapshotToR2({
      client: casHarness.client,
      env: okEnv,
      nowMs: baseMs,
      liveTickerDoc: {
        observedAt: new Date(baseMs).toISOString(),
        LIST: [
          {
            WagerNumber: 1001,
            CustomerID: "C001",
            AmountWagered: 500,
            InsertDateTime: "2026-11-17 15:00:00.000",
            TicketWriter: "Internet",
            ShortDesc: "S.Basketball #547 Pistons +12 -110 - For Game",
          },
        ],
      },
    });

    // Before syncing ops-supervisor & edge-topology, verifyCanonicalR2Manifests reports ok=false
    const preVerify = await verifyCanonicalR2Manifests({
      client: casHarness.client,
      env: okEnv,
    });
    expect(preVerify.ok).toBe(false);
    expect(preVerify.circuit_state).toBe("OPEN");

    // syncCanonicalGovernanceManifestsToR2 requires SPORTSDESK_LIVE_INGEST=1
    let noLiveErr: unknown = null;
    try {
      await syncCanonicalGovernanceManifestsToR2({
        client: casHarness.client,
        env: { ...okEnv, SPORTSDESK_LIVE_INGEST: "0" },
        nowMs: baseMs,
      });
    } catch (err) {
      noLiveErr = err;
    }
    expect((noLiveErr as { exitCode?: number }).exitCode).toBe(65);

    // Sync gen=1 ops-supervisor and edge-topology with SPORTSDESK_LIVE_INGEST=1
    const syncGen1 = await syncCanonicalGovernanceManifestsToR2({
      client: casHarness.client,
      env: {
        ...okEnv,
        SPORTSDESK_LIVE_INGEST: "1",
        CLOUDFLARE_ACCOUNT_ID: "acc-test-enam",
      },
      nowMs: baseMs + 5_000,
    });
    expect(syncGen1.opsSupervisor.manifest.generation_u32).toBe(1);
    expect(syncGen1.opsSupervisor.manifest.lane).toBe("ops-control-plane");
    expect(syncGen1.opsSupervisor.manifest.skillOrdinalU8).toBe(16);
    expect(syncGen1.edgeTopology.manifest.generation_u32).toBe(1);
    expect(syncGen1.edgeTopology.manifest.snapshot_gen_u32).toBe(1);
    expect(syncGen1.edgeTopology.manifest.r2_region).toBe("ENAM");
    expect(syncGen1.edgeTopology.manifest.account_scope).toBe("acc-test-enam");
    expect(syncGen1.edgeTopology.manifest.etag_cas).toBe("If-None-Match:*");
    expect(syncGen1.edgeTopology.manifest.drift_exit_code).toBe(0);

    // Non-zero drift_exit_code aborts edge-topology promotion
    let driftErr: unknown = null;
    try {
      await publishEdgeTopologyManifestToR2({
        client: casHarness.client,
        env: okEnv,
        driftExitCode: 2,
      });
    } catch (err) {
      driftErr = err;
    }
    expect((driftErr as { exitCode?: number }).exitCode).toBe(65);

    // gen=2 ops-supervisor uses strict If-Match ETag
    const opsGen2 = await publishOpsSupervisorManifestToR2({
      client: casHarness.client,
      env: okEnv,
      nowMs: baseMs + 10_000,
    });
    expect(opsGen2.manifest.generation_u32).toBe(2);
    expect(opsGen2.prevETag).toBe(syncGen1.opsSupervisor.newETag);

    // All 4 canonical manifests present, CLOSED, gap="0", and fresh within SLA
    const verified = await verifyCanonicalR2Manifests({
      client: casHarness.client,
      env: okEnv,
    });
    expect(verified.ok).toBe(true);
    expect(verified.circuit_state).toBe("CLOSED");
    expect(verified.unresolved_gap_cents).toBe("0");
    expect(verified.sinks).toHaveLength(4);

    const freshReport = await evaluateCanonicalR2ManifestStaleness({
      client: casHarness.client,
      env: okEnv,
      nowMs: baseMs + 60_000,
      slaMs: 3_600_000,
    });
    expect(freshReport.ok).toBe(true);
    expect(freshReport.degraded_count).toBe(0);
    expect(freshReport.circuit_state).toBe("CLOSED");

    // Advance clock past SLA -> marks sinks stale on dual clocks
    const staleReport = await evaluateCanonicalR2ManifestStaleness({
      client: casHarness.client,
      env: okEnv,
      nowMs: baseMs + 7_200_000,
      slaMs: 3_600_000,
    });
    expect(staleReport.ok).toBe(false);
    expect(staleReport.degraded_count).toBeGreaterThan(0);
    expect(staleReport.circuit_state).toBe("OPEN");

    // BRIDGE_R2_SINK_SPECS & includeBridges:true audits all 6 manifests on demand
    expect(Object.keys(BRIDGE_R2_SINK_SPECS)).toEqual([
      "xml-ingest",
      "f402-weblog",
    ]);
    await casHarness.client.write(
      BRIDGE_R2_SINK_SPECS["xml-ingest"].manifestKey,
      JSON.stringify({
        domain: "[Ops & Governance]",
        sink_id: "xml-ingest",
        generation_u32: 4,
        merkle_root_sha256: "e".repeat(64),
        data_window_max_epoch_ms: baseMs,
        r2_published_at_epoch_ms: baseMs + 1_000,
        circuit_state: "CLOSED",
        unresolved_gap_cents: "0",
      }),
    );
    await casHarness.client.write(
      BRIDGE_R2_SINK_SPECS["f402-weblog"].manifestKey,
      JSON.stringify({
        schemaVersion: 1,
        kind: "f402-weblog-manifest",
        deskDate: "2026-11-17",
        sha256: "d".repeat(64),
        data_window_max_epoch_ms: baseMs,
        r2_published_at_epoch_ms: baseMs + 2_000,
      }),
    );

    const sixVerify = await verifyCanonicalR2Manifests({
      client: casHarness.client,
      env: okEnv,
      includeBridges: true,
    });
    expect(sixVerify.ok).toBe(true);
    expect(sixVerify.sinks).toHaveLength(6);

    const sixStale = await evaluateCanonicalR2ManifestStaleness({
      client: casHarness.client,
      env: okEnv,
      includeBridges: true,
      nowMs: baseMs + 60_000,
      slaMs: 3_600_000,
    });
    expect(sixStale.ok).toBe(true);
    expect(sixStale.sinks).toHaveLength(6);

    // Chunk faults (ERR_R2_CHUNK_MERKLE_MISMATCH & ERR_R2_CHUNK_PUT_RETRY) report exit 74 (EX_IOERR)
    let mismatchErr: unknown = null;
    try {
      await writeContentAddressedChunkWithRetry(
        casHarness.client,
        new Uint8Array([1, 2, 3]),
        { expectedSha256: "0".repeat(64), maxRetries: 0, baseDelayMs: 0 },
      );
    } catch (err) {
      mismatchErr = err;
    }
    expect((mismatchErr as Error).message).toContain(
      "ERR_R2_CHUNK_MERKLE_MISMATCH",
    );
    expect((mismatchErr as { exitCode?: number }).exitCode).toBe(74);

    const failingChunkClient: CasR2ClientLike = {
      async headEtag() {
        return null;
      },
      async write() {
        throw new Error("simulated chunk S3 reset");
      },
      async writeWithMetadata() {
        return 0;
      },
      file() {
        return {
          async text() {
            return "";
          },
          async bytes() {
            return new Uint8Array(0);
          },
        };
      },
      async stat() {
        return {};
      },
    };
    let retryErr: unknown = null;
    try {
      await writeContentAddressedChunkWithRetry(
        failingChunkClient,
        new Uint8Array([4, 5, 6]),
        { maxRetries: 1, baseDelayMs: 0 },
      );
    } catch (err) {
      retryErr = err;
    }
    expect((retryErr as Error).message).toContain("ERR_R2_CHUNK_PUT_RETRY");
    expect((retryErr as { exitCode?: number }).exitCode).toBe(74);

    // STAGE_4_LEDGER_PUBLISH_SNAPSHOT records DOC-14, DOC-16, LIVE-KEEP-HUD while leaving DOC-13 untouched
    expect(STAGE_4_LEDGER_PUBLISH_SNAPSHOT.preserved_docs).toEqual(["DOC-13"]);
    expect(STAGE_4_LEDGER_PUBLISH_SNAPSHOT.targets["DOC-14"].label).toBe(
      "LIVE-01",
    );
    expect(STAGE_4_LEDGER_PUBLISH_SNAPSHOT.targets["DOC-16"].label).toBe(
      "LIVE-02",
    );
    expect(
      STAGE_4_LEDGER_PUBLISH_SNAPSHOT.sinks["wagers-by-state"].generation_u32,
    ).toBe(2);
    expect(
      STAGE_4_LEDGER_PUBLISH_SNAPSHOT.sinks["edge-topology"].generation_u32,
    ).toBe(1);
  });

  test("PR #340 follow-up invariants (#341, #342, #344): header validation before alloc, f402-weblog generationPrefix, and self-comparison guard", async () => {
    // #342: f402-weblog generationPrefix matches generations/<sinkId>
    expect(BRIDGE_R2_SINK_SPECS["f402-weblog"].generationPrefix).toBe(
      "generations/f402-weblog",
    );

    // #344: evaluateColumnarPairwiseCrossRef rejects self-comparison after normalization
    const store = new PairwiseWagerColumnStore(2);
    expect(() =>
      evaluateColumnarPairwiseCrossRef(store, " c001 ", "C001"),
    ).toThrow("ERR_PAIRWISE_SELF_COMPARISON");

    // #341: executePairwiseCrossRefFromR2 validates SoA header before allocating PairwiseWagerColumnStore
    const malformedChunk = new Uint8Array(16);
    const dv = new DataView(malformedChunk.buffer);
    dv.setUint32(0, 0x534f4157, true);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, 0xffff_ffff, true);
    dv.setUint32(12, 0xffff_ffff, true);

    const mockR2: PairwiseR2Reader = {
      file(key: string) {
        return {
          async text() {
            if (key === WAGERS_BY_STATE_MANIFEST_KEY) {
              return JSON.stringify({
                generation_u32: 1,
                merkle_root_sha256: "a".repeat(64),
                watermark_cursor: "wm-1",
                data_window_max_epoch_ms: 1_763_400_000_000,
                r2_published_at_epoch_ms: 1_763_400_000_000,
                chunk_key: "chunks/corrupt.bin",
                circuit_state: "CLOSED",
                unresolved_gap_cents: "0",
              });
            }
            return JSON.stringify({
              domain: "[DOD Spine]",
              generation_u32: 1,
              spine_generation_u32: 1,
              merkle_root_sha256: "b".repeat(64),
              data_window_max_epoch_ms: 1_763_400_000_000,
              r2_published_at_epoch_ms: 1_763_400_000_000,
              poison_bit: 0,
              circuit_state: "CLOSED",
              active_edge_count_u32: 0,
              ring_count_u32: 0,
              unresolved_gap_cents: "0",
            });
          },
          async bytes() {
            return malformedChunk;
          },
        };
      },
    };

    let chunkErr: unknown = null;
    try {
      await executePairwiseCrossRefFromR2({
        r2: mockR2,
        customerA: "C001",
        customerB: "C002",
      });
    } catch (err) {
      chunkErr = err;
    }
    expect((chunkErr as Error).message).toContain(
      "ERR_SOA_BINARY_PAYLOAD_TRUNCATED",
    );
    expect((chunkErr as { exitCode?: number }).exitCode).toBe(65);
  });
});
