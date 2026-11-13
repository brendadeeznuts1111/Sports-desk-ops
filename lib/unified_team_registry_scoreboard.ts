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

const LIVE_BETS_LOGO_PATH = /images\/team-logos\/([^"\\?#]+?\.png)/i;
const COLLEGE_SUBSPORT = /college|ncaa/i;

export interface CollectLogoFilesOptions {
  /** Keep only files that appear in a game whose `subSport` marks it as college. */
  readonly collegeOnly?: boolean;
}

/**
 * Team-logo filenames referenced by live-bets `team.logoUrl` values, deduped.
 *
 * College is classified by the enclosing game's `subSport` (`College`, `NCAA`, `NCAAF Futures`),
 * not by filename shape: the CDN's `<City>-<Nickname>.png` convention is mostly pro but is not a
 * reliable discriminator, and `Arizona-Cardinals.png` would otherwise match CFB `Arizona`.
 */
export function collectLogoFilesFromLiveBets(
  liveBets: unknown,
  options: CollectLogoFilesOptions = {},
): string[] {
  const seen = new Map<string, boolean>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if ("team1" in record || "team2" in record) {
      const subSport = record["subSport"];
      const college =
        typeof subSport === "string" && COLLEGE_SUBSPORT.test(subSport);
      for (const slot of ["team1", "team2"] as const) {
        const team = record[slot];
        if (team === null || typeof team !== "object") continue;
        const url = (team as Record<string, unknown>)["logoUrl"];
        if (typeof url !== "string") continue;
        const match = LIVE_BETS_LOGO_PATH.exec(url);
        if (match === null) continue;
        const file = decodeURIComponent(match[1]!);
        seen.set(file, (seen.get(file) ?? false) || college);
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(liveBets);
  const files: string[] = [];
  for (const [file, college] of seen) {
    if (options.collegeOnly === true && !college) continue;
    files.push(file);
  }
  return files;
}

/**
 * Registry name key for logo-file matching. The CDN spells out `State` while the registry
 * abbreviates `St.`; expand the trailing `st` token so `Florida St.` matches
 * `Florida State Seminoles.png`. A leading `St.` (a saint) is left alone.
 */
function registryNameKey(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length > 0 && tokens[tokens.length - 1] === "st") {
    tokens[tokens.length - 1] = "state";
  }
  return tokens.join(" ");
}

export interface LogoFileMergeResult {
  readonly updated: number;
  /** Alias records that inherited a logo from another record with the same league+code. */
  readonly aliased: number;
  readonly total: number;
  readonly matched: readonly {
    readonly teamId: string;
    readonly logoFile: string;
  }[];
  readonly unmatchedFiles: readonly string[];
}

export interface LogoFileMergeOptions {
  /** Leagues a logo file may be attributed to. Defaults to CFB (college names are unique). */
  readonly leagues?: readonly League[];
  /** When false, resolve without writing the registry (dry run). */
  readonly write?: boolean;
}

/**
 * Attribute logo filenames to logo-less registry teams by name.
 *
 * The registry stores pro teams by city only (`Chicago`), so a filename such as
 * `Chicago-Bears.png` would be ambiguous across leagues; the default scope is therefore CFB,
 * where `School Mascot.png` names identify one team. Longest-name wins so `Florida St.` takes
 * `Florida State Seminoles.png` instead of `Florida`, and an unresolved or ambiguous file is
 * reported rather than guessed.
 */
export function mergeLogoFilesIntoRegistryFile(
  registryPath: string,
  logoFiles: readonly string[],
  options: LogoFileMergeOptions = {},
): LogoFileMergeResult {
  const leagues = new Set<League>(options.leagues ?? ["CFB"]);
  const registry = JSON.parse(
    readFileSync(registryPath, "utf8"),
  ) as UnifiedTeamRegistryFile;
  const assignments = new Map<string, string>();
  const matched: Array<{ teamId: string; logoFile: string }> = [];
  const unmatchedFiles: string[] = [];
  for (const file of logoFiles) {
    const stem = registryNameKey(file.replace(/\.png$/i, ""));
    if (stem === "") continue;
    // Rank over every team in scope, including those that already have a logo: a shorter
    // prefix must not win just because the longer match was filled on an earlier run
    // (`Penn State Nittany Lions.png` belongs to Penn St., never to Penn).
    const hits = registry.teams.filter((team) => {
      if (!leagues.has(team.league)) return false;
      const key = registryNameKey(team.displayName);
      return key !== "" && (stem === key || stem.startsWith(`${key} `));
    });
    if (hits.length === 0) {
      unmatchedFiles.push(file);
      continue;
    }
    const longest = Math.max(
      ...hits.map((team) => registryNameKey(team.displayName).length),
    );
    const top = hits.filter(
      (team) => registryNameKey(team.displayName).length === longest,
    );
    if (top.length !== 1) {
      unmatchedFiles.push(file);
      continue;
    }
    const team = top[0]!;
    if (team.portalLogoFile || assignments.has(team.id)) {
      unmatchedFiles.push(file);
      continue;
    }
    assignments.set(team.id, file);
    matched.push({ teamId: team.id, logoFile: file });
  }
  // The registry can hold two records for one franchise: a nickname record (with the logo) and
  // a city/code alias (without). A league+code pair is the same team, so a lone logo propagates;
  // conflicting logos are left alone rather than guessed.
  const grouped = new Map<string, UnifiedTeamRecord[]>();
  for (const team of registry.teams) {
    const key = `${team.league}:${team.code}`;
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [team]);
    else group.push(team);
  }
  const propagated = new Map<string, string>();
  for (const group of grouped.values()) {
    const logos = new Set<string>();
    for (const team of group) {
      const logo = assignments.get(team.id) ?? team.portalLogoFile ?? null;
      if (logo !== null) logos.add(logo);
    }
    if (logos.size !== 1) continue;
    const logo = logos.values().next().value;
    if (logo === undefined) continue;
    for (const team of group) {
      if (!team.portalLogoFile && !assignments.has(team.id)) {
        propagated.set(team.id, logo);
      }
    }
  }
  const teams =
    assignments.size === 0 && propagated.size === 0
      ? registry.teams
      : registry.teams.map((team) => {
          const logoFile = assignments.get(team.id) ?? propagated.get(team.id);
          return logoFile === undefined
            ? team
            : { ...team, portalLogoFile: logoFile };
        });
  if (options.write !== false) {
    writeFileSync(
      registryPath,
      `${JSON.stringify({ ...registry, teams }, null, 2)}\n`,
      "utf8",
    );
    resetUnifiedTeamRegistryCache();
  }
  return {
    updated: assignments.size,
    aliased: propagated.size,
    total: teams.length,
    matched,
    unmatchedFiles,
  };
}
