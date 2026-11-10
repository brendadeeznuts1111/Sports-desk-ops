/**
 * @file fraud_model.ts
 * @description Transparent weak-label risk model for the SportsDesk security/fraud console.
 *
 * What it is: a deterministic logistic ranker over GSLive `getBetReport` rows. It predicts a
 * *desk-flag proxy* (`isSuspectedBot≠0 OR reversedCredit set OR manualLogExists≠0`), never a
 * probability of fraud. Every fitted artifact carries the limits that make that distinction explicit.
 *
 * Leakage rule (enforced by construction, proven in tests): every `*_prior_*` feature for row i is
 * computed only from rows with `logTime < logTime_i`. Rows are processed in timestamp order and a
 * same-timestamp batch is folded into the prefix state only *after* each row of that batch has been
 * featurized, so a later row (even one with an identical timestamp) cannot change an earlier row's
 * features.
 *
 * Determinism: full-batch gradient descent from a fixed zero initialisation, no shuffling, no
 * randomness. Two fits over the same rows and options produce identical weights, intercept, metrics
 * and score map.
 *
 * Write posture: the only artifact this module writes is `reports/security/fraud-model.json`, and
 * only through {@link writeFraudModelArtifact} — atomic tmp+rename, mode 0600, inside the root.
 */

import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Bits } from "./bits.ts";
import {
  METRIC_METADATA_KINDS,
  isMetricMetadataKind,
} from "./metric_metadata.ts";

import { sha256Hex, stableJson } from "./f402_bet_ticker_delta.ts";
import {
  DEFAULT_FRAUD_CONFIG,
  FRAUD_MODEL_FIT_COMMAND,
  impliedProbability,
  type FraudBetRecord,
  type FraudCorpus,
  type FraudFeatureConfig,
  type FraudModelHyperparameters,
  type FraudPluginConfig,
  type FraudProxyLabel,
  type FraudSourceState,
} from "./fraud_logs.ts";

export { FRAUD_MODEL_FIT_COMMAND };
export type { FraudProxyLabel } from "./fraud_logs.ts";

export const FRAUD_MODEL_REL_PATH = "reports/security/fraud-model.json";
export const FRAUD_MODEL_KIND = "fraud-model" as const;
export const FRAUD_MODEL_SCHEMA_VERSION = 2 as const;

export type FraudModelErrorCode =
  | "insufficient_corpus"
  | "model_missing"
  | "invalid_model_artifact"
  | "unknown_subject";

/** Refusal error: every code maps to CLI exit 3 (structured refusal, not a crash). */
export class FraudModelError extends Error {
  readonly code: FraudModelErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: FraudModelErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "FraudModelError";
    this.code = code;
    this.details = details;
  }
}

/* -------------------------------------------------------------------------- */
/* Frozen feature registry                                                     */
/* -------------------------------------------------------------------------- */

/** Frozen feature ids in registry order (config may relabel but not add/remove ids). */
export const FRAUD_FEATURE_IDS = DEFAULT_FRAUD_CONFIG.features.map(
  (feature) => feature.id,
);

export type FraudScoreBand = "low" | "medium" | "high" | "critical";

export interface FraudFeatureStats {
  readonly mean: number;
  readonly std: number;
  readonly min: number;
  readonly max: number;
  /** Rows whose raw input was absent and were imputed with 0. */
  readonly missing: number;
  readonly missingRate: number;
  readonly trainMean: number;
  readonly holdoutMean: number;
  /** |holdoutMean - trainMean| / trainStd (train-vs-holdout standardized mean shift). */
  readonly standardizedMeanShift: number;
}

export interface FraudModelFeature {
  readonly id: string;
  readonly label: string;
  readonly kind: "snapshot" | "history";
  /** Weight in standardized-feature space. */
  readonly weight: number;
  readonly stats: FraudFeatureStats;
}

export interface FraudCalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly predictedMean: number | null;
  readonly observedRate: number | null;
}

export interface FraudLabelSupport {
  readonly proxy: FraudProxyLabel;
  readonly trainPositives: number;
  readonly trainNegatives: number;
  readonly holdoutPositives: number;
  readonly holdoutNegatives: number;
  readonly totalPositives: number;
  readonly prevalence: number | null;
  /** Holdout rows whose composite desk_flag is true (independent of the fitted proxy). */
  readonly holdoutDeskFlagPositives: number;
  /** Which signals make up the composite holdout positives; a row can carry more than one. */
  readonly holdoutBySignal: FraudLabelSignalCounts;
}

export interface FraudMetricWindow {
  readonly fromIso: string | null;
  readonly toIso: string | null;
}

/**
 * One review batch of **bet rows** (not accounts, sports or markets): what an analyst sees after
 * reading the top `k` rows by model score.
 */
export interface FraudRowPrecisionAtK {
  /** Requested review size in bet rows. */
  readonly k: number;
  /** Bet rows actually available: `min(k, scored rows)`. */
  readonly kSamples: number;
  /** Top-k rows whose own label is true. */
  readonly kPositives: number;
  /** All rows in the scored population whose own label is true. */
  readonly positives: number;
  readonly precision: number | null;
  readonly recall: number | null;
  /** Precision divided by the label prevalence in the scored rows. */
  readonly lift: number | null;
}

/** Review sizes in **bet rows**; reported as a table rather than one guessed cutoff. */
export const FRAUD_ROW_REVIEW_SIZES = [10, 20, 50, 100, 200, 500] as const;

/** Headline review size for the metadata row; the full k-table stays in `metrics.rowPrecisionAtK`. */
export const FRAUD_HEADLINE_K = 20;

export interface FraudClassificationMetrics {
  readonly aucRoc: number | null;
  readonly averagePrecision: number | null;
  readonly precisionAt1Pct: number | null;
  readonly precisionAt5Pct: number | null;
  readonly rowPrecisionAtK: readonly FraudRowPrecisionAtK[];
  readonly brier: number | null;
}

export interface FraudModelMetrics extends FraudClassificationMetrics {
  readonly calibrationBins: readonly FraudCalibrationBin[];
  readonly labelSupport: FraudLabelSupport;
  readonly trainWindow: FraudMetricWindow;
  readonly holdoutWindow: FraudMetricWindow;
  readonly rows: { readonly train: number; readonly holdout: number };
  /** Epochs actually run before the tolerance/epoch budget was reached (reported, not hidden). */
  readonly epochsRun: number;
  /** True when gradient descent reached the convergence tolerance inside the epoch budget. */
  readonly converged: boolean;
}

export type FraudModelWarningCode =
  | "not_converged"
  | "stability_delta_gt_0.10"
  | "drift_shift_gt_1.0"
  | "no_prior_bet_precision_gap"
  | "source_stale";

export interface FraudModelWarning {
  readonly code: FraudModelWarningCode;
  readonly message: string;
  readonly observed: number | string | null;
}

export interface FraudStability {
  readonly firstHalfAuc: number | null;
  readonly secondHalfAuc: number | null;
  readonly absDelta: number | null;
  readonly firstHalfRows: number;
  readonly secondHalfRows: number;
}

/** Holdout **bet rows** whose account has no earlier bet in the corpus. */
export interface FraudNoPriorBetValidation {
  readonly rows: number;
  readonly positives: number;
  readonly metrics: FraudClassificationMetrics;
}

export interface FraudFeatureDrift {
  readonly feature: string;
  readonly standardizedMeanShift: number;
}

export interface FraudModelValidation {
  readonly holdout: FraudClassificationMetrics;
  readonly noPriorBet: FraudNoPriorBetValidation | null;
  readonly stability: FraudStability;
  readonly drift: readonly FraudFeatureDrift[];
  /**
   * Explicit rule-based warnings. Warnings never silently drop a feature or hide a result: they
   * name the measured value so the reader can judge it (e.g. real temporal drift).
   */
  readonly warnings: readonly FraudModelWarning[];
}

export interface FraudModelScoreMap {
  readonly size: number;
  /** Sorted in-sample (train) predicted probabilities; percentile mapping for score 0-100. */
  readonly quantiles: readonly number[];
}

export interface FraudModelScoreBands {
  readonly lowMax: number;
  readonly mediumMax: number;
  readonly highMax: number;
}

export type FraudModelProvenance = {
  readonly corpusPath: string;
  readonly corpusSha256: string | null;
  readonly corpusRawRows: number;
  readonly corpusRows: number;
  readonly excludedRows: number;
  readonly sources: readonly {
    readonly id: string;
    readonly state: string;
    readonly provenance: string;
    readonly path: string;
  }[];
  readonly fixtureSourcesExcluded: readonly string[];
  readonly generatedAt: string;
};

export interface FraudModelArtifact {
  readonly schemaVersion: typeof FRAUD_MODEL_SCHEMA_VERSION;
  readonly kind: typeof FRAUD_MODEL_KIND;
  readonly fittedAt: string;
  readonly corpusPath: string;
  readonly corpusSha256: string | null;
  readonly corpusRows: number;
  readonly split: number;
  readonly proxy: FraudProxyLabel;
  readonly spec: {
    readonly schemaVersion: typeof FRAUD_MODEL_SCHEMA_VERSION;
    readonly corpusSha256: string | null;
    readonly corpusRows: number;
    readonly split: number;
    readonly proxy: FraudProxyLabel;
    readonly epochsRequested: number;
    readonly epochsRun: number;
    readonly converged: boolean;
    readonly l2: number;
    readonly learningRate: number;
    readonly seed: number;
    readonly featureCount: number;
  };
  readonly features: readonly FraudModelFeature[];
  readonly weights: readonly number[];
  readonly intercept: number;
  readonly metrics: FraudModelMetrics;
  readonly validation: FraudModelValidation;
  readonly scoreMap: FraudModelScoreMap;
  readonly scoreBands: FraudModelScoreBands;
  readonly limits: readonly string[];
  readonly provenance: FraudModelProvenance;
}

/** State a UI needs to render the Model tab honestly (no placeholder zeros when absent). */
export interface FraudModelState {
  readonly present: boolean;
  readonly path: string;
  readonly fittedAt: string | null;
  readonly schemaVersion: typeof FRAUD_MODEL_SCHEMA_VERSION | null;
  readonly corpusRows: number | null;
  readonly split: number | null;
  readonly metrics: {
    readonly aucRoc: number | null;
    readonly averagePrecision: number | null;
    readonly brier: number | null;
  } | null;
  readonly limits: readonly string[];
  readonly reason: string | null;
  readonly command: string;
}

/* -------------------------------------------------------------------------- */
/* Limits (honesty floor, reported by every model answer)                      */
/* -------------------------------------------------------------------------- */

export const FRAUD_MODEL_LIMITS: readonly string[] = [
  "proxy label, not observed fraud: desk_flag is a row flag (suspected bot / reversed credit / manual log), never a confirmed fraud outcome",
  "live snapshot, not longitudinal: one 7-day getBetReport export",
  "fixture sources excluded: the generated customer book and hardcoded IP-tracker clusters contribute no features",
  "no account↔login bridge (betReport userID ≠ ticker Login)",
  "line_hundredths is constant 0: the capture has no line column",
  "single book (partner 118), single desk; no cross-book comparison",
  "IP tag is an 8-hex sha256 prefix (collisions possible); /24 identifies a network, not a subscriber",
  "class weights balance the weak label: the logistic probability is not calibrated; scores are train-CDF percentiles",
  "temporal split does not remove drift: thresholds may not hold on the next capture",
  "history features use only strictly earlier rows (logTime < logTime_i)",
  "no-prior-bet rows are reported separately: overall row precision is dominated by repeat offenders and must not be quoted for new accounts",
  "row precision is not account precision: these tables rank bet rows, while fraud_queue ranks accounts",
  "not stratified by sport, subSport, market or period: a stratum with few positives is noise, so the corpus does not support per-stratum precision claims",
];

export function fraudModelLimits(): readonly string[] {
  return FRAUD_MODEL_LIMITS;
}

/* -------------------------------------------------------------------------- */
/* Leakage-safe feature extraction                                             */
/* -------------------------------------------------------------------------- */

export interface FraudFeatureLabels {
  readonly deskFlag: boolean;
  readonly suspectedBot: boolean;
  readonly reversedCredit: boolean;
  readonly manualLog: boolean;
}

/** Holdout proxy-positive rows by source signal; the signals overlap, so counts need not sum. */
export interface FraudLabelSignalCounts {
  readonly suspectedBot: number;
  readonly reversedCredit: number;
  readonly manualLog: number;
}

export interface FraudFeatureRow {
  readonly betId: string;
  readonly placedAtMs: number;
  readonly accountId: string;
  readonly labels: FraudFeatureLabels;
  readonly values: readonly number[];
  readonly missing: Bits;
}

export interface FraudFeatureMatrix {
  readonly featureIds: readonly string[];
  readonly rows: readonly FraudFeatureRow[];
  /** Rows dropped because `logTime` was absent/unparseable (they cannot be placed in time). */
  readonly droppedNoTimestamp: number;
}

interface AccountPrefix {
  bets: number;
  stakeSum: number;
  driftCount: number;
  reversalCount: number;
  botCount: number;
  readonly ips: Set<string>;
}

interface IpPrefix {
  bets: number;
  readonly accounts: Set<string>;
}

interface AgentPrefix {
  bets: number;
  driftCount: number;
  botCount: number;
}

interface PrefixState {
  readonly accounts: Map<string, AccountPrefix>;
  readonly ips: Map<string, IpPrefix>;
  readonly prefixes: Map<string, Set<string>>;
  readonly agents: Map<string, AgentPrefix>;
}

function emptyPrefixState(): PrefixState {
  return {
    accounts: new Map(),
    ips: new Map(),
    prefixes: new Map(),
    agents: new Map(),
  };
}

function accountPrefix(state: PrefixState, accountId: string): AccountPrefix {
  const existing = state.accounts.get(accountId);
  if (existing !== undefined) return existing;
  const created: AccountPrefix = {
    bets: 0,
    stakeSum: 0,
    driftCount: 0,
    reversalCount: 0,
    botCount: 0,
    ips: new Set(),
  };
  state.accounts.set(accountId, created);
  return created;
}

function ipPrefix(state: PrefixState, tag: string): IpPrefix {
  const existing = state.ips.get(tag);
  if (existing !== undefined) return existing;
  const created: IpPrefix = { bets: 0, accounts: new Set() };
  state.ips.set(tag, created);
  return created;
}

function prefixPrefix(state: PrefixState, key: string): Set<string> {
  const existing = state.prefixes.get(key);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  state.prefixes.set(key, created);
  return created;
}

function agentPrefix(state: PrefixState, agentId: string): AgentPrefix {
  const existing = state.agents.get(agentId);
  if (existing !== undefined) return existing;
  const created: AgentPrefix = { bets: 0, driftCount: 0, botCount: 0 };
  state.agents.set(agentId, created);
  return created;
}

function foldRow(state: PrefixState, record: FraudBetRecord): void {
  if (record.placedAtMs === null) return;
  const account = accountPrefix(state, record.userId);
  account.bets += 1;
  if (record.stakeUsd !== null) account.stakeSum += record.stakeUsd;
  if (record.oddsDrift !== null && record.oddsDrift !== 0)
    account.driftCount += 1;
  if (record.reversedCredit) account.reversalCount += 1;
  if (record.suspectedBot) account.botCount += 1;
  if (record.ipTag !== null) {
    account.ips.add(record.ipTag);
    const ip = ipPrefix(state, record.ipTag);
    ip.bets += 1;
    ip.accounts.add(record.userId);
    if (record.ipPrefix24 !== null) {
      prefixPrefix(state, record.ipPrefix24).add(record.userId);
    }
  }
  if (record.agentId !== null) {
    const agent = agentPrefix(state, record.agentId);
    agent.bets += 1;
    if (record.oddsDrift !== null && record.oddsDrift !== 0)
      agent.driftCount += 1;
    if (record.suspectedBot) agent.botCount += 1;
  }
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function buildFeatureRow(
  record: FraudBetRecord,
  state: PrefixState,
  featureIds: readonly string[],
  datacenterClasses: readonly string[],
): FraudFeatureRow {
  const values: number[] = [];
  const missing = new Bits(featureIds.length);
  const account = state.accounts.get(record.userId);
  const ip = record.ipTag === null ? undefined : state.ips.get(record.ipTag);
  const prefix =
    record.ipPrefix24 === null
      ? undefined
      : state.prefixes.get(record.ipPrefix24);
  const agent =
    record.agentId === null ? undefined : state.agents.get(record.agentId);
  const oddsPlacedProb = impliedProbability(record.oddsPlaced);
  const featureValue = (id: string): { value: number; absent: boolean } => {
    switch (id) {
      case "delay_sec":
        return record.delaySec === null
          ? { value: 0, absent: true }
          : { value: record.delaySec, absent: false };
      case "accept_sec":
        return record.acceptSec === null
          ? { value: 0, absent: true }
          : { value: record.acceptSec, absent: false };
      case "odds_drift":
        return record.oddsDrift === null
          ? { value: 0, absent: true }
          : { value: record.oddsDrift, absent: false };
      case "implied_prob":
        return oddsPlacedProb === null
          ? { value: 0, absent: true }
          : { value: oddsPlacedProb, absent: false };
      case "stake_usd":
        return record.stakeUsd === null
          ? { value: 0, absent: true }
          : { value: record.stakeUsd, absent: false };
      case "to_win_usd":
        return record.toWinUsd === null
          ? { value: 0, absent: true }
          : { value: record.toWinUsd, absent: false };
      case "line_hundredths":
        return { value: record.lineHundredths ?? 0, absent: false };
      case "period":
        return record.periodCode === null
          ? { value: 0, absent: true }
          : { value: record.periodCode, absent: false };
      case "state_code":
        return record.stateCode === null
          ? { value: 0, absent: true }
          : { value: record.stateCode, absent: false };
      case "hour_of_day":
        return { value: record.hourOfDayUtc, absent: false };
      case "day_of_week":
        return { value: record.dayOfWeekUtc, absent: false };
      case "result_code":
        return { value: record.resultCodeNum, absent: false };
      case "acct_prior_bets":
        return { value: account?.bets ?? 0, absent: account === undefined };
      case "acct_prior_stake_mean":
        return {
          value:
            account === undefined || account.bets === 0
              ? 0
              : account.stakeSum / account.bets,
          absent: account === undefined,
        };
      case "acct_prior_drift_rate":
        return {
          value:
            account === undefined ? 0 : rate(account.driftCount, account.bets),
          absent: account === undefined,
        };
      case "acct_prior_reversal_rate":
        return {
          value:
            account === undefined
              ? 0
              : rate(account.reversalCount, account.bets),
          absent: account === undefined,
        };
      case "acct_prior_bot_rate":
        return {
          value:
            account === undefined ? 0 : rate(account.botCount, account.bets),
          absent: account === undefined,
        };
      case "ip_prior_accounts":
        return {
          value: ip?.accounts.size ?? 0,
          absent: record.ipTag === null,
        };
      case "ip_prior_bets":
        return { value: ip?.bets ?? 0, absent: record.ipTag === null };
      case "ip_prefix24_accounts":
        return {
          value: prefix?.size ?? 0,
          absent: record.ipPrefix24 === null,
        };
      case "acct_prior_ip_count":
        return {
          value: account?.ips.size ?? 0,
          absent: account === undefined,
        };
      case "ip_bot_ring_range":
        return { value: record.botRingRange ? 1 : 0, absent: false };
      case "ip_datacenter":
        return {
          value: datacenterClasses.includes(record.ipClass) ? 1 : 0,
          absent: false,
        };
      case "agent_prior_bets":
        return { value: agent?.bets ?? 0, absent: agent === undefined };
      case "agent_prior_drift_rate":
        return {
          value: agent === undefined ? 0 : rate(agent.driftCount, agent.bets),
          absent: agent === undefined,
        };
      case "agent_prior_bot_rate":
        return {
          value: agent === undefined ? 0 : rate(agent.botCount, agent.bets),
          absent: agent === undefined,
        };
      default:
        return { value: 0, absent: true };
    }
  };
  for (let i = 0; i < featureIds.length; i += 1) {
    const feature = featureValue(featureIds[i]!);
    values.push(feature.value);
    if (feature.absent) missing.set(i);
  }
  return {
    betId: record.betId,
    placedAtMs: record.placedAtMs ?? 0,
    accountId: record.userId,
    labels: {
      deskFlag:
        record.suspectedBot || record.reversedCredit || record.manualLog,
      suspectedBot: record.suspectedBot,
      reversedCredit: record.reversedCredit,
      manualLog: record.manualLog,
    },
    values,
    missing,
  };
}

/**
 * Compute the leakage-safe feature matrix. Rows are processed in `logTime` order; a batch with an
 * identical timestamp is folded into the prefix state only after every row in it is featurized, so
 * only rows with a strictly earlier `logTime` can influence a row's history features.
 */
export function extractFraudFeatures(
  records: readonly FraudBetRecord[],
  options: {
    readonly featureIds?: readonly string[];
    readonly datacenterClasses?: readonly string[];
  } = {},
): FraudFeatureMatrix {
  const featureIds = options.featureIds ?? FRAUD_FEATURE_IDS;
  const datacenterClasses =
    options.datacenterClasses ??
    DEFAULT_FRAUD_CONFIG.detectors.datacenterClasses;
  const timed = records.filter(
    (record): record is FraudBetRecord & { placedAtMs: number } =>
      record.placedAtMs !== null,
  );
  const droppedNoTimestamp = records.length - timed.length;
  const sorted = [...timed].sort((a, b) => {
    if (a.placedAtMs !== b.placedAtMs) return a.placedAtMs - b.placedAtMs;
    return a.betId < b.betId ? -1 : a.betId > b.betId ? 1 : 0;
  });
  const state = emptyPrefixState();
  const rows: FraudFeatureRow[] = [];
  let batch: (FraudBetRecord & { placedAtMs: number })[] = [];
  let batchTimestamp: number | null = null;
  for (const record of sorted) {
    if (batchTimestamp !== null && record.placedAtMs !== batchTimestamp) {
      for (const batched of batch) foldRow(state, batched);
      batch = [];
    }
    batchTimestamp = record.placedAtMs;
    rows.push(buildFeatureRow(record, state, featureIds, datacenterClasses));
    batch.push(record);
  }
  // The trailing batch is intentionally NOT folded: it has no later rows to influence.
  return { featureIds, rows, droppedNoTimestamp };
}

/** Label bitset for a proxy over extracted rows. */
export function labelVector(
  matrix: FraudFeatureMatrix,
  proxy: FraudProxyLabel,
): Bits {
  const out = new Bits(matrix.rows.length);
  for (let i = 0; i < matrix.rows.length; i += 1) {
    const row = matrix.rows[i]!;
    const positive =
      proxy === "suspected_bot"
        ? row.labels.suspectedBot
        : proxy === "reversed_credit"
          ? row.labels.reversedCredit
          : row.labels.deskFlag;
    if (positive) out.set(i);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Metric primitives                                                           */
/* -------------------------------------------------------------------------- */

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** AUC-ROC with average ranks for ties; null when one class is absent. */
export function aucRoc(scores: readonly number[], labels: Bits): number | null {
  if (scores.length !== labels.length) {
    throw new Error("aucRoc: scores/labels length mismatch");
  }
  const positives = labels.count();
  const negatives = scores.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const order = scores
    .map((score, index) => ({ score, label: labels.bit(index), index }))
    .sort((a, b) => a.score - b.score || a.index - b.index);
  let rankSumPositives = 0;
  let index = 0;
  while (index < order.length) {
    let end = index;
    while (
      end + 1 < order.length &&
      order[end + 1]?.score === order[index]?.score
    )
      end += 1;
    const averageRank = (index + end + 2) / 2; // 1-based average rank
    for (let cursor = index; cursor <= end; cursor += 1) {
      if (order[cursor]?.label === true) rankSumPositives += averageRank;
    }
    index = end + 1;
  }
  return (
    (rankSumPositives - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

/** Average precision (PR-AUC) with score-tie grouping; null when no positives. */
export function averagePrecision(
  scores: readonly number[],
  labels: Bits,
): number | null {
  if (scores.length !== labels.length) {
    throw new Error("averagePrecision: scores/labels length mismatch");
  }
  const positives = labels.count();
  if (positives === 0) return null;
  const order = scores
    .map((score, index) => ({ score, label: labels.bit(index), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  let truePositives = 0;
  let falsePositives = 0;
  let previousRecall = 0;
  let ap = 0;
  let index = 0;
  while (index < order.length) {
    let end = index;
    while (
      end + 1 < order.length &&
      order[end + 1]?.score === order[index]?.score
    )
      end += 1;
    for (let cursor = index; cursor <= end; cursor += 1) {
      if (order[cursor]?.label === true) truePositives += 1;
      else falsePositives += 1;
    }
    const recall = truePositives / positives;
    const precision =
      truePositives + falsePositives === 0
        ? 0
        : truePositives / (truePositives + falsePositives);
    ap += precision * (recall - previousRecall);
    previousRecall = recall;
    index = end + 1;
  }
  return ap;
}

/** Precision among the top `fraction` of holdout rows by score (at least one row). */
export function precisionAtFraction(
  scores: readonly number[],
  labels: Bits,
  fraction: number,
): number | null {
  if (scores.length === 0) return null;
  const k = Math.max(1, Math.round(scores.length * fraction));
  const order = scores
    .map((score, index) => ({ score, label: labels.bit(index), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k);
  const hits = order.filter((entry) => entry.label).length;
  return hits / order.length;
}

/**
 * The decision-boundary table: precision, recall and lift after the analyst reviews the top
 * `k` **bet rows** by score. `k` is a review-size choice, so several are reported instead of
 * one invented cutoff. The labels are row-level; in this model they are the `desk_flag` proxy.
 */
export function rowPrecisionAtK(
  scores: readonly number[],
  labels: Bits,
  k: number,
): FraudRowPrecisionAtK {
  if (scores.length !== labels.length) {
    throw new Error("rowPrecisionAtK: scores/labels length mismatch");
  }
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error("rowPrecisionAtK: k must be a positive integer");
  }
  const positives = labels.count();
  const kSamples = Math.min(k, scores.length);
  if (kSamples === 0) {
    return {
      k,
      kSamples: 0,
      kPositives: 0,
      positives,
      precision: null,
      recall: null,
      lift: null,
    };
  }
  const order = scores
    .map((score, index) => ({ score, label: labels.bit(index), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, kSamples);
  const kPositives = order.filter((entry) => entry.label).length;
  const precision = kPositives / kSamples;
  const recall = positives === 0 ? null : kPositives / positives;
  const prevalence = positives / scores.length;
  return {
    k,
    kSamples,
    kPositives,
    positives,
    precision,
    recall,
    lift: prevalence === 0 ? null : precision / prevalence,
  };
}

/** The review-size table; each `k` larger than the scored rows is capped and says so. */
export function rowPrecisionAtKTable(
  scores: readonly number[],
  labels: Bits,
  sizes: readonly number[] = FRAUD_ROW_REVIEW_SIZES,
): readonly FraudRowPrecisionAtK[] {
  return sizes.map((k) => rowPrecisionAtK(scores, labels, k));
}

export function brierScore(
  probabilities: readonly number[],
  labels: Bits,
): number | null {
  if (probabilities.length === 0) return null;
  let sum = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    const probability = probabilities[index] ?? 0;
    const label = labels.bit(index) ? 1 : 0;
    sum += (probability - label) * (probability - label);
  }
  return sum / probabilities.length;
}

/** Equal-width calibration bins over [0,1]; empty bins report counts 0 and null rates. */
export function calibrationBins(
  probabilities: readonly number[],
  labels: Bits,
  bins: number,
): FraudCalibrationBin[] {
  const result: FraudCalibrationBin[] = [];
  const counts = Array.from({ length: bins }, () => 0);
  const positives = Array.from({ length: bins }, () => 0);
  const probabilitySums = Array.from({ length: bins }, () => 0);
  for (let index = 0; index < probabilities.length; index += 1) {
    const probability = Math.min(1, Math.max(0, probabilities[index] ?? 0));
    const bin = Math.min(bins - 1, Math.floor(probability * bins));
    counts[bin] = (counts[bin] ?? 0) + 1;
    probabilitySums[bin] = (probabilitySums[bin] ?? 0) + probability;
    if (labels.bit(index)) positives[bin] = (positives[bin] ?? 0) + 1;
  }
  for (let bin = 0; bin < bins; bin += 1) {
    const count = counts[bin] ?? 0;
    result.push({
      lower: bin / bins,
      upper: (bin + 1) / bins,
      count,
      predictedMean: count === 0 ? null : (probabilitySums[bin] ?? 0) / count,
      observedRate: count === 0 ? null : (positives[bin] ?? 0) / count,
    });
  }
  return result;
}

function classificationMetrics(
  scores: readonly number[],
  labels: Bits,
): FraudClassificationMetrics {
  return {
    aucRoc: aucRoc(scores, labels),
    averagePrecision: averagePrecision(scores, labels),
    precisionAt1Pct: precisionAtFraction(scores, labels, 0.01),
    precisionAt5Pct: precisionAtFraction(scores, labels, 0.05),
    rowPrecisionAtK: rowPrecisionAtKTable(scores, labels),
    brier: brierScore(scores, labels),
  };
}

/* -------------------------------------------------------------------------- */
/* Fit                                                                         */
/* -------------------------------------------------------------------------- */

export interface FraudFitOptions {
  readonly proxy: FraudProxyLabel;
  readonly split: number;
  readonly l2: number;
  readonly epochs: number;
  readonly learningRate: number;
  readonly seed: number;
  readonly minRows: number;
  readonly minLabeledAccounts: number;
  readonly calibrationBins: number;
  readonly scoreQuantiles: number;
  readonly scoreBands: FraudModelScoreBands;
}

export interface FraudFitParams {
  readonly corpus: FraudCorpus;
  /** Explicit CLI overrides; omitted fields fall back to `config.model`. */
  readonly options: Partial<FraudFitOptions>;
  readonly config: FraudPluginConfig;
  readonly now: Date;
  readonly sources?: readonly FraudSourceState[];
}

export interface FraudFitResult {
  readonly artifact: FraudModelArtifact;
  readonly extraction: {
    readonly rows: number;
    readonly droppedNoTimestamp: number;
    readonly featureCount: number;
    readonly positiveAccounts: number;
  };
}

function resolveFitOptions(
  config: FraudPluginConfig,
  overrides: Partial<FraudFitOptions>,
): FraudFitOptions {
  const model = config.model;
  return {
    proxy: overrides.proxy ?? model.proxy,
    split: overrides.split ?? model.split,
    l2: overrides.l2 ?? model.l2,
    epochs: overrides.epochs ?? model.epochs,
    learningRate: overrides.learningRate ?? model.learningRate,
    seed: overrides.seed ?? model.seed,
    minRows: overrides.minRows ?? model.minRows,
    minLabeledAccounts:
      overrides.minLabeledAccounts ?? model.minLabeledAccounts,
    calibrationBins: overrides.calibrationBins ?? model.calibrationBins,
    scoreQuantiles: overrides.scoreQuantiles ?? model.scoreQuantiles,
    scoreBands: overrides.scoreBands ?? model.scoreBands,
  };
}

function validateFitOptions(options: FraudFitOptions): void {
  if (!(options.split > 0 && options.split < 1)) {
    throw new FraudModelError(
      "insufficient_corpus",
      `split must be in (0,1), got ${options.split}`,
    );
  }
  if (!(options.l2 >= 0 && options.l2 <= 1)) {
    throw new FraudModelError(
      "insufficient_corpus",
      `l2 must be in [0,1], got ${options.l2}`,
    );
  }
  if (
    !Number.isInteger(options.epochs) ||
    options.epochs < 100 ||
    options.epochs > 5000
  ) {
    throw new FraudModelError(
      "insufficient_corpus",
      `epochs must be an integer in [100,5000], got ${options.epochs}`,
    );
  }
}

interface Standardization {
  readonly means: Float64Array;
  readonly stds: Float64Array;
}

function standardizeTrain(
  matrix: FraudFeatureMatrix,
  trainCount: number,
  featureCount: number,
): Standardization {
  const means = new Float64Array(featureCount);
  const stds = new Float64Array(featureCount);
  for (let row = 0; row < trainCount; row += 1) {
    const values = matrix.rows[row]?.values;
    if (values === undefined) continue;
    for (let column = 0; column < featureCount; column += 1) {
      means[column] = (means[column] ?? 0) + (values[column] ?? 0);
    }
  }
  if (trainCount > 0) {
    for (let column = 0; column < featureCount; column += 1) {
      means[column] = (means[column] ?? 0) / trainCount;
    }
  }
  for (let row = 0; row < trainCount; row += 1) {
    const values = matrix.rows[row]?.values;
    if (values === undefined) continue;
    for (let column = 0; column < featureCount; column += 1) {
      const delta = (values[column] ?? 0) - (means[column] ?? 0);
      stds[column] = (stds[column] ?? 0) + delta * delta;
    }
  }
  for (let column = 0; column < featureCount; column += 1) {
    const variance = trainCount > 0 ? (stds[column] ?? 0) / trainCount : 0;
    const std = Math.sqrt(Math.max(0, variance));
    stds[column] = std > 1e-12 ? std : 1;
  }
  return { means, stds };
}

function buildDesignMatrix(
  matrix: FraudFeatureMatrix,
  from: number,
  to: number,
  featureCount: number,
  standardization: Standardization,
): Float64Array {
  const rows = to - from;
  const flat = new Float64Array(rows * featureCount);
  for (let row = 0; row < rows; row += 1) {
    const source = matrix.rows[from + row];
    if (source === undefined) continue;
    for (let column = 0; column < featureCount; column += 1) {
      flat[row * featureCount + column] =
        ((source.values[column] ?? 0) - (standardization.means[column] ?? 0)) /
        (standardization.stds[column] ?? 1);
    }
  }
  return flat;
}

/** Deterministic full-batch L2 logistic regression with balanced class weights. */
function trainLogistic(
  x: Float64Array,
  y: Float64Array,
  weights: Float64Array,
  rowCount: number,
  featureCount: number,
  options: FraudFitOptions,
): {
  weights: Float64Array;
  intercept: number;
  epochsRun: number;
  converged: boolean;
} {
  const w = new Float64Array(featureCount);
  let intercept = 0;
  if (rowCount === 0) {
    return { weights: w, intercept, epochsRun: 0, converged: false };
  }
  const gradient = new Float64Array(featureCount);
  const tolerance = 1e-7;
  let epochsRun = 0;
  let converged = false;
  for (let epoch = 0; epoch < options.epochs; epoch += 1) {
    gradient.fill(0);
    let interceptGradient = 0;
    for (let row = 0; row < rowCount; row += 1) {
      let z = intercept;
      const offset = row * featureCount;
      for (let column = 0; column < featureCount; column += 1) {
        z += (w[column] ?? 0) * (x[offset + column] ?? 0);
      }
      const error = (sigmoid(z) - (y[row] ?? 0)) * (weights[row] ?? 1);
      interceptGradient += error;
      for (let column = 0; column < featureCount; column += 1) {
        gradient[column] =
          (gradient[column] ?? 0) + error * (x[offset + column] ?? 0);
      }
    }
    let maxGradient = Math.abs(interceptGradient / rowCount);
    interceptGradient /= rowCount;
    for (let column = 0; column < featureCount; column += 1) {
      const value =
        (gradient[column] ?? 0) / rowCount + options.l2 * (w[column] ?? 0);
      gradient[column] = value;
      maxGradient = Math.max(maxGradient, Math.abs(value));
    }
    intercept -= options.learningRate * interceptGradient;
    for (let column = 0; column < featureCount; column += 1) {
      w[column] =
        (w[column] ?? 0) - options.learningRate * (gradient[column] ?? 0);
    }
    epochsRun = epoch + 1;
    if (maxGradient <= tolerance) {
      converged = true;
      break;
    }
  }
  return { weights: w, intercept, epochsRun, converged };
}

function predictRows(
  x: Float64Array,
  weights: Float64Array,
  intercept: number,
  rowCount: number,
  featureCount: number,
): Float64Array {
  const scores = new Float64Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    let z = intercept;
    const offset = row * featureCount;
    for (let column = 0; column < featureCount; column += 1) {
      z += (weights[column] ?? 0) * (x[offset + column] ?? 0);
    }
    scores[row] = sigmoid(z);
  }
  return scores;
}

function quantilesOf(
  values: readonly number[],
  count: number,
): readonly number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0 || count <= 1) return [];
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const position = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((index / (count - 1)) * (sorted.length - 1))),
    );
    result.push(sorted[position] ?? 0);
  }
  return result;
}

function windowOf(
  matrix: FraudFeatureMatrix,
  from: number,
  to: number,
): FraudMetricWindow {
  let first: number | null = null;
  let last: number | null = null;
  for (let index = from; index < to; index += 1) {
    const timestamp = matrix.rows[index]?.placedAtMs;
    if (timestamp === undefined) continue;
    first = first === null ? timestamp : Math.min(first, timestamp);
    last = last === null ? timestamp : Math.max(last, timestamp);
  }
  return {
    fromIso: first === null ? null : new Date(first).toISOString(),
    toIso: last === null ? null : new Date(last).toISOString(),
  };
}

function featureStats(
  matrix: FraudFeatureMatrix,
  column: number,
  trainCount: number,
  standardization: Standardization,
): FraudFeatureStats {
  let mean = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let missing = 0;
  let trainSum = 0;
  let holdoutSum = 0;
  let holdoutCount = 0;
  for (let row = 0; row < matrix.rows.length; row += 1) {
    const entry = matrix.rows[row];
    if (entry === undefined) continue;
    const value = entry.values[column] ?? 0;
    mean += value;
    if (value < min) min = value;
    if (value > max) max = value;
    if (entry.missing.bit(column)) missing += 1;
    if (row < trainCount) trainSum += value;
    else {
      holdoutSum += value;
      holdoutCount += 1;
    }
  }
  const count = matrix.rows.length;
  const overallMean = count === 0 ? 0 : mean / count;
  let variance = 0;
  for (const entry of matrix.rows) {
    const delta = (entry.values[column] ?? 0) - overallMean;
    variance += delta * delta;
  }
  const std = count === 0 ? 0 : Math.sqrt(variance / count);
  const trainMean = trainCount === 0 ? 0 : trainSum / trainCount;
  const holdoutMean = holdoutCount === 0 ? 0 : holdoutSum / holdoutCount;
  const trainStd = standardization.stds[column] ?? 1;
  return {
    mean: overallMean,
    std,
    min: count === 0 ? 0 : min,
    max: count === 0 ? 0 : max,
    missing,
    missingRate: count === 0 ? 0 : missing / count,
    trainMean,
    holdoutMean,
    standardizedMeanShift:
      Number.isFinite(trainStd) && trainStd > 1e-12
        ? Math.abs(holdoutMean - trainMean) / trainStd
        : 0,
  };
}

/** A 25-point precision gap at the same queue size is a material repeat-offender effect. */
const NO_PRIOR_BET_PRECISION_GAP = 0.25;

/**
 * Fit the weak-label logistic model. Refuses with `insufficient_corpus` (exit 3) instead of
 * producing a model from too little data, and always reports the label support it fitted on.
 */
export function fitFraudModel(params: FraudFitParams): FraudFitResult {
  const options = resolveFitOptions(params.config, params.options);
  validateFitOptions(options);
  const matrix = extractFraudFeatures(params.corpus.records, {
    featureIds: params.config.features.map((feature) => feature.id),
    datacenterClasses: params.config.detectors.datacenterClasses,
  });
  const labels = labelVector(matrix, options.proxy);
  const rowCount = matrix.rows.length;
  const positives = labels.count();
  const positiveAccounts = new Set<string>();
  for (let index = 0; index < rowCount; index += 1) {
    if (labels.bit(index)) {
      const row = matrix.rows[index];
      if (row !== undefined) positiveAccounts.add(row.accountId.toUpperCase());
    }
  }
  if (
    rowCount < options.minRows ||
    positiveAccounts.size < options.minLabeledAccounts
  ) {
    throw new FraudModelError(
      "insufficient_corpus",
      `insufficient corpus to fit: ${rowCount} rows, ${positives} positive rows, ${positiveAccounts.size} accounts with proxy "${options.proxy}" (need >= ${options.minRows} rows and >= ${options.minLabeledAccounts} labeled accounts)`,
      {
        rows: rowCount,
        positives,
        accountsWithProxyLabel: positiveAccounts.size,
        proxy: options.proxy,
        minRows: options.minRows,
        minLabeledAccounts: options.minLabeledAccounts,
        corpusPath: params.corpus.path,
        corpusRows: params.corpus.rows,
      },
    );
  }
  const trainCount = Math.min(
    rowCount - 1,
    Math.max(1, Math.floor(rowCount * options.split)),
  );
  const holdoutCount = rowCount - trainCount;
  const featureCount = matrix.featureIds.length;
  const trainLabels = labels.slice(0, trainCount);
  const holdoutLabels = labels.slice(trainCount);
  const trainPositives = trainLabels.count();
  const trainNegatives = trainCount - trainPositives;
  if (trainPositives === 0 || trainNegatives === 0) {
    throw new FraudModelError(
      "insufficient_corpus",
      `insufficient corpus to fit: the temporal train split has ${trainPositives} positive / ${trainNegatives} negative rows for proxy "${options.proxy}"`,
      {
        rows: rowCount,
        trainRows: trainCount,
        trainPositives,
        trainNegatives,
        proxy: options.proxy,
      },
    );
  }
  const standardization = standardizeTrain(matrix, trainCount, featureCount);
  const trainX = buildDesignMatrix(
    matrix,
    0,
    trainCount,
    featureCount,
    standardization,
  );
  const holdoutX = buildDesignMatrix(
    matrix,
    trainCount,
    rowCount,
    featureCount,
    standardization,
  );
  const trainY = new Float64Array(trainCount);
  for (let index = 0; index < trainCount; index += 1) {
    trainY[index] = trainLabels.bit(index) ? 1 : 0;
  }
  const holdoutY = new Float64Array(holdoutCount);
  for (let index = 0; index < holdoutCount; index += 1) {
    holdoutY[index] = holdoutLabels.bit(index) ? 1 : 0;
  }
  const sampleWeights = new Float64Array(trainCount);
  const positiveWeight = trainCount / (2 * trainPositives);
  const negativeWeight = trainCount / (2 * trainNegatives);
  for (let index = 0; index < trainCount; index += 1) {
    sampleWeights[index] = trainLabels.bit(index)
      ? positiveWeight
      : negativeWeight;
  }
  const trained = trainLogistic(
    trainX,
    trainY,
    sampleWeights,
    trainCount,
    featureCount,
    options,
  );
  const trainScores = predictRows(
    trainX,
    trained.weights,
    trained.intercept,
    trainCount,
    featureCount,
  );
  const holdoutScores = predictRows(
    holdoutX,
    trained.weights,
    trained.intercept,
    holdoutCount,
    featureCount,
  );
  const scoreList = Array.from(holdoutScores);
  const trainScoreList = Array.from(trainScores);
  const holdoutMetrics = classificationMetrics(scoreList, holdoutLabels);
  const calibration = calibrationBins(
    scoreList,
    holdoutLabels,
    options.calibrationBins,
  );
  // A no-prior-bet row has no earlier bet for its account. If precision collapses here, the
  // ranker is finding repeat offenders rather than new ones, and the tier-1 claim must say so.
  const priorBetsColumn = matrix.featureIds.indexOf("acct_prior_bets");
  let noPriorBet: FraudNoPriorBetValidation | null = null;
  if (priorBetsColumn >= 0) {
    const indices: number[] = [];
    for (let index = 0; index < holdoutCount; index += 1) {
      const row = matrix.rows[trainCount + index];
      if (row !== undefined && (row.values[priorBetsColumn] ?? 0) === 0) {
        indices.push(index);
      }
    }
    if (indices.length > 0) {
      const noPriorScores = indices.map((index) => scoreList[index] ?? 0);
      const noPriorLabels = new Bits(indices.length);
      for (let j = 0; j < indices.length; j += 1) {
        if (holdoutLabels.bit(indices[j]!)) noPriorLabels.set(j);
      }
      noPriorBet = {
        rows: indices.length,
        positives: noPriorLabels.count(),
        metrics: classificationMetrics(noPriorScores, noPriorLabels),
      };
    }
  }
  const totalPositives = positives;
  const half = Math.floor(holdoutCount / 2);
  const firstHalfLabels = holdoutLabels.slice(0, half);
  const secondHalfLabels = holdoutLabels.slice(half);
  const firstHalfAuc = aucRoc(scoreList.slice(0, half), firstHalfLabels);
  const secondHalfAuc = aucRoc(scoreList.slice(half), secondHalfLabels);
  const drift: FraudFeatureDrift[] = matrix.featureIds
    .map((feature, column) => ({
      feature,
      standardizedMeanShift: featureStats(
        matrix,
        column,
        trainCount,
        standardization,
      ).standardizedMeanShift,
    }))
    .sort((a, b) => b.standardizedMeanShift - a.standardizedMeanShift);
  const features: FraudModelFeature[] = matrix.featureIds.map((id, column) => {
    const configFeature = params.config.features.find(
      (feature) => feature.id === id,
    );
    return {
      id,
      label: configFeature?.label ?? id,
      kind: configFeature?.kind ?? "snapshot",
      weight: trained.weights[column] ?? 0,
      stats: featureStats(matrix, column, trainCount, standardization),
    };
  });
  const holdoutRows = matrix.rows.slice(trainCount);
  const holdoutBySignal = {
    suspectedBot: 0,
    reversedCredit: 0,
    manualLog: 0,
  };
  let holdoutDeskFlagPositives = 0;
  for (let index = 0; index < holdoutRows.length; index += 1) {
    const row = holdoutRows[index];
    if (row?.labels.deskFlag !== true) continue;
    holdoutDeskFlagPositives += 1;
    if (row.labels.suspectedBot) holdoutBySignal.suspectedBot += 1;
    if (row.labels.reversedCredit) holdoutBySignal.reversedCredit += 1;
    if (row.labels.manualLog) holdoutBySignal.manualLog += 1;
  }
  const holdoutPositives = holdoutLabels.count();
  const metrics: FraudModelMetrics = {
    aucRoc: holdoutMetrics.aucRoc,
    averagePrecision: holdoutMetrics.averagePrecision,
    precisionAt1Pct: holdoutMetrics.precisionAt1Pct,
    precisionAt5Pct: holdoutMetrics.precisionAt5Pct,
    rowPrecisionAtK: holdoutMetrics.rowPrecisionAtK,
    brier: holdoutMetrics.brier,
    calibrationBins: calibration,
    labelSupport: {
      proxy: options.proxy,
      trainPositives,
      trainNegatives,
      holdoutPositives,
      holdoutNegatives: holdoutCount - holdoutPositives,
      totalPositives,
      prevalence: rowCount === 0 ? null : totalPositives / rowCount,
      holdoutDeskFlagPositives,
      holdoutBySignal,
    },
    trainWindow: windowOf(matrix, 0, trainCount),
    holdoutWindow: windowOf(matrix, trainCount, rowCount),
    rows: { train: trainCount, holdout: holdoutCount },
    epochsRun: trained.epochsRun,
    converged: trained.converged,
  };
  const stability: FraudStability = {
    firstHalfAuc,
    secondHalfAuc,
    absDelta:
      firstHalfAuc === null || secondHalfAuc === null
        ? null
        : Math.abs(firstHalfAuc - secondHalfAuc),
    firstHalfRows: firstHalfLabels.length,
    secondHalfRows: secondHalfLabels.length,
  };
  const warnings: FraudModelWarning[] = [];
  if (!trained.converged) {
    warnings.push({
      code: "not_converged",
      message: `gradient descent ran ${trained.epochsRun}/${options.epochs} epochs without reaching the convergence tolerance; treat coefficients as approximate`,
      observed: trained.epochsRun,
    });
  }
  if (stability.absDelta !== null && stability.absDelta > 0.1) {
    warnings.push({
      code: "stability_delta_gt_0.10",
      message: `the two temporal holdout halves differ in AUC by ${stability.absDelta.toFixed(3)} (>0.10): the weak label or its prevalence drifts across the window`,
      observed: Math.round(stability.absDelta * 10_000) / 10_000,
    });
  }
  const maxDrift = drift[0];
  if (maxDrift !== undefined && maxDrift.standardizedMeanShift > 1.0) {
    warnings.push({
      code: "drift_shift_gt_1.0",
      message: `feature "${maxDrift.feature}" has a standardized train-vs-holdout mean shift of ${maxDrift.standardizedMeanShift.toFixed(3)} (>1.0); the feature is kept, not dropped`,
      observed: Math.round(maxDrift.standardizedMeanShift * 10_000) / 10_000,
    });
  }
  const noPriorBetAt20 = noPriorBet?.metrics.rowPrecisionAtK.find(
    (row) => row.k === 20,
  );
  const holdoutAt20 = holdoutMetrics.rowPrecisionAtK.find(
    (row) => row.k === 20,
  );
  const noPriorPrecision = noPriorBetAt20?.precision ?? null;
  const holdoutPrecision = holdoutAt20?.precision ?? null;
  if (
    noPriorPrecision !== null &&
    holdoutPrecision !== null &&
    holdoutPrecision - noPriorPrecision > NO_PRIOR_BET_PRECISION_GAP
  ) {
    warnings.push({
      code: "no_prior_bet_precision_gap",
      message: `no-prior-bet precision@20 is ${noPriorPrecision.toFixed(3)} vs ${holdoutPrecision.toFixed(3)} overall (n=${noPriorBet?.rows ?? 0} rows, ${noPriorBet?.positives ?? 0} positive rows): the ranker mostly finds repeat offenders, so do not quote the overall precision for new accounts`,
      observed:
        Math.round((holdoutPrecision - noPriorPrecision) * 10_000) / 10_000,
    });
  }
  const staleSources = (params.sources ?? [params.corpus.source]).filter(
    (source) => source.stale || source.state === "stale",
  );
  if (staleSources.length > 0) {
    warnings.push({
      code: "source_stale",
      message: `stale source(s) contributed to this fit: ${staleSources
        .map(
          (source) => `${source.id} (age ${source.ageSeconds ?? "unknown"}s)`,
        )
        .join(", ")}`,
      observed: staleSources.map((source) => source.id).join(","),
    });
  }
  const validation: FraudModelValidation = {
    holdout: holdoutMetrics,
    noPriorBet,
    stability,
    drift,
    warnings,
  };
  const scoreMap: FraudModelScoreMap = {
    size: options.scoreQuantiles,
    quantiles: quantilesOf(trainScoreList, options.scoreQuantiles),
  };
  const fixtureSourcesExcluded = params.sources
    ? params.sources
        .filter(
          (source) =>
            source.provenance === "fixture" &&
            (source.id === "customer_book" ||
              source.id === "ip_tracker_clusters"),
        )
        .map((source) => source.id)
    : ["customer_book", "ip_tracker_clusters"];
  const artifact: FraudModelArtifact = {
    schemaVersion: FRAUD_MODEL_SCHEMA_VERSION,
    kind: FRAUD_MODEL_KIND,
    fittedAt: params.now.toISOString(),
    corpusPath: params.corpus.path,
    corpusSha256: params.corpus.sha256,
    corpusRows: rowCount,
    split: options.split,
    proxy: options.proxy,
    spec: {
      schemaVersion: FRAUD_MODEL_SCHEMA_VERSION,
      corpusSha256: params.corpus.sha256,
      corpusRows: rowCount,
      split: options.split,
      proxy: options.proxy,
      epochsRequested: options.epochs,
      epochsRun: trained.epochsRun,
      converged: trained.converged,
      l2: options.l2,
      learningRate: options.learningRate,
      seed: options.seed,
      featureCount,
    },
    features,
    weights: Array.from(trained.weights),
    intercept: trained.intercept,
    metrics,
    validation,
    scoreMap,
    scoreBands: options.scoreBands,
    limits: FRAUD_MODEL_LIMITS,
    provenance: {
      corpusPath: params.corpus.path,
      corpusSha256: params.corpus.sha256,
      corpusRawRows: params.corpus.rows,
      corpusRows: rowCount,
      excludedRows: matrix.droppedNoTimestamp,
      sources: (params.sources ?? [params.corpus.source]).map((source) => ({
        id: source.id,
        state: source.state,
        provenance: source.provenance,
        path: source.path,
      })),
      fixtureSourcesExcluded,
      generatedAt: params.now.toISOString(),
    },
  };
  return {
    artifact,
    extraction: {
      rows: rowCount,
      droppedNoTimestamp: matrix.droppedNoTimestamp,
      featureCount,
      positiveAccounts: positiveAccounts.size,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Artifact read / write                                                       */
/* -------------------------------------------------------------------------- */

function modelStateAbsent(path: string, reason: string): FraudModelState {
  return {
    present: false,
    path: FRAUD_MODEL_REL_PATH,
    fittedAt: null,
    schemaVersion: null,
    corpusRows: null,
    split: null,
    metrics: null,
    limits: FRAUD_MODEL_LIMITS,
    reason,
    command: FRAUD_MODEL_FIT_COMMAND,
  };
}

/** Absolute artifact path under the repo root. */
export function fraudModelPath(root: string): string {
  return join(root, FRAUD_MODEL_REL_PATH);
}

export async function readFraudModel(root: string): Promise<{
  state: FraudModelState;
  artifact: FraudModelArtifact | null;
  absolutePath: string;
}> {
  const absolutePath = fraudModelPath(root);
  let raw: unknown;
  try {
    raw = await Bun.file(absolutePath).json();
  } catch (error) {
    const exists = await Bun.file(absolutePath).exists();
    return {
      state: modelStateAbsent(
        FRAUD_MODEL_REL_PATH,
        exists
          ? `artifact exists but is unreadable: ${
              error instanceof Error ? error.message : String(error)
            }`
          : "no fitted model artifact",
      ),
      artifact: null,
      absolutePath,
    };
  }
  const record =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (
    record === null ||
    record["schemaVersion"] !== FRAUD_MODEL_SCHEMA_VERSION ||
    record["kind"] !== FRAUD_MODEL_KIND
  ) {
    return {
      state: modelStateAbsent(
        FRAUD_MODEL_REL_PATH,
        `artifact exists but is unreadable: expected schemaVersion ${FRAUD_MODEL_SCHEMA_VERSION} and kind "${FRAUD_MODEL_KIND}"`,
      ),
      artifact: null,
      absolutePath,
    };
  }
  const artifact = record as unknown as FraudModelArtifact;
  if (
    !Array.isArray(artifact.features) ||
    !Array.isArray(artifact.weights) ||
    typeof artifact.intercept !== "number" ||
    artifact.metrics === undefined ||
    artifact.validation === undefined ||
    artifact.scoreMap === undefined ||
    !Array.isArray(artifact.scoreMap.quantiles)
  ) {
    return {
      state: modelStateAbsent(
        FRAUD_MODEL_REL_PATH,
        "artifact exists but is missing required fitted fields",
      ),
      artifact: null,
      absolutePath,
    };
  }
  return {
    state: {
      present: true,
      path: FRAUD_MODEL_REL_PATH,
      fittedAt:
        typeof artifact.fittedAt === "string" ? artifact.fittedAt : null,
      schemaVersion: FRAUD_MODEL_SCHEMA_VERSION,
      corpusRows: artifact.corpusRows,
      split: artifact.split,
      metrics: {
        aucRoc: artifact.metrics.aucRoc ?? null,
        averagePrecision: artifact.metrics.averagePrecision ?? null,
        brier: artifact.metrics.brier ?? null,
      },
      limits: artifact.limits.length > 0 ? artifact.limits : FRAUD_MODEL_LIMITS,
      reason: null,
      command: FRAUD_MODEL_FIT_COMMAND,
    },
    artifact,
    absolutePath,
  };
}

/**
 * The only write in this plugin: atomic tmp+rename of `reports/security/fraud-model.json`
 * (mkdir -p, mode 0600). Callers must gate on an explicit `--write`.
 */
export async function writeFraudModelArtifact(
  root: string,
  artifact: FraudModelArtifact,
): Promise<string> {
  const absolutePath = fraudModelPath(root);
  const directory = dirname(absolutePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${stableJson(artifact)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, absolutePath);
    await chmod(absolutePath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return FRAUD_MODEL_REL_PATH;
}

/** sha256 of the stable serialization (artifact integrity tag; reported, not trusted blindly). */
export function fraudModelArtifactDigest(artifact: FraudModelArtifact): string {
  return sha256Hex(stableJson(artifact));
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface FraudAccountContribution {
  readonly feature: string;
  readonly weight: number;
  readonly contribution: number;
}

export interface FraudAccountScore {
  readonly accountId: string;
  readonly rows: number;
  readonly score: number | null;
  readonly percentile: number | null;
  readonly band: FraudScoreBand | null;
  readonly probability: number | null;
  readonly contributions: readonly FraudAccountContribution[];
  readonly provenance: {
    readonly fittedAt: string;
    readonly proxy: FraudProxyLabel;
    readonly corpusSha256: string | null;
  };
}

/** Percentile of a probability against the in-sample train CDF stored in the artifact. */
export function scoreFromQuantiles(
  probability: number,
  quantiles: readonly number[],
): { percentile: number | null; score: number | null } {
  if (quantiles.length === 0) return { percentile: null, score: null };
  let low = 0;
  let high = quantiles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((quantiles[middle] ?? Number.POSITIVE_INFINITY) <= probability) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const percentile = (low / quantiles.length) * 100;
  return {
    percentile,
    score: Math.max(0, Math.min(100, Math.round(percentile))),
  };
}

export function bandForScore(
  score: number,
  bands: FraudModelScoreBands,
): FraudScoreBand {
  if (score <= bands.lowMax) return "low";
  if (score <= bands.mediumMax) return "medium";
  if (score <= bands.highMax) return "high";
  return "critical";
}

/**
 * Score one account from an extracted matrix: average the account's row feature vectors, apply the
 * fitted standardization/weights, then map the probability through the train-CDF score map.
 * Returns null for an unknown account (the CLI turns that into `unknown_subject`).
 */
export function scoreAccountWithModel(
  artifact: FraudModelArtifact,
  matrix: FraudFeatureMatrix,
  accountId: string,
): FraudAccountScore | null {
  const wanted = accountId.trim().toUpperCase();
  if (wanted === "") return null;
  const matched = matrix.rows.filter(
    (row) => row.accountId.toUpperCase() === wanted,
  );
  if (matched.length === 0) return null;
  const means = matched.map((row) => row.values);
  const featureCount = matrix.featureIds.length;
  const featureValues: number[] = Array.from({ length: featureCount }, () => 0);
  for (const values of means) {
    for (let column = 0; column < featureCount; column += 1) {
      featureValues[column] =
        (featureValues[column] ?? 0) + (values[column] ?? 0) / means.length;
    }
  }
  const statsById = new Map(
    artifact.features.map((feature) => [feature.id, feature.stats]),
  );
  let z = artifact.intercept;
  const contributions: FraudAccountContribution[] = [];
  for (let column = 0; column < featureCount; column += 1) {
    const id = matrix.featureIds[column] ?? "";
    const stats = statsById.get(id);
    const mean = stats?.trainMean ?? 0;
    const std = stats?.std ?? 0;
    const standardized =
      Number.isFinite(std) && std > 1e-12
        ? ((featureValues[column] ?? 0) - mean) / std
        : 0;
    const weight = artifact.weights[column] ?? 0;
    z += weight * standardized;
    contributions.push({
      feature: id,
      weight,
      contribution: weight * standardized,
    });
  }
  const probability = sigmoid(z);
  const { percentile, score } = scoreFromQuantiles(
    probability,
    artifact.scoreMap.quantiles,
  );
  contributions.sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
  );
  return {
    accountId: matched[0]?.accountId ?? accountId,
    rows: matched.length,
    score,
    percentile,
    band: score === null ? null : bandForScore(score, artifact.scoreBands),
    probability,
    contributions: contributions.slice(0, 10),
    provenance: {
      fittedAt: artifact.fittedAt,
      proxy: artifact.proxy,
      corpusSha256: artifact.corpusSha256,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Report payload helper                                                       */
/* -------------------------------------------------------------------------- */

function roundReportNumber(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundReportNullable(value: number | null, digits = 3): number | null {
  return value === null ? null : roundReportNumber(value, digits);
}

function roundRowPrecisionAtK(
  rows: readonly FraudRowPrecisionAtK[] | undefined,
): readonly FraudRowPrecisionAtK[] {
  return (rows ?? []).map((row) => ({
    ...row,
    precision: roundReportNullable(row.precision),
    recall: roundReportNullable(row.recall),
    lift: roundReportNullable(row.lift),
  }));
}

function roundClassificationMetrics(metrics: FraudClassificationMetrics) {
  return {
    aucRoc: roundReportNullable(metrics.aucRoc),
    averagePrecision: roundReportNullable(metrics.averagePrecision),
    precisionAt1Pct: roundReportNullable(metrics.precisionAt1Pct),
    precisionAt5Pct: roundReportNullable(metrics.precisionAt5Pct),
    rowPrecisionAtK: roundRowPrecisionAtK(metrics.rowPrecisionAtK),
    brier: roundReportNullable(metrics.brier),
  };
}

export interface ModelReportPayloadOptions {
  /**
   * Opt-in: include the full train-CDF quantile array (1001 floats, ~19 KB) in the payload.
   * The artifact always retains it; the default answer reports the shape only so an agent/tool
   * payload stays small.
   */
  readonly includeScoreMap?: boolean;
}

/** The reference-bearing fields a metric-metadata definition can carry. */
export interface MetricMetadataDefinition {
  readonly unit?: string;
  readonly label?: string;
  readonly name: string;
  readonly kind: string;
  readonly description?: string;
  readonly baselineRef?: string;
  readonly population?: string;
  readonly subsetOf?: string;
  readonly subsets?: readonly string[];
  readonly rows?: number | null;
  readonly k?: number;
  readonly maxAchievable?: number | null;
  readonly kSamples?: number | null;
  readonly kPositives?: number | null;
  readonly positives?: number | null;
  /** Population size (rows) or baseline rate, depending on `kind`. */
  readonly value?: unknown;
  readonly state?: string | undefined;
  /** What unblocks a not-measured row, e.g. accountDispositionFeed. */
  readonly blockedBy?: string | undefined;
  /** Where the full table lives in the report, for a headline row. */
  readonly detailRef?: string;
  readonly derivedFrom?: string;
}

export interface MetricVocabulary {
  readonly unit?: Readonly<Record<string, string>>;
  readonly label?: Readonly<Record<string, string>>;
}

/** Levenshtein distance over short definition names; candidates are fewer than 20. */
function editDistance(a: string, b: string): number {
  const columns = b.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column < columns; column += 1) {
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Longest shared prefix, so long names with a stable stem still get a useful hint. */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/** Up to three nearest names by distance, with the shared-stem OR edit-distance predicate. */
function suggestNames(
  name: string,
  candidates: readonly string[],
): readonly string[] {
  return candidates
    .map((candidate) => ({
      name: candidate,
      prefix: commonPrefixLength(name, candidate),
      distance: editDistance(name, candidate),
    }))
    .filter((candidate) => candidate.prefix >= 4 || candidate.distance <= 3)
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        b.prefix - a.prefix ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 3)
    .map((candidate) => candidate.name);
}

function suggestionHint(names: readonly string[]): string {
  if (names.length === 0) return "; no close candidates";
  if (names.length === 1) return `; did you mean "${names[0]}"?`;
  return `; nearest: ${names.map((name) => `"${name}"`).join(", ")}`;
}

/**
 * Check the FK-by-name contract: a `baseline` must name a `baseline` row, a `population` or
 * `subsetOf` must name a `population` row, and names must be unique. Cheap enough to run on every
 * report; turns the convention into a checked invariant instead of a schema-version promise.
 */
/** Resolve a dot path in a report payload; undefined means the pointer is dangling. */
function getPath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Check the metadata contract: names are unique; baseline/population/subsetOf references resolve
 * by kind; stored computed fields (maxAchievable, baseline value) match their inputs; and, when a
 * report root is given, detailRef resolves in that report. Cheap enough to run on every report.
 */
export function validateMetricMetadata(
  metadata: {
    readonly schemaVersion: number;
    readonly vocabulary?: MetricVocabulary;
    readonly definitions: readonly MetricMetadataDefinition[];
  },
  root?: unknown,
): void {
  if (metadata.schemaVersion !== FRAUD_MODEL_SCHEMA_VERSION) {
    throw new Error(
      `metricMetadata: schemaVersion ${metadata.schemaVersion} but validator expects ${FRAUD_MODEL_SCHEMA_VERSION}; re-run "model fit --write"`,
    );
  }
  const byName = new Map<string, MetricMetadataDefinition>();
  for (const row of metadata.definitions) {
    if (!isMetricMetadataKind(row.kind)) {
      throw new Error(
        `metricMetadata: ${row.name} has unknown kind "${row.kind}"; allowed: ${METRIC_METADATA_KINDS.join(", ")}`,
      );
    }
    if (byName.has(row.name)) {
      throw new Error(`metricMetadata: duplicate definition "${row.name}"`);
    }
    byName.set(row.name, row);
  }
  const requireKind = (
    source: string,
    field: string,
    targetName: string,
    kind: string,
  ): void => {
    const target = byName.get(targetName);
    const hint = suggestionHint(
      suggestNames(
        targetName,
        [...byName.values()]
          .filter((row) => row.kind === kind)
          .map((row) => row.name),
      ),
    );
    if (target === undefined) {
      throw new Error(
        `metricMetadata: ${source}.${field} -> "${targetName}" not found${hint}`,
      );
    }
    if (target.kind !== kind) {
      throw new Error(
        `metricMetadata: ${source}.${field} -> "${targetName}" is ${target.kind}, not ${kind}${hint}`,
      );
    }
  };
  for (const row of metadata.definitions) {
    if (row.unit !== undefined) {
      const declaration = metadata.vocabulary?.unit?.[row.unit];
      if (declaration === undefined) {
        throw new Error(
          `metricMetadata: ${row.name}.unit "${row.unit}" has no vocabulary entry`,
        );
      }
    }
    if (row.label !== undefined) {
      const declaration = metadata.vocabulary?.label?.[row.label];
      if (declaration === undefined) {
        throw new Error(
          `metricMetadata: ${row.name}.label "${row.label}" has no vocabulary entry`,
        );
      }
    }
    if (row.baselineRef !== undefined) {
      requireKind(row.name, "baselineRef", row.baselineRef, "baseline");
    }
    if (row.population !== undefined) {
      requireKind(row.name, "population", row.population, "population");
    }
    if (row.subsetOf !== undefined) {
      requireKind(row.name, "subsetOf", row.subsetOf, "population");
      const parent = byName.get(row.subsetOf);
      if (parent?.subsets?.includes(row.name) !== true) {
        throw new Error(
          `metricMetadata: ${row.name}.subsetOf = "${row.subsetOf}" but parent.subsets does not list "${row.name}"`,
        );
      }
    }
    if (row.subsets !== undefined) {
      for (const subset of row.subsets) {
        const target = byName.get(subset);
        if (target?.kind !== "population" || target.subsetOf !== row.name) {
          throw new Error(
            `metricMetadata: ${row.name}.subsets -> "${subset}" is not a population with subsetOf "${row.name}"`,
          );
        }
      }
    }
  }
  // A baseline value is positives / rows for the population it names.
  for (const row of metadata.definitions) {
    if (row.kind !== "baseline") continue;
    if (row.value === null) {
      if (row.state !== "not_measured") {
        throw new Error(
          `metricMetadata: ${row.name} has a null baseline value without state "not_measured"`,
        );
      }
      continue;
    }
    if (typeof row.value !== "number") {
      throw new Error(
        `metricMetadata: ${row.name} baseline value must be a number or null`,
      );
    }
    const population =
      row.population === undefined ? undefined : byName.get(row.population);
    if (
      population === undefined ||
      typeof population.rows !== "number" ||
      population.positives === null ||
      population.positives === undefined
    ) {
      throw new Error(
        `metricMetadata: ${row.name} baseline cannot resolve rows/positives from "${row.population ?? "?"}"`,
      );
    }
    const expected = population.positives / population.rows;
    if (Math.abs(row.value - expected) > 1e-6) {
      throw new Error(
        `metricMetadata: ${row.name}.value ${row.value} != positives/rows = ${expected}`,
      );
    }
  }
  // A stored maxAchievable is min(k, positives) / k; the top-k counts must also fit k.
  for (const row of metadata.definitions) {
    if (row.kind !== "metric") continue;
    if (row.k === undefined) continue;
    if (row.maxAchievable === null) {
      if (row.state !== "not_measured") {
        throw new Error(
          `metricMetadata: ${row.name} has a null maxAchievable without state "not_measured"`,
        );
      }
      continue;
    }
    if (row.maxAchievable === undefined) {
      throw new Error(
        `metricMetadata: ${row.name} (metric with k) has no maxAchievable`,
      );
    }
    if (row.k === undefined || !Number.isInteger(row.k) || row.k <= 0) {
      throw new Error(
        `metricMetadata: ${row.name} (metric with k) needs a positive integer k`,
      );
    }
    if (row.kSamples === null || row.kSamples === undefined) {
      throw new Error(
        `metricMetadata: ${row.name} (metric with k) has no kSamples`,
      );
    }
    if (row.kPositives === null || row.kPositives === undefined) {
      throw new Error(
        `metricMetadata: ${row.name} (metric with k) has no kPositives`,
      );
    }
    if (row.kSamples > row.k) {
      throw new Error(
        `metricMetadata: ${row.name}.kSamples ${row.kSamples} > k ${row.k}`,
      );
    }
    if (row.kPositives > row.kSamples) {
      throw new Error(
        `metricMetadata: ${row.name}.kPositives ${row.kPositives} > kSamples ${row.kSamples}`,
      );
    }
    if (row.detailRef === undefined) {
      throw new Error(
        `metricMetadata: ${row.name} (metric with k) has no detailRef`,
      );
    }
    const population =
      row.population === undefined ? undefined : byName.get(row.population);
    if (population?.positives === null || population?.positives === undefined) {
      throw new Error(
        `metricMetadata: ${row.name} stores maxAchievable but population "${row.population ?? "?"}" has no positive`,
      );
    }
    const expected = Math.min(row.k, population.positives) / row.k;
    if (Math.abs(row.maxAchievable - expected) > 1e-6) {
      throw new Error(
        `metricMetadata: ${row.name}.maxAchievable ${row.maxAchievable} != min(k=${row.k}, positives=${population.positives})/k = ${expected}`,
      );
    }
  }
  for (const row of metadata.definitions) {
    if (row.state === "not_measured" && (row.blockedBy ?? "").trim() === "") {
      throw new Error(
        `metricMetadata: ${row.name} is not_measured but has no blockedBy`,
      );
    }
  }
  if (root !== undefined) {
    for (const row of metadata.definitions) {
      if (row.detailRef === undefined) continue;
      const target = getPath(root, row.detailRef);
      if (target === undefined) {
        throw new Error(
          `metricMetadata: ${row.name}.detailRef -> "${row.detailRef}" does not resolve in the report`,
        );
      }
      if (row.state === "not_measured") {
        if (target === null || typeof target !== "object") {
          throw new Error(
            `metricMetadata: ${row.name}.detailRef -> "${row.detailRef}" is not a state container`,
          );
        }
        const container = target as Record<string, unknown>;
        if (container["state"] !== "not_measured") {
          throw new Error(
            `metricMetadata: ${row.name}.detailRef -> "${row.detailRef}" has no state "not_measured"`,
          );
        }
        if (container["metrics"] !== undefined) {
          throw new Error(
            `metricMetadata: ${row.name}.detailRef -> "${row.detailRef}" carries metrics despite state "not_measured"`,
          );
        }
      }
    }
  }
}

/**
 * Metric metadata is built from the fitted artifact, not a static constant: a population size,
 * a base rate or a label mix that cannot be read from the numbers would be a comment, not a
 * contract. Every row separates `kind` (what the row is) from `description` (what it says).
 */
function buildMetricMetadata(artifact: FraudModelArtifact) {
  const { rows, labelSupport } = artifact.metrics;
  const noPriorBet = artifact.validation.noPriorBet ?? null;
  const holdoutRate =
    rows.holdout === 0 ? null : labelSupport.holdoutPositives / rows.holdout;
  const noPriorBetRate =
    noPriorBet === null || noPriorBet.rows === 0
      ? null
      : noPriorBet.positives / noPriorBet.rows;
  const signals = labelSupport.holdoutBySignal ?? {
    suspectedBot: 0,
    reversedCredit: 0,
    manualLog: 0,
  };
  const holdoutHeadline =
    artifact.metrics.rowPrecisionAtK.find(
      (row) => row.k === FRAUD_HEADLINE_K,
    ) ?? null;
  const noPriorHeadline =
    noPriorBet?.metrics.rowPrecisionAtK.find(
      (row) => row.k === FRAUD_HEADLINE_K,
    ) ?? null;
  const maxAchievable = (positives: number | null): number | null =>
    positives === null
      ? null
      : Math.min(FRAUD_HEADLINE_K, positives) / FRAUD_HEADLINE_K;
  const metadata = {
    kind: "fraud-model-metric-metadata",
    schemaVersion: FRAUD_MODEL_SCHEMA_VERSION,
    proxy: artifact.proxy,
    vocabulary: {
      unit: {
        "bet-row":
          "One getBetReport bet row; not an account, sport, sub-sport, market, or period.",
        account: "One account; the queue subject, not a bet row.",
      },
      label: {
        desk_flag:
          "suspectedBot OR reversedCredit OR manualLog; never a confirmed fraud outcome.",
        suspected_bot:
          "suspectedBot row flag; never a confirmed fraud outcome.",
        reversed_credit:
          "reversedCredit row flag; never a confirmed fraud outcome.",
        "account-disposition":
          "An adjudicated account outcome; no account holdout exists yet.",
      },
    },
    definitions: [
      {
        name: "temporalHoldout",
        kind: "population",
        rows: rows.holdout,
        positives: labelSupport.holdoutPositives,
        subsets: ["noPriorBet"],
        description: "The last 30% of rows by logTime (temporal split).",
      },
      {
        name: "noPriorBet",
        kind: "population",
        subsetOf: "temporalHoldout",
        rows: noPriorBet?.rows ?? null,
        positives: noPriorBet?.positives ?? null,
        description:
          "The same row table restricted to holdout rows whose account has no earlier bet in the corpus.",
      },
      {
        name: "temporalHoldoutPositiveRate",
        kind: "baseline",
        unit: "bet-row",
        label: artifact.proxy,
        population: "temporalHoldout",
        value: roundReportNullable(holdoutRate, 6),
        state: holdoutRate === null ? "not_measured" : undefined,
        blockedBy: holdoutRate === null ? "noHoldoutRows" : undefined,
        description:
          "The overall desk_flag rate in the temporal holdout; rowPrecisionAtK is lift over this rate.",
      },
      {
        name: "noPriorBetPositiveRate",
        kind: "baseline",
        unit: "bet-row",
        label: artifact.proxy,
        population: "noPriorBet",
        value: roundReportNullable(noPriorBetRate, 6),
        state: noPriorBetRate === null ? "not_measured" : undefined,
        blockedBy: noPriorBetRate === null ? "noPriorBetSlice" : undefined,
        description:
          "The desk_flag rate in the no-prior-bet slice; rowPrecisionAtKNoPriorBet is lift over this rate.",
      },
      {
        name: "rowPrecisionAtK",
        kind: "metric",
        unit: "bet-row",
        label: artifact.proxy,
        population: "temporalHoldout",
        baselineRef: "temporalHoldoutPositiveRate",
        detailRef: "metrics.rowPrecisionAtK",
        k: FRAUD_HEADLINE_K,
        value: roundReportNullable(holdoutHeadline?.precision ?? null),
        maxAchievable: roundReportNullable(
          maxAchievable(labelSupport.holdoutPositives),
          6,
        ),
        kSamples: holdoutHeadline?.kSamples ?? null,
        kPositives: holdoutHeadline?.kPositives ?? null,
        description:
          "Headline at k=20 (full table in metrics.rowPrecisionAtK): of the top-k holdout bet rows by model score, the share whose own desk_flag is true.",
      },
      {
        name: "rowPrecisionAtKNoPriorBet",
        kind: "metric",
        unit: "bet-row",
        label: artifact.proxy,
        population: "noPriorBet",
        baselineRef: "noPriorBetPositiveRate",
        detailRef:
          noPriorBet === null
            ? "validation.noPriorBet"
            : "validation.noPriorBet.metrics.rowPrecisionAtK",
        state: noPriorBet === null ? "not_measured" : undefined,
        blockedBy: noPriorBet === null ? "noPriorBetSlice" : undefined,
        k: FRAUD_HEADLINE_K,
        value: roundReportNullable(noPriorHeadline?.precision ?? null),
        maxAchievable: roundReportNullable(
          maxAchievable(noPriorBet?.positives ?? null),
          6,
        ),
        kSamples: noPriorHeadline?.kSamples ?? null,
        kPositives: noPriorHeadline?.kPositives ?? null,
        description:
          "The same headline and cap on accounts with no earlier bet: maxAchievable = min(k, positives) / k, so a slice with fewer than k positives cannot reach 1.0.",
      },
      {
        name: "labelComposition",
        kind: "distribution",
        population: "temporalHoldout",
        value: {
          suspectedBot: signals.suspectedBot,
          reversedCredit: signals.reversedCredit,
          manualLog: signals.manualLog,
        },
        description:
          "Counts of the composite desk_flag holdout positives by signal; the signals overlap, so counts can sum above positives. labelComposition describes the composite desk_flag. Metric rows measure against the fitted proxy (see metricMetadata.proxy); the two labels have different positive sets, and correlation between them is not measured here.",
      },
      {
        name: "accountHoldout",
        kind: "population",
        state: "not_measured",
        blockedBy: "accountDispositionFeed",
        description:
          "No account-level holdout exists yet; accountPrecisionAtK cannot be computed without one.",
      },
      {
        name: "accountPrecisionAtK",
        kind: "metric",
        state: "not_measured",
        blockedBy: "accountDispositionFeed",
        unit: "account",
        label: "account-disposition",
        population: "accountHoldout",
        description:
          "fraud_queue ranks accounts; account-level precision@k is the operational KPI and is not measured yet.",
      },
      {
        name: "notStratifiedBy",
        kind: "caveat",
        value: ["sport", "subSport", "market", "period", "agent"],
        description:
          "No per-sport, per-subSport, per-market, per-period or per-agent precision is claimed; those fields are not the unit.",
      },
      {
        name: "accountQueue",
        kind: "caveat",
        value: "account",
        description:
          "fraud_queue ranks accounts; these row metrics are not account precision.",
      },
    ],
  };
  return metadata;
}

/**
 * The `model report` payload (contract shape; client half reads these keys). Numbers are rounded
 * to 6 decimals for display and the score-map quantiles are opt-in: the artifact keeps full
 * precision, the tool answer stays compact (`--include-score-map` restores the quantiles).
 */
export function modelReportPayload(
  artifact: FraudModelArtifact,
  state: FraudModelState,
  options: ModelReportPayloadOptions = {},
): Record<string, unknown> {
  const metrics = artifact.metrics;
  const validation = artifact.validation;
  const noPriorBet = validation.noPriorBet ?? null;
  const metricMetadata = buildMetricMetadata(artifact);
  const payload: Record<string, unknown> = {
    kind: FRAUD_MODEL_KIND,
    present: true,
    path: state.path,
    fittedAt: artifact.fittedAt,
    metricMetadata,
    spec: artifact.spec,
    features: artifact.features.map((feature) => ({
      id: feature.id,
      label: feature.label,
      kind: feature.kind,
      weight: roundReportNumber(feature.weight),
      stats: {
        mean: roundReportNumber(feature.stats.mean),
        std: roundReportNumber(feature.stats.std),
        missing: feature.stats.missing,
        missingRate: roundReportNumber(feature.stats.missingRate),
        trainMean: roundReportNumber(feature.stats.trainMean),
        holdoutMean: roundReportNumber(feature.stats.holdoutMean),
      },
    })),
    intercept: roundReportNumber(artifact.intercept),
    metrics: {
      aucRoc: roundReportNullable(metrics.aucRoc),
      averagePrecision: roundReportNullable(metrics.averagePrecision),
      precisionAt1Pct: roundReportNullable(metrics.precisionAt1Pct),
      precisionAt5Pct: roundReportNullable(metrics.precisionAt5Pct),
      rowPrecisionAtK: roundRowPrecisionAtK(metrics.rowPrecisionAtK),
      brier: roundReportNullable(metrics.brier),
      calibrationBins: metrics.calibrationBins.map((bin) => ({
        lower: roundReportNumber(bin.lower),
        upper: roundReportNumber(bin.upper),
        count: bin.count,
        predictedMean: roundReportNullable(bin.predictedMean),
        observedRate: roundReportNullable(bin.observedRate),
      })),
      labelSupport: metrics.labelSupport,
      trainWindow: metrics.trainWindow,
      holdoutWindow: metrics.holdoutWindow,
      rows: metrics.rows,
      epochsRun: metrics.epochsRun,
      converged: metrics.converged,
    },
    validation: {
      holdout: roundClassificationMetrics(validation.holdout),
      noPriorBet:
        noPriorBet === null
          ? { state: "not_measured" }
          : {
              rows: noPriorBet.rows,
              positives: noPriorBet.positives,
              metrics: roundClassificationMetrics(noPriorBet.metrics),
            },
      stability: {
        firstHalfAuc: roundReportNullable(validation.stability.firstHalfAuc),
        secondHalfAuc: roundReportNullable(validation.stability.secondHalfAuc),
        absDelta: roundReportNullable(validation.stability.absDelta),
        firstHalfRows: validation.stability.firstHalfRows,
        secondHalfRows: validation.stability.secondHalfRows,
      },
      drift: validation.drift.map((row) => ({
        feature: row.feature,
        standardizedMeanShift: roundReportNumber(row.standardizedMeanShift),
      })),
      warnings: validation.warnings,
    },
    scoreMap:
      options.includeScoreMap === true
        ? {
            size: artifact.scoreMap.size,
            quantileCount: artifact.scoreMap.quantiles.length,
            quantiles: artifact.scoreMap.quantiles,
          }
        : {
            size: artifact.scoreMap.size,
            quantileCount: artifact.scoreMap.quantiles.length,
          },
    scoreBands: artifact.scoreBands,
    limits: artifact.limits,
    /** Integrity tag of the serialized artifact (the payload only renders rounded numbers). */
    artifactSha256: fraudModelArtifactDigest(artifact),
    corpusProvenance: {
      corpusPath: artifact.provenance.corpusPath,
      corpusSha256: artifact.provenance.corpusSha256,
      corpusRawRows: artifact.provenance.corpusRawRows,
      corpusRows: artifact.provenance.corpusRows,
      excludedRows: artifact.provenance.excludedRows,
      fixtureSourcesExcluded: artifact.provenance.fixtureSourcesExcluded,
    },
  };
  validateMetricMetadata(metricMetadata, payload);
  return payload;
}

/** Truthful refusal for every command that needs a fitted artifact. */
export function modelMissingRefusal(): FraudModelError {
  return new FraudModelError(
    "model_missing",
    `no fitted model artifact at ${FRAUD_MODEL_REL_PATH}; run \`${FRAUD_MODEL_FIT_COMMAND}\` after reviewing the dry-run metrics`,
    {
      path: FRAUD_MODEL_REL_PATH,
      command: FRAUD_MODEL_FIT_COMMAND,
      hint: "the artifact is written only with --write and only under reports/security/",
    },
  );
}

export type { FraudFeatureConfig, FraudModelHyperparameters };
export { DEFAULT_FRAUD_CONFIG };
