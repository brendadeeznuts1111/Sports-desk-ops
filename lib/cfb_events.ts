/**
 * @file lib/cfb_events.ts
 * @description CFB (college football) events as a data universe: the paginated event fetch,
 * its on-disk index cache, and the condition-id / slug / CLOB-token lookup the
 * combo layer resolves legs against. Knows nothing about combo identity, gates or
 * uniqueness.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CFB_SERIES_ID, GAMMA_API } from "./polymarket_combo.ts";
import {
  asRecord,
  getJson,
  jsonArray,
  text,
  type JsonFetchOptions,
} from "./json_fetch.ts";

export interface CfbEventsOptions extends JsonFetchOptions {
  readonly concurrency?: number;
  readonly cacheDir?: string;
  readonly cacheTtlHours?: number;
  /** Cache the CFB event index on disk. Off by default; `offline` implies it. */
  readonly cacheGames?: boolean;
  /** Read the event index only from cache and fail instead of fetching. */
  readonly offline?: boolean;
  readonly fresh?: boolean;
  readonly now?: number;
  readonly gammaBase?: string;
  /** Safety cap on paginated event fetches (default 30 pages x 100). */
  readonly maxGamePages?: number;
  readonly limitGames?: number;
  /** Also index settled CFB events (`closed=true`). Default true; pass false for open-only. */
  readonly includeClosedGames?: boolean;
  /** Keep only games on/after this ISO date (e.g. `2026-09-01`). */
  readonly since?: string;
}

export const DEFAULT_CACHE_TTL_HOURS = 24;

export interface CfbGame {
  readonly slug: string;
  readonly title: string;
  readonly volume24hr: number;
  readonly endIso: string | null;
  readonly conditionIds: readonly string[];
  readonly marketSlugs: readonly string[];
  readonly clobTokenIds: readonly string[];
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

export function cacheTtlMs(options?: CfbEventsOptions): number {
  const hours = options?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;
  return Math.max(0, hours) * 3_600_000;
}

async function cachedEvents(
  url: string,
  options?: CfbEventsOptions,
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

export async function loadCfbGames(
  options?: CfbEventsOptions,
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

export interface GameIndex {
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
