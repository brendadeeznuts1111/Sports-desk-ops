/**
 * Transparent per-account change scores. Heuristics plus a simple
 * exponential waiting-time window — no black-box model.
 */

import {
  F402AnalyzeError,
  type PullProjection,
} from "./f402_analyze_ingest.ts";

export type PredictSignalName =
  | "balance_trend"
  | "activity_cadence"
  | "activity_gaps"
  | "deposit_withdrawal_rhythm"
  | "credit_limit_drawdown"
  | "agent_moves";

export const PREDICT_SIGNAL_WEIGHTS: Readonly<
  Record<PredictSignalName, number>
> = {
  balance_trend: 0.15,
  activity_cadence: 0.15,
  activity_gaps: 0.25,
  deposit_withdrawal_rhythm: 0.2,
  credit_limit_drawdown: 0.15,
  agent_moves: 0.1,
};

export const SIGNALS_NEEDING_MULTIPLE_CENSUS_SNAPSHOTS: readonly PredictSignalName[] =
  ["agent_moves"];

export const SUGGESTED_SNAPSHOT_CADENCE = {
  census:
    "weekly (twice weekly if a dispute or suspected move is already in view)",
  transactions: "weekly, or after each figure week",
  weblog: "daily (getWebLog's unit of work is one agent-day)",
  notes: [
    "agent_moves is unavailable until at least two census snapshots are ingested (place dated copies under <in>/snapshots/<YYYY-MM-DD>/).",
    "credit_limit_drawdown needs CreditLimit from getCustomerAdmin or getInfoPlayer (or a census row that carries it).",
    "Deleted-history Amount units are unverified; those rows contribute activity times but are weak for balance trend.",
  ],
} as const;

export interface SignalResult {
  readonly name: PredictSignalName;
  readonly available: boolean;
  readonly value: number | null;
  readonly weight: number;
  readonly contribution: number;
  readonly reason: string;
}

export interface ExpectedChangeWindow {
  readonly model: "exponential-waiting-time";
  readonly tauDays: number;
  readonly lastEventIso: string | null;
  readonly expectedIso: string | null;
  readonly windowStartIso: string | null;
  readonly windowEndIso: string | null;
  readonly overdue: boolean;
  readonly hazard: number;
  readonly survival: number;
  readonly explanation: string;
}

export interface AccountPrediction {
  readonly accountId: string;
  readonly login: string;
  readonly score: number;
  readonly label: "evidence-scored guess";
  readonly signals: readonly SignalResult[];
  readonly expectedChange: ExpectedChangeWindow;
}

export interface PredictReport {
  readonly generatedAtIso: string;
  readonly censusSnapshotCount: number;
  readonly signalsNeedingMultipleCensusSnapshots: readonly PredictSignalName[];
  readonly snapshotCadence: typeof SUGGESTED_SNAPSHOT_CADENCE;
  readonly accounts: readonly AccountPrediction[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function gaps(sortedMs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < sortedMs.length; i += 1) {
    const dt = sortedMs[i]! - sortedMs[i - 1]!;
    if (dt > 0) out.push(dt);
  }
  return out;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

function slopePerDay(
  points: readonly { ms: number; y: number }[],
): number | null {
  if (points.length < 2) return null;
  const t0 = points[0]!.ms;
  const xs = points.map((p) => (p.ms - t0) / 86_400_000);
  const ys = points.map((p) => p.y);
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    num += dx * (ys[i]! - meanY);
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

function waitingWindow(
  lastMs: number | null,
  tauDays: number,
  nowMs: number,
): ExpectedChangeWindow {
  const tau = Math.max(tauDays, 0.5);
  const lastEventIso = lastMs === null ? null : new Date(lastMs).toISOString();
  if (lastMs === null || !Number.isFinite(lastMs)) {
    return {
      model: "exponential-waiting-time",
      tauDays: tau,
      lastEventIso: null,
      expectedIso: null,
      windowStartIso: null,
      windowEndIso: null,
      overdue: false,
      hazard: 0,
      survival: 1,
      explanation:
        "No dated activity; no waiting-time window can be estimated yet.",
    };
  }
  const elapsedDays = Math.max(0, (nowMs - lastMs) / 86_400_000);
  const survival = Math.exp(-elapsedDays / tau);
  const hazard = 1 - survival;
  const expectedMs = lastMs + tau * 86_400_000;
  const overdue = nowMs > expectedMs;
  const startMs = overdue ? nowMs : lastMs + 0.5 * tau * 86_400_000;
  const endMs = overdue
    ? nowMs + 0.5 * tau * 86_400_000
    : lastMs + 2 * tau * 86_400_000;
  return {
    model: "exponential-waiting-time",
    tauDays: Number(tau.toFixed(2)),
    lastEventIso,
    expectedIso: new Date(expectedMs).toISOString(),
    windowStartIso: new Date(startMs).toISOString(),
    windowEndIso: new Date(endMs).toISOString(),
    overdue,
    hazard: Number(clamp01(hazard).toFixed(4)),
    survival: Number(clamp01(survival).toFixed(4)),
    explanation: overdue
      ? `Elapsed ${elapsedDays.toFixed(1)}d exceeds typical gap τ=${tau.toFixed(1)}d (exponential survival ${survival.toFixed(2)}); change is overdue.`
      : `Next change is expected around last event + τ=${tau.toFixed(1)}d, in the window [0.5τ, 2τ].`,
  };
}

function signalWeight(
  name: PredictSignalName,
  weights: Readonly<Partial<Record<PredictSignalName, number>>> | undefined,
): number {
  return weights?.[name] ?? PREDICT_SIGNAL_WEIGHTS[name];
}

function unavailable(
  name: PredictSignalName,
  reason: string,
  weights?: Readonly<Partial<Record<PredictSignalName, number>>>,
): SignalResult {
  return {
    name,
    available: false,
    value: null,
    weight: signalWeight(name, weights),
    contribution: 0,
    reason,
  };
}

function availableSignal(
  name: PredictSignalName,
  value: number,
  reason: string,
  weights?: Readonly<Partial<Record<PredictSignalName, number>>>,
): SignalResult {
  const clamped = clamp01(value);
  const weight = signalWeight(name, weights);
  return {
    name,
    available: true,
    value: Number(clamped.toFixed(4)),
    weight,
    contribution: 0,
    reason,
  };
}

export function predictAccount(
  projection: PullProjection,
  accountId: string,
  nowMs: number,
  options: {
    readonly weights?: Readonly<Partial<Record<PredictSignalName, number>>>;
  } = {},
): AccountPrediction {
  const weights = options.weights;
  const account = projection.accounts.find(
    (row) => row.accountId === accountId,
  );
  if (account === undefined) {
    throw new F402AnalyzeError(
      "config",
      "predict",
      `unknown account ${accountId}`,
    );
  }
  const logins = new Set(
    [account.accountId, account.login]
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== ""),
  );
  const ledger = projection.ledger
    .filter((row) => logins.has(row.accountId.toLowerCase()))
    .slice()
    .sort((a, b) => a.tranMs - b.tranMs);
  const weblog = projection.weblog.filter((row) =>
    logins.has(row.loginId.toLowerCase()),
  );
  const activityMs = uniqueSorted([
    ...ledger.map((row) => row.tranMs),
    ...weblog.map((row) => row.accessMs),
  ]);
  const lastMs =
    activityMs.length === 0 ? null : activityMs[activityMs.length - 1]!;
  const activityGaps = gaps(activityMs);
  const typicalGapDays = (median(activityGaps) ?? 7 * 86_400_000) / 86_400_000;

  const liveBalances = ledger
    .filter((row) => !row.deleted && row.balanceCents !== null)
    .map((row) => ({ ms: row.tranMs, y: row.balanceCents! }))
    .filter((row) => Number.isFinite(row.ms));
  const slope = slopePerDay(liveBalances);
  const balanceSignal =
    slope === null
      ? unavailable(
          "balance_trend",
          "Need at least two getTransactionList rows with a running Balance.",
          weights,
        )
      : availableSignal(
          "balance_trend",
          clamp01(
            -slope / Math.max(Math.abs(liveBalances[0]?.y ?? 0) * 0.05, 1000),
          ),
          `Balance slope ${slope.toFixed(0)} cents/day (negative is drawdown).`,
          weights,
        );

  let cadenceSignal: SignalResult;
  if (activityGaps.length < 2) {
    cadenceSignal = unavailable(
      "activity_cadence",
      "Need at least three dated events to compare recent vs typical pace.",
      weights,
    );
  } else {
    const recent = median(
      activityGaps.slice(-Math.max(2, Math.floor(activityGaps.length / 3))),
    )!;
    const typical = median(activityGaps)!;
    const ratio = typical <= 0 ? 1 : recent / typical;
    cadenceSignal = availableSignal(
      "activity_cadence",
      clamp01((ratio - 1) / 2),
      `Recent median gap ${(recent / 86_400_000).toFixed(1)}d vs typical ${(typical / 86_400_000).toFixed(1)}d.`,
      weights,
    );
  }

  let gapSignal: SignalResult;
  if (lastMs === null) {
    gapSignal = unavailable("activity_gaps", "No dated activity.", weights);
  } else {
    const elapsedDays = Math.max(0, (nowMs - lastMs) / 86_400_000);
    gapSignal = availableSignal(
      "activity_gaps",
      1 - Math.exp(-elapsedDays / (2 * Math.max(typicalGapDays, 0.5))),
      `Last event ${elapsedDays.toFixed(1)}d ago; typical gap ${typicalGapDays.toFixed(1)}d.`,
      weights,
    );
  }

  const cash = ledger
    .filter((row) => row.tranType === "E" || row.tranType === "I")
    .sort((a, b) => a.tranMs - b.tranMs);
  const cashGaps = gaps(cash.map((row) => row.tranMs));
  let cashSignal: SignalResult;
  if (cash.length === 0) {
    cashSignal = unavailable(
      "deposit_withdrawal_rhythm",
      "No deposit (E) or withdrawal (I) rows.",
      weights,
    );
  } else {
    const lastCash = cash[cash.length - 1]!;
    const tau = (median(cashGaps) ?? 7 * 86_400_000) / 86_400_000;
    const elapsed = Math.max(0, (nowMs - lastCash.tranMs) / 86_400_000);
    cashSignal = availableSignal(
      "deposit_withdrawal_rhythm",
      1 - Math.exp(-elapsed / (2 * Math.max(tau, 0.5))),
      `Last ${lastCash.kindLabel.toLowerCase()} ${elapsed.toFixed(1)}d ago; typical cash interval ${tau.toFixed(1)}d.`,
      weights,
    );
  }

  let drawdownSignal: SignalResult;
  const latestBalance =
    liveBalances.length === 0 ? null : liveBalances[liveBalances.length - 1]!.y;
  if (account.creditLimitCents === null || account.creditLimitCents <= 0) {
    drawdownSignal = unavailable(
      "credit_limit_drawdown",
      "CreditLimit was not present on the ingested census or getCustomerAdmin snapshot.",
      weights,
    );
  } else if (latestBalance === null) {
    drawdownSignal = unavailable(
      "credit_limit_drawdown",
      "CreditLimit is known but no running Balance is available.",
      weights,
    );
  } else {
    const used = account.creditLimitCents - latestBalance;
    const ratio = used / account.creditLimitCents;
    drawdownSignal = availableSignal(
      "credit_limit_drawdown",
      clamp01(ratio),
      `Balance ${latestBalance} cents against CreditLimit ${account.creditLimitCents} cents.`,
      weights,
    );
  }

  let moveSignal: SignalResult;
  if (projection.censusSnapshotCount < 2 || account.agentChanged === null) {
    moveSignal = unavailable(
      "agent_moves",
      "Needs at least two census snapshots to compare AgentID / Agent.",
      weights,
    );
  } else if (account.agentChanged) {
    const agents = Object.entries(account.agentBySnapshot)
      .map(([snap, agent]) => `${snap}:${agent}`)
      .join(" → ");
    moveSignal = availableSignal(
      "agent_moves",
      1,
      `Agent changed (${agents}).`,
      weights,
    );
  } else {
    moveSignal = availableSignal(
      "agent_moves",
      0,
      "Agent was stable across the ingested census snapshots.",
      weights,
    );
  }

  const raw = [
    balanceSignal,
    cadenceSignal,
    gapSignal,
    cashSignal,
    drawdownSignal,
    moveSignal,
  ];
  const activeWeight = raw
    .filter((s) => s.available)
    .reduce((sum, s) => sum + s.weight, 0);
  const signals = raw.map((s) => ({
    ...s,
    contribution:
      s.available && activeWeight > 0
        ? Number((((s.value ?? 0) * s.weight) / activeWeight).toFixed(4))
        : 0,
  }));
  const score =
    activeWeight === 0
      ? 0
      : Number(signals.reduce((sum, s) => sum + s.contribution, 0).toFixed(4));

  const cashTau =
    cashGaps.length > 0 ? (median(cashGaps) ?? 0) / 86_400_000 : null;
  const tauDays =
    median(
      [typicalGapDays, cashTau].filter((v): v is number => v !== null && v > 0),
    ) ?? 7;

  return {
    accountId: account.accountId,
    login: account.login,
    score,
    label: "evidence-scored guess",
    signals,
    expectedChange: waitingWindow(lastMs, tauDays, nowMs),
  };
}

export function predictAccounts(
  projection: PullProjection,
  options: {
    readonly nowMs?: number;
    readonly weights?: Readonly<Partial<Record<PredictSignalName, number>>>;
  } = {},
): PredictReport {
  if (projection.accounts.length === 0) {
    throw new F402AnalyzeError("empty", "predict", "no accounts to score");
  }
  const nowMs = options.nowMs ?? Date.now();
  const accounts = projection.accounts
    .map((row) =>
      predictAccount(
        projection,
        row.accountId,
        nowMs,
        options.weights === undefined ? {} : { weights: options.weights },
      ),
    )
    .sort(
      (a, b) => b.score - a.score || a.accountId.localeCompare(b.accountId),
    );
  return {
    generatedAtIso: new Date(nowMs).toISOString(),
    censusSnapshotCount: projection.censusSnapshotCount,
    signalsNeedingMultipleCensusSnapshots:
      SIGNALS_NEEDING_MULTIPLE_CENSUS_SNAPSHOTS,
    snapshotCadence: SUGGESTED_SNAPSHOT_CADENCE,
    accounts,
  };
}
