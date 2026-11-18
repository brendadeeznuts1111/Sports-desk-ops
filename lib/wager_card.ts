/**
 * @file lib/wager_card.ts
 * @description Reconstruct a generated combination ticket (round robin / parlay card) from its
 * graded rows: the legs, their outcomes, every slot the product enumerated, and the slots that
 * were never booked.
 *
 * WHY THIS IS POSSIBLE: the book numbers the wagers of one generated ticket as combination ranks.
 * For one ticket, the wager number equals
 *
 *   offset(size) + lexicographicRank(combination of legs under the book's leg order) + 1
 *
 * where the sizes are laid out in ascending blocks (`C(n,3)` threes, then `C(n,5)` fives, ...).
 * The book's leg order is not printed, but it is a permutation of at most `MAX_CARD_LEGS` legs, so
 * it can be recovered by trying them all. A unique fit over every booked row is strong evidence
 * the model is right; no fit, or more than one, means the card is NOT reconstructed and the caller
 * must keep saying so.
 *
 * WHAT IT DOES NOT DO: it does not assume the omitted slots were staked. The counterfactual prices
 * them at the median booked stake for their size and states that assumption in `assumptions`.
 * Probabilities are the book's implied ones; true probabilities are lower, and the output says so.
 */

import type { GradedWagerRow } from "./customer_wager_artifacts.ts";

/** More legs than this and the permutation search stops being cheap; the card is left unsolved. */
export const MAX_CARD_LEGS = 8;
/** More rows than this and the ticket is not one generated card worth reconstructing. */
export const MAX_CARD_ROWS = 200;

const LEG_PATTERN =
  /(Soccer|Golf|Basketball|Football|Baseball|Hockey|Tennis|MMA|Boxing|Rugby|Cricket|Motorsport)\s+#(\d+)\s+(.+?)\s+([+-]\d+)\s+-\s+([A-Za-z0-9 ]+?)(?=\s+(?:Soccer|Golf|Basketball|Football|Baseball|Hockey|Tennis|MMA|Boxing|Rugby|Cricket|Motorsport)\s+#|$)/g;

export interface WagerLeg {
  readonly sport: string;
  readonly rotation: string;
  readonly selection: string;
  readonly priceAmerican: number;
  readonly period: string;
}

/** Parse the concatenated leg text of one wager row ("Soccer #123 Spain -180 - For 1st Half ..."). */
export function parseWagerLegs(description: string): readonly WagerLeg[] {
  const legs: WagerLeg[] = [];
  const pattern = new RegExp(LEG_PATTERN.source, "g");
  let match: RegExpExecArray | null = pattern.exec(description);
  while (match !== null) {
    const price = Number(match[4]);
    if (Number.isFinite(price) && price !== 0) {
      legs.push({
        sport: match[1] ?? "",
        rotation: match[2] ?? "",
        selection: (match[3] ?? "").trim(),
        priceAmerican: price,
        period: (match[5] ?? "").trim(),
      });
    }
    match = pattern.exec(description);
  }
  return legs;
}

/** Implied probability of American odds; null for a nonsensical price. */
export function impliedFromAmerican(american: number): number | null {
  if (american > 0) return 100 / (american + 100);
  if (american < 0) return -american / (-american + 100);
  return null;
}

/** Decimal odds of American odds. */
export function decimalFromAmerican(american: number): number | null {
  if (american > 0) return 1 + american / 100;
  if (american < 0) return 1 + 100 / -american;
  return null;
}

export interface CardLeg extends WagerLeg {
  readonly impliedProbability: number | null;
  /** "won", "lost", or null when the winning set could not be inferred. */
  readonly outcome: "won" | "lost" | null;
}

export interface CardLayer {
  readonly picks: number;
  readonly slots: number;
  readonly booked: number;
  readonly stakedUsd: number;
  readonly netUsd: number;
  readonly wins: number;
  readonly losses: number;
}

export interface CardCoverage {
  readonly allWinnerSlots: number;
  readonly allWinnerBooked: number;
  readonly hasLoserSlots: number;
  readonly hasLoserBooked: number;
  readonly allWinnerBookingRatePct: number | null;
  readonly hasLoserBookingRatePct: number | null;
}

export interface CardProbability {
  readonly distribution: readonly {
    readonly winners: number;
    readonly probabilityPct: number;
  }[];
  readonly allLegsPct: number | null;
  /** P(at least as many winners as actually resolved), at the book's implied prices. */
  readonly atLeastRealizedPct: number | null;
  readonly realizedWinners: number;
}

export interface ReconstructedCard {
  readonly ticket: string;
  readonly legs: readonly CardLeg[];
  readonly winners: readonly string[];
  readonly losers: readonly string[];
  readonly slots: number;
  readonly bookedSlots: number;
  readonly omittedSlots: number;
  readonly layers: readonly CardLayer[];
  readonly coverage: CardCoverage | null;
  readonly counterfactualNetUsd: number | null;
  readonly probability: CardProbability | null;
  readonly assumptions: readonly string[];
  readonly reason: string | null;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Binomial coefficient; small n only, which is all a card needs. */
function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Rank of a sorted position combination under lexicographic order of the `combinations(pool, size)`
 * enumeration, computed directly instead of enumerating the earlier combinations.
 */
function lexicographicIndex(
  combo: readonly number[],
  pool: number,
  size: number,
): number {
  let index = 0;
  let previous = -1;
  for (let i = 0; i < combo.length; i += 1) {
    const end = combo[i] ?? 0;
    if (end < 0 || end >= pool) return Number.NaN;
    for (let candidate = previous + 1; candidate < end; candidate += 1) {
      index += combinations(pool - candidate - 1, size - i - 1);
    }
    previous = end;
  }
  return index;
}

interface CardRow {
  readonly wagerNumber: number;
  readonly picks: number;
  readonly status: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly combo: readonly number[];
}

interface LegOrderFit {
  readonly order: readonly number[];
  /** Leg-index combination (`"1,3,5"`) -> slot number. */
  readonly slotByCombo: ReadonlyMap<string, number>;
}

/**
 * Reconstruct one ticket. `rows` must all belong to the same ticket; returns null when the ticket
 * is too small or too large to be a generated card.
 */
export function reconstructWagerCard(
  rows: readonly GradedWagerRow[],
): ReconstructedCard | null {
  if (rows.length < 2 || rows.length > MAX_CARD_ROWS) return null;

  const legsByRow: { row: GradedWagerRow; legs: readonly WagerLeg[] }[] = [];
  for (const row of rows) {
    legsByRow.push({ row, legs: parseWagerLegs(row.description) });
  }
  // Every row must parse the number of legs it claims, or the text is not a plain leg list.
  for (const entry of legsByRow) {
    if (entry.legs.length !== entry.row.picks) return null;
  }

  const universe: WagerLeg[] = [];
  const seen = new Set<string>();
  for (const entry of legsByRow) {
    for (const leg of entry.legs) {
      const key = `${leg.rotation}|${leg.selection}`;
      if (seen.has(key)) continue;
      seen.add(key);
      universe.push(leg);
    }
  }
  const n = universe.length;
  if (n < 2 || n > MAX_CARD_LEGS) return null;

  const index = new Map(
    universe.map((leg, position) => [
      `${leg.rotation}|${leg.selection}`,
      position,
    ]),
  );
  const sizes = [...new Set(legsByRow.map((entry) => entry.row.picks))].sort(
    (a, b) => a - b,
  );
  if (sizes.length === 0) return null;

  const offsets = new Map<number, number>();
  let offset = 0;
  for (const size of sizes) {
    offsets.set(size, offset);
    offset += combinations(n, size);
  }
  const totalSlots = offset;

  const ticket = rows[0]?.ticket ?? "";
  const parsedRows: CardRow[] = [];
  for (const entry of legsByRow) {
    const combo = entry.legs
      .map((leg) => index.get(`${leg.rotation}|${leg.selection}`))
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    if (combo.length !== entry.row.picks) return null;
    const wagerNumber = Number(entry.row.wagerNumber);
    if (!Number.isInteger(wagerNumber) || wagerNumber < 1) return null;
    parsedRows.push({
      wagerNumber,
      picks: entry.row.picks,
      status: entry.row.status,
      riskUsd: entry.row.riskUsd,
      toWinUsd: entry.row.toWinUsd,
      combo,
    });
  }

  const legViews = (outcomes: readonly ("won" | "lost" | null)[]): CardLeg[] =>
    universe.map((leg, legIndex) => ({
      ...leg,
      impliedProbability: impliedFromAmerican(leg.priceAmerican),
      outcome: outcomes[legIndex] ?? null,
    }));

  const unsolved = (reason: string): ReconstructedCard => ({
    ticket,
    legs: legViews(universe.map(() => null)),
    winners: [],
    losers: [],
    slots: totalSlots,
    bookedSlots: parsedRows.length,
    omittedSlots: totalSlots - parsedRows.length,
    layers: [],
    coverage: null,
    counterfactualNetUsd: null,
    probability: null,
    assumptions: [],
    reason,
  });

  const fit = findLegOrder(parsedRows, sizes, offsets, n);
  if (fit === null) {
    return unsolved(
      "No unique leg order reproduces the wager numbers as combination ranks, so the slot space " +
        "is not reconstructed. The rows are still a generated card, but its unbooked slots " +
        "cannot be named.",
    );
  }

  const bookedNumbers = new Set(parsedRows.map((row) => row.wagerNumber));
  const slotOf = (combo: readonly number[]): number =>
    fit.slotByCombo.get(combo.join(",")) ?? Number.NaN;

  // Inferred outcomes: a winning k-leg combination proves k legs won. The winning row with the
  // most legs therefore names the winning set; every other row must be consistent with it.
  const winningRows = parsedRows.filter((row) => row.status === "W");
  let winners: number[] = [];
  let outcomesKnown = false;
  if (winningRows.length > 0) {
    const largest = winningRows.reduce((best, row) =>
      row.picks > best.picks ? row : best,
    );
    winners = [...largest.combo];
    const winnerSet = new Set(winners);
    const consistent = parsedRows.every((row) => {
      const allWin = row.combo.every((leg) => winnerSet.has(leg));
      return row.status === "W" ? allWin : !allWin;
    });
    if (!consistent) {
      return unsolved(
        "The wager numbers reconstruct, but a winning row is not a subset of the largest winning " +
          "combination (or a losing row is a subset of it), so outcomes are not inferred.",
      );
    }
    outcomesKnown = true;
  }
  const winnerSet = new Set(winners);
  const legOutcome = universe.map((_, legIndex) =>
    outcomesKnown ? (winnerSet.has(legIndex) ? "won" : "lost") : null,
  );

  // Layers as booked: the ledger's own profit on a win, the stake on a loss.
  const bookedBySize = new Map<number, CardRow[]>();
  for (const row of parsedRows) {
    const bucket = bookedBySize.get(row.picks);
    if (bucket === undefined) bookedBySize.set(row.picks, [row]);
    else bucket.push(row);
  }
  const layers: CardLayer[] = [];
  for (const size of sizes) {
    const booked = bookedBySize.get(size) ?? [];
    let staked = 0;
    let net = 0;
    let wins = 0;
    let losses = 0;
    for (const row of booked) {
      staked += row.riskUsd;
      if (row.status === "W") {
        wins += 1;
        net += row.toWinUsd;
      } else {
        losses += 1;
        net -= row.riskUsd;
      }
    }
    layers.push({
      picks: size,
      slots: combinations(n, size),
      booked: booked.length,
      stakedUsd: round2(staked),
      netUsd: round2(net),
      wins,
      losses,
    });
  }

  // Coverage: booking rate split by whether the slot would have won, which is what decides whether
  // an omission is a filter or a partial record.
  let coverage: CardCoverage | null = null;
  if (outcomesKnown) {
    let allWinnerSlots = 0;
    let allWinnerBooked = 0;
    let hasLoserSlots = 0;
    let hasLoserBooked = 0;
    for (const size of sizes) {
      for (const slot of enumerateCombinations(n, size)) {
        const allWin = slot.every((leg) => winnerSet.has(leg));
        const booked = bookedNumbers.has(slotOf(slot));
        if (allWin) {
          allWinnerSlots += 1;
          if (booked) allWinnerBooked += 1;
        } else {
          hasLoserSlots += 1;
          if (booked) hasLoserBooked += 1;
        }
      }
    }
    coverage = {
      allWinnerSlots,
      allWinnerBooked,
      hasLoserSlots,
      hasLoserBooked,
      allWinnerBookingRatePct:
        allWinnerSlots > 0
          ? round2((allWinnerBooked / allWinnerSlots) * 100)
          : null,
      hasLoserBookingRatePct:
        hasLoserSlots > 0
          ? round2((hasLoserBooked / hasLoserSlots) * 100)
          : null,
    };
  }

  // Counterfactual: price the omitted slots at the median booked stake for their size.
  let counterfactualNetUsd: number | null = null;
  if (outcomesKnown) {
    let net = layers.reduce((total, layer) => total + layer.netUsd, 0);
    for (const size of sizes) {
      const stake = median(
        (bookedBySize.get(size) ?? []).map((row) => row.riskUsd),
      );
      for (const slot of enumerateCombinations(n, size)) {
        if (bookedNumbers.has(slotOf(slot))) continue;
        if (!slot.every((leg) => winnerSet.has(leg))) {
          net -= stake;
          continue;
        }
        const decimal = slot.reduce((product, legIndex) => {
          const price = universe[legIndex]?.priceAmerican ?? 0;
          return product * (decimalFromAmerican(price) ?? 1);
        }, 1);
        net += stake * (decimal - 1);
      }
    }
    counterfactualNetUsd = round2(net);
  }

  // Probability model at the book's implied prices.
  let probability: CardProbability | null = null;
  const probs = universe.map((leg) => impliedFromAmerican(leg.priceAmerican));
  if (probs.every((value): value is number => value !== null)) {
    const fractions: number[] = Array.from({ length: n + 1 }, () => 0);
    for (let mask = 0; mask < 1 << n; mask += 1) {
      let p = 1;
      let k = 0;
      for (let i = 0; i < n; i += 1) {
        const legProb = probs[i]!;
        if ((mask >> i) & 1) {
          p *= legProb;
          k += 1;
        } else {
          p *= 1 - legProb;
        }
      }
      fractions[k] = (fractions[k] ?? 0) + p;
    }
    const realizedWinners = outcomesKnown ? winners.length : 0;
    let atLeast = 0;
    for (let k = realizedWinners; k <= n; k += 1) atLeast += fractions[k] ?? 0;
    probability = {
      distribution: fractions.map((fraction, k) => ({
        winners: k,
        probabilityPct: round2(fraction * 100),
      })),
      allLegsPct: round2((fractions[n] ?? 0) * 100),
      atLeastRealizedPct: outcomesKnown ? round2(atLeast * 100) : null,
      realizedWinners,
    };
  }

  return {
    ticket,
    legs: legViews(legOutcome),
    winners: winners
      .map((legIndex) => universe[legIndex]?.selection ?? "")
      .filter(Boolean),
    losers: outcomesKnown
      ? universe
          .map((leg, legIndex) => ({ leg, legIndex }))
          .filter(({ legIndex }) => !winnerSet.has(legIndex))
          .map(({ leg }) => leg.selection)
      : [],
    slots: totalSlots,
    bookedSlots: parsedRows.length,
    omittedSlots: totalSlots - parsedRows.length,
    layers,
    coverage,
    counterfactualNetUsd,
    probability,
    assumptions: [
      "Slot numbers are reconstructed as lexicographic combination ranks over an inferred leg " +
        "order; the fit is unique across every booked row.",
      "Outcomes are inferred from the largest winning combination: a k-leg win proves k legs won, " +
        "and every other row must be consistent with that set.",
      "Omitted slots are priced at the median booked stake for their size; they were not " +
        "necessarily staked.",
      "Probabilities are the book's implied prices, so they include the margin; true probabilities " +
        "are lower.",
      "Leg outcomes are inferred from settlement, not observed individually.",
    ],
    reason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Corpus norms                                                               */
/* -------------------------------------------------------------------------- */

/** Groups processed per review; the cap keeps a large corpus from dominating a lookup. */
export const CARD_CORPUS_MAX_GROUPS = 250;

/** A size-matched booking band; the pooled list mixes card sizes and is not a comparator. */
export interface CardBookingBand {
  readonly minWagers: number;
  readonly n: number;
  readonly bookingRatesPct: readonly number[];
  readonly medianPct: number | null;
  readonly minPct: number | null;
  readonly maxPct: number | null;
}

/** The band a large card is actually comparable to. */
export const COMPARABLE_CARD_MIN_WAGERS = 10;

export interface CardCorpus {
  readonly candidateTickets: number;
  readonly solved: number;
  readonly refused: number;
  readonly unparseable: number;
  readonly truncated: boolean;
  readonly bookingRatesPct: readonly number[];
  readonly medianBookingPct: number | null;
  readonly minBookingPct: number | null;
  readonly maxBookingPct: number | null;
  /** Size-matched band (>= COMPARABLE_CARD_MIN_WAGERS rows); the pooled list is not a benchmark. */
  readonly comparable: CardBookingBand;
  /** Refused / unparseable tickets keyed by reason, so the denominator gap is visible. */
  readonly refusalReasons: Readonly<Record<string, number>>;
  readonly note: string;
}

function refusalKey(card: ReconstructedCard | null): string {
  if (card === null) return "unparseable_or_oversized";
  if (card.reason === null) return "solved";
  if (card.reason.startsWith("No unique leg order")) return "no_unique_order";
  if (card.reason.startsWith("The wager numbers reconstruct")) {
    return "inconsistent_outcomes";
  }
  return "other";
}

/**
 * Booking-rate norms over the card tickets in a graded corpus. Every statistic carries its `n`,
 * and refusals are counted by reason: the reconstructable subsample is biased toward cards whose
 * leg text parses cleanly, so a rate here is a norm over that subsample, not over all cards.
 */
const REASON_LABELS: Readonly<Record<string, string>> = {
  no_unique_order: "no unique numbering fit",
  inconsistent_outcomes: "inconsistent outcomes",
  unparseable_or_oversized: "unparseable or oversized",
  other: "other",
};

function bandOf(rates: readonly number[], minWagers: number): CardBookingBand {
  const sorted = [...rates].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 0
        ? ((sorted[sorted.length / 2 - 1] ?? 0) +
            (sorted[sorted.length / 2] ?? 0)) /
          2
        : (sorted[Math.floor(sorted.length / 2)] ?? 0);
  return {
    minWagers,
    n: sorted.length,
    bookingRatesPct: sorted,
    medianPct: median,
    minPct: sorted[0] ?? null,
    maxPct: sorted[sorted.length - 1] ?? null,
  };
}

/**
 * Booking-rate norms over the card tickets in a graded corpus. Every statistic carries its `n`,
 * refusals are counted by reason (not assumed random), and the size-matched band is reported next
 * to the pooled list because a 7-wager card and a 38-wager card are not comparable.
 */
export function summarizeCardCorpus(
  rows: readonly GradedWagerRow[],
): CardCorpus {
  const groups = new Map<string, GradedWagerRow[]>();
  for (const row of rows) {
    if (row.ticket === "") continue;
    const key = `${row.customerId}|${row.ticket}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  const candidates: GradedWagerRow[][] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    if (!list.some((row) => row.picks >= 2)) continue;
    candidates.push(list);
  }
  candidates.sort((a, b) => b.length - a.length);
  const truncated = candidates.length > CARD_CORPUS_MAX_GROUPS;
  const processed = truncated
    ? candidates.slice(0, CARD_CORPUS_MAX_GROUPS)
    : candidates;

  const rates: number[] = [];
  const comparableRates: number[] = [];
  const reasons: Record<string, number> = {};
  let solved = 0;
  let refused = 0;
  let unparseable = 0;
  for (const list of processed) {
    const card = reconstructWagerCard(list);
    const key = refusalKey(card);
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (card === null) {
      unparseable += 1;
      continue;
    }
    if (card.reason !== null) {
      refused += 1;
      continue;
    }
    solved += 1;
    const rate = Math.round((card.bookedSlots / card.slots) * 10000) / 100;
    rates.push(rate);
    if (list.length >= COMPARABLE_CARD_MIN_WAGERS) comparableRates.push(rate);
  }
  rates.sort((a, b) => a - b);
  const comparable = bandOf(comparableRates, COMPARABLE_CARD_MIN_WAGERS);
  const pooled = bandOf(rates, 0);

  const reasonText = Object.entries(reasons)
    .filter(([key]) => key !== "solved")
    .map(([key, count]) => `${count} ${REASON_LABELS[key] ?? key}`)
    .join(", ");
  const refusalClause =
    refused + unparseable === 0
      ? "every candidate reconstructed"
      : `${refused + unparseable} refused (${reasonText})`;

  return {
    candidateTickets: candidates.length,
    solved,
    refused,
    unparseable,
    truncated,
    bookingRatesPct: pooled.bookingRatesPct,
    medianBookingPct: pooled.medianPct,
    minBookingPct: pooled.minPct,
    maxBookingPct: pooled.maxPct,
    comparable,
    refusalReasons: reasons,
    note:
      "Candidate cards are tickets with >=2 wagers and at least one multi-leg wager in the " +
      `recent graded export; ${refusalClause}. Refusals are counted by reason rather than ` +
      "assumed random, and the rates describe the reconstructable subsample, not every card. The " +
      `pooled list mixes card sizes, so \`comparable\` is the >=${COMPARABLE_CARD_MIN_WAGERS}-wager ` +
      "band — the comparator for a large card. Every statistic carries its n.",
  };
}

function findLegOrder(
  rows: readonly CardRow[],
  sizes: readonly number[],
  offsets: ReadonlyMap<number, number>,
  n: number,
): LegOrderFit | null {
  const combosBySize = new Map<number, number[][]>();
  for (const size of sizes)
    combosBySize.set(size, [...enumerateCombinations(n, size)]);

  let fit: LegOrderFit | null = null;
  for (const order of permutations([...Array(n).keys()])) {
    const position = new Map(order.map((legIndex, pos) => [legIndex, pos]));
    let ok = true;
    for (const row of rows) {
      const offset = offsets.get(row.picks);
      if (offset === undefined) {
        ok = false;
        break;
      }
      const positions = row.combo
        .map((legIndex) => position.get(legIndex))
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => a - b);
      const rank = lexicographicIndex(positions, n, row.picks);
      if (!Number.isFinite(rank) || offset + rank + 1 !== row.wagerNumber) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (fit !== null) return null; // ambiguous: refuse rather than pick one
    const slotByCombo = new Map<string, number>();
    for (const size of sizes) {
      const offset = offsets.get(size) ?? 0;
      for (const combo of combosBySize.get(size) ?? []) {
        const positions = combo
          .map((legIndex) => position.get(legIndex))
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);
        slotByCombo.set(
          combo.join(","),
          offset + lexicographicIndex(positions, n, size) + 1,
        );
      }
    }
    fit = { order, slotByCombo };
  }
  return fit;
}

function* enumerateCombinations(n: number, size: number): Generator<number[]> {
  const combo: number[] = [];
  function* walk(start: number, remaining: number): Generator<number[]> {
    if (remaining === 0) {
      yield [...combo];
      return;
    }
    for (let value = start; value <= n - remaining; value += 1) {
      combo.push(value);
      yield* walk(value + 1, remaining - 1);
      combo.pop();
    }
  }
  yield* walk(0, size);
}

function* permutations(values: number[]): Generator<number[]> {
  if (values.length <= 1) {
    yield [...values];
    return;
  }
  for (let i = 0; i < values.length; i += 1) {
    const rest = [...values.slice(0, i), ...values.slice(i + 1)];
    for (const tail of permutations(rest)) {
      yield [values[i]!, ...tail];
    }
  }
}
