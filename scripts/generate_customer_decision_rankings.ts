/**
 * Deterministic generator for the Book-Wide Customer Decision-Instrument &
 * Systematic Pattern Ranking System (v3.0.0) across all 6,228 customers.
 *
 * Run:
 *   bun scripts/generate_customer_decision_rankings.ts
 */

import {
  buildAllCustomerDecisionRankingSystem,
  renderAllCustomerDecisionRankingMarkdown,
} from "../lib/f402_customer_decision_ranking.ts";
import type { GradedWagerRawRow } from "../lib/f402_ccc88412_decision_instrument.ts";
import type { ReportPlayerAnalysisRowRaw } from "../lib/f402_report_player_analysis.ts";

const PLAYER_ANALYSIS_PATH = "scratch/f402-player-analysis-all.json";
const BOT_DETAIL_PATH = "scratch/f402-suspected-bots-detail.json";
const GRADED_OCT_PATH = "/tmp/graded-oct-window.json";
const GRADED_TODAY_PATH = "/tmp/graded-today.json";
const FALLBACK_LEDGER_BUNDLE_PATH =
  "scratch/f402-suspected-bots-raw-ledger-bundle.json";

const OUT_JSON_PATH = "scratch/f402-customer-decision-rankings.json";
const OUT_MD_PATH = "scratch/f402-customer-decision-rankings.md";

function sha256Hex(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

async function loadGradedWagers(): Promise<GradedWagerRawRow[]> {
  const octFile = Bun.file(GRADED_OCT_PATH);
  const todayFile = Bun.file(GRADED_TODAY_PATH);
  if ((await octFile.exists()) && (await todayFile.exists())) {
    const octRaw = (await octFile.json()) as
      GradedWagerRawRow[] | { LIST?: GradedWagerRawRow[] };
    const todayRaw = (await todayFile.json()) as
      GradedWagerRawRow[] | { LIST?: GradedWagerRawRow[] };
    const octList = Array.isArray(octRaw) ? octRaw : (octRaw.LIST ?? []);
    const todayList = Array.isArray(todayRaw)
      ? todayRaw
      : (todayRaw.LIST ?? []);
    const map = new Map<string, GradedWagerRawRow>();
    for (const w of [...octList, ...todayList]) {
      if (!w.CustomerID || w.TicketNumber == null) continue;
      const key = `${String(w.CustomerID).trim()}|${w.TicketNumber}|${w.WagerNumber ?? 1}|${w.PlayNumber ?? 1}`;
      map.set(key, w);
    }
    return [...map.values()];
  }

  const fallbackFile = Bun.file(FALLBACK_LEDGER_BUNDLE_PATH);
  if (await fallbackFile.exists()) {
    const bundle = (await fallbackFile.json()) as {
      rawTicketLedgerForFlagged?: GradedWagerRawRow[];
      ccc88412GradedWagers?: GradedWagerRawRow[];
    };
    return (
      bundle.rawTicketLedgerForFlagged ?? bundle.ccc88412GradedWagers ?? []
    );
  }
  return [];
}

async function main() {
  const playerRaw = (await Bun.file(PLAYER_ANALYSIS_PATH).json()) as {
    LIST?: ReportPlayerAnalysisRowRaw[];
  };
  const allSummaryRows = playerRaw.LIST ?? [];

  const botDetailFile = Bun.file(BOT_DETAIL_PATH);
  let suspectedBotDetailRows: ReportPlayerAnalysisRowRaw[] = [];
  if (await botDetailFile.exists()) {
    const rawDetail = (await botDetailFile.json()) as {
      detailRows?: ReportPlayerAnalysisRowRaw[];
      LIST?: ReportPlayerAnalysisRowRaw[];
    };
    suspectedBotDetailRows = rawDetail.detailRows ?? rawDetail.LIST ?? [];
  }

  const gradedWagerRows = await loadGradedWagers();

  const system1 = buildAllCustomerDecisionRankingSystem({
    allSummaryRows,
    suspectedBotDetailRows,
    gradedWagerRows,
  });
  const system2 = buildAllCustomerDecisionRankingSystem({
    allSummaryRows,
    suspectedBotDetailRows,
    gradedWagerRows,
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

  console.log(
    JSON.stringify(
      {
        status: "OK",
        schemaVersion: system1.schemaVersion,
        bookPriors: system1.bookPriors,
        botFlagCohortSummary: system1.botFlagCohortSummary,
        gradedWagersLoaded: gradedWagerRows.length,
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
