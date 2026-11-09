/**
 * @file live_wagers.ts
 * @description The live wager list (`{LIST: [...]}`) — the bet-ticker shape, which is a
 * different feed from `Report/Pending`.
 *
 * Field notes that matter, all evidenced by the paste this was built from:
 *  - `WagerNumber` is the ticket id here; `Report/Pending` calls the same concept `TicketNumber`.
 *  - `ShortDesc` carries one line per leg. A straight bet is one line; a parlay is several, one
 *    per selection. Each line reads:
 *      `M.G319748909\r\nFootball - Rams vs Chargers / Game / Winner (2 way) / Rams -140`
 *    with an optional leading code (`S.`, `M.G…`, `P.G…`) before the first newline.
 *  - `WagerType` uses codes `S`, `P` and `M` in this feed. `M` has no documented meaning in this
 *    repository, so it is carried as a raw code rather than guessed into a name.
 *  - `VolumeAmount` is sometimes far below `AmountWagered` (a $3,500 wager with $2,188 volume),
 *    so both are kept and the difference is reported instead of one being treated as a typo.
 *  - `TicketWriter` names the channel: `GSLIVE`, `GSBUILDER`, `Internet`, `ALERT`, `BLOCKED`.
 *    `ALERT` rows mirror a real ticket within seconds with `VolumeAmount` 0, and `BLOCKED` rows
 *    are sentinels rather than wagers, so neither may be summed into stake.
 */

import { SPORT_CATEGORIES } from "./sport_taxonomy.ts";

/** Parse a bet-ticker XML feed with Bun's native parser (compact shape). */
export function parseBetTickerXml(
  input: string | Uint8Array,
): Bun.XML.Document {
  return Bun.XML.parse(input);
}

export interface LiveWagerLeg {
  /** `Football`, `Basketball`, `Soccer`, `Tennis`, `Hockey`, … as printed. */
  readonly sport: string;
  /** `"Los Angeles Rams vs Los Angeles Chargers"`. */
  readonly game: string;
  /** `Game`, `1st Half`, `Match`, … */
  readonly period: string;
  /** `Winner (2 way)`, `Point spread`, `Total`, … */
  readonly market: string;
  /** `"Los Angeles Rams -140"`; empty when the line had no pick segment. */
  readonly pick: string;
  /** The raw line as printed, for anything the split above loses. */
  readonly raw: string;
  /**
   * True for the portal's compact grammar (`S:Basketball #540 Warriors -2 -110 - For Game`),
   * which has no `/ Period / Market / Pick` segments. Sport is still recognised; the rest of
   * the line lands in `pick` rather than being guessed into fields it does not have.
   */
  readonly compact: boolean;
  /**
   * `LIVE #9263 …` / `… (Live)` — the only live marker in the feed.
   *
   * `WagerType` is **not** it: the page carries `M.LIVE`, `S:LIVE` and `L.LIVE` rows, so `M` and
   * `S` are live too, and `L` also appears on ordinary soccer/half markets. The word in
   * `ShortDesc` is the signal; the type code is not.
   */
  readonly live: boolean;
  /** The portal's `#<id>` game number when the line carries one, else `null`. */
  readonly gameNumber: string | null;
}

export interface LiveWager {
  readonly wagerNumber: number;
  readonly agentId: string;
  readonly agentLogin: string;
  readonly customerId: string;
  readonly login: string;
  /** Raw `WagerType`: `S`, `P`, `M`, … — never renamed here. */
  readonly wagerType: string;
  readonly amountWagered: number;
  readonly toWinAmount: number;
  readonly volumeAmount: number;
  /** True when `volumeAmount` is not equal to `amountWagered`. */
  readonly volumeDiffers: boolean;
  readonly ticketWriter: string;
  /** Channel family inferred from `TicketWriter`; `other` for anything unrecognised. */
  readonly writer:
    "gslive" | "gsbuilder" | "internet" | "alert" | "blocked" | "other";
  readonly insertedAt: string;
  readonly vip: boolean;
  /**
   * Any leg carries the `LIVE` marker. This is the live/pregame split — `WagerType` is not
   * (`M.LIVE`, `S:LIVE` and `L.LIVE` all occur on the same page).
   */
  readonly live: boolean;
  readonly legs: readonly LiveWagerLeg[];
  /** Leading code before the first newline (`S`, `M.G319748909`, `P.G14580595`). */
  readonly descCode: string | null;
  /** `W`/`L`/`X`/`P` when the wire row carries `WagerStatus`; absent in most ticker rows. */
  readonly wagerStatus?: string;
}

export interface WagerListFile {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly observedAt: string | null;
  readonly wagers: readonly LiveWager[] | readonly Record<string, unknown>[];
}

/**
 * What the committed file says about itself. Served alongside the rows so a count of 17 can
 * never be read as "the ticker showed 17".
 */
export interface WagerListProvenance {
  /** `capture:<operation>@<id>`, `paste:…`, or `unlabelled` when the file declares nothing. */
  readonly source: string;
  /** When the rows were observed, or null when the file does not say. */
  readonly observedAt: string | null;
  /** The file's own note about how it was obtained, verbatim. */
  readonly captureNote: string | null;
  /**
   * True when the list is a subset of what the portal showed. An explicit `partial` flag wins;
   * otherwise the presence of any capture note is enough, because a file that needed a caveat
   * is not a clean capture.
   */
  readonly partial: boolean;
}

export interface WagerListArtifact {
  readonly wagers: readonly LiveWager[];
  readonly provenance: WagerListProvenance;
}

const WRITERS: Readonly<Record<string, LiveWager["writer"]>> = {
  gslive: "gslive",
  gsbuilder: "gsbuilder",
  internet: "internet",
  alert: "alert",
  blocked: "blocked",
};

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * The compact XML shape collapses a one-item list to the item (`LIST: {...}`), while JSON
 * captures keep `LIST: [{...}]`. Normalize both before iterating.
 */
function oneOrMany(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "object") return [value];
  return undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `GSLIVE   ` → `gslive`; anything unknown → `other`. */
export function writerOf(ticketWriter: unknown): LiveWager["writer"] {
  return WRITERS[text(ticketWriter).toLowerCase()] ?? "other";
}

/**
 * `ALERT` mirrors another row's stake and `BLOCKED` is not a wager; summing either inflates the
 * book. Same rule as the forensic pending reader in `forensic_diagnostic_modes.ts`.
 */
export function isTickerNoise(wager: Pick<LiveWager, "writer">): boolean {
  return wager.writer === "alert" || wager.writer === "blocked";
}

/** Longest-first so multi-word sports ("Auto Racing") win over a shorter prefix. */
const SPORT_PREFIXES = [...SPORT_CATEGORIES]
  .filter((name) => name !== "Other")
  .sort((a, b) => b.length - a.length);

/** Splits `"Football #263 Eagles 8 -160 …"` into its sport and the remainder. */
export function splitSportPrefix(header: string): {
  sport: string;
  rest: string;
} {
  const trimmed = header.trim();
  for (const sport of SPORT_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(sport.toLowerCase())) {
      const rest = trimmed
        .slice(sport.length)
        .replace(/^[\s:,-]+/, "")
        .trim();
      return { sport, rest };
    }
  }
  return { sport: trimmed, rest: "" };
}

/** `LIVE #9263 Eagles (Live) -160 - For Game` and `#209857 Houston/Portland O 2½,3 -130`. */
const LIVE_TOKEN = /^LIVE\s+#(\d+)\s+/i;
const HASH_TOKEN = /^#(\d+)\s+/;

/**
 * The compact grammar has no `/` segments: it is `[Sport] [#id] [LIVE #id] <selection> <odds>
 * - For <period>`. Everything after the odds is the period, the `#id` is the game number, and the
 * `LIVE` token is the only live marker the feed carries.
 */
function parseCompactLeg(header: string): {
  sport: string;
  pick: string;
  period: string;
  live: boolean;
  gameNumber: string | null;
} {
  // `L.LIVE …` / `L:Soccer …` — the outer loop only strips `S`, `P` and `M`.
  const coded = /^[A-Z][.:]/.exec(header);
  const withoutCode = coded === null ? header : header.slice(2).trim();
  const { sport, rest } = splitSportPrefix(withoutCode);
  // `splitSportPrefix` returns the whole header as `sport` when nothing matched — that is "no
  // sport", not a sport called `LIVE #9263 Eagles (Live)`. Hand the text to the token parser.
  const knownSport = SPORT_PREFIXES.some(
    (name) => name.toLowerCase() === sport.toLowerCase(),
  );
  let body = rest === "" ? (knownSport ? "" : withoutCode) : rest;
  let resolvedSport = rest === "" && !knownSport ? "" : sport;
  let live = false;
  let gameNumber: string | null = null;

  const liveMatch = LIVE_TOKEN.exec(body);
  if (liveMatch !== null) {
    live = true;
    gameNumber = liveMatch[1] ?? null;
    body = body.slice(liveMatch[0].length);
  } else {
    const hashMatch = HASH_TOKEN.exec(body);
    if (hashMatch !== null) {
      gameNumber = hashMatch[1] ?? null;
      body = body.slice(hashMatch[0].length);
    }
  }

  if (/\bLIVE\b|\(live\)/i.test(body)) live = true;

  // ` - For Game` / ` - For 1st Half` is the period tail.
  let period = "";
  const tail = /\s+-\s+For\s+(.+)$/i.exec(body);
  if (tail !== null) {
    period = (tail[1] ?? "").trim();
    body = body.slice(0, tail.index).trim();
  }

  return { sport: resolvedSport, pick: body.trim(), period, live, gameNumber };
}

/**
 * Splits `ShortDesc` into legs and each leg into sport / game / period / market / pick.
 *
 * Lines are separated by `\r\n` (and stray `&#x0D;\n` artefacts); a leg is
 * `"Sport - Game / Period / Market / Pick"`. Segments are taken positionally, and a leg with
 * fewer segments keeps what it has rather than inventing the rest.
 *
 * The client's bet-ticker renderer strips non-ASCII from `ShortDesc` before painting the DOM
 * (`replace(/[^(\x20-\x7F)½]+/g, "")`), so DOM captures mangle names like `Culiacán`. This
 * parser deliberately preserves them: the JSON source is correct, and if the client bug is
 * fixed the two stay aligned.
 */
export function parseShortDesc(shortDesc: unknown): {
  legs: LiveWagerLeg[];
  descCode: string | null;
  /** Any leg carries the live marker. `WagerType` cannot answer this. */
  isLive: boolean;
} {
  const raw = String(shortDesc ?? "")
    .replace(/&#x0D;?/gi, "\n")
    .replace(/\\r\\n|\\n/g, "\n");

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) return { legs: [], descCode: null, isLive: false };

  // A code line looks like `M.G319748909` or `S.` and is alone on its first line.
  let descCode: string | null = null;
  let start = 0;
  const first = lines[0] as string;
  if (/^[A-Z]\.(?:[A-Z]\d+)?$/.test(first)) {
    descCode = first;
    start = 1;
  } else if (first.startsWith("S:") || first.startsWith("P:")) {
    // `S:Basketball #540 …` — the code is a prefix of the leg itself, not its own line.
    descCode = first.slice(0, 1);
  }

  // `M.G319748909` carries the game id for every leg that has no `#id` of its own.
  const codeGame =
    descCode === null ? null : (/G(\d{6,})/.exec(descCode)?.[1] ?? null);

  const legs: LiveWagerLeg[] = [];
  for (const line of lines.slice(start)) {
    const [head, ...rest] = line.split(" / ");
    let header = head ?? "";
    // A leg may carry its own code prefix (`S:Basketball #540 …`), even when the description
    // had no separate code line. Strip it before splitting so the sport is not `S:Basketball`.
    if (/^[SPM][.:]/.test(header)) {
      descCode ??= header.slice(0, 1);
      header = header.slice(2).trim();
    }

    if (rest.length === 0) {
      // Compact grammar: no `/ Period / Market / Pick` segments to read.
      const compactLeg = parseCompactLeg(header);
      legs.push({
        sport: compactLeg.sport,
        game: "",
        period: compactLeg.period,
        market: "",
        pick: compactLeg.pick,
        raw: line,
        compact: true,
        live: compactLeg.live,
        gameNumber: compactLeg.gameNumber,
      });
      continue;
    }

    const dash = header.indexOf(" - ");
    let sport = dash >= 0 ? header.slice(0, dash).trim() : header.trim();
    const game = dash >= 0 ? header.slice(dash + 3).trim() : "";

    // Sport names arrive as `Football`, but guard against pads and stray codes anyway.
    if (
      !SPORT_PREFIXES.some((name) => name.toLowerCase() === sport.toLowerCase())
    ) {
      sport = splitSportPrefix(sport).sport;
    }

    legs.push({
      sport,
      game,
      period: (rest[0] ?? "").trim(),
      market: (rest[1] ?? "").trim(),
      pick: rest.slice(2).join(" / ").trim(),
      raw: line,
      compact: false,
      live: /\bLIVE\b|\(live\)/i.test(line),
      gameNumber:
        /G(\d{6,})/.exec(line)?.[1] ?? /#(\d+)/.exec(line)?.[1] ?? codeGame,
    });
  }

  return {
    legs,
    descCode,
    isLive: legs.some((leg) => leg.live),
  };
}

export function toLiveWager(row: Record<string, unknown>): LiveWager {
  const { legs, descCode, isLive } = parseShortDesc(row.ShortDesc);
  const amountWagered = number(row.AmountWagered);
  const volumeAmount = number(row.VolumeAmount);
  const ticketWriter = text(row.TicketWriter);

  return {
    wagerNumber: number(row.WagerNumber),
    agentId: text(row.AgentID),
    agentLogin: text(row.AgentLogin),
    customerId: text(row.CustomerID),
    login: text(row.Login),
    wagerType: text(row.WagerType),
    amountWagered,
    toWinAmount: number(row.ToWinAmount),
    volumeAmount,
    volumeDiffers: amountWagered !== volumeAmount,
    ticketWriter,
    writer: writerOf(ticketWriter),
    insertedAt: text(row.InsertDateTime),
    vip: text(row.VIP) !== "" && text(row.VIP) !== "0",
    legs,
    descCode,
    live: isLive,
    wagerStatus: text(row.WagerStatus),
  };
}

/** Accepts the `{LIST: [...]}` envelope, a bare array, or already-mapped wagers. */
export function readWagerList(payload: unknown): LiveWager[] {
  return [...readWagerListArtifact(payload).wagers];
}

export const BET_TICKER_OPERATION = "/cloud/api/Manager/getBetTicker";

/** Provenance prefix for a live `getBetTicker` read (`live:<operation>@<observedAt>`). */
export const LIVE_TICKER_SOURCE_PREFIX = "live:";

/**
 * A raw `getBetTicker` body as the file `/api/live-wagers` serves. `wagerNumber=0` returns the
 * whole current list, so a capture is complete (`partial: false`), unlike the clipboard paste.
 * Throws when the body has no `LIST`, so a login page or error envelope never replaces a capture.
 */
export function betTickerFile(
  payload: unknown,
  observedAt: string,
): {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly observedAt: string;
  readonly partial: false;
  readonly LIST: readonly unknown[];
} {
  const hasList =
    typeof payload === "object" && payload !== null && "LIST" in payload;
  const list = hasList
    ? oneOrMany((payload as { LIST?: unknown }).LIST)
    : undefined;
  if (list === undefined) {
    throw new Error("getBetTicker body has no LIST array");
  }
  return {
    schemaVersion: 1,
    source: `capture:${BET_TICKER_OPERATION}@${observedAt}`,
    observedAt,
    partial: false,
    LIST: list,
  };
}

/**
 * A live `getBetTicker` body as persisted under `data/live-wagers.json`. Same wire shape as
 * {@link betTickerFile}, with a `live:` provenance label.
 */
export function liveTickerFile(
  payload: unknown,
  observedAt: string,
): {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly observedAt: string;
  readonly partial: false;
  readonly LIST: readonly unknown[];
} {
  const captured = betTickerFile(payload, observedAt);
  return {
    ...captured,
    source: `${LIVE_TICKER_SOURCE_PREFIX}${BET_TICKER_OPERATION}@${observedAt}`,
  };
}

/** The rows plus whatever the file admits about its own completeness. */
export function readWagerListArtifact(payload: unknown): WagerListArtifact {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? (oneOrMany((payload as { LIST?: unknown }).LIST) ?? [])
      : [];

  const wagers = rows
    .filter(
      (row): row is Record<string, unknown> =>
        typeof row === "object" && row !== null && "WagerNumber" in row,
    )
    .map(toLiveWager);

  const meta = (payload ?? {}) as Record<string, unknown>;
  const captureNote = text(
    meta.captureNote === undefined ? null : meta.captureNote,
  );
  const source = text(meta.source ?? meta.dataSource);
  const observedAt = text(meta.observedAt ?? meta.capturedAt);

  return {
    wagers,
    provenance: {
      source: source === "" ? "unlabelled" : source,
      observedAt: observedAt === "" ? null : observedAt,
      captureNote: captureNote === "" ? null : captureNote,
      partial:
        typeof meta.partial === "boolean" ? meta.partial : captureNote !== "",
    },
  };
}

/**
 * `count`, `byWriter` and `byType` cover every row, because the filter chips show every row.
 * Every other figure covers only the `counted` rows — those `isTickerNoise` does not reject.
 */
export interface LiveWagerSummary {
  /** All rows, noise included. */
  readonly count: number;
  /** Rows that are not `ALERT` mirrors or `BLOCKED` sentinels. */
  readonly counted: number;
  /** What was left out of the stake figures; `risk` is the noise rows' `amountWagered`. */
  readonly excluded: {
    readonly alert: number;
    readonly blocked: number;
    readonly risk: number;
  };
  readonly risk: number;
  readonly toWin: number;
  readonly volume: number;
  readonly vip: number;
  readonly volumeMismatches: number;
  readonly byWriter: Record<string, number>;
  readonly byType: Record<string, number>;
  readonly bySport: Record<string, number>;
  readonly legs: number;
  /** Counted rows whose description carries the live marker. */
  readonly live: number;
  /** `counted - live`. */
  readonly pregame: number;
  readonly liveRisk: number;
  readonly pregameRisk: number;
}

/** Aggregates over the parsed rows; sports come from the legs, so parlays count each leg. */
export function summarizeLiveWagers(
  wagers: readonly LiveWager[],
): LiveWagerSummary {
  const byWriter: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const bySport: Record<string, number> = {};
  let counted = 0;
  let excludedAlert = 0;
  let excludedBlocked = 0;
  let excludedRisk = 0;
  let risk = 0;
  let toWin = 0;
  let volume = 0;
  let vip = 0;
  let volumeMismatches = 0;
  let legs = 0;
  let live = 0;
  let liveRisk = 0;

  for (const wager of wagers) {
    byWriter[wager.writer] = (byWriter[wager.writer] ?? 0) + 1;
    const type = wager.wagerType === "" ? "unknown" : wager.wagerType;
    byType[type] = (byType[type] ?? 0) + 1;

    if (isTickerNoise(wager)) {
      if (wager.writer === "alert") excludedAlert += 1;
      else excludedBlocked += 1;
      excludedRisk += wager.amountWagered;
      continue;
    }

    counted += 1;
    risk += wager.amountWagered;
    toWin += wager.toWinAmount;
    volume += wager.volumeAmount;
    if (wager.vip) vip += 1;
    if (wager.volumeDiffers) volumeMismatches += 1;

    if (wager.live) {
      live += 1;
      liveRisk += wager.amountWagered;
    }

    for (const leg of wager.legs) {
      legs += 1;
      const sport = leg.sport === "" ? "unknown" : leg.sport;
      bySport[sport] = (bySport[sport] ?? 0) + 1;
    }
  }

  return {
    count: wagers.length,
    counted,
    excluded: {
      alert: excludedAlert,
      blocked: excludedBlocked,
      risk: excludedRisk,
    },
    risk,
    toWin,
    volume,
    vip,
    volumeMismatches,
    byWriter,
    byType,
    bySport,
    legs,
    live,
    pregame: counted - live,
    liveRisk,
    pregameRisk: risk - liveRisk,
  };
}
