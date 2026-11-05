#!/usr/bin/env bun
/**
 * Capture a fresh GSLive `getBetReport` corpus into the shape the fraud pipeline reads:
 * `{ r: { bets: [...] }, from, to }`, plus a sha256 sidecar and a capture manifest.
 *
 * Reuses `captureWagersSnapshot` so there is one GSLive fetch/session path. The blob/live-bets
 * gateway is a downstream sink for normalized events, not the raw row source.
 *
 * The session comes from the manager-session SSOT (keychain/session file). The cookie is never
 * printed. A failed or empty capture never overwrites the previous corpus.
 *
 * Usage:
 *   bun run capture:gslive-corpus --hours 6
 *   bun run capture:gslive-corpus --from 1793000000 --to 1793020000 --dry-run
 */

import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  bootstrapGanchrowSession,
  type DateFilterBy,
} from "../fetch-bet-tally.ts";
import { captureWagersSnapshot } from "../gslive_wagers_by_state.ts";
import {
  resolveManagerSession,
  sessionGateFromEnv,
} from "../../lib/manager_session.ts";

export const DEFAULT_CORPUS_REL_PATH =
  "Scratch/security/corpus/gslive-betreport-latest.json";
export const DEFAULT_SIDECAR_REL_PATH = "Scratch/security/corpus/sha256.txt";
export const DEFAULT_MANIFEST_REL_PATH =
  "Scratch/security/corpus/capture-manifest.json";

export interface CorpusDocument {
  readonly r: { readonly bets: readonly unknown[] };
  readonly e: 0;
  readonly d: "";
  readonly from: number;
  readonly to: number;
}

export function buildCorpusDocument(
  rows: readonly unknown[],
  fromEpochSec: number,
  toEpochSec: number,
): CorpusDocument {
  return {
    r: { bets: rows },
    e: 0,
    d: "",
    from: fromEpochSec,
    to: toEpochSec,
  };
}

export function sidecarLine(relativePath: string, sha256: string): string {
  return `${sha256}  ${relativePath}\n`;
}

function usage(): string {
  return [
    "capture:gslive-corpus — write a fresh GSLive getBetReport corpus",
    "",
    "Options:",
    "  --hours <n>        Window length ending now (default 6)",
    "  --from <epoch>     Window start (overrides --hours)",
    "  --to <epoch>       Window end (default now)",
    "  --date-filter-by   logTime | betTime | calcTime (default logTime)",
    "  --out <path>       Corpus path (default Scratch/security/corpus/gslive-betreport-latest.json)",
    "  --dry-run          Print the plan; no network, no writes",
    "  -h, --help         This text",
    "",
    "The session comes from the manager-session SSOT. The cookie is never printed.",
  ].join("\n");
}

interface Options {
  readonly hours: number;
  readonly from: number | null;
  readonly to: number | null;
  readonly dateFilterBy: DateFilterBy;
  readonly out: string;
  readonly dryRun: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let hours = 6;
  let from: number | null = null;
  let to: number | null = null;
  let dateFilterBy: DateFilterBy = "logTime";
  let out = DEFAULT_CORPUS_REL_PATH;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) break;
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "-h" || flag === "--help") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case "--hours":
        hours = Number(value);
        break;
      case "--from":
        from = Number(value);
        break;
      case "--to":
        to = Number(value);
        break;
      case "--date-filter-by":
        if (
          value !== "logTime" &&
          value !== "betTime" &&
          value !== "calcTime"
        ) {
          throw new Error("--date-filter-by must be logTime|betTime|calcTime");
        }
        dateFilterBy = value;
        break;
      case "--out":
        out = value;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
    index += 1;
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("--hours must be a positive number <= 720");
  }
  if (from !== null && !Number.isFinite(from)) {
    throw new Error("--from must be epoch seconds");
  }
  if (to !== null && !Number.isFinite(to)) {
    throw new Error("--to must be epoch seconds");
  }
  return { hours, from, to, dateFilterBy, out, dryRun };
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const nowSec = Math.floor(Date.now() / 1000);
  const toEpochSec = options.to ?? nowSec;
  const fromEpochSec =
    options.from ?? Math.max(0, toEpochSec - Math.round(options.hours * 3600));
  if (fromEpochSec > toEpochSec) {
    throw new Error("--from must be <= --to");
  }

  if (options.dryRun) {
    console.error(
      JSON.stringify(
        {
          url: "https://plive.sportswidgets.pro/manager-tools/ajax.php",
          action: "getBetReport",
          state: "",
          dateFilterBy: options.dateFilterBy,
          from: fromEpochSec,
          to: toEpochSec,
          out: options.out,
        },
        null,
        2,
      ),
    );
    return;
  }

  const session = await resolveManagerSession();
  if (session.source === "none") {
    throw new Error(
      "No GSLive manager session. Provision it with `bun run secrets:gslive set` or the SSOT environment; never paste a cookie.",
    );
  }
  let sessionGate = sessionGateFromEnv(Bun.env);
  if (sessionGate === "") {
    try {
      sessionGate = await bootstrapGanchrowSession({
        cookieHeader: session.cookieHeader,
      });
    } catch {
      // The cookie alone is enough on some days; the fetch will fail closed if not.
    }
  }

  // Reuse the live wagers pipeline so the session, fetch, normalization and retry semantics are
  // the same ones the scheduled capture uses. `rawRows` is the untouched getBetReport table.
  const snapshot = await captureWagersSnapshot({
    fromEpochSec,
    toEpochSec,
    cookieHeader: session.cookieHeader,
    sessionGate,
    dateFilterBy: options.dateFilterBy,
  });
  const rows = snapshot.rawRows;
  if (rows.length === 0) {
    throw new Error(
      "getBetReport returned zero rows; refusing to overwrite the previous corpus",
    );
  }

  const document = buildCorpusDocument(rows, fromEpochSec, toEpochSec);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const sha256 = Bun.CryptoHasher.hash("sha256", text, "hex");
  const root = resolve(import.meta.dir, "../..");
  const outPath = resolve(root, options.out);
  const sidecarPath = join(root, DEFAULT_SIDECAR_REL_PATH);
  const manifestPath = join(root, DEFAULT_MANIFEST_REL_PATH);
  const capturedAt = new Date().toISOString();
  const relativeOut = relative(root, outPath).split("\\").join("/");

  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  await Bun.write(tmpPath, text);
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, outPath);
  await mkdir(dirname(sidecarPath), { recursive: true });
  await Bun.write(sidecarPath, sidecarLine(relativeOut, sha256));
  await Bun.write(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "gslive-corpus-capture",
        capturedAt,
        source: "plive.sportswidgets.pro/manager-tools/ajax.php getBetReport",
        sessionSource: session.source,
        dateFilterBy: options.dateFilterBy,
        from: fromEpochSec,
        to: toEpochSec,
        rows: rows.length,
        sha256,
        path: relativeOut,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    JSON.stringify(
      {
        path: relativeOut,
        rows: rows.length,
        from: new Date(fromEpochSec * 1000).toISOString(),
        to: new Date(toEpochSec * 1000).toISOString(),
        sha256,
        sessionSource: session.source,
        manifest: DEFAULT_MANIFEST_REL_PATH,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `capture:gslive-corpus: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
