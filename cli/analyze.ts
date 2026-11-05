/**
 * @file analyze.ts
 * @description Capture data-quality checks that are independent of the parser.
 */

export interface WagerOrderingInput {
  readonly wagerNumber: string;
  /** Portal `InsertDateTime` (space or `T` separator); parsed with `Date.parse`. */
  readonly insertedAt: string;
}

export interface OrderingReport {
  readonly inOrder: boolean;
  readonly outOfOrder: ReadonlyArray<{
    readonly wager: string;
    readonly inserted: string;
    readonly prevWager: string;
    readonly prevInserted: string;
  }>;
}

/**
 * The client advances `lastWagerNumber` monotonically and polls `> lastWagerNumber`.
 * If a lower wager inserted later, a later poll can skip it. This flags the symptom:
 * `InsertDateTime` going backwards as `WagerNumber` increases.
 */
export function checkWagerOrdering(
  tickets: readonly WagerOrderingInput[],
): OrderingReport {
  const withTime = tickets
    .filter((ticket) => Number.isFinite(Date.parse(ticket.insertedAt)))
    .sort((a, b) => Number(a.wagerNumber) - Number(b.wagerNumber));
  const outOfOrder: Array<{
    wager: string;
    inserted: string;
    prevWager: string;
    prevInserted: string;
  }> = [];
  for (let index = 1; index < withTime.length; index++) {
    const previous = withTime[index - 1]!;
    const current = withTime[index]!;
    if (Date.parse(current.insertedAt) < Date.parse(previous.insertedAt)) {
      outOfOrder.push({
        wager: current.wagerNumber,
        inserted: current.insertedAt,
        prevWager: previous.wagerNumber,
        prevInserted: previous.insertedAt,
      });
    }
  }
  return { inOrder: outOfOrder.length === 0, outOfOrder };
}
