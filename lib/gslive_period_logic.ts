/**
 * @file GSLive `sportPeriods` vocabulary: the period table behind the bet-history Period filter.
 *
 * WHY IT EXISTS
 *
 * `#/events/bet-history` filters on a period *code* (`s3`), while the operator console shows a
 * *label* that is sport-specific: `s1` is "1st Inning" for Baseball, "1st Quarter" for
 * Basketball and "1st Period" for Hockey. Building a link from a label — or validating a code a
 * caller guessed — needs the captured table rather than a global number→name guess.
 *
 * SOURCE / PROVENANCE
 *
 * `POST https://plive.sportswidgets.pro/betLobbyV2/logic/` with body `{"a":"sportPeriods"}`
 * (unauthenticated; the same request is documented in docs/gs-manager-contracts.md §2.2).
 * Captured 2026-11-03: `200`, 25,697 bytes, sha256
 * `d00c630926022e7e169103152598d99ddcf3772beebeec90d51c94b3c84dd4b9`, 102 periods /
 * 10 abbreviations / 40 period names. Fixture:
 * tests/fixtures/gslive-sport-periods-2026-11-03.json.
 *
 * The `periods` keys are sport ids quoted as strings and are non-contiguous — never iterate a
 * range. `L_<code>` entries override a code's displayed label, so the label is
 * `L_<code> ?? <code>`, and the override family is not segment-only (`L_h1` exists too).
 */

/** Base period codes the console offers, in display order. */
export const GSLIVE_PERIOD_BASE_CODES = [
  "h1",
  "h2",
  "ht",
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s8",
  "s9",
  "s10",
] as const;
export type GsLivePeriodCode = (typeof GSLIVE_PERIOD_BASE_CODES)[number];

/** One sport's period vocabulary: `m` is the period class; `h1…s10` and `L_*` are labels. */
export interface GsLivePeriodLabels {
  readonly m: string;
  readonly [key: string]: string;
}

/** The parsed `sportPeriods` payload. */
export interface GsLiveSportPeriods {
  readonly periods: Readonly<Record<string, GsLivePeriodLabels>>;
  readonly abbreviations: Readonly<Record<string, string>>;
  readonly periodNames: Readonly<Record<string, string>>;
}

/**
 * Parses the captured `sportPeriods` payload once, at the boundary.
 *
 * @returns the typed vocabulary, or `null` when the payload is not the expected shape (a
 * malformed fixture must surface as MISSING, never as an empty vocabulary).
 */
export function parseGsLiveSportPeriods(
  payload: unknown,
): GsLiveSportPeriods | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const periodsRaw = record.periods;
  const abbreviationsRaw = record.abbreviations;
  const periodNamesRaw = record.periodNames;
  if (
    typeof periodsRaw !== "object" ||
    periodsRaw === null ||
    Array.isArray(periodsRaw) ||
    typeof abbreviationsRaw !== "object" ||
    abbreviationsRaw === null ||
    Array.isArray(abbreviationsRaw) ||
    typeof periodNamesRaw !== "object" ||
    periodNamesRaw === null ||
    Array.isArray(periodNamesRaw)
  ) {
    return null;
  }

  const periods: Record<string, GsLivePeriodLabels> = {};
  for (const [sportId, value] of Object.entries(periodsRaw)) {
    if (typeof value !== "object" || value === null) return null;
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(value)) {
      if (typeof label === "string") labels[key] = label;
    }
    const periodClass = labels.m;
    if (typeof periodClass !== "string") return null;
    periods[sportId] = { ...labels, m: periodClass };
  }

  const abbreviations: Record<string, string> = {};
  for (const [key, value] of Object.entries(abbreviationsRaw)) {
    if (typeof value !== "string") return null;
    abbreviations[key] = value;
  }

  const periodNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(periodNamesRaw)) {
    if (typeof value !== "string") return null;
    periodNames[key] = value;
  }

  return { periods, abbreviations, periodNames };
}

/** One selectable period: its code, the label the console renders, and whether it is overridden. */
export interface GsLivePeriodOption {
  readonly code: GsLivePeriodCode;
  readonly label: string;
  /** True when the console overrides this code's label with `L_<code>`. */
  readonly overridden: boolean;
}

/**
 * Periods offered for one sport, in console order.
 *
 * `NA` (or absent) codes are omitted: the console renders them as unavailable, so they are not
 * a label a link can carry.
 */
export function listGsLivePeriodOptions(
  vocabulary: GsLiveSportPeriods,
  sportId: string,
): readonly GsLivePeriodOption[] {
  const labels = vocabulary.periods[String(sportId).trim()];
  if (labels === undefined) return [];
  const options: GsLivePeriodOption[] = [];
  for (const code of GSLIVE_PERIOD_BASE_CODES) {
    const raw = labels[code];
    if (raw === undefined || raw === "" || raw === "NA") continue;
    const override = labels[`L_${code}`];
    options.push({
      code,
      label: override ?? raw,
      overridden: override !== undefined,
    });
  }
  return options;
}

/** The segment noun for one sport (e.g. `Quarter`, `Inning`); undefined when not captured. */
export function gsLivePeriodName(
  vocabulary: GsLiveSportPeriods,
  sportId: string,
): string | undefined {
  return vocabulary.periodNames[String(sportId).trim()];
}

/**
 * Resolves a code (`s3`) or a display label (`3rd Quarter`) to a period option for one sport.
 *
 * Matching is case- and whitespace-insensitive; a label that matches more than one code resolves
 * to the first in console order. Returns `undefined` when the sport or the value is not captured.
 */
export function resolveGsLivePeriodCode(
  vocabulary: GsLiveSportPeriods,
  sportId: string,
  input: string,
): GsLivePeriodOption | undefined {
  const options = listGsLivePeriodOptions(vocabulary, sportId);
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");
  const needle = normalize(input);
  if (needle === "") return undefined;
  const byCode = options.find((option) => option.code === needle);
  if (byCode !== undefined) return byCode;
  return options.find((option) => normalize(option.label) === needle);
}
