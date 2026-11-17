/**
 * @file bet_ticker_view.ts
 * @description Pure view helpers for the Bet-Ticker panel: deterministic row
 * sorting and a TSV export of the filtered stream.
 *
 * The panel renders at most `BET_TICKER_RENDER_LIMIT` rows; the export always
 * covers the whole filtered set so "copy rows" cannot silently equal the page.
 */

import type { BetTickerTicketRow } from "./types.ts";

/** Default number of rows the panel renders before asking to show the rest. */
export const BET_TICKER_RENDER_LIMIT = 120;

export type BetTickerSortField = "ticket" | "time" | "wagered" | "toWin";
export type BetTickerSortDirection = "asc" | "desc";

export interface BetTickerSortSpec {
  readonly field: BetTickerSortField;
  readonly direction: BetTickerSortDirection;
}

function ticketNumber(row: BetTickerTicketRow): number {
  if (Number.isFinite(row.wagerNumber) && row.wagerNumber > 0) {
    return row.wagerNumber;
  }
  const parsed = Number(row.ticketId);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareByField(
  a: BetTickerTicketRow,
  b: BetTickerTicketRow,
  field: BetTickerSortField,
): number {
  switch (field) {
    case "ticket":
      return ticketNumber(a) - ticketNumber(b);
    case "time": {
      const left = a.insertedAt ?? "";
      const right = b.insertedAt ?? "";
      return left.localeCompare(right);
    }
    case "wagered":
      return a.amountWageredCents - b.amountWageredCents;
    case "toWin":
      return a.toWinAmountCents - b.toWinAmountCents;
  }
}

/**
 * Sorted copy of the filtered stream. Rows compare on the selected field with a
 * stable `wagerNumber` tie-break, so equal amounts keep a deterministic order.
 */
export function sortBetTickerRows(
  rows: readonly BetTickerTicketRow[],
  sort: BetTickerSortSpec | null,
): readonly BetTickerTicketRow[] {
  if (sort === null) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    // Undated tickets stay at the bottom whichever way the column runs.
    if (sort.field === "time") {
      const aNull = a.insertedAt === null || a.insertedAt === "";
      const bNull = b.insertedAt === null || b.insertedAt === "";
      if (aNull !== bNull) return aNull ? 1 : -1;
    }
    const primary = compareByField(a, b, sort.field);
    if (primary !== 0) return primary * direction;
    return (ticketNumber(a) - ticketNumber(b)) * direction;
  });
}

/** Toggle helper: same field flips direction, a new field starts descending. */
export function nextBetTickerSort(
  current: BetTickerSortSpec | null,
  field: BetTickerSortField,
): BetTickerSortSpec {
  if (current !== null && current.field === field) {
    return {
      field,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return { field, direction: "desc" };
}

function cell(text: string): string {
  return text.replace(/[\t\r\n]+/g, " ").trim();
}

function usd(cents: number): string {
  return (cents / 100).toFixed(2);
}

export const BET_TICKER_TSV_HEADER = [
  "ticket_id",
  "customer_id",
  "agent_id",
  "master_agent",
  "channel",
  "wager_type",
  "sport",
  "selection",
  "amount_wagered_usd",
  "volume_usd",
  "to_win_usd",
  "legs",
  "live",
  "flags",
  "inserted_at",
] as const;

/** Tab-separated export of every row handed in (filtered stream, not the page). */
export function betTickerRowsToTsv(
  rows: readonly BetTickerTicketRow[],
): string {
  const lines = [BET_TICKER_TSV_HEADER.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        cell(row.ticketId),
        cell(row.customerId),
        cell(row.agentId),
        cell(row.masterAgent),
        cell(row.ticketWriter),
        cell(row.wagerType),
        cell(row.sport),
        cell(row.selection),
        usd(row.amountWageredCents),
        usd(row.volumeAmountCents),
        usd(row.toWinAmountCents),
        String(row.legCount),
        row.live ? "live" : "pregame",
        cell(row.alertFlags.join(",")),
        cell(row.insertedAt ?? ""),
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}
