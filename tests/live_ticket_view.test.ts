import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  findDupePairs,
  normalizeLeg,
  normalizeTicket,
  splitPickPrice,
} from "../lib/live_ticket_view.ts";
import { readWagerList, readWagerListArtifact } from "../lib/live_wagers.ts";

const FIXTURE = join(import.meta.dir, "fixtures/live-wagers-list-sample.json");
const payload = (await Bun.file(FIXTURE).json()) as { LIST: unknown[] };
const row = payload.LIST[0] as Record<string, unknown>;

describe("live_ticket_view", () => {
  test("normalizes a raw LIST row to the public shape", () => {
    expect(normalizeTicket(row, { file: FIXTURE })).toEqual({
      wagerNumber: "767125863",
      product: "GSLIVE",
      wagerType: "P",
      wagerTypeLabel: "Parlay",
      phase: "pregame",
      live: false,
      vip: false,
      stake: 1000,
      toWin: 1395,
      volume: null,
      insertedAt: "2026-11-01T23:15:02.770Z",
      descCode: "P.G319747616",
      writer: null,
      ticketWriter: "GSLIVE",
      legs: [
        {
          index: 1,
          sport: "Football",
          eventName: "Los Angeles Rams vs Los Angeles Chargers",
          period: "Game",
          market: "Winner (2 way)",
          selection: "Los Angeles Rams",
          price: "-140",
          live: false,
          gameNumber: "319747616",
        },
        {
          index: 2,
          sport: "Football",
          eventName: "Miami Dolphins vs New England Patriots",
          period: "Game",
          market: "Winner (2 way)",
          selection: "New England Patriots",
          price: "-252",
          live: false,
          gameNumber: "319747616",
        },
      ],
      source: "GSLIVE",
      provenance: {
        file: FIXTURE,
        capturedAt: null,
        source: "unlabelled",
      },
    });
  });

  test("accepts an already-parsed wager and keeps artifact metadata", () => {
    const artifact = readWagerListArtifact({
      ...payload,
      source: "capture:test",
      observedAt: "2026-11-04T00:00:00.000Z",
    });
    const parsed = artifact.wagers[0]!;
    const view = normalizeTicket(parsed, {
      file: FIXTURE,
      source: artifact.provenance.source,
      capturedAt: artifact.provenance.observedAt,
    });
    expect(view).toEqual(
      normalizeTicket(row, {
        file: FIXTURE,
        source: "capture:test",
        capturedAt: "2026-11-04T00:00:00.000Z",
      }),
    );
    expect(view.provenance.source).toBe("capture:test");
    expect(view.provenance.capturedAt).toBe("2026-11-04T00:00:00.000Z");
  });

  test("volume is an override, not a duplicate of stake", () => {
    const internet = readWagerList(payload).find(
      (wager) => wager.wagerNumber === 767126231,
    );
    expect(internet?.volumeDiffers).toBe(true);
    const view = normalizeTicket(internet!);
    expect(view.stake).toBe(3500);
    expect(view.volume).toBe(2188);
    expect(view.product).toBe("INTERNET");
  });

  test("wire labels come from the client getTypeInfo map", () => {
    const wagers = readWagerList(payload);
    const moneyline = wagers.find((wager) => wager.wagerNumber === 767126203)!;
    const spread = wagers.find((wager) => wager.wagerNumber === 767126231)!;
    expect(normalizeTicket(moneyline).wagerTypeLabel).toBe("Moneyline");
    expect(normalizeTicket(spread).wagerTypeLabel).toBe("Spread");
  });

  test("periods use the canonical typePeriod code", () => {
    expect(
      normalizeLeg(
        {
          sport: "Football",
          game: "A vs B",
          period: "1st Half",
          market: "Winner (2 way)",
          pick: "A -110",
          raw: "Football - A vs B / 1st Half / Winner (2 way) / A -110",
          compact: false,
          live: false,
          gameNumber: null,
        },
        1,
      ).period,
    ).toBe("1H");
  });

  test("the public view carries no customer, agent or login identifiers", () => {
    const text = JSON.stringify(normalizeTicket(row));
    for (const identifier of [
      "WC9001",
      "ADAM",
      "MARWES50",
      "JP1833",
      "YAS107",
    ]) {
      expect(text).not.toContain(identifier);
    }
  });

  test("splitPickPrice peels only a trailing American price", () => {
    expect(splitPickPrice("Los Angeles Rams -140")).toEqual({
      selection: "Los Angeles Rams",
      price: "-140",
    });
    expect(splitPickPrice("Over 46.5 -108")).toEqual({
      selection: "Over 46.5",
      price: "-108",
    });
    expect(splitPickPrice("Eagles -2 -110")).toEqual({
      selection: "Eagles -2",
      price: "-110",
    });
    expect(splitPickPrice("New England Patriots +145")).toEqual({
      selection: "New England Patriots",
      price: "+145",
    });
    expect(splitPickPrice("No price")).toEqual({
      selection: "No price",
      price: null,
    });
    expect(splitPickPrice("-140")).toEqual({
      selection: "-140",
      price: null,
    });
    expect(splitPickPrice("")).toEqual({ selection: "", price: null });
  });

  test("duplicate grouping skips ALERT mirrors and BLOCKED sentinels", () => {
    const rawRow = (
      wagerNumber: number,
      writer: string,
      type: string,
    ): Record<string, unknown> => ({
      WagerNumber: wagerNumber,
      WagerType: type,
      AmountWagered: 100,
      ToWinAmount: 90,
      VolumeAmount: 100,
      TicketWriter: writer,
      InsertDateTime: "2026-11-04 12:00:00.000",
      ShortDesc:
        "S.G999999777\r\nFootball - Gamma vs Delta / Game / Winner (2 way) / Gamma -110&#x0D;\n",
      VIP: "0",
    });
    const tickets = [
      normalizeTicket(rawRow(1, "GSLIVE", "P")),
      normalizeTicket(rawRow(2, "ALERT", "M")),
      normalizeTicket(rawRow(3, "BLOCKED", "S")),
    ];
    expect(findDupePairs(tickets)).toEqual([]);

    const withRealTwin = findDupePairs([
      ...tickets,
      normalizeTicket(rawRow(4, "GSLIVE", "M")),
    ]);
    expect(withRealTwin).toHaveLength(1);
    expect(withRealTwin[0]?.wagerNumbers).toEqual(["1", "4"]);
  });

  test("identical selections at different games are not duplicates", () => {
    const rows = [
      {
        wagerNumber: "1",
        wagerType: "S",
        source: "GSLIVE",
        descCode: "G320210254",
        legs: [{ selection: "Utah Jazz", price: "+181" }],
      },
      {
        wagerNumber: "2",
        wagerType: "S",
        source: "GSLIVE",
        descCode: "G320210390",
        legs: [{ selection: "Utah Jazz", price: "+181" }],
      },
    ];
    expect(findDupePairs(rows)).toEqual([]);
  });
});
