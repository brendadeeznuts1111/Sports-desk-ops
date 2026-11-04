#!/usr/bin/env bun
/**
 * @file bridge3d_census.ts
 * @description Reproducible Phase-1 census for Bridge 3d (graded/settled rows).
 *
 * Parses the four committed graded-wager HTML fixtures through the production parser
 * (`lib/f402_graded_wager_row.ts`), folds rows into counters in memory, and prints only aggregate
 * numbers — no row, identifier or raw field value. `--check <census.json>` recomputes the
 * `streams["3d-f402-graded"]` block and exits non-zero on drift, so the committed census is a gate,
 * not a transcription: `bun run census:3d:check`.
 *
 * Failure policy (matches docs/design/bridge3d_f402_graded.md): a missing fixture, an unparseable
 * row, or a drift against the record aborts with no partial numbers.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseGradedWagerRows,
  type GradedWagerRow,
} from "../lib/f402_graded_wager_row.ts";

const FIXTURE_PATTERN = /^f402-graded-wager-row.*\.html$/;
const DEFAULT_FIXTURES = "tests/fixtures";
const DEFAULT_CENSUS = "docs/design/census/2026-11-04.json";
const STREAM_KEY = "3d-f402-graded";

export interface GradedCensusFanout {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly p99_9: number;
  readonly p100: number;
}

export interface GradedCensus {
  readonly files: number;
  readonly rows: number;
  readonly wireFields: number;
  readonly nullableFields: Readonly<Record<string, number>>;
  readonly CmaxTickets: number;
  readonly Bmax: number;
  readonly BmaxDimensions: readonly string[];
  readonly fanout: GradedCensusFanout;
  readonly ticketNumberBits: number;
  readonly wagerSuffixBits: number;
  readonly freePlayFieldPresent: boolean;
  readonly loginFieldPresent: boolean;
  /** Raw populations retained for the design doc; not part of the drift check. */
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly wagerTypeCounts: Readonly<Record<string, number>>;
  readonly placedOnCounts: Readonly<Record<string, number>>;
}

/** Nearest-rank at `floor((n-1)p)`: the census convention that makes P100=2 with P99=1. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p)),
  );
  return sorted[index] ?? 0;
}

function bitLength(value: bigint): number {
  return value <= 0n ? 0 : value.toString(2).length;
}

function countBy(
  rows: readonly GradedWagerRow[],
  key: (row: GradedWagerRow) => string,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function wagerSuffix(wagerNumber: string): number | null {
  const match = /-(\d+)$/.exec(wagerNumber.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Compute the aggregate census from the fixture directory. Throws on no fixtures or any parse
 * failure; never returns partial numbers.
 */
export function computeGradedCensus(
  fixturesDir: string = DEFAULT_FIXTURES,
): GradedCensus {
  let names: string[];
  try {
    names = readdirSync(fixturesDir)
      .filter((name) => FIXTURE_PATTERN.test(name))
      .sort();
  } catch {
    throw new Error(
      `bridge3d_census: no graded fixtures in ${fixturesDir} (directory unreadable)`,
    );
  }
  if (names.length === 0) {
    throw new Error(`bridge3d_census: no graded fixtures in ${fixturesDir}`);
  }
  const rows: GradedWagerRow[] = [];
  for (const name of names) {
    const html = readFileSync(join(fixturesDir, name), "utf8");
    rows.push(...parseGradedWagerRows(html));
  }
  const fields = Object.keys(rows[0] ?? {}) as (keyof GradedWagerRow)[];
  const nullableFields: Record<string, number> = {};
  for (const field of fields) {
    const nulls = rows.filter((row) => row[field] === null).length;
    if (nulls > 0) nullableFields[field] = nulls;
  }

  const perTicket = new Map<string, number>();
  for (const row of rows) {
    perTicket.set(row.ticketNumber, (perTicket.get(row.ticketNumber) ?? 0) + 1);
  }
  const tickets = [...perTicket.keys()];
  const maxTicket = tickets.reduce(
    (max, ticket) => (BigInt(ticket) > max ? BigInt(ticket) : max),
    0n,
  );
  const sortedFanout = [...perTicket.values()].sort((a, b) => a - b);
  const suffixes = rows
    .map((row) => wagerSuffix(row.wagerNumber))
    .filter((value): value is number => value !== null);
  const maxSuffix = suffixes.reduce((max, value) => Math.max(max, value), 0);

  const bmaxKeys = new Set(
    rows.map((row) =>
      [
        row.wagerType,
        row.status,
        row.placedOn,
        row.league ?? "",
        row.market ?? "",
      ].join("\u0000"),
    ),
  );

  return {
    files: names.length,
    rows: rows.length,
    wireFields: fields.length,
    nullableFields,
    CmaxTickets: tickets.length,
    Bmax: bmaxKeys.size,
    BmaxDimensions: [
      "channel",
      "sport",
      "period",
      "wagerType",
      "settlementState",
    ],
    fanout: {
      p50: percentile(sortedFanout, 0.5),
      p95: percentile(sortedFanout, 0.95),
      p99: percentile(sortedFanout, 0.99),
      p99_9: percentile(sortedFanout, 0.999),
      p100: percentile(sortedFanout, 1),
    },
    ticketNumberBits: bitLength(maxTicket),
    wagerSuffixBits: bitLength(BigInt(maxSuffix)),
    freePlayFieldPresent: fields.some((field) =>
      /freeplay/i.test(String(field)),
    ),
    loginFieldPresent: fields.some((field) => /^login$/i.test(String(field))),
    statusCounts: countBy(rows, (row) => row.status),
    wagerTypeCounts: countBy(rows, (row) => row.wagerType),
    placedOnCounts: countBy(rows, (row) => row.placedOn),
  };
}

/** Fields the committed census records and the runner checks for drift. */
const CHECKED_FIELDS = [
  "files",
  "rows",
  "wireFields",
  "CmaxTickets",
  "Bmax",
  "fanout",
  "ticketNumberBits",
  "wagerSuffixBits",
  "freePlayFieldPresent",
  "loginFieldPresent",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare one computed field; returns a readable diff or null when equal. */
function diffField(
  field: (typeof CHECKED_FIELDS)[number],
  actual: unknown,
  expected: unknown,
): string | null {
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : `${field}: census=${JSON.stringify(expected)} measured=${JSON.stringify(actual)}`;
}

/** Compare against the committed census file's 3d block. */
export function compareGradedCensus(
  actual: GradedCensus,
  census: unknown,
): string[] {
  if (!isRecord(census) || !isRecord(census["streams"])) {
    return ["census file has no streams object"];
  }
  const expected = census["streams"][STREAM_KEY];
  if (!isRecord(expected)) {
    return [`census file has no streams["${STREAM_KEY}"] block`];
  }
  const diffs: string[] = [];
  for (const field of CHECKED_FIELDS) {
    if (!(field in expected)) {
      diffs.push(`${field}: missing from census record`);
      continue;
    }
    if (field === "fanout") {
      const a = actual.fanout as unknown as Record<string, number>;
      const e = expected["fanout"];
      if (!isRecord(e)) {
        diffs.push("fanout: census value is not an object");
        continue;
      }
      for (const key of ["p50", "p95", "p99", "p99_9", "p100"] as const) {
        const diff = diffField(field, a[key], e[key]);
        if (diff !== null) diffs.push(`${diff} [${key}]`);
      }
      continue;
    }
    const diff = diffField(
      field,
      actual[field as keyof GradedCensus],
      expected[field],
    );
    if (diff !== null) diffs.push(diff);
  }
  return diffs;
}

function readCensus(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `bridge3d_census: cannot read census ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function main(): void {
  const args = Bun.argv.slice(2);
  const checkIndex = args.indexOf("--check");
  const checkPath =
    checkIndex === -1 ? null : (args[checkIndex + 1] ?? DEFAULT_CENSUS);
  const fixturesIndex = args.indexOf("--fixtures");
  const fixturesDir =
    fixturesIndex === -1
      ? DEFAULT_FIXTURES
      : (args[fixturesIndex + 1] ?? DEFAULT_FIXTURES);

  let actual: GradedCensus;
  try {
    actual = computeGradedCensus(fixturesDir);
  } catch (error) {
    console.error(
      `bridge3d_census: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (checkPath === null) {
    console.log(JSON.stringify(actual, null, 2));
    return;
  }
  const diffs = compareGradedCensus(actual, readCensus(checkPath));
  if (diffs.length > 0) {
    console.error(`census:3d: DRIFT against ${checkPath}`);
    for (const diff of diffs) console.error(`  ${diff}`);
    process.exit(1);
  }
  console.log(
    `census:3d: ok — ${actual.files} files, ${actual.rows} rows, Cmax=${actual.CmaxTickets}, Bmax=${actual.Bmax}`,
  );
}

if (import.meta.main) main();
