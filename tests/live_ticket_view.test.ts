import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { normalizeTicket, splitPickPrice } from "../lib/live_ticket_view.ts";
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
      source: "unlabelled",
      provenance: { file: FIXTURE, capturedAt: null },
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
    expect(view.source).toBe("capture:test");
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
});
