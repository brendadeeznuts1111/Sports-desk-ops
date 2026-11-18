import { describe, expect, it } from "bun:test";
import {
  COMBO_KEY15_BITS,
  COMBO_KEY15_MASK,
  DenseSubSportLookupTable,
  MARKET_KIND_BITS,
  MARKET_KIND_MASK,
  MARKET_KIND_SHIFT,
  PERIOD_BITS,
  PERIOD_MASK,
  PERIOD_SHIFT,
  SUB_SPORT_BITS,
  SUB_SPORT_MASK,
  SUB_SPORT_SHIFT,
  SUBSPORT_FIELD_MASK,
  SUBSPORT_UNKNOWN_CODE6,
  WAGER_TYPE_BITS,
  WAGER_TYPE_MASK,
  WAGER_TYPE_SHIFT,
  hydratePortalTaxonomyFromR2,
  packSubSportComboKey15,
  type PortalTaxonomyManifest,
} from "../src/lib/portal_taxonomy_normalizer";

function createTestManifest(
  overrides: Partial<PortalTaxonomyManifest> = {},
): PortalTaxonomyManifest {
  return {
    generation_u32: 4,
    merkle_root_sha256: "a".repeat(64),
    r2_published_at_epoch_ms: 1_763_262_000_000,
    entries: [
      {
        sport: "FOOTBALL",
        subSport: "NFL",
        denseCode6: 1,
        aliases: ["NFL", "PRO FOOTBALL"],
      },
      {
        sport: "FOOTBALL",
        subSport: "CFB",
        denseCode6: 2,
        aliases: ["CFB", "NCAA FOOTBALL", "COLLEGE FOOTBALL"],
      },
      {
        sport: "BASKETBALL",
        subSport: "NBA",
        denseCode6: 3,
        aliases: ["NBA", "PRO BASKETBALL"],
      },
      {
        sport: "BASKETBALL",
        subSport: "NCAAB",
        denseCode6: 4,
        aliases: ["NCAAB", "NCAA BASKETBALL", "CBB"],
      },
      { sport: "HOCKEY", subSport: "NHL", denseCode6: 5, aliases: ["NHL"] },
      { sport: "BASEBALL", subSport: "MLB", denseCode6: 6, aliases: ["MLB"] },
      {
        sport: "TENNIS",
        subSport: "ATP",
        denseCode6: 18,
        aliases: ["ATP TOUR"],
      },
      {
        sport: "MAX_BOUNDARY",
        subSport: "MAX_63",
        denseCode6: SUBSPORT_FIELD_MASK,
      },
    ],
    ...overrides,
  };
}

describe("DenseSubSportLookupTable", () => {
  it("resolves canonical entries and case-insensitive/trimmed aliases to dense 6-bit codes", () => {
    const table = new DenseSubSportLookupTable(createTestManifest());

    expect(table.generationU32).toBe(4);
    expect(table.resolveDenseSubSportCode6("FOOTBALL", "NFL")).toBe(1);
    expect(table.resolveDenseSubSportCode6("football", "pro football")).toBe(1);
    expect(table.resolveDenseSubSportCode6("  BASKETBALL ", "  cbb  ")).toBe(4);
    expect(table.resolveDenseSubSportCode6("TENNIS", "ATP")).toBe(18);
    expect(table.resolveDenseSubSportCode6("TENNIS", "atp tour")).toBe(18);
    expect(table.resolveDenseSubSportCode6("MAX_BOUNDARY", "MAX_63")).toBe(63);
  });

  it("maps null, undefined, and empty/whitespace subSport to SUBSPORT_UNKNOWN_CODE6 (0)", () => {
    const table = new DenseSubSportLookupTable(createTestManifest());

    expect(table.resolveDenseSubSportCode6("BASKETBALL", null)).toBe(
      SUBSPORT_UNKNOWN_CODE6,
    );
    expect(table.resolveDenseSubSportCode6("BASKETBALL", undefined)).toBe(0);
    expect(table.resolveDenseSubSportCode6("", null)).toBe(0);
    expect(table.resolveDenseSubSportCode6("FOOTBALL", "   ")).toBe(0);
  });

  it("prevents delimiter-free prefix collisions such as (FOOT, BALL) vs (FOO, TBALL)", () => {
    const manifest = createTestManifest({
      entries: [
        { sport: "FOOT", subSport: "BALL", denseCode6: 10 },
        { sport: "FOO", subSport: "TBALL", denseCode6: 11 },
      ],
    });
    const table = new DenseSubSportLookupTable(manifest);

    expect(table.resolveDenseSubSportCode6("FOOT", "BALL")).toBe(10);
    expect(table.resolveDenseSubSportCode6("FOO", "TBALL")).toBe(11);
  });

  it("fails closed with ERR_DOD_BITFIELD_RANGE_OVERFLOW when manifest assigns code 0, negative, or > 63", () => {
    expect(
      () =>
        new DenseSubSportLookupTable(
          createTestManifest({
            entries: [
              { sport: "FOOTBALL", subSport: "RESERVED_ZERO", denseCode6: 0 },
            ],
          }),
        ),
    ).toThrow(/ERR_DOD_BITFIELD_RANGE_OVERFLOW/);

    expect(
      () =>
        new DenseSubSportLookupTable(
          createTestManifest({
            entries: [
              { sport: "FOOTBALL", subSport: "NEGATIVE_CODE", denseCode6: -1 },
            ],
          }),
        ),
    ).toThrow(/ERR_DOD_BITFIELD_RANGE_OVERFLOW/);

    expect(
      () =>
        new DenseSubSportLookupTable(
          createTestManifest({
            entries: [
              { sport: "FOOTBALL", subSport: "OVERFLOW_64", denseCode6: 64 },
            ],
          }),
        ),
    ).toThrow(/ERR_DOD_BITFIELD_RANGE_OVERFLOW/);
  });

  it("rejects duplicate denseCode6 assignments across entries", () => {
    expect(
      () =>
        new DenseSubSportLookupTable(
          createTestManifest({
            entries: [
              { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1 },
              { sport: "BASKETBALL", subSport: "NBA", denseCode6: 1 },
            ],
          }),
        ),
    ).toThrow(/ERR_DOD_BITFIELD_RANGE_OVERFLOW: Duplicate denseCode6=1/);
  });

  it("rejects conflicting alias mappings targeting different denseCode6 values", () => {
    expect(
      () =>
        new DenseSubSportLookupTable(
          createTestManifest({
            entries: [
              {
                sport: "BASKETBALL",
                subSport: "NBA",
                denseCode6: 3,
                aliases: ["PRO_HOOPS"],
              },
              {
                sport: "BASKETBALL",
                subSport: "WNBA",
                denseCode6: 7,
                aliases: ["pro_hoops"],
              },
            ],
          }),
        ),
    ).toThrow(/ERR_DOD_BITFIELD_RANGE_OVERFLOW: Conflicting alias mapping/);
  });

  it("throws ERR_DOD_BITFIELD_RANGE_OVERFLOW on unregistered non-null subSport pairs", () => {
    const table = new DenseSubSportLookupTable(createTestManifest());

    expect(() =>
      table.resolveDenseSubSportCode6("CRICKET", "CRICKET_T20"),
    ).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW: Unmapped F402 taxonomy pair \(CRICKET\/CRICKET_T20\)/,
    );
    expect(() => table.resolveDenseSubSportCode6("", "NBA")).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW: Unmapped F402 taxonomy pair \(<empty>\/NBA\)/,
    );
  });

  it("maintains open-addressed probe convergence above 256 keys (dynamic table expansion)", () => {
    const entries = Array.from({ length: 63 }, (_, index) => {
      const code = index + 1;
      return {
        sport: `SPORT_${code}`,
        subSport: `SUB_${code}`,
        denseCode6: code,
        aliases: [`ALIAS_A_${code}`, `ALIAS_B_${code}`, `ALIAS_C_${code}`],
      };
    });
    const table = new DenseSubSportLookupTable(createTestManifest({ entries }));

    for (let code = 1; code <= 63; code++) {
      expect(
        table.resolveDenseSubSportCode6(`SPORT_${code}`, `SUB_${code}`),
      ).toBe(code);
      expect(
        table.resolveDenseSubSportCode6(`SPORT_${code}`, `ALIAS_C_${code}`),
      ).toBe(code);
    }
  });
});

describe("packSubSportComboKey15", () => {
  it("packs [14:9] subSport6 | [8:6] wagerType3 | [5:2] period4 | [1:0] marketKind2", () => {
    expect(MARKET_KIND_BITS).toBe(2);
    expect(PERIOD_BITS).toBe(4);
    expect(WAGER_TYPE_BITS).toBe(3);
    expect(SUB_SPORT_BITS).toBe(6);
    expect(MARKET_KIND_SHIFT).toBe(0);
    expect(PERIOD_SHIFT).toBe(2);
    expect(WAGER_TYPE_SHIFT).toBe(6);
    expect(SUB_SPORT_SHIFT).toBe(9);
    expect(SUB_SPORT_MASK).toBe(SUBSPORT_FIELD_MASK);
    expect(COMBO_KEY15_BITS).toBe(15);
    expect(COMBO_KEY15_MASK).toBe(0x7fff);

    const atpSet2Ml = packSubSportComboKey15(18, 0, 14, 2);
    expect(atpSet2Ml).toBe((18 << SUB_SPORT_SHIFT) | (14 << PERIOD_SHIFT) | 2);
    expect((atpSet2Ml >>> SUB_SPORT_SHIFT) & SUB_SPORT_MASK).toBe(18);

    const unknownLiveSpread = packSubSportComboKey15(
      SUBSPORT_UNKNOWN_CODE6,
      7,
      0,
      0,
    );
    expect(unknownLiveSpread).toBe(0x01c0);

    const maxKey = packSubSportComboKey15(
      SUBSPORT_FIELD_MASK,
      WAGER_TYPE_MASK,
      PERIOD_MASK,
      MARKET_KIND_MASK,
    );
    expect(maxKey).toBe(COMBO_KEY15_MASK);
  });

  it("fails closed with ERR_DOD_BITFIELD_RANGE_OVERFLOW on negative, float, NaN, or out-of-range inputs", () => {
    expect(() => packSubSportComboKey15(-1, 0, 0, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => packSubSportComboKey15(64, 0, 0, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => packSubSportComboKey15(1, 8, 0, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => packSubSportComboKey15(1, 0, 16, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => packSubSportComboKey15(1, 0, 0, 4)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => packSubSportComboKey15(1.5, 0, 0, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => packSubSportComboKey15(Number.NaN, 0, 0, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
  });
});

describe("hydratePortalTaxonomyFromR2", () => {
  it("hydrates DenseSubSportLookupTable and ETag from Bun.S3Client contract", async () => {
    const manifestJson = JSON.stringify(
      createTestManifest({ generation_u32: 9 }),
    );
    const mockR2 = {
      file(key: string) {
        expect(key).toBe("manifests/portal-taxonomy/latest");
        return {
          stat: async () => ({ etag: '"etag-gen-9"' }),
          text: async () => manifestJson,
        };
      },
    } as unknown as Bun.S3Client;

    const { table, eTag } = await hydratePortalTaxonomyFromR2(mockR2);
    expect(eTag).toBe('"etag-gen-9"');
    expect(table.generationU32).toBe(9);
    expect(table.resolveDenseSubSportCode6("BASKETBALL", "NBA")).toBe(3);
  });

  it("fails closed with ERR_DOD_INVALID_SPINE_MAGIC on malformed R2 manifest payloads", async () => {
    const mockR2 = {
      file() {
        return {
          stat: async () => ({ etag: '"etag-bad"' }),
          text: async () => JSON.stringify({ generation_u32: "not-a-number" }),
        };
      },
    } as unknown as Bun.S3Client;

    await expect(hydratePortalTaxonomyFromR2(mockR2)).rejects.toThrow(
      /ERR_DOD_INVALID_SPINE_MAGIC/,
    );
  });
});
