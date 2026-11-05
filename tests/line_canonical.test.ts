import { describe, expect, test } from "bun:test";

import { nFormatter } from "../cli/format.ts";
import { checkDisplayLine, getLineGameFull, isDecimal } from "../cli/line.ts";

describe("canonical line formatting", () => {
  test("isDecimal renders PK and half-points", () => {
    expect(isDecimal(0)).toBe("PK");
    expect(isDecimal(0.5)).toBe("½");
    expect(isDecimal(-0.5)).toBe("-½");
    expect(isDecimal(4.5)).toBe("4½");
    expect(isDecimal(-4.5)).toBe("-4½");
    expect(isDecimal(-4)).toBe("-4");
    expect(isDecimal(null)).toBe("");
  });

  test("checkDisplayLine orders negative quarter lines like the app", () => {
    expect(checkDisplayLine({ line: -4.25, odd: -110, lineType: "S" })).toBe(
      "-4½,-4 -110",
    );
    expect(checkDisplayLine({ line: 4.25, odd: -110, lineType: "S" })).toBe(
      "4½,+4 -110",
    );
    expect(checkDisplayLine({ line: -4.5, odd: 158, lineType: "S" })).toBe(
      "-4½ +158",
    );
    expect(checkDisplayLine({ line: 0, odd: -105, lineType: "S" })).toBe(
      "PK -105",
    );
  });

  test("checkDisplayLine splits quarter totals", () => {
    expect(
      checkDisplayLine({
        line: 3.25,
        odd: -110,
        lineType: "L",
        totalOU: "O",
      }),
    ).toBe("Ov 3,3½ -110");
    expect(
      checkDisplayLine({
        line: 219.5,
        odd: -115,
        lineType: "L",
        totalOU: "O",
      }),
    ).toBe("Ov 219½ -115");
  });

  test("getLineGameFull adds DRAW and buy-point suffixes", () => {
    expect(
      getLineGameFull({
        legWagerType: "M",
        finalMoney: 105,
        sportType: "SOCCER",
        chosenTeamId: "T1 / T2",
        team1Id: "T1",
        team2Id: "T2",
      }),
    ).toBe("DRAW +105");
    expect(
      getLineGameFull({
        legWagerType: "S",
        adjSpread: -5,
        finalMoney: -120,
        sportType: "BASKETBALL",
        chosenTeamId: "",
        team1Id: "",
        team2Id: "",
        buyPoints: 0.5,
      }),
    ).toBe("-5 -120 (B+½) ");
  });

  test("nFormatter compacts aggregates coarsely like the client", () => {
    expect(nFormatter(612_750)).toBe("613K");
    expect(nFormatter(1_500_000)).toBe("2M");
    expect(nFormatter(58)).toBe("58");
    expect(nFormatter(Number.NaN)).toBe("");
  });
});
