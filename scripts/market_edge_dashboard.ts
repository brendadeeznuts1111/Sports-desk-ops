#!/usr/bin/env bun
/**
 * @file scripts/market_edge_dashboard.ts
 * @description Fantasy402 Market Edge & Leakage Dashboard CLI.
 *
 * Slices wagers across Sport, Sub-Sport, Period, and Market Type to surface
 * critical book leakage, player edges, high-margin recreational flows, and
 * late steam vulnerabilities.
 *
 * Usage:
 *   bun run scripts/market_edge_dashboard.ts --input data/f402-bets.jsonl
 *   bun run scripts/market_edge_dashboard.ts --sort leak --min-wagers 25
 *   bun run scripts/market_edge_dashboard.ts --sport Football --period 1
 *   bun run scripts/market_edge_dashboard.ts --format json
 *   ./bin/dx edge --sort hold --top 10
 */

import { existsSync } from "node:fs";
import {
  streamAndAggregateMarketEdges,
  MarketEdgeInspection,
  type EdgeSortCriteria,
  type EdgeFilterOptions,
  type MarketEdgeReport,
  type InputFileSource,
} from "../lib/market_edge_engine.ts";
import { cliInspectOptions, inspectReport } from "../lib/cli_inspect.ts";
import { F402_BETS_JSONL_OPERATOR_DEFAULT } from "../lib/f402_bets_corpus_path.ts";

function printUsage(): void {
  console.log(`
Fantasy402 Market Edge & Leakage Dashboard
==========================================
Analyzes wager profitability, bettor win rate, desk hold, and steam skew
across sports, sub-sports, portal periods, and market types.

Options:
  --input <path|->            Path to wager stream (JSONL/JSON) or '-' for stdin
  --sort <criteria>           Sort ordering: leak | hold | edge | volume | wagers | steam (default: leak)
                              - leak   : Lowest desk hold % first (biggest cash leaks)
                              - hold   : Highest desk hold % first (most profitable book markets)
                              - edge   : Highest bettor win rate % first
                              - volume : Highest total risk volume first
                              - wagers : Highest wager count first
                              - steam  : Highest late steam % first
  --sport <name>              Filter by canonical sport (Football, Basketball, Baseball, Hockey, etc.)
  --subsport <code>           Filter by sub-sport / league (NFL, CFB, NBA, CBB, NHL, MLB, EPL, etc.)
  --period <-1|0..6>          Filter by portal period (default: -1 [All Periods])
                              -1 = All, 0 = Game, 1 = 1st Half, 2 = 2nd Half, 3-6 = Quarters
  --market <type>             Filter by market type (derivative_points, spread, moneyline, total, etc.)
  --min-wagers <N>            Minimum wager count threshold to avoid low-sample noise (default: 10)
  --top <N>                   Maximum market cohorts to display (default: 25)
  --compact                   Display single-line compact matrix summary
  --columns <col1,col2,...>   Select specific columns to display
  --no-color                  Disable terminal ANSI colors
  --format <fmt>              Output presentation: table | inspect | json | summary | csv (default: table)
  --inspect                   Shortcut for --format=inspect
  --json                      Shortcut for --format=json
  --help                      Show this help message
`);
}

export interface CliOptions extends EdgeFilterOptions {
  readonly inputPath: InputFileSource;
  readonly format: "table" | "inspect" | "json" | "summary" | "csv";
  readonly inspect?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly noColor?: boolean | undefined;
  readonly columns?: readonly string[] | undefined;
}

export function parseCliArgs(args: string[]): CliOptions {
  let inputPath = "";
  let sort: EdgeSortCriteria = "leak";
  let sport: string | null = null;
  let subSport: string | null = null;
  let period: number | null = null;
  let market: string | null = null;
  let minWagers = 10;
  let top = 25;
  let format: "table" | "inspect" | "json" | "summary" | "csv" = "table";
  let inspect = false;
  let json = false;
  let compact = false;
  let noColor = false;
  let columns: string[] | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--input" && i + 1 < args.length) {
      inputPath = args[++i] ?? "";
    } else if (arg === "--sort" && i + 1 < args.length) {
      const nextArg = (args[++i] ?? "").toLowerCase();
      if (
        nextArg === "leak" ||
        nextArg === "hold" ||
        nextArg === "edge" ||
        nextArg === "volume" ||
        nextArg === "wagers" ||
        nextArg === "steam"
      ) {
        sort = nextArg;
      }
    } else if (arg === "--sport" && i + 1 < args.length) {
      sport = args[++i] ?? null;
    } else if (arg === "--subsport" && i + 1 < args.length) {
      subSport = args[++i] ?? null;
    } else if (arg === "--period" && i + 1 < args.length) {
      const p = parseInt(args[++i] ?? "", 10);
      if (!Number.isNaN(p)) period = p;
    } else if (arg === "--market" && i + 1 < args.length) {
      market = args[++i] ?? null;
    } else if (arg === "--min-wagers" && i + 1 < args.length) {
      const mw = parseInt(args[++i] ?? "", 10);
      if (!Number.isNaN(mw)) minWagers = mw;
    } else if (arg === "--top" && i + 1 < args.length) {
      const t = parseInt(args[++i] ?? "", 10);
      if (!Number.isNaN(t)) top = t;
    } else if (arg === "--columns" && i + 1 < args.length) {
      columns = (args[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--compact") {
      compact = true;
    } else if (arg === "--no-color") {
      noColor = true;
    } else if (arg === "--format" && i + 1 < args.length) {
      const fmt = (args[++i] ?? "").toLowerCase();
      if (
        fmt === "table" ||
        fmt === "inspect" ||
        fmt === "json" ||
        fmt === "summary" ||
        fmt === "csv"
      ) {
        format = fmt;
      }
    } else if (arg === "--inspect") {
      inspect = true;
      format = "inspect";
    } else if (arg === "--json") {
      json = true;
      format = "json";
    }
  }

  // Auto-resolve candidate files if not provided
  if (!inputPath) {
    const envBets = Bun.env.F402_BETS_JSONL?.trim();
    const candidates = [
      ...(envBets ? [envBets] : []),
      "data/f402-bets.jsonl",
      "data/live-bets.json",
      F402_BETS_JSONL_OPERATOR_DEFAULT,
      "tests/fixtures/fraud/live-bets.json",
      "tests/fixtures/live-wagers.partial.json",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        inputPath = c;
        break;
      }
    }
  }

  const result: CliOptions = {
    inputPath,
    sort,
    sport,
    subSport,
    period,
    market,
    minWagers,
    top,
    format,
  };

  if (inspect) (result as { inspect?: boolean }).inspect = true;
  if (json) (result as { json?: boolean }).json = true;
  if (compact) (result as { compact?: boolean }).compact = true;
  if (noColor) (result as { noColor?: boolean }).noColor = true;
  if (columns) (result as { columns?: readonly string[] }).columns = columns;

  return result;
}

export async function runMarketEdgeDashboard(
  options: CliOptions,
): Promise<{ report: MarketEdgeReport; inspection: MarketEdgeInspection }> {
  if (
    typeof options.inputPath === "string" &&
    options.inputPath !== "-" &&
    !options.inputPath
  ) {
    throw new Error(
      "No input file specified and no default candidate exists. Pass --input <path>.",
    );
  }

  const report = await streamAndAggregateMarketEdges(options.inputPath, {
    sort: options.sort,
    sport: options.sport,
    subSport: options.subSport,
    period: options.period,
    market: options.market,
    minWagers: options.minWagers,
    top: options.top,
  });

  const inspection = new MarketEdgeInspection(report, options);

  return { report, inspection };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const { report, inspection } = await runMarketEdgeDashboard(options);

  if (options.json || options.format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (options.inspect || options.format === "inspect") {
    console.log(inspectReport(inspection, cliInspectOptions()));
    return;
  }

  if (options.format === "summary") {
    const u = report.universe;
    console.log("=== Market Edge Universe Summary ===");
    console.log(`Total Wagers:     ${u.totalWagers.toLocaleString()}`);
    console.log(`Settled Wagers:   ${u.totalSettled.toLocaleString()}`);
    console.log(
      `Risk Volume:      $${u.totalRiskDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    console.log(
      `Desk Net PnL:     $${u.totalDeskPnlDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    console.log(`Overall Hold:     ${u.overallHoldPct.toFixed(2)}%`);
    console.log(`Critical Leaks:   ${u.criticalLeakCount}`);
    console.log(`Player Edges:     ${u.playerEdgeCount}`);
    console.log(`Book Edges:       ${u.bookEdgeCount}`);
    return;
  }

  if (options.format === "csv") {
    console.log(
      "Sport,SubSport,Period,Market,Wagers,Settled,RiskDollars,DeskPnlDollars,WinRatePct,DeskHoldPct,LateSteamPct,Status",
    );
    for (const r of report.rows) {
      console.log(
        [
          r.sport,
          r.subSport,
          `"${r.periodLabel}"`,
          `"${r.marketLabel}"`,
          r.totalWagers,
          r.settledWagers,
          r.totalRiskDollars.toFixed(2),
          r.deskPnlDollars.toFixed(2),
          r.bettorWinRatePct.toFixed(1),
          r.deskHoldPct.toFixed(2),
          r.lateSteamPct.toFixed(1),
          `"${r.edgeStatus}"`,
        ].join(","),
      );
    }
    return;
  }

  // Default: table output using Bun.inspect and Bun.inspect.table
  const baseInspectOpts = cliInspectOptions();
  const inspectOpts = {
    ...baseInspectOpts,
    colors: options.noColor
      ? false
      : options.inspect
        ? true
        : baseInspectOpts.colors,
    compact: options.compact ?? false,
    maxArrayLength: options.top,
  };
  console.log(Bun.inspect(inspection, inspectOpts));
}

if (import.meta.main) {
  await main();
}
