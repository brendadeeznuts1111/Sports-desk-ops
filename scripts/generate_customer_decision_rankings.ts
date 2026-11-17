/**
 * Deterministic generator for the Book-Wide Customer Decision-Instrument &
 * Systematic Pattern Ranking System (v3.0.0) across all 6,228 customers.
 *
 * Run:
 *   bun scripts/generate_customer_decision_rankings.ts
 *
 * Graded-wager exports
 * --------------------
 * `--graded-oct` / `--graded-today` are `getWagersByFigureDate` exports with `graded=1`, pulled
 * from the F402 manager. They are customer data and are not tracked here. The two files this
 * artifact was built from carry accepted dates 2026-02-08..2026-10-03 (62,146 rows) and
 * 2026-09-09..2026-11-13 (8,723 rows); the windows overlap and the loader dedupes on
 * customer|ticket|wager|play. A reviewer with portal access re-exports those windows; anyone can
 * confirm the bytes with:
 *
 *   shasum -a 256 scratch/graded/graded-oct-window.json scratch/graded/graded-today.json
 *
 * and comparing against `inputProvenance[].sha256` in the generated JSON. A hash without a
 * retrieval path would only prove that something was hashed.
 */

import {
  buildAllCustomerDecisionRankingSystem,
  renderAllCustomerDecisionRankingMarkdown,
} from "../lib/f402_customer_decision_ranking.ts";
import type { RankingInputProvenance } from "../lib/f402_customer_decision_ranking.ts";
import type { GradedWagerRawRow } from "../lib/f402_ccc88412_decision_instrument.ts";
import type { ReportPlayerAnalysisRowRaw } from "../lib/f402_report_player_analysis.ts";
import { projectRankingsSummary } from "./project_rankings_summary.ts";

function argValue(flag: string): string | null {
  const idx = Bun.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < Bun.argv.length ? Bun.argv[idx + 1]! : null;
}

const PLAYER_ANALYSIS_PATH =
  argValue("--player-analysis") ?? "scratch/f402-player-analysis-all.json";
const BOT_DETAIL_PATH =
  argValue("--bot-detail") ?? "scratch/f402-suspected-bots-detail.json";
const GRADED_OCT_PATH =
  argValue("--graded-oct") ?? "scratch/graded/graded-oct-window.json";
const GRADED_TODAY_PATH =
  argValue("--graded-today") ?? "scratch/graded/graded-today.json";
const FALLBACK_ARG = argValue("--graded-fallback");
const FALLBACK_LEDGER_BUNDLE_PATH =
  FALLBACK_ARG ?? "scratch/f402-suspected-bots-raw-ledger-bundle.json";

const OUT_JSON_PATH = "scratch/f402-customer-decision-rankings.json";
const OUT_MD_PATH = "scratch/f402-customer-decision-rankings.md";

function sha256Hex(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

interface GradedInput {
  readonly rows: GradedWagerRawRow[];
  readonly sources: ReadonlyArray<{ path: string; records: number }>;
}

function dedupeGradedWagers(lists: GradedWagerRawRow[][]): GradedWagerRawRow[] {
  const map = new Map<string, GradedWagerRawRow>();
  for (const w of lists.flat()) {
    if (!w.CustomerID || w.TicketNumber == null) continue;
    const key = `${String(w.CustomerID).trim()}|${w.TicketNumber}|${w.WagerNumber ?? 1}|${w.PlayNumber ?? 1}`;
    map.set(key, w);
  }
  return [...map.values()];
}

function parseGradedList(raw: unknown): GradedWagerRawRow[] {
  if (Array.isArray(raw)) return raw as GradedWagerRawRow[];
  const list = (raw as { LIST?: unknown } | null)?.LIST;
  return Array.isArray(list) ? (list as GradedWagerRawRow[]) : [];
}

async function loadGradedWagers(): Promise<GradedInput> {
  const octFile = Bun.file(GRADED_OCT_PATH);
  const todayFile = Bun.file(GRADED_TODAY_PATH);
  if ((await octFile.exists()) && (await todayFile.exists())) {
    const octList = parseGradedList(await octFile.json());
    const todayList = parseGradedList(await todayFile.json());
    return {
      rows: dedupeGradedWagers([octList, todayList]),
      sources: [
        { path: GRADED_OCT_PATH, records: octList.length },
        { path: GRADED_TODAY_PATH, records: todayList.length },
      ],
    };
  }

  if (FALLBACK_ARG === null) {
    throw new Error(
      `Graded-wager exports not found at ${GRADED_OCT_PATH} and ${GRADED_TODAY_PATH}. ` +
        `Pass --graded-oct/--graded-today, or --graded-fallback <bundle> to use the flagged-ledger bundle deliberately.`,
    );
  }

  const bundle = (await Bun.file(FALLBACK_LEDGER_BUNDLE_PATH).json()) as {
    rawTicketLedgerForFlagged?: GradedWagerRawRow[];
    ccc88412GradedWagers?: GradedWagerRawRow[];
  };
  const rows =
    bundle.rawTicketLedgerForFlagged ?? bundle.ccc88412GradedWagers ?? [];
  return {
    rows,
    sources: [{ path: FALLBACK_LEDGER_BUNDLE_PATH, records: rows.length }],
  };
}

async function describeInput(
  path: string,
  records: number,
): Promise<RankingInputProvenance> {
  const bytes = await Bun.file(path).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return {
    path,
    sha256: hasher.digest("hex"),
    bytes: bytes.byteLength,
    records,
  };
}

async function main() {
  const playerRaw = (await Bun.file(PLAYER_ANALYSIS_PATH).json()) as {
    LIST?: ReportPlayerAnalysisRowRaw[];
  };
  const allSummaryRows = playerRaw.LIST ?? [];
  if (allSummaryRows.length === 0) {
    throw new Error(
      `No customer summary rows in ${PLAYER_ANALYSIS_PATH}; refusing to emit an empty ranking artifact.`,
    );
  }

  const botDetailFile = Bun.file(BOT_DETAIL_PATH);
  let suspectedBotDetailRows: ReportPlayerAnalysisRowRaw[] = [];
  if (await botDetailFile.exists()) {
    const rawDetail = (await botDetailFile.json()) as {
      detailRows?: ReportPlayerAnalysisRowRaw[];
      LIST?: ReportPlayerAnalysisRowRaw[];
    };
    suspectedBotDetailRows = rawDetail.detailRows ?? rawDetail.LIST ?? [];
  }

  const graded = await loadGradedWagers();
  const gradedWagerRows = graded.rows;
  if (gradedWagerRows.length === 0) {
    console.error(
      `warning: ${graded.sources.map((s) => s.path).join(", ")} produced 0 usable graded rows; skin-hold and graded timing features will be empty.`,
    );
  }

  const inputProvenance: RankingInputProvenance[] = [
    await describeInput(PLAYER_ANALYSIS_PATH, allSummaryRows.length),
    ...(suspectedBotDetailRows.length > 0
      ? [await describeInput(BOT_DETAIL_PATH, suspectedBotDetailRows.length)]
      : []),
    ...(await Promise.all(
      graded.sources.map((s) => describeInput(s.path, s.records)),
    )),
  ];

  const system1 = buildAllCustomerDecisionRankingSystem({
    allSummaryRows,
    suspectedBotDetailRows,
    gradedWagerRows,
    inputProvenance,
  });
  const system2 = buildAllCustomerDecisionRankingSystem({
    allSummaryRows,
    suspectedBotDetailRows,
    gradedWagerRows,
    inputProvenance,
  });

  const json1 = `${JSON.stringify(system1, null, 2)}\n`;
  const json2 = `${JSON.stringify(system2, null, 2)}\n`;
  const md1 = renderAllCustomerDecisionRankingMarkdown(system1);
  const md2 = renderAllCustomerDecisionRankingMarkdown(system2);

  const jsonSha1 = sha256Hex(json1);
  const jsonSha2 = sha256Hex(json2);
  const mdSha1 = sha256Hex(md1);
  const mdSha2 = sha256Hex(md2);

  if (jsonSha1 !== jsonSha2 || mdSha1 !== mdSha2) {
    throw new Error(
      `Determinism oracle failed: JSON (${jsonSha1} vs ${jsonSha2}), MD (${mdSha1} vs ${mdSha2})`,
    );
  }

  if (!system1.conservationOracles.passed) {
    throw new Error(
      `Conservation oracles failed: ${JSON.stringify(system1.conservationOracles, null, 2)}`,
    );
  }

  await Bun.write(OUT_JSON_PATH, json1);
  await Bun.write(OUT_MD_PATH, md1);

  if (Bun.argv.includes("--project-summary")) {
    projectRankingsSummary({ check: false, policy: false });
  }

  console.log(
    JSON.stringify(
      {
        status: "OK",
        schemaVersion: system1.schemaVersion,
        bookPriors: system1.bookPriors,
        botFlagCohortSummary: system1.botFlagCohortSummary,
        gradedWagersLoaded: gradedWagerRows.length,
        inputProvenance: system1.inputProvenance,
        tierSummaries: system1.tierSummaries,
        ccc88412BenchmarkRow: system1.ccc88412BenchmarkRow,
        conservationOracles: system1.conservationOracles,
        jsonPath: OUT_JSON_PATH,
        jsonSha256: jsonSha1,
        mdPath: OUT_MD_PATH,
        mdSha256: mdSha1,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
