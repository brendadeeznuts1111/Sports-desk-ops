import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { stableJson } from "../lib/f402_bet_ticker_delta.ts";
import { loadFraudConfig } from "../lib/fraud_logs.ts";
import {
  FRAUD_FEATURE_IDS,
  FRAUD_MODEL_FIT_COMMAND,
  FRAUD_MODEL_KIND,
  FRAUD_MODEL_LIMITS,
  FRAUD_HEADLINE_K,
  FRAUD_MODEL_REL_PATH,
  FRAUD_ROW_REVIEW_SIZES,
  FraudModelError,
  bandForScore,
  extractFraudFeatures,
  fitFraudModel,
  fraudModelArtifactDigest,
  modelMissingRefusal,
  modelReportPayload,
  rowPrecisionAtK,
  rowPrecisionAtKTable,
  readFraudModel,
  scoreAccountWithModel,
  scoreFromQuantiles,
  validateMetricMetadata,
  writeFraudModelArtifact,
  type FraudFitOptions,
  type FraudModelArtifact,
} from "../lib/fraud_model.ts";
import {
  parseFraudCorpus,
  type FraudBetRecord,
  type FraudCorpus,
} from "../lib/fraud_logs.ts";
import {
  BASE_EPOCH_SEC,
  CORPUS_PRIMARY_REL,
  buildSyntheticRoot,
  fixedNow,
  makeRoot,
  syntheticBetReport,
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

function corpusFromParsed(
  root: string,
  parsed: Awaited<ReturnType<typeof parseFraudCorpus>>,
): FraudCorpus {
  return {
    source: {
      id: "gslive_bet_report",
      label: "",
      path: CORPUS_PRIMARY_REL,
      exists: true,
      bytes: 0,
      mtimeIso: null,
      ageSeconds: 0,
      stale: false,
      provenance: "live-api",
      records: parsed.rows,
      sha256: null,
      state: "ok",
      note: "",
      reason: null,
    },
    path: join(root, CORPUS_PRIMARY_REL),
    sha256: null,
    rows: parsed.rows,
    malformed: parsed.malformed,
    records: parsed.records,
    window: parsed.window,
    ipIndex: {
      byIp: parsed.byIp,
      byPrefix24: parsed.byPrefix24,
      byAccount: parsed.byAccount,
      distinctIps: parsed.byIp.size,
    },
    accounts: parsed.accounts,
    agents: parsed.agents,
    parseMs: parsed.parseMs,
    timerSource: "mock",
  };
}

/** Parse a synthetic corpus document via a temp file (exercises normalization too). */
async function syntheticCorpus(
  rows: readonly Record<string, unknown>[],
  extraRows: readonly Record<string, unknown>[] = [],
): Promise<{
  root: string;
  corpus: FraudCorpus;
  records: readonly FraudBetRecord[];
}> {
  const root = track(makeRoot());
  const document = {
    r: { bets: [...rows, ...extraRows] },
    e: 0,
    d: "",
    from: BASE_EPOCH_SEC,
    to: BASE_EPOCH_SEC + 7 * 24 * 3600,
  };
  writeAt(root, CORPUS_PRIMARY_REL, document);
  const parsed = await parseFraudCorpus(join(root, CORPUS_PRIMARY_REL));
  return {
    root,
    corpus: corpusFromParsed(root, parsed),
    records: parsed.records,
  };
}

async function fullSynthetic(): Promise<{
  root: string;
  corpus: FraudCorpus;
  options: FraudFitOptions;
}> {
  const { root } = buildSyntheticRoot();
  track(root);
  const parsed = await parseFraudCorpus(join(root, CORPUS_PRIMARY_REL));
  const corpus = corpusFromParsed(root, parsed);
  const config = (await loadFraudConfig(root)).config;
  return {
    root,
    corpus,
    options: {
      proxy: config.model.proxy,
      split: config.model.split,
      l2: config.model.l2,
      epochs: config.model.epochs,
      learningRate: config.model.learningRate,
      seed: config.model.seed,
      minRows: config.model.minRows,
      minLabeledAccounts: config.model.minLabeledAccounts,
      calibrationBins: config.model.calibrationBins,
      scoreQuantiles: config.model.scoreQuantiles,
      scoreBands: config.model.scoreBands,
    },
  };
}

function featureIndex(id: string): number {
  const index = FRAUD_FEATURE_IDS.indexOf(id);
  if (index === -1) throw new Error(`unknown feature ${id}`);
  return index;
}

function valueOf(
  row: { values: readonly number[] } | undefined,
  id: string,
): number | undefined {
  if (row === undefined) return undefined;
  return row.values[featureIndex(id)];
}

/* -------------------------------------------------------------------------- */
/* Feature registry and leakage safety                                         */
/* -------------------------------------------------------------------------- */

describe("rowPrecisionAtK", () => {
  test("reports precision, recall and lift at a staffed queue size", () => {
    const scores = [0.9, 0.8, 0.7, 0.6, 0.5];
    const labels = [true, false, true, false, false];
    expect(rowPrecisionAtK(scores, labels, 2)).toEqual({
      k: 2,
      kSamples: 2,
      kPositives: 1,
      positives: 2,
      precision: 0.5,
      recall: 0.5,
      lift: 1.25,
    });
  });

  test("caps k at the holdout size instead of inventing rows", () => {
    const row = rowPrecisionAtK([0.9, 0.8], [true, false], 10);
    expect(row.k).toBe(10);
    expect(row.kSamples).toBe(2);
    expect(row.precision).toBe(0.5);
  });

  test("ties keep input order, so the table is deterministic", () => {
    const scores = [0.5, 0.5, 0.5];
    const labels = [false, true, false];
    expect(rowPrecisionAtK(scores, labels, 1).precision).toBe(0);
    expect(rowPrecisionAtK(scores, labels, 2).precision).toBe(0.5);
  });

  test("no positives reports zero precision and null recall/lift", () => {
    const row = rowPrecisionAtK([0.9, 0.8], [false, false], 1);
    expect(row.precision).toBe(0);
    expect(row.recall).toBeNull();
    expect(row.lift).toBeNull();
  });

  test("the table covers the operational queue sizes", () => {
    const rows = rowPrecisionAtKTable(
      [0.9, 0.8, 0.7],
      [true, false, true],
      [1, 2, 10],
    );
    expect(rows.map((row) => row.k)).toEqual([1, 2, 10]);
    expect(rows.map((row) => row.kSamples)).toEqual([1, 2, 3]);
  });
});

describe("validateMetricMetadata", () => {
  const validDefinitions = [
    { name: "rate", kind: "baseline", value: 0.5, population: "pop" },
    { name: "pop", kind: "population", rows: 24, positives: 12 },
    {
      name: "metric",
      kind: "metric",
      baselineRef: "rate",
      population: "pop",
      k: 20,
      maxAchievable: 0.6,
      kSamples: 20,
      kPositives: 12,
      detailRef: "metrics.metric",
    },
  ];

  test("baseline and population references resolve by kind", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: validDefinitions,
      }),
    ).not.toThrow();

    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "metric", kind: "metric", baselineRef: "missing" },
        ],
      }),
    ).toThrow(/missing/);

    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "rate", kind: "caveat" },
          { name: "metric", kind: "metric", baselineRef: "rate" },
        ],
      }),
    ).toThrow(/not baseline/);
  });

  test("a stored maxAchievable must match the population it names", () => {
    const definitions = validDefinitions.map((row) =>
      row.name === "metric" ? { ...row, maxAchievable: 0.5 } : row,
    );
    expect(() =>
      validateMetricMetadata({ schemaVersion: 2, definitions }),
    ).toThrow(/maxAchievable 0.5 != min\(k=20, positives=12\)\/k = 0.6/);
  });

  test("a baseline value must match positives/rows", () => {
    const definitions = validDefinitions.map((row) =>
      row.name === "rate" ? { ...row, value: 0.6 } : row,
    );
    expect(() =>
      validateMetricMetadata({ schemaVersion: 2, definitions }),
    ).toThrow(/value 0.6 != positives\/rows = 0.5/);
  });

  test("a missing reference suggests the nearest name", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "noPriorBetPositiveRate", kind: "baseline" },
          { name: "pop", kind: "population", positives: 12 },
          {
            name: "rowPrecisionAtKNoPriorBet",
            kind: "metric",
            baselineRef: "noPriorBetHoldout",
            population: "pop",
            k: 20,
            maxAchievable: 0.6,
          },
        ],
      }),
    ).toThrow(/did you mean "noPriorBetPositiveRate"/);
  });

  test("multiple close candidates are all shown", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "alphaRate", kind: "baseline" },
          { name: "alphaRateLong", kind: "baseline" },
          {
            name: "metric",
            kind: "metric",
            baselineRef: "alphaRat",
            population: "pop",
          },
        ],
      }),
    ).toThrow(/nearest: "alphaRate", "alphaRateLong"/);
  });

  test("detailRef must resolve in the report root", () => {
    expect(() =>
      validateMetricMetadata(
        { schemaVersion: 2, definitions: validDefinitions },
        { metrics: { metric: [] } },
      ),
    ).not.toThrow();
    expect(() =>
      validateMetricMetadata(
        { schemaVersion: 2, definitions: validDefinitions },
        { metrics: {} },
      ),
    ).toThrow(/detailRef/);
  });

  test("ranking metrics must carry top-k counts and detailRef", () => {
    const definitions = [
      { name: "rate", kind: "baseline", value: 0.5, population: "pop" },
      { name: "pop", kind: "population", rows: 24, positives: 12 },
      {
        name: "metric",
        kind: "metric",
        baselineRef: "rate",
        population: "pop",
        k: 20,
        maxAchievable: 0.6,
      },
    ];
    expect(() =>
      validateMetricMetadata({ schemaVersion: 2, definitions }),
    ).toThrow(/kSamples/);
  });

  test("not-measured detailRef resolves to a state container without metrics", () => {
    const definitions = [
      {
        name: "metric",
        kind: "metric",
        state: "not_measured",
        blockedBy: "feed",
        detailRef: "validation.noPriorBet",
      },
    ];
    expect(() =>
      validateMetricMetadata(
        { schemaVersion: 2, definitions },
        { validation: { noPriorBet: { state: "not_measured" } } },
      ),
    ).not.toThrow();
    expect(() =>
      validateMetricMetadata(
        { schemaVersion: 2, definitions },
        { validation: { noPriorBet: {} } },
      ),
    ).toThrow(/state "not_measured"/);
    expect(() =>
      validateMetricMetadata(
        { schemaVersion: 2, definitions },
        { validation: { noPriorBet: { state: "not_measured", metrics: {} } } },
      ),
    ).toThrow(/carries metrics/);
  });

  test("not-measured rows must say what blocks them", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "metric", kind: "metric", state: "not_measured" },
        ],
      }),
    ).toThrow(/blockedBy/);
  });

  test("refuses a stale schemaVersion", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 1,
        definitions: validDefinitions,
      }),
    ).toThrow(/schemaVersion/);
  });

  test("a measured metric with k must carry maxAchievable", () => {
    const definitions = validDefinitions.map((row) =>
      row.name === "metric"
        ? {
            name: "metric",
            kind: "metric",
            baselineRef: "rate",
            population: "pop",
            k: 20,
            kSamples: 20,
            kPositives: 12,
            detailRef: "metrics.metric",
          }
        : row,
    );
    expect(() =>
      validateMetricMetadata({ schemaVersion: 2, definitions }),
    ).toThrow(/maxAchievable/);
  });

  test("subsets and subsetOf must agree", () => {
    const definitions = [
      {
        name: "parent",
        kind: "population",
        rows: 10,
        positives: 1,
        subsets: ["child"],
      },
      { name: "child", kind: "population", rows: 5, positives: 1 },
    ];
    expect(() =>
      validateMetricMetadata({ schemaVersion: 2, definitions }),
    ).toThrow(/subsetOf/);
  });

  test("a unit or label must be declared in the vocabulary", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "m", kind: "metric", unit: "bet-row", description: "x" },
        ],
      }),
    ).toThrow(/vocabulary/);
  });

  test("duplicate definition names are refused", () => {
    expect(() =>
      validateMetricMetadata({
        schemaVersion: 2,
        definitions: [
          { name: "unit", kind: "parameter" },
          { name: "unit", kind: "parameter" },
        ],
      }),
    ).toThrow(/duplicate/);
  });
});

describe("leakage-safe feature extraction", () => {
  test("the frozen registry matches config/fraud-model.json", async () => {
    const config = (await Bun.file("config/fraud-model.json").json()) as {
      features: { id: string; kind: string }[];
    };
    expect(FRAUD_FEATURE_IDS).toHaveLength(26);
    expect(config.features.map((feature) => feature.id)).toEqual([
      ...FRAUD_FEATURE_IDS,
    ]);
    expect(
      config.features.filter((feature) => feature.kind === "snapshot"),
    ).toHaveLength(12);
    expect(
      config.features.filter((feature) => feature.kind === "history"),
    ).toHaveLength(14);
  });

  test("a later row cannot change an earlier row's features", async () => {
    const base = syntheticBetReport({
      rows: 12,
      accounts: 4,
      labeledAccounts: 2,
    });
    const earlier = await syntheticCorpus(base.rows);
    const laterRows = syntheticBetReport({
      rows: 3,
      accounts: 1,
      baseEpochSec: BASE_EPOCH_SEC + 12 * 60,
    }).rows;
    const withLater = await syntheticCorpus(base.rows, laterRows);

    const before = extractFraudFeatures(earlier.records);
    const after = extractFraudFeatures(withLater.records);
    expect(before.rows).toHaveLength(12);
    expect(after.rows).toHaveLength(15);
    for (let index = 0; index < before.rows.length; index += 1) {
      expect(after.rows[index]?.values).toEqual(before.rows[index]?.values);
      expect(after.rows[index]?.missing).toEqual(before.rows[index]?.missing);
      expect(after.rows[index]?.labels).toEqual(before.rows[index]?.labels);
    }
  });

  test("same-timestamp rows are featurized from the strictly-earlier prefix", async () => {
    const rows = syntheticBetReport({
      rows: 6,
      accounts: 2,
      labeledAccounts: 1,
    }).rows;
    // Rewrite timestamps so rows 1..4 share one timestamp and row 5..6 share the next.
    const timed = rows.map((row, index) => ({
      ...row,
      logTime: String(BASE_EPOCH_SEC + (index < 4 ? 0 : 60)),
    }));
    const { records } = await syntheticCorpus(timed);
    // Rows are sorted by timestamp then betId: U000,U001,U000,U001 at ts0, then U000,U001.
    for (const index of [0, 1, 2, 3]) {
      expect(
        valueOf(extractFraudFeatures(records).rows[index], "acct_prior_bets"),
      ).toBe(0);
    }
    const matrix = extractFraudFeatures(records);
    for (const index of [4, 5]) {
      expect(valueOf(matrix.rows[index], "acct_prior_bets")).toBe(2);
    }
  });

  test("history features use only rows with logTime < logTime_i", async () => {
    const rows = syntheticBetReport({
      rows: 6,
      accounts: 2,
      labeledAccounts: 1,
    }).rows;
    const { records } = await syntheticCorpus(rows);
    const matrix = extractFraudFeatures(records);
    // Row i (sorted by time) must see exactly i earlier rows.
    for (let index = 0; index < matrix.rows.length; index += 1) {
      expect(valueOf(matrix.rows[index], "acct_prior_bets")).toBe(
        Math.floor(index / 2),
      );
      // Synthetic IPs cycle every 4 rows, so the prior count is the number of earlier
      // rows in the same residue class.
      expect(valueOf(matrix.rows[index], "ip_prior_bets")).toBe(
        Math.floor(index / 4),
      );
      const priorSameAccountIps = new Set(
        rows
          .slice(0, index)
          .filter((_, priorIndex) => priorIndex % 2 === index % 2)
          .map((row) => String(row["ipAddress"])),
      );
      expect(valueOf(matrix.rows[index], "acct_prior_ip_count")).toBe(
        priorSameAccountIps.size,
      );
    }
  });

  test("line_hundredths is constant zero (capture has no line column)", async () => {
    const { records } = await syntheticCorpus(
      syntheticBetReport({ rows: 10, accounts: 2 }).rows,
    );
    const matrix = extractFraudFeatures(records);
    const index = featureIndex("line_hundredths");
    expect(matrix.rows.every((row) => row.values[index] === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Fit, determinism and metric honesty                                         */
/* -------------------------------------------------------------------------- */

describe("fraud model fit", () => {
  test("refuses an insufficient corpus with measured counts", async () => {
    const root = track(makeRoot());
    const config = (await loadFraudConfig(root)).config;
    const tiny = await syntheticCorpus(
      syntheticBetReport({ rows: 40, accounts: 4, labeledAccounts: 2 }).rows,
    );
    expect(() =>
      fitFraudModel({
        corpus: tiny.corpus,
        config,
        now: fixedNow(),
        options: {},
      }),
    ).toThrow(FraudModelError);
    try {
      fitFraudModel({
        corpus: tiny.corpus,
        config,
        now: fixedNow(),
        options: {},
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(FraudModelError);
      const refusal = error as FraudModelError;
      expect(refusal.code).toBe("insufficient_corpus");
      expect(refusal.details["rows"]).toBe(40);
      expect(Number(refusal.details["accountsWithProxyLabel"])).toBeLessThan(
        20,
      );
    }
  });

  test("is deterministic: two fits produce identical weights, metrics and score map", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const first = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    const second = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    expect(stableJson(second.artifact)).toBe(stableJson(first.artifact));
    expect(second.artifact.weights).toEqual(first.artifact.weights);
    expect(second.artifact.intercept).toBe(first.artifact.intercept);
    expect(second.artifact.metrics.aucRoc).toBe(first.artifact.metrics.aucRoc);
    expect(second.artifact.scoreMap.quantiles).toEqual(
      first.artifact.scoreMap.quantiles,
    );
  });

  test("splits temporally and reports both windows", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    expect(artifact.split).toBe(0.7);
    expect(artifact.metrics.rows.train).toBe(
      Math.floor(corpus.records.length * 0.7),
    );
    expect(artifact.metrics.rows.train + artifact.metrics.rows.holdout).toBe(
      corpus.records.length,
    );
    expect(artifact.metrics.trainWindow.toIso).not.toBeNull();
    expect(artifact.metrics.holdoutWindow.fromIso).not.toBeNull();
    expect(
      (artifact.metrics.trainWindow.toIso ?? "") <
        (artifact.metrics.holdoutWindow.fromIso ?? ""),
    ).toBe(true);
    expect(artifact.proxy).toBe("desk_flag");
  });

  test("reports honest metric ranges, support and calibration", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    const metrics = artifact.metrics;
    expect(metrics.aucRoc).not.toBeNull();
    expect(metrics.aucRoc ?? 0).toBeGreaterThanOrEqual(0);
    expect(metrics.aucRoc ?? 0).toBeLessThanOrEqual(1);
    expect(metrics.averagePrecision).not.toBeNull();
    expect(metrics.precisionAt1Pct ?? 0).toBeGreaterThanOrEqual(0);
    expect(metrics.precisionAt5Pct ?? 0).toBeLessThanOrEqual(1);
    expect(metrics.rowPrecisionAtK.map((row) => row.k)).toEqual([
      ...FRAUD_ROW_REVIEW_SIZES,
    ]);
    expect(
      metrics.rowPrecisionAtK.every(
        (row) =>
          row.precision === null || (row.precision >= 0 && row.precision <= 1),
      ),
    ).toBe(true);
    expect(artifact.validation.holdout.rowPrecisionAtK).toEqual(
      metrics.rowPrecisionAtK,
    );
    const noPriorBet = artifact.validation.noPriorBet;
    if (noPriorBet !== null) {
      expect(noPriorBet.rows).toBeGreaterThan(0);
      expect(noPriorBet.rows).toBeLessThanOrEqual(metrics.rows.holdout);
      expect(noPriorBet.positives).toBeLessThanOrEqual(noPriorBet.rows);
      expect(noPriorBet.metrics.rowPrecisionAtK).toHaveLength(
        FRAUD_ROW_REVIEW_SIZES.length,
      );
    }
    expect(metrics.brier ?? 1).toBeLessThanOrEqual(1);
    expect(metrics.calibrationBins).toHaveLength(10);
    expect(
      metrics.calibrationBins.reduce((sum, bin) => sum + bin.count, 0),
    ).toBe(metrics.rows.holdout);
    for (const bin of metrics.calibrationBins) {
      if (bin.count === 0) {
        expect(bin.predictedMean).toBeNull();
        expect(bin.observedRate).toBeNull();
      } else {
        expect(bin.predictedMean).not.toBeNull();
        expect(bin.observedRate).not.toBeNull();
      }
    }
    const support = metrics.labelSupport;
    expect(support.proxy).toBe("desk_flag");
    expect(support.trainPositives + support.trainNegatives).toBe(
      metrics.rows.train,
    );
    expect(support.holdoutPositives + support.holdoutNegatives).toBe(
      metrics.rows.holdout,
    );
    expect(support.totalPositives).toBe(
      support.trainPositives + support.holdoutPositives,
    );
    expect(support.totalPositives).toBeGreaterThan(0);
    expect(support.prevalence).toBeCloseTo(
      support.totalPositives / artifact.corpusRows,
      10,
    );
    expect(support.holdoutDeskFlagPositives).toBeGreaterThanOrEqual(
      support.holdoutPositives,
    );
    for (const count of Object.values(support.holdoutBySignal)) {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(support.holdoutPositives);
    }
    if (metrics.aucRoc === null)
      throw new Error("synthetic corpus should be separable");
    expect(metrics.aucRoc).toBeGreaterThan(0.5);
    // Stability and drift are reported, not hidden.
    expect(artifact.validation.holdout.aucRoc).toBe(metrics.aucRoc);
    expect(artifact.validation.drift.length).toBe(26);
    expect(
      artifact.validation.drift[0]?.standardizedMeanShift,
    ).toBeGreaterThanOrEqual(
      artifact.validation.drift[25]?.standardizedMeanShift ?? 0,
    );
    expect(artifact.limits).toEqual([...FRAUD_MODEL_LIMITS]);
  });

  test("warns instead of hiding a non-converged fit", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      // The minimum budget; with lr 0.5 / l2 0.01 this does NOT reach the tolerance.
      options: { ...options, epochs: 100 },
    });
    expect(artifact.spec.epochsRun).toBeLessThanOrEqual(100);
    if (!artifact.metrics.converged) {
      const codes = artifact.validation.warnings.map((warning) => warning.code);
      expect(codes).toContain("not_converged");
      const warning = artifact.validation.warnings.find(
        (item) => item.code === "not_converged",
      );
      expect(warning?.observed).toBe(artifact.metrics.epochsRun);
      // A warning is not a refusal: the artifact still carries full metrics.
      expect(artifact.metrics.aucRoc).not.toBeNull();
      expect(artifact.features).toHaveLength(26);
    }
  });

  test("supports the narrower proxies and reports their support", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    for (const proxy of ["suspected_bot", "reversed_credit"] as const) {
      const { artifact } = fitFraudModel({
        corpus,
        config,
        now: fixedNow(),
        options: { ...options, proxy },
      });
      expect(artifact.proxy).toBe(proxy);
      expect(artifact.metrics.labelSupport.proxy).toBe(proxy);
      expect(artifact.metrics.labelSupport.totalPositives).toBeGreaterThan(0);
      const labels = extractFraudFeatures(corpus.records);
      const expected = labels.rows.filter((row) =>
        proxy === "suspected_bot"
          ? row.labels.suspectedBot
          : row.labels.reversedCredit,
      ).length;
      expect(artifact.metrics.labelSupport.totalPositives).toBe(expected);
    }
  });

  test("artifact features carry weights and stats in frozen order", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    expect(artifact.features.map((feature) => feature.id)).toEqual([
      ...FRAUD_FEATURE_IDS,
    ]);
    expect(artifact.weights).toHaveLength(26);
    expect(artifact.features).toHaveLength(26);
    expect(Number.isFinite(artifact.intercept)).toBe(true);
    expect(artifact.spec.featureCount).toBe(26);
    expect(artifact.spec.epochsRequested).toBe(options.epochs);
    expect(artifact.spec.epochsRun).toBeGreaterThan(0);
    expect(artifact.spec.epochsRun).toBeLessThanOrEqual(options.epochs);
    for (const feature of artifact.features) {
      expect(Number.isFinite(feature.weight)).toBe(true);
      expect(feature.stats.min).toBeLessThanOrEqual(feature.stats.max);
      expect(feature.stats.missingRate).toBeGreaterThanOrEqual(0);
      expect(feature.stats.missingRate).toBeLessThanOrEqual(1);
    }
    const line = artifact.features.find(
      (feature) => feature.id === "line_hundredths",
    );
    expect(line?.stats.std).toBe(0);
    // No raw IP or account identifier leaks into the artifact. The one IP-shaped literal is the
    // public bot-ring CIDR constant embedded in that feature's config label, not a row address.
    const serialized = stableJson(artifact).replaceAll(
      "140.248.0.0/16",
      "CIDR",
    );
    expect(/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(serialized)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Artifact write / read / score mapping                                       */
/* -------------------------------------------------------------------------- */

describe("model artifact", () => {
  test("writes atomically with mode 0600 under reports/security only", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    expect((await readFraudModel(root)).artifact).toBeNull();
    const refusal = modelMissingRefusal();
    expect(refusal.code).toBe("model_missing");
    expect(refusal.message).toContain(FRAUD_MODEL_FIT_COMMAND);

    const written = await writeFraudModelArtifact(root, artifact);
    expect(written).toBe(FRAUD_MODEL_REL_PATH);
    const absolute = join(root, FRAUD_MODEL_REL_PATH);
    const fileStat = await stat(absolute);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const directoryEntries = await readdir(join(root, "reports", "security"));
    expect(directoryEntries).toEqual(["fraud-model.json"]);
    const onDisk = (await Bun.file(absolute).json()) as FraudModelArtifact;
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.kind).toBe("fraud-model");
    expect(onDisk.features).toHaveLength(26);

    const read = await readFraudModel(root);
    expect(read.artifact).not.toBeNull();
    expect(read.state.present).toBe(true);
    expect(read.state.fittedAt).toBe(fixedNow().toISOString());
    expect(read.state.metrics?.aucRoc).toBe(artifact.metrics.aucRoc);
    expect(read.state.command).toBe(FRAUD_MODEL_FIT_COMMAND);
    const payload = modelReportPayload(
      read.artifact as FraudModelArtifact,
      read.state,
    );
    expect(payload["present"]).toBe(true);
    expect(payload["kind"]).toBe(FRAUD_MODEL_KIND);
    expect(payload["spec"]).toBeDefined();
    expect(payload["validation"]).toBeDefined();
    const metadata = payload["metricMetadata"] as {
      kind: string;
      schemaVersion: number;
      proxy: string;
      definitions: Array<{
        name: string;
        kind: string;
        description: string;
        unit?: string;
        label?: string;
        population?: string;
        baselineRef?: string;
        subsetOf?: string;
        state?: string;
        positives?: number | null;
        k?: number;
        maxAchievable?: number | null;
        kSamples?: number | null;
        kPositives?: number | null;
        detailRef?: string;
        value?: unknown;
      }>;
    };
    expect(metadata.kind).toBe("fraud-model-metric-metadata");
    expect(metadata.schemaVersion).toBe(2);
    expect(metadata.proxy).toBe(artifact.proxy);
    for (const definition of metadata.definitions) {
      expect(typeof definition.name).toBe("string");
      expect(typeof definition.kind).toBe("string");
      expect(typeof definition.description).toBe("string");
    }
    const vocabulary = (
      metadata as unknown as {
        vocabulary: {
          unit: Record<string, string>;
          label: Record<string, string>;
        };
      }
    ).vocabulary;
    expect(vocabulary.unit["bet-row"]).toContain("getBetReport");
    expect(vocabulary.label["desk_flag"]).toContain("suspectedBot");
    const rowMetric = metadata.definitions.find(
      (definition) => definition.name === "rowPrecisionAtK",
    );
    expect(rowMetric).toMatchObject({
      kind: "metric",
      unit: "bet-row",
      label: "desk_flag",
      population: "temporalHoldout",
      baselineRef: "temporalHoldoutPositiveRate",
      k: FRAUD_HEADLINE_K,
      maxAchievable: 1,
    });
    expect(rowMetric?.detailRef).toBe("metrics.rowPrecisionAtK");
    const rowHeadline = artifact.metrics.rowPrecisionAtK.find(
      (row) => row.k === FRAUD_HEADLINE_K,
    );
    expect(rowMetric?.value).toBeCloseTo(rowHeadline?.precision ?? -1, 6);
    expect(rowMetric?.kSamples).toBe(rowHeadline?.kSamples ?? null);
    expect(rowMetric?.kPositives).toBe(rowHeadline?.kPositives ?? null);
    const noPriorMetric = metadata.definitions.find(
      (definition) => definition.name === "rowPrecisionAtKNoPriorBet",
    );
    const noPriorHeadline =
      artifact.validation.noPriorBet?.metrics.rowPrecisionAtK.find(
        (row) => row.k === FRAUD_HEADLINE_K,
      );
    if (noPriorHeadline !== undefined) {
      expect(noPriorMetric).toMatchObject({
        k: FRAUD_HEADLINE_K,
        kSamples: noPriorHeadline.kSamples,
        kPositives: noPriorHeadline.kPositives,
        detailRef: "validation.noPriorBet.metrics.rowPrecisionAtK",
      });
      expect(noPriorMetric?.maxAchievable).toBeCloseTo(
        Math.min(
          FRAUD_HEADLINE_K,
          artifact.validation.noPriorBet?.positives ?? 0,
        ) / FRAUD_HEADLINE_K,
        6,
      );
    }
    const holdoutRow = metadata.definitions.find(
      (definition) => definition.name === "temporalHoldout",
    );
    expect(holdoutRow).toMatchObject({
      kind: "population",
      rows: artifact.metrics.rows.holdout,
      positives: artifact.metrics.labelSupport.holdoutPositives,
      subsets: ["noPriorBet"],
    });
    const noPriorRow = metadata.definitions.find(
      (definition) => definition.name === "noPriorBet",
    );
    expect(noPriorRow).toMatchObject({
      kind: "population",
      subsetOf: "temporalHoldout",
      rows: artifact.validation.noPriorBet?.rows ?? null,
      positives: artifact.validation.noPriorBet?.positives ?? null,
    });
    const baseline = metadata.definitions.find(
      (definition) => definition.name === "temporalHoldoutPositiveRate",
    );
    expect(baseline).toMatchObject({
      kind: "baseline",
      unit: "bet-row",
      label: "desk_flag",
      population: "temporalHoldout",
    });
    expect(baseline?.value).toBeCloseTo(
      artifact.metrics.labelSupport.holdoutPositives /
        artifact.metrics.rows.holdout,
      6,
    );
    const composition = metadata.definitions.find(
      (definition) => definition.name === "labelComposition",
    );
    expect(composition).toMatchObject({
      kind: "distribution",
      population: "temporalHoldout",
    });
    expect(composition?.value).toMatchObject({
      suspectedBot: expect.any(Number),
      reversedCredit: expect.any(Number),
      manualLog: expect.any(Number),
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "accountPrecisionAtK",
      ),
    ).toMatchObject({
      kind: "metric",
      state: "not_measured",
      blockedBy: "accountDispositionFeed",
      unit: "account",
      population: "accountHoldout",
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "accountHoldout",
      ),
    ).toMatchObject({
      kind: "population",
      state: "not_measured",
      blockedBy: "accountDispositionFeed",
    });
    expect(
      metadata.definitions.find(
        (definition) => definition.name === "notStratifiedBy",
      )?.value,
    ).toEqual(["sport", "subSport", "market", "period", "agent"]);
    expect(typeof payload["artifactSha256"]).toBe("string");
    expect((payload["artifactSha256"] as string).length).toBe(64);

    // A second write replaces the artifact and leaves no temp file behind.
    await writeFraudModelArtifact(root, artifact);
    expect(await readdir(join(root, "reports", "security"))).toEqual([
      "fraud-model.json",
    ]);
  });

  test("a missing noPriorBet slice reports a not-measured container", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    const state = (await readFraudModel(root)).state;
    const withoutSlice: FraudModelArtifact = {
      ...artifact,
      validation: { ...artifact.validation, noPriorBet: null },
    };
    const payload = modelReportPayload(withoutSlice, state);
    const metadata = payload["metricMetadata"] as {
      definitions: Array<{
        name: string;
        state?: string;
        blockedBy?: string;
        detailRef?: string;
      }>;
    };
    const row = metadata.definitions.find(
      (definition) => definition.name === "rowPrecisionAtKNoPriorBet",
    );
    expect(row).toMatchObject({
      state: "not_measured",
      blockedBy: "noPriorBetSlice",
      detailRef: "validation.noPriorBet",
    });
    const validation = payload["validation"] as {
      noPriorBet: { state: string; metrics?: unknown };
    };
    expect(validation.noPriorBet).toEqual({ state: "not_measured" });
    expect(validation.noPriorBet.metrics).toBeUndefined();
  });

  test("report payload trims the score map while the artifact keeps it", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    const state = (await readFraudModel(root)).state;
    const compact = modelReportPayload(artifact, state);
    const scoreMap = compact["scoreMap"] as Record<string, unknown>;
    expect(scoreMap).toEqual({
      size: artifact.scoreMap.size,
      quantileCount: artifact.scoreMap.quantiles.length,
    });
    expect(Object.hasOwn(scoreMap, "quantiles")).toBe(false);
    // The artifact itself is untouched: the quantile array stays fitted for scoring.
    expect(artifact.scoreMap.quantiles).toHaveLength(1001);
    const full = modelReportPayload(artifact, state, {
      includeScoreMap: true,
    });
    const fullScoreMap = full["scoreMap"] as Record<string, unknown>;
    expect(fullScoreMap["quantileCount"]).toBe(1001);
    expect(fullScoreMap["quantiles"]).toHaveLength(1001);
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(full).length,
    );
    // Integrity tag and the per-feature train/holdout context are present in both forms.
    expect(typeof compact["artifactSha256"]).toBe("string");
    expect((compact["artifactSha256"] as string).length).toBe(64);
    const features = compact["features"] as {
      stats: Record<string, unknown>;
    }[];
    for (const feature of features) {
      expect(typeof feature.stats["trainMean"]).toBe("number");
      expect(typeof feature.stats["holdoutMean"]).toBe("number");
      expect(typeof feature.stats["missingRate"]).toBe("number");
    }
    expect(compact["sources"]).toBeUndefined();
  });

  test("an unreadable artifact is reported as not fitted, never half-valid", async () => {
    const root = track(makeRoot());
    writeAt(root, FRAUD_MODEL_REL_PATH, "{ not a model }");
    // The module writer is not used here; write raw text through a fresh path after mkdir.
    const read = await readFraudModel(root);
    expect(read.artifact).toBeNull();
    expect(read.state.present).toBe(false);
    expect(read.state.reason).toContain("unreadable");
    expect(read.state.metrics).toBeNull();
  });

  test("score mapping is a train-CDF percentile with the configured bands", async () => {
    const { corpus, options, root } = await fullSynthetic();
    const config = (await loadFraudConfig(root)).config;
    const { artifact } = fitFraudModel({
      corpus,
      config,
      now: fixedNow(),
      options,
    });
    const low = scoreFromQuantiles(0, artifact.scoreMap.quantiles);
    expect(low.score).toBe(0);
    const high = scoreFromQuantiles(1, artifact.scoreMap.quantiles);
    expect(high.score).toBe(100);
    const middle = scoreFromQuantiles(0.5, artifact.scoreMap.quantiles);
    expect(middle.score).toBeGreaterThanOrEqual(0);
    expect(middle.score).toBeLessThanOrEqual(100);
    expect(bandForScore(0, artifact.scoreBands)).toBe("low");
    expect(bandForScore(60, artifact.scoreBands)).toBe("medium");
    expect(bandForScore(80, artifact.scoreBands)).toBe("high");
    expect(bandForScore(95, artifact.scoreBands)).toBe("critical");

    const matrix = extractFraudFeatures(corpus.records);
    const score = scoreAccountWithModel(artifact, matrix, "U003");
    expect(score).not.toBeNull();
    expect(score?.score).toBeGreaterThanOrEqual(0);
    expect(score?.score).toBeLessThanOrEqual(100);
    expect(score?.band).toBe(
      bandForScore(score?.score ?? 0, artifact.scoreBands),
    );
    expect(score?.contributions.length).toBeLessThanOrEqual(10);
    expect(score?.rows).toBeGreaterThan(0);
    expect(scoreAccountWithModel(artifact, matrix, "NOPE")).toBeNull();
    expect(fraudModelArtifactDigest(artifact)).toHaveLength(64);
  });
});
