/**
 * @file market_type_registry.ts
 * @description Canonical market vocabulary for cross-venue matching: parser kinds, observed
 * picker labels, period tokens, the documented F402 wager-type map and combo rules.
 *
 * Why a registry rather than per-call switches:
 *  - The pending feed's picker label (`subSport`) uses book vocabulary (`Winner (2 way)`,
 *    `Point spread`, `Miami Heat team total`), while the parser uses kinds
 *    (`moneyline`, `spread`, `team_total`). One mapping table keeps every consumer aligned.
 *  - Wager type codes have a documented map in `lib/combo_identity.ts` (from the deobfuscated
 *    report.js), including which codes append total picks — the combo rule.
 *  - Kalshi series live in one place (`SERIES_BY_LEAGUE`); this module reads that map instead
 *    of duplicating it.
 *
 * Data: `data/market_type_registry.json` (generated from the capture by
 * `Scratch/normalization/build_market_type_registry.ts`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  F402_WAGER_TYPE_MAP,
  type F402ReportWagerTypeCode,
  type F402WagerTypeMeta,
} from "./combo_identity.ts";
import { SERIES_BY_LEAGUE } from "./kalshi_signal_join.ts";
import {
  describeWagerComposition,
  type WagerComposition,
} from "./wager_composition.ts";
import type { League } from "./watchlist_signal_engine.ts";

export interface ObservedMarketLabel {
  readonly label: string;
  readonly count: number;
}

export interface MarketTypeEntry {
  readonly id: string;
  readonly parserKind: string | null;
  readonly family: string;
  readonly periods: readonly string[];
  readonly observed: readonly ObservedMarketLabel[];
  readonly parserObserved: number;
}

export interface WagerTypeEntry {
  readonly code: F402ReportWagerTypeCode;
  readonly name: string;
  readonly labelKey: string;
  readonly appendsTotalPicks: boolean;
  readonly canonicalEligible: boolean;
  readonly combo: boolean;
  readonly observed: number;
}

export interface VenueEquivalence {
  readonly product: string;
  readonly note: string;
}

export interface MarketTypeRegistry {
  readonly schemaVersion: number;
  readonly description: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly wagerTypes: readonly WagerTypeEntry[];
  readonly marketTypes: readonly MarketTypeEntry[];
  readonly periods: {
    readonly tokens: Readonly<Record<string, readonly string[]>>;
  };
  readonly combos: {
    readonly definition: string;
    readonly minLegs: number;
    readonly wagerCodes: readonly string[];
    readonly observed: Readonly<Record<string, unknown>>;
    readonly venueEquivalence: Readonly<Record<string, VenueEquivalence>>;
  };
}

const DEFAULT_PATH = resolve(
  import.meta.dir,
  "../data/market_type_registry.json",
);
let cached: MarketTypeRegistry | null = null;

/**
 * Fallback used only when the generated data file is absent (fresh checkout before the generator
 * runs, or an external clean that removed the untracked artifact). It carries the code-defined
 * vocabulary so classification still works; the observed label counts are empty.
 */
function fallbackRegistry(): MarketTypeRegistry {
  const families: Record<string, string> = {
    moneyline: "single outcome price (team/player/draw)",
    spread: "handicap/line vs opponent",
    total: "over/under on a combined score",
    team_total: "over/under on one team's score",
    player_prop: "player stat over/under",
    prop: "non-player prop (margin, first scorer, tree)",
    combo: "ticket of ≥2 legs; venue combo products are wallet/RFQ-anchored",
  };
  const kinds: MarketTypeEntry[] = Object.entries(families).map(
    ([id, family]) => ({
      id,
      parserKind: id === "combo" ? null : id,
      family,
      periods: ["game"],
      observed: [],
      parserObserved: 0,
    }),
  );
  return {
    schemaVersion: 0,
    description: "fallback vocabulary (data/market_type_registry.json missing)",
    snapshot: {},
    wagerTypes: Object.values(F402_WAGER_TYPE_MAP).map((meta) => ({
      code: meta.code,
      name: meta.name,
      labelKey: meta.labelKey,
      appendsTotalPicks: meta.appendsTotalPicks,
      canonicalEligible: meta.isSportsCanonicalEligible,
      combo: ["P", "T", "I"].includes(meta.code),
      observed: 0,
    })),
    marketTypes: kinds,
    periods: {
      tokens: {
        game: ["Game", "Match", "Match (Including OT)"],
        "1h": ["1st Half"],
        "2h": ["2nd Half"],
        "1q": ["1st Quarter"],
        "2q": ["2nd Quarter"],
        "3q": ["3rd Quarter"],
        "4q": ["4th Quarter"],
        "1p": ["1st Period"],
        "2p": ["2nd Period"],
        "3p": ["3rd Period"],
        round: ["1st Round"],
      },
    },
    combos: {
      definition: "a ticket with two or more picks/legs",
      minLegs: 2,
      wagerCodes: ["P", "T", "I"],
      observed: {},
      venueEquivalence: {
        kalshi: {
          product: "none",
          note: "Kalshi exposes single markets only",
        },
        polymarket: {
          product: "combo",
          note: "combo product is wallet/RFQ-anchored",
        },
        repo: {
          product: "synthetic",
          note: "lib/sports_combo_* is repo-side pricing, not a venue market",
        },
      },
    },
  };
}

export function loadMarketTypeRegistry(
  path: string = DEFAULT_PATH,
): MarketTypeRegistry {
  if (cached === null) {
    try {
      cached = JSON.parse(readFileSync(path, "utf8")) as MarketTypeRegistry;
    } catch {
      cached = fallbackRegistry();
    }
  }
  return cached;
}

export function resetMarketTypeRegistryCache(): void {
  cached = null;
}

const normalizeLabel = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.+$/, "");

/**
 * Canonical kind for a picker label or parser kind. The registry's observed labels win (they
 * are the capture's own strings), then a small set of shape rules covers per-team/per-player
 * labels that cannot be enumerated (`<team> team total`, `Total Player ...`).
 */
export function classifyMarketLabel(
  raw: string | null | undefined,
): string | null {
  const label = normalizeLabel(raw ?? "");
  if (label === "") return null;
  const registry = loadMarketTypeRegistry();
  for (const entry of registry.marketTypes) {
    const hit = entry.observed.find(
      (observed) => normalizeLabel(observed.label) === label,
    );
    if (hit !== undefined) return entry.id;
    if (
      entry.parserKind !== null &&
      normalizeLabel(entry.parserKind) === label
    ) {
      return entry.id;
    }
  }
  if (label.endsWith(" team total")) return "team_total";
  if (label === "game winner" || label === "winner (3 way)") return "moneyline";
  if (label.startsWith("total player ")) return "player_prop";
  if (label === "total assists" || label === "total interceptions") {
    return "player_prop";
  }
  if (label === "total" || label === "over/under") return "total";
  if (label.startsWith("total ")) return "prop";
  if (label.includes("spread")) return "spread";
  if (label.includes("winner") || label.includes("moneyline"))
    return "moneyline";
  if (label.includes("futures") || label.startsWith("to win")) return "futures";
  return null;
}

/** Canonical period token for a raw period label (`"2nd Period"` → `"2p"`). */
export function periodTokenFor(raw: string | null | undefined): string | null {
  const label = normalizeLabel(raw ?? "");
  if (label === "") return null;
  const tokens = loadMarketTypeRegistry().periods.tokens;
  for (const [token, raws] of Object.entries(tokens)) {
    if (raws.some((candidate) => normalizeLabel(candidate) === label)) {
      return token;
    }
  }
  return null;
}

/** The documented F402 wager-type metadata, or null for an unknown code. */
export function wagerTypeMeta(
  code: string | null | undefined,
): F402WagerTypeMeta | null {
  const upper = (code ?? "").trim().toUpperCase();
  if (upper === "") return null;
  return F402_WAGER_TYPE_MAP[upper as F402ReportWagerTypeCode] ?? null;
}

export interface ComboInput {
  readonly wagerType?: string | null;
  readonly wagerKind?: string | null;
  readonly picks?: number | null;
  /** Wire description; when present the leg composition (same-game/cross-game/cross-sport) is classified. */
  readonly description?: string | null;
}

export interface ComboProfile {
  readonly isCombo: boolean;
  readonly code: string | null;
  readonly name: string | null;
  /** Picks/legs when the caller knows them; null otherwise. */
  readonly legs: number | null;
  readonly reasons: readonly string[];
  readonly composition: WagerComposition;
  readonly venue: Readonly<Record<string, VenueEquivalence>>;
}

const MULTI_LEG_KINDS = new Set(["parlay", "teaser", "ifbet", "reverse"]);

/**
 * Classify a ticket as a combo. Evidence is explicit: the documented wager code (P/T/I append
 * picks), the wire wager kind, or a known leg count ≥ 2. A casino/manual code is not treated
 * as a sports combo even when the code is unusual.
 */
export function comboProfile(input: ComboInput): ComboProfile {
  const code = (input.wagerType ?? "").trim().toUpperCase() || null;
  const meta = wagerTypeMeta(code);
  const legs =
    input.picks !== null &&
    input.picks !== undefined &&
    Number.isFinite(input.picks)
      ? Math.trunc(input.picks)
      : null;
  const kind = (input.wagerKind ?? "").trim().toLowerCase();
  const reasons: string[] = [];
  if (meta?.appendsTotalPicks === true) {
    reasons.push(`wager code ${meta.code} appends total picks`);
  }
  if (MULTI_LEG_KINDS.has(kind)) reasons.push(`wager kind ${kind}`);
  if (legs !== null && legs >= 2) reasons.push(`${legs} picks`);
  const nonSports = meta !== null && meta.isSportsCanonicalEligible === false;
  const composition = describeWagerComposition(input.description, legs);
  if (composition.legCount >= 2 && composition.splitLegs >= 2) {
    reasons.push(`${composition.legCount} legs in description`);
  }
  // Futures are outside the requested wager coverage and are never a combo here.
  const isCombo =
    !nonSports && !composition.excludedFutures && reasons.length > 0;
  return {
    isCombo,
    code,
    name: meta?.name ?? null,
    legs,
    reasons,
    composition,
    venue: loadMarketTypeRegistry().combos.venueEquivalence,
  };
}

/** Kalshi series for a league × kind, from the single source of truth. */
export function kalshiSeriesFor(
  league: string,
  marketKind: string,
): string | null {
  const leagueMap = SERIES_BY_LEAGUE[league.toUpperCase() as League];
  if (leagueMap === undefined) return null;
  return leagueMap[marketKind] ?? null;
}

/** One-line venue family description for a canonical kind. */
export function marketFamilyFor(kind: string): string | null {
  const entry = loadMarketTypeRegistry().marketTypes.find(
    (candidate) => candidate.id === kind,
  );
  return entry?.family ?? null;
}
