#!/usr/bin/env bun
/**
 * @file scripts/normalize.ts
 * @description Canonical normalizer CLI mapping Fantasy402 wager data to portal period taxonomy.
 *
 * Usage:
 *   bun run scripts/normalize.ts --mode CPV --period 1 --engine full
 *   bun run scripts/normalize.ts --mode CPV --period 2 --range start=2026-10-02,end=2026-11-09 --output scratch/norm_2h.json
 *   bun run scripts/normalize.ts --help
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { Database } from "bun:sqlite";
import {
  DATE_FAMILIES,
  PORTAL_PERIOD_LABELS,
  classifyPortalPeriod,
  detectEngine,
  isDerivativePointsLineWager,
  normalizeWager,
  PeriodTaxonomyInspection,
  registerPortalPeriodSqliteFunctions,
  insertNormalizedWagers,
  type NormalizedWagerRecord,
  type PortalPeriodCode,
  type ProvenanceSidecar,
  type RawWagerInput,
  type ReportMode,
} from "../lib/portal_period_taxonomy.ts";
import { cliInspectOptions, inspectReport } from "../lib/cli_inspect.ts";
import { F402_BETS_JSONL_OPERATOR_DEFAULT } from "../lib/f402_bets_corpus_path.ts";

function printUsage(): void {
  console.log(`
Fantasy402 Portal Period Normalizer CLI
=======================================
Enforces the canonical 0–6 portal period enum and multi-family date mapping.

Options:
  --mode <CP|CPS|CPV|G>       Report mode determining date field family (default: CPV)
                              - CP / CPS -> Aggregate (start / end, disabled)
                              - CPV      -> Customer Volume (startReportVolumen / endReportVolumen, disabled + period)
                              - G        -> Grading (startG / endG, enabled)
  --period <-1|0..6>          Portal period dropdown value (default: -1 [All Periods])
                              -1 = All Periods
                               0 = Game (incl_ot folded)
                               1 = 1st Half
                               2 = 2nd Half
                               3 = 1st Qtr
                               4 = 2nd Qtr
                               5 = 3rd Qtr
                               6 = 4th Qtr
  --engine <native|full>      Ingestion engine scope (default: full)
                              - native: Native ASI desk only (WagerType === 'E')
                              - full: Native ASI + Gansrow Live/Builder
  --market <tt|all>           Market scope (default: tt [Derivative Points Line only], or all)
  --sport <name>              Filter by sport category (e.g. Football, Basketball, Soccer)
  --subsport <code>           Filter by sub-sport / league (e.g. NFL, CFB, NBA, CBB)
  --range start=...,end=...   Optional date window (maps to mode's date family)
  --input <path>              Path to JSONL wagers file
  --output <path>             Path to save normalized JSON output (also writes <output>_meta.json)
  --sqlite <path>             Ingest normalized records directly into SQLite database using atomic transaction
  --format <fmt>              Output presentation format: inspect | table | json | summary (default: table)
  --inspect                   Format output using Bun.inspect inspection view (shortcut for --format=inspect)
  --help                      Show this help message
`);
}

export type InputFileSource = string | File | Blob;

export interface CliOptions {
  mode: ReportMode;
  period: PortalPeriodCode;
  engine: "native" | "full";
  market: "tt" | "all";
  sport?: string | null;
  subSport?: string | null;
  startDate: string | null;
  endDate: string | null;
  inputPath: InputFileSource;
  outputPath: string | null;
  sqlitePath?: string | null;
  format: "json" | "table" | "inspect" | "summary";
  inspect?: boolean;
}

export function parseCliArgs(args: string[]): CliOptions {
  let mode: ReportMode = "CPV";
  let period: PortalPeriodCode = -1;
  let engine: "native" | "full" = "full";
  let market: "tt" | "all" = "tt";
  let sport: string | null = null;
  let subSport: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let inputPath = "";
  let outputPath: string | null = null;
  let sqlitePath: string | null = null;
  let format: "json" | "table" | "inspect" | "summary" = "table";
  let inspect = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--mode" && i + 1 < args.length) {
      const nextArg = args[++i];
      const val = nextArg ? nextArg.toUpperCase() : "";
      if (val === "CP" || val === "CPS" || val === "CPV" || val === "G") {
        mode = val;
      } else {
        console.error(`Invalid --mode: ${val}. Must be CP, CPS, CPV, or G.`);
        process.exit(1);
      }
    } else if (arg === "--period" && i + 1 < args.length) {
      const nextArg = args[++i] ?? "";
      const val = parseInt(nextArg, 10);
      if (val >= -1 && val <= 6) {
        period = val as PortalPeriodCode;
      } else {
        console.error(`Invalid --period: ${val}. Must be between -1 and 6.`);
        process.exit(1);
      }
    } else if (arg === "--engine" && i + 1 < args.length) {
      const nextArg = args[++i];
      const val = nextArg ? nextArg.toLowerCase() : "";
      if (val === "native" || val === "full") {
        engine = val;
      } else {
        console.error(`Invalid --engine: ${val}. Must be 'native' or 'full'.`);
        process.exit(1);
      }
    } else if (arg === "--market" && i + 1 < args.length) {
      const nextArg = args[++i];
      const val = nextArg ? nextArg.toLowerCase() : "";
      if (val === "tt" || val === "all") {
        market = val;
      } else {
        console.error(`Invalid --market: ${val}. Must be 'tt' or 'all'.`);
        process.exit(1);
      }
    } else if (arg === "--sport" && i + 1 < args.length) {
      sport = (args[++i] ?? "").trim();
    } else if (
      (arg === "--subsport" || arg === "--sub-sport") &&
      i + 1 < args.length
    ) {
      subSport = (args[++i] ?? "").trim();
    } else if (arg === "--range" && i + 1 < args.length) {
      const val = args[++i] ?? "";
      const matchStart = val.match(/start=([^,]+)/i);
      const matchEnd = val.match(/end=([^,]+)/i);
      if (matchStart && matchStart[1]) startDate = matchStart[1].trim();
      if (matchEnd && matchEnd[1]) endDate = matchEnd[1].trim();
    } else if (arg === "--input" && i + 1 < args.length) {
      inputPath = args[++i] ?? "";
    } else if (arg === "--output" && i + 1 < args.length) {
      outputPath = args[++i] ?? null;
    } else if (arg === "--sqlite" && i + 1 < args.length) {
      sqlitePath = args[++i] ?? null;
    } else if (arg === "--format" && i + 1 < args.length) {
      const nextArg = args[++i];
      const val = nextArg ? nextArg.toLowerCase() : "";
      if (
        val === "json" ||
        val === "table" ||
        val === "inspect" ||
        val === "summary"
      ) {
        format = val;
      }
    } else if (arg === "--inspect") {
      inspect = true;
      format = "inspect";
    }
  }

  // Resolve input path default
  if (!inputPath) {
    const envBets = Bun.env.F402_BETS_JSONL?.trim();
    const candidates = [
      ...(envBets ? [envBets] : []),
      F402_BETS_JSONL_OPERATOR_DEFAULT,
      "data/f402-bets.jsonl",
      "data/live-bets.json",
      "tests/fixtures/live-wagers.partial.json",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        inputPath = c;
        break;
      }
    }
  }

  return {
    mode,
    period,
    engine,
    market,
    sport,
    subSport,
    startDate,
    endDate,
    inputPath,
    outputPath,
    sqlitePath,
    format,
    inspect,
  };
}

export async function runNormalizer(options: CliOptions): Promise<{
  records: NormalizedWagerRecord[];
  provenance: ProvenanceSidecar;
  inspection: PeriodTaxonomyInspection;
}> {
  const inputFile: Blob =
    typeof options.inputPath === "string"
      ? Bun.file(options.inputPath)
      : options.inputPath;
  if (
    typeof options.inputPath === "string" &&
    (!options.inputPath || !(await Bun.file(options.inputPath).exists()))
  ) {
    throw new Error(`Input file not found: ${options.inputPath}`);
  }

  const dateMapping = DATE_FAMILIES[options.mode];
  const dateFields = {
    start:
      options.mode === "CP" || options.mode === "CPS"
        ? options.startDate
        : null,
    end:
      options.mode === "CP" || options.mode === "CPS" ? options.endDate : null,
    startG: options.mode === "G" ? options.startDate : null,
    endG: options.mode === "G" ? options.endDate : null,
    startReportVolumen: options.mode === "CPV" ? options.startDate : null,
    endReportVolumen: options.mode === "CPV" ? options.endDate : null,
  };

  const records: NormalizedWagerRecord[] = [];
  const periodBreakdown: Record<string, { count: number; risk: number }> = {};
  const detailedBreakdown: Record<
    string,
    {
      engine: string;
      code: string;
      label: string;
      market: string;
      count: number;
      risk: number;
    }
  > = {};
  const seenWagerNumbers = new Set<string | number>();

  let totalProcessed = 0;
  let totalRisk = 0;
  const startNs =
    typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function"
      ? Bun.nanoseconds()
      : 0;

  const rl = readline.createInterface({
    input: Readable.fromWeb(
      inputFile.stream() as unknown as Parameters<typeof Readable.fromWeb>[0],
    ),
    crlfDelay: Infinity,
  });

  const startBound = options.startDate
    ? new Date(options.startDate).getTime()
    : null;
  const endBound = options.endDate ? new Date(options.endDate).getTime() : null;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let raw: RawWagerInput;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const wagerNum = raw.WagerNumber ?? raw.wagerNumber;
      if (wagerNum !== undefined) {
        if (seenWagerNumbers.has(wagerNum)) continue;
        seenWagerNumbers.add(wagerNum);
      }

      // Market scope filter
      if (options.market === "tt" && !isDerivativePointsLineWager(raw)) {
        continue;
      }

      // Engine scope filter
      const eng = detectEngine(raw);
      if (options.engine === "native" && eng !== "native") {
        continue;
      }

      totalProcessed++;

      // Date range filter
      if (startBound !== null || endBound !== null) {
        const dateStr = raw.InsertDateTime ?? raw.PlacedDate ?? raw.GradedDate;
        if (dateStr) {
          const time = new Date(dateStr).getTime();
          if (!Number.isNaN(time)) {
            if (startBound !== null && time < startBound) continue;
            if (endBound !== null && time > endBound) continue;
          }
        }
      }

      // Portal Period classification
      const pInfo = classifyPortalPeriod(raw);
      const code =
        pInfo.portalPeriod === null ? "∅" : String(pInfo.portalPeriod);
      const label = pInfo.portalLabel;
      const normalized = normalizeWager(raw);

      // Sport / Sub-sport filter
      if (
        options.sport &&
        normalized.sport.toLowerCase() !== options.sport.toLowerCase()
      ) {
        continue;
      }
      if (
        options.subSport &&
        normalized.subSport.toLowerCase() !== options.subSport.toLowerCase()
      ) {
        continue;
      }

      if (!periodBreakdown[label]) {
        periodBreakdown[label] = { count: 0, risk: 0 };
      }
      periodBreakdown[label].count++;
      periodBreakdown[label].risk += normalized.risk;

      const wt = String(raw.WagerType ?? raw.wagerType ?? "").trim();
      let marketName = "Derivative Points Line";
      if (eng === "native") {
        marketName = "Native Desk Derivative Points Line";
      } else if (wt === "M") {
        marketName = "Gansrow In-Play Single";
      } else if (wt === "P") {
        marketName = "Gansrow Builder Parlay";
      }

      const dKey = `${eng}|${code}|${label}|${marketName}`;
      if (!detailedBreakdown[dKey]) {
        detailedBreakdown[dKey] = {
          engine: eng,
          code,
          label,
          market: marketName,
          count: 0,
          risk: 0,
        };
      }
      detailedBreakdown[dKey].count++;
      detailedBreakdown[dKey].risk += normalized.risk;

      // Period filter matching
      if (options.period === -1) {
        // All Periods: portal exposes all 0..6
        records.push(normalized);
        totalRisk += normalized.risk;
      } else if (pInfo.portalPeriod === options.period) {
        // Exact portal period match
        records.push(normalized);
        totalRisk += normalized.risk;
      }
    }
  } finally {
    rl.close();
  }

  const durationMs =
    typeof Bun !== "undefined" && typeof Bun.nanoseconds === "function"
      ? Number(Bun.nanoseconds() - startNs) / 1_000_000
      : 0;
  const throughputRowsPerSec =
    durationMs > 0
      ? Math.round((totalProcessed / durationMs) * 1000)
      : undefined;

  if (options.sqlitePath) {
    const db = new Database(options.sqlitePath);
    registerPortalPeriodSqliteFunctions(db);
    insertNormalizedWagers(db, records);
    db.close();
  }

  const provenance: ProvenanceSidecar = {
    capturedAt: new Date().toISOString(),
    reportMode: options.mode,
    wagerType:
      options.market === "tt" ? "E (native) / M,P (Gansrow TT)" : "ALL",
    filtersExpanded: options.mode === "CPV",
    period: String(options.period),
    portalPeriod: options.period,
    portalPeriodLabel: PORTAL_PERIOD_LABELS[options.period],
    engineFilter: options.engine,
    dateFamily: dateMapping.family,
    dateFields,
    stats: {
      totalProcessed,
      matchedRows: records.length,
      totalRisk: Math.round(totalRisk * 100) / 100,
      avgRisk:
        records.length > 0
          ? Math.round((totalRisk / records.length) * 100) / 100
          : 0,
      durationMs,
      throughputRowsPerSec,
      periodBreakdown,
      detailedBreakdown,
    },
  };

  const inspection = new PeriodTaxonomyInspection(
    provenance,
    records.slice(0, 10),
  );

  return { records, provenance, inspection };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  const { records, provenance, inspection } = await runNormalizer(options);

  if (options.inspect || options.format === "inspect") {
    console.log(inspectReport(inspection, cliInspectOptions()));
    if (options.outputPath) {
      const outPath = resolve(options.outputPath);
      const metaPath = outPath.replace(/(\.json)?$/i, "_meta.json");

      await Bun.write(outPath, JSON.stringify(records, null, 2));
      await Bun.write(metaPath, JSON.stringify(provenance, null, 2));

      console.log(
        `\n[Normalizer] Wrote ${records.length} records to: ${outPath}`,
      );
      console.log(`[Normalizer] Wrote provenance metadata to:   ${metaPath}`);
    }
    return;
  }

  console.log(`[Normalizer] Processing: ${options.inputPath}`);
  console.log(
    `[Normalizer] Mode: ${options.mode} (${DATE_FAMILIES[options.mode].family}) | Period: ${options.period} (${PORTAL_PERIOD_LABELS[options.period]}) | Engine: ${options.engine}`,
  );

  console.log(`\n=== Provenance & Date Window Metadata ===`);
  console.log(`Mode:            ${provenance.reportMode}`);
  console.log(`Date Family:     ${provenance.dateFamily}`);
  console.log(
    `Date Fields:     ${JSON.stringify(
      Object.fromEntries(
        Object.entries(provenance.dateFields).filter(([, v]) => v !== null),
      ),
    )}`,
  );
  console.log(
    `Period Filter:   [${provenance.period}] ${provenance.portalPeriodLabel}`,
  );
  console.log(`Engine:          ${provenance.engineFilter}`);
  console.log(
    `Total Universe:  ${provenance.stats.totalProcessed.toLocaleString()} wagers`,
  );
  console.log(
    `Matched Rows:    ${provenance.stats.matchedRows.toLocaleString()} wagers`,
  );
  console.log(
    `Total Risk:      $${provenance.stats.totalRisk.toLocaleString("en-US", {
      minimumFractionDigits: 2,
    })}`,
  );
  console.log(
    `Average Risk:    $${provenance.stats.avgRisk.toLocaleString("en-US", {
      minimumFractionDigits: 2,
    })}`,
  );

  console.log(`\n=== Taxonomy Breakdown (Engine | Code | Label | Market) ===`);
  const detailed = provenance.stats.detailedBreakdown ?? {};
  const breakdownRows = Object.values(detailed)
    .map((row) => ({
      engine: row.engine,
      code: row.code,
      label: row.label,
      market: row.market,
      count: row.count,
      risk: `$${row.risk.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      avg: `$${(row.count > 0 ? row.risk / row.count : 0).toLocaleString(
        "en-US",
        {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        },
      )}`,
    }))
    .sort(
      (a, b) =>
        a.engine.localeCompare(b.engine) ||
        (a.code === "∅" ? 99 : Number(a.code)) -
          (b.code === "∅" ? 99 : Number(b.code)) ||
        a.market.localeCompare(b.market),
    );
  console.table(breakdownRows);

  if (options.outputPath) {
    const outPath = resolve(options.outputPath);
    const metaPath = outPath.replace(/(\.json)?$/i, "_meta.json");

    await Bun.write(outPath, JSON.stringify(records, null, 2));
    await Bun.write(metaPath, JSON.stringify(provenance, null, 2));

    console.log(
      `\n[Normalizer] Wrote ${records.length} records to: ${outPath}`,
    );
    console.log(`[Normalizer] Wrote provenance metadata to:   ${metaPath}`);
  }

  if (options.sqlitePath) {
    console.log(
      `\n[Normalizer] Ingested ${records.length} records into SQLite: ${resolve(options.sqlitePath)}`,
    );
  } else if (!options.outputPath && options.format === "json") {
    console.log(
      JSON.stringify({ provenance, sample: records.slice(0, 5) }, null, 2),
    );
  }
}

if (import.meta.main) {
  await main();
}
