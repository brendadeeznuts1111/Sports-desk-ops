/**
 * Merge portal scoreboard nicknames + logo filenames into the unified team registry.
 */
// Sync registry maintenance script: it reads and rewrites one committed JSON file.
// ast-grep-ignore: node-fs-read-write-file
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { League } from "./watchlist_signal_engine.ts";
import type {
  UnifiedTeamRecord,
  UnifiedTeamRegistryFile,
} from "./unified_team_registry.ts";
import { resetUnifiedTeamRegistryCache } from "./unified_team_registry.ts";

const SCOREBOARD_LEAGUE: Readonly<Record<string, League | null>> = {
  NFL: "NFL",
  NBA: "NBA",
  NHL: "NHL",
  MLB: "MLB",
  NCAA: null,
};

/** Nickname → canonical code (scoreboard `team.name` column). */
const NICKNAME_CODE: Readonly<
  Record<League, Readonly<Record<string, string>>>
> = {
  NFL: {
    Vikings: "MIN",
    Lions: "DET",
    Raiders: "LV",
    Jets: "NYJ",
    Cardinals: "ARI",
    Cowboys: "DAL",
    Falcons: "ATL",
    Buccaneers: "TB",
    Ravens: "BAL",
    Bills: "BUF",
    Colts: "IND",
    Jaguars: "JAX",
    Titans: "TEN",
    Bengals: "CIN",
    Browns: "CLE",
    Steelers: "PIT",
    Chargers: "LAC",
    Rams: "LAR",
    Chiefs: "KC",
    Broncos: "DEN",
    Patriots: "NE",
    Dolphins: "MIA",
    Eagles: "PHI",
    Commanders: "WAS",
  },
  NBA: {
    Celtics: "BOS",
    Magic: "ORL",
    Nets: "BKN",
    Pacers: "IND",
    Clippers: "LAC",
    Warriors: "GSW",
    Raptors: "TOR",
    Lakers: "LAL",
  },
  NHL: {
    Jets: "WPG",
    Hurricanes: "CAR",
    Wild: "MIN",
    Capitals: "WSH",
    Oilers: "EDM",
    Rangers: "NYR",
    Senators: "OTT",
    Ducks: "ANA",
  },
  MLB: {},
  CFB: {},
  EPL: {},
  UNKNOWN: {},
};

function logoToDisplayName(logoFile: string, nickname: string): string {
  const stem = logoFile.replace(/\.png$/i, "").replace(/_/g, " ");
  if (stem.includes("-")) {
    return stem.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  }
  return nickname.trim();
}

function slugId(league: League, nickname: string): string {
  return `${league.toLowerCase()}:${nickname.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

export interface ScoreboardSyncResult {
  readonly added: number;
  readonly updated: number;
  readonly skipped: number;
  readonly total: number;
}

export function mergeScoreboardIntoRegistryFile(
  registryPath: string,
  scoreboardPath: string,
): ScoreboardSyncResult {
  const registry = JSON.parse(
    readFileSync(registryPath, "utf8"),
  ) as UnifiedTeamRegistryFile;
  const scoreboard = JSON.parse(readFileSync(scoreboardPath, "utf8")) as {
    games?: readonly {
      league?: string;
      team1?: { name?: string; logo?: string };
      team2?: { name?: string; logo?: string };
    }[];
  };

  const byId = new Map<string, UnifiedTeamRecord>();
  for (const team of registry.teams) {
    byId.set(team.id, { ...team });
  }
  const byCode = new Map<string, UnifiedTeamRecord>();
  for (const team of registry.teams) {
    byCode.set(`${team.league}:${team.code}`, team);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const game of scoreboard.games ?? []) {
    const league = SCOREBOARD_LEAGUE[game.league ?? ""] ?? null;
    if (league === null) continue;
    for (const slot of [game.team1, game.team2]) {
      if (slot === undefined) continue;
      const nickname = (slot.name ?? "").trim();
      const logo = (slot.logo ?? "").trim();
      if (nickname === "") {
        skipped += 1;
        continue;
      }
      const code = NICKNAME_CODE[league][nickname];
      if (code === undefined) {
        skipped += 1;
        continue;
      }
      const id = slugId(league, nickname);
      const displayName =
        logo !== "" ? logoToDisplayName(logo, nickname) : nickname;
      const existing = byId.get(id) ?? byCode.get(`${league}:${code}`);
      if (existing !== undefined) {
        const merged: UnifiedTeamRecord = {
          ...existing,
          nicknames: Array.from(
            new Set([...(existing.nicknames ?? []), nickname]),
          ),
          portalLogoFile:
            logo !== "" ? logo : (existing.portalLogoFile ?? null),
        };
        byId.set(existing.id, merged);
        updated += 1;
      } else {
        const record: UnifiedTeamRecord = {
          id,
          league,
          code,
          displayName,
          nicknames: [nickname],
          portalLogoFile: logo !== "" ? logo : null,
          polymarketHints: [
            displayName.split(" ").slice(-1)[0] ?? nickname,
            displayName,
          ],
        };
        byId.set(id, record);
        byCode.set(`${league}:${code}`, record);
        added += 1;
      }
    }
  }

  const teams = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const next: UnifiedTeamRegistryFile = {
    ...registry,
    teams,
  };
  writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  resetUnifiedTeamRegistryCache();
  return { added, updated, skipped, total: teams.length };
}

export function defaultScoreboardSyncPaths(repoRoot: string): {
  registryPath: string;
  scoreboardPath: string;
} {
  return {
    registryPath: resolve(repoRoot, "data/unified_team_registry.json"),
    scoreboardPath: resolve(repoRoot, "data/scoreboard.json"),
  };
}
