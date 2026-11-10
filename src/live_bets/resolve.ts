/**
 * @file resolve.ts
 * @description Single source-of-truth resolver for live-bets snapshots (`resolveLiveBets`),
 * replacing duplicated resolution across `deskLive` and legacy `loadLiveBetsFrom`.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { REPORT_PENDING_OPERATION } from "../../lib/f402_live_pending.ts";
import { wagerTypeLabel } from "../../lib/game_admin.ts";
import {
  buildArtifact,
  hierarchyIndexFromAgentIndex,
  summarizeAgents,
  summarizeGames,
  type AgentScope,
  type HierarchyIndex,
  type LiveBetGame,
  type LiveBetsArtifact,
} from "../../lib/live_bets.ts";
import {
  findScore,
  readScoreboardFile,
  summarizeScoreboard,
  type ScoreboardFile,
} from "../../lib/scoreboard.ts";
import {
  LIVE_FILTER,
  SPORT_CATEGORIES,
  sportCategoryFor,
  summarizeCategories,
} from "../../lib/sport_taxonomy.ts";
import {
  isLiveBetsFallback,
  isLiveBetsSource,
  type LiveBetsSource,
  type LiveBetsV2Game,
  type LiveBetsV2Request,
  type LiveBetsV2Response,
} from "../contracts/live_bets.v2.ts";

export const DEFAULT_LIVE_BETS_FILE = "data/live-bets.json";
export const DEFAULT_LIVE_BETS_SAMPLE_FIXTURE =
  "tests/f402-pending-wager-sample.json";
const DEFAULT_SCOREBOARD_FILE = "data/scoreboard.json";
const DEFAULT_AGENT_INDEX_FILE = "data/agent-index.json";

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, "../..");

export interface ResolveLiveBetsOptions {
  readonly repoRoot?: string | undefined;
  /** Server default file path when `req.path` is omitted (`<repoRoot>/data/live-bets.json`). */
  readonly defaultFilePath?: string | undefined;
  /** Sample fixture path used when `fallback === "sample"` (`<repoRoot>/tests/f402-pending-wager-sample.json`). */
  readonly sampleFixturePath?: string | undefined;
  /** Optional DB / live-store reader invoked when `req.source === "db"`. */
  readonly readDb?: (() => Promise<LiveBetsArtifact | null>) | undefined;
  /** Clock override for deterministic `provenance.generatedAt`. */
  readonly now?: (() => Date) | undefined;
  /** Preloaded scoreboard (pass `null` to skip file load; omit to load `<repoRoot>/data/scoreboard.json`). */
  readonly scoreboard?: ScoreboardFile | null | undefined;
}

interface ParsedSnapshot {
  readonly games: readonly LiveBetGame[];
  readonly agents: AgentScope;
  readonly pendingCount: number;
  readonly capturedAt: string | null;
  readonly summaryDataSource: string;
}

type FileLoadResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly hash: string;
      readonly snapshot: ParsedSnapshot;
    }
  | {
      readonly ok: false;
      readonly warning: string;
    };

const PARSED_CACHE_MAX = 32;
const parsedFileCache = new Map<string, ParsedSnapshot>();
const hierarchyCache = new Map<
  string,
  { readonly hash: string; readonly index: HierarchyIndex }
>();
const scoreboardCache = new Map<
  string,
  { readonly hash: string; readonly file: ScoreboardFile | null }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sha256Hex(input: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

function displayPathFor(absPath: string, repoRoot: string): string {
  const rel = relative(repoRoot, absPath);
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel.replaceAll("\\", "/");
  }
  return absPath;
}

function emptyAgentScope(): AgentScope {
  return summarizeAgents([]);
}

function normalizeAgentScope(raw: unknown): AgentScope {
  if (!isRecord(raw)) return emptyAgentScope();
  return {
    agents: Array.isArray(raw.agents)
      ? (raw.agents as AgentScope["agents"])
      : [],
    unresolved: Array.isArray(raw.unresolved)
      ? (raw.unresolved as AgentScope["unresolved"])
      : [],
    unassignedGames:
      typeof raw.unassignedGames === "number" ? raw.unassignedGames : 0,
    maxLevel: typeof raw.maxLevel === "number" ? raw.maxLevel : null,
    hierarchyLoaded: raw.hierarchyLoaded === true,
    collisions: Array.isArray(raw.collisions)
      ? (raw.collisions as AgentScope["collisions"])
      : [],
  };
}

async function loadHierarchyIndex(
  repoRoot: string,
): Promise<{ readonly hash: string; readonly index: HierarchyIndex } | null> {
  const indexPath = resolve(repoRoot, DEFAULT_AGENT_INDEX_FILE);
  const file = Bun.file(indexPath);
  if (!(await file.exists())) return null;
  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch {
    return null;
  }
  const hash = sha256Hex(bytes);
  const cached = hierarchyCache.get(indexPath);
  if (cached !== undefined && cached.hash === hash) return cached;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const entry = { hash, index: hierarchyIndexFromAgentIndex(parsed) };
    if (hierarchyCache.size >= PARSED_CACHE_MAX) hierarchyCache.clear();
    hierarchyCache.set(indexPath, entry);
    return entry;
  } catch {
    return null;
  }
}

async function resolveScoreboard(
  repoRoot: string,
  override: ScoreboardFile | null | undefined,
): Promise<ScoreboardFile | null> {
  if (override !== undefined) return override;
  const path = resolve(repoRoot, DEFAULT_SCOREBOARD_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch {
    return null;
  }
  const hash = sha256Hex(bytes);
  const cached = scoreboardCache.get(path);
  if (cached !== undefined && cached.hash === hash) return cached.file;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const board = readScoreboardFile(parsed);
    if (scoreboardCache.size >= PARSED_CACHE_MAX) scoreboardCache.clear();
    scoreboardCache.set(path, { hash, file: board });
    return board;
  } catch {
    return null;
  }
}

function isPendingEnvelopeOrRow(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return true;
  if (!isRecord(parsed)) return false;
  if (Array.isArray(parsed.Pending)) return true;
  if ("TicketNumber" in parsed || "ticketNumber" in parsed) return true;
  const result = parsed.result;
  return isRecord(result) && typeof result.preview === "string";
}

async function loadSnapshotFromFile(
  absPath: string,
  repoRoot: string,
  sourceKind: "file" | "fixture",
): Promise<FileLoadResult> {
  const shown = displayPathFor(absPath, repoRoot);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    return { ok: false, warning: `missing file: ${shown}` };
  }

  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch {
    return { ok: false, warning: `unreadable file: ${shown}` };
  }

  const hash = sha256Hex(bytes);
  const hierarchy = await loadHierarchyIndex(repoRoot);
  const cacheKey = `${absPath}|${sourceKind}|${hash}|${hierarchy?.hash ?? "none"}`;
  const hit = parsedFileCache.get(cacheKey);
  if (hit !== undefined) {
    return { ok: true, path: shown, hash, snapshot: hit };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, warning: `invalid JSON in ${shown}` };
  }

  if (isRecord(parsed) && Array.isArray(parsed.games)) {
    const games = parsed.games as LiveBetGame[];
    const pendingCount =
      typeof parsed.pendingCount === "number"
        ? parsed.pendingCount
        : games.length;
    const capturedAt =
      typeof parsed.capturedAt === "string" ? parsed.capturedAt : null;
    const summaryDataSource =
      typeof parsed.dataSource === "string" && parsed.dataSource !== ""
        ? parsed.dataSource
        : `${sourceKind}:${shown}`;
    const snapshot: ParsedSnapshot = {
      games,
      agents: normalizeAgentScope(parsed.agents),
      pendingCount,
      capturedAt,
      summaryDataSource,
    };
    if (parsedFileCache.size >= PARSED_CACHE_MAX) parsedFileCache.clear();
    parsedFileCache.set(cacheKey, snapshot);
    return { ok: true, path: shown, hash, snapshot };
  }

  if (isPendingEnvelopeOrRow(parsed)) {
    const { readPendingRows } = await import("../../lib/live_bets.ts");
    const rows = readPendingRows(parsed);
    const artifact = buildArtifact(rows, {
      operation: REPORT_PENDING_OPERATION,
      capturedAt: null,
      ...(hierarchy === null ? {} : { hierarchyIndex: hierarchy.index }),
    });
    const snapshot: ParsedSnapshot = {
      games: artifact.games,
      agents: artifact.agents,
      pendingCount: artifact.pendingCount,
      capturedAt: artifact.capturedAt,
      summaryDataSource:
        sourceKind === "fixture" ? `fixture:${shown}` : artifact.dataSource,
    };
    if (parsedFileCache.size >= PARSED_CACHE_MAX) parsedFileCache.clear();
    parsedFileCache.set(cacheKey, snapshot);
    return { ok: true, path: shown, hash, snapshot };
  }

  return { ok: false, warning: `unrecognized live-bets payload in ${shown}` };
}

function buildResponse(input: {
  readonly dataSource: LiveBetsSource;
  readonly fallbackUsed: boolean;
  readonly path: string | null;
  readonly hash: string | null;
  readonly generatedAt: string;
  readonly warnings: readonly string[];
  readonly snapshot: ParsedSnapshot;
  readonly scoreboard: ScoreboardFile | null;
}): LiveBetsV2Response {
  const { snapshot, scoreboard } = input;
  const withScores: LiveBetsV2Game[] = snapshot.games.map((game) => ({
    ...game,
    position: wagerTypeLabel(game.wagerType),
    category: sportCategoryFor({
      sportType: game.sport,
      sportSubType: game.subSport,
    }),
    scoreboard:
      scoreboard === null ||
      game.team1?.name == null ||
      game.team2?.name == null
        ? null
        : findScore(scoreboard, {
            team1: game.team1.name,
            team2: game.team2.name,
            league: game.subSport,
          }),
  }));

  const categories = summarizeCategories(
    withScores.map((game) => ({
      category: game.category,
      live: game.scoreboard?.status === "live",
    })),
  );

  const summary = summarizeGames(
    snapshot.games,
    snapshot.pendingCount,
    snapshot.summaryDataSource,
    snapshot.capturedAt,
  );

  return {
    apiVersion: "2",
    dataSource: input.dataSource,
    fallbackUsed: input.fallbackUsed,
    provenance: {
      path: input.path,
      hash: input.hash,
      generatedAt: input.generatedAt,
    },
    games: withScores,
    warnings: [...input.warnings],
    agents: snapshot.agents,
    pendingCount: summary.totalPending,
    summary,
    scoreboard:
      scoreboard === null
        ? null
        : {
            source: scoreboard.source,
            observedAt: scoreboard.observedAt,
            summary: summarizeScoreboard(scoreboard),
          },
    sports: {
      categories,
      all: SPORT_CATEGORIES,
      liveFilter: LIVE_FILTER,
    },
  };
}

function emptySnapshot(): ParsedSnapshot {
  return {
    games: [],
    agents: emptyAgentScope(),
    pendingCount: 0,
    capturedAt: null,
    summaryDataSource: "none",
  };
}

export async function resolveLiveBets(
  req: LiveBetsV2Request,
  options?: ResolveLiveBetsOptions,
): Promise<LiveBetsV2Response> {
  if (!isLiveBetsSource(req.source)) {
    throw new TypeError(
      `Invalid LiveBetsSource "${String(req.source)}"; expected db, file, fixture or none`,
    );
  }
  if (!isLiveBetsFallback(req.fallback)) {
    throw new TypeError(
      `Invalid LiveBetsFallback "${String(req.fallback)}"; expected strict or sample`,
    );
  }

  const repoRoot = resolve(options?.repoRoot ?? DEFAULT_REPO_ROOT);
  const defaultFileAbs = resolve(
    repoRoot,
    options?.defaultFilePath ?? DEFAULT_LIVE_BETS_FILE,
  );
  const sampleFixtureAbs = resolve(
    repoRoot,
    options?.sampleFixturePath ?? DEFAULT_LIVE_BETS_SAMPLE_FIXTURE,
  );
  const generatedAt = (options?.now?.() ?? new Date()).toISOString();
  const scoreboard = await resolveScoreboard(repoRoot, options?.scoreboard);

  if (req.source === "none") {
    return buildResponse({
      dataSource: "none",
      fallbackUsed: false,
      path: null,
      hash: null,
      generatedAt,
      warnings: ["no data"],
      snapshot: emptySnapshot(),
      scoreboard,
    });
  }

  if (req.source === "db") {
    const dbArtifact = options?.readDb ? await options.readDb() : null;
    if (dbArtifact !== null) {
      return buildResponse({
        dataSource: "db",
        fallbackUsed: false,
        path: null,
        hash: sha256Hex(JSON.stringify(dbArtifact)),
        generatedAt,
        warnings: [],
        snapshot: {
          games: [...dbArtifact.games],
          agents: dbArtifact.agents,
          pendingCount: dbArtifact.pendingCount,
          capturedAt: dbArtifact.capturedAt,
          summaryDataSource: dbArtifact.dataSource,
        },
        scoreboard,
      });
    }

    if (req.fallback === "strict") {
      return buildResponse({
        dataSource: "none",
        fallbackUsed: false,
        path: null,
        hash: null,
        generatedAt,
        warnings: ["no data", "db source unavailable"],
        snapshot: emptySnapshot(),
        scoreboard,
      });
    }

    const candidateAbs =
      req.path !== undefined && req.path.trim() !== ""
        ? resolve(repoRoot, req.path)
        : defaultFileAbs;
    const fileTry = await loadSnapshotFromFile(candidateAbs, repoRoot, "file");
    if (fileTry.ok) {
      return buildResponse({
        dataSource: "file",
        fallbackUsed: true,
        path: fileTry.path,
        hash: fileTry.hash,
        generatedAt,
        warnings: [`db source unavailable; fell back to ${fileTry.path}`],
        snapshot: fileTry.snapshot,
        scoreboard,
      });
    }

    const sampleTry = await loadSnapshotFromFile(
      sampleFixtureAbs,
      repoRoot,
      "fixture",
    );
    if (sampleTry.ok) {
      return buildResponse({
        dataSource: "fixture",
        fallbackUsed: true,
        path: sampleTry.path,
        hash: sampleTry.hash,
        generatedAt,
        warnings: [
          "db source unavailable",
          `${fileTry.warning}; fell back to ${sampleTry.path}`,
        ],
        snapshot: sampleTry.snapshot,
        scoreboard,
      });
    }

    return buildResponse({
      dataSource: "none",
      fallbackUsed: false,
      path: null,
      hash: null,
      generatedAt,
      warnings: [
        "no data",
        "db source unavailable",
        fileTry.warning,
        sampleTry.warning,
      ],
      snapshot: emptySnapshot(),
      scoreboard,
    });
  }

  // `source === "file"` or `source === "fixture"`
  const primaryAbs =
    req.path !== undefined && req.path.trim() !== ""
      ? resolve(repoRoot, req.path)
      : req.source === "fixture"
        ? sampleFixtureAbs
        : defaultFileAbs;

  const primary = await loadSnapshotFromFile(primaryAbs, repoRoot, req.source);
  if (primary.ok) {
    return buildResponse({
      dataSource: req.source,
      fallbackUsed: false,
      path: primary.path,
      hash: primary.hash,
      generatedAt,
      warnings: [],
      snapshot: primary.snapshot,
      scoreboard,
    });
  }

  if (req.fallback === "strict" || primaryAbs === sampleFixtureAbs) {
    return buildResponse({
      dataSource: "none",
      fallbackUsed: false,
      path: null,
      hash: null,
      generatedAt,
      warnings: ["no data", primary.warning],
      snapshot: emptySnapshot(),
      scoreboard,
    });
  }

  const sample = await loadSnapshotFromFile(
    sampleFixtureAbs,
    repoRoot,
    "fixture",
  );
  if (sample.ok) {
    return buildResponse({
      dataSource: "fixture",
      fallbackUsed: true,
      path: sample.path,
      hash: sample.hash,
      generatedAt,
      warnings: [`${primary.warning}; fell back to ${sample.path}`],
      snapshot: sample.snapshot,
      scoreboard,
    });
  }

  return buildResponse({
    dataSource: "none",
    fallbackUsed: false,
    path: null,
    hash: null,
    generatedAt,
    warnings: ["no data", primary.warning, sample.warning],
    snapshot: emptySnapshot(),
    scoreboard,
  });
}
