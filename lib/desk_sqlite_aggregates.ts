/**
 * @file desk_sqlite_aggregates.ts
 * @description Desk bet aggregates registered on a `bun:sqlite` Database through the native
 *              `Database.aggregate` API:
 *              - `desk_decimal_odds(american)`: scalar American → decimal odds.
 *              - `desk_clv_bps(stake, taken_decimal, close_decimal)`: stake-weighted mean CLV in
 *                basis points; window-capable, so `ROWS BETWEEN n - 1 PRECEDING AND CURRENT ROW`
 *                gives a rolling CLV over the last n bets.
 *              - `desk_stake_sum(stake)`: summed stake; window-capable for time-window frames.
 *              - `desk_max_drawdown(order_key, pnl)`: largest fall of cumulative P&L from its
 *                running peak (starting equity 0), with rows sorted by `order_key` inside the
 *                aggregate so the result never depends on the order SQLite feeds rows.
 */

import type { Database } from "bun:sqlite";

export class DeskAggregateInputError extends Error {
  constructor(
    readonly fn: string,
    message: string,
  ) {
    super(`[${fn}] ${message}`);
    this.name = "DeskAggregateInputError";
  }
}

export class NonFiniteInputError extends DeskAggregateInputError {
  constructor(fn: string, field: string, value: unknown) {
    super(fn, `${field} must be a finite number, got ${String(value)}`);
    this.name = "NonFiniteInputError";
  }
}

export class NegativeStakeError extends DeskAggregateInputError {
  constructor(fn: string, value: number) {
    super(fn, `stake must be >= 0, got ${value}`);
    this.name = "NegativeStakeError";
  }
}

export class InvalidOddsError extends DeskAggregateInputError {
  constructor(fn: string, field: string, value: number) {
    super(fn, `${field} is not a valid price: ${value}`);
    this.name = "InvalidOddsError";
  }
}

export class MissingOrderKeyError extends DeskAggregateInputError {
  constructor(fn: string) {
    super(fn, "order_key must not be NULL");
    this.name = "MissingOrderKeyError";
  }
}

function finite(fn: string, field: string, value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new NonFiniteInputError(fn, field, value);
  }
  return n;
}

function stakeOf(fn: string, value: unknown): number {
  const stake = finite(fn, "stake", value);
  if (stake < 0) throw new NegativeStakeError(fn, stake);
  return stake;
}

function decimalOddsOf(fn: string, field: string, value: unknown): number {
  const odds = finite(fn, field, value);
  if (odds <= 1) throw new InvalidOddsError(fn, field, odds);
  return odds;
}

export function americanToDecimalOdds(american: unknown): number {
  const fn = "desk_decimal_odds";
  const odds = finite(fn, "american", american);
  if (Math.abs(odds) < 100) throw new InvalidOddsError(fn, "american", odds);
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds;
}

export function clvBps(takenDecimal: number, closeDecimal: number): number {
  return (takenDecimal / closeDecimal - 1) * 10_000;
}

interface ClvAccumulator {
  weighted: number;
  stake: number;
}

function clvTerm(
  stake: unknown,
  taken: unknown,
  close: unknown,
): [stake: number, weighted: number] {
  const fn = "desk_clv_bps";
  const s = stakeOf(fn, stake);
  const t = decimalOddsOf(fn, "taken_decimal", taken);
  const c = decimalOddsOf(fn, "close_decimal", close);
  return [s, s * clvBps(t, c)];
}

type DrawdownRow = readonly [key: string | number, pnl: number, seq: number];

function compareKeys(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function maxDrawdown(pnlInOrder: Iterable<number>): number {
  let equity = 0;
  let peak = 0;
  let worst = 0;
  for (const pnl of pnlInOrder) {
    equity += pnl;
    if (equity > peak) peak = equity;
    else if (peak - equity > worst) worst = peak - equity;
  }
  return worst;
}

export function registerDeskAggregates(db: Database): void {
  db.function(
    "desk_decimal_odds",
    { deterministic: true },
    (american: unknown) => americanToDecimalOdds(american),
  );

  db.aggregate<ClvAccumulator>("desk_clv_bps", {
    start: () => ({ weighted: 0, stake: 0 }),
    step: (acc, stake: unknown, taken: unknown, close: unknown) => {
      const [s, w] = clvTerm(stake, taken, close);
      acc.stake += s;
      acc.weighted += w;
    },
    inverse: (acc, stake: unknown, taken: unknown, close: unknown) => {
      const [s, w] = clvTerm(stake, taken, close);
      acc.stake -= s;
      acc.weighted -= w;
    },
    result: (acc) => (acc.stake > 0 ? acc.weighted / acc.stake : null),
  });

  db.aggregate<number>("desk_stake_sum", {
    start: 0,
    step: (total, stake: unknown) => total + stakeOf("desk_stake_sum", stake),
    inverse: (total, stake: unknown) =>
      total - stakeOf("desk_stake_sum", stake),
  });

  db.aggregate<DrawdownRow[]>("desk_max_drawdown", {
    start: () => [],
    step: (rows, orderKey: unknown, pnl: unknown) => {
      if (orderKey === null || orderKey === undefined) {
        throw new MissingOrderKeyError("desk_max_drawdown");
      }
      const key =
        typeof orderKey === "number" || typeof orderKey === "string"
          ? orderKey
          : String(orderKey);
      rows.push([key, finite("desk_max_drawdown", "pnl", pnl), rows.length]);
    },
    result: (rows) =>
      maxDrawdown(
        rows
          .toSorted((a, b) => compareKeys(a[0], b[0]) || a[2] - b[2])
          .map((row) => row[1]),
      ),
  });
}
