import { describe, expect, test } from "bun:test";
import {
  GradedWagerRowError,
  parseGradedWagerRow,
  parseGradedWagerRows,
  parseGradedWagerRowsSoA,
  countLive,
  isLive,
  averageRisk,
  marketsMatching,
  type GradedWagerRow,
  type GradedWagerRowsSoA,
} from "../lib/f402_graded_wager_row.ts";
import { findScore, readScoreboardFile } from "../lib/scoreboard.ts";

const FIXTURE_URL = new URL(
  "./fixtures/f402-graded-wager-row-1073373500.html",
  import.meta.url,
);
const MULTI_URL = new URL(
  "./fixtures/f402-graded-wager-rows.html",
  import.meta.url,
);
const fixtureHtml = await Bun.file(FIXTURE_URL).text();
const multiHtml = await Bun.file(MULTI_URL).text();

const EXPECTED: GradedWagerRow = {
  ticketNumber: "1073373500",
  wagerNumber: "1073373500-1",
  wagerType: "S",
  selection: "Lions (Live)",
  selectedTeam: "Lions",
  team1: "Vikings",
  team2: "Lions",
  line: "-2½",
  price: "-130",
  riskCents: 2600000,
  winCents: 2000000,
  status: "Win",
  score: "Vikings (Live) 15 - Lions (Live) 19",
  game: "Vikings (Live) / Lions (Live)",
  league: "NFL",
  live: true,
  gameNumber: "9240",
  market: "Game Spread",
  scheduled: "Nov 1, 2026 10:00 PM - (CST)",
  accepted: "Nov 1, 2026 2:30 PM - (CST)",
  placedOn: "Internet",
  gradedAmount: "+$20,000",
};

/** `-2½` -> `-2.5`; plain signed decimals pass through. */
function lineValue(line: string): number {
  const sign = line.startsWith("-") ? -1 : 1;
  const body = line.replace(/^[-+]/, "");
  if (body.endsWith("½")) return sign * (Number(body.slice(0, -1)) + 0.5);
  return sign * Number(body);
}

describe("parseGradedWagerRow", () => {
  test("parses every field of the graded wager row", () => {
    expect(parseGradedWagerRow(fixtureHtml)).toEqual(EXPECTED);
  });

  test("decodes entities and collapses whitespace in line and price", () => {
    const row = parseGradedWagerRow(fixtureHtml);
    expect(row.line).toBe("-2½");
    expect(row.price).toBe("-130");
    expect(row.line).not.toContain("&nbsp;");
    expect(row.price).not.toContain("&nbsp;");
    expect(row.line).not.toContain(" ");
    expect(row.price).not.toContain(" ");
  });

  test("risk and win are consistent at -130", () => {
    const row = parseGradedWagerRow(fixtureHtml);
    expect(row.winCents).toBe(Math.round((row.riskCents * 100) / 130));
    expect(Number.isInteger(row.riskCents)).toBe(true);
    expect(Number.isInteger(row.winCents)).toBe(true);
  });

  test("joins the parsed row to data/scoreboard.json", async () => {
    const payload = await Bun.file(
      new URL("../data/scoreboard.json", import.meta.url),
    ).json();
    const scoreboard = readScoreboardFile(payload);
    expect(scoreboard).not.toBeNull();
    if (scoreboard === null) return;

    const row = parseGradedWagerRow(fixtureHtml);
    const joined = findScore(scoreboard, {
      team1: row.team1 ?? "",
      team2: row.team2 ?? "",
      league: row.league ?? "",
    });
    expect(joined).not.toBeNull();
    if (joined === null) return;
    expect(joined.status).toBe("final");
    const vikings = joined.team1Score;
    const lions = joined.team2Score;
    expect(vikings).toBe(15);
    expect(lions).toBe(19);
    expect(row.selectedTeam).toBe("Lions");
    if (vikings !== null && lions !== null) {
      expect(lions - vikings).toBeGreaterThan(2.5);
    }
  });

  test("parses a Loss row's L status and negative graded amount", () => {
    const lossHtml = fixtureHtml
      .replace('class="wager-status-W"', 'class="wager-status-L"')
      .replace(">+$20,000<", ">-$26,000<")
      .replace(/Win(\s*\()/, "Loss$1");
    const row = parseGradedWagerRow(lossHtml);
    expect(row.status).toBe("Loss");
    expect(row.gradedAmount).toBe("-$26,000");
    expect(row.riskCents).toBe(2600000);
  });

  test("the scored result covers the line", () => {
    const row = parseGradedWagerRow(fixtureHtml);
    const match = /Vikings \(Live\) (\d+) - Lions \(Live\) (\d+)/.exec(
      row.score ?? "",
    );
    const vikings = Number(match?.[1]);
    const lions = Number(match?.[2]);
    const margin = lions - vikings;
    const line = lineValue(row.line ?? "");

    expect(vikings).toBe(15);
    expect(lions).toBe(19);
    expect(margin).toBe(4);
    expect(line).toBe(-2.5);
    expect(margin).toBeGreaterThan(Math.abs(line));
    expect(row.status).toBe("Win");
  });

  test("a row without data-ticket throws GradedWagerRowError", () => {
    const html = fixtureHtml.replace(' data-ticket="1073373500"', "");
    expect(() => parseGradedWagerRow(html)).toThrow(GradedWagerRowError);
  });

  test("a row without the Status field throws GradedWagerRowError", () => {
    const html = fixtureHtml.replace(
      /<div class="ln">\s*<div class="d-l">Status<\/div>\s*<div class="d-r">[^<]*<\/div>\s*<\/div>/,
      "",
    );
    expect(html).not.toBe(fixtureHtml);
    expect(() => parseGradedWagerRow(html)).toThrow(GradedWagerRowError);
  });

  test("malformed Risk/Win throws without echoing raw amounts", () => {
    const html = fixtureHtml.replace(
      "$ 26,000.00 / $ 20,000.00",
      "$ 26,000.00",
    );
    let error: unknown;
    try {
      parseGradedWagerRow(html);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GradedWagerRowError);
    expect(error instanceof Error ? error.message : "").toContain("riskCents");
    expect(error instanceof Error ? error.message : "").not.toContain("26,000");
  });

  test("more than one row throws GradedWagerRowError", () => {
    const row = /<tr data-ticket[\s\S]*?<\/tr>/.exec(fixtureHtml)?.[0];
    expect(row).toBeDefined();
    const html = fixtureHtml.replace(row ?? "", `${row ?? ""}${row ?? ""}`);
    expect(() => parseGradedWagerRow(html)).toThrow(GradedWagerRowError);
  });

  test("irrelevant whitespace does not change the result", () => {
    const noisy = fixtureHtml
      .replace(/>\s*</g, ">\n\n      <")
      .replace(/NFL Live\s+-/, "NFL   Live\t-")
      .replace(/Win\s+\(/, "Win\n   (");
    expect(noisy).not.toBe(fixtureHtml);
    expect(parseGradedWagerRow(noisy)).toEqual(EXPECTED);
  });
});

describe("parseGradedWagerRows", () => {
  const rows = parseGradedWagerRows(multiHtml);

  test("parses all three rows in document order", () => {
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.ticketNumber)).toEqual([
      "1073373500",
      "1073373501",
      "1073373502",
    ]);
    expect(rows.map((row) => row.wagerNumber)).toEqual([
      "1073373500-1",
      "1073373501-1",
      "1073373502-1",
    ]);
    expect(rows.map((row) => row.wagerType)).toEqual(["S", "M", "T"]);
    expect(rows.map((row) => row.status)).toEqual(["Win", "Loss", "Canceled"]);
  });

  test("row 1 Win: Lions -2½ -130, risk 26000¢ win 20000¢", () => {
    const row = rows[0]!;
    expect(row.selection).toBe("Lions (Live)");
    expect(row.selectedTeam).toBe("Lions");
    expect(row.team1).toBe("Vikings");
    expect(row.team2).toBe("Lions");
    expect(row.line).toBe("-2½");
    expect(row.price).toBe("-130");
    expect(row.riskCents).toBe(2600000);
    expect(row.winCents).toBe(2000000);
    expect(row.status).toBe("Win");
    expect(row.score).toBe("Vikings (Live) 15 - Lions (Live) 19");
    expect(row.game).toBe("Vikings (Live) / Lions (Live)");
    expect(row.league).toBe("NFL");
    expect(row.live).toBe(true);
    expect(row.gameNumber).toBe("9240");
    expect(row.market).toBe("Game Spread");
    expect(row.gradedAmount).toBe("+$20,000");
  });

  test("row 2 Loss: Patriots -7 -110, risk 11000¢ win 10000¢", () => {
    const row = rows[1]!;
    expect(row.selection).toBe("Patriots (Live)");
    expect(row.selectedTeam).toBe("Patriots");
    expect(row.team1).toBe("Patriots");
    expect(row.team2).toBe("Bills");
    expect(row.line).toBe("-7");
    expect(row.price).toBe("-110");
    expect(row.riskCents).toBe(1100000);
    expect(row.winCents).toBe(1000000);
    expect(row.status).toBe("Loss");
    expect(row.score).toBe("Patriots (Live) 20 - Bills (Live) 24");
    expect(row.league).toBe("NFL");
    expect(row.live).toBe(true);
    expect(row.gameNumber).toBe("9241");
    expect(row.market).toBe("Game Moneyline");
    expect(row.gradedAmount).toBe("-$11,000");
  });

  test("row 3 Canceled: Chiefs total O 48½ -105, risk 5000¢ win 47619¢", () => {
    const row = rows[2]!;
    expect(row.selection).toBe("Chiefs (Live)");
    expect(row.selectedTeam).toBe("Chiefs");
    expect(row.team1).toBe("Chiefs");
    expect(row.team2).toBe("Raiders");
    expect(row.line).toBe("O 48½");
    expect(row.price).toBe("-105");
    expect(row.riskCents).toBe(500000);
    expect(row.winCents).toBe(476190);
    expect(row.status).toBe("Canceled");
    expect(row.score).toBe("Chiefs (Live) - Raiders (Live)");
    expect(row.league).toBe("NFL");
    expect(row.live).toBe(true);
    expect(row.gameNumber).toBe("9242");
    expect(row.market).toBe("Game Total");
    expect(row.gradedAmount).toBe("$0.00");
  });

  test("joins every parsed row to data/scoreboard.json", async () => {
    const payload = await Bun.file(
      new URL("../data/scoreboard.json", import.meta.url),
    ).json();
    const scoreboard = readScoreboardFile(payload);
    expect(scoreboard).not.toBeNull();
    if (scoreboard === null) return;

    const expected: Array<{
      team1Score: number | null;
      team2Score: number | null;
    }> = [
      { team1Score: 15, team2Score: 19 }, // Vikings 15 - Lions 19
      { team1Score: null, team2Score: null }, // Patriots - Bills: not on board
      { team1Score: null, team2Score: null }, // Chiefs - Raiders: not on board
    ];

    for (const [index, row] of rows.entries()) {
      const joined = findScore(scoreboard, {
        team1: row.team1 ?? "",
        team2: row.team2 ?? "",
        league: row.league ?? "",
      });
      const exp = expected[index]!;
      if (exp.team1Score === null) {
        expect(joined).toBeNull();
      } else {
        expect(joined).not.toBeNull();
        if (joined === null) continue;
        expect(joined.status).toBe("final");
        expect(joined.team1Score).toBe(exp.team1Score);
        expect(joined.team2Score).toBe(exp.team2Score);
      }
    }
  });

  test("empty HTML throws GradedWagerRowError", () => {
    expect(() => parseGradedWagerRows("")).toThrow(GradedWagerRowError);
    expect(() => parseGradedWagerRows("<table></table>")).toThrow(
      GradedWagerRowError,
    );
  });

  test("no rows throws GradedWagerRowError", () => {
    expect(() =>
      parseGradedWagerRows("<tr><td>no data-ticket</td></tr>"),
    ).toThrow(GradedWagerRowError);
  });

  test("a malformed row inside a multi-row page throws for that row", () => {
    const bad = multiHtml.replace("$ 26,000.00 / $ 20,000.00", "$ 26,000.00");
    expect(() => parseGradedWagerRows(bad)).toThrow(GradedWagerRowError);
  });

  // ---- countLive / averageRisk / marketsMatching lockstep tests ----

  test("countLive counts only true, ignores false and null", () => {
    const soa: GradedWagerRowsSoA = {
      ticketNumbers: ["t1", "t2", "t3"],
      wagerNumbers: ["n1", "n2", "n3"],
      wagerTypes: ["S", "S", "S"],
      selections: ["Lions", "Patriots", "Chiefs"],
      selectedTeams: ["Lions", "Patriots", "Chiefs"],
      team1s: ["Vikings", "Bills", "Chiefs"],
      team2s: ["Lions", "Bills", "Raiders"],
      lines: ["-2½", "-7", "O 48½"],
      prices: ["-130", "-110", "-105"],
      riskCents: [2600000, null, 1000000],
      winCents: [2000000, 1000000, 500000],
      statuses: ["Win", "Loss", "Win"],
      scores: [
        "Vikings 15 - Lions 19",
        "Patriots 20 - Bills 24",
        "Chiefs - Raiders",
      ],
      games: ["Vikings / Lions", "Patriots / Bills", "Chiefs / Raiders"],
      leagues: ["NFL", "NFL", "NFL"],
      lives: 0b101n,
      gameNumbers: ["9240", "9241", "9242"],
      markets: ["Game Spread", "Game Moneyline", "Game Total"],
      scheduleds: ["Nov 1, 2026 10:00 PM", "Nov 2, 1:00 PM", "Nov 3, 4:25 PM"],
      accepteds: ["Nov 1, 2:30 PM", "Nov 2, 12:45 PM", "Nov 3, 4:00 PM"],
      placedOns: ["Internet", "Mobile", "Desktop"],
      gradedAmounts: ["+$20,000", "-$11,000", "+$5,000"],
    };
    expect(countLive(soa)).toBe(2); // only t1 and t3 are live
  });

  test("averageRisk filters nulls, does not dilute with zero", () => {
    const soa: GradedWagerRowsSoA = {
      ticketNumbers: ["t1", "t2", "t3"],
      wagerNumbers: ["n1", "n2", "n3"],
      wagerTypes: ["S", "S", "S"],
      selections: ["Lions", "Patriots", "Chiefs"],
      selectedTeams: ["Lions", "Patriots", "Chiefs"],
      team1s: ["Vikings", "Bills", "Chiefs"],
      team2s: ["Lions", "Bills", "Raiders"],
      lines: ["-2½", "-7", "O 48½"],
      prices: ["-130", "-110", "-105"],
      riskCents: [1000, null, 2000],
      winCents: [500, 500, 500],
      statuses: ["Win", "Loss", "Win"],
      scores: [
        "Vikings 15 - Lions 19",
        "Patriots 20 - Bills 24",
        "Chiefs - Raiders",
      ],
      games: ["Vikings / Lions", "Patriots / Bills", "Chiefs / Raiders"],
      leagues: ["NFL", "NFL", "NFL"],
      lives: 0b101n,
      gameNumbers: ["9240", "9241", "9242"],
      markets: ["Game Spread", "Game Moneyline", "Game Total"],
      scheduleds: ["Nov 1, 2026 10:00 PM", "Nov 2, 1:00 PM", "Nov 3, 4:25 PM"],
      accepteds: ["Nov 1, 2:30 PM", "Nov 2, 12:45 PM", "Nov 3, 4:00 PM"],
      placedOns: ["Internet", "Mobile", "Desktop"],
      gradedAmounts: ["+$20,000", "-$11,000", "+$5,000"],
    };
    expect(averageRisk(soa)).toBe(1500); // (1000 + 2000) / 2, not (1000 + 0 + 2000) / 3
  });

  test("marketsMatching case-insensitive hit; null market skipped; non-match excluded", () => {
    const soa: GradedWagerRowsSoA = {
      ticketNumbers: ["t1", "t2", "t3", "t4"],
      wagerNumbers: ["n1", "n2", "n3", "n4"],
      wagerTypes: ["S", "S", "S", "S"],
      selections: ["Lions", "Patriots", "Chiefs", "Raiders"],
      selectedTeams: ["Lions", "Patriots", "Chiefs", "Raiders"],
      team1s: ["Vikings", "Bills", "Chiefs", "Raiders"],
      team2s: ["Lions", "Bills", "Raiders", "Chiefs"],
      lines: ["-2½", "-7", "O 48½", "-3"],
      prices: ["-130", "-110", "-105", "-200"],
      riskCents: [2600000, 1100000, 500000, 800000],
      winCents: [2000000, 1000000, 500000, 400000],
      statuses: ["Win", "Loss", "Win", "Loss"],
      scores: [
        "Vikings 15 - Lions 19",
        "Patriots 20 - Bills 24",
        "Chiefs - Raiders",
        "Raiders 10 - Chiefs 5",
      ],
      games: [
        "Vikings / Lions",
        "Patriots / Bills",
        "Chiefs / Raiders",
        "Raiders / Chiefs",
      ],
      leagues: ["NFL", "NFL", "NFL", "NFL"],
      lives: 0b0101n,
      gameNumbers: ["9240", "9241", "9242", "9243"],
      markets: ["Game Spread", null, "Game Total", "Game Moneyline"],
      scheduleds: [
        "Nov 1, 2026 10:00 PM",
        "Nov 2, 1:00 PM",
        "Nov 3, 4:25 PM",
        "Nov 4, 1:00 PM",
      ],
      accepteds: [
        "Nov 1, 2:30 PM",
        "Nov 2, 12:45 PM",
        "Nov 3, 4:00 PM",
        "Nov 4, 12:30 PM",
      ],
      placedOns: ["Internet", "Mobile", "Desktop", "Console"],
      gradedAmounts: ["+$20,000", "-$11,000", "+$5,000", "-$2,000"],
    };
    // case-insensitive match
    expect(marketsMatching(soa, "spread")).toEqual(["Game Spread"]);
    // null market skipped, doesn't throw
    expect(marketsMatching(soa, "total")).toEqual(["Game Total"]);
    // non-match excluded
    expect(marketsMatching(soa, "parlay")).toEqual([]);
  });

  test("lockstep: all 22 arrays equal length on the 3-row fixture", async () => {
    const html = await Bun.file(
      new URL("./fixtures/f402-graded-wager-rows.html", import.meta.url),
    ).text();
    const soa = parseGradedWagerRowsSoA(html);
    const lengths = [
      soa.ticketNumbers.length,
      soa.wagerNumbers.length,
      soa.wagerTypes.length,
      soa.selections.length,
      soa.selectedTeams.length,
      soa.team1s.length,
      soa.team2s.length,
      soa.lines.length,
      soa.prices.length,
      soa.riskCents.length,
      soa.winCents.length,
      soa.statuses.length,
      soa.scores.length,
      soa.games.length,
      soa.leagues.length,
      soa.gameNumbers.length,
      soa.markets.length,
      soa.scheduleds.length,
      soa.accepteds.length,
      soa.placedOns.length,
      soa.gradedAmounts.length,
    ];
    const allEqual = lengths.every((l) => l === lengths[0]);
    expect(allEqual).toBe(true);
    // 3 rows from the fixture
    expect(lengths[0]).toBe(3);
  });

  test("all-null row: structural invariant with 3-row fixture", async () => {
    const html = await Bun.file(
      new URL("./fixtures/f402-graded-wager-rows.html", import.meta.url),
    ).text();
    const soa = parseGradedWagerRowsSoA(html);
    const lengths = [
      soa.ticketNumbers.length,
      soa.wagerNumbers.length,
      soa.wagerTypes.length,
      soa.selections.length,
      soa.selectedTeams.length,
      soa.team1s.length,
      soa.team2s.length,
      soa.lines.length,
      soa.prices.length,
      soa.riskCents.length,
      soa.winCents.length,
      soa.statuses.length,
      soa.scores.length,
      soa.games.length,
      soa.leagues.length,
      soa.gameNumbers.length,
      soa.markets.length,
      soa.scheduleds.length,
      soa.accepteds.length,
      soa.placedOns.length,
      soa.gradedAmounts.length,
    ];
    const allEqual = lengths.every((l) => l === lengths[0]);
    expect(allEqual).toBe(true);
    expect(lengths[0]).toBe(3);
  });
});

describe("parseGradedWagerRow E-type college team total", () => {
  test("parses the 1st-half team-total row from the Oct 31 graded panel", async () => {
    const html = await Bun.file(
      new URL(
        "./fixtures/f402-graded-wager-row-e-1072619695.html",
        import.meta.url,
      ),
    ).text();
    const row = parseGradedWagerRow(html);
    expect(row.ticketNumber).toBe("1072619695");
    expect(row.wagerNumber).toBe("1072619695-1");
    expect(row.wagerType).toBe("E");
    expect(row.selection).toBe("Colorado St");
    expect(row.team1).toBe("Colorado St");
    expect(row.team2).toBe("Utah St");
    expect(row.line).toBe("U 13½");
    expect(row.price).toBe("+100");
    expect(row.riskCents).toBe(200000);
    expect(row.winCents).toBe(200000);
    expect(row.status).toBe("Win");
    expect(row.score).toBe("Colorado St 0 - Utah St 17");
    expect(row.league).toBe("College");
    expect(row.live).toBe(false);
    expect(row.gameNumber).toBe("205");
    expect(row.market).toBe("1st Half Team Total");
    expect(row.placedOn).toBe("Internet");
    expect(row.gradedAmount).toBe("+$2,000");
  });
});

describe("parseGradedWagerRows G-type game combos", () => {
  test("Won and Lost G rows parse with nulls where the panel prints placeholders", async () => {
    const html = await Bun.file(
      new URL("./fixtures/f402-graded-wager-rows-g.html", import.meta.url),
    ).text();
    const rows = parseGradedWagerRows(html);
    expect(rows).toHaveLength(2);

    const won = rows[0]!;
    expect(won.ticketNumber).toBe("1074338151");
    expect(won.wagerNumber).toBe("1074338151-1");
    expect(won.wagerType).toBe("G");
    expect(won.status).toBe("Won");
    expect(won.score).toBeNull();
    expect(won.line).toBeNull();
    expect(won.price).toBeNull();
    expect(won.team1).toBeNull();
    expect(won.team2).toBeNull();
    expect(won.league).toBeNull();
    expect(won.market).toBeNull();
    expect(won.live).toBe(false);
    expect(won.gameNumber).toBe("319977747");
    expect(won.riskCents).toBe(17500);
    expect(won.winCents).toBe(66325);
    expect(won.scheduled).toBeNull();
    expect(won.accepted).toBe("Nov 2, 2026 11:17 PM - (CST)");
    expect(won.gradedAmount).toBe("+$663");

    const lost = rows[1]!;
    expect(lost.ticketNumber).toBe("1074340989");
    expect(lost.status).toBe("Lost");
    expect(lost.score).toBeNull();
    expect(lost.gameNumber).toBe("319979060");
    expect(lost.riskCents).toBe(8700);
    expect(lost.winCents).toBe(14007);
    expect(lost.gradedAmount).toBe("-$87");
  });

  test("G rows stay lockstep in the SoA shape", async () => {
    const html = await Bun.file(
      new URL("./fixtures/f402-graded-wager-rows-g.html", import.meta.url),
    ).text();
    const soa = parseGradedWagerRowsSoA(html);
    expect(soa.gameNumbers).toEqual(["319977747", "319979060"]);
    expect(soa.markets).toEqual([null, null]);
    expect(soa.scores).toEqual([null, null]);
    expect(soa.statuses).toEqual(["Won", "Lost"]);
  });
});

describe("graded wager bitset property", () => {
  test("countLive and isLive agree with a random bitset across 1000 cases", () => {
    for (let t = 0; t < 1000; t++) {
      const n = 1 + Math.floor(Math.random() * 64);
      let bits = 0n;
      const expected: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const live = Math.random() < 0.5;
        expected.push(live);
        if (live) bits |= 1n << BigInt(i);
      }
      const soa = { lives: bits } as unknown as GradedWagerRowsSoA;
      let pop = 0;
      for (const b of expected) if (b) pop++;
      expect(countLive(soa)).toBe(pop);
      for (let i = 0; i < n; i++) {
        expect(isLive(soa, i)).toBe(expected[i]!);
      }
    }
  });
});
