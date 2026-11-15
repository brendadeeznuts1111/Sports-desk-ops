import { describe, expect, test } from "bun:test";

import {
  ORIGIN_DOMAIN_REGISTRY,
  SENTINEL_CHANNEL_REGISTRY,
  VENUE_REGISTRY,
  WRITER_LANES_BY_ORIGIN,
  WRITER_LANE_REGISTRY,
  isOriginDomainId,
  isSentinelChannelId,
  isTradeableVenue,
  isVenueId,
  isWriterLaneId,
  parseVenueId,
  resolveVenueIdForOrigin,
  resolveVenueIdForWriter,
  resolveWriterChannel,
  resolveWriterLaneId,
  sentinelChannelEntryFor,
  venueEntry,
  writerLaneEntryForChannel,
  type OriginDomainId,
  type SentinelChannelId,
  type VenueId,
  type WriterLaneId,
} from "../lib/domain_venue_registry.ts";
import {
  SENTINEL_CHANNEL_BY_WIRE_ID,
  SENTINEL_CHANNEL_WIRE_ID,
  WRITER_LANE_BY_WIRE_ID,
  WRITER_LANE_WIRE_ID,
  sentinelChannelWireIdOf,
  writerLaneIdOfWireId,
  writerLaneWireIdOf,
} from "../lib/domain-enums.ts";

describe("venue registry", () => {
  test("every venue id has an entry whose id matches its key", () => {
    for (const [id, entry] of Object.entries(VENUE_REGISTRY)) {
      expect(entry.venueId).toBe(id as VenueId);
      expect(entry.displayLabel.length).toBeGreaterThan(0);
      expect(entry.brandColorHex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("every venue has exactly one origin, and every origin one venue", () => {
    for (const venueId of Object.keys(VENUE_REGISTRY) as VenueId[]) {
      expect(VENUE_REGISTRY[venueId].originDomainIds).toHaveLength(1);
    }
    const seen = new Set<string>();
    for (const origin of Object.keys(
      ORIGIN_DOMAIN_REGISTRY,
    ) as OriginDomainId[]) {
      const venueId = ORIGIN_DOMAIN_REGISTRY[origin].venueId;
      expect(VENUE_REGISTRY[venueId].originDomainIds).toContain(origin);
      expect(seen.has(origin)).toBe(false);
      seen.add(origin);
    }
  });

  test("a venue's origins and colour are derived from the origin table", () => {
    for (const venueId of Object.keys(VENUE_REGISTRY) as VenueId[]) {
      const derived = (
        Object.keys(ORIGIN_DOMAIN_REGISTRY) as OriginDomainId[]
      ).filter((origin) => ORIGIN_DOMAIN_REGISTRY[origin].venueId === venueId);
      expect(VENUE_REGISTRY[venueId].originDomainIds).toEqual(derived);
      expect(VENUE_REGISTRY[venueId].brandColorHex).toBe(
        ORIGIN_DOMAIN_REGISTRY[derived[0]!].brandColorHex,
      );
    }
  });

  test("the split venues are desk and lakehouse, and neither settles", () => {
    expect(VENUE_REGISTRY.desk.kind).toBe("internal");
    expect(VENUE_REGISTRY.lakehouse.kind).toBe("internal");
    for (const id of ["desk", "lakehouse"] as const) {
      expect("settlement" in VENUE_REGISTRY[id]).toBe(false);
      expect(isTradeableVenue(VENUE_REGISTRY[id])).toBe(false);
    }
    expect(VENUE_REGISTRY.f402.settlement).toBe("cash_stake");
    expect(VENUE_REGISTRY.polymarket.settlement).toBe("token_position");
    expect(isTradeableVenue(VENUE_REGISTRY.f402)).toBe(true);
  });

  test("kinds are stated per venue", () => {
    expect(VENUE_REGISTRY.f402.kind).toBe("sportsbook");
    expect(VENUE_REGISTRY.gslive_partner118.kind).toBe("sportsbook");
    expect(VENUE_REGISTRY.polymarket.kind).toBe("exchange");
    expect(VENUE_REGISTRY.kalshi.kind).toBe("exchange");
  });
});

describe("writer lanes are feeds, sentinels are row states", () => {
  test("lane id, provenance label and signal channel code agree", () => {
    for (const lane of Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[]) {
      const entry = WRITER_LANE_REGISTRY[lane];
      expect(entry.writerLaneId).toBe(lane);
      expect(entry.provenanceLabel).toBe(lane.toUpperCase());
      expect(resolveVenueIdForOrigin(entry.originDomainId)).toBe(entry.venueId);
    }
  });

  test("no lane is a sentinel class, and sentinels are not lanes", () => {
    for (const lane of Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[]) {
      expect(isSentinelChannelId(lane)).toBe(false);
    }
    for (const sentinel of Object.keys(
      SENTINEL_CHANNEL_REGISTRY,
    ) as SentinelChannelId[]) {
      expect(isWriterLaneId(sentinel)).toBe(false);
      expect(SENTINEL_CHANNEL_REGISTRY[sentinel].isMoneyExcluded).toBe(true);
    }
  });

  test("ALERT is the mirror lane, not a Kalshi lane", () => {
    expect(resolveWriterChannel("ALERT")).toBe("inet_mirror");
    expect(resolveWriterChannel("Internet")).toBe("internet");
    expect(resolveWriterLaneId("ALERT")).toBe("inet_mirror");
    expect(resolveVenueIdForWriter("ALERT")).toBe("f402");
    expect(SENTINEL_CHANNEL_REGISTRY.alert.laneId).toBe("inet_mirror");
    expect(SENTINEL_CHANNEL_REGISTRY.alert.signalChannelCode).toBe("ALERT");
    expect(writerLaneEntryForChannel("alert")?.writerLaneId).toBe(
      "inet_mirror",
    );
    expect(sentinelChannelEntryFor("alert")?.sentinelId).toBe("alert");
    expect(sentinelChannelEntryFor("internet")).toBeNull();
  });

  test("an unparseable writer is a sentinel, and asking for a lane throws", () => {
    expect(resolveWriterChannel("mystery-writer")).toBe("unknown");
    expect(resolveVenueIdForWriter("mystery-writer")).toBe("desk");
    expect(SENTINEL_CHANNEL_REGISTRY.unknown.provenanceLabel).toBe(
      "UNRESOLVED",
    );
    expect(() => resolveWriterLaneId("mystery-writer")).toThrow(/GATE-04/);
    expect(() => resolveWriterLaneId("BLOCKED")).toThrow(/GATE-04/);
    expect(writerLaneEntryForChannel("unknown")).toBeNull();
  });

  test("every origin's writer lanes are derived, and Kalshi claims none", () => {
    for (const origin of Object.keys(
      ORIGIN_DOMAIN_REGISTRY,
    ) as OriginDomainId[]) {
      const derived = (
        Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[]
      ).filter((lane) => WRITER_LANE_REGISTRY[lane].originDomainId === origin);
      expect(WRITER_LANES_BY_ORIGIN[origin]).toEqual(derived);
    }
    expect(WRITER_LANES_BY_ORIGIN.ORIGIN_EXCHANGE_KALSHI_REGULATED).toEqual([]);
  });
});

describe("wire ids stay frozen while the ids are renamed", () => {
  test("lanes keep their bytes and sentinels keep theirs", () => {
    expect(writerLaneWireIdOf("internet")).toBe(3);
    expect(writerLaneWireIdOf("gslive")).toBe(2);
    expect(writerLaneWireIdOf("gsbuilder")).toBe(4);
    expect(writerLaneWireIdOf("cslevel2")).toBe(5);
    expect(writerLaneWireIdOf("gateway")).toBe(6);
    expect(writerLaneWireIdOf("inet_mirror")).toBe(1);
    expect(sentinelChannelWireIdOf("alert")).toBe(1);
    expect(sentinelChannelWireIdOf("blocked")).toBe(7);
    expect(sentinelChannelWireIdOf("unknown")).toBe(0);
    expect(sentinelChannelWireIdOf("non_sports_drop")).toBe(8);
  });

  test("decoding prefers the lane and falls back to the sentinel class", () => {
    expect(writerLaneIdOfWireId(1)).toBe("inet_mirror");
    expect(writerLaneIdOfWireId(3)).toBe("internet");
    expect(writerLaneIdOfWireId(0)).toBe("unknown");
    expect(writerLaneIdOfWireId(7)).toBe("blocked");
    expect(writerLaneIdOfWireId(8)).toBe("non_sports_drop");
    expect(writerLaneIdOfWireId(99)).toBeNull();
    expect(Object.keys(WRITER_LANE_BY_WIRE_ID).sort()).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(Object.keys(SENTINEL_CHANNEL_BY_WIRE_ID).sort()).toEqual([
      "0",
      "7",
      "8",
    ]);
    expect(Object.keys(WRITER_LANE_WIRE_ID).sort()).toEqual([
      "cslevel2",
      "gateway",
      "gsbuilder",
      "gslive",
      "inet_mirror",
      "internet",
    ]);
    expect(Object.keys(SENTINEL_CHANNEL_WIRE_ID).sort()).toEqual([
      "alert",
      "blocked",
      "non_sports_drop",
      "unknown",
    ]);
  });
});

describe("boundary parsing", () => {
  test("parses canonical ids and external spellings, and refuses the rest", () => {
    expect(parseVenueId("polymarket")).toBe("polymarket");
    expect(parseVenueId("  F402 ")).toBe("f402");
    expect(parseVenueId("Fantasy402")).toBe("f402");
    expect(parseVenueId("GS-LIVE")).toBe("gslive_partner118");
    expect(parseVenueId("ctf")).toBe("polymarket");
    expect(parseVenueId("r2")).toBe("lakehouse");
    expect(parseVenueId("internal")).toBe("desk");
    expect(parseVenueId("coinbase")).toBeNull();
    expect(parseVenueId("")).toBeNull();
    expect(parseVenueId(null)).toBeNull();
    expect(parseVenueId(42)).toBeNull();
  });

  test("type guards agree with the registries and reject lookalikes", () => {
    expect(isVenueId("f402")).toBe(true);
    expect(isVenueId("internal")).toBe(false);
    expect(isVenueId("f402 ")).toBe(false);
    expect(isOriginDomainId("ORIGIN_EXCHANGE_KALSHI_REGULATED")).toBe(true);
    expect(isOriginDomainId("f402")).toBe(false);
    expect(isWriterLaneId("cslevel2")).toBe(true);
    expect(isWriterLaneId("alert")).toBe(false);
    expect(isSentinelChannelId("alert")).toBe(true);
  });

  test("venueEntry is total for every declared VenueId", () => {
    for (const id of Object.keys(VENUE_REGISTRY) as VenueId[]) {
      expect(venueEntry(id).venueId).toBe(id);
    }
  });
});
