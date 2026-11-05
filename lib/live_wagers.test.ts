import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  betTickerFile,
  isTickerNoise,
  parseBetTickerXml,
  parseShortDesc,
  readWagerList,
  readWagerListArtifact,
  summarizeLiveWagers,
  toLiveWager,
  writerOf,
  type LiveWager,
} from "./live_wagers.ts";

const payload = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../tests/fixtures/live-wagers-list-sample.json"),
    "utf8",
  ),
);

const wagers = readWagerList(payload);

describe("readWagerList", () => {
  test("accepts the {LIST: [...]} envelope", () => {
    expect(wagers).toHaveLength(7);
  });

  test("accepts a bare array and skips rows without a WagerNumber", () => {
    const list = (payload as { LIST: unknown[] }).LIST;
    expect(readWagerList(list)).toHaveLength(7);
    expect(readWagerList([{ AgentID: "X" }, ...list.slice(0, 1)])).toHaveLength(
      1,
    );
  });

  test("accepts a one-item LIST object from the compact XML shape", () => {
    const first = (payload as { LIST: unknown[] }).LIST[0];
    expect(readWagerList({ LIST: first })).toHaveLength(1);
    expect(
      betTickerFile({ LIST: first }, "2026-11-05T00:00:00.000Z").LIST,
    ).toEqual([first]);

    // End to end: compact XML collapses <LIST> to an object when it has one child.
    const doc = parseBetTickerXml(
      "<LIST><WagerNumber>99001</WagerNumber><ShortDesc>S.Basketball #1 Team -2 -110 - For Game</ShortDesc><AmountWagered>100</AmountWagered><ToWinAmount>90</ToWinAmount></LIST>",
    ) as { LIST: Record<string, unknown> };
    const file = betTickerFile(doc, "2026-11-05T00:00:00.000Z");
    expect(file.LIST).toHaveLength(1);
    expect(readWagerList(file)).toHaveLength(1);
  });

  test("accepts an empty LIST but still rejects a missing or non-list value", () => {
    expect(readWagerList({ LIST: [] })).toEqual([]);
    expect(readWagerList({ LIST: "" })).toEqual([]);
    expect(
      betTickerFile({ LIST: [] }, "2026-11-05T00:00:00.000Z").LIST,
    ).toEqual([]);
    expect(
      betTickerFile({ LIST: "" }, "2026-11-05T00:00:00.000Z").LIST,
    ).toEqual([]);
    expect(() => betTickerFile({}, "2026-11-05T00:00:00.000Z")).toThrow(
      /no LIST/,
    );
    expect(() =>
      betTickerFile({ LIST: "login" }, "2026-11-05T00:00:00.000Z"),
    ).toThrow(/no LIST/);
  });

  test("returns nothing for unrelated payloads", () => {
    expect(readWagerList(null)).toEqual([]);
    expect(readWagerList({ ok: true })).toEqual([]);
  });

  test("trims padded identifiers", () => {
    const first = wagers[0] as LiveWager;
    expect(first.customerId).toBe("WC9001.");
    expect(first.agentLogin).toBe("ADAM");
    expect(first.login).toBe("WC9001");
  });

  test("keeps WagerType raw instead of renaming an unknown code", () => {
    // "M" has no documented meaning in this repository; inventing a name would be a guess.
    const moneylineish = wagers.filter((wager) => wager.wagerType === "M");
    expect(moneylineish.length).toBeGreaterThan(0);
    expect(new Set(wagers.map((wager) => wager.wagerType))).toEqual(
      new Set(["P", "M", "S"]),
    );
  });
});

describe("writerOf", () => {
  test("classifies the four observed channels", () => {
    expect(writerOf("GSLIVE                                            ")).toBe(
      "gslive",
    );
    expect(writerOf("GSBUILDER                                         ")).toBe(
      "gsbuilder",
    );
    expect(writerOf("Internet                                          ")).toBe(
      "internet",
    );
    expect(writerOf("ALERT                                             ")).toBe(
      "alert",
    );
  });

  test("BLOCKED sentinels are their own writer, and noise with ALERT", () => {
    expect(writerOf("BLOCKED   ")).toBe("blocked");
    expect(isTickerNoise({ writer: "blocked" })).toBe(true);
    expect(isTickerNoise({ writer: "alert" })).toBe(true);
    expect(isTickerNoise({ writer: "internet" })).toBe(false);
    expect(isTickerNoise({ writer: "other" })).toBe(false);
  });

  test("anything else is other, not a guess", () => {
    expect(writerOf("")).toBe("other");
    expect(writerOf("KIOSK")).toBe("other");
  });
});

describe("parseShortDesc", () => {
  test("splits a parlay into one leg per selection", () => {
    const { legs, descCode } = parseShortDesc(
      "P.G319747616\r\nFootball - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Los Angeles Rams -140&#x0D;\nFootball - Miami Dolphins vs New England Patriots / Game / Winner (2 way) / New England Patriots -252&#x0D;\n",
    );
    expect(descCode).toBe("P.G319747616");
    expect(legs).toHaveLength(2);
    expect(legs[0]).toEqual({
      sport: "Football",
      game: "Los Angeles Rams vs Los Angeles Chargers",
      period: "Game",
      market: "Winner (2 way)",
      pick: "Los Angeles Rams -140",
      raw: "Football - Los Angeles Rams vs Los Angeles Chargers / Game / Winner (2 way) / Los Angeles Rams -140",
      compact: false,
      live: false,
      gameNumber: "319747616",
    });
  });

  test("parses a straight bet with the code inline", () => {
    const { legs, descCode } = parseShortDesc(
      "S:Basketball #540 Warriors -2 -110 - For Game ",
    );
    expect(descCode).toBe("S");
    expect(legs).toHaveLength(1);
    // The alert line uses the compact grammar (`Sport #rot Team line - For Game`), not the
    // `/ Period / Market / Pick` one, so only sport and game survive the split.
    expect(legs[0]?.sport).toBe("Basketball");
    // The `#540` is a game number and `- For Game` a period tail, so both are now split out
    // instead of being left inside the pick.
    expect(legs[0]?.pick).toBe("Warriors -2 -110");
    expect(legs[0]?.period).toBe("Game");
    expect(legs[0]?.gameNumber).toBe("540");
    expect(legs[0]?.market).toBe("");
    expect(legs[0]?.compact).toBe(true);
    expect(legs[0]?.live).toBe(false);
  });

  test("handles an escaped newline form and &#x0D artefacts", () => {
    const { legs } = parseShortDesc(
      "M.G319749023\\r\\nTennis - Stiles Brockett vs Emile Hudd / Match / Winner (2 way) / Emile Hudd -236&#x0D;\\n",
    );
    expect(legs).toHaveLength(1);
    expect(legs[0]?.sport).toBe("Tennis");
    expect(legs[0]?.period).toBe("Match");
  });

  test("keeps a pick that itself contains slashes", () => {
    const { legs } = parseShortDesc(
      "M.G1\r\nFootball - A vs B / Game / Market / Over 11.5 / and more",
    );
    expect(legs[0]?.pick).toBe("Over 11.5 / and more");
  });

  test("empty description yields no legs", () => {
    expect(parseShortDesc("")).toEqual({
      legs: [],
      descCode: null,
      isLive: false,
    });
    expect(parseShortDesc(null)).toEqual({
      legs: [],
      descCode: null,
      isLive: false,
    });
  });
});

describe("volume vs amount", () => {
  test("flags the Internet bet where volume is below the stake", () => {
    const riverrat = wagers.find((wager) => wager.wagerNumber === 767126231);
    expect(riverrat?.amountWagered).toBe(3500);
    expect(riverrat?.volumeAmount).toBe(2188);
    expect(riverrat?.volumeDiffers).toBe(true);
  });

  test("flags the alert bet with zero volume", () => {
    const alert = wagers.find((wager) => wager.writer === "alert");
    expect(alert?.volumeAmount).toBe(0);
    expect(alert?.volumeDiffers).toBe(true);
  });

  test("equal amounts are not flagged", () => {
    const gslive = wagers.find((wager) => wager.wagerNumber === 767126203);
    expect(gslive?.volumeDiffers).toBe(false);
  });
});

describe("toLiveWager", () => {
  test("keeps amounts in integer dollars as the feed reports them", () => {
    const wager = toLiveWager(
      (payload as { LIST: Record<string, unknown>[] }).LIST[1]!,
    );
    expect(wager.amountWagered).toBe(21600);
    expect(wager.toWinAmount).toBe(20000);
  });

  test("VIP flag treats the padded '0' as false", () => {
    const wager = wagers[0] as LiveWager;
    expect(wager.vip).toBe(false);
    expect(toLiveWager({ WagerNumber: 1, VIP: "1" }).vip).toBe(true);
  });
});

describe("summarizeLiveWagers", () => {
  const summary = summarizeLiveWagers(wagers);

  // The fixture's one ALERT row is 767126258: 1430 risked, 1300 to win, volume 0, one
  // Basketball leg. It is a row but not a wager.
  test("totals the stakes, payouts and volume without the alert mirror", () => {
    expect(summary.count).toBe(7);
    expect(summary.counted).toBe(6);
    expect(summary.excluded).toEqual({ alert: 1, blocked: 0, risk: 1430 });
    expect(summary.risk).toBe(1000 + 21600 + 7277 + 3500 + 1600 + 3000);
    expect(summary.toWin).toBe(1395 + 20000 + 20001 + 5878 + 678 + 3542);
    expect(summary.volume).toBe(1000 + 21600 + 7277 + 2188 + 1600 + 3000);
  });

  test("counts every row by writer and type, but only wagers by leg sport", () => {
    expect(summary.byWriter).toEqual({
      gslive: 4,
      internet: 1,
      alert: 1,
      gsbuilder: 1,
    });
    expect(summary.byType).toEqual({ P: 3, M: 2, S: 2 });
    expect(summary.bySport).toEqual({
      Football: 7,
      Basketball: 3,
      Tennis: 1,
    });
  });

  test("counts legs across parlays", () => {
    // 2 + 1 + 3 + 1 + 1 + 3
    expect(summary.legs).toBe(11);
  });

  test("counts volume mismatches among wagers only", () => {
    expect(summary.volumeMismatches).toBe(1);
  });

  test("no VIP rows in this sample", () => {
    expect(summary.vip).toBe(0);
  });

  test("splits counted rows into live and pregame", () => {
    expect(summary.live).toBe(0);
    expect(summary.pregame).toBe(6);
    expect(summary.pregameRisk).toBe(summary.risk);
  });

  test("handles an empty list", () => {
    expect(summarizeLiveWagers([])).toEqual({
      count: 0,
      counted: 0,
      excluded: { alert: 0, blocked: 0, risk: 0 },
      risk: 0,
      toWin: 0,
      volume: 0,
      vip: 0,
      volumeMismatches: 0,
      byWriter: {},
      byType: {},
      bySport: {},
      legs: 0,
      live: 0,
      pregame: 0,
      liveRisk: 0,
      pregameRisk: 0,
    });
  });

  /**
   * The live/pregame split is the `LIVE` marker, not `WagerType`: the page carries `M.LIVE`,
   * `S:LIVE` and `L.LIVE` rows, so `M` and `S` are live too and `L` also labels ordinary soccer
   * and half markets.
   */
  test("counts live rows from the marker, not the type code", () => {
    const rows = [
      {
        WagerNumber: 1,
        WagerType: "M",
        AmountWagered: 100,
        ShortDesc: "M.LIVE #9263 Eagles (Live) -160 - For Game",
      },
      {
        WagerNumber: 2,
        WagerType: "S",
        AmountWagered: 200,
        ShortDesc: "S:LIVE #9540 Warriors (Live) -2½ -115 - For Game",
      },
      {
        WagerNumber: 3,
        WagerType: "L",
        AmountWagered: 300,
        ShortDesc:
          "L:LIVE #9263 Eagles (Live)/Commanders (Live) O 42½ -110 - For Game",
      },
      {
        WagerNumber: 4,
        WagerType: "L",
        AmountWagered: 400,
        ShortDesc: "L.Soccer #209857 Houston/Portland O 2½,3 -130 - For Game",
      },
      {
        WagerNumber: 5,
        WagerType: "M",
        AmountWagered: 500,
        ShortDesc:
          "M.G319807248\r\nBasketball - Lakers vs Raptors / Game / Winner / Lakers -246",
      },
    ].map((row) => toLiveWager(row));

    const summary = summarizeLiveWagers(rows);
    expect(summary.live).toBe(3);
    expect(summary.pregame).toBe(2);
    expect(summary.liveRisk).toBe(600);
    expect(summary.pregameRisk).toBe(900);
    // The `L` row without the marker is pregame, which is why the type cannot stand in for it.
    expect(rows[3]?.wagerType).toBe("L");
    expect(rows[3]?.live).toBe(false);
  });

  test("alert and blocked rows stay in the chips but out of every figure", () => {
    const rows = [
      {
        WagerNumber: 1,
        WagerType: "S",
        TicketWriter: "Internet  ",
        AmountWagered: 500,
        ToWinAmount: 450,
        VolumeAmount: 500,
        ShortDesc: "S:LIVE #9540 Warriors (Live) -2½ -115 - For Game",
      },
      {
        WagerNumber: 2,
        WagerType: "S",
        TicketWriter: "ALERT     ",
        AmountWagered: 500,
        ToWinAmount: 450,
        VolumeAmount: 0,
        ShortDesc: "S:LIVE #9540 Warriors (Live) -2½ -115 - For Game",
      },
      {
        WagerNumber: 3,
        WagerType: "P",
        TicketWriter: "BLOCKED   ",
        AmountWagered: 250,
        ToWinAmount: 900,
        VolumeAmount: 0,
        ShortDesc:
          "P.G1\r\nFootball - A vs B / Game / Spread / A -3\r\nTennis - C vs D / Match / Winner / C",
      },
    ].map((row) => toLiveWager(row));

    const summary = summarizeLiveWagers(rows);
    expect(summary.count).toBe(3);
    expect(summary.counted).toBe(1);
    expect(summary.excluded).toEqual({ alert: 1, blocked: 1, risk: 750 });
    expect(summary.byWriter).toEqual({ internet: 1, alert: 1, blocked: 1 });
    expect(summary.byType).toEqual({ S: 2, P: 1 });
    expect(summary.risk).toBe(500);
    expect(summary.toWin).toBe(450);
    expect(summary.volume).toBe(500);
    expect(summary.volumeMismatches).toBe(0);
    expect(summary.legs).toBe(1);
    expect(summary.bySport).toEqual({ unknown: 1 });
    expect(summary.live).toBe(1);
    expect(summary.liveRisk).toBe(500);
    expect(summary.pregame).toBe(0);
    expect(summary.pregameRisk).toBe(0);
  });
});

describe("readWagerListArtifact", () => {
  test("carries the file's own account of its completeness", () => {
    const artifact = readWagerListArtifact({
      schemaVersion: 1,
      source: "paste:clipboard-ticker",
      observedAt: null,
      partial: true,
      captureNote: "Salvaged from a partial paste.",
      LIST: [{ WagerNumber: 1, WagerType: "S", AmountWagered: 100 }],
    });

    expect(artifact.wagers).toHaveLength(1);
    expect(artifact.provenance).toEqual({
      source: "paste:clipboard-ticker",
      observedAt: null,
      captureNote: "Salvaged from a partial paste.",
      partial: true,
    });
  });

  test("an explicit partial flag beats inferring it from the note", () => {
    const artifact = readWagerListArtifact({
      source: "capture:/cloud/api/Report/getWagers@2026-11-01T18:00:00Z",
      observedAt: "2026-11-01T18:00:00Z",
      partial: false,
      captureNote:
        "Rows older than four weeks are pruned by the portal, not by us.",
      LIST: [],
    });

    expect(artifact.provenance.partial).toBe(false);
    expect(artifact.provenance.source).toStartWith("capture:");
  });

  test("a note without a flag marks the list partial", () => {
    // A file that needed a caveat is not a clean capture; the safe reading is the honest one.
    const artifact = readWagerListArtifact({
      captureNote: "partial paste",
      LIST: [],
    });

    expect(artifact.provenance.partial).toBe(true);
  });

  test("says unlabelled rather than inventing a source", () => {
    const artifact = readWagerListArtifact({ LIST: [] });

    expect(artifact.provenance).toEqual({
      source: "unlabelled",
      observedAt: null,
      captureNote: null,
      partial: false,
    });
  });

  test("readWagerList still returns bare rows for existing callers", () => {
    expect(readWagerList({ LIST: [{ WagerNumber: 7 }] })).toHaveLength(1);
    expect(
      readWagerListArtifact({ LIST: [{ WagerNumber: 7 }] }).wagers,
    ).toHaveLength(1);
  });
});

describe("betTickerFile", () => {
  const at = "2026-11-02T04:10:00.000Z";

  test("a getBetTicker body becomes a complete, labelled capture", () => {
    const file = betTickerFile(payload, at);
    const artifact = readWagerListArtifact(file);
    expect(artifact.wagers.length).toBe(readWagerList(payload).length);
    expect(artifact.provenance).toEqual({
      source: `capture:/cloud/api/Manager/getBetTicker@${at}`,
      observedAt: at,
      captureNote: null,
      partial: false,
    });
  });

  test("refuses a body with no LIST, so an error page never replaces a capture", () => {
    expect(() => betTickerFile({ status: "error" }, at)).toThrow("no LIST");
    expect(() => betTickerFile("<html>login</html>", at)).toThrow("no LIST");
  });
});
