/**
 * Public Polymarket quotes for the execution planner: discover an open market for a matchup and
 * read both outcome-token books. Read-only by construction — gamma search + CLOB book GETs, no
 * signer, no API key, no order path.
 *
 * Discovery is strict: the market must be open (`active` and not `closed`) and its question must
 * name both teams. A closed or mismatched market is `{available:false, reason}` — never a guessed
 * token — because an execution decision built on the wrong market is worse than no venue offer.
 */
import { isRecordValue } from "./zod_guards.ts";
import type { KalshiClient } from "./kalshi_client.ts";
import { getUnifiedTeamRegistry } from "./unified_team_registry.ts";

export const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
export const POLYMARKET_CLOB_BASE_URL = "https://clob.polymarket.com";
export const POLYMARKET_QUOTE_TTL_MS = 60_000;
export const POLYMARKET_REQUEST_TIMEOUT_MS = 5_000;

export interface PolymarketLevel {
  readonly price: number;
  readonly size: number;
}

export interface PolymarketOutcome {
  readonly name: string;
  readonly tokenId: string;
  readonly bids: readonly PolymarketLevel[];
  readonly asks: readonly PolymarketLevel[];
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
}

export interface PolymarketError {
  readonly scope: "search" | "book";
  readonly reason: string;
}

export interface PolymarketTelemetry {
  readonly ok: boolean;
  readonly degraded: boolean;
  readonly requests: number;
  readonly cacheHits: number;
  readonly cacheTtlSec: number;
  readonly errors: readonly PolymarketError[];
}

export interface PolymarketQuoteAvailable {
  readonly available: true;
  readonly source: "gamma+clob";
  readonly marketId: string;
  readonly question: string;
  readonly slug: string | null;
  readonly outcomes: readonly PolymarketOutcome[];
  /** Book age in seconds, so a consumer can tell a fresh quote from a cached one. */
  readonly queriedAtIso: string;
  readonly telemetry: PolymarketTelemetry;
}

export interface PolymarketQuoteUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly telemetry: PolymarketTelemetry;
}

export type PolymarketQuote =
  PolymarketQuoteAvailable | PolymarketQuoteUnavailable;

export interface PolymarketQuoteClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly gammaBaseUrl?: string;
  readonly clobBaseUrl?: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** `clobTokenIds` / `outcomes` arrive JSON-encoded in a string; malformed is `null`. */
function parseJsonStringArray(value: unknown): readonly string[] | null {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string") ? value : null;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export interface PolymarketMarketCandidate {
  readonly marketId: string;
  readonly question: string;
  readonly slug: string | null;
  readonly tokenIds: readonly string[];
  readonly outcomes: readonly string[];
}

/** One gamma market row, only if it is open and its token/outcome arrays are readable. */
export function parseGammaMarket(
  value: unknown,
): PolymarketMarketCandidate | null {
  if (!isRecordValue(value)) return null;
  if (value["active"] !== true || value["closed"] === true) return null;
  const marketId = parseString(value["id"]);
  const question = parseString(value["question"]);
  const tokenIds = parseJsonStringArray(value["clobTokenIds"]);
  const outcomes = parseJsonStringArray(value["outcomes"]);
  if (marketId === null || question === null) return null;
  if (tokenIds === null || outcomes === null) return null;
  if (tokenIds.length !== outcomes.length) return null;
  return {
    marketId,
    question,
    slug: parseString(value["slug"]),
    tokenIds,
    outcomes,
  };
}

/** Gamma search envelope → open markets (closed/historical rows are dropped here). */
export function parseGammaSearch(
  value: unknown,
): readonly PolymarketMarketCandidate[] {
  if (!isRecordValue(value) || !Array.isArray(value["events"])) return [];
  const markets: PolymarketMarketCandidate[] = [];
  for (const rawEvent of value["events"]) {
    if (!isRecordValue(rawEvent)) continue;
    const eventMarkets = Array.isArray(rawEvent["markets"])
      ? rawEvent["markets"]
      : [];
    for (const rawMarket of eventMarkets) {
      const candidate = parseGammaMarket(rawMarket);
      if (candidate !== null) markets.push(candidate);
    }
  }
  return markets;
}

function parseBookLevels(value: unknown): readonly PolymarketLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: PolymarketLevel[] = [];
  for (const raw of value) {
    if (!isRecordValue(raw)) continue;
    const price = parseNumber(raw["price"]);
    const size = parseNumber(raw["size"]);
    if (price === null || size === null) continue;
    if (price <= 0 || price >= 1 || size <= 0) continue;
    levels.push({ price, size });
  }
  // CLOB publishes bids descending and asks ascending; sort defensively.
  return levels;
}

export interface ParsedPolymarketBook {
  readonly bids: readonly PolymarketLevel[];
  readonly asks: readonly PolymarketLevel[];
}

/** `{bids:[{price,size}],asks:[...]}` from the CLOB book endpoint. */
export function parsePolymarketBook(
  value: unknown,
): ParsedPolymarketBook | null {
  if (!isRecordValue(value)) return null;
  const bids = parseBookLevels(value["bids"]);
  const asks = parseBookLevels(value["asks"]);
  if (bids === null || asks === null) return null;
  return {
    bids: [...bids].sort((a, b) => b.price - a.price),
    asks: [...asks].sort((a, b) => a.price - b.price),
  };
}

/* -------------------------------------------------------------------------- */
/* Team matching                                                              */
/* -------------------------------------------------------------------------- */

/** Codes the question's city/name text does not contain verbatim. */
const TEAM_HINTS: Readonly<Record<string, readonly string[]>> = {
  GSW: ["Golden State", "Warriors"],
  NOP: ["New Orleans", "Pelicans"],
  NYK: ["New York Knicks", "Knicks"],
  BKN: ["Brooklyn", "Nets"],
  LAL: ["Lakers"],
  LAC: ["Clippers"],
  SAS: ["San Antonio", "Spurs"],
  WSH: ["Washington"],
  PHX: ["Phoenix", "Suns"],
  JAX: ["Jacksonville", "Jaguars"],
  LAR: ["Rams"],
  LAC_NFL: ["Chargers"],
};

export function teamMatchesQuestion(question: string, team: string): boolean {
  const upper = question.toUpperCase();
  const code = team.trim().toUpperCase();
  if (code === "") return false;
  if (new RegExp(`\\b${code}\\b`).test(upper)) return true;
  // A 3-letter code also matches a city prefix (`ATL` in `ATLANTA`, `MIL` in `MILWAUKEE`).
  if (upper.includes(code)) return true;
  const registryHints = getUnifiedTeamRegistry().polymarketHintsForCode(code);
  const hints =
    registryHints.length > 0 ? registryHints : (TEAM_HINTS[code] ?? []);
  return hints.some((hint) => upper.includes(hint.toUpperCase()));
}

/** The search phrase for a query: code with a hint/expansion when one is known. */
export function queryForTeams(teams: readonly string[]): string {
  const registry = getUnifiedTeamRegistry();
  return teams
    .map((team) => {
      const code = team.trim().toUpperCase();
      const fromRegistry = registry.polymarketHintsForCode(code)[0];
      const hint = fromRegistry ?? TEAM_HINTS[code]?.[0];
      return hint ?? code;
    })
    .filter((part) => part !== "")
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  readonly expiresAt: number;
  readonly value: unknown;
}

interface SearchMarket {
  readonly candidate: PolymarketMarketCandidate;
}

export class PolymarketQuoteClient {
  /** Unused import guard: keeps the cache shape visibly parallel to the Kalshi client. */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly gammaBaseUrl: string;
  private readonly clobBaseUrl: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly errors: PolymarketError[] = [];
  private requestCount = 0;
  private cacheHitCount = 0;

  constructor(options: PolymarketQuoteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.gammaBaseUrl = (
      options.gammaBaseUrl ?? POLYMARKET_GAMMA_BASE_URL
    ).replace(/\/+$/, "");
    this.clobBaseUrl = (
      options.clobBaseUrl ?? POLYMARKET_CLOB_BASE_URL
    ).replace(/\/+$/, "");
    this.ttlMs = options.ttlMs ?? POLYMARKET_QUOTE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? POLYMARKET_REQUEST_TIMEOUT_MS;
  }

  telemetry(): PolymarketTelemetry {
    return {
      ok: this.errors.length === 0,
      degraded: this.errors.length > 0,
      requests: this.requestCount,
      cacheHits: this.cacheHitCount,
      cacheTtlSec: Math.floor(this.ttlMs / 1000),
      errors: [...this.errors],
    };
  }

  private recordError(scope: PolymarketError["scope"], reason: string): void {
    if (this.errors.length < 20) this.errors.push({ scope, reason });
  }

  private async getJson(
    scope: PolymarketError["scope"],
    url: string,
  ): Promise<unknown | null> {
    const key = `${scope}:${url}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > now) {
      this.cacheHitCount += 1;
      return hit.value;
    }
    this.requestCount += 1;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.recordError(
          scope,
          `HTTP ${response.status} from ${new URL(url).pathname}`,
        );
        return null;
      }
      const value = (await response.json()) as unknown;
      this.cache.set(key, { expiresAt: now + this.ttlMs, value });
      return value;
    } catch (error) {
      this.recordError(
        scope,
        `network: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          200,
        ),
      );
      return null;
    }
  }

  /** Open markets matching a phrase (gamma search, 60s cache). */
  async search(phrase: string): Promise<readonly SearchMarket[] | null> {
    const url = `${this.gammaBaseUrl}/public-search?q=${encodeURIComponent(
      phrase,
    )}&limit_per_type=5`;
    const raw = await this.getJson("search", url);
    if (raw === null) return null;
    return parseGammaSearch(raw).map((candidate) => ({ candidate }));
  }

  /** One outcome token's book (CLOB, 60s cache). */
  async book(tokenId: string): Promise<ParsedPolymarketBook | null> {
    const url = `${this.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const raw = await this.getJson("book", url);
    return raw === null ? null : parsePolymarketBook(raw);
  }

  /**
   * Quote both outcome tokens for a matchup, or explain why no venue offer exists.
   *
   * The search phrase is the team codes first and, when that yields nothing, a hint-expanded
   * phrase (`GSW` → `Golden State`). A match requires both teams in the question and an open
   * market; the token ids come from that market's own `clobTokenIds` field.
   */
  async quoteForTeams(teams: readonly string[]): Promise<PolymarketQuote> {
    if (teams.length < 2) {
      return {
        available: false,
        reason: "need two teams to match a Polymarket market",
        telemetry: this.telemetry(),
      };
    }
    const phrases = [...new Set([teams.join(" "), queryForTeams(teams)])];
    let sawOpenMarket = false;
    for (const phrase of phrases) {
      const markets = await this.search(phrase);
      if (markets === null) {
        return {
          available: false,
          reason: `Polymarket gamma unavailable: ${
            this.errors[this.errors.length - 1]?.reason ?? "unknown error"
          }`,
          telemetry: this.telemetry(),
        };
      }
      for (const { candidate } of markets) {
        if (
          !teams.every((team) => teamMatchesQuestion(candidate.question, team))
        )
          continue;
        sawOpenMarket = true;
        const [first, second] = candidate.outcomes;
        const [yesToken, noToken] = candidate.tokenIds;
        if (
          first === undefined ||
          second === undefined ||
          yesToken === undefined ||
          noToken === undefined
        ) {
          continue;
        }
        const [yesBook, noBook] = await Promise.all([
          this.book(yesToken),
          this.book(noToken),
        ]);
        if (yesBook === null || noBook === null) {
          return {
            available: false,
            reason: `Polymarket CLOB book unavailable: ${
              this.errors[this.errors.length - 1]?.reason ?? "unknown error"
            }`,
            telemetry: this.telemetry(),
          };
        }
        const outcome = (
          name: string,
          tokenId: string,
          book: ParsedPolymarketBook,
        ): PolymarketOutcome => ({
          name,
          tokenId,
          bids: book.bids,
          asks: book.asks,
          bestBid: book.bids[0]?.price ?? null,
          bestAsk: book.asks[0]?.price ?? null,
        });
        return {
          available: true,
          source: "gamma+clob",
          marketId: candidate.marketId,
          question: candidate.question,
          slug: candidate.slug,
          outcomes: [
            outcome(first, yesToken, yesBook),
            outcome(second, noToken, noBook),
          ],
          queriedAtIso: new Date(this.now()).toISOString(),
          telemetry: this.telemetry(),
        };
      }
    }
    return {
      available: false,
      reason: sawOpenMarket
        ? "no open Polymarket market matched both teams' outcome tokens"
        : "no open Polymarket market matches both teams",
      telemetry: this.telemetry(),
    };
  }
}

/** Kept for callers that want the same cache TTL shape as the Kalshi client. */
export type { KalshiClient };
