#!/usr/bin/env bun
/**
 * @file scripts/enrich_bets_from_figure_date.ts
 * @description Streaming enrichment engine joining f402-bets.jsonl with /cloud/api/Report/getWagersByFigureDate.
 *
 * Adheres strictly to AGENTS.md data-handling budgets:
 * - Settled batch rows indexed in memory by composite match key (< 5 MB budget).
 * - Live ticker JSONL processed strictly via line-by-line stream (never loads whole file into memory).
 *
 * Usage:
 *   bun run scripts/enrich_bets_from_figure_date.ts --figure scratch/figure_date.json --ticker probes/out13/f402-bets.jsonl --output scratch/f402-bets-enriched.jsonl
 */

import { resolve } from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import {
  buildCompositeMatchKey,
  enrichWagerRecord,
  inferTotalPicks,
  parseBuyPointsFromDesc,
  FigureDateEnrichmentInspection,
  type FigureDateWager,
  type LiveTickerWager,
  type EnrichedWager,
} from "../lib/f402_figure_date_enricher.ts";
import { parseAsCents } from "../design/domain-branded-types.ts";
import { cliInspectOptions, inspectReport } from "../lib/cli_inspect.ts";
import { F402_BETS_JSONL_OPERATOR_DEFAULT } from "../lib/f402_bets_corpus_path.ts";
import { classifyPortalPeriod } from "../lib/portal_period_taxonomy.ts";

function printUsage(): void {
  console.log(`
Fantasy402 Figure Date Enrichment Engine
========================================
Joins live ticker wagers with settled ground-truth records.

Options:
  --figure <path>    Path to getWagersByFigureDate JSON payload or JSONL
  --ticker <path>    Path to raw f402-bets.jsonl stream
  --output <path>    Path to emit enriched JSONL wagers
  --format <fmt>     Output presentation format: inspect | jsonl | summary | table (default: summary)
  --inspect          Format output using Bun.inspect inspection view (shortcut for --format=inspect)
  --sample <N>       Number of sample enriched wagers to inspect (default: 5)
  --stats            Output match rate and summary statistics (default: true)
  --help             Show this help message
`);
}

export type InputFileSource = string | File | Blob;

export interface CliOptions {
  figurePath: InputFileSource;
  tickerPath: InputFileSource;
  outputPath?: string | null;
  stats?: boolean;
  format?: "jsonl" | "inspect" | "summary" | "table";
  inspect?: boolean;
  sampleCount?: number;
}

export function parseCliArgs(args: string[]): CliOptions {
  let figurePath = "";
  let tickerPath =
    Bun.env.F402_BETS_JSONL?.trim() || F402_BETS_JSONL_OPERATOR_DEFAULT;
  let outputPath = resolve(process.cwd(), "scratch/f402-bets-enriched.jsonl");
  let stats = true;
  let format: "jsonl" | "inspect" | "summary" | "table" = "summary";
  let inspect = false;
  let sampleCount = 5;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--figure" && i + 1 < args.length) {
      const val = args[++i];
      if (val) figurePath = resolve(process.cwd(), val);
    } else if (arg === "--ticker" && i + 1 < args.length) {
      const val = args[++i];
      if (val) tickerPath = resolve(process.cwd(), val);
    } else if (arg === "--output" && i + 1 < args.length) {
      const val = args[++i];
      if (val) outputPath = resolve(process.cwd(), val);
    } else if (arg === "--no-stats") {
      stats = false;
    } else if (arg === "--format" && i + 1 < args.length) {
      const nextArg = args[++i];
      const val = nextArg ? nextArg.toLowerCase() : "";
      if (
        val === "inspect" ||
        val === "jsonl" ||
        val === "summary" ||
        val === "table"
      ) {
        format = val;
      }
    } else if (arg === "--inspect") {
      inspect = true;
      format = "inspect";
    } else if (arg === "--sample" && i + 1 < args.length) {
      const parsed = parseInt(args[++i] ?? "5", 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        sampleCount = parsed;
      }
    }
  }

  if (!figurePath) {
    console.error("Error: Missing required argument --figure <path>");
    printUsage();
    process.exit(1);
  }

  return {
    figurePath,
    tickerPath,
    outputPath,
    stats,
    format,
    inspect,
    sampleCount,
  };
}

async function loadFigureIndex(
  source: InputFileSource,
): Promise<Map<string, FigureDateWager>> {
  const index = new Map<string, FigureDateWager>();
  const file: Blob = typeof source === "string" ? Bun.file(source) : source;

  let records: FigureDateWager[] = [];
  try {
    const fileWithJson = file as Blob & { json?: () => Promise<unknown> };
    const parsed: unknown =
      typeof fileWithJson.json === "function"
        ? await fileWithJson.json()
        : JSON.parse(await file.text());

    if (Array.isArray(parsed)) {
      records = parsed as FigureDateWager[];
    } else if (
      parsed &&
      typeof parsed === "object" &&
      "LIST" in parsed &&
      parsed.LIST &&
      typeof parsed.LIST === "object" &&
      "INFO" in parsed.LIST &&
      Array.isArray((parsed.LIST as Record<string, unknown>).INFO)
    ) {
      records = (parsed.LIST as { INFO: FigureDateWager[] }).INFO;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      "rows" in parsed &&
      Array.isArray((parsed as Record<string, unknown>).rows)
    ) {
      records = (parsed as { rows: FigureDateWager[] }).rows;
    }
  } catch {
    // If not single JSON, parse line-by-line JSONL from file text
    const content = await file.text();
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // ignore unparseable lines
      }
    }
  }

  for (const rec of records) {
    const key = buildCompositeMatchKey(
      String(rec.CustomerID || ""),
      String(rec.AcceptedDateTime || ""),
      Number(rec.AmountWagered || 0),
      Number(rec.ToWinAmount || 0),
      String(rec.Description || ""),
    );
    index.set(key, rec);
  }

  return index;
}

export async function runEnrichment(options: CliOptions): Promise<{
  totalTickerRows: number;
  matchedRows: number;
  unmatchedRows: number;
  enrichedOutPath: string;
  inspection: FigureDateEnrichmentInspection;
}> {
  if (
    typeof options.figurePath === "string" &&
    !(await Bun.file(options.figurePath).exists())
  ) {
    throw new Error(`Figure file not found: ${options.figurePath}`);
  }

  const tickerFile: Blob =
    typeof options.tickerPath === "string"
      ? Bun.file(options.tickerPath)
      : options.tickerPath;
  if (
    typeof options.tickerPath === "string" &&
    !(await Bun.file(options.tickerPath).exists())
  ) {
    throw new Error(`Ticker file not found: ${options.tickerPath}`);
  }

  const startNs =
    typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function"
      ? Bun.nanoseconds()
      : 0;

  const figureIndex = await loadFigureIndex(options.figurePath);
  let totalTickerRows = 0;
  let matchedRows = 0;
  let unmatchedRows = 0;
  let totalRiskCents = 0;
  let totalNetPnlCents = 0;
  const samples: EnrichedWager[] = [];
  const maxSamples = options.sampleCount ?? 5;

  const rl = readline.createInterface({
    input: Readable.fromWeb(
      tickerFile.stream() as unknown as Parameters<typeof Readable.fromWeb>[0],
    ),
    crlfDelay: Infinity,
  });

  const outWriter = options.outputPath
    ? Bun.file(options.outputPath).writer()
    : null;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      totalTickerRows++;

      let tickerRow: LiveTickerWager;
      try {
        tickerRow = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Skip ALERT mirrors if VolumeAmount === 0 to avoid double counting
      if (tickerRow.TicketWriter === "ALERT" && tickerRow.VolumeAmount === 0) {
        continue;
      }

      const matchKey = buildCompositeMatchKey(
        String(tickerRow.CustomerID || ""),
        String(tickerRow.InsertDateTime || ""),
        Number(tickerRow.AmountWagered || 0),
        Number(tickerRow.ToWinAmount || 0),
        String(tickerRow.ShortDesc || ""),
      );

      const figureRow = figureIndex.get(matchKey);
      if (figureRow) {
        matchedRows++;
        const enriched = enrichWagerRecord(tickerRow, figureRow);
        totalRiskCents += enriched.settlement.amountWageredCents;
        totalNetPnlCents += enriched.settlement.netPnlCents;
        if (samples.length < maxSamples) {
          samples.push(enriched);
        }
        if (outWriter) outWriter.write(JSON.stringify(enriched) + "\n");
      } else {
        unmatchedRows++;
        const periodClassification = classifyPortalPeriod({
          ShortDesc: tickerRow.ShortDesc,
          WagerType: tickerRow.WagerType,
        });
        // Output pending un-enriched row with consistent schema flag
        if (outWriter) {
          outWriter.write(
            JSON.stringify({
              ticketNumber: String(tickerRow.WagerNumber),
              liveWagerNumber: tickerRow.WagerNumber,
              customerId: String(tickerRow.CustomerID || "").trim(),
              agentLogin: String(
                tickerRow.AgentLogin || tickerRow.AgentID || "",
              ).trim(),
              ticketWriter: String(tickerRow.TicketWriter || "").trim(),
              volumeAmount: Number(
                tickerRow.VolumeAmount ?? tickerRow.AmountWagered ?? 0,
              ),
              totalPicks: inferTotalPicks(
                tickerRow.WagerType,
                tickerRow.ShortDesc,
              ),
              eventId: "UNSETTLED",
              sport: "Unknown",
              subSport: "Unknown",
              opponents: { away: "", home: "" },
              gameDateTime: tickerRow.InsertDateTime,
              acceptedDateTime: tickerRow.InsertDateTime,
              dailyFigureDate: tickerRow.InsertDateTime.slice(0, 10),
              latencySeconds: 0,
              isLateSteam: false,
              isLive: /LIVE/i.test(tickerRow.ShortDesc || ""),
              portalPeriod: periodClassification.portalPeriod,
              periodNumber: periodClassification.portalPeriod ?? 0,
              periodDescription: periodClassification.portalLabel,
              marketType: "other",
              buyPoints: parseBuyPointsFromDesc(tickerRow.ShortDesc || ""),
              origSpread: null,
              adjSpread: null,
              origTotalPoints: null,
              adjTotalPoints: null,
              selection: {
                chosenTeam: "",
                line: null,
                origLine: null,
                buyPoints: parseBuyPointsFromDesc(tickerRow.ShortDesc || ""),
                price: null,
                overUnder: null,
              },
              settlement: {
                isSettled: false,
                status: "P",
                outcome: "PENDING",
                amountWageredCents: Number(tickerRow.AmountWagered || 0),
                toWinCents: Number(tickerRow.ToWinAmount || 0),
                amountWonCents: 0,
                amountLostCents: 0,
                netPnlCents: 0,
                awayScore: null,
                homeScore: null,
              },
            }) + "\n",
          );
        }
      }
    }
  } finally {
    rl.close();
  }

  if (outWriter) await outWriter.end();

  const durationMs =
    typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function"
      ? Number(Bun.nanoseconds() - startNs) / 1_000_000
      : 0;
  const throughputRowsPerSec =
    durationMs > 0
      ? Math.round((totalTickerRows / durationMs) * 1000)
      : undefined;

  const inspection = new FigureDateEnrichmentInspection(
    {
      figureRecordsIndexed: figureIndex.size,
      tickerRowsStreamed: totalTickerRows,
      exactMatchedRows: matchedRows,
      unmatchedRows,
      matchRatePct:
        totalTickerRows > 0 ? (matchedRows / totalTickerRows) * 100 : 0,
      totalRiskCents: parseAsCents(totalRiskCents, true),
      totalNetPnlCents: parseAsCents(totalNetPnlCents, true),
      durationMs,
      throughputRowsPerSec,
    },
    samples,
  );

  if (options.inspect || options.format === "inspect") {
    console.log(inspectReport(inspection, cliInspectOptions()));
  } else if (options.stats && options.format === "summary") {
    console.log("Enrichment Run Summary:");
    console.log(`- Settled Figure Records Indexed: ${figureIndex.size}`);
    console.log(`- Ticker Rows Streamed:           ${totalTickerRows}`);
    console.log(`- Exact Matched & Enriched:       ${matchedRows}`);
    console.log(`- Unmatched (Pending):            ${unmatchedRows}`);
    console.log(`- Enriched JSONL Output:          ${options.outputPath}`);
  }

  return {
    totalTickerRows,
    matchedRows,
    unmatchedRows,
    enrichedOutPath: options.outputPath ?? ":memory:",
    inspection,
  };
}

if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));
  runEnrichment(options).catch((err) => {
    console.error("Fatal enrichment error:", err);
    process.exit(1);
  });
}
