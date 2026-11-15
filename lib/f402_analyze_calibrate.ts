/**
 * Replay harness: predict at time t from history available then, score against
 * what later happened. Pure Brier / calibration math is ready for a live pull.
 */

import {
  F402AnalyzeError,
  type AnalyzedAccount,
  type PullProjection,
} from "./f402_analyze_ingest.ts";
import {
  predictAccount,
  type AccountPrediction,
} from "./f402_analyze_predict.ts";

export const CALIBRATION_MIN_SAMPLE = 30;
export const CALIBRATION_BIN_MIN = 5;
export const DEFAULT_HORIZON_DAYS = 7;

export interface CalibrationBin {
  readonly lo: number;
  readonly hi: number;
  readonly predictedMean: number;
  readonly observedRate: number;
  readonly count: number;
  readonly lowSample: boolean;
}

export interface BacktestRow {
  readonly accountId: string;
  readonly asOfIso: string;
  readonly horizonEndIso: string;
  readonly predicted: number;
  readonly observed: 0 | 1;
  readonly reasons: readonly string[];
}

export interface CalibrationReport {
  readonly horizonDays: number;
  readonly windowCount: number;
  readonly brier: number;
  readonly lowSample: boolean;
  readonly lowSampleThreshold: number;
  readonly observedRate: number;
  readonly predictedMean: number;
  readonly bins: readonly CalibrationBin[];
  readonly rows: readonly BacktestRow[];
}

export function brierScore(
  predicted: readonly number[],
  observed: readonly number[],
): number {
  if (predicted.length === 0 || predicted.length !== observed.length) {
    throw new F402AnalyzeError(
      "config",
      "calibrate",
      "Brier score needs equal, non-empty predicted and observed vectors",
    );
  }
  let sum = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    const p = predicted[i]!;
    const y = observed[i]!;
    if (!Number.isFinite(p) || !Number.isFinite(y)) {
      throw new F402AnalyzeError(
        "config",
        "calibrate",
        "non-finite Brier input",
      );
    }
    sum += (p - y) ** 2;
  }
  return Number((sum / predicted.length).toFixed(6));
}

export function calibrationTable(
  predicted: readonly number[],
  observed: readonly number[],
  binWidth = 0.1,
  binMin = CALIBRATION_BIN_MIN,
): CalibrationBin[] {
  if (predicted.length !== observed.length) {
    throw new F402AnalyzeError(
      "config",
      "calibrate",
      "calibration table needs equal vectors",
    );
  }
  const bins: CalibrationBin[] = [];
  for (let lo = 0; lo < 1; lo = Number((lo + binWidth).toFixed(10))) {
    const hi = Number((lo + binWidth).toFixed(10));
    const last = hi >= 1 - 1e-12;
    const pred: number[] = [];
    const obs: number[] = [];
    for (let i = 0; i < predicted.length; i += 1) {
      const p = predicted[i]!;
      if (p >= lo && (last ? p <= 1 : p < hi)) {
        pred.push(p);
        obs.push(observed[i]!);
      }
    }
    const count = pred.length;
    const predictedMean =
      count === 0 ? 0 : pred.reduce((s, v) => s + v, 0) / count;
    const observedRate =
      count === 0 ? 0 : obs.reduce((s, v) => s + v, 0) / count;
    bins.push({
      lo,
      hi: last ? 1 : hi,
      predictedMean: Number(predictedMean.toFixed(4)),
      observedRate: Number(observedRate.toFixed(4)),
      count,
      lowSample: count < binMin,
    });
  }
  return bins;
}

function asOfTimes(
  projection: PullProjection,
  horizonMs: number,
  nowMs: number,
): number[] {
  const times = [
    ...projection.ledger.map((row) => row.tranMs),
    ...projection.weblog.map((row) => row.accessMs),
    ...projection.wagers.map((row) => row.acceptedMs),
  ].filter(Number.isFinite);
  if (times.length === 0) return [];
  const start = Math.min(...times);
  const last = Math.max(...times, nowMs);
  const end = last - horizonMs;
  const days: number[] = [];
  const step = 86_400_000;
  for (let t = start; t <= end; t += step) days.push(t);
  if (days.length === 0 && start <= end) days.push(start);
  return days;
}

function snapshotAtOrBefore(
  account: AnalyzedAccount,
  asOfMs: number,
): string | null {
  const dated = account.snapshots
    .filter((id) => {
      const ms = Date.parse(id);
      return Number.isFinite(ms) ? ms <= asOfMs : id === "current";
    })
    .sort();
  return dated.length === 0 ? null : dated[dated.length - 1]!;
}

export function outcomeInHorizon(
  projection: PullProjection,
  accountId: string,
  asOfMs: number,
  horizonMs: number,
): { readonly observed: 0 | 1; readonly reasons: readonly string[] } {
  const end = asOfMs + horizonMs;
  const account = projection.accounts.find(
    (row) => row.accountId === accountId,
  );
  const reasons: string[] = [];
  if (account !== undefined) {
    const before = snapshotAtOrBefore(account, asOfMs);
    const afterIds = account.snapshots.filter((id) => {
      const ms = Date.parse(id);
      return Number.isFinite(ms) && ms > asOfMs && ms <= end;
    });
    if (before !== null) {
      const agentBefore = account.agentBySnapshot[before] ?? "";
      for (const snap of afterIds) {
        const agent = account.agentBySnapshot[snap] ?? "";
        if (agent !== "" && agentBefore !== "" && agent !== agentBefore) {
          reasons.push(`agent moved ${agentBefore} → ${agent}`);
        }
      }
    }
  }
  const ledger = projection.ledger.filter(
    (row) =>
      row.accountId === accountId &&
      Number.isFinite(row.tranMs) &&
      row.tranMs > asOfMs &&
      row.tranMs <= end,
  );
  if (ledger.some((row) => row.tranType === "I"))
    reasons.push("withdrawal in horizon");
  const activityAfter = [
    ...ledger.map((row) => row.tranMs),
    ...projection.weblog
      .filter((row) => row.loginId.toLowerCase() === accountId.toLowerCase())
      .map((row) => row.accessMs),
    ...projection.wagers
      .filter((row) => row.accountId === accountId)
      .map((row) => row.acceptedMs),
  ].filter((ms) => ms > asOfMs && ms <= end);
  const activityBefore = [
    ...projection.ledger
      .filter((row) => row.accountId === accountId)
      .map((row) => row.tranMs),
    ...projection.wagers
      .filter((row) => row.accountId === accountId)
      .map((row) => row.acceptedMs),
  ].filter((ms) => Number.isFinite(ms) && ms <= asOfMs);
  if (activityBefore.length >= 3 && activityAfter.length === 0) {
    reasons.push("activity stopped in horizon");
  }
  return { observed: reasons.length > 0 ? 1 : 0, reasons };
}

export function sliceProjection(
  projection: PullProjection,
  asOfMs: number,
): PullProjection {
  const snapshotOk = (id: string): boolean => {
    const ms = Date.parse(id);
    if (Number.isFinite(ms)) return ms <= asOfMs;
    return id === "current" ? false : true;
  };
  const accounts = projection.accounts.map((account) => {
    const agentBySnapshot = Object.fromEntries(
      Object.entries(account.agentBySnapshot).filter(([id]) => snapshotOk(id)),
    );
    const snapshots = account.snapshots.filter((id) => snapshotOk(id));
    const agents = Object.values(agentBySnapshot).filter((v) => v !== "");
    return {
      ...account,
      agentBySnapshot,
      snapshots,
      agentChanged: agents.length === 0 ? null : new Set(agents).size > 1,
    };
  });
  return {
    ...projection,
    accounts,
    ledger: projection.ledger.filter(
      (row) => row.tranMs <= asOfMs || !Number.isFinite(row.tranMs),
    ),
    weblog: projection.weblog.filter(
      (row) => row.accessMs <= asOfMs || !Number.isFinite(row.accessMs),
    ),
    wagers: projection.wagers.filter(
      (row) => row.acceptedMs <= asOfMs || !Number.isFinite(row.acceptedMs),
    ),
    snapshotIds: projection.snapshotIds.filter((id) => snapshotOk(id)),
    censusSnapshotCount: projection.snapshotIds.filter((id) => snapshotOk(id))
      .length,
  };
}

function predictedProbability(prediction: AccountPrediction): number {
  const hazard = prediction.expectedChange.hazard;
  return Number((0.6 * prediction.score + 0.4 * hazard).toFixed(4));
}

export function backtestPredict(
  projection: PullProjection,
  options: {
    readonly horizonDays?: number;
    readonly nowMs?: number;
    readonly minSample?: number;
  } = {},
): CalibrationReport {
  if (projection.accounts.length === 0) {
    throw new F402AnalyzeError("empty", "calibrate", "no accounts to backtest");
  }
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const horizonMs = horizonDays * 86_400_000;
  const nowMs = options.nowMs ?? Date.now();
  const minSample = options.minSample ?? CALIBRATION_MIN_SAMPLE;
  const asOfs = asOfTimes(projection, horizonMs, nowMs);
  const rows: BacktestRow[] = [];
  for (const asOfMs of asOfs) {
    const sliced = sliceProjection(projection, asOfMs);
    for (const account of sliced.accounts) {
      if (
        sliced.ledger.every((row) => row.accountId !== account.accountId) &&
        sliced.wagers.every((row) => row.accountId !== account.accountId) &&
        sliced.weblog.every(
          (row) =>
            row.loginId.toLowerCase() !== account.accountId.toLowerCase() &&
            row.loginId.toLowerCase() !== account.login.toLowerCase(),
        )
      ) {
        continue;
      }
      const prediction = predictAccount(sliced, account.accountId, asOfMs);
      const outcome = outcomeInHorizon(
        projection,
        account.accountId,
        asOfMs,
        horizonMs,
      );
      rows.push({
        accountId: account.accountId,
        asOfIso: new Date(asOfMs).toISOString(),
        horizonEndIso: new Date(asOfMs + horizonMs).toISOString(),
        predicted: predictedProbability(prediction),
        observed: outcome.observed,
        reasons: outcome.reasons,
      });
    }
  }
  const predicted = rows.map((row) => row.predicted);
  const observed = rows.map((row) => row.observed);
  const brier = predicted.length === 0 ? 0 : brierScore(predicted, observed);
  const bins =
    predicted.length === 0 ? [] : calibrationTable(predicted, observed);
  const observedRate =
    observed.length === 0
      ? 0
      : observed.reduce((s: number, v) => s + v, 0) / observed.length;
  const predictedMean =
    predicted.length === 0
      ? 0
      : predicted.reduce((s, v) => s + v, 0) / predicted.length;
  return {
    horizonDays,
    windowCount: rows.length,
    brier: Number(brier.toFixed(6)),
    lowSample: rows.length < minSample,
    lowSampleThreshold: minSample,
    observedRate: Number(observedRate.toFixed(4)),
    predictedMean: Number(predictedMean.toFixed(4)),
    bins,
    rows,
  };
}
