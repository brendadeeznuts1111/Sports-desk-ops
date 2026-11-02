import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compareTotals,
  countedRows,
  matchesSelection,
  readAnalysisReport,
  recomputeTotals,
  type AnalysisReport,
} from "./analysis_report.ts";

const report = readAnalysisReport(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../data/analysis-cp-baseball-2026-11-01.json"),
      "utf8",
    ),
  ),
) as AnalysisReport;

describe("readAnalysisReport", () => {
  test("loads the pasted report", () => {
    expect(report.report).toBe("CP");
    expect(report.rows).toHaveLength(8);
    expect(report.context.agent).toBe("BILLY666");
    expect(report.context.sport).toBe("Baseball");
  });

  test("rejects foreign payloads", () => {
    expect(readAnalysisReport(null)).toBeNull();
    expect(readAnalysisReport({})).toBeNull();
    expect(readAnalysisReport({ report: "CP", rows: [] })).toBeNull();
    expect(readAnalysisReport({ report: "CP", rows: [{}] })).toBeNull();
  });
});

describe("duplicate rows", () => {
  test("the second KYM206 row is marked as a duplicate of TDFIRE", () => {
    const kym = report.rows.filter((row) => row.customer === "KYM206");
    expect(kym).toHaveLength(1);
    expect(kym[0]?.duplicateOf).toBe("TDFIRE");
    expect(kym[0]?.agentLogin).toBe("TDFIRE");
  });

  test("counted rows exclude it", () => {
    expect(report.rows).toHaveLength(8);
    expect(countedRows(report)).toHaveLength(7);
  });

  test("the bare TDFIRE row is not a duplicate", () => {
    const tdfire = report.rows.find(
      (row) => row.customer === "TDFIRE" && row.duplicateOf === null,
    );
    expect(tdfire?.risk).toBe(500);
  });
});

describe("recomputeTotals", () => {
  const totals = recomputeTotals(report);

  test("matches the pasted footer", () => {
    expect(totals).toEqual(report.totals);
  });

  test("accounts and wagers are the portal's own counts", () => {
    expect(totals.accounts).toBe(7);
    expect(totals.wagers).toBe(9);
  });

  test("risk is the seven distinct rows, not all eight", () => {
    // Eight rows sum to 15,750.00; the footer says 15,745.00 because one is a duplicate.
    expect(totals.risk).toBe(1574500);
    const allRows = report.rows.reduce((total, row) => total + row.risk, 0);
    expect(allRows).toBe(1575000);
  });

  test("hold is -Risk / Net, which is what the portal prints", () => {
    expect(totals.holdPercent).toBe(-58.33);
    expect(Number((-(totals.risk / totals.net) * 100).toFixed(2))).toBe(-58.33);
    // The naive Net / Risk gives +171.45 for this book, so the direction is not cosmetic.
    expect(Number(((totals.net / totals.risk) * 100).toFixed(2))).toBe(171.45);
  });

  test("per-row hold matches the portal for a winning and a losing account", () => {
    for (const row of report.rows) {
      const expected = Number((-(row.risk / row.net) * 100).toFixed(2));
      expect(row.holdPercent).toBe(expected);
    }
  });

  test("a flat book does not divide by zero", () => {
    const flat: AnalysisReport = {
      ...report,
      rows: [{ ...report.rows[0]!, risk: 100, net: 0 }],
      totals: { ...report.totals, risk: 100, net: 0, holdPercent: 0 },
    };
    expect(recomputeTotals(flat).holdPercent).toBe(0);
  });
});

describe("compareTotals", () => {
  test("the committed report is arithmetically consistent", () => {
    expect(compareTotals(report)).toEqual([]);
  });

  test("reports a drifted footer instead of hiding it", () => {
    const drifted: AnalysisReport = {
      ...report,
      totals: { ...report.totals, risk: report.totals.risk + 500 },
    };
    const issues = compareTotals(drifted);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("risk");
    expect(issues[0]?.stated).toBe(1575000);
    expect(issues[0]?.recomputed).toBe(1574500);
  });

  test("allows the portal's two-decimal rounding on hold only", () => {
    const rounded: AnalysisReport = {
      ...report,
      totals: { ...report.totals, holdPercent: -58.331 },
    };
    expect(compareTotals(rounded)).toEqual([]);
  });
});

describe("matchesSelection", () => {
  const base = {
    report: "CP",
    agent: "BILLY666",
    sport: "Baseball",
    week: "-1",
    activity: "0",
  };

  test("matches the recorded selection", () => {
    expect(matchesSelection(report, base)).toBe(true);
  });

  test("is case-insensitive on agent and sport", () => {
    expect(matchesSelection(report, { ...base, agent: "billy666" })).toBe(true);
    expect(matchesSelection(report, { ...base, sport: "baseball" })).toBe(true);
  });

  test("rejects a different sport or agent", () => {
    expect(matchesSelection(report, { ...base, sport: "Football" })).toBe(
      false,
    );
    expect(matchesSelection(report, { ...base, agent: "MJ2026" })).toBe(false);
  });

  test("rejects a different report kind", () => {
    expect(matchesSelection(report, { ...base, report: "CPS" })).toBe(false);
  });

  test("an unfiltered request only matches an unfiltered context", () => {
    expect(matchesSelection(report, { ...base, sport: "" })).toBe(false);
    expect(matchesSelection(report, { ...base, sport: "all" })).toBe(false);
  });
});
