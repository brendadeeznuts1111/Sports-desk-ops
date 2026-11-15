#!/usr/bin/env bun
/**
 * @file scripts/f402_report_player_analysis_sweep.ts
 * @description Fetch and summarize `POST /cloud/api/Manager/getReportPlayerAnalysis`
 * across all customers (`customerID: ""` and/or active customer sweep) using
 * `createF402ReplayTransport()`.
 *
 * Usage:
 *   bun run scripts/f402_report_player_analysis_sweep.ts
 *   bun run scripts/f402_report_player_analysis_sweep.ts --days 14 --line-type -1
 *   bun run scripts/f402_report_player_analysis_sweep.ts --customers CUST04_1,MM1012,MM1023
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import {
  defaultAnalysisDateWindow,
  fetchLineTypes,
  fetchReportPlayerAnalysis,
  summarizeReportPlayerAnalysis,
  summarizeSuspectedBotCohort,
  type CustomerAnalysisRollup,
  type PortfolioAnalysisSummary,
  type ReportPlayerAnalysisRowRaw,
} from "../lib/f402_report_player_analysis.ts";

interface CliOptions {
  readonly agentID: string;
  readonly agentOwner: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly reportType: string;
  readonly lineType: string;
  readonly customers: readonly string[];
  readonly maxSweepCustomers: number;
  readonly concurrency: number;
  readonly outPath: string;
  readonly fromFile: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let days = 14;
  let startDate = "";
  let endDate = "";
  let agentID = (Bun.env.F402_AGENT_ID ?? "AGENT_BB").trim() || "AGENT_BB";
  let agentOwner = "";
  let reportType = "";
  let lineType = "1";
  let customers: string[] = [];
  let maxSweepCustomers = 150;
  let concurrency = 6;
  let outPath = resolve(
    import.meta.dir,
    "..",
    "scratch",
    "f402-player-analysis-all.json",
  );
  let fromFile = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) days = Math.trunc(n);
    } else if (arg === "--start" && i + 1 < argv.length) {
      startDate = (argv[++i] ?? "").trim();
    } else if (arg === "--end" && i + 1 < argv.length) {
      endDate = (argv[++i] ?? "").trim();
    } else if (arg === "--agent" && i + 1 < argv.length) {
      agentID = (argv[++i] ?? "").trim() || agentID;
    } else if (arg === "--owner" && i + 1 < argv.length) {
      agentOwner = (argv[++i] ?? "").trim();
    } else if (arg === "--report-type" && i + 1 < argv.length) {
      reportType = (argv[++i] ?? "1").trim();
    } else if (arg === "--line-type" && i + 1 < argv.length) {
      lineType = (argv[++i] ?? "1").trim();
    } else if (arg === "--customers" && i + 1 < argv.length) {
      customers = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    } else if (arg === "--max-customers" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) maxSweepCustomers = Math.trunc(n);
    } else if (arg === "--concurrency" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) concurrency = Math.trunc(n);
    } else if (arg === "--out" && i + 1 < argv.length) {
      outPath = resolve(process.cwd(), argv[++i] ?? outPath);
    } else if (arg === "--from-file" && i + 1 < argv.length) {
      fromFile = resolve(process.cwd(), argv[++i] ?? "");
    }
  }

  // Default to reportType="2" (wager-level detail) when sweeping specific customers, or "1" (summary) when querying all customers
  const resolvedReportType =
    reportType !== "" ? reportType : customers.length > 0 ? "2" : "1";
  const defWindow = defaultAnalysisDateWindow(new Date(), days);
  return {
    agentID,
    agentOwner: agentOwner || agentID,
    startDate: startDate || defWindow.startDate,
    endDate: endDate || defWindow.endDate,
    reportType: resolvedReportType,
    lineType,
    customers,
    maxSweepCustomers,
    concurrency,
    outPath,
    fromFile,
  };
}

function discoverLocalCustomerIds(maxCount: number): string[] {
  const seen = new Set<string>();
  const repoRoot = resolve(import.meta.dir, "..");

  const addId = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const id = raw.trim();
    if (id !== "" && id !== "0" && id !== "*") {
      seen.add(id);
    }
  };

  // 1. Always seed with known AGNT_A / sharp watchlist accounts
  for (const seed of ["CUST04_1", "CUST04", "MM1012", "MM1023", "CUST03"]) {
    seen.add(seed);
  }

  // 2. Check data/live-bets.json & data/live-wagers.json if present
  for (const rel of ["data/live-bets.json", "data/live-wagers.json"]) {
    const p = resolve(repoRoot, rel);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<
        string,
        unknown
      >;
      const rows =
        (Array.isArray(parsed.bets) ? parsed.bets : null) ??
        (Array.isArray(parsed.wagers) ? parsed.wagers : null) ??
        (Array.isArray(parsed.rows) ? parsed.rows : null) ??
        (Array.isArray(parsed.LIST) ? parsed.LIST : null) ??
        [];
      for (const r of rows) {
        if (typeof r !== "object" || r === null) continue;
        const rec = r as Record<string, unknown>;
        addId(rec.customerId ?? rec.CustomerID ?? rec.customer ?? rec.login);
        if (seen.size >= maxCount) break;
      }
    } catch {
      // ignore
    }
  }

  return [...seen].slice(0, maxCount);
}

function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function printSummaryReport(
  summary: PortfolioAnalysisSummary,
  meta: {
    readonly startDate: string;
    readonly endDate: string;
    readonly mode: string;
    readonly outPath: string;
  },
): void {
  console.log(
    `\n=== F402 Player Analysis (${meta.startDate} -> ${meta.endDate}) [${meta.mode}] ===`,
  );
  console.log(
    `Rows: ${summary.rowCount} (detail: ${summary.detailRowCount}, summary: ${summary.summaryRowCount}) | Customers: ${summary.customerCount} | Offices: ${summary.officeCount} | Total Wagers: ${summary.totalWagerCount.toLocaleString("en-US")}`,
  );
  console.log(
    `Total Risk: ${formatUsd(summary.totalRiskCents)} | To Win: ${formatUsd(summary.totalToWinCents)} | Player Net: ${formatUsd(summary.totalPlayerNetCents)} | House Net: ${formatUsd(summary.totalHouseNetCents)}`,
  );
  console.log(
    `CLV Price Beats: ${summary.beatClosingPriceCount.toLocaleString("en-US")}/${summary.totalWagerCount.toLocaleString("en-US")} (${(summary.beatClosingPriceRate * 100).toFixed(1)}%) | Mean PRICE: ${summary.meanPriceDelta ?? "n/a"}¢ | CLV Points Beats: ${summary.beatClosingPointsCount.toLocaleString("en-US")}/${summary.totalWagerCount.toLocaleString("en-US")} (${(summary.beatClosingPointsRate * 100).toFixed(1)}%) | Mean POINTS: ${summary.meanPointsDelta ?? "n/a"} pts`,
  );
  console.log(
    `Formula Checks: PRICE ${summary.priceFormulaMatchCount}/${summary.rowCount} | WINLOSE ${summary.winLoseInvariantMatchCount}/${summary.rowCount} | Unflagged Sharp Signals: ${summary.unflaggedSharpCustomers.length}`,
  );

  if (summary.byOffice.length > 0) {
    console.log(`\n--- Top Offices by Volume / Risk ---`);
    console.table(
      summary.byOffice.slice(0, 15).map((o) => ({
        Office: o.agentId,
        Customers: o.customerCount,
        Wagers: o.wagerCount,
        PlayerNet: formatUsd(o.playerNetCents),
        HouseNet: formatUsd(o.houseNetCents),
        "BeatPrice%": `${(o.beatClosingPriceRate * 100).toFixed(1)}% (${o.beatClosingPriceCount}/${o.wagerCount})`,
        "BeatPts%": `${(o.beatClosingPointsRate * 100).toFixed(1)}% (${o.beatClosingPointsCount}/${o.wagerCount})`,
        "MeanPRICE(¢)": o.meanPriceDelta ?? "n/a",
        MeanPOINTS: o.meanPointsDelta ?? "n/a",
        UnflaggedSharps: o.unflaggedSharpCustomerCount,
      })),
    );
  }

  const formatCust = (c: CustomerAnalysisRollup) => ({
    Customer: c.customerId,
    Office: c.agentId,
    BotFlag: `${c.suspectedBot}:${c.suspectedBotType} (${c.botLabel})`,
    Wagers:
      c.winCount + c.lossCount > 0
        ? `${c.wagerCount} (${c.winCount}W-${c.lossCount}L)`
        : `${c.wagerCount}`,
    PlayerNet: formatUsd(c.playerNetCents),
    "BeatPrice%": `${(c.beatClosingPriceRate * 100).toFixed(1)}% (${c.beatClosingPriceCount}/${c.wagerCount})`,
    "BeatPts%": `${(c.beatClosingPointsRate * 100).toFixed(1)}% (${c.beatClosingPointsCount}/${c.wagerCount})`,
    "MeanPRICE(¢)": c.meanPriceDelta ?? "n/a",
    MeanPOINTS: c.meanPointsDelta ?? "n/a",
    Skin: c.inetTargets.join(",") || "-",
    SharpSignal: c.unflaggedSharpSignal ? "YES" : "no",
  });

  if (summary.customers.length > 0) {
    console.log(`\n--- Top Customers by CLV Price Beats ---`);
    console.table(summary.customers.slice(0, 20).map(formatCust));

    const moosemCusts = summary.customers.filter((c) => c.agentId === "AGNT_A");
    if (moosemCusts.length > 0) {
      console.log(
        `\n--- AGNT_A Office Customers (${moosemCusts.length} accounts) ---`,
      );
      console.table(moosemCusts.map(formatCust));
    }

    const topWinners = [...summary.customers]
      .sort((a, b) => b.playerNetCents - a.playerNetCents)
      .slice(0, 15);
    console.log(`\n--- Top Customer Winners (Player Net) ---`);
    console.table(topWinners.map(formatCust));
  }

  if (summary.bySubSport.length > 0) {
    console.log(`\n--- Breakdown by Sub-Sport ---`);
    console.table(
      summary.bySubSport.slice(0, 15).map((s) => ({
        SubSport: s.sportSubType,
        Wagers: s.wagerCount,
        Risk: formatUsd(s.totalRiskCents),
        PlayerNet: formatUsd(s.playerNetCents),
        HouseNet: formatUsd(s.houseNetCents),
        "BeatClose%": `${(s.beatClosingPriceRate * 100).toFixed(1)}% (${s.beatClosingPriceCount}/${s.wagerCount})`,
        "MeanPRICE(¢)": s.meanPriceDelta ?? "n/a",
      })),
    );
  }

  if (summary.byInetTarget.length > 0) {
    console.log(`\n--- Top InetTarget (Entry Skin) Domains ---`);
    console.table(
      summary.byInetTarget.slice(0, 15).map((i) => ({
        InetTarget: i.inetTarget,
        Customers: i.customerCount,
        Wagers: i.wagerCount,
        PlayerNet: formatUsd(i.playerNetCents),
        HouseNet: formatUsd(i.houseNetCents),
        "BeatPrice%": `${(i.beatClosingPriceRate * 100).toFixed(1)}% (${i.beatClosingPriceCount}/${i.wagerCount})`,
        "BeatPts%": `${(i.beatClosingPointsRate * 100).toFixed(1)}% (${i.beatClosingPointsCount}/${i.wagerCount})`,
      })),
    );
  }

  console.log(`\nSaved artifact -> ${meta.outPath}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.fromFile !== "") {
    const rawJson = (await Bun.file(opts.fromFile).json()) as {
      startDate?: string;
      endDate?: string;
      agentID?: string;
      reportType?: string;
      lineType?: string;
      mode?: string;
      LIST?: ReportPlayerAnalysisRowRaw[];
    };
    const allRows = Array.isArray(rawJson.LIST) ? rawJson.LIST : [];
    const summary = summarizeReportPlayerAnalysis({ LIST: allRows });
    const botCohort = summarizeSuspectedBotCohort({ LIST: allRows });
    const startDate = rawJson.startDate ?? opts.startDate;
    const endDate = rawJson.endDate ?? opts.endDate;
    const mode = rawJson.mode ?? `from-file (${opts.fromFile})`;

    mkdirSync(dirname(opts.outPath), { recursive: true });
    await Bun.write(
      opts.outPath,
      JSON.stringify(
        {
          ...rawJson,
          summarizedAt: new Date().toISOString(),
          summary,
          botCohort,
          rawRowCount: allRows.length,
          LIST: allRows,
        },
        null,
        2,
      ),
    );

    printSummaryReport(summary, {
      startDate,
      endDate,
      mode,
      outPath: opts.outPath,
    });
    if (botCohort.suspectedBotCustomerCount > 0) {
      console.log(
        `\n--- Suspected Bot Cohort (${botCohort.suspectedBotCustomerCount} bots, ${botCohort.totalBotWagerCount} wagers, top sub-sport: ${botCohort.topSubSportByWagers ?? "n/a"}) ---`,
      );
      if (botCohort.subSportRankings.length > 0) {
        console.table(botCohort.subSportRankings.slice(0, 10));
      }
    }
    return;
  }

  const transport = await createF402ReplayTransport();

  try {
    // 1. Optional line types discovery
    const lineTypes = await fetchLineTypes(transport, {
      agentID: opts.agentID,
      agentOwner: opts.agentOwner,
    }).catch(() => []);
    if (lineTypes.length > 0) {
      console.log(
        `[lineTypes] ${lineTypes.map((lt) => `${lt.lineType}=${lt.displayLineType}`).join(", ")}`,
      );
    }

    const allRows: ReportPlayerAnalysisRowRaw[] = [];
    let fetchMode = 'all-customers (customerID="")';

    if (opts.customers.length === 0) {
      // First query with customerID="" (manager.js default for all customers under agentID)
      for (const lt of opts.lineType === "all"
        ? ["-1", "1", "2"]
        : [opts.lineType]) {
        const res = await fetchReportPlayerAnalysis(transport, {
          agentID: opts.agentID,
          agentOwner: opts.agentOwner,
          customerID: "",
          reportType: opts.reportType,
          startDate: opts.startDate,
          endDate: opts.endDate,
          lineType: lt,
        });
        console.log(
          `[getReportPlayerAnalysis] customerID="" reportType=${opts.reportType} lineType=${lt} -> ${res.envelope.LIST.length} rows`,
        );
        allRows.push(...res.envelope.LIST);
        if (allRows.length > 0) break;
      }
    }

    // If customerID="" returned 0 rows (or explicit --customers was provided), sweep active customers
    if (allRows.length === 0) {
      const targetCustomers =
        opts.customers.length > 0
          ? [...opts.customers]
          : discoverLocalCustomerIds(opts.maxSweepCustomers);
      fetchMode = `customer-sweep (${targetCustomers.length} customers, concurrency=${opts.concurrency})`;
      console.log(`[getReportPlayerAnalysis] running ${fetchMode}...`);

      const queue = [...targetCustomers];
      const workers = Array.from(
        { length: Math.min(opts.concurrency, queue.length) },
        async () => {
          while (queue.length > 0) {
            const cid = queue.shift();
            if (cid === undefined) break;
            try {
              const res = await fetchReportPlayerAnalysis(transport, {
                agentID: opts.agentID,
                agentOwner: opts.agentOwner,
                customerID: cid,
                reportType: opts.reportType,
                startDate: opts.startDate,
                endDate: opts.endDate,
                lineType: opts.lineType,
              });
              if (res.envelope.LIST.length > 0) {
                allRows.push(...res.envelope.LIST);
                console.log(
                  `  + ${cid}: ${res.envelope.LIST.length} rows (beat close: ${res.summary.beatClosingPriceCount}/${res.summary.detailRowCount})`,
                );
              }
            } catch (err) {
              console.warn(
                `  ! ${cid}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        },
      );
      await Promise.all(workers);
    }

    const summary = summarizeReportPlayerAnalysis({ LIST: allRows });
    const botCohort = summarizeSuspectedBotCohort({ LIST: allRows });
    mkdirSync(dirname(opts.outPath), { recursive: true });
    await Bun.write(
      opts.outPath,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          agentID: opts.agentID,
          startDate: opts.startDate,
          endDate: opts.endDate,
          reportType: opts.reportType,
          lineType: opts.lineType,
          mode: fetchMode,
          summary,
          botCohort,
          rawRowCount: allRows.length,
          LIST: allRows,
        },
        null,
        2,
      ),
    );

    printSummaryReport(summary, {
      startDate: opts.startDate,
      endDate: opts.endDate,
      mode: fetchMode,
      outPath: opts.outPath,
    });
    if (botCohort.suspectedBotCustomerCount > 0) {
      console.log(
        `\n--- Suspected Bot Cohort (${botCohort.suspectedBotCustomerCount} bots, ${botCohort.totalBotWagerCount} wagers, top sub-sport: ${botCohort.topSubSportByWagers ?? "n/a"}) ---`,
      );
      if (botCohort.subSportRankings.length > 0) {
        console.table(botCohort.subSportRankings.slice(0, 10));
      }
    }
  } finally {
    await transport.close();
  }
}

if (import.meta.main) {
  await main();
}
