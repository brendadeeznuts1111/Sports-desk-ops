/**
 * Unified team registry — one canonical entity per franchise, many venue-facing aliases.
 *
 * How venues identify teams (icons are not join keys):
 *  - **SportsDesk / F402:** full names in `ShortDesc`, optional 2–4 letter codes in live-bets JSON.
 *  - **Portal / scoreboard:** display nicknames + CDN logo filenames (`data/scoreboard.json`).
 *  - **Kalshi:** compressed codes embedded in `event_ticker` suffix (e.g. `KXNBAGAME-26NOV04ATLWAS`).
 *  - **Polymarket:** natural-language `question` / slug on gamma markets (no stable team-id API).
 *
 * This module resolves any alias → canonical `code` within a league, then exposes venue codes and
 * Polymarket search hints. Expand `data/unified_team_registry.json` as captures prove new pairs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { League } from "./watchlist_signal_engine.ts";

export interface UnifiedTeamRecord {
  readonly id: string;
  readonly league: League;
  /** Internal canonical code (SportsDesk watchlist / signal vocabulary). */
  readonly code: string;
  readonly displayName: string;
  readonly nicknames?: readonly string[];
  readonly f402Names?: readonly string[];
  readonly kalshiCodes?: readonly string[];
  readonly legacyCodes?: readonly string[];
  readonly polymarketHints?: readonly string[];
  readonly portalLogoFile?: string | null;
}

export interface UnifiedTeamRegistryFile {
  readonly schemaVersion: number;
  readonly description?: string;
  readonly teams: readonly UnifiedTeamRecord[];
}

export interface UnifiedTeamEntity {
  readonly record: UnifiedTeamRecord;
  readonly allCodes: ReadonlySet<string>;
}

const DEFAULT_REGISTRY_PATH = resolve(
  import.meta.dir,
  "../data/unified_team_registry.json",
);

function normalizeToken(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

function looksLikeAbbreviation(token: string): boolean {
  return /^[A-Z0-9]{2,4}$/.test(token.trim());
}

function buildEntity(record: UnifiedTeamRecord): UnifiedTeamEntity {
  const allCodes = new Set<string>([record.code.toUpperCase()]);
  for (const list of [record.kalshiCodes, record.legacyCodes]) {
    if (list === undefined) continue;
    for (const entry of list) {
      const norm = entry.trim().toUpperCase();
      if (norm !== "") allCodes.add(norm);
    }
  }
  return { record, allCodes };
}

export class UnifiedTeamRegistry {
  private readonly byLeagueAndCode = new Map<string, UnifiedTeamEntity>();
  private readonly byLeagueAndName = new Map<string, UnifiedTeamEntity>();

  constructor(file: UnifiedTeamRegistryFile) {
    for (const team of file.teams) {
      const entity = buildEntity(team);
      const league = team.league;
      for (const code of entity.allCodes) {
        this.byLeagueAndCode.set(`${league}:${code}`, entity);
      }
      this.byLeagueAndName.set(
        `${league}:${normalizeToken(team.displayName)}`,
        entity,
      );
      for (const name of team.f402Names ?? []) {
        this.byLeagueAndName.set(`${league}:${normalizeToken(name)}`, entity);
      }
      for (const nick of team.nicknames ?? []) {
        this.byLeagueAndName.set(`${league}:${normalizeToken(nick)}`, entity);
      }
    }
  }

  resolve(league: League, token: string): UnifiedTeamEntity | null {
    const trimmed = token.trim();
    if (trimmed === "") return null;
    const upper = normalizeToken(trimmed);

    if (looksLikeAbbreviation(trimmed)) {
      return this.byLeagueAndCode.get(`${league}:${upper}`) ?? null;
    }

    const byFull = this.byLeagueAndName.get(`${league}:${upper}`);
    if (byFull !== undefined) return byFull;

    for (const [key, entity] of this.byLeagueAndName) {
      if (!key.startsWith(`${league}:`)) continue;
      if (upper.includes(key.slice(league.length + 1))) return entity;
      if (key.includes(upper)) return entity;
    }
    return null;
  }

  codesEquivalent(league: League, a: string, b: string): boolean {
    const left = a.trim().toUpperCase();
    const right = b.trim().toUpperCase();
    if (left === right) return true;
    const entityA = this.resolve(league, a);
    const entityB = this.resolve(league, b);
    if (entityA === null || entityB === null) return false;
    return entityA.record.id === entityB.record.id;
  }

  canonicalCode(league: League, token: string): string | null {
    return this.resolve(league, token)?.record.code ?? null;
  }

  kalshiCode(league: League, token: string): string | null {
    const entity = this.resolve(league, token);
    if (entity === null) return null;
    const preferred = entity.record.kalshiCodes?.[0];
    return preferred ?? entity.record.code;
  }

  polymarketHintsForCode(code: string): readonly string[] {
    const upper = code.trim().toUpperCase();
    for (const entity of this.byLeagueAndCode.values()) {
      if (entity.record.code.toUpperCase() === upper) {
        return entity.record.polymarketHints ?? [entity.record.displayName];
      }
    }
    return [];
  }

  normalizeTeamList(
    league: League,
    teams: readonly string[],
  ): readonly string[] {
    return teams.map((team) => this.canonicalCode(league, team) ?? normalizeToken(team));
  }

  normalizeSideTeam(
    league: League,
    sideTeam: string | null,
  ): string | null {
    if (sideTeam === null || sideTeam.trim() === "") return null;
    return this.canonicalCode(league, sideTeam) ?? normalizeToken(sideTeam);
  }
}

let cached: UnifiedTeamRegistry | null = null;

export function loadUnifiedTeamRegistry(
  path: string = DEFAULT_REGISTRY_PATH,
): UnifiedTeamRegistry {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as UnifiedTeamRegistryFile;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.teams)) {
    throw new Error(`Invalid unified team registry: ${path}`);
  }
  return new UnifiedTeamRegistry(parsed);
}

export function getUnifiedTeamRegistry(): UnifiedTeamRegistry {
  if (cached === null) {
    cached = loadUnifiedTeamRegistry();
  }
  return cached;
}

/** Reset cache (tests). */
export function resetUnifiedTeamRegistryCache(): void {
  cached = null;
}

export function unifiedTeamCodesMatch(
  league: League,
  a: string,
  b: string,
): boolean {
  return getUnifiedTeamRegistry().codesEquivalent(league, a, b);
}
