/**
 * @file lib/terminal_customer_resolve.ts
 * @description Resolve terminal `profile` targets from book corpora, rankings, and live wagers
 * (same sources as `/api/customers/*`), not only the static KNOWN_CUSTOMERS demo matrix.
 *
 * Customer **tiers** follow ranked wager data (`calculateCompositeScore` / 30d rankings), or
 * explicit `tier` / `tierLabel` on the book row — never hardcoded sharp_score cutoffs.
 */

import { resolve } from "node:path";
import { createCustomerRowFinder } from "../packages/backend/src/customers.ts";
import { runBatchedRanking } from "./customer_rankings.ts";
import { liveWagerCustomerId, liveWagerRows } from "./customer_source_rows.ts";
import {
  calculateCompositeScore,
  type CustomerAccumulator,
} from "../scripts/batch_rank_all_players.ts";
import type { PlayerRankingRecord } from "../scripts/batch_rank_all_players.ts";
import type { TerminalCustomerRecord } from "./terminal_emulator.ts";

type JsonRow = Record<string, unknown>;

type CompositeScoring = ReturnType<typeof calculateCompositeScore>;

let _finder: ReturnType<typeof createCustomerRowFinder<JsonRow>> | null = null;
let _rankingCache: Promise<readonly PlayerRankingRecord[]> | null = null;
let _liveWagersCache: Promise<readonly JsonRow[]> | null = null;

function customerRowFinder(): ReturnType<
  typeof createCustomerRowFinder<JsonRow>
> {
  if (_finder === null) {
    _finder = createCustomerRowFinder<JsonRow>();
  }
  return _finder;
}

function rankingPlayers(): Promise<readonly PlayerRankingRecord[]> {
  if (_rankingCache === null) {
    _rankingCache = runBatchedRanking({ limitPlayers: 500 })
      .then((r) => r.topRankedPlayers)
      .catch((err) => {
        _rankingCache = null;
        throw err;
      });
  }
  return _rankingCache;
}

async function allLiveWagerRows(): Promise<readonly JsonRow[]> {
  if (_liveWagersCache === null) {
    _liveWagersCache = (async () => {
      const path = resolve(process.cwd(), "data/live-wagers.json");
      const file = Bun.file(path);
      if (!(await file.exists())) return [];
      try {
        return liveWagerRows(await file.json());
      } catch {
        return [];
      }
    })();
  }
  return _liveWagersCache;
}

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmptyText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

function str(row: JsonRow, key: string, fallback = "—"): string {
  return nonEmptyText(row[key]) ?? fallback;
}

function clvBpsToScore(clvBps: number | null): number {
  if (clvBps === null) return 0.8;
  return Math.min(3, Math.max(0, clvBps / 40));
}

function sportFromShortDesc(desc: string): string {
  if (
    desc.includes("Football") ||
    desc.includes("NFL") ||
    desc.includes("CFB")
  ) {
    return "FOOTBALL";
  }
  if (desc.includes("Basketball") || desc.includes("NBA")) return "BASKETBALL";
  if (desc.includes("Hockey") || desc.includes("NHL")) return "HOCKEY";
  if (desc.includes("Tennis")) return "TENNIS";
  if (desc.includes("Baseball") || desc.includes("MLB")) return "BASEBALL";
  return "OTHER";
}

function ingestWagerIntoAccumulator(
  acc: CustomerAccumulator,
  rec: JsonRow,
): void {
  const dt =
    nonEmptyText(rec.InsertDateTime) ??
    nonEmptyText(rec.insertedAt) ??
    nonEmptyText(rec.placed_at) ??
    "";
  const stakeCents = Math.round(
    (finiteNumber(rec.AmountWagered) ??
      finiteNumber(rec.amountWagered) ??
      finiteNumber(rec.risk_usd) ??
      0) * 100,
  );
  const toWinCents = Math.round(
    (finiteNumber(rec.ToWinAmount) ??
      finiteNumber(rec.toWinAmount) ??
      finiteNumber(rec.win_usd) ??
      stakeCents / 100) * 100,
  );
  const writer =
    nonEmptyText(rec.TicketWriter) ??
    nonEmptyText(rec.ticketWriter) ??
    nonEmptyText(rec.channel) ??
    "";
  const isAlert = writer.includes("ALERT");
  const isBlocked = writer.includes("BLOCKED");

  acc.wagerCount++;
  acc.handleCents += stakeCents;
  acc.toWinCents += toWinCents;
  if (isAlert) acc.alertCount++;
  if (isBlocked) acc.blockedCount++;
  if (acc.stakesSample.length < 500) {
    acc.stakesSample.push(stakeCents / 100);
  }
  if (dt && (!acc.minDate || dt < acc.minDate)) acc.minDate = dt;
  if (dt && (!acc.maxDate || dt > acc.maxDate)) acc.maxDate = dt;

  const selectionText = nonEmptyText(rec.selection);
  const wt =
    nonEmptyText(rec.WagerType) ??
    nonEmptyText(rec.wager_type) ??
    (selectionText !== null && selectionText.includes("\r\n") ? "P" : "S");
  acc.types[wt] = (acc.types[wt] ?? 0) + 1;

  const desc =
    nonEmptyText(rec.ShortDesc) ??
    nonEmptyText(rec.shortDesc) ??
    nonEmptyText(rec.selection) ??
    "";
  const sp = sportFromShortDesc(desc);
  acc.sports[sp] = (acc.sports[sp] ?? 0) + 1;
}

function emptyAccumulator(login: string, row: JsonRow): CustomerAccumulator {
  const agent = str(row, "agent_id", "UNKNOWN");
  return {
    login,
    agentId: agent,
    masterAgent: str(row, "master_agent", agent),
    wagerCount: 0,
    handleCents: 0,
    toWinCents: 0,
    alertCount: 0,
    blockedCount: 0,
    stakesSample: [],
    types: {},
    sports: {},
    minDate: "",
    maxDate: "",
  };
}

function accumulatorFromBookTickets(
  login: string,
  row: JsonRow,
): CustomerAccumulator | null {
  const tickets = row.recent_tickets;
  if (!Array.isArray(tickets) || tickets.length === 0) return null;
  const acc = emptyAccumulator(login, row);
  for (const raw of tickets) {
    if (typeof raw !== "object" || raw === null) continue;
    ingestWagerIntoAccumulator(acc, raw as JsonRow);
  }
  return acc.wagerCount > 0 ? acc : null;
}

async function accumulatorFromLiveCapture(
  login: string,
  row: JsonRow,
): Promise<CustomerAccumulator | null> {
  const rows = await allLiveWagerRows();
  if (rows.length === 0) return null;
  const acc = emptyAccumulator(login, row);
  for (const wager of rows) {
    if (liveWagerCustomerId(wager) !== login) continue;
    ingestWagerIntoAccumulator(acc, wager);
  }
  return acc.wagerCount > 0 ? acc : null;
}

async function compositeScoringFromRow(
  login: string,
  row: JsonRow,
): Promise<CompositeScoring | null> {
  const provenance = nonEmptyText(row.provenance);
  const acc =
    provenance === "live-wagers"
      ? await accumulatorFromLiveCapture(login, row)
      : (accumulatorFromBookTickets(login, row) ??
        (await accumulatorFromLiveCapture(login, row)));
  return acc === null ? null : calculateCompositeScore(acc);
}

function tierLabelFromData(
  row: JsonRow,
  scoring: CompositeScoring | null,
): { tier: string; archetype: string } {
  const explicitTier =
    nonEmptyText(row.tier) ??
    nonEmptyText(row.tierLabel) ??
    nonEmptyText(row.context_type);
  if (explicitTier) {
    return {
      tier: explicitTier,
      archetype:
        nonEmptyText(row.context_type) ?? scoring?.tierLabel ?? explicitTier,
    };
  }
  if (scoring) {
    return { tier: scoring.tier, archetype: scoring.tierLabel };
  }
  return { tier: "UNRANKED", archetype: "PENDING_WAGER_SAMPLE" };
}

function actionFromTier(
  tier: string,
  scoring: CompositeScoring | null,
): string {
  if (scoring) {
    return scoring.tier === "TIER_1" || scoring.tier === "TIER_2"
      ? "ALERT_OPERATOR"
      : "MONITOR";
  }
  if (tier.includes("TIER_1") || tier.includes("ELITE"))
    return "ALERT_OPERATOR";
  if (tier.includes("TIER_2") || tier.includes("STEAM"))
    return "ALERT_OPERATOR";
  return "MONITOR";
}

function sampleWagersFromTickets(
  tickets: unknown,
): TerminalCustomerRecord["sampleWagers"] {
  if (!Array.isArray(tickets)) return undefined;
  const out: NonNullable<TerminalCustomerRecord["sampleWagers"]>[number][] = [];
  for (const raw of tickets) {
    if (typeof raw !== "object" || raw === null) continue;
    const t = raw as JsonRow;
    const sport = nonEmptyText(t.league) ?? nonEmptyText(t.sport) ?? "—";
    const market = nonEmptyText(t.market) ?? "—";
    const line = nonEmptyText(t.selection) ?? nonEmptyText(t.line) ?? "—";
    const stakeUsd = finiteNumber(t.risk_usd) ?? finiteNumber(t.stakeUsd) ?? 0;
    const netUsd =
      finiteNumber(t.net_usd) ??
      finiteNumber(t.netUsd) ??
      (finiteNumber(t.win_usd) ?? 0) - stakeUsd;
    out.push({
      sport,
      market,
      line: line.length > 48 ? `${line.slice(0, 45)}…` : line,
      clvBps: finiteNumber(t.clv_bps) ?? 0,
      stakeUsd,
      netUsd,
      time: nonEmptyText(t.placed_at) ?? nonEmptyText(t.time) ?? "—",
    });
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : undefined;
}

async function bookRowToTerminal(
  row: JsonRow,
  rankingPlayer?: PlayerRankingRecord,
): Promise<TerminalCustomerRecord> {
  const id = str(row, "customer_id", "UNKNOWN").toUpperCase();
  const scoring =
    rankingPlayer === undefined ? await compositeScoringFromRow(id, row) : null;
  const { tier, archetype } =
    rankingPlayer !== undefined
      ? { tier: rankingPlayer.tier, archetype: rankingPlayer.tierLabel }
      : tierLabelFromData(row, scoring);
  const sharp = finiteNumber(row.sharp_score);
  const score =
    rankingPlayer?.compositeScore ??
    scoring?.score ??
    (sharp !== null ? Math.min(10, Math.max(0, sharp / 10)) : 5);
  const clvBps = finiteNumber(row.clv_bps);
  const ltv = finiteNumber(row.lifetime_net_usd) ?? 0;
  const hold = finiteNumber(row.hold_pct) ?? 0;
  const volume = finiteNumber(row.lifetime_volume_usd) ?? 0;

  const gini =
    rankingPlayer?.stakeGini ??
    (scoring ? Math.max(0, 1 - (scoring.shadowCopy > 0 ? 0.15 : 0.35)) : 0.2);
  const meanStake =
    rankingPlayer?.avgStakeUsd ??
    (volume > 0 && Array.isArray(row.recent_tickets)
      ? volume / Math.max(1, row.recent_tickets.length)
      : 0);

  return {
    id,
    name: str(row, "name", `Book customer ${id}`),
    agentId: rankingPlayer?.agentId ?? str(row, "agent_id", "—"),
    masterAgent:
      rankingPlayer?.masterAgent ??
      str(row, "master_agent", str(row, "agent_id", "—")),
    tier,
    score,
    clvScore: clvBpsToScore(clvBps),
    skillScore: Math.min(2.5, score * 0.28),
    sizingScore: Math.min(1.5, Math.max(0.3, 1.5 - gini * 0.8)),
    sigScore: Math.min(
      2,
      rankingPlayer ? 1 + rankingPlayer.alertRatePct / 100 : 1.2,
    ),
    timingScore: archetype.includes("SNIPER") ? 0.9 : 0.6,
    correlatedScore: rankingPlayer?.isProxyConduit ? 0.8 : 0.4,
    sizingStrategy:
      gini > 0.35
        ? "VARIABLE_STAKE"
        : scoring
          ? "RANKING_DERIVED"
          : "BOOK_DERIVED",
    gini,
    meanStake,
    maxMinRatio:
      rankingPlayer && rankingPlayer.medianStakeUsd > 0
        ? rankingPlayer.maxStakeUsd / rankingPlayer.medianStakeUsd
        : 2,
    specialization:
      rankingPlayer !== undefined
        ? `${rankingPlayer.dominantSport} · ${rankingPlayer.dominantBetType}`
        : archetype,
    timingArchetype: archetype,
    correlatedRisk: rankingPlayer?.isProxyConduit ? "HIGH" : "MODERATE",
    correlatedExploitRate: rankingPlayer
      ? rankingPlayer.alertRatePct / 100
      : 0.25,
    syndicateRisk: rankingPlayer?.isProxyConduit ? "HIGH" : "ELEVATED",
    syndicateProb: rankingPlayer?.isProxyConduit ? 0.75 : 0.35,
    subAccountIndex: null,
    var95Usd: Math.max(
      1000,
      rankingPlayer?.handleUsd
        ? rankingPlayer.handleUsd * 0.05
        : Math.abs(ltv) * 0.15,
    ),
    cvar95Usd: Math.max(
      1500,
      rankingPlayer?.handleUsd
        ? rankingPlayer.handleUsd * 0.08
        : Math.abs(ltv) * 0.2,
    ),
    holdPct: hold,
    ltvUsd: rankingPlayer
      ? rankingPlayer.toWinUsd - rankingPlayer.handleUsd
      : ltv,
    recommendedLimitUsd:
      rankingPlayer?.recommendedLimitUsd ??
      scoring?.limitUsd ??
      finiteNumber(row.wager_limit_usd) ??
      500,
    inPlayDelaySec:
      rankingPlayer?.recommendedDelaySeconds ??
      scoring?.delaySec ??
      finiteNumber(row.delay_seconds) ??
      3,
    lineShadeCents:
      rankingPlayer?.recommendedLineShadeCents ?? scoring?.shadeCents ?? 10,
    shadowCopyMultiplier:
      rankingPlayer?.shadowCopyRatio ?? scoring?.shadowCopy ?? 0.75,
    action: actionFromTier(tier, scoring),
    ipAddress: str(row, "ip_subnet", "—").split("/")[0] ?? "—",
    sampleWagers: sampleWagersFromTickets(row.recent_tickets),
  };
}

function playerToTerminal(player: PlayerRankingRecord): TerminalCustomerRecord {
  const score = Math.min(10, Math.max(0, player.compositeScore));
  return {
    id: player.customerId.toUpperCase(),
    name: `Ranked player ${player.customerId}`,
    agentId: player.agentId,
    masterAgent: player.masterAgent,
    tier: player.tier,
    score,
    clvScore: Math.min(3, score * 0.32),
    skillScore: Math.min(2.5, score * 0.26),
    sizingScore: Math.min(1.5, 1.5 - player.stakeGini * 0.5),
    sigScore: Math.min(2, 1 + player.alertRatePct / 100),
    timingScore: 0.7,
    correlatedScore: player.isProxyConduit ? 0.8 : 0.4,
    sizingStrategy: player.stakeGini > 0.35 ? "VARIABLE_STAKE" : "FLAT_UNIT",
    gini: player.stakeGini,
    meanStake: player.avgStakeUsd,
    maxMinRatio:
      player.medianStakeUsd > 0
        ? player.maxStakeUsd / player.medianStakeUsd
        : 2,
    specialization: `${player.dominantSport} · ${player.dominantBetType}`,
    timingArchetype: player.tierLabel,
    correlatedRisk: player.isProxyConduit ? "HIGH" : "MODERATE",
    correlatedExploitRate: player.alertRatePct / 100,
    syndicateRisk: player.isProxyConduit ? "HIGH" : "ELEVATED",
    syndicateProb: player.isProxyConduit ? 0.75 : 0.4,
    subAccountIndex: null,
    var95Usd: Math.max(1000, player.handleUsd * 0.05),
    cvar95Usd: Math.max(1500, player.handleUsd * 0.08),
    holdPct: 0,
    ltvUsd: player.toWinUsd - player.handleUsd,
    recommendedLimitUsd: player.recommendedLimitUsd,
    inPlayDelaySec: player.recommendedDelaySeconds,
    lineShadeCents: player.recommendedLineShadeCents,
    shadowCopyMultiplier: player.shadowCopyRatio,
    action:
      player.tier === "TIER_1" || player.tier === "TIER_2"
        ? "ALERT_OPERATOR"
        : "MONITOR",
    ipAddress: "—",
  };
}

/**
 * Resolve a customer id for terminal profile rendering from local book corpora and rankings.
 */
export async function resolveTerminalCustomer(
  customerId: string,
): Promise<TerminalCustomerRecord | null> {
  const norm = customerId.trim().toUpperCase();
  if (!norm) return null;

  let rankingPlayer: PlayerRankingRecord | undefined;
  try {
    const players = await rankingPlayers();
    rankingPlayer = players.find(
      (p) => p.customerId.trim().toUpperCase() === norm,
    );
  } catch {
    // signal-honesty: rankings artifact optional for terminal profile
  }

  const row = await customerRowFinder().findCustomerRow(norm);
  if (row !== null) {
    return bookRowToTerminal(row, rankingPlayer);
  }

  if (rankingPlayer !== undefined) {
    return playerToTerminal(rankingPlayer);
  }

  return null;
}

/** Test-only: drop in-memory resolver caches. */
export function clearTerminalCustomerResolveCache(): void {
  _rankingCache = null;
  _liveWagersCache = null;
  _finder?.clearCache();
}
