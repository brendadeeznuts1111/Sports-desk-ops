import { describe, expect, test } from "bun:test";
import {
  branchState,
  formatMatrixEvidenceTable,
  formatMatrixRowEvidence,
  MATRIX_BRANCHES,
} from "../packages/ui/src/build_matrix_evidence.ts";
import type { BuildMatrixRow } from "../packages/ui/src/types.ts";

const PROD: BuildMatrixRow = {
  target: "prod",
  features: ["PROD", "ANALYTICS"],
  totalJsBytes: 40960,
  totalCssBytes: 8192,
  hasProdSentinel: true,
  hasDebugSentinel: false,
  hasExperimentalSentinel: false,
};

const DEV: BuildMatrixRow = {
  target: "dev",
  features: ["DEBUG", "TEST", "ANALYTICS", "EXPERIMENTAL"],
  totalJsBytes: 81920,
  totalCssBytes: 8192,
  hasProdSentinel: false,
  hasDebugSentinel: true,
  hasExperimentalSentinel: true,
};

const TEST_ROW: BuildMatrixRow = {
  target: "test",
  features: ["DEBUG", "TEST", "ANALYTICS"],
  totalJsBytes: 81936,
  totalCssBytes: 8192,
  hasProdSentinel: false,
  hasDebugSentinel: true,
  hasExperimentalSentinel: false,
};

describe("build_matrix_evidence · branch state", () => {
  test("reports kept and pruned per probe", () => {
    expect(MATRIX_BRANCHES.map((b) => branchState(PROD, b))).toEqual([
      "kept",
      "pruned",
      "pruned",
    ]);
    expect(MATRIX_BRANCHES.map((b) => branchState(DEV, b))).toEqual([
      "pruned",
      "kept",
      "kept",
    ]);
  });
});

describe("build_matrix_evidence · row line", () => {
  test("quotes exact bytes, delta and retention in one line", () => {
    expect(formatMatrixRowEvidence(PROD, DEV.totalJsBytes)).toBe(
      "prod · flags=PROD, ANALYTICS · js=40960B · css=8192B · total=49152B · deltaVsDev=-40960B (-50.0%) · branches: PROD=kept, DEBUG=pruned, EXPERIMENTAL=pruned",
    );
  });

  test("marks the baseline row and a missing baseline", () => {
    expect(formatMatrixRowEvidence(DEV, DEV.totalJsBytes)).toContain(
      "deltaVsDev=baseline",
    );
    expect(formatMatrixRowEvidence(DEV, null)).toContain("deltaVsDev=n/a");
  });

  test("annotates unregistered flags instead of pretending they are known", () => {
    const line = formatMatrixRowEvidence(
      { ...PROD, features: ["PROD", "TURBO"] },
      DEV.totalJsBytes,
    );
    expect(line).toContain("flags=PROD, TURBO(unregistered)");
  });

  test("an empty flag list reads as none", () => {
    expect(formatMatrixRowEvidence({ ...PROD, features: [] }, null)).toContain(
      "flags=none",
    );
  });
});

describe("build_matrix_evidence · table", () => {
  test("renders probe metadata plus a row per target", () => {
    const table = formatMatrixEvidenceTable([PROD, DEV], DEV.totalJsBytes, {
      target: "unbundled-hmr",
      generatedAt: "2026-11-16T03:30:00.000Z",
      compiledMs: 80.4,
    });
    const lines = table.split("\n");
    expect(lines[0]).toBe(
      "DCE matrix · runtime target=unbundled-hmr · probe=2026-11-16T03:30:00.000Z · compiled=80ms",
    );
    expect(lines[2]).toBe(
      "| target | flags | JS | CSS | total | Δ vs dev | PROD | DEBUG | EXPERIMENTAL |",
    );
    expect(lines[3]).toBe(
      "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
    );
    expect(lines[4]).toBe(
      "| prod | PROD, ANALYTICS | 40.0 KB | 8.0 KB | 48.0 KB | -40.0 KB (-50.0%) | kept | pruned | pruned |",
    );
    expect(lines[5]).toBe(
      "| dev | DEBUG, TEST, ANALYTICS, EXPERIMENTAL | 80.0 KB | 8.0 KB | 88.0 KB | baseline | pruned | kept | kept |",
    );
  });

  test("omits metadata fields that were not measured", () => {
    const table = formatMatrixEvidenceTable([TEST_ROW], null);
    expect(table.split("\n")[0]).toBe("DCE matrix");
  });

  test("an empty probe is an explicit note, not an empty table", () => {
    expect(formatMatrixEvidenceTable([], null)).toBe(
      "DCE matrix\n\n(no target rows in the probe)",
    );
  });
});
