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
  /** First `Game` team without a trailing `(Live)`, e.g. "Vikings". Null for `G`
   * rows, whose `Game` is a game id plus the full line, not `team1 / team2`. */
  team1: string | null;
  /** Second `Game` team without a trailing `(Live)`, e.g. "Lions". Null for `G` rows. */
  team2: string | null;
  /** First token of `.line-selected`, e.g. "-2½". Null when the row carries no
   * line (`G` rows render an empty `.line-selected`). */
  line: string | null;
  /** Second token of `.line-selected`, e.g. "-130". Null when the row carries
   * no line. */
  price: string | null;
  /** `Risk/Win` risk side in integer cents, e.g. 2600000. */
  riskCents: number;
  /** `Risk/Win` win side in integer cents, e.g. 2000000. */
  winCents: number;
  /** `Status` before the parenthesized score, e.g. "Win". `G` rows print a bare
   * "Won"/"Lost" with no score; the raw text is carried through, never renamed. */
  status: string;
  /** Result text inside the `Status` parentheses, e.g. "Vikings (Live) 15 - Lions (Live) 19".
   * Null for `G` rows, whose status has no parenthesized score. */
  score: string | null;
  /** `Game` field, e.g. "Vikings (Live) / Lions (Live)". For `G` rows this is the
   * game id plus the full line (e.g. "G319977747 Basketball - …"). */
  game: string;
  /** League token of `Selection`, e.g. "NFL". Null for `G` rows, whose Selection
   * reads "- 0  Not available". */
  league: string | null;
  /** Whether `Selection` carries the optional `Live` token. */
  live: boolean;
  /** Game number token of `Selection`, e.g. "9240". For `G` rows the id comes
   * from the `.choosen` `G<digits>` prefix instead. Null when neither carries one. */
  gameNumber: string | null;
  /** Market text after the game number, e.g. "Game Spread". Null for `G` rows. */
  market: string | null;
  /** `Scheduled` field, e.g. "Nov 1, 2026 10:00 PM - (CST)". Null when the panel
   * prints the "--" placeholder (`G` rows). */
  scheduled: string | null;
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
    team1: z.string().min(1).nullable(),
    team2: z.string().min(1).nullable(),
    line: z.string().min(1).nullable(),
    price: z.string().min(1).nullable(),
    riskCents: z.number().int().nonnegative(),
    winCents: z.number().int().nonnegative(),
    status: z.string().min(1),
    score: z.string().min(1).nullable(),
    game: z.string().min(1),
    league: z.string().min(1).nullable(),
    live: z.boolean(),
    gameNumber: z.string().regex(/^\d+$/).nullable(),
    market: z.string().min(1).nullable(),
    scheduled: z.string().min(1).nullable(),
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

/** "Win  (Vikings (Live) 15 - Lions (Live) 19)" -> status and inner score.
 * A bare status with no parentheses (`G` rows print "Won"/"Lost") yields the
 * whole text as status and a null score. */
function parseStatus(value: string): { status: string; score: string | null } {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new GradedWagerRowError(["status"], "missing field");
  }
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open < 0 || close <= open) {
    return { status: trimmed, score: null };
  }
  const status = trimmed.slice(0, open).trim();
  const score = trimmed.slice(open + 1, close).trim();
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

/** "-2½  -130" -> line and price tokens; "O 48½  -105" -> line "O 48½".
 * An empty line-selected (`G` rows) yields nulls instead of throwing. */
function parseLineSelected(value: string): {
  line: string | null;
  price: string | null;
} {
  const tokens = value.split(" ").filter((token) => token !== "");
  if (tokens.length === 0) {
    return { line: null, price: null };
  }
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
  const game = requireField(fields, LABELS.game, "game");
  const scheduledRaw = requireField(fields, LABELS.scheduled, "scheduled");
  // The panel prints "--" for a missing schedule (`G` rows); a placeholder is
  // absent data, not a date.
  const scheduled = scheduledRaw === "--" ? null : scheduledRaw;

  // `G` rows are game-combo tickets, not `team1 / team2` selections: their
  // Selection reads "- 0  Not available", the line-selected is empty, and the
  // game id rides the `.choosen` `G<digits>` prefix instead. Those fields are
  // null rather than forced through parsers whose grammar they don't match.
  const isGameCombo = extracted.wagerType === "G";
  const { team1, team2 } = isGameCombo
    ? { team1: null, team2: null }
    : parseGameTeams(game);
  const selectionFields = isGameCombo
    ? {
        league: null,
        live: false,
        gameNumber:
          /^G(\d+)/.exec(normalizeText(extracted.selection))?.[1] ?? null,
        market: null,
      }
    : parseSelection(requireField(fields, LABELS.selection, "selection"));
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
    scheduled,
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
  const team1s: (string | null)[] = [];
  const team2s: (string | null)[] = [];
  const lines: (string | null)[] = [];
  const prices: (string | null)[] = [];
  const riskCentsList: number[] = [];
  const winCentsList: number[] = [];
  const statuses: string[] = [];
  const scores: (string | null)[] = [];
  const games: string[] = [];
  const leagues: (string | null)[] = [];
  let lives = 0n;
  const gameNumbers: (string | null)[] = [];
  const markets: (string | null)[] = [];
  const scheduleds: (string | null)[] = [];
  const accepteds: string[] = [];
  const placedOns: string[] = [];
  const gradedAmounts: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
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
    if (row.live) lives |= 1n << BigInt(i);
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
  /** First game team, e.g. ["Vikings", "Patriots"] (null for `G` rows) */
  team1s: (string | null)[];
  /** Second game team, e.g. ["Lions", "Bills"] (null for `G` rows) */
  team2s: (string | null)[];
  /** .line-selected text, e.g. ["-2½ -130", "-7 -110"] (null for `G` rows) */
  lines: (string | null)[];
  /** .line-selected price token, e.g. ["-130", "-110"] (null for `G` rows) */
  prices: (string | null)[];
  /** Risk/Win risk side in cents, e.g. [2600000, 1100000] */
  riskCents: (number | null)[];
  /** Risk/Win win side in cents, e.g. [2000000, 1000000] */
  winCents: number[];
  /** Status text, e.g. ["Win", "Loss"] (`G` rows print "Won"/"Lost") */
  statuses: string[];
  /** Result text in parens, e.g. ["Vikings (Live) 15 - Lions (Live) 19", "Patriots (Live) 20 - Bills (Live) 24"] (null for `G` rows) */
  scores: (string | null)[];
  /** Game field, e.g. ["Vikings (Live) / Lions (Live)", "Patriots (Live) / Bills (Live)"] */
  games: string[];
  /** League token, e.g. ["NFL", "NFL"] (null for `G` rows) */
  leagues: (string | null)[];
  /** Bitset of live rows: bit i is 1 when row i's Selection carried the (Live) token. */
  lives: bigint;
  /** Game number token, e.g. ["9240", "9241"] (for `G` rows, the `.choosen` `G<digits>` id) */
  gameNumbers: (string | null)[];
  /** Market text, e.g. ["Game Spread", "Game Moneyline"] */
  markets: (string | null)[];
  /** Scheduled field, e.g. ["Nov 1, 2026 10:00 PM - (CST)", "Nov 2, 1:00 PM - (CST)"] (null for "--" placeholders) */
  scheduleds: (string | null)[];
  /** Accepted field, e.g. ["Nov 1, 2:30 PM - (CST)", "Nov 2, 12:45 PM - (CST)"] */
  accepteds: string[];
  /** Placed On field, e.g. ["Internet", "Mobile"] */
  placedOns: string[];
  /** .wager-status-W|L|X text, e.g. ["+$20,000", "-$11,000"] */
  gradedAmounts: string[];
}

/** Count how many rows have live === true. */
export const countLive = (s: GradedWagerRowsSoA): number => {
  let n = 0;
  let b = s.lives;
  while (b) {
    n += Number(b & 1n);
    b >>= 1n;
  }
  return n;
};

/** True when row i carried the (Live) token. */
export const isLive = (s: GradedWagerRowsSoA, i: number): boolean =>
  ((s.lives >> BigInt(i)) & 1n) === 1n;

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
