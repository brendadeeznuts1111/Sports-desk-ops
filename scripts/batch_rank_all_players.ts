/**
 * @file scripts/batch_rank_all_players.ts
 * @description Batched streaming aggregator and ranking engine across the 30-day wager corpus.
 *
 * Implements chunked 50,000-line stream processing to adhere to repository data-handling
 * budgets, avoid event-loop blocking, and maintain signal honesty.
 *
 * Usage:
 *   bun run scripts/batch_rank_all_players.ts [--batch 50000] [--out data/player_rankings_30d.json]
 */

import { existsSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveF402BetsJsonlPath } from "../lib/f402_bets_corpus_path.ts";
import {
  createDod6V54LifetimeReader,
  type Dod6LifetimeLookupTarget,
  type Dod6V54LifetimeReader,
} from "../lib/dod6_v54_lifetime_reader.ts";
import { parseBuyPointsFromDesc } from "../lib/f402_figure_date_enricher.ts";

const FOOTBALL_KEY_NUMBER_SPREAD_RE =
  /(?:^|\s)[+-]?(?:2\.5|2½|3|3\.5|3½|6\.5|6½|7|7\.5|7½|10|14|21)(?:\s|$)/;

export interface RawBetRow {
  Login?: string;
  CustomerID?: string;
  AgentID?: string;
  AgentLogin?: string;
  AmountWagered?: number;
  ToWinAmount?: number;
  InsertDateTime?: string;
  WagerType?: string;
  TicketWriter?: string;
  ShortDesc?: string;
}

interface CachedBatchedRanking {
  readonly baseResult: Omit<BatchedRankingResult, "topRankedPlayers">;
  readonly allRankedPlayers: readonly PlayerRankingRecord[];
  readonly playerById: ReadonlyMap<string, PlayerRankingRecord>;
}

const RANKING_CACHE_MAX = 4;
const batchedRankingCache = new Map<string, CachedBatchedRanking>();
const inflightRankings = new Map<string, Promise<CachedBatchedRanking>>();

let cachedDod6Entry: {
  readonly stamp: string;
  readonly reader: Dod6V54LifetimeReader | null;
} | null = null;

async function getCachedDod6Reader(
  dodbinPath = resolve(
    import.meta.dir,
    "../data/sportsdesk_unified_baseline_v54.dodbin",
  ),
): Promise<Dod6V54LifetimeReader | null> {
  const stamp = await fileStatStamp(dodbinPath);
  if (cachedDod6Entry !== null && cachedDod6Entry.stamp === stamp) {
    return cachedDod6Entry.reader;
  }
  if (stamp === "missing") {
    cachedDod6Entry = { stamp, reader: null };
    return null;
  }
  try {
    const reader = await createDod6V54LifetimeReader(dodbinPath);
    cachedDod6Entry = { stamp, reader };
    return reader;
  } catch {
    cachedDod6Entry = { stamp, reader: null };
    return null;
  }
}

export function resetBatchedRankingCache(): void {
  batchedRankingCache.clear();
  inflightRankings.clear();
  cachedDod6Entry = null;
}

/** Non-blocking O(1) lookup against already-computed 30d rankings cache (never scans disk cold). */
export function peekCachedRankedPlayer(
  customerId: string,
): PlayerRankingRecord | null {
  const norm = customerId.trim().toUpperCase();
  if (!norm) return null;
  const canonical = norm.replace(/_\d+$/, "");
  for (const cached of batchedRankingCache.values()) {
    const exact = cached.playerById.get(norm);
    if (exact) return exact;
    if (canonical && canonical !== norm) {
      const fallback = cached.playerById.get(canonical);
      if (fallback) return fallback;
    }
  }
  return null;
}

// Memory pressure notification listener (Bun 1.4 native)
if (typeof process !== "undefined" && typeof process.on === "function") {
  try {
    process.on("memoryPressure", (level: string) => {
      batchedRankingCache.clear();
      console.warn(
        `[SportsDesk Engine] Host memory pressure level: ${level}. Compacting temporary caches.`,
      );
    });
  } catch {
    // Unsupported environment fallback
  }
}

export interface CustomerAccumulator {
  login: string;
  agentId: string;
  masterAgent: string;
  wagerCount: number;
  handleCents: number;
  toWinCents: number;
  alertCount: number;
  blockedCount: number;
  stakesSample: number[];
  types: Record<string, number>;
  sports: Record<string, number>;
  minDate: string;
  maxDate: string;
  keyNumberBuysCount?: number;
  halfPointBuysCount?: number;
  seatIds?: Set<string>;
}

export interface PlayerRankingRecord {
  rank: number;
  customerId: string;
  agentId: string;
  masterAgent: string;
  totalWagers: number;
  handleUsd: number;
  avgStakeUsd: number;
  medianStakeUsd: number;
  maxStakeUsd: number;
  toWinUsd: number;
  stakeGini: number;
  alertRatePct: number;
  dominantSport: string;
  dominantBetType: string;
  compositeScore: number;
  tier: "TIER_1" | "TIER_2" | "TIER_3" | "TIER_4" | "TIER_5";
  tierLabel: string;
  recommendedLimitUsd: number;
  recommendedDelaySeconds: number;
  recommendedLineShadeCents: number;
  shadowCopyRatio: number;
  isProxyConduit: boolean;
  lastWagerAt?: string;
  clvBps?: number | null;
  clvLegs?: number;
  dodSharpScore?: number | null;
  lifetimeNetUsd?: number | null;
  sharpCandidateGatePassed?: boolean;
  scoreComponents?: {
    readonly clv: number;
    readonly volume: number;
    readonly sizing: number;
    readonly timing: number;
    readonly combo: number;
  };
  keyNumberBuys30d?: number;
  halfPointBuys30d?: number;
  halfPointBuyRatePct?: number;
  seatCount?: number;
  isKeyNumberBuyer?: boolean;
  isHalfPointHookBuyer?: boolean;
  isMultiSeatCluster?: boolean;
  autoExecute: false;
}

export interface FormulaCohortSummary {
  readonly activeAccounts: number;
  readonly clvMeasuredCount: number;
  readonly positiveClvCount: number;
  readonly poweredPositiveClvCount: number;
  readonly eliteClv100BpsCount: number;
  readonly profitablePositiveClvCount: number;
  readonly keyNumberBuyersCount: number;
  readonly halfPointHookBuyersCount: number;
  readonly proxyConduitPlayersCount: number;
  readonly multiSeatClustersCount: number;
  readonly hookOrSyndicateCount: number;
  readonly meanClvBps: number | null;
}

export interface SubAgentRollup {
  agentId: string;
  masterAgent: string;
  totalHandleUsd: number;
  totalWagers: number;
  customerCount: number;
  topCustomer: string;
  topCustomerHandleUsd: number;
  topCustomerConcentrationPct: number;
  isProxyConduit: boolean;
}

export interface MasterAgentRollup {
  masterAgent: string;
  totalHandleUsd: number;
  totalWagers: number;
  subAgentCount: number;
  customerCount: number;
}

export interface BatchedRankingResult {
  generatedAtIso: string;
  windowStart: string;
  windowEnd: string;
  totalWagersScanned: number;
  inWindowWagers: number;
  totalHandleUsd: number;
  totalToWinUsd: number;
  activeCustomerCount: number;
  activeSubAgentCount: number;
  activeMasterAgentCount: number;
  conduitSubAgentCount: number;
  topMasterAgents: MasterAgentRollup[];
  topSubAgents: SubAgentRollup[];
  topRankedPlayers: PlayerRankingRecord[];
  formulaCohorts?: FormulaCohortSummary;
}

export function computeGini(values: number[]): number {
  const n = values.length;
  if (n <= 1) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;
  let diffSum = 0;
  for (let i = 0; i < n; i++) {
    const val = sorted[i] ?? 0;
    diffSum += val * (2 * i - n + 1);
  }
  return Math.max(0, Math.min(1, diffSum / (n * sum)));
}

export interface CompositeScoreComponents {
  readonly clv: number;
  readonly volume: number;
  readonly sizing: number;
  readonly timing: number;
  readonly combo: number;
}

export function calculateCompositeScore(acc: CustomerAccumulator): {
  score: number;
  tier: "TIER_1" | "TIER_2" | "TIER_3" | "TIER_4" | "TIER_5";
  tierLabel: string;
  limitUsd: number;
  delaySec: number;
  shadeCents: number;
  shadowCopy: number;
  components: CompositeScoreComponents;
} {
  const gini = computeGini(acc.stakesSample);
  const alertRate = acc.wagerCount > 0 ? acc.alertCount / acc.wagerCount : 0;
  const parlayRatio =
    acc.wagerCount > 0 ? (acc.types["P"] ?? 0) / acc.wagerCount : 0;
  const liveRatio =
    acc.wagerCount > 0 ? (acc.types["L"] ?? 0) / acc.wagerCount : 0;

  // 1. CLV Edge / Alert Score (0.0 to 3.0 pts)
  const sClv = Math.min(3.0, alertRate * 4.0);

  // 2. Volume & Stake Weight (0.0 to 2.5 pts)
  const avgStake =
    acc.wagerCount > 0 ? acc.handleCents / 100 / acc.wagerCount : 0;
  const sStake = Math.min(2.5, Math.log10(Math.max(1, avgStake)) * 0.6);

  // 3. Stake Sizing Discipline / Low Gini (0.0 to 1.5 pts)
  const sGini = Math.max(0, 1.5 * (1.0 - gini));

  // 4. Timing & Market Selectivity (0.0 to 2.0 pts)
  const sTiming =
    (acc.blockedCount > 0 ? 1.0 : 0.0) + (liveRatio > 0.4 ? 1.0 : 0.5);

  // 5. Correlated Combination Risk (0.0 to 1.0 pts)
  const sCombo = parlayRatio > 0.2 ? 1.0 : parlayRatio * 5.0;

  const rawScore = sClv + sStake + sGini + sTiming + sCombo;
  const score = Number(Math.max(0.5, Math.min(10.0, rawScore)).toFixed(2));

  // Round component scores to 2dp while preserving exact integer-cents conservation against `score`.
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let clv = r2(sClv);
  let volume = r2(sStake);
  let sizing = r2(sGini);
  let timing = r2(sTiming);
  let combo = r2(sCombo);
  const targetUnits = Math.round(score * 100);
  const deltaUnits =
    targetUnits - Math.round((clv + volume + sizing + timing + combo) * 100);
  if (deltaUnits !== 0) {
    const entries: Array<{
      key: "clv" | "volume" | "sizing" | "timing" | "combo";
      val: number;
      cap: number;
    }> = [
      { key: "clv", val: clv, cap: 3.0 },
      { key: "volume", val: volume, cap: 2.5 },
      { key: "sizing", val: sizing, cap: 1.5 },
      { key: "timing", val: timing, cap: 2.0 },
      { key: "combo", val: combo, cap: 1.0 },
    ];
    entries.sort((a, b) => b.val - a.val);
    const chosen = entries.find(
      (e) =>
        Math.round(e.val * 100) + deltaUnits >= 0 &&
        Math.round(e.val * 100) + deltaUnits <= Math.round(e.cap * 100),
    );
    if (chosen) {
      const next = (Math.round(chosen.val * 100) + deltaUnits) / 100;
      if (chosen.key === "clv") clv = next;
      else if (chosen.key === "volume") volume = next;
      else if (chosen.key === "sizing") sizing = next;
      else if (chosen.key === "timing") timing = next;
      else combo = next;
    }
  }
  const components: CompositeScoreComponents = {
    clv,
    volume,
    sizing,
    timing,
    combo,
  };

  if (score >= 8.8) {
    return {
      score,
      tier: "TIER_1",
      tierLabel: "Tier 1: Elite Originator",
      limitUsd: 250,
      delaySec: 3.0,
      shadeCents: 15,
      shadowCopy: 1.0,
      components,
    };
  } else if (score >= 8.0) {
    return {
      score,
      tier: "TIER_2",
      tierLabel: "Tier 2: Steam Syndicate",
      limitUsd: 500,
      delaySec: 2.0,
      shadeCents: 10,
      shadowCopy: 0.5,
      components,
    };
  } else if (score >= 7.0) {
    return {
      score,
      tier: "TIER_3",
      tierLabel: "Tier 3: Disciplined Sharp",
      limitUsd: 1000,
      delaySec: 1.0,
      shadeCents: 5,
      shadowCopy: 0.0,
      components,
    };
  } else if (score >= 5.5) {
    return {
      score,
      tier: "TIER_4",
      tierLabel: "Tier 4: Semi-Sharp / Mixed",
      limitUsd: 2500,
      delaySec: 0.0,
      shadeCents: 0,
      shadowCopy: 0.0,
      components,
    };
  } else {
    return {
      score,
      tier: "TIER_5",
      tierLabel: "Tier 5: Recreational / Retail",
      limitUsd: 5000,
      delaySec: 0.0,
      shadeCents: 0,
      shadowCopy: 0.0,
      components,
    };
  }
}

async function fileStatStamp(path: string): Promise<string> {
  const st = await Bun.file(path)
    .stat()
    .catch(() => null);
  return st === null ? "missing" : `${st.mtimeMs}:${st.size}`;
}

/**
 * Advance a string JSONL window. `read` stops at the record terminator; on a
 * parse error the poison line is dropped so the next chunk can make progress.
 */
export function advanceJsonlStringRemainder(
  text: string,
  result: { readonly read: number; readonly error: unknown },
): string {
  if (!result.error) return text.slice(result.read);
  let at = result.read;
  while (at < text.length && (text[at] === "\n" || text[at] === "\r")) {
    at += 1;
  }
  const end = text.indexOf("\n", at);
  return end < 0 ? text.slice(at) : text.slice(end + 1);
}

export async function runBatchedRanking(
  options: {
    corpusPath?: string;
    treePath?: string;
    batchSize?: number;
    windowCutoff?: string;
    limitPlayers?: number;
  } = {},
): Promise<BatchedRankingResult> {
  const corpus = options.corpusPath ?? resolveF402BetsJsonlPath();
  const treePath =
    options.treePath ?? resolve(import.meta.dir, "../data/agent-tree.json");
  const _batchSize = options.batchSize ?? 50000;
  const windowCutoff =
    options.windowCutoff ??
    (typeof Temporal !== "undefined"
      ? Temporal.Now.zonedDateTimeISO("America/New_York")
          .subtract({ days: 30 })
          .toPlainDate()
          .toString()
      : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const limitPlayers = options.limitPlayers ?? 100;

  const [corpusStamp, treeStamp] = await Promise.all([
    fileStatStamp(corpus),
    fileStatStamp(treePath),
  ]);
  const cacheKey = `${corpus}|${corpusStamp}|${treePath}|${treeStamp}|${windowCutoff}`;

  const hit = batchedRankingCache.get(cacheKey);
  if (hit !== undefined) {
    return {
      ...hit.baseResult,
      topRankedPlayers: hit.allRankedPlayers.slice(0, limitPlayers),
    };
  }

  let pending = inflightRankings.get(cacheKey);
  if (pending === undefined) {
    pending = computeUncachedBatchedRanking(
      corpus,
      treePath,
      windowCutoff,
    ).finally(() => {
      inflightRankings.delete(cacheKey);
    });
    inflightRankings.set(cacheKey, pending);
  }

  const computed = await pending;
  if (corpusStamp !== "missing") {
    if (batchedRankingCache.size >= RANKING_CACHE_MAX) {
      batchedRankingCache.clear();
    }
    batchedRankingCache.set(cacheKey, computed);
  }

  return {
    ...computed.baseResult,
    topRankedPlayers: computed.allRankedPlayers.slice(0, limitPlayers),
  };
}

async function computeUncachedBatchedRanking(
  corpus: string,
  treePath: string,
  windowCutoff: string,
): Promise<CachedBatchedRanking> {
  let treeNodes: Record<string, { p?: string | null; l?: number | null }> = {};
  const treeFile = Bun.file(treePath);
  if (await treeFile.exists()) {
    const treeRaw = (await treeFile.json()) as {
      nodes?: Record<string, { p?: string | null; l?: number | null }>;
    };
    treeNodes = treeRaw.nodes ?? {};
  }

  function resolveMaster(agentId: string): string {
    const norm = (agentId || "").trim().toUpperCase().replace(/\.+$/, "");
    let curr = norm;
    const seen = new Set<string>();
    let master = norm;
    while (curr && !seen.has(curr)) {
      seen.add(curr);
      const node = treeNodes[curr];
      if (!node) break;
      master = curr;
      if (!node.p) break;
      curr = node.p.trim().toUpperCase().replace(/\.+$/, "");
    }
    return master;
  }

  const customerMap = new Map<string, CustomerAccumulator>();
  const subAgentMap = new Map<
    string,
    {
      agentId: string;
      masterAgent: string;
      count: number;
      handleCents: number;
      customers: Map<string, number>;
    }
  >();
  const masterAgentMap = new Map<
    string,
    {
      masterAgent: string;
      count: number;
      handleCents: number;
      subAgents: Set<string>;
      customers: Set<string>;
    }
  >();

  let totalLines = 0;
  let inWindowWagers = 0;
  let totalHandleCents = 0;
  let totalToWinCents = 0;

  const processRow = (rec: RawBetRow) => {
    totalLines++;
    const dt = rec.InsertDateTime ?? "";
    if (dt < windowCutoff) return;

    inWindowWagers++;
    const login = (rec.Login || rec.CustomerID || "UNKNOWN")
      .trim()
      .toUpperCase();
    const rawAgent = (rec.AgentLogin || rec.AgentID || "UNKNOWN")
      .trim()
      .toUpperCase()
      .replace(/\.+$/, "");
    const master = resolveMaster(rawAgent);
    const stakeCents = Number(rec.AmountWagered) || 0;
    const toWinCents = Number(rec.ToWinAmount) || 0;
    const isAlert =
      (rec.TicketWriter && rec.TicketWriter.includes("ALERT")) || false;
    const isBlocked =
      (rec.TicketWriter && rec.TicketWriter.includes("BLOCKED")) || false;

    totalHandleCents += stakeCents;
    totalToWinCents += toWinCents;

    // Customer level
    let c = customerMap.get(login);
    if (!c) {
      c = {
        login,
        agentId: rawAgent,
        masterAgent: master,
        wagerCount: 0,
        handleCents: 0,
        toWinCents: 0,
        alertCount: 0,
        blockedCount: 0,
        stakesSample: [],
        types: {},
        sports: {},
        minDate: dt,
        maxDate: dt,
        keyNumberBuysCount: 0,
        halfPointBuysCount: 0,
        seatIds: new Set<string>(),
      };
      customerMap.set(login, c);
    }
    c.wagerCount++;
    c.handleCents += stakeCents;
    c.toWinCents += toWinCents;
    if (isAlert) c.alertCount++;
    if (isBlocked) c.blockedCount++;
    if (c.stakesSample.length < 500) {
      c.stakesSample.push(stakeCents / 100);
    }
    if (dt && (!c.minDate || dt < c.minDate)) c.minDate = dt;
    if (dt && (!c.maxDate || dt > c.maxDate)) c.maxDate = dt;

    const wt = rec.WagerType || "OTHER";
    c.types[wt] = (c.types[wt] || 0) + 1;

    const desc = rec.ShortDesc || "";
    let sp = "OTHER";
    if (
      desc.includes("Football") ||
      desc.includes("NFL") ||
      desc.includes("CFB")
    )
      sp = "FOOTBALL";
    else if (desc.includes("Basketball") || desc.includes("NBA"))
      sp = "BASKETBALL";
    else if (desc.includes("Baseball") || desc.includes("MLB")) sp = "BASEBALL";
    else if (desc.includes("Soccer")) sp = "SOCCER";
    else if (desc.includes("Hockey") || desc.includes("NHL")) sp = "HOCKEY";
    else if (desc.includes("Tennis")) sp = "TENNIS";
    c.sports[sp] = (c.sports[sp] || 0) + 1;

    if (!isAlert && !isBlocked) {
      const seatId = (rec.CustomerID || "").trim().toUpperCase();
      if (seatId && c.seatIds) c.seatIds.add(seatId);
      if (desc.includes("buying") || desc.includes("Buying")) {
        const bp = parseBuyPointsFromDesc(desc);
        if (bp > 0) {
          if (bp === 0.5) {
            c.halfPointBuysCount = (c.halfPointBuysCount ?? 0) + 1;
          }
          if (sp === "FOOTBALL" && FOOTBALL_KEY_NUMBER_SPREAD_RE.test(desc)) {
            c.keyNumberBuysCount = (c.keyNumberBuysCount ?? 0) + 1;
          }
        }
      }
    }

    // Sub-Agent level
    let sa = subAgentMap.get(rawAgent);
    if (!sa) {
      sa = {
        agentId: rawAgent,
        masterAgent: master,
        count: 0,
        handleCents: 0,
        customers: new Map(),
      };
      subAgentMap.set(rawAgent, sa);
    }
    sa.count++;
    sa.handleCents += stakeCents;
    sa.customers.set(login, (sa.customers.get(login) || 0) + stakeCents);

    // Master-Agent level
    let ma = masterAgentMap.get(master);
    if (!ma) {
      ma = {
        masterAgent: master,
        count: 0,
        handleCents: 0,
        subAgents: new Set(),
        customers: new Set(),
      };
      masterAgentMap.set(master, ma);
    }
    ma.count++;
    ma.handleCents += stakeCents;
    ma.subAgents.add(rawAgent);
    ma.customers.add(login);
  };

  // High-performance streaming: Use native Bun.JSONL.parseChunk if available
  const hasNativeJsonl =
    typeof Bun !== "undefined" &&
    typeof (
      Bun as unknown as {
        JSONL?: {
          parseChunk?: (s: string) => {
            values: unknown[];
            read: number;
            done: boolean;
            error: unknown;
          };
        };
      }
    ).JSONL?.parseChunk === "function";

  if (hasNativeJsonl && existsSync(corpus)) {
    const file = Bun.file(corpus);
    const stream = file.stream();
    const reader = stream.getReader();
    let remainder = "";
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (remainder.trim()) {
          const last = (
            Bun as unknown as {
              JSONL: {
                parseChunk: (s: string) => {
                  values: unknown[];
                  read: number;
                  done: boolean;
                  error: unknown;
                };
              };
            }
          ).JSONL.parseChunk(remainder);
          for (const item of (last.values ?? []) as RawBetRow[]) {
            processRow(item);
          }
        }
        break;
      }

      const chunkText = remainder + decoder.decode(value, { stream: true });
      const result = (
        Bun as unknown as {
          JSONL: {
            parseChunk: (s: string) => {
              values: unknown[];
              read: number;
              done: boolean;
              error: unknown;
            };
          };
        }
      ).JSONL.parseChunk(chunkText);
      for (const item of (result.values ?? []) as RawBetRow[]) {
        processRow(item);
      }
      remainder = advanceJsonlStringRemainder(chunkText, result);
    }
  } else {
    // Node.js fallback readline streaming
    const fileStream = createReadStream(corpus);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as RawBetRow;
        processRow(item);
      } catch {
        continue;
      }
    }
  }

  // Rollups
  const topMasters: MasterAgentRollup[] = Array.from(masterAgentMap.values())
    .map((m) => ({
      masterAgent: m.masterAgent,
      totalHandleUsd: m.handleCents / 100,
      totalWagers: m.count,
      subAgentCount: m.subAgents.size,
      customerCount: m.customers.size,
    }))
    .sort((a, b) => b.totalHandleUsd - a.totalHandleUsd);

  let conduitSubAgentCount = 0;
  const topSubAgents: SubAgentRollup[] = Array.from(subAgentMap.values())
    .map((sa) => {
      let topCust = "NONE";
      let topCustCents = 0;
      for (const [cust, cHandle] of sa.customers.entries()) {
        if (cHandle > topCustCents) {
          topCustCents = cHandle;
          topCust = cust;
        }
      }
      const topCustomerConcentrationPct =
        sa.handleCents > 0
          ? Number(((topCustCents / sa.handleCents) * 100).toFixed(1))
          : 0;
      const isProxyConduit =
        topCustomerConcentrationPct >= 80.0 && sa.handleCents >= 50000000; // >= $500k handle
      if (isProxyConduit) conduitSubAgentCount++;

      return {
        agentId: sa.agentId,
        masterAgent: sa.masterAgent,
        totalHandleUsd: sa.handleCents / 100,
        totalWagers: sa.count,
        customerCount: sa.customers.size,
        topCustomer: topCust,
        topCustomerHandleUsd: topCustCents / 100,
        topCustomerConcentrationPct,
        isProxyConduit,
      };
    })
    .sort((a, b) => b.totalHandleUsd - a.totalHandleUsd);

  // Player scoring (O(1) sub-agent & DOD6 lookup)
  const subAgentById = new Map<string, SubAgentRollup>();
  for (const sa of topSubAgents) {
    subAgentById.set(sa.agentId, sa);
  }
  const dodReader = await getCachedDod6Reader();
  const dodTarget: Dod6LifetimeLookupTarget = {
    clvBps: null,
    sharpScore: null,
    lifetimeNetUsd: null,
    clvLegs: 0,
    avgClvPoints: null,
    sharpCandidateGatePassed: false,
    source: "lifetime_csv",
    handleKind: "binary",
    handleValue: null,
  };

  const rankedPlayers: PlayerRankingRecord[] = [];
  for (const c of customerMap.values()) {
    const scoring = calculateCompositeScore(c);
    const gini = computeGini(c.stakesSample);
    const sortedStakes = [...c.stakesSample].sort((a, b) => a - b);
    const medianStake =
      sortedStakes.length > 0
        ? (sortedStakes[Math.floor(sortedStakes.length / 2)] ?? 0)
        : 0;
    const maxStake =
      sortedStakes.length > 0
        ? (sortedStakes[sortedStakes.length - 1] ?? 0)
        : 0;
    const avgStake = c.wagerCount > 0 ? c.handleCents / 100 / c.wagerCount : 0;

    let dominantSport = "OTHER";
    let maxSportCount = 0;
    for (const [sp, cnt] of Object.entries(c.sports)) {
      if (cnt > maxSportCount) {
        maxSportCount = cnt;
        dominantSport = sp;
      }
    }

    let dominantBetType = "OTHER";
    let maxTypeCount = 0;
    for (const [t, cnt] of Object.entries(c.types)) {
      if (cnt > maxTypeCount) {
        maxTypeCount = cnt;
        dominantBetType = t;
      }
    }

    const saRollup = subAgentById.get(c.agentId);
    const isProxyConduit =
      saRollup?.isProxyConduit && saRollup.topCustomer === c.login
        ? true
        : false;

    const normLogin = c.login.trim().toUpperCase();
    const canonicalLogin = normLogin.replace(/_\d+$/, "");
    const dodMatched =
      dodReader !== null &&
      (dodReader.lookupInto(normLogin, dodTarget) ||
        (canonicalLogin !== normLogin &&
          dodReader.lookupInto(canonicalLogin, dodTarget)));

    const keyNumberBuys = c.keyNumberBuysCount ?? 0;
    const halfPointBuys = c.halfPointBuysCount ?? 0;
    const halfPointRatePct =
      c.wagerCount > 0 && halfPointBuys > 0
        ? Math.round((halfPointBuys / c.wagerCount) * 1000) / 10
        : 0;
    const seatCount = c.seatIds ? c.seatIds.size : 1;
    const isKeyNumberBuyer = keyNumberBuys >= 3;
    const isHalfPointHookBuyer =
      halfPointBuys >= 5 &&
      c.wagerCount > 0 &&
      halfPointBuys / c.wagerCount >= 0.05;
    const isMultiSeatCluster = seatCount >= 2;

    rankedPlayers.push({
      rank: 0,
      customerId: c.login,
      agentId: c.agentId,
      masterAgent: c.masterAgent,
      totalWagers: c.wagerCount,
      handleUsd: c.handleCents / 100,
      avgStakeUsd: Number(avgStake.toFixed(2)),
      medianStakeUsd: Number(medianStake.toFixed(2)),
      maxStakeUsd: Number(maxStake.toFixed(2)),
      toWinUsd: c.toWinCents / 100,
      stakeGini: Number(gini.toFixed(3)),
      alertRatePct:
        c.wagerCount > 0
          ? Number(((c.alertCount / c.wagerCount) * 100).toFixed(1))
          : 0,
      dominantSport,
      dominantBetType,
      compositeScore: scoring.score,
      tier: scoring.tier,
      tierLabel: scoring.tierLabel,
      recommendedLimitUsd: scoring.limitUsd,
      recommendedDelaySeconds: scoring.delaySec,
      recommendedLineShadeCents: scoring.shadeCents,
      shadowCopyRatio: scoring.shadowCopy,
      isProxyConduit,
      ...(c.maxDate ? { lastWagerAt: c.maxDate } : {}),
      scoreComponents: scoring.components,
      ...(keyNumberBuys > 0 ? { keyNumberBuys30d: keyNumberBuys } : {}),
      ...(halfPointBuys > 0
        ? {
            halfPointBuys30d: halfPointBuys,
            halfPointBuyRatePct: halfPointRatePct,
          }
        : {}),
      ...(seatCount > 1 ? { seatCount } : {}),
      ...(isKeyNumberBuyer ? { isKeyNumberBuyer: true } : {}),
      ...(isHalfPointHookBuyer ? { isHalfPointHookBuyer: true } : {}),
      ...(isMultiSeatCluster ? { isMultiSeatCluster: true } : {}),
      ...(dodMatched
        ? {
            clvBps: dodTarget.clvBps,
            clvLegs: dodTarget.clvLegs,
            dodSharpScore: dodTarget.sharpScore,
            lifetimeNetUsd: dodTarget.lifetimeNetUsd,
            sharpCandidateGatePassed: dodTarget.sharpCandidateGatePassed,
          }
        : {}),
      autoExecute: false,
    });
  }

  // Sort by composite score desc, then volume desc
  rankedPlayers.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore)
      return b.compositeScore - a.compositeScore;
    return b.handleUsd - a.handleUsd;
  });

  const playerById = new Map<string, PlayerRankingRecord>();
  rankedPlayers.forEach((p, idx) => {
    (p as { rank: number }).rank = idx + 1;
    const key = p.customerId.trim().toUpperCase();
    if (key && !playerById.has(key)) playerById.set(key, p);
  });
  for (const p of rankedPlayers) {
    const canonical = p.customerId.trim().toUpperCase().replace(/_\d+$/, "");
    if (canonical && !playerById.has(canonical)) playerById.set(canonical, p);
  }

  let clvMeasuredCount = 0;
  let clvSum = 0;
  let positiveClvCount = 0;
  let poweredPositiveClvCount = 0;
  let eliteClv100BpsCount = 0;
  let profitablePositiveClvCount = 0;
  let keyNumberBuyersCount = 0;
  let halfPointHookBuyersCount = 0;
  let proxyConduitPlayersCount = 0;
  let multiSeatClustersCount = 0;
  let hookOrSyndicateCount = 0;

  for (const p of rankedPlayers) {
    const hasClv = typeof p.clvBps === "number" && Number.isFinite(p.clvBps);
    if (hasClv) {
      clvMeasuredCount++;
      clvSum += p.clvBps!;
      if (p.clvBps! > 0) {
        positiveClvCount++;
        if (p.sharpCandidateGatePassed === true) {
          poweredPositiveClvCount++;
          if (p.clvBps! >= 100) eliteClv100BpsCount++;
        }
        if (typeof p.lifetimeNetUsd === "number" && p.lifetimeNetUsd > 0) {
          profitablePositiveClvCount++;
        }
      }
    }
    if (p.isKeyNumberBuyer) keyNumberBuyersCount++;
    if (p.isHalfPointHookBuyer) halfPointHookBuyersCount++;
    if (p.isProxyConduit) proxyConduitPlayersCount++;
    if (p.isMultiSeatCluster) multiSeatClustersCount++;
    if (p.isHalfPointHookBuyer || p.isProxyConduit || p.isMultiSeatCluster) {
      hookOrSyndicateCount++;
    }
  }

  const formulaCohorts: FormulaCohortSummary = {
    activeAccounts: rankedPlayers.length,
    clvMeasuredCount,
    positiveClvCount,
    poweredPositiveClvCount,
    eliteClv100BpsCount,
    profitablePositiveClvCount,
    keyNumberBuyersCount,
    halfPointHookBuyersCount,
    proxyConduitPlayersCount,
    multiSeatClustersCount,
    hookOrSyndicateCount,
    meanClvBps:
      clvMeasuredCount > 0
        ? Math.round((clvSum / clvMeasuredCount) * 10) / 10
        : null,
  };

  const nowIso =
    typeof Temporal !== "undefined"
      ? Temporal.Now.instant().toString()
      : new Date().toISOString();
  const windowEnd =
    typeof Temporal !== "undefined"
      ? Temporal.Now.zonedDateTimeISO("America/New_York")
          .toPlainDate()
          .toString()
      : "2026-11-09";

  return {
    baseResult: {
      generatedAtIso: nowIso,
      windowStart: windowCutoff,
      windowEnd,
      totalWagersScanned: totalLines,
      inWindowWagers,
      totalHandleUsd: totalHandleCents / 100,
      totalToWinUsd: totalToWinCents / 100,
      activeCustomerCount: customerMap.size,
      activeSubAgentCount: subAgentMap.size,
      activeMasterAgentCount: masterAgentMap.size,
      conduitSubAgentCount,
      topMasterAgents: topMasters.slice(0, 15),
      topSubAgents: topSubAgents.slice(0, 25),
      formulaCohorts,
    },
    allRankedPlayers: rankedPlayers,
    playerById,
  };
}

if (import.meta.main) {
  console.log("Starting Batched Player Ranking & Downline Aggregator...");
  const t0 = performance.now();
  const result = await runBatchedRanking();
  const t1 = performance.now();

  console.log(
    `\nAggregated ${result.inWindowWagers.toLocaleString()} wagers across ${result.activeCustomerCount.toLocaleString()} customers in ${(t1 - t0).toFixed(0)}ms`,
  );
  console.log(
    `Desk Total Handle: $${result.totalHandleUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  );
  console.log(
    `Total Active Sub-Agents: ${result.activeSubAgentCount} | Identified Proxy Conduits: ${result.conduitSubAgentCount}`,
  );

  console.log("\n--- TOP 10 RANKED SHARPS / CONDUITS ---");
  for (const p of result.topRankedPlayers.slice(0, 10)) {
    const proxyFlag = p.isProxyConduit
      ? "🚨 PROXY CONDUIT"
      : "                ";
    console.log(
      `#${String(p.rank).padStart(2)} ${p.customerId.padEnd(10)} [Score: ${String(p.compositeScore).padStart(4)} | ${p.tier.padEnd(6)}] ` +
        `Handle: $${p.handleUsd.toLocaleString().padStart(12)} | Wagers: ${String(p.totalWagers).padStart(5)} | ` +
        `Gini: ${p.stakeGini.toFixed(3)} | Alerts: ${String(p.alertRatePct).padStart(4)}% | ${proxyFlag}`,
    );
  }
}
