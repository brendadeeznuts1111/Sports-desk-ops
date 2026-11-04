/**
 * @file f402_bet_ticker_drain.ts
 * @description Fail-closed drain for Bridge 3a. A `getBetTicker` response that carries at least
 * `pageLimit` (100) rows is treated as possibly truncated: the poller asks again with the highest
 * processed `wagerNumber` before any delta is published or the watermark advances.
 *
 * Completion rules, in order:
 *  - a response with fewer than 100 rows settles the drain;
 *  - a page that adds no new ticket (a full-snapshot endpoint, or paging the endpoint ignores)
 *    settles it too, so a 700-row ticker does not loop forever — that is a bounded completion, not
 *    a partial publish;
 *  - `maxPages` exhausted while every page is still full and progressing is `unsettled`, and
 *    nothing may be published.
 *
 * Failure rules:
 *  - a probe error is returned as `error`; the caller keeps the previous watermark and snapshot;
 *  - a page whose highest wager number is below the watermark is `regressed` (the page fell
 *    behind the processed point); nothing is published and the caller raises an alert.
 */

import type { F402Probe, F402TickerRow } from "./f402_ingest.ts";
import {
  demuxChannel,
  highestWagerNumber,
  ticketKey,
} from "./f402_bet_ticker_delta.ts";

export const F402_TICKER_PAGE_LIMIT = 100;
export const F402_TICKER_MAX_DRAIN_PAGES = 10;

export interface F402TickerDrainOptions {
  /** Issues one `getBetTicker` request; the argument is the `wagerNumber` cursor. */
  readonly probe: (wagerNumber: string) => Promise<F402Probe>;
  /** Highest wager number already fully processed; pages below it are a regression. */
  readonly watermark?: number;
  readonly pageLimit?: number;
  readonly maxPages?: number;
}

export type F402TickerDrainResult =
  | {
      readonly status: "ok";
      readonly rows: readonly F402TickerRow[];
      readonly watermark: number;
      readonly pages: number;
    }
  | {
      readonly status: "empty";
      readonly watermark: number;
      readonly pages: number;
    }
  | {
      readonly status: "regressed";
      readonly watermark: number;
      readonly pageMax: number;
      readonly pages: number;
    }
  | { readonly status: "error"; readonly error: string; readonly pages: number }
  | { readonly status: "unsettled"; readonly pages: number };

/** Stable identity for exact-duplicate removal across drain pages; keeps ALERT twins distinct. */
function rowKey(row: F402TickerRow): string {
  return `${ticketKey(row)}|${demuxChannel(row.ticketWriter)}`;
}

/**
 * Drain the ticker until a page settles. Pure with respect to the injected probe: no network,
 * clock, or filesystem access of its own, so tests drive it deterministically.
 */
export async function drainF402BetTicker(
  options: F402TickerDrainOptions,
): Promise<F402TickerDrainResult> {
  const pageLimit = options.pageLimit ?? F402_TICKER_PAGE_LIMIT;
  const maxPages = options.maxPages ?? F402_TICKER_MAX_DRAIN_PAGES;
  const watermark = options.watermark ?? 0;
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new Error(
      "drainF402BetTicker: watermark must be a non-negative integer",
    );
  }
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new Error("drainF402BetTicker: pageLimit must be a positive integer");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("drainF402BetTicker: maxPages must be a positive integer");
  }

  const rows = new Map<string, F402TickerRow>();
  let cursor = "0";
  let pages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    pages = page;
    const probe = await options.probe(cursor);
    if (probe.error !== null) {
      return { status: "error", error: probe.error, pages };
    }

    const pageMax = highestWagerNumber(probe.ticks);
    if (watermark > 0 && probe.rows > 0 && pageMax < watermark) {
      return { status: "regressed", watermark, pageMax, pages };
    }

    let added = 0;
    for (const row of probe.ticks) {
      const key = rowKey(row);
      if (!rows.has(key)) {
        rows.set(key, row);
        added += 1;
      }
    }

    if (probe.rows < pageLimit) {
      return settle(rows, pageMax, pages, watermark);
    }
    if (added === 0) {
      // The endpoint repeated everything (full-snapshot semantics or ignored cursor). The set is
      // complete, so settle instead of spinning; still fail closed on regression and errors above.
      return settle(rows, pageMax, pages, watermark);
    }
    if (pageMax <= Number(cursor)) {
      // The cursor cannot advance even though rows were added: no progress is possible.
      return settle(rows, pageMax, pages, watermark);
    }
    cursor = String(pageMax);
  }

  return { status: "unsettled", pages };
}

function settle(
  rows: ReadonlyMap<string, F402TickerRow>,
  pageMax: number,
  pages: number,
  watermark: number,
): F402TickerDrainResult {
  if (rows.size === 0) {
    return { status: "empty", watermark: Math.max(watermark, pageMax), pages };
  }
  const drained = [...rows.values()];
  const highest = Math.max(pageMax, highestWagerNumber(drained));
  return {
    status: "ok",
    rows: drained,
    watermark: Math.max(watermark, highest),
    pages,
  };
}
