/**
 * @file lib/bet_context.ts
 * @description Batch context for rule evaluation: for every incoming bet, what the same customer,
 * the same agent and the same market were doing before it. Filled by {@link enrichIncomingBets}
 * into `IncomingBetRecord.context` (v2); the rules engine exposes every field under `context.*`.
 *
 * Two different baselines, deliberately kept apart:
 *  - `customerPrior*` / `stakeVsPriorMedian` are strictly EARLIER bets in the batch (sorted by
 *    `acceptedAt`, then `betKey`). They answer "is this stake large for this customer so far".
 *  - `*Window` / `marketCrowd*` count the whole batch inside `[now - windowSeconds, now]`
 *    (inclusive), current bet included. They answer "how busy is this customer/market right now".
 *
 * Honesty notes:
 *  - Prior is a within-batch notion. A batch that only carries the last few minutes has no long
 *    history, so `stakeVsPriorMedian` is naive until enough earlier rows arrive; it is `null` when
 *    there is no prior stake or the prior median is 0 (no division by zero, no invented ratio).
 *  - An empty identity never groups: an unknown `agentId` reads `agentBetsWindow: 0`, an empty
 *    `marketKey` reads `marketCrowd*: 0`, and an empty period reads `customerPeriodBetsWindow: 0`,
 *    rather than making every unknown row look like one crowd.
 *  - `ticketLegs` counts batch rows sharing `ticketNumber`; a ticker row has no `TicketNumber` (its
 *    `wagerNumber` is the ticket, one row per ticket), so it reads 1 rather than counting the batch.
 *
 * Pure and deterministic for a given `records`/`now`: no clock, network or file access; input
 * records are never mutated.
 */

import type { IncomingBetRecord } from "./bet_flags.ts";

export interface BetContext {
  customerPriorBets: number;
  customerPriorStakeUsd: number;
  customerPriorStakeMedianUsd: number | null;
  /** Current `stakeUsd` / prior median; `null` when there is no prior stake or the median is 0. */
  stakeVsPriorMedian: number | null;
  customerBetsWindow: number;
  customerStakeWindowUsd: number;
  customerPeriodBetsWindow: number;
  agentBetsWindow: number;
  marketKey: string;
  /** Distinct customers on the same `marketKey` inside the window. */
  marketCrowdCustomers: number;
  marketCrowdBets: number;
  /** Rows sharing `ticketNumber` in the batch; 1 for a ticker row (no ticket-number field). */
  ticketLegs: number;
  windowSeconds: number;
}

/** The context fields in contract order; the engine exposes each one as `context.<name>`. */
export const BET_CONTEXT_FIELDS: readonly string[] = [
  "customerPriorBets",
  "customerPriorStakeUsd",
  "customerPriorStakeMedianUsd",
  "stakeVsPriorMedian",
  "customerBetsWindow",
  "customerStakeWindowUsd",
  "customerPeriodBetsWindow",
  "agentBetsWindow",
  "marketKey",
  "marketCrowdCustomers",
  "marketCrowdBets",
  "ticketLegs",
  "windowSeconds",
];

const DEFAULT_WINDOW_SECONDS = 300;
const MAX_WINDOW_SECONDS = 86_400;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whole-dollar sums with sub-cent noise removed, so two runs always print the same number. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function stakeOf(record: IncomingBetRecord): number | null {
  return isFiniteNumber(record.stakeUsd) ? record.stakeUsd : null;
}

function acceptedMs(record: IncomingBetRecord): number | null {
  const parsed = Date.parse(record.acceptedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Ascending `acceptedAt`, ties by `betKey`; an unparseable time sorts after every real instant. */
function compareByTimeThenKey(
  left: IncomingBetRecord,
  right: IncomingBetRecord,
): number {
  const leftMs = acceptedMs(left);
  const rightMs = acceptedMs(right);
  if (leftMs !== null && rightMs !== null && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (leftMs !== null && rightMs === null) return -1;
  if (leftMs === null && rightMs !== null) return 1;
  return left.betKey < right.betKey ? -1 : left.betKey > right.betKey ? 1 : 0;
}

/** Median of a non-empty list; `null` for an empty one. Even counts average the middle pair. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle];
  if (high === undefined) return null;
  if (sorted.length % 2 === 1) return cents(high);
  const low = sorted[middle - 1];
  return low === undefined ? cents(high) : cents((low + high) / 2);
}

function periodKeyOf(record: IncomingBetRecord): string {
  return record.periodLabel.trim() !== ""
    ? record.periodLabel
    : record.period.trim();
}

function windowSecondsOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WINDOW_SECONDS;
  if (
    !isFiniteNumber(value) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_WINDOW_SECONDS
  ) {
    throw new TypeError(
      `enrichIncomingBets: windowSeconds must be an integer between 1 and ${MAX_WINDOW_SECONDS}`,
    );
  }
  return value;
}

/**
 * Attach a {@link BetContext} to every record and return the batch sorted by `acceptedAt` then
 * `betKey`. `now` (default: current time) anchors the window counts; tests pass it explicitly.
 * Input records are not mutated and every output record is a shallow copy.
 */
export function enrichIncomingBets(
  records: readonly IncomingBetRecord[],
  options: { windowSeconds?: number; now?: Date } = {},
): IncomingBetRecord[] {
  const windowSeconds = windowSecondsOf(options.windowSeconds);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const windowMs = windowSeconds * 1000;
  const fromMs = nowMs - windowMs;

  const ordered = records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const order = compareByTimeThenKey(left.record, right.record);
      return order !== 0 ? order : left.index - right.index;
    })
    .map((entry) => entry.record);

  const inWindow = ordered.filter((record) => {
    const ms = acceptedMs(record);
    return ms !== null && ms >= fromMs && ms <= nowMs;
  });

  const priorCounts = new Map<string, number>();
  const priorStakesByCustomer = new Map<string, number[]>();
  const enriched: IncomingBetRecord[] = [];
  for (const record of ordered) {
    const customerPriorBets = priorCounts.get(record.customerId) ?? 0;
    const priorStakes = priorStakesByCustomer.get(record.customerId) ?? [];
    const priorMedian = median(priorStakes);
    const currentStake = stakeOf(record);
    const periodKey = periodKeyOf(record);
    const windowRows =
      record.customerId === ""
        ? []
        : inWindow.filter((row) => row.customerId === record.customerId);
    const customerStakeWindowUsd = windowRows.reduce(
      (total, row) => total + (stakeOf(row) ?? 0),
      0,
    );
    const customerPeriodBetsWindow =
      periodKey === ""
        ? 0
        : windowRows.filter((row) => periodKeyOf(row) === periodKey).length;
    const agentRows =
      record.agentId === ""
        ? []
        : inWindow.filter((row) => row.agentId === record.agentId);
    const marketRows =
      record.marketKey === ""
        ? []
        : inWindow.filter((row) => row.marketKey === record.marketKey);
    const marketCrowdCustomers = new Set(
      marketRows.map((row) => row.customerId),
    ).size;
    const ticketLegs =
      record.ticketNumber === ""
        ? 1
        : ordered.filter((row) => row.ticketNumber === record.ticketNumber)
            .length;

    const context: BetContext = {
      customerPriorBets,
      customerPriorStakeUsd: cents(
        priorStakes.reduce((total, stake) => total + stake, 0),
      ),
      customerPriorStakeMedianUsd: priorMedian,
      stakeVsPriorMedian:
        priorMedian === null || priorMedian <= 0 || currentStake === null
          ? null
          : currentStake / priorMedian,
      customerBetsWindow: windowRows.length,
      customerStakeWindowUsd: cents(customerStakeWindowUsd),
      customerPeriodBetsWindow,
      agentBetsWindow: agentRows.length,
      marketKey: record.marketKey,
      marketCrowdCustomers,
      marketCrowdBets: marketRows.length,
      ticketLegs,
      windowSeconds,
    };
    enriched.push({ ...record, context });

    priorCounts.set(record.customerId, customerPriorBets + 1);
    if (currentStake !== null) {
      const stakes = priorStakesByCustomer.get(record.customerId);
      if (stakes === undefined) {
        priorStakesByCustomer.set(record.customerId, [currentStake]);
      } else {
        stakes.push(currentStake);
      }
    }
  }
  return enriched;
}
