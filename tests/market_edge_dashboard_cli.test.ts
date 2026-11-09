/**
 * @file tests/market_edge_dashboard_cli.test.ts
 * @description CLI tests for scripts/market_edge_dashboard.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  parseCliArgs,
  runMarketEdgeDashboard,
} from "../scripts/market_edge_dashboard.ts";

describe("Market Edge Dashboard CLI > Argument Parsing", () => {
  it("parses CLI flags into structured CliOptions", () => {
    const opts = parseCliArgs([
      "--input",
      "data/f402-bets.jsonl",
      "--sort",
      "leak",
      "--sport",
      "Football",
      "--subsport",
      "CFB",
      "--period",
      "1",
      "--market",
      "derivative",
      "--min-wagers",
      "25",
      "--top",
      "15",
      "--format",
      "json",
    ]);

    expect(opts.inputPath).toBe("data/f402-bets.jsonl");
    expect(opts.sort).toBe("leak");
    expect(opts.sport).toBe("Football");
    expect(opts.subSport).toBe("CFB");
    expect(opts.period).toBe(1);
    expect(opts.market).toBe("derivative");
    expect(opts.minWagers).toBe(25);
    expect(opts.top).toBe(15);
    expect(opts.format).toBe("json");
  });

  it("handles shortcuts --inspect and --json", () => {
    const inspectOpts = parseCliArgs(["--inspect"]);
    expect(inspectOpts.inspect).toBe(true);
    expect(inspectOpts.format).toBe("inspect");

    const jsonOpts = parseCliArgs(["--json"]);
    expect(jsonOpts.json).toBe(true);
    expect(jsonOpts.format).toBe("json");
  });

  it("handles --compact, --no-color, and --columns flags", () => {
    const opts = parseCliArgs([
      "--compact",
      "--no-color",
      "--columns",
      "Sport,Market,Risk,DeskHold",
    ]);
    expect(opts.compact).toBe(true);
    expect(opts.noColor).toBe(true);
    expect(opts.columns).toEqual(["Sport", "Market", "Risk", "DeskHold"]);
  });
});

describe("Market Edge Dashboard CLI > Execution", () => {
  const fixtureWagers = [
    {
      SportType: "FOOTBALL",
      SportSubType: "NFL",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Chiefs -3.5 -110",
      AmountWagered: 100.0,
      AmountWon: 90.91,
      AmountLost: 0.0,
      Outcome: "W",
    },
    {
      SportType: "FOOTBALL",
      SportSubType: "NFL",
      PeriodDescription: "Game",
      PeriodNumber: 0,
      ShortDesc: "Ravens +3.5 -110",
      AmountWagered: 100.0,
      AmountWon: 0.0,
      AmountLost: 100.0,
      Outcome: "L",
    },
    {
      SportType: "BASKETBALL",
      SportSubType: "NBA",
      PeriodDescription: "1st Half",
      PeriodNumber: 1,
      ShortDesc: "Celtics 1H ML -130",
      AmountWagered: 130.0,
      AmountWon: 100.0,
      AmountLost: 0.0,
      Outcome: "W",
    },
  ];

  it("runs dashboard on in-memory File source and returns structured report", async () => {
    const file = new File(
      [fixtureWagers.map((w) => JSON.stringify(w)).join("\n")],
      "test_cli_edge.jsonl",
      { type: "application/x-ndjson" },
    );

    const { report, inspection } = await runMarketEdgeDashboard({
      inputPath: file,
      sort: "leak",
      minWagers: 1,
      format: "table",
    });

    expect(report.universe.totalWagers).toBe(3);
    expect(report.universe.totalSettled).toBe(3);
    expect(report.rows.length).toBe(2);
    expect(inspection).toBeDefined();

    const inspectStr = Bun.inspect(inspection, { colors: false });
    expect(inspectStr).toContain("Fantasy402 Market Edge & Leakage Matrix");
    expect(inspectStr).toContain("Total Wagers     : 3");
  });
});
