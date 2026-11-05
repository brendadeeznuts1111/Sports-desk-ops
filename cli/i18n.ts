/**
 * @file i18n.ts
 * @description UI-label resolver over the portal's own `ui.json` table.
 *
 * WHY THIS EXISTS
 *
 * Every label the Manager web app renders, and every `data-language="L-xxx"` attribute in an
 * HTML capture, is a key into `/app/language/ui.json`. The CLI used to render hardcoded
 * English constants, so its labels could drift from what the operator sees and could not
 * follow the operator's language. This module resolves labels from the same table the app
 * reads, with the same fallback chain as the client's `get()`:
 *
 *     selected language -> ENGLISH -> the key itself
 *
 * SOURCE OF TRUTH (measured, 2026-11-04)
 *
 * `tests/fixtures/ui.json` is the table the desktop WebView fetched from
 * `/app/language/ui.json`, extracted from the WebView network cache; it is UI label strings
 * only (no logins, amounts or other customer data). Measured coverage: 1,461 keys; ENGLISH
 * complete; SPANISH 1,422; CHINESE 1,460; FRENCH 23; GREEK 0; JAPANESE 0; KOREAN 402;
 * VIETNAMESE 438, plus one row tagged with the typo `VIETNAMES`. An operator can point at a
 * newer table with `--ui-table <path>` / `F402_UI_JSON`.
 *
 * THE UPSTREAM BUG WE DO NOT REPLICATE
 *
 * The client's language switch has a copy/paste defect: its JAPANESE branch assigns the
 * GREEK translation. Because the app's `get()` falls back selected -> default -> key, that
 * bug is mostly invisible — until a GREEK string exists, in which case Greek wins over the
 * English default. This module never reads GREEK for JAPANESE: a missing language falls
 * through to ENGLISH exactly like the rest of the fallback chain, and the CLI warns when
 * JAPANESE is requested (`japaneseFallbackNotice`). A regression test pins the behaviour.
 *
 * This module is deliberately dependency-free (node:fs + node:path only) and pure apart from
 * the lazy table load.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The languages the app ships a switch for. Order is the CLI's language list. */
export type LangCode =
  | "ENGLISH"
  | "SPANISH"
  | "CHINESE"
  | "FRENCH"
  | "GREEK"
  | "JAPANESE"
  | "KOREAN"
  | "VIETNAMESE";

export const LANG_CODES: readonly LangCode[] = [
  "ENGLISH",
  "SPANISH",
  "CHINESE",
  "FRENCH",
  "GREEK",
  "JAPANESE",
  "KOREAN",
  "VIETNAMESE",
] as const;

export const DEFAULT_LANG: LangCode = "ENGLISH";

/** `--lang=keys` renders the raw L-key so an operator can map HTML attributes to columns. */
export const KEYS_MODE = "keys" as const;
export type LangArg = LangCode | typeof KEYS_MODE;

/** One table row: language code -> label. Unknown tags survive (see `coverage`). */
export type UiRow = Readonly<Record<string, string | undefined>>;
export type UiTable = Readonly<Record<string, UiRow>>;

/** Repo-relative default; `--ui-table` and `F402_UI_JSON` may point at a newer extraction. */
export const DEFAULT_UI_TABLE_PATH = "tests/fixtures/ui.json";
export const UI_TABLE_PATH_ENV = "F402_UI_JSON";

/** Known upstream defect: the web app's JAPANESE branch reads the GREEK translation. */
export const JAPANESE_GREEK_UPSTREAM_BUG = {
  replicated: false,
  upstreamBehavior: "JAPANESE request assigns the GREEK translation",
  ourBehavior: "JAPANESE falls through the normal chain to ENGLISH",
} as const;

const TABLES = new Map<string, UiTable>();

/** A label is usable only when it is a non-empty string; the app treats blanks as missing. */
function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Load and cache the UI table. Throws on a missing or malformed file; callers that need a
 * graceful answer use {@link tryLoadUiTable}.
 *
 * @param path repo-relative or absolute path to the extracted ui.json
 * @returns the parsed table (same object on repeated calls for the same path)
 */
export function loadUiTable(
  path: string = Bun.env[UI_TABLE_PATH_ENV]?.trim() || DEFAULT_UI_TABLE_PATH,
): UiTable {
  const absolute = resolve(process.cwd(), path);
  const cached = TABLES.get(absolute);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`ui table is not a JSON object: ${absolute}`);
  }
  const table = parsed as UiTable;
  TABLES.set(absolute, table);
  return table;
}

/** Missing/malformed table is reported by callers instead of crashing a label lookup. */
export function tryLoadUiTable(path?: string): UiTable | null {
  try {
    return loadUiTable(path);
  } catch {
    return null;
  }
}

let defaultTable: UiTable | null | undefined;

function loadDefaultTableOnce(): UiTable | null {
  if (defaultTable === undefined) defaultTable = tryLoadUiTable();
  return defaultTable;
}

/**
 * Resolve one L-key through `selected -> ENGLISH -> key`.
 *
 * `keys` mode is accepted as a convenience so a caller can pass `--lang=keys` straight
 * through and get the raw key back (via {@link labelOrKey} the presentation is identical).
 * A missing table degrades to the key itself rather than throwing at a call site.
 */
export function t(
  key: string,
  lang: LangArg = DEFAULT_LANG,
  table?: UiTable,
): string {
  if (lang === KEYS_MODE) return key;
  const resolved = table ?? loadDefaultTableOnce();
  if (resolved === null) return key;
  const row = resolved[key];
  if (row === undefined) return key;
  // Deliberately NO special case that reads GREEK for JAPANESE: that is the upstream bug.
  const direct = row[lang];
  if (usable(direct)) return direct;
  const english = row.ENGLISH;
  if (usable(english)) return english;
  return key;
}

/**
 * `--lang=keys` returns the key; any language resolves it. Used for analyst output where a
 * screenshot shows translated labels but the operator has raw L-keys in hand.
 */
export function labelOrKey(
  lkey: string,
  lang: LangArg,
  table?: UiTable,
): string {
  return lang === KEYS_MODE ? lkey : t(lkey, lang, table);
}

/** Canonical labels the CLI renders, pinned to verified L-keys (2026-11-04 extraction). */
export const ENGLISH_LABEL_KEYS: Readonly<Record<string, string>> = {
  Ticket: "L-38",
  "To Win": "L-245",
  Source: "L-1029",
  Type: "L-152",
  Customer: "L-213",
  Agent: "L-318",
  Description: "L-207",
  Risk: "L-244",
  Win: "L-393",
  "Time (ET)": "L-1030",
  Sport: "L-235",
  Event: "L-1428",
  Period: "L-236",
  Line: "L-357",
  Live: "L-582",
  Straight: "L-83",
  Parlay: "L-84",
  Teaser: "L-85",
  "If Bet": "L-86",
  Reverse: "L-87",
  Spread: "L-142",
  Money: "L-143",
  Moneyline: "L-1303",
  Total: "L-144",
  "Team Total": "L-145",
  "Double Chance": "L-146",
  BTS: "L-147",
} as const;

/** The genuine `#` column header has no L-key; the CLI renders the literal. */
const NO_KEY_LABELS = new Set(["#", "Stake", "Legs", "Writer", "Pregame"]);

/**
 * Render a canonical English label in the requested language.
 *
 * - ENGLISH returns the caller's literal text, byte-for-byte (the CLI's pinned default
 *   rendering; e.g. its headline uses `To win`, not the table's `To Win`).
 * - `keys` returns the L-key when one exists, else the literal.
 * - Any other language resolves the L-key and falls back to the literal when the table has
 *   no translation, so a sparse locale never prints `L-245` in a Spanish report.
 */
export function label(english: string, lang: LangArg, table?: UiTable): string {
  if (lang === "ENGLISH") return english;
  if (NO_KEY_LABELS.has(english)) return english;
  const key = ENGLISH_LABEL_KEYS[english];
  if (key === undefined) return english;
  if (lang === KEYS_MODE) return key;
  const value = t(key, lang, table);
  return value === key ? english : value;
}

/** Language coverage of a table: present/missing per shipped language + unknown tags. */
export interface LangCoverage {
  readonly totalKeys: number;
  readonly byLang: Readonly<
    Record<
      LangCode,
      {
        readonly present: number;
        readonly missing: number;
        readonly missingKeys: readonly string[];
      }
    >
  >;
  /** Tags found in the table that are outside {@link LANG_CODES} (e.g. the `VIETNAMES` typo). */
  readonly unknownLanguageTags: readonly string[];
}

const MAX_SAMPLE_KEYS = 5;

/**
 * Measure which keys are missing per language. This is the DA view: it explains why an
 * operator sees English in one locale and not another, and it surfaces upstream data bugs
 * such as the `VIETNAMES` typo without opening the browser devtools.
 */
export function coverage(table: UiTable = loadUiTable()): LangCoverage {
  const keys = Object.keys(table);
  const byLang = {} as Record<
    LangCode,
    { present: number; missing: number; missingKeys: string[] }
  >;
  for (const lang of LANG_CODES) {
    byLang[lang] = { present: 0, missing: 0, missingKeys: [] };
  }
  const unknownTags = new Set<string>();
  for (const key of keys) {
    const row = table[key] ?? {};
    for (const tag of Object.keys(row)) {
      if (
        !(LANG_CODES as readonly string[]).includes(tag) &&
        usable(row[tag])
      ) {
        unknownTags.add(tag);
      }
    }
    for (const lang of LANG_CODES) {
      if (usable(row[lang])) {
        byLang[lang].present += 1;
      } else {
        byLang[lang].missing += 1;
        if (byLang[lang].missingKeys.length < MAX_SAMPLE_KEYS) {
          byLang[lang].missingKeys.push(key);
        }
      }
    }
  }
  return {
    totalKeys: keys.length,
    byLang,
    unknownLanguageTags: [...unknownTags].sort(),
  };
}

/** Parse and validate a `--lang` argument; returns null for an unknown language. */
export function parseLangArg(value: string): LangArg | null {
  const normalized = value.trim().toUpperCase();
  if (normalized === "KEYS") return KEYS_MODE;
  return (LANG_CODES as readonly string[]).includes(normalized)
    ? (normalized as LangCode)
    : null;
}

/**
 * The one-line warning the CLI prints when JAPANESE is requested. Deliberately explicit:
 * the operator should know the English fallback is our choice, not a Japanese translation.
 */
export function japaneseFallbackNotice(lang: LangArg): string | null {
  if (lang !== "JAPANESE") return null;
  return (
    "warning: JAPANESE → ENGLISH fallback (upstream bug maps JAPANESE → GREEK); " +
    "this CLI does not replicate it"
  );
}

/** Compact `ENGLISH | SPANISH` language list for --help. */
export function languageList(): string {
  return LANG_CODES.join(" | ");
}
