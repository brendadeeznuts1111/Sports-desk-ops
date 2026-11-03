/**
 * @file lib/f402_graded_wager_row.ts
 * @description Typed DOM parser for Fantasy402 manager graded-wager rows.
 *
 * Built on Bun's native `HTMLRewriter` (see `lib/ticket_html.ts` for the
 * contract): text chunks arrive entity-encoded, so each buffer is joined first
 * and decoded with `decodeEntities` after. External shape is validated once at
 * the boundary with a strict `zod` schema; nothing downstream sees an unchecked
 * object.
 *
 * The parser accepts one or more rows: every `tr[data-ticket]` in the HTML is
 * parsed. A real graded-wagers page holds many rows; zero rows throws.
 *
 * `GradedWagerRowError` messages name only field paths (plus a static reason)
 * and never echo raw amounts, labels or values, so an error can be logged
 * safely.
 */

import { z } from "zod";
import { decodeEntities } from "./ticket_html.ts";

/** One graded wager row from the Fantasy402 manager wager list. */
export interface GradedWagerRow {
  /** `data-ticket` on the row, e.g. "1073373500". */
  ticketNumber: string;
  /** `Ticket#` field, e.g. "1073373500-1". */
  wagerNumber: string;
  /** `data-type` on the row, e.g. "S". */
  wagerType: string;
  /** `.choosen` text, e.g. "Lions (Live)". */
  selection: string;
  /** `.choosen` text without a trailing (Live), e.g. "Lions". */
  selectedTeam: string;
  /** First `Game` team without a trailing `(Live)`, e.g. "Vikings". */
  team1: string;
  /** Second `Game` team without a trailing `(Live)`, e.g. "Lions". */
  team2: string;
  /** First token of `.line-selected`, e.g. "-2½". */
  line: string;
  /** Second token of `.line-selected`, e.g. "-130". */
  price: string;
  /** `Risk/Win` risk side in integer cents, e.g. 2600000. */
  riskCents: number;
  /** `Risk/Win` win side in integer cents, e.g. 2000000. */
  winCents: number;
  /** `Status` before the parenthesized score, e.g. "Win". */
  status: string;
  /** Result text inside the `Status` parentheses, e.g. "Vikings (Live) 15 - Lions (Live) 19". */
  score: string;
  /** `Game` field, e.g. "Vikings (Live) / Lions (Live)". */
  game: string;
  /** League token of `Selection`, e.g. "NFL". */
  league: string;
  /** Whether `Selection` carries the optional `Live` token. */
  live: boolean;
  /** Game number token of `Selection`, e.g. "9240". */
  gameNumber: string;
  /** Market text after the game number, e.g. "Game Spread". */
  market: string;
  /** `Scheduled` field, e.g. "Nov 1, 2026 10:00 PM - (CST)". */
  scheduled: string;
  /** `Accepted` field, e.g. "Nov 1, 2:30 PM - (CST)". */
  accepted: string;
  /** `Placed On` field, e.g. "Internet". */
  placedOn: string;
  /** `.wager-status-W|L|X` text, e.g. "+$20,000". */
  gradedAmount: string;
}

/** Raised when the HTML holds no rows or a malformed row. */
export class GradedWagerRowError extends Error {
  /** Field paths implicated by the failure. Never contains raw values. */
  readonly paths: readonly string[];

  constructor(
    paths: readonly string[],
    reason?: string,
    options?: ErrorOptions,
  ) {
    const prefix =
      reason === undefined
        ? "invalid Fantasy402 graded wager row"
        : `invalid Fantasy402 graded wager row (${reason})`;
    super(`${prefix}: ${[...paths].join(", ")}`, options);
    this.name = "GradedWagerRowError";
    this.paths = [...paths];
  }
}

const gradedWagerRowSchema = z
  .object({
    ticketNumber: z.string().regex(/^\d+$/),
    wagerNumber: z.string().regex(/^\d+-\d+$/),
    wagerType: z.string().min(1),
    selection: z.string().min(1),
    selectedTeam: z.string().min(1),
    team1: z.string().min(1),
    team2: z.string().min(1),
    line: z.string().min(1),
    price: z.string().min(1),
    riskCents: z.number().int().nonnegative(),
    winCents: z.number().int().nonnegative(),
    status: z.string().min(1),
    score: z.string().min(1),
    game: z.string().min(1),
    league: z.string().min(1),
    live: z.boolean(),
    gameNumber: z.string().regex(/^\d+$/),
    market: z.string().min(1),
    scheduled: z.string().min(1),
    accepted: z.string().min(1),
    placedOn: z.string().min(1),
    gradedAmount: z.string().min(1),
  })
  .strict()
  .refine((row) => row.wagerNumber.startsWith(`${row.ticketNumber}-`), {
    path: ["wagerNumber"],
    message: "wagerNumber must start with ticketNumber",
  });

const LABELS = {
  ticket: "Ticket#",
  status: "Status",
  riskWin: "Risk/Win",
  game: "Game",
  selection: "Selection",
  scheduled: "Scheduled",
  accepted: "Accepted",
  placedOn: "Placed On",
} as const;

/** Collapse runs of whitespace (including decoded nbsp) to single spaces. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** "Vikings (Live)" -> "Vikings"; leaves a non-live name unchanged. */
function stripLiveSuffix(value: string): string {
  return value.replace(/\(live\)/i, "").trim();
}

/** "Vikings (Live) / Lions (Live)" -> { team1: "Vikings", team2: "Lions" }. */
function parseGameTeams(game: string): { team1: string; team2: string } {
  const parts = game.split("/").map(stripLiveSuffix);
  const team1 = parts[0];
  const team2 = parts[1];
  if (
    parts.length !== 2 ||
    team1 === undefined ||
    team2 === undefined ||
    team1 === "" ||
    team2 === ""
  ) {
    throw new GradedWagerRowError(["team1", "team2"], "expected two teams");
  }
  return { team1, team2 };
}

/** "$ 26,000.00" -> 2600000; rejects everything else. */
function moneyToCents(value: string, path: string): number {
  const cleaned = value.replace(/[\s,$]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
    throw new GradedWagerRowError([path], "not a money amount");
  }
  return Math.round(Number(cleaned) * 100);
}

/** "$ 26,000.00 / $ 20,000.00" -> risk and win cents. */
function parseRiskWin(value: string): { riskCents: number; winCents: number } {
  const parts = value.split("/").map((part) => part.trim());
  const risk = parts[0];
  const win = parts[1];
  if (parts.length !== 2 || risk === undefined || win === undefined) {
    throw new GradedWagerRowError(
      ["riskCents", "winCents"],
      "expected risk / win",
    );
  }
  return {
    riskCents: moneyToCents(risk, "riskCents"),
    winCents: moneyToCents(win, "winCents"),
  };
}

/** "Win  (Vikings (Live) 15 - Lions (Live) 19)" -> status and inner score. */
function parseStatus(value: string): { status: string; score: string } {
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  if (open < 0 || close <= open) {
    throw new GradedWagerRowError(
      ["status", "score"],
      "expected status (score)",
    );
  }
  const status = value.slice(0, open).trim();
  const score = value.slice(open + 1, close).trim();
  if (status === "" || score === "") {
    throw new GradedWagerRowError(
      ["status", "score"],
      "expected status (score)",
    );
  }
  return { status, score };
}

/** "NFL Live - 9240 Game Spread" -> league, live, game number and market. */
function parseSelection(value: string): {
  league: string;
  live: boolean;
  gameNumber: string;
  market: string;
} {
  const match = /^(.+?)\s+-\s+(.+)$/.exec(value);
  const head = match?.[1];
  const tail = match?.[2];
  if (head === undefined || tail === undefined) {
    throw new GradedWagerRowError(
      ["league", "live", "gameNumber", "market"],
      "expected selection",
    );
  }

  const headTokens = head.split(" ");
  const league = headTokens[0];
  if (league === undefined || league === "") {
    throw new GradedWagerRowError(["league"], "missing league");
  }
  const live = headTokens[1]?.toLowerCase() === "live";

  const tailTokens = tail.split(" ");
  const gameNumber = tailTokens[0];
  const market = tailTokens.slice(1).join(" ");
  if (gameNumber === undefined || market === "") {
    throw new GradedWagerRowError(
      ["gameNumber", "market"],
      "expected game number and market",
    );
  }

  return { league, live, gameNumber, market };
}

/** "-2½  -130" -> line and price tokens; "O 48½  -105" -> line "O 48½". */
function parseLineSelected(value: string): { line: string; price: string } {
  const tokens = value.split(" ").filter((token) => token !== "");
  if (tokens.length < 2) {
    throw new GradedWagerRowError(["line", "price"], "expected line and price");
  }
  const price = tokens[tokens.length - 1]!;
  const line = tokens.slice(0, -1).join(" ");
  return { line, price };
}

/** HTML-level capture for one row, before field parsing. */
interface ExtractedRow {
  readonly ticketNumber: string;
  readonly wagerType: string;
  readonly selection: string;
  readonly lineSelected: string;
  readonly gradedAmount: string;
  readonly fields: ReadonlyMap<string, string>;
}

/** Extract every tr[data-ticket] row from the HTML. */
function extractRows(html: string): ExtractedRow[] {
  const rows: { ticket: string; type: string }[] = [];
  const texts: Array<{
    selection: string;
    lineSelected: string;
    gradedAmount: string;
  }> = [];
  const fieldsList: Map<string, string>[] = [];
  let currentRow: number | null = null;
  let labelText = "";
  let valueText = "";

  const rewriter = new HTMLRewriter()
    .on("tr[data-ticket]", {
      element(element) {
        rows.push({
          ticket: (element.getAttribute("data-ticket") ?? "").trim(),
          type: (element.getAttribute("data-type") ?? "").trim(),
        });
        texts.push({ selection: "", lineSelected: "", gradedAmount: "" });
        fieldsList.push(new Map());
        currentRow = rows.length - 1;
        labelText = "";
        valueText = "";
      },
    })
    .on("tr[data-ticket] .choosen", {
      text(chunk) {
        const idx = currentRow;
        if (idx === null || chunk.removed) return;
        texts[idx]!.selection += chunk.text;
      },
    })
    .on("tr[data-ticket] .line-selected", {
      text(chunk) {
        const idx = currentRow;
        if (idx === null || chunk.removed) return;
        texts[idx]!.lineSelected += chunk.text;
      },
    })
    .on(
      "tr[data-ticket] .wager-status-W, tr[data-ticket] .wager-status-L, tr[data-ticket] .wager-status-X",
      {
        text(chunk) {
          const idx = currentRow;
          if (idx === null || chunk.removed) return;
          texts[idx]!.gradedAmount += chunk.text;
        },
      },
    )
    .on("tr[data-ticket] .content-descripcion .ln", {
      element(element) {
        labelText = "";
        valueText = "";
        if (element.canHaveContent !== false) {
          element.onEndTag(() => {
            const idx = currentRow;
            if (idx === null) return;
            const label = normalizeText(decodeEntities(labelText));
            if (label !== "")
              fieldsList[idx]!.set(
                label,
                normalizeText(decodeEntities(valueText)),
              );
          });
        }
      },
    })
    .on("tr[data-ticket] .content-descripcion .d-l", {
      text(chunk) {
        if (!chunk.removed) labelText += chunk.text;
      },
    })
    .on("tr[data-ticket] .content-descripcion .d-r", {
      text(chunk) {
        if (!chunk.removed) valueText += chunk.text;
      },
    });

  rewriter.transform(html);

  if (rows.length === 0) {
    throw new GradedWagerRowError(
      ["ticketNumber"],
      "expected at least one row",
    );
  }

  return rows.map((row, index) => ({
    ticketNumber: row.ticket,
    wagerType: row.type,
    selection: normalizeText(decodeEntities(texts[index]!.selection)),
    lineSelected: normalizeText(decodeEntities(texts[index]!.lineSelected)),
    gradedAmount: normalizeText(decodeEntities(texts[index]!.gradedAmount)),
    fields: fieldsList[index]!,
  }));
}

function requireField(
  fields: ReadonlyMap<string, string>,
  label: string,
  path: string,
): string {
  const value = fields.get(label);
  if (value === undefined || value === "") {
    throw new GradedWagerRowError([path], "missing field");
  }
  return value;
}

/** Parse one extracted row into a validated `GradedWagerRow`. */
function parseRowFromExtracted(extracted: ExtractedRow): GradedWagerRow {
  const fields = extracted.fields;

  const { riskCents, winCents } = parseRiskWin(
    requireField(fields, LABELS.riskWin, "riskCents"),
  );
  const { status, score } = parseStatus(
    requireField(fields, LABELS.status, "status"),
  );
  const { line, price } = parseLineSelected(extracted.lineSelected);
  const selectionFields = parseSelection(
    requireField(fields, LABELS.selection, "selection"),
  );
  const game = requireField(fields, LABELS.game, "game");
  const { team1, team2 } = parseGameTeams(game);
  const selectedTeam = stripLiveSuffix(extracted.selection);
  if (selectedTeam === "") {
    throw new GradedWagerRowError(["selectedTeam"], "missing selection");
  }

  const candidate = {
    ticketNumber: extracted.ticketNumber,
    wagerNumber: requireField(fields, LABELS.ticket, "wagerNumber"),
    wagerType: extracted.wagerType,
    selection: extracted.selection,
    selectedTeam,
    team1,
    team2,
    line,
    price,
    riskCents,
    winCents,
    status,
    score,
    game,
    league: selectionFields.league,
    live: selectionFields.live,
    gameNumber: selectionFields.gameNumber,
    market: selectionFields.market,
    scheduled: requireField(fields, LABELS.scheduled, "scheduled"),
    accepted: requireField(fields, LABELS.accepted, "accepted"),
    placedOn: requireField(fields, LABELS.placedOn, "placedOn"),
    gradedAmount: extracted.gradedAmount,
  };

  const result = gradedWagerRowSchema.safeParse(candidate);
  if (!result.success) {
    const paths = [
      ...new Set(
        result.error.issues.map((issue) => issue.path.join(".") || "row"),
      ),
    ];
    throw new GradedWagerRowError(paths, "schema", { cause: result.error });
  }
  return result.data satisfies GradedWagerRow;
}

/**
 * Parse every graded-wager row in the HTML.
 *
 * @param html Markup holding one or more tr[data-ticket] rows (a full table
 *   is fine).
 * @returns One GradedWagerRow per tr[data-ticket], in document order.
 * @throws {GradedWagerRowError} When there are no rows, or any row is missing
 *   a field or fails the strict schema.
 */
export function parseGradedWagerRows(html: string): GradedWagerRow[] {
  return extractRows(html).map(parseRowFromExtracted);
}

/**
 * Parse exactly one Fantasy402 manager graded-wager row.
 *
 * @param html Markup holding a single tr[data-ticket] (a full table is fine).
 * @returns The validated row.
 * @throws {GradedWagerRowError} When the row count is not one, a field is
 *   missing, or the extracted shape fails the strict schema.
 */
export function parseGradedWagerRow(html: string): GradedWagerRow {
  const rows = extractRows(html);
  if (rows.length !== 1) {
    throw new GradedWagerRowError(["ticketNumber"], "expected exactly one row");
  }
  return parseRowFromExtracted(rows[0]!);
}

/**
 * Parse every graded-wager row in the HTML, returning a Structure of Arrays.
 *
 * Unlike parseGradedWagerRows which returns an array of row objects (AoS),
 * this returns parallel arrays (SoA) so callers can process one field across
 * all rows without unpacking each row individually.
 *
 * @param html Markup holding one or more tr[data-ticket] rows (a full table
 *   is fine).
 * @returns A GradedWagerRowsSoA with one array per field, all aligned by index.
 * @throws {GradedWagerRowError} When there are no rows, or any row is missing
 *   a field or fails the strict schema.
 */
export function parseGradedWagerRowsSoA(html: string): GradedWagerRowsSoA {
  const extracted = extractRows(html);

  if (extracted.length === 0) {
    throw new GradedWagerRowError(
      ["ticketNumber"],
      "expected at least one row",
    );
  }

  // Parse all rows into AoS first (reuses existing, tested logic)
  const rows = extracted.map(parseRowFromExtracted);

  const ticketNumbers: string[] = [];
  const wagerNumbers: string[] = [];
  const wagerTypes: string[] = [];
  const selections: string[] = [];
  const selectedTeams: string[] = [];
  const team1s: string[] = [];
  const team2s: string[] = [];
  const lines: string[] = [];
  const prices: string[] = [];
  const riskCentsList: number[] = [];
  const winCentsList: number[] = [];
  const statuses: string[] = [];
  const scores: string[] = [];
  const games: string[] = [];
  const leagues: string[] = [];
  const lives: boolean[] = [];
  const gameNumbers: string[] = [];
  const markets: string[] = [];
  const scheduleds: string[] = [];
  const accepteds: string[] = [];
  const placedOns: string[] = [];
  const gradedAmounts: string[] = [];

  for (const row of rows) {
    ticketNumbers.push(row.ticketNumber);
    wagerNumbers.push(row.wagerNumber);
    wagerTypes.push(row.wagerType);
    selections.push(row.selection);
    selectedTeams.push(row.selectedTeam);
    team1s.push(row.team1);
    team2s.push(row.team2);
    lines.push(row.line);
    prices.push(row.price);
    riskCentsList.push(row.riskCents);
    winCentsList.push(row.winCents);
    statuses.push(row.status);
    scores.push(row.score);
    games.push(row.game);
    leagues.push(row.league);
    lives.push(row.live);
    gameNumbers.push(row.gameNumber);
    markets.push(row.market);
    scheduleds.push(row.scheduled);
    accepteds.push(row.accepted);
    placedOns.push(row.placedOn);
    gradedAmounts.push(row.gradedAmount);
  }

  return {
    ticketNumbers,
    wagerNumbers,
    wagerTypes,
    selections,
    selectedTeams,
    team1s,
    team2s,
    lines,
    prices,
    riskCents: riskCentsList,
    winCents: winCentsList,
    statuses,
    scores,
    games,
    leagues,
    lives,
    gameNumbers,
    markets,
    scheduleds,
    accepteds,
    placedOns,
    gradedAmounts,
  } satisfies GradedWagerRowsSoA;
}

/**
 * Structure of Arrays for graded wager rows.
 * Each field is a separate array, aligned by index:
 *   row i across all arrays corresponds to the same wager.
 * @totalKeys Total number of indexed fields — 22. Used by lockstep tests.
 */
export interface GradedWagerRowsSoA {
  /** data-ticket values, e.g. ["1073373500", "1073373501"] */
  ticketNumbers: string[];
  /** wagerNumber values, e.g. ["1073373500-1", "1073373501-1"] */
  wagerNumbers: string[];
  /** data-type values, e.g. ["S", "M"] */
  wagerTypes: string[];
  /** .choosen text, e.g. ["Lions (Live)", "Patriots (Live)"] */
  selections: string[];
  /** .choosen without (Live) suffix, e.g. ["Lions", "Patriots"] */
  selectedTeams: string[];
  /** First game team, e.g. ["Vikings", "Patriots"] */
  team1s: string[];
  /** Second game team, e.g. ["Lions", "Bills"] */
  team2s: string[];
  /** .line-selected text, e.g. ["-2½ -130", "-7 -110"] */
  lines: string[];
  /** .line-selected price token, e.g. ["-130", "-110"] */
  prices: string[];
  /** Risk/Win risk side in cents, e.g. [2600000, 1100000] */
  riskCents: (number | null)[];
  /** Risk/Win win side in cents, e.g. [2000000, 1000000] */
  winCents: number[];
  /** Status text, e.g. ["Win", "Loss"] */
  statuses: string[];
  /** Result text in parens, e.g. ["Vikings (Live) 15 - Lions (Live) 19", "Patriots (Live) 20 - Bills (Live) 24"] */
  scores: string[];
  /** Game field, e.g. ["Vikings (Live) / Lions (Live)", "Patriots (Live) / Bills (Live)"] */
  games: string[];
  /** League token, e.g. ["NFL", "NFL"] */
  leagues: string[];
  /** Whether Selection carries the optional Live token, e.g. [true, true] */
  lives: boolean[];
  /** Game number token, e.g. ["9240", "9241"] */
  gameNumbers: string[];
  /** Market text, e.g. ["Game Spread", "Game Moneyline"] */
  markets: (string | null)[];
  /** Scheduled field, e.g. ["Nov 1, 2026 10:00 PM - (CST)", "Nov 2, 1:00 PM - (CST)"] */
  scheduleds: string[];
  /** Accepted field, e.g. ["Nov 1, 2:30 PM - (CST)", "Nov 2, 12:45 PM - (CST)"] */
  accepteds: string[];
  /** Placed On field, e.g. ["Internet", "Mobile"] */
  placedOns: string[];
  /** .wager-status-W|L|X text, e.g. ["+$20,000", "-$11,000"] */
  gradedAmounts: string[];
}

/** Count how many rows have live === true. */
export const countLive = (s: GradedWagerRowsSoA): number =>
  s.lives.filter((l): l is boolean => l).length;

/** Average riskCents across all rows. Returns null when no rows. */
export const averageRisk = (s: GradedWagerRowsSoA): number | null => {
  const xs = s.riskCents.filter((c): c is number => c !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

/** Filter markets by substring match (case-insensitive).
 *  Returns a new array with only markets containing the needle.
 *  Null markets are skipped (do not match). */
export const marketsMatching = (
  s: GradedWagerRowsSoA,
  needle: string,
): string[] =>
  s.markets.filter(
    (m): m is string =>
      m !== null && m.toLowerCase().includes(needle.toLowerCase()),
  );
