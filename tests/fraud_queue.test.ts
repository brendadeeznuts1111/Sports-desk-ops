import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { loadFraudPerception } from "../lib/fraud_logs.ts";
import type { FraudFinding } from "../lib/fraud_logs.ts";
import { runFraudPatterns } from "../lib/fraud_patterns.ts";
import { buildFraudQueue } from "../lib/fraud_queue.ts";
import {
  CLI_PATH,
  FIXED_NOW_ISO,
  buildFixtureRoot,
  fixedNow,
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
});
