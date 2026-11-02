/**
 * @file contests.ts
 * @description The portal's Contest (futures) list: one entry per `data-action="get-games-prop"`
 * anchor in the sports nav, keyed by `contestNum`.
 *
 * The nav groups entries by `<div data-group="FOOTBALL">`, and each anchor carries a
 * `data-param` whose `type` string packs three fields separated by runs of `‡`:
 *
 *   "FOOTBALL‡‡‡…NFL 1st TD Scorer‡‡‡…Chargers vs Rams"
 *    sport      league/market         subject
 *
 * `parseContestType` splits on those runs and drops the padding, so a UI can show
 * "NFL 1st TD Scorer" instead of the raw padded string. It never guesses when fewer than
 * three parts survive: it returns what it has and marks the entry `partial`.
 */

export interface ContestEntry {
  /** `contestNum` from `data-param`; the portal's primary key. */
  readonly contestNum: number;
  /** `data-group` of the enclosing block, e.g. `FOOTBALL`. */
  readonly group: string;
  /** `data-type` on the anchor, e.g. `GOLF`. */
  readonly type: string;
  /** `contestDesc` with the padding removed, e.g. `Mexico Open - Top 5`. */
  readonly description: string;
  /** `type` split into its three non-empty segments. */
  readonly sport: string | null;
  readonly market: string | null;
  readonly subject: string | null;
  /** True when fewer than three segments survived. */
  readonly partial: boolean;
}

export interface ContestFile {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly extractedAt: string | null;
  readonly entries: readonly ContestEntry[];
}

/**
 * The portal uses a single `‡` between words and a run of them between fields, so the two
 * must be treated differently: splitting on any `‡` mangles "Mexico Open Futures" into three
 * fields.
 */
const WORD_SEP = /‡/g;
const FIELD_SEP = /‡{2,}/;

export function stripPadding(raw: unknown): string {
  return String(raw ?? "")
    .replace(WORD_SEP, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseContestType(raw: unknown): {
  sport: string | null;
  market: string | null;
  subject: string | null;
  partial: boolean;
} {
  const parts = String(raw ?? "")
    .split(FIELD_SEP)
    .map((field) => field.replace(WORD_SEP, " ").replace(/\s+/g, " ").trim())
    .filter((field) => field !== "");

  const [sport = null, market = null, ...rest] = parts;
  const subject = rest.length > 0 ? rest.join(" ") : null;

  return { sport, market, subject, partial: parts.length < 3 };
}

export function readContestFile(payload: unknown): ContestFile | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Partial<ContestFile>;
  if (!Array.isArray(record.entries)) return null;
  return {
    schemaVersion: 1,
    source: typeof record.source === "string" ? record.source : "",
    extractedAt:
      typeof record.extractedAt === "string" ? record.extractedAt : null,
    entries: record.entries as ContestEntry[],
  };
}

/** Contests for one `data-group`, or all when `group` is empty. */
export function contestsInGroup(
  file: ContestFile,
  group: string,
): ContestEntry[] {
  if (group.trim() === "") return [...file.entries];
  const needle = group.trim().toUpperCase();
  return file.entries.filter((entry) => entry.group.toUpperCase() === needle);
}

/** Case-insensitive search across description, group and the parsed segments. */
export function searchContests(
  file: ContestFile,
  query: string,
): ContestEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...file.entries];
  return file.entries.filter((entry) =>
    [
      entry.description,
      entry.group,
      entry.sport,
      entry.market,
      entry.subject,
      String(entry.contestNum),
    ]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(needle)),
  );
}

export function summarizeContests(file: ContestFile): {
  total: number;
  byGroup: Record<string, number>;
  partial: number;
} {
  const byGroup: Record<string, number> = {};
  let partial = 0;
  for (const entry of file.entries) {
    byGroup[entry.group] = (byGroup[entry.group] ?? 0) + 1;
    if (entry.partial) partial += 1;
  }
  return { total: file.entries.length, byGroup, partial };
}

/* ---------------------------------------------------------------- markup parsing */

/** `&quot;` and friends appear inside `data-param`; decode before JSON.parse. */
export function decodeEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface RawParam {
  readonly contestNum?: unknown;
  readonly contestDesc?: unknown;
  readonly type?: unknown;
}

/**
 * Walks the markup keeping the most recent `data-group`, so each anchor inherits the group
 * it sits under. Anchors outside any group are skipped rather than guessed.
 */
export function extractContests(html: string): ContestEntry[] {
  // Saved markup arrives two ways: HTML-escaped JSON inside double quotes
  // (`data-param="{&quot;…&quot;}"`) straight from the page, and raw JSON inside single
  // quotes (`data-param='{"…":"…"}'`) once a formatter has run. Accept both.
  const tokens = [
    ...html.matchAll(
      /data-group=(?:"([^"]*)"|'([^']*)')|data-param=(?:"([^"]*)"|'([^']*)')/g,
    ),
  ];
  const byContest = new Map<number, ContestEntry>();
  let group = "";

  for (const token of tokens) {
    const groupValue = token[1] ?? token[2];
    if (groupValue !== undefined) {
      group = decodeEntities(groupValue).trim().toUpperCase();
      continue;
    }

    const escaped = token[3] ?? token[4];
    if (escaped === undefined) continue;

    let param: RawParam;
    try {
      param = JSON.parse(decodeEntities(escaped)) as RawParam;
    } catch {
      continue; // A malformed anchor must not abort the whole extraction.
    }

    const contestNum = Number(param.contestNum);
    if (!Number.isFinite(contestNum) || contestNum <= 0) continue;

    const parsed = parseContestType(param.type);
    const description =
      stripPadding(param.contestDesc) || stripPadding(param.type);

    // First occurrence wins: the same contest can be linked from several groups.
    if (byContest.has(contestNum)) continue;
    byContest.set(contestNum, {
      contestNum,
      group: group === "" ? stripPadding(parsed.sport).toUpperCase() : group,
      type: String(param.type ?? ""),
      description,
      sport: parsed.sport,
      market: parsed.market,
      subject: parsed.subject,
      partial: parsed.partial,
    });
  }

  return [...byContest.values()].sort((a, b) => a.contestNum - b.contestNum);
}
