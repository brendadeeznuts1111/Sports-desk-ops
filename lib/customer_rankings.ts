/**
 * Customer-book rankings DERIVED from `enriched_customers_full.json` at call time.
 *
 * WHY THIS EXISTS
 *
 * The CLI's `winners`, `losers` and `leaderboard` tables used to be literal arrays of demo
 * rows, so their numbers were fabricated and could never change. This module computes them
 * from the checked-in book instead: every customer count, volume, net and win rate below is a
 * function of the file. Nothing about how many customers or bets exist is written down here.
 *
 * HONESTY LIMITS, stated rather than hidden
 *
 * - The book carries `lifetime_*` rollups plus a SAMPLE of recent tickets per customer. The
 *   only windows it can answer are `7d` (`sports_7d_*`) and `lifetime`; `24h`/`48h`/`month`
 *   are refused instead of being silently mapped to a different window.
 * - `winPct` is computed over the sampled WIN/LOSS tickets only and is `null` when the sample
 *   has no decisive ticket; the CLI labels it as a sample.
 * - The "league"/"market" shown for a customer is the most frequent one in that sample.
 *
 * @module lib/customer_rankings
 */

import { resolve } from "node:path";
import { z } from "zod";

const TicketSchema = z.object({
  league: z.string().optional(),
  market: z.string().optional(),
  result: z.string().optional(),
});

const CustomerSchema = z.object({
  customer_id: z.string(),
  agent_id: z.string(),
  context_type: z.string().optional(),
  churn_mode: z.string().optional(),
  lifetime_volume_usd: z.number(),
  lifetime_net_usd: z.number(),
  sports_7d_volume_usd: z.number().optional(),
  sports_7d_net_usd: z.number().optional(),
  recent_tickets: z.array(TicketSchema).optional(),
});

/** The book is validated once at the boundary; callers get typed rows or a loud error. */
export const CustomerBookSchema = z.array(CustomerSchema);

export type RankingWindow = "7d" | "lifetime";
export type RankingSort = "net" | "gross_hold" | "volume";
export type RankingDirection = "winners" | "losers";

export interface CustomerRankingRow {
  readonly rank: number;
  readonly customerId: string;
  readonly agentId: string;
  readonly league: string;
  readonly market: string;
  /** Sample size: `recent_tickets.length`, not a lifetime ticket count. */
  readonly tickets: number;
  readonly volumeUSD: number;
  readonly netUSD: number;
  /** Percent over sampled WIN/LOSS tickets; `null` when the sample has none. */
  readonly winPct: number | null;
  readonly grossHold: number;
  /** Derived context (context type, sample size, churn mode) — never an invented playbook. */
  readonly details: string;
}

const SUPPORTED_PERIODS = "7d, lifetime";

/**
 * Map a CLI period to the only window the book actually stores.
 *
 * @param {string} period
 * @returns {RankingWindow}
 * @throws RangeError when the period cannot be derived from the book
 */
export function periodWindow(period: string): RankingWindow {
  const normalized = period.trim().toLowerCase();
  if (normalized === "7d") return "7d";
  if (normalized === "lifetime" || normalized === "all") return "lifetime";
  throw new RangeError(
    `[PERIOD_UNAVAILABLE] ${JSON.stringify(period)} cannot be derived: ` +
      `the customer book stores a 7d window and lifetime rollups only. ` +
      `Supported: ${SUPPORTED_PERIODS}.`,
  );
}

/**
 * Load and validate the customer book.
 *
 * @returns {Promise<z.infer<typeof CustomerBookSchema>>}
 * @throws Error when the file is missing or fails validation (missing is not "no customers")
 */
export async function loadCustomerBook(): Promise<
  z.infer<typeof CustomerBookSchema>
> {
  const path = resolve(import.meta.dir, "..", "enriched_customers_full.json");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `[CUSTOMER_BOOK_MISSING] ${path} does not exist. ` +
        "The book must be built before rankings can be derived; this is not an empty book.",
    );
  }
  const parsed = CustomerBookSchema.safeParse(await file.json());
  if (!parsed.success) {
    throw new Error(
      `[CUSTOMER_BOOK_INVALID] ${path} failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * The most frequent non-empty value in the sample, or "N/A" when there is none.
 *
 * @param {(string | undefined)[]} values
 * @returns {string}
 */
function dominantValue(values: (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === undefined || value === "") continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = "N/A";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Rank customers by the derived window.
 *
 * @param {{ direction: RankingDirection, period: string, sortBy: RankingSort, limit: number }} options
 * @returns {Promise<CustomerRankingRow[]>}
 */
export async function buildCustomerRanking(options: {
  direction: RankingDirection;
  period: string;
  sortBy: RankingSort;
  limit: number;
}): Promise<CustomerRankingRow[]> {
  const window = periodWindow(options.period);
  const book = await loadCustomerBook();
  const limit =
    Number.isInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, 500)
      : 10;
  const rows = book.map((entry) => {
    const tickets = entry.recent_tickets ?? [];
    const decisive = tickets.filter(
      (ticket) => ticket.result === "WIN" || ticket.result === "LOSS",
    );
    const wins = decisive.filter((ticket) => ticket.result === "WIN").length;
    const netUSD =
      window === "7d" ? (entry.sports_7d_net_usd ?? 0) : entry.lifetime_net_usd;
    const volumeUSD =
      window === "7d"
        ? (entry.sports_7d_volume_usd ?? 0)
        : entry.lifetime_volume_usd;
    return {
      rank: 0,
      customerId: entry.customer_id,
      agentId: entry.agent_id,
      league: dominantValue(tickets.map((ticket) => ticket.league)),
      market: dominantValue(tickets.map((ticket) => ticket.market)),
      tickets: tickets.length,
      volumeUSD,
      netUSD,
      winPct: decisive.length === 0 ? null : (wins / decisive.length) * 100,
      grossHold: Math.abs(netUSD),
      details:
        `${entry.context_type ?? "UNKNOWN"} • ${tickets.length} sampled ` +
        `ticket(s) • ${entry.churn_mode ?? "UNKNOWN"}`,
    };
  });
  const filtered = rows.filter((row) =>
    options.direction === "winners" ? row.netUSD > 0 : row.netUSD < 0,
  );
  const score = (row: CustomerRankingRow): number => {
    if (options.sortBy === "volume") return row.volumeUSD;
    if (options.sortBy === "gross_hold") return row.grossHold;
    return options.direction === "losers" ? -row.netUSD : row.netUSD;
  };
  return filtered
    .sort((left, right) => score(right) - score(left))
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
