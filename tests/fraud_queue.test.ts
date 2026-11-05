import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openReviewDb, recordFlagReview } from "../cli/review.ts";
import { loadFraudPerception } from "../lib/fraud_logs.ts";
import type { FraudFinding } from "../lib/fraud_logs.ts";
import { fitFraudModel, writeFraudModelArtifact } from "../lib/fraud_model.ts";
import { runFraudPatterns } from "../lib/fraud_patterns.ts";
import { buildFraudQueue } from "../lib/fraud_queue.ts";
import {
  CLI_PATH,
  CORPUS_PRIMARY_REL,
  FIXED_NOW_ISO,
  buildFixtureRoot,
  buildSyntheticRoot,
  fixedNow,
  sha256Of,
  writeAt,
} from "./fixtures/fraud/support.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function track(root: string): string {
  roots.push(root);
  return root;
}

interface CliResult {
  readonly code: number;
  readonly body: Record<string, unknown>;
  readonly stderr: string;
}

function runCli(root: string, args: readonly string[]): CliResult {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      "--json",
      "--root",
      root,
      "--now",
      FIXED_NOW_ISO,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdout);
    body =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    body = { unparseableStdout: stdout.slice(0, 200) };
  }
  return {
    code: proc.exitCode ?? -1,
    body,
    stderr: proc.stderr.toString(),
  };
}

function accountFinding(
  id: string,
  severity: FraudFinding["severity"],
  category: FraudFinding["category"],
  account: string,
): FraudFinding {
  return {
    id,
    title: `synthetic ${id}`,
    severity,
    category,
    subject: { kind: "account", id: account },
    observed: { synthetic: true },
    threshold: null,
    evidence: [],
    provenance: ["fixture"],
    explanation: "synthetic finding for the queue test",
    insufficientData: false,
  };
}

describe("fraud priority queue (lib)", () => {
  test("eligibility, ranks and determinism over the crafted corpus", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({ root, now: fixedNow() });
    const corpus = perception.corpus;
    expect(corpus).not.toBeNull();
    if (corpus === null) return;
    const findings = runFraudPatterns(perception).findings;

    const first = buildFraudQueue({ corpus, findings, limit: 100 });
    const second = buildFraudQueue({ corpus, findings, limit: 100 });
    expect(second).toEqual(first);
    expect(first.rows.length).toBe(first.totals.returned);
    expect(first.totals.eligible).toBeGreaterThanOrEqual(first.rows.length);
    expect(first.totals.accounts).toBe(corpus.accounts);
    expect(first.rows.map((row) => row.rank)).toEqual(
      first.rows.map((_row, index) => index + 1),
    );

    for (const row of first.rows) {
      expect(row.flagRows > 0 || row.findings.total > 0).toBe(true);
      expect(row.reasons.length).toBeGreaterThan(0);
    }
    for (let index = 1; index < first.rows.length; index += 1) {
      const previous = first.rows[index - 1]!;
      const current = first.rows[index]!;
      expect(previous.deskFlagRows).toBeGreaterThanOrEqual(
        current.deskFlagRows,
      );
    }
  });

  test("account findings rank a flagged account and data-quality findings are ignored", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({ root, now: fixedNow() });
    const corpus = perception.corpus;
    if (corpus === null) throw new Error("fixture corpus missing");
    const real = runFraudPatterns(perception).findings;
    const before = buildFraudQueue({ corpus, findings: real, limit: 100 });

    const synthetic: FraudFinding[] = [
      accountFinding("SYNTH-CRITICAL", "critical", "multi_accounting", "U001"),
      accountFinding("SYNTH-QUALITY", "critical", "data_quality", "U002"),
    ];
    const after = buildFraudQueue({
      corpus,
      findings: [...real, ...synthetic],
      limit: 100,
    });
    const u001 = after.rows.find((row) => row.account === "U001");
    expect(u001).toBeDefined();
    expect(u001?.findings.critical).toBe(1);
    expect(u001?.findings.total).toBe(1);
    expect(u001?.categories).toEqual(["multi_accounting"]);
    expect(u001?.reasons).toContain("1 critical finding");
    expect(after.totals.eligible).toBeGreaterThanOrEqual(
      before.totals.eligible,
    );
    for (const row of after.rows) {
      expect(row.categories).not.toContain("data_quality");
    }
  });

  test("model scores fill the model column and never invent scores", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({ root, now: fixedNow() });
    const corpus = perception.corpus;
    if (corpus === null) throw new Error("fixture corpus missing");
    const findings = runFraudPatterns(perception).findings;
    const seen: string[] = [];
    const withScores = buildFraudQueue({
      corpus,
      findings,
      limit: 100,
      model: {
        present: true,
        fittedAt: FIXED_NOW_ISO,
        proxy: "desk_flag",
        corpusSha256: null,
      },
      scoreOf: (account) => {
        seen.push(account);
        return { score: 50, band: "medium" };
      },
    });
    expect(withScores.model).toEqual({
      present: true,
      fittedAt: FIXED_NOW_ISO,
      proxy: "desk_flag",
      corpusSha256: null,
    });
    expect(withScores.totals.scored).toBe(withScores.rows.length);
    for (const row of withScores.rows) {
      expect(row.model).toEqual({ score: 50, band: "medium" });
      expect(row.reasons).toContain("model score 50 (medium)");
    }
    expect(new Set(seen).size).toBe(withScores.totals.eligible);

    const withoutScores = buildFraudQueue({
      corpus,
      findings,
      limit: 100,
      model: { present: false, reason: "no artifact" },
    });
    expect(withoutScores.totals.scored).toBe(0);
    for (const row of withoutScores.rows) {
      expect(row.model).toBeNull();
      expect(
        row.reasons.some((reason) => reason.startsWith("model score")),
      ).toBe(false);
    }
  });

  test("limit bounds the returned rows", async () => {
    const root = track(buildFixtureRoot());
    const perception = await loadFraudPerception({ root, now: fixedNow() });
    const corpus = perception.corpus;
    if (corpus === null) throw new Error("fixture corpus missing");
    const findings = runFraudPatterns(perception).findings;
    expect(buildFraudQueue({ corpus, findings, limit: 0 }).rows).toEqual([]);
    expect(buildFraudQueue({ corpus, findings, limit: 2 }).rows).toHaveLength(
      2,
    );
    expect(
      buildFraudQueue({ corpus, findings, limit: 1_000 }).rows.length,
    ).toBeLessThanOrEqual(100);
  });
});

describe("fraud priority queue (CLI)", () => {
  test("queue --json reports rows, totals and sources without a fitted model", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["queue", "--limit", "5"]);
    expect(result.code).toBe(0);
    const body = result.body;
    expect(body.success).toBe(true);
    expect(body.command).toBe("queue");
    expect(body.model).toEqual({ present: false, reason: expect.any(String) });
    const rows = body.rows as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as { rank: number }[]).map((row) => row.rank)).toEqual(
      (rows as unknown[]).map((_row, index) => index + 1),
    );
    expect((body.totals as { returned: number }).returned).toBe(rows.length);
    expect(Array.isArray(body.sources)).toBe(true);
  });

  test("queue rejects out-of-range and unknown flags as usage errors", () => {
    const root = track(buildFixtureRoot());
    for (const args of [
      ["queue", "--limit", "0"],
      ["queue", "--limit", "101"],
      ["queue", "--limit", "nope"],
      ["queue", "--bogus"],
    ] as const) {
      const result = runCli(root, args);
      expect(result.code).toBe(2);
      expect((result.body.error as { code: string }).code).toBe("usage_error");
    }
  });

  test("queue is deterministic for the same root and clock", () => {
    const root = track(buildFixtureRoot());
    const first = runCli(root, ["queue", "--limit", "10"]).body;
    const second = runCli(root, ["queue", "--limit", "10"]).body;
    expect(second.rows).toEqual(first.rows);
    expect(second.totals).toEqual(first.totals);
    expect(second.model).toEqual(first.model);
  });

  test("queue build --dry-run exits 1 with every readiness blocker and no rows", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["queue", "build", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.body.success).toBe(false);
    const error = result.body.error as {
      code: string;
      details: {
        readiness: {
          ready: boolean;
          blockers: { name: string }[];
          ruleApplication: {
            applied: string[];
            notApplied: { rule: string; reason: string; n: number }[];
            blockers: { name: string }[];
          };
        };
        bridge: {
          coverage: {
            value: number;
            matched: number;
            total: number;
            evidence: string;
            artifactReason: string | null;
          };
          representativeness: {
            representative: boolean | null;
            reason?: string;
          };
        };
        inputs: {
          bridgeCoverage: number | null;
          bridgeRepresentative: boolean | null;
          confirmedReviews: number;
          rules: { rule: string; confirmedReviews: number }[];
        };
      };
    };
    expect(error.code).toBe("queue_not_ready");
    expect(error.details.readiness.ready).toBe(false);
    expect(
      error.details.readiness.blockers.map((blocker) => blocker.name),
    ).toEqual([
      "corpusFreshness",
      "modelFreshness",
      "bridgeRepresentativeness",
      "reviewRows",
    ]);
    expect(error.details.inputs.bridgeCoverage).toBeCloseTo(102 / 2586, 12);
    expect(error.details.inputs.bridgeRepresentative).toBeNull();
    expect(error.details.inputs.confirmedReviews).toBe(0);
    expect(error.details.bridge.coverage).toMatchObject({
      matched: 102,
      total: 2586,
      evidence: "committed-baseline",
      artifactReason: "missing",
    });
    expect(error.details.bridge.coverage.value).toBeCloseTo(102 / 2586, 12);
    expect(error.details.bridge.representativeness).toMatchObject({
      representative: null,
      reason: "missing",
    });
    expect(error.details.inputs.rules).toHaveLength(9);
    expect(error.details.readiness.ruleApplication.notApplied).toHaveLength(9);
    expect(
      error.details.readiness.ruleApplication.notApplied.every(
        (entry) => entry.n === 0 && entry.reason === "reviewedSampleSize",
      ),
    ).toBe(true);
    expect(
      error.details.readiness.ruleApplication.blockers.map(
        (blocker) => blocker.name,
      ),
    ).toEqual(["reviewRowsPerRule"]);
    expect(result.body.rows).toBeUndefined();
    expect(result.body.batch).toBeUndefined();
  });

  test("queue build requires --dry-run", () => {
    const root = track(buildFixtureRoot());
    const result = runCli(root, ["queue", "build"]);
    expect(result.code).toBe(2);
    expect((result.body.error as { code: string }).code).toBe("usage_error");
  });

  test("queue build counts confirmed flags per run, not just per seq", () => {
    const root = track(buildFixtureRoot());
    const dbPath = join(root, "reports/security/flags-review.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openReviewDb(dbPath);
    try {
      for (let seq = 0; seq < 3; seq += 1) {
        recordFlagReview(db, {
          runId: "run-a",
          seq,
          rule: "period_correlation",
          wagerNumbers: [String(seq)],
          verdict: "confirmed",
          reviewer: "analyst-a",
        });
      }
      // Same seq in a second run is a different flag; a double review of run-a/0 is not.
      for (let seq = 0; seq < 2; seq += 1) {
        recordFlagReview(db, {
          runId: "run-b",
          seq,
          rule: "period_correlation",
          wagerNumbers: [String(seq)],
          verdict: "confirmed",
          reviewer: "analyst-a",
        });
      }
      recordFlagReview(db, {
        runId: "run-a",
        seq: 0,
        rule: "period_correlation",
        wagerNumbers: ["0"],
        verdict: "confirmed",
        reviewer: "analyst-b",
      });
    } finally {
      db.close();
    }

    const result = runCli(root, ["queue", "build", "--dry-run"]);
    expect(result.code).toBe(1);
    const details = (
      result.body.error as {
        details: {
          inputs: {
            confirmedReviews: number;
            rules: { rule: string; confirmedReviews: number }[];
          };
          readiness: {
            ruleApplication: { applied: string[]; notApplied: unknown[] };
          };
        };
      }
    ).details;
    expect(details.inputs.confirmedReviews).toBe(5);
    expect(details.inputs.rules).toHaveLength(9);
    expect(
      details.inputs.rules.find((rule) => rule.rule === "period_correlation"),
    ).toEqual({ rule: "period_correlation", confirmedReviews: 5 });
    expect(details.readiness.ruleApplication.applied).toEqual([
      "period_correlation",
    ]);
    expect(details.readiness.ruleApplication.notApplied).toHaveLength(8);
    expect(
      (
        details.readiness.ruleApplication.notApplied as {
          n: number;
        }[]
      ).every((entry) => entry.n === 0),
    ).toBe(true);
  });

  test("the batch executes when fresh data and a study open every gate", async () => {
    const { root: created, corpus } = buildSyntheticRoot();
    const root = track(created);
    const nowSec = Math.floor(fixedNow().getTime() / 1000);
    const document = {
      r: { bets: corpus.rows },
      e: 0,
      d: "",
      from: nowSec - 7200,
      to: nowSec - 60,
    };
    writeAt(root, CORPUS_PRIMARY_REL, document);
    writeAt(
      root,
      "Scratch/security/corpus/sha256.txt",
      `${sha256Of(`${JSON.stringify(document, null, 2)}\n`)}  ${CORPUS_PRIMARY_REL}\n`,
    );

    const perception = await loadFraudPerception({ root, now: fixedNow() });
    if (perception.corpus === null) throw new Error("fixture corpus missing");
    const { artifact } = fitFraudModel({
      corpus: perception.corpus,
      config: perception.config,
      now: fixedNow(),
      options: {},
    });
    await writeFraudModelArtifact(root, artifact);

    const db = openReviewDb(join(root, "reports/security/flags-review.sqlite"));
    try {
      recordFlagReview(db, {
        runId: "batch-run",
        seq: 0,
        rule: "period_correlation",
        wagerNumbers: ["900000000"],
        verdict: "confirmed",
        reviewer: "test",
      });
    } finally {
      db.close();
    }

    writeAt(root, "reports/security/bridge-coverage.json", {
      schemaVersion: 1,
      kind: "queue-bridge-coverage",
      measuredAt: FIXED_NOW_ISO,
      population: "gslive-accounts",
      matched: 102,
      total: 2586,
    });
    writeAt(root, "reports/security/bridge-representativeness.json", {
      schemaVersion: 1,
      kind: "queue-bridge-representativeness",
      measuredAt: FIXED_NOW_ISO,
      corpusSha: artifact.corpusSha256,
      covered: { n: 34, precision: 0.71, wilson: [0.54, 0.84] },
      uncovered: { n: 21, precision: 0.62, wilson: [0.41, 0.79] },
      representative: true,
    });

    const result = runCli(root, ["queue", "build", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.body.success).toBe(true);
    expect(result.body.subcommand).toBe("build");
    expect(result.body.dryRun).toBe(true);

    const readiness = result.body.readiness as {
      ready: boolean;
      ruleApplication: { applied: string[]; notApplied: unknown[] };
    };
    expect(readiness.ready).toBe(true);
    expect(readiness.ruleApplication.applied).toEqual([]);
    expect(readiness.ruleApplication.notApplied).toHaveLength(9);

    const batch = result.body.batch as {
      rows: unknown[];
      totals: { eligible: number; returned: number };
      ruleApplication: {
        state: string;
        applied: string[];
        notApplied: unknown[];
      };
    };
    expect(batch.rows.length).toBeGreaterThan(0);
    expect(batch.totals.eligible).toBeGreaterThan(0);
    expect(batch.totals.returned).toBe(batch.rows.length);
    expect(batch.ruleApplication.state).toBe("not_applied");
    expect(batch.ruleApplication.applied).toEqual([]);
    expect(batch.ruleApplication.notApplied).toHaveLength(9);

    const inputs = result.body.inputs as {
      bridgeCoverage: number | null;
      bridgeRepresentative: boolean | null;
    };
    expect(inputs.bridgeCoverage).toBeCloseTo(102 / 2586, 12);
    expect(inputs.bridgeRepresentative).toBe(true);

    const bridge = result.body.bridge as {
      coverage: { value: number; matched: number; total: number };
      representativeness: { representative: boolean };
    };
    expect(bridge.coverage).toMatchObject({ matched: 102, total: 2586 });
    expect(bridge.coverage.value).toBeCloseTo(102 / 2586, 12);
    expect(bridge.representativeness.representative).toBe(true);
  });
});
