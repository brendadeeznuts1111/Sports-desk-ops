/**
 * @file game_admin_board.ts
 * @description The Game Admin **Admin** module: per-game lines and the money on each side.
 *
 * Source: operator paste of the portal's Game Admin report (module `Admin`), observed
 * 2026-11-01. This is the other half of F.A.Q. #4 — `Admin` shows the market with exposure,
 * `Position` (lib/game_admin.ts) shows the same action split by wager shape.
 *
 * Money honesty: the portal renders some amounts abbreviated (`120k`, `163k`) and others as
 * exact integers (`53,903`). `amountExact` is therefore `null` whenever the paste only proves
 * an approximation; treating `120k` as 120000 would invent four digits of precision. Aggregates
 * report how many sides carry a proven figure so a sum is never mistaken for a total.
 */

export type MarketKey = "spread" | "money" | "total" | "teamTotal";

export interface MarketSide {
  /** Team name, or `OVER` / `UNDER` for the total market. */
  readonly side: string;
  /** Line as printed, e.g. `+6½`, `PK`, `46`, `19½ -125o  -105u`. */
  readonly line: string;
  readonly price: number | null;
  /** Exactly as rendered: `"53,903"`, `"120k"`, `"146"`. */
  readonly amount: string;
  /** Integer only when the paste proves the exact figure. */
  readonly amountExact: number | null;
}

export interface TeamTotalSide {
  readonly team: string;
  readonly line: string;
  readonly overPrice: number | null;
  readonly underPrice: number | null;
  readonly overAmount: string;
  readonly underAmount: string;
  readonly overAmountExact: number | null;
  readonly underAmountExact: number | null;
}

export interface BoardGame {
  readonly gameNum: number;
  /** Calendar date the report grouped the game under, `YYYY-MM-DD`. */
  readonly date?: string;
  readonly league: string;
  readonly status: "live" | "scheduled" | "final" | string;
  /** Clock or start time as printed, e.g. `"2nd Q 09:02"`, `"08:20 PM"`. */
  readonly clock: string;
  readonly rot: readonly [number, number];
  readonly teams: readonly [string, string];
  readonly score: readonly [number, number];
  readonly openers: readonly [string, string];
  readonly spread: readonly [MarketSide, MarketSide];
  readonly money: readonly [MarketSide, MarketSide];
  readonly total: readonly [MarketSide, MarketSide];
  readonly teamTotal: readonly [TeamTotalSide, TeamTotalSide];
}

export interface BoardFile {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly observedAt: string | null;
  readonly notes?: readonly string[];
  readonly games: readonly BoardGame[];
}

export interface MarketAggregate {
  readonly market: MarketKey;
  /** Sides with a proven integer amount. */
  readonly proven: number;
  /** Sides rendered abbreviated (e.g. `120k`) and therefore excluded from `sumExact`. */
  readonly approximate: number;
  /** Sum of `amountExact` over proven sides only. */
  readonly sumExact: number;
}

export interface BoardSummary {
  readonly games: number;
  readonly live: number;
  readonly scheduled: number;
  readonly byMarket: readonly MarketAggregate[];
}

const MARKETS: readonly MarketKey[] = ["spread", "money", "total", "teamTotal"];

export function readBoardFile(payload: unknown): BoardFile | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Partial<BoardFile>;
  if (!Array.isArray(record.games) || record.games.length === 0) return null;

  const games: BoardGame[] = [];
  for (const entry of record.games) {
    if (typeof entry !== "object" || entry === null) return null;
    const game = entry as Partial<BoardGame>;
    if (typeof game.gameNum !== "number") return null;
    if (!Array.isArray(game.teams) || game.teams.length !== 2) return null;
    for (const market of MARKETS) {
      const sides = game[market];
      if (!Array.isArray(sides) || sides.length !== 2) return null;
    }
    games.push(game as BoardGame);
  }

  return {
    schemaVersion: 1,
    source: typeof record.source === "string" ? record.source : "",
    observedAt:
      typeof record.observedAt === "string" ? record.observedAt : null,
    ...(Array.isArray(record.notes) ? { notes: record.notes.map(String) } : {}),
    games,
  };
}

/** Sides of one game for one market, flattened for display. */
export function sidesOf(game: BoardGame, market: MarketKey): MarketSide[] {
  if (market === "teamTotal") {
    return game.teamTotal.flatMap((entry) => [
      {
        side: `${entry.team} OVER`,
        line: entry.line,
        price: entry.overPrice,
        amount: entry.overAmount,
        amountExact: entry.overAmountExact,
      },
      {
        side: `${entry.team} UNDER`,
        line: entry.line,
        price: entry.underPrice,
        amount: entry.underAmount,
        amountExact: entry.underAmountExact,
      },
    ]);
  }
  return [...game[market]];
}

/**
 * The portal's `data-field="time-game"` selector: `48` yesterday, `24` today,
 * `-1` the current board (anything not final). The day windows compare each game's own
 * `date` against the report's `observedAt`, so a one-day paste answers "Yesterday" with
 * no games rather than with today's.
 */
export type BoardWindow = "48" | "24" | "-1";

export const BOARD_WINDOWS = [
  { value: "48", label: "Yesterday" },
  { value: "24", label: "Today" },
  { value: "-1", label: "Current Board" },
] as const satisfies readonly { value: BoardWindow; label: string }[];

export function parseBoardWindow(raw: string | null): BoardWindow | null {
  if (raw === null) return "24";
  return BOARD_WINDOWS.some((entry) => entry.value === raw)
    ? (raw as BoardWindow)
    : null;
}

function shiftDay(isoDate: string, days: number): string | null {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function filterByWindow(
  file: BoardFile,
  window: BoardWindow,
): BoardGame[] {
  if (window === "-1") {
    return file.games.filter((game) => game.status !== "final");
  }
  const anchorDate =
    window === "24"
      ? file.observedAt
      : file.observedAt === null
        ? null
        : shiftDay(file.observedAt, -1);
  if (anchorDate === null) {
    // No reference date: return nothing rather than guessing which day is "yesterday".
    return window === "24" ? [...file.games] : [];
  }
  return file.games.filter((game) => (game.date ?? anchorDate) === anchorDate);
}

export function summarizeBoard(file: BoardFile): BoardSummary {
  let live = 0;
  let scheduled = 0;
  for (const game of file.games) {
    if (game.status === "live") live += 1;
    else if (game.status === "scheduled") scheduled += 1;
  }

  const byMarket = MARKETS.map((market) => {
    let proven = 0;
    let approximate = 0;
    let sumExact = 0;
    for (const game of file.games) {
      for (const side of sidesOf(game, market)) {
        if (side.amountExact === null) approximate += 1;
        else {
          proven += 1;
          sumExact += side.amountExact;
        }
      }
    }
    return { market, proven, approximate, sumExact };
  });

  return { games: file.games.length, live, scheduled, byMarket };
}

/** Largest exposure side across every market, for a "where the money is" line. */
export function biggestSide(
  file: BoardFile,
): { game: BoardGame; market: MarketKey; side: MarketSide } | null {
  let best: { game: BoardGame; market: MarketKey; side: MarketSide } | null =
    null;
  for (const game of file.games) {
    for (const market of MARKETS) {
      for (const side of sidesOf(game, market)) {
        if (side.amountExact === null) continue;
        if (best === null || side.amountExact > (best.side.amountExact ?? 0)) {
          best = { game, market, side };
        }
      }
    }
  }
  return best;
}
