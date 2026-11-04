/**
 * @file lib/combo_uniqueness.ts
 * @description CFB combo uniqueness: per-game distinct combos and wallets, seeded from public
 * CFB trades + the Polymarket leaderboard, with a TTL cache and an optional strict mode.
 *
 * Public APIs only. Combo discovery is user-anchored: no global CFB combo feed was exposed by the
 * probed endpoints (`[UNVERIFIED]` for any endpoint added later).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CFB_SERIES_ID, GAMMA_API } from "./polymarket_combo.ts";

export const DEFAULT_CACHE_TTL_HOURS = 24;
const ELIGIBLE_LEG_TYPES = new Set(["moneyline", "spreads", "totals"]);

export interface ComboUniquenessOptions {
  readonly fetchImpl?: typeof fetch;
  readonly concurrency?: number;
  readonly cacheDir?: string;
  readonly cacheTtlHours?: number;
  /** Cache the CFB event index on disk. Off by default; `offline` implies it. */
  readonly cacheGames?: boolean;
  /** Read the event index only from cache and fail instead of fetching. */
  readonly offline?: boolean;
  readonly fresh?: boolean;
  readonly leaderboard?: boolean;
  readonly leaderboardLimit?: number;
  readonly walletFile?: string;
  readonly strictFullGame?: boolean;
  /** Explicit gate; overrides `strictFullGame`. */
  readonly gate?: ComboGate;
  /** Include the per-combo audit trail in the report (default true). */
  readonly includeAudit?: boolean;
  readonly seedTrades?: boolean;
  readonly maxSeedMarkets?: number;
  readonly perMarket?: number;
  readonly maxComboPages?: number;
  readonly limitGames?: number;
  /** Also index settled CFB events (`closed=true`). Default true; pass false for open-only. */
  readonly includeClosedGames?: boolean;
  /** Keep only games on/after this ISO date (e.g. `2026-09-01`). */
  readonly since?: string;
  /** Safety cap on paginated event fetches (default 30 pages × 100). */
  readonly maxGamePages?: number;
  readonly now?: number;
  readonly timeoutMs?: number;
  readonly gammaBase?: string;
  readonly dataBase?: string;
}

interface CacheFile {
  readonly schemaVersion: 1;
  readonly fetchedAtIso: string;
  readonly records: readonly unknown[];
}

export interface ComboGameStats {
  readonly gameSlug: string;
  readonly title: string;
  readonly volume24hr: number;
  readonly uniqueCombos: number;
  readonly uniqueWallets: number;
  readonly fullyWithinGame: number;
  readonly samples: readonly {
    readonly comboId: string;
    readonly wallet: string;
    readonly legs: number;
    readonly games: number;
  }[];
}

export type ComboGate = "permissive" | "all-legs-cfb" | "full-game";

export type StrictDropReason =
  "UNRESOLVED_LEGS" | "CROSS_GAME" | "INELIGIBLE_LEG_TYPE";

export interface ComboAuditRow {
  readonly comboId: string;
  readonly wallet: string;
  readonly legs: number;
  readonly games: number;
  readonly allLegsCfb: boolean;
  readonly fullyWithinGame: boolean;
  readonly allCfbLegsEligible: boolean;
  /** False only under a gated mode; permissive attribution is mode-independent. */
  readonly kept: boolean;
  readonly dropReason: StrictDropReason | null;
  /** Leg keys that failed to resolve to any CFB game. */
  readonly unresolvedLegKeys: readonly string[];
}

export interface ComboUniquenessReport {
  readonly gate: ComboGate;
  /** Back-compat: true only for `full-game`. */
  readonly strictFullGame: boolean;
  readonly index: {
    readonly games: number;
    readonly activeOnly: boolean;
    readonly since: string | null;
  };
  readonly games: readonly ComboGameStats[];
  readonly global: {
    readonly gamesWithActivity: number;
    readonly sumPerGameCombos: number;
    readonly sumPerGameWallets: number;
    readonly distinctCombos: number;
    readonly distinctWallets: number;
  };
  readonly walletsScanned: number;
  readonly comboRecords: number;
  /** Distinct combos before the strict gate; `strict` is always a subset of this. */
  readonly permissiveCombos: number;
  /** Records collapsed by the `comboId|wallet` or `legKeys|wallet` dedupe passes. */
  readonly duplicatesCollapsed: number;
  readonly duplicatesCollapsedById: number;
  /** Non-zero proves the cross-indexer leg-set pass is doing work. */
  readonly duplicatesCollapsedByLegSet: number;
  /** Why the active gate dropped a combo. Sum equals `permissiveCombos - comboRecords`. */
  readonly exclusions: Readonly<Record<StrictDropReason, number>>;
  /** Kept combos that span more than one game. Admitted by `permissive` and `all-legs-cfb`. */
  readonly includedCrossGame: number;
  readonly diagnostics: {
    /** Legs with no outcome/side; such rows cannot match a sided source. */
    readonly legsWithoutSide: number;
    readonly legsWithoutStableId: number;
    readonly combosWithUnstableIdentity: number;
    /** Resolution gap: which permissive combos die on legs that match no indexed CFB game. */
    readonly unresolved: {
      readonly combos: number;
      readonly legs: number;
      readonly distinctLegKeys: number;
      /** Leg keys seen in exactly one combo (long tail). */
      readonly oneOffLegKeys: number;
      /** Leg keys seen in two or more combos (systemic). */
      readonly systemicLegKeys: number;
      readonly top: readonly {
        readonly legKey: string;
        readonly combos: number;
      }[];
    };
    /** Combos with legs that resolved to **zero** indexed games; they never reach the report. */
    readonly combosWithoutAttribution: number;
    readonly recordsWithoutLegs: number;
    /** Share of observed combos that touch an indexed CFB game. Non-CFB combos are in the denominator. */
    readonly cfbTouchRatePct: number;
    /** Unresolved leg keys shaped like zero-padded combo conditions (no CLOB market). */
    readonly suspectedComboOfComboLegKeys: number;
  };
  /** Sorted, unique wallets scanned — the input for `--dump-wallets`. */
  readonly wallets: readonly string[];
  /** Per-combo audit trail; empty under `--json` only if `includeAudit: false`. */
  readonly combos: readonly ComboAuditRow[];
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly ttlHours: number;
  };
}

interface CfbGame {
  readonly slug: string;
  readonly title: string;
  readonly volume24hr: number;
  readonly endIso: string | null;
  readonly conditionIds: readonly string[];
  readonly marketSlugs: readonly string[];
  readonly clobTokenIds: readonly string[];
}

interface NormalizedCombo {
  readonly comboId: string;
  readonly wallet: string;
  readonly gameSlugs: ReadonlySet<string>;
  readonly legKeys: readonly string[];
  /** `legKey|outcome|marketType` — distinguishes legs that share a condition id. */
  readonly legSignatures: readonly string[];
  /** Legs with no outcome/side token; those rows cannot dedupe against a sided source. */
  readonly legsWithoutSide: number;
  /** Legs whose identity fell back to `JSON.stringify(leg)`. */
  readonly unstableLegs: number;
  readonly allLegsCfb: boolean;
  readonly allCfbLegsEligible: boolean;
  readonly fullyWithinGame: boolean;
  /** `legKey` of every leg that could not be attributed to a CFB game. */
  readonly unresolvedLegKeys: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((entry) => text(entry)).filter(Boolean);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((entry) => text(entry)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function getJson(
  url: string,
  options?: ComboUniquenessOptions,
): Promise<unknown> {
  const response = await (options?.fetchImpl ?? fetch)(url, {
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
  } as RequestInit);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

interface EventCacheFile {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly fetchedAtIso: string;
  readonly payload: unknown;
}

/**
 * Disk cache for the paginated CFB event index.
 *
 * Off unless `cacheGames`/`offline` is set, because the CLI's default is a fresh index per run.
 * `offline` ignores the TTL and throws when a page is missing, rather than silently returning a
 * partial index: a short index would look like fewer games, not like a failed fetch.
 */
async function cachedEvents(
  url: string,
  options?: ComboUniquenessOptions,
): Promise<unknown> {
  const dir = options?.cacheDir ?? "scratch/cfb-combo-cache";
  await mkdir(dir, { recursive: true });
  const key = new Bun.CryptoHasher("sha256").update(url).digest("hex");
  const path = join(dir, `events-${key}.json`);
  const offline = options?.offline === true;

  if (options?.fresh !== true) {
    try {
      const parsed = (await Bun.file(path).json()) as Partial<EventCacheFile>;
      if (parsed.schemaVersion === 1 && parsed.url === url) {
        const fetchedAt = Date.parse(parsed.fetchedAtIso ?? "");
        const ttl = cacheTtlMs(options);
        const age = (options?.now ?? Date.now()) - fetchedAt;
        if (offline || (Number.isFinite(fetchedAt) && ttl > 0 && age <= ttl)) {
          return parsed.payload;
        }
      }
    } catch {
      // fall through to fetch or to the offline error
    }
  }

  if (offline) throw new Error(`offline: no cached events for ${url}`);

  const payload = await getJson(url, options);
  const file: EventCacheFile = {
    schemaVersion: 1,
    url,
    fetchedAtIso: new Date(options?.now ?? Date.now()).toISOString(),
    payload,
  };
  await writeFile(path, `${JSON.stringify(file)}\n`, "utf8");
  return payload;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // eslint-disable-next-line unicorn/no-new-array -- dense preallocation filled by index
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length || 1) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Loads CFB events and indexes their condition IDs, slugs and CLOB token IDs. */
export async function loadCfbGames(
  options?: ComboUniquenessOptions,
): Promise<CfbGame[]> {
  const gamma = (options?.gammaBase ?? GAMMA_API).replace(/\/$/, "");
  const since = options?.since ?? null;
  const sources: Array<"active" | "closed"> =
    options?.includeClosedGames === false ? ["active"] : ["active", "closed"];
  const useCache = options?.cacheGames === true || options?.offline === true;

  const games: CfbGame[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const pageSize = 100;
    const maxPages = Math.max(1, options?.maxGamePages ?? 30);
    for (let page = 0; page < maxPages; page += 1) {
      const ordering =
        source === "active"
          ? "active=true&closed=false&order=volume24hr&ascending=false"
          : "closed=true&order=endDate&ascending=false";
      const url = `${gamma}/events?series_id=${CFB_SERIES_ID}&${ordering}&limit=${pageSize}&offset=${page * pageSize}`;
      const body = useCache
        ? await cachedEvents(url, options)
        : await getJson(url, options);
      if (!Array.isArray(body) || body.length === 0) break;
      for (const game of mapCfbEvents(body)) {
        if (
          since !== null &&
          (game.endIso === null || game.endIso.slice(0, 10) < since)
        )
          continue;
        if (seen.has(game.slug)) continue;
        seen.add(game.slug);
        games.push(game);
      }
      if (body.length < pageSize) break;
    }
  }

  const cap = options?.limitGames ?? 0;
  return cap > 0 ? games.slice(0, cap) : games;
}

function mapCfbEvents(body: readonly unknown[]): CfbGame[] {
  return body
    .map((raw): CfbGame | null => {
      const event = asRecord(raw);
      if (event === null) return null;
      const slug = text(event.slug);
      if (slug === "") return null;
      const markets = Array.isArray(event.markets) ? event.markets : [];
      const conditionIds: string[] = [];
      const marketSlugs: string[] = [];
      const tokenIds: string[] = [];
      for (const candidate of markets) {
        const market = asRecord(candidate);
        if (market === null) continue;
        const conditionId = text(market.conditionId);
        if (conditionId !== "") conditionIds.push(conditionId.toLowerCase());
        const marketSlug = text(market.slug);
        if (marketSlug !== "") marketSlugs.push(marketSlug);
        tokenIds.push(...jsonArray(market.clobTokenIds));
      }
      const endIso = text(event.endDate) || text(event.startTime) || null;
      return {
        slug,
        title: text(event.title),
        volume24hr: Number(event.volume24hr) || 0,
        conditionIds,
        marketSlugs,
        clobTokenIds: tokenIds,
        endIso,
      };
    })
    .filter((game): game is CfbGame => game !== null);
}

interface GameIndex {
  readonly byConditionId: Map<string, string>;
  readonly byMarketSlug: Map<string, string>;
  readonly byTokenId: Map<string, string>;
}

export function buildGameIndex(games: readonly CfbGame[]): GameIndex {
  const byConditionId = new Map<string, string>();
  const byMarketSlug = new Map<string, string>();
  const byTokenId = new Map<string, string>();
  for (const game of games) {
    for (const id of game.conditionIds) byConditionId.set(id, game.slug);
    for (const slug of game.marketSlugs) byMarketSlug.set(slug, game.slug);
    for (const token of game.clobTokenIds) byTokenId.set(token, game.slug);
  }
  return { byConditionId, byMarketSlug, byTokenId };
}

function legConditionIds(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = text(leg.leg_condition_id) || text(leg.conditionId);
  if (direct !== "") out.push(direct.toLowerCase());
  const market = asRecord(leg.market);
  if (market !== null) {
    const nested = text(market.condition_id) || text(market.conditionId);
    if (nested !== "") out.push(nested.toLowerCase());
  }
  return out;
}

function legMarketSlugs(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const market = leg.market;
  if (typeof market === "string" && market !== "") out.push(market);
  const direct = text(leg.marketSlug);
  if (direct !== "") out.push(direct);
  const nested = asRecord(market);
  if (nested !== null) {
    const slug = text(nested.slug) || text(nested.market_slug);
    if (slug !== "") out.push(slug);
  }
  return out;
}

function legTokenIds(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = text(leg.clobTokenId) || text(leg.tokenId);
  if (direct !== "") out.push(direct);
  return out;
}

function legMarketType(leg: Record<string, unknown>): string {
  const market = asRecord(leg.market);
  return (
    text(market?.sports_market_type) ||
    text(market?.sportsMarketType) ||
    text(leg.sports_market_type) ||
    text(leg.sportsMarketType) ||
    text(leg.market_type)
  ).toLowerCase();
}

function legKey(leg: Record<string, unknown>): string {
  return (
    text(leg.leg_condition_id) ||
    text(leg.conditionId) ||
    text(asRecord(leg.market)?.condition_id) ||
    text(asRecord(leg.market)?.conditionId) ||
    text(leg.clobTokenId) ||
    text(leg.tokenId) ||
    text(leg.marketSlug) ||
    (typeof leg.market === "string" ? leg.market : "") ||
    text(asRecord(leg.market)?.slug) ||
    text(asRecord(leg.market)?.market_slug) ||
    text(leg.symbol) ||
    JSON.stringify(leg)
  ).toLowerCase();
}

/**
 * Dedupe signature for a single leg. `legKey` alone is too coarse: two combos can reference the
 * same condition id on different outcomes or market types (moneyline vs player_props).
 */
function legSignature(leg: Record<string, unknown>): string {
  const outcome = legOutcome(leg);
  return `${legKey(leg)}|${outcome}|${legMarketType(leg)}`;
}

function legOutcome(leg: Record<string, unknown>): string {
  return (
    text(leg.leg_outcome_label) ||
    text(leg.outcome) ||
    text(leg.leg_outcome)
  ).toUpperCase();
}

/** A stable id is anything but the `JSON.stringify` fallback in `legKey`. */
function hasStableLegId(leg: Record<string, unknown>): boolean {
  return !legKey(leg).startsWith("{");
}

function attributeLeg(
  leg: Record<string, unknown>,
  index: GameIndex,
): { game: string | null; type: string } {
  for (const id of legConditionIds(leg)) {
    const game = index.byConditionId.get(id);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  for (const slug of legMarketSlugs(leg)) {
    const game = index.byMarketSlug.get(slug);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  for (const token of legTokenIds(leg)) {
    const game = index.byTokenId.get(token);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  return { game: null, type: legMarketType(leg) };
}

type NormalizeResult =
  | { readonly ok: true; readonly combo: NormalizedCombo }
  | { readonly ok: false; readonly reason: "NO_LEGS" | "NO_ATTRIBUTION" };

function normalizeCombo(
  raw: unknown,
  fallbackWallet: string,
  index: GameIndex,
): NormalizeResult {
  const record = asRecord(raw);
  if (record === null) return { ok: false, reason: "NO_LEGS" };
  const legsRaw = Array.isArray(record.legs)
    ? record.legs
    : Array.isArray(record.components)
      ? record.components
      : [];
  if (legsRaw.length === 0) return { ok: false, reason: "NO_LEGS" };
  const legs = legsRaw
    .map(asRecord)
    .filter((leg): leg is Record<string, unknown> => leg !== null);
  if (legs.length === 0) return { ok: false, reason: "NO_LEGS" };

  const games = new Set<string>();
  const unresolvedLegKeys: string[] = [];
  let attributed = 0;
  let eligible = true;
  for (const leg of legs) {
    const result = attributeLeg(leg, index);
    if (result.game === null) {
      unresolvedLegKeys.push(legKey(leg));
      continue;
    }
    attributed += 1;
    games.add(result.game);
    if (!ELIGIBLE_LEG_TYPES.has(result.type)) eligible = false;
  }
  if (games.size === 0) return { ok: false, reason: "NO_ATTRIBUTION" };

  const legKeys = legs.map(legKey).sort();
  const legSignatures = legs.map(legSignature).sort();
  const comboId =
    text(record.comboId) ||
    text(record.id) ||
    `sha256:${hashKeys(legSignatures)}`;
  const wallet = (
    text(record.user) ||
    text(record.wallet) ||
    fallbackWallet
  ).toLowerCase();
  return {
    ok: true,
    combo: {
      comboId,
      wallet,
      gameSlugs: games,
      legKeys,
      legSignatures,
      legsWithoutSide: legs.filter((leg) => legOutcome(leg) === "").length,
      unstableLegs: legs.filter((leg) => !hasStableLegId(leg)).length,
      allLegsCfb: attributed === legs.length,
      allCfbLegsEligible: eligible,
      fullyWithinGame: games.size === 1,
      unresolvedLegKeys,
    },
  };
}

function hashKeys(keys: readonly string[]): string {
  return new Bun.CryptoHasher("sha256").update(keys.join("|")).digest("hex");
}

/** Zero-padded condition ids look like combo conditions; CLOB answers 404 for them. */
function looksLikeComboCondition(key: string): boolean {
  return /^0x[0-9a-f]{40,}0{16,}$/.test(key);
}

/** Seeds wallets from public CFB trades (one request per sampled market). */
export async function seedWalletsFromTrades(
  games: readonly CfbGame[],
  options?: ComboUniquenessOptions,
): Promise<Set<string>> {
  const maxMarkets = options?.maxSeedMarkets ?? 60;
  const perMarket = options?.perMarket ?? 100;
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(
    /\/$/,
    "",
  );
  const ids = [...new Set(games.flatMap((game) => game.conditionIds))].slice(
    0,
    maxMarkets,
  );
  const wallets = new Set<string>();
  await mapLimit(ids, options?.concurrency ?? 6, async (conditionId) => {
    try {
      const body = await getJson(
        `${data}/trades?market=${encodeURIComponent(conditionId)}&limit=${perMarket}`,
        options,
      );
      if (!Array.isArray(body)) return;
      for (const raw of body) {
        const row = asRecord(raw);
        if (row === null) continue;
        const wallet =
          text(row.proxyWallet) ||
          text(row.wallet) ||
          text(row.maker) ||
          text(row.taker) ||
          text(row.user);
        if (/^0x[0-9a-fA-F]{40}$/.test(wallet))
          wallets.add(wallet.toLowerCase());
      }
    } catch {
      // a market with no trades is normal
    }
  });
  return wallets;
}

/** Seeds wallets from the v2 leaderboard (week/month/all, PnL-sorted). */
export async function seedWalletsFromLeaderboard(
  options?: ComboUniquenessOptions,
): Promise<Set<string>> {
  const wallets = new Set<string>();
  const limit = options?.leaderboardLimit ?? 100;
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(
    /\/$/,
    "",
  );
  for (const period of ["week", "month", "all"] as const) {
    try {
      const body = await getJson(
        `${data}/v2/leaderboard?time_period=${period}&sort_by=PNL&limit=${limit}`,
        options,
      );
      const rows = Array.isArray(asRecord(body)?.data)
        ? (asRecord(body)!.data as unknown[])
        : [];
      for (const raw of rows) {
        const wallet = text(asRecord(raw)?.user_id);
        if (/^0x[0-9a-fA-F]{40}$/.test(wallet))
          wallets.add(wallet.toLowerCase());
      }
    } catch {
      // leaderboard is a best-effort seed
    }
  }
  return wallets;
}

function cacheTtlMs(options?: ComboUniquenessOptions): number {
  const hours = options?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;
  return Math.max(0, hours) * 3_600_000;
}

async function readCache(
  path: string,
  options?: ComboUniquenessOptions,
): Promise<readonly unknown[] | null> {
  if (options?.fresh === true) return null;
  try {
    const parsed = (await Bun.file(path).json()) as Partial<CacheFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records))
      return null;
    const fetchedAt = Date.parse(parsed.fetchedAtIso ?? "");
    if (!Number.isFinite(fetchedAt)) return null;
    // TTL applies in offline mode too: `offline` only switches fetch behavior (fail instead
    // of network when a page is missing), it must not turn a stale cache into a fresh hit.
    const ttl = cacheTtlMs(options);
    if (ttl === 0) return null;
    if ((options?.now ?? Date.now()) - fetchedAt > ttl) return null;
    return parsed.records;
  } catch {
    return null;
  }
}

async function fetchCombosUncached(
  wallet: string,
  options?: ComboUniquenessOptions,
): Promise<unknown[]> {
  const maxPages = Math.max(1, options?.maxComboPages ?? 3);
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(
    /\/$/,
    "",
  );
  const records: unknown[] = [];
  for (const path of ["/v2/activity/combos", "/v2/positions/combos"]) {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const suffix =
        cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      try {
        const body = await getJson(
          `${data}${path}?user=${wallet}&limit=500${suffix}`,
          options,
        );
        const record = asRecord(body);
        const pageRows = Array.isArray(record?.data)
          ? (record.data as unknown[])
          : [];
        records.push(...pageRows);
        const next = text(asRecord(record?.pagination)?.next_cursor);
        if (pageRows.length === 0 || next === "") break;
        cursor = next;
      } catch {
        break;
      }
    }
  }
  return records;
}

async function cachedCombos(
  wallet: string,
  options: ComboUniquenessOptions | undefined,
  stats: { hits: number; misses: number },
): Promise<unknown[]> {
  const dir = options?.cacheDir ?? "scratch/cfb-combo-cache";
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${wallet}.json`);
  const cached = await readCache(path, options);
  if (cached !== null) {
    stats.hits += 1;
    return [...cached];
  }
  if (options?.offline === true) {
    throw new Error(`offline: no cached combos for ${wallet}`);
  }
  stats.misses += 1;
  const records = await fetchCombosUncached(wallet, options);
  const payload: CacheFile = {
    schemaVersion: 1,
    fetchedAtIso: new Date(options?.now ?? Date.now()).toISOString(),
    records,
  };
  await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
  return records;
}

export async function buildComboUniquenessReport(
  options?: ComboUniquenessOptions,
): Promise<ComboUniquenessReport> {
  const games = await loadCfbGames(options);
  const index = buildGameIndex(games);

  const wallets = new Set<string>();
  if (options?.leaderboard !== false) {
    for (const wallet of await seedWalletsFromLeaderboard(options))
      wallets.add(wallet);
  }
  if (options?.seedTrades === true) {
    for (const wallet of await seedWalletsFromTrades(games, options))
      wallets.add(wallet);
  }
  if (options?.walletFile !== undefined) {
    try {
      const file = await readFile(options.walletFile, "utf8");
      for (const candidate of file.split(/\s+/)) {
        if (/^0x[0-9a-fA-F]{40}$/.test(candidate))
          wallets.add(candidate.toLowerCase());
      }
    } catch {
      // missing wallet file is not fatal
    }
  }

  const stats = { hits: 0, misses: 0 };
  let recordsWithoutLegs = 0;
  let combosWithoutAttribution = 0;
  const perWallet = await mapLimit(
    [...wallets],
    options?.concurrency ?? 6,
    async (wallet) => {
      const records = await cachedCombos(wallet, options, stats);
      const combos: NormalizedCombo[] = [];
      for (const record of records) {
        const result = normalizeCombo(record, wallet, index);
        if (result.ok) {
          combos.push(result.combo);
        } else if (result.reason === "NO_ATTRIBUTION") {
          combosWithoutAttribution += 1;
        } else {
          recordsWithoutLegs += 1;
        }
      }
      return combos;
    },
  );

  const gate: ComboGate =
    options?.gate ??
    (options?.strictFullGame === true ? "full-game" : "permissive");
  const strict = gate === "full-game";

  // Two dedupe passes, in order of certainty:
  //   1. `comboId|wallet` — the upstream identity when it exists.
  //   2. `legKeys|wallet` — cross-indexer fallback: the same combo surfaced by two endpoints
  //      can carry different ids, but its resolved leg set and wallet are the same.
  const seenIds = new Set<string>();
  const seenLegSets = new Set<string>();
  const dedupedAll: NormalizedCombo[] = [];
  let duplicatesCollapsedById = 0;
  let duplicatesCollapsedByLegSet = 0;
  for (const combo of perWallet.flat()) {
    const idKey = `${combo.comboId}|${combo.wallet}`;
    const legKey = `${combo.legSignatures.join(";")}|${combo.wallet}`;
    if (seenIds.has(idKey)) {
      duplicatesCollapsedById += 1;
      continue;
    }
    if (seenLegSets.has(legKey)) {
      duplicatesCollapsedByLegSet += 1;
      continue;
    }
    seenIds.add(idKey);
    seenLegSets.add(legKey);
    dedupedAll.push(combo);
  }
  const duplicatesCollapsed =
    duplicatesCollapsedById + duplicatesCollapsedByLegSet;
  const unresolvedByKey = new Map<string, number>();
  let unresolvedCombos = 0;
  let unresolvedLegs = 0;
  for (const combo of dedupedAll) {
    if (combo.unresolvedLegKeys.length === 0) continue;
    unresolvedCombos += 1;
    unresolvedLegs += combo.unresolvedLegKeys.length;
    for (const key of new Set(combo.unresolvedLegKeys)) {
      unresolvedByKey.set(key, (unresolvedByKey.get(key) ?? 0) + 1);
    }
  }
  const unresolvedTop = [...unresolvedByKey.entries()]
    .map(([legKey, combos]) => ({ legKey, combos }))
    .sort((a, b) => b.combos - a.combos || a.legKey.localeCompare(b.legKey))
    .slice(0, 10);
  const diagnostics = {
    legsWithoutSide: dedupedAll.reduce(
      (sum, combo) => sum + combo.legsWithoutSide,
      0,
    ),
    legsWithoutStableId: dedupedAll.reduce(
      (sum, combo) => sum + combo.unstableLegs,
      0,
    ),
    combosWithUnstableIdentity: dedupedAll.filter(
      (combo) => combo.unstableLegs > 0,
    ).length,
    unresolved: {
      combos: unresolvedCombos,
      legs: unresolvedLegs,
      distinctLegKeys: unresolvedByKey.size,
      oneOffLegKeys: [...unresolvedByKey.values()].filter(
        (count) => count === 1,
      ).length,
      systemicLegKeys: [...unresolvedByKey.values()].filter(
        (count) => count >= 2,
      ).length,
      top: unresolvedTop,
    },
    combosWithoutAttribution,
    recordsWithoutLegs,
    cfbTouchRatePct:
      dedupedAll.length + combosWithoutAttribution > 0
        ? Math.round(
            (dedupedAll.length /
              (dedupedAll.length + combosWithoutAttribution)) *
              10_000,
          ) / 100
        : 0,
    suspectedComboOfComboLegKeys: [...unresolvedByKey.keys()].filter(
      looksLikeComboCondition,
    ).length,
  };

  // Attribution above is mode-independent. Each gate is a pure filter applied afterwards, so a
  // stricter gate is always a subset of a looser one and `fullyWithinGame` is monotonic.
  // `eligible` is exactly `market_sport_type ∈ {moneyline, spreads, totals}` (ELIGIBLE_LEG_TYPES),
  // the same predicate `full-game` uses.
  const exclusions: Record<StrictDropReason, number> = {
    UNRESOLVED_LEGS: 0,
    CROSS_GAME: 0,
    INELIGIBLE_LEG_TYPE: 0,
  };
  const dropReasonOf = (combo: NormalizedCombo): StrictDropReason | null => {
    if (gate === "permissive") return null;
    if (!combo.allLegsCfb) return "UNRESOLVED_LEGS";
    if (gate === "full-game" && !combo.fullyWithinGame) return "CROSS_GAME";
    if (!combo.allCfbLegsEligible) return "INELIGIBLE_LEG_TYPE";
    return null;
  };
  const kept: NormalizedCombo[] = [];
  const audit: ComboAuditRow[] = [];
  for (const combo of dedupedAll) {
    const dropReason = dropReasonOf(combo);
    if (dropReason === null) kept.push(combo);
    else exclusions[dropReason] += 1;
    if (options?.includeAudit !== false) {
      audit.push({
        comboId: combo.comboId,
        wallet: combo.wallet,
        legs: combo.legKeys.length,
        games: combo.gameSlugs.size,
        allLegsCfb: combo.allLegsCfb,
        fullyWithinGame: combo.fullyWithinGame,
        allCfbLegsEligible: combo.allCfbLegsEligible,
        kept: dropReason === null,
        dropReason,
        unresolvedLegKeys: combo.unresolvedLegKeys,
      });
    }
  }
  const normalized = kept;
  const deduped = normalized;
  const includedCrossGame = normalized.filter(
    (combo) => !combo.fullyWithinGame,
  ).length;

  const byGame = new Map<
    string,
    {
      combos: Set<string>;
      wallets: Set<string>;
      full: number;
      samples: NormalizedCombo[];
    }
  >();
  for (const game of games) {
    byGame.set(game.slug, {
      combos: new Set(),
      wallets: new Set(),
      full: 0,
      samples: [],
    });
  }
  for (const combo of deduped) {
    for (const slug of combo.gameSlugs) {
      const bucket = byGame.get(slug);
      if (bucket === undefined) continue;
      bucket.combos.add(combo.comboId);
      bucket.wallets.add(combo.wallet);
      if (combo.fullyWithinGame) bucket.full += 1;
      if (bucket.samples.length < 3) bucket.samples.push(combo);
    }
  }

  const gamesReport: ComboGameStats[] = games
    .map((game) => {
      const bucket = byGame.get(game.slug)!;
      return {
        gameSlug: game.slug,
        title: game.title,
        volume24hr: game.volume24hr,
        uniqueCombos: bucket.combos.size,
        uniqueWallets: bucket.wallets.size,
        fullyWithinGame: bucket.full,
        samples: bucket.samples.map((combo) => ({
          comboId: combo.comboId,
          wallet: combo.wallet,
          legs: combo.legKeys.length,
          games: combo.gameSlugs.size,
        })),
      };
    })
    .sort(
      (a, b) =>
        b.volume24hr - a.volume24hr || a.gameSlug.localeCompare(b.gameSlug),
    );

  const globalCombos = new Set(deduped.map((combo) => combo.comboId));
  const globalWallets = new Set(deduped.map((combo) => combo.wallet));
  const sumCombos = gamesReport.reduce(
    (sum, game) => sum + game.uniqueCombos,
    0,
  );
  const sumWallets = gamesReport.reduce(
    (sum, game) => sum + game.uniqueWallets,
    0,
  );

  return {
    gate,
    strictFullGame: strict,
    index: {
      games: games.length,
      activeOnly: options?.includeClosedGames === false,
      since: options?.since ?? null,
    },
    games: gamesReport,
    global: {
      gamesWithActivity: gamesReport.filter((game) => game.uniqueCombos > 0)
        .length,
      sumPerGameCombos: sumCombos,
      sumPerGameWallets: sumWallets,
      distinctCombos: globalCombos.size,
      distinctWallets: globalWallets.size,
    },
    walletsScanned: wallets.size,
    comboRecords: normalized.length,
    permissiveCombos: dedupedAll.length,
    duplicatesCollapsed,
    duplicatesCollapsedById,
    duplicatesCollapsedByLegSet,
    exclusions,
    includedCrossGame,
    diagnostics,
    wallets: [...wallets].sort(),
    combos: audit,
    cache: {
      ...stats,
      ttlHours: options?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS,
    },
  };
}

/**
 * Sorted `comboId|wallet` lines for **kept** combos only.
 *
 * There is deliberately no "include dropped" option: a subset check is only meaningful against
 * kept sets, and an ambiguous boolean here previously widened a gated reference back to the audit
 * population.
 */
export function comboIdLines(report: ComboUniquenessReport): string[] {
  return report.combos
    .filter((row) => row.kept)
    .map((row) => `${row.comboId}|${row.wallet}`)
    .sort();
}

/** Sorted unique wallets, one per line — the `--dump-wallets` input. */
export function walletLines(report: ComboUniquenessReport): string[] {
  return [...report.wallets].sort();
}

/** Join lines for file emission; an empty set writes an empty file, never a blank line. */
export function linesToText(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface ComboSubsetCheck {
  readonly referenceGate: ComboGate;
  readonly treatmentGate: ComboGate;
  readonly reference: number;
  readonly treatment: number;
  readonly leaks: readonly string[];
  /** True when the treatment set is empty: an empty diff proves nothing. */
  readonly vacuous: boolean;
}

/**
 * Empirical subset proof: every treatment combo must exist in the reference set.
 * An empty treatment set is reported as `vacuous` rather than as a pass.
 */
export function checkComboSubset(
  reference: ComboUniquenessReport,
  treatment: ComboUniquenessReport,
): ComboSubsetCheck {
  // Kept-only on both sides. Using all audit rows for the reference would silently widen a
  // gated reference (e.g. all-legs-cfb) back to the permissive population.
  const referenceIds = new Set(comboIdLines(reference));
  const treatmentIds = comboIdLines(treatment);
  const leaks = treatmentIds.filter((line) => !referenceIds.has(line));
  return {
    referenceGate: reference.gate,
    treatmentGate: treatment.gate,
    reference: referenceIds.size,
    treatment: treatmentIds.length,
    leaks,
    vacuous: treatmentIds.length === 0,
  };
}
