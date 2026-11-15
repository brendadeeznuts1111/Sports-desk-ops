import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brierScore,
  calibrationTable,
  containsUnhashedIp,
  ingestPullDirectory,
  JOIN_ASSUMPTIONS,
  linkAccounts,
  reportJoinCoverage,
  runReviewAnalysis,
  hashIp,
} from "../lib/f402_analyze.ts";
import { amountsMatch } from "../lib/f402_analyze_join.ts";
import {
  plantedBehaviourPull,
  writeSyntheticPull,
} from "./fixtures/f402-analyze/synthetic_pull.ts";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function behaviourTree(): string {
  return writeSyntheticPull(tempDir("f402-beh-"), plantedBehaviourPull());
}

describe("wager ingest and join", () => {
  test("joins weblog tickets to wagers and wagers to ledger with coverage", () => {
    const projection = ingestPullDirectory(behaviourTree());
    expect(projection.wagers.length).toBeGreaterThan(0);
    const { coverage, ticketJoins, ledgerJoins } =
      reportJoinCoverage(projection);
    expect(JOIN_ASSUMPTIONS.length).toBeGreaterThan(0);
    expect(ticketJoins.some((row) => row.ticket === "5001")).toBe(true);
    expect(ticketJoins.some((row) => row.ticket === "7001")).toBe(true);
    const ledger = ledgerJoins.find((row) => row.ticketNumber === "5001");
    expect(ledger?.confidence).toBe("document_number");
    expect(ledger?.ledgerDocumentNumber).toBe(4242);
    expect(coverage.weblogCoverage).toBeGreaterThan(0);
    expect(coverage.ledgerCoverage).toBeGreaterThan(0);
    expect(coverage.assumptions).toEqual([...JOIN_ASSUMPTIONS]);
  });

  test("amount matching accepts cents or dollars", () => {
    expect(amountsMatch(5000, 5000)).toBe(true);
    expect(amountsMatch(50, 5000)).toBe(true);
    expect(amountsMatch(5000, 50)).toBe(true);
    expect(amountsMatch(12, 99)).toBe(false);
  });
});

describe("bet-behaviour linking", () => {
  test("finds the planted steam ring and shared-parlay ring, not decoys", () => {
    const report = linkAccounts(ingestPullDirectory(behaviourTree()), {
      hashIp,
    });
    const steam = report.clusters.find(
      (cluster) =>
        cluster.accounts.includes("STEAM1") &&
        cluster.accounts.includes("STEAM2") &&
        cluster.accounts.includes("STEAM3"),
    );
    expect(steam).toBeDefined();
    expect(steam?.accounts.includes("SOLO")).toBe(false);
    expect(
      steam?.edges.some((edge) =>
        edge.evidence.some((item) => item.type === "steam_chase"),
      ),
    ).toBe(true);
    const parlay = report.clusters.find(
      (cluster) =>
        cluster.accounts.includes("PAR1") && cluster.accounts.includes("PAR2"),
    );
    expect(parlay).toBeDefined();
    expect(parlay?.accounts.includes("PAR3")).toBe(false);
    expect(
      parlay?.edges.some((edge) =>
        edge.evidence.some((item) => item.type === "shared_parlay_legs"),
      ),
    ).toBe(true);
    for (const cluster of report.clusters) {
      expect(cluster.label).toBe("evidence-scored guess");
      expect(
        cluster.accounts.includes("SOLO") &&
          cluster.accounts.includes("STEAM1"),
      ).toBe(false);
      expect(
        cluster.accounts.includes("PAR3") && cluster.accounts.includes("PAR1"),
      ).toBe(false);
    }
  });
});

describe("calibration math", () => {
  test("Brier score and calibration table match known vectors", () => {
    const predicted = [0.2, 0.8, 0.8, 0.2];
    const observed = [0, 1, 1, 0];
    expect(brierScore(predicted, observed)).toBe(0.04);
    const bins = calibrationTable(predicted, observed, 0.1, 2);
    const low = bins.find((bin) => bin.lo === 0.2);
    const high = bins.find((bin) => bin.lo === 0.8);
    expect(low?.count).toBe(2);
    expect(low?.observedRate).toBe(0);
    expect(low?.predictedMean).toBe(0.2);
    expect(high?.count).toBe(2);
    expect(high?.observedRate).toBe(1);
    expect(high?.predictedMean).toBe(0.8);
    expect(calibrationTable([0.05], [0], 0.1, 5)[0]?.lowSample).toBe(true);
  });
});

describe("review report", () => {
  test("writes hashed markdown with clusters, predictions, and evidence", () => {
    const root = behaviourTree();
    const { markdown, outPath } = runReviewAnalysis(root, {
      nowMs: Date.parse("2026-11-14T00:00:00.000Z"),
      horizonDays: 7,
    });
    const saved = readFileSync(outPath, "utf8");
    expect(saved).toContain("# Fantasy402 review");
    expect(saved).toContain("Top clusters");
    expect(saved).toContain("STEAM1");
    expect(saved).toContain("PAR1");
    expect(saved).toContain("evidence-scored guess");
    expect(saved).toContain("Join coverage");
    expect(saved).toContain("Calibration backtest");
    expect(saved).toContain("Brier");
    expect(containsUnhashedIp(saved)).toBe(false);
    expect(saved).not.toContain("203.0.113.80");
    expect(containsUnhashedIp(markdown)).toBe(false);
  });
});
