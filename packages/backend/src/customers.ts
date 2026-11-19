/**
 * @file packages/backend/src/customers.ts
 * @description Indexed customer lookup and dynamic cohort aggregation for `/api/customers*`.
 */

import { resolve } from "node:path";
import type {
  CustomersCohortsSummary,
  DashboardSourceProvenance,
} from "@sportsdesk-ops/contracts";
import { BoundedStampCache, statStamp } from "./cache.ts";

export interface GenericCustomerRow {
  readonly customer_id?: string | undefined;
}

export interface Dod6CustomerLookupHit {
  readonly clvBps: number | null;
  readonly sharpScore: number | null;
  readonly lifetimeNetUsd: number | null;
  readonly clvLegs: number;
  readonly sharpCandidateGatePassed: boolean;
}

export interface RankedPlayerLookupHit {
  readonly customerId: string;
  readonly agentId?: string;
  readonly masterAgent?: string;
  readonly totalWagers?: number;
  readonly avgStakeUsd?: number;
  readonly lastWagerAt?: string;
  readonly dominantSport?: string;
  readonly tierLabel?: string;
  readonly compositeScore?: number;
  readonly recommendedLimitUsd?: number;
  readonly recommendedDelaySeconds?: number;
}

export interface CustomerRowFinderOptions {
  readonly cwd?: string | undefined;
  readonly enrichedPaths?: readonly string[] | undefined;
  readonly profilesPath?: string | undefined;
  readonly backtestPath?: string | undefined;
  readonly dodLookup?:
    | ((
        id: string,
      ) => Promise<Dod6CustomerLookupHit | null> | Dod6CustomerLookupHit | null)
    | undefined;
  readonly rankedLookup?:
    ((id: string) => RankedPlayerLookupHit | null) | undefined;
}

/** Build a stat-cached customer row lookup function over enriched JSON corpora & profiles. */
export function createCustomerRowFinder<
  TRow extends GenericCustomerRow = GenericCustomerRow,
>(options: CustomerRowFinderOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const candidatePaths = options.enrichedPaths ?? [
    resolve(cwd, "enriched_customers_full.json"),
    resolve(cwd, "tests/fixtures/backtest/enriched_customers_full.json"),
    resolve(cwd, "tests/fixtures/verify-load/enriched_customers_full.json"),
  ];
  const profilesPath =
    options.profilesPath ?? resolve(cwd, "data/customer-profiles.json");
  const backtestPath =
    options.backtestPath ?? resolve(cwd, "docs/backtest-4wk-cfb-nba.json");

  const indexCache = new BoundedStampCache<ReadonlyMap<string, TRow>>(8);

  const findCustomerRow = async (id: string): Promise<TRow | null> => {
    const normId = id.trim().toUpperCase();
    if (!normId) return null;

    for (const enrichedPath of candidatePaths) {
      const stamp = await statStamp(enrichedPath);
      if (stamp === null) continue;
      try {
        let byId = indexCache.getIfFresh(enrichedPath, stamp);
        if (!byId) {
          const rows = (await Bun.file(enrichedPath).json()) as TRow[];
          const nextMap = new Map<string, TRow>();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (typeof row.customer_id === "string") {
                const key = row.customer_id.trim().toUpperCase();
                if (key && !nextMap.has(key)) nextMap.set(key, row);
              }
            }
          }
          byId = nextMap;
          indexCache.set(enrichedPath, stamp, byId);
        }
        const found = byId.get(normId);
        if (found) return found;
      } catch {
        // signal-honesty: intentional-fallback-invalid-json-candidate
      }
    }

    const profilesStamp = await statStamp(profilesPath);
    if (profilesStamp !== null) {
      try {
        let byId = indexCache.getIfFresh(profilesPath, profilesStamp);
        if (!byId) {
          const data = (await Bun.file(profilesPath).json()) as {
            profiles?: unknown[];
          };
          const nextMap = new Map<string, TRow>();
          if (Array.isArray(data?.profiles)) {
            for (const profile of data.profiles) {
              // The artifact stores built profiles, not book rows; lift the book aggregates back.
              const row = profileDocumentRow(profile);
              if (row === null) continue;
              const key = row.customer_id.trim().toUpperCase();
              if (key && !nextMap.has(key))
                nextMap.set(key, row as unknown as TRow);
            }
          }
          byId = nextMap;
          indexCache.set(profilesPath, profilesStamp, byId);
        }
        const found = byId.get(normId);
        if (found) return found;
      } catch {
        // signal-honesty: intentional-fallback-invalid-profiles-json
      }
    }

    // 3. Fallback: harvested live profiles. Model-derived, and the artifact publishes no lifetime
    // volume, so the row omits it rather than guessing one from net.
    const harvestedPath = resolve(cwd, "reports/harvested-live-profiles.json");
    const harvestedStamp = await statStamp(harvestedPath);
    if (harvestedStamp !== null) {
      try {
        let byId = indexCache.getIfFresh(harvestedPath, harvestedStamp);
        if (!byId) {
          const data = (await Bun.file(harvestedPath).json()) as {
            profiles?: unknown[];
          };
          const nextMap = new Map<string, TRow>();
          if (Array.isArray(data?.profiles)) {
            for (const profile of data.profiles) {
              const row = harvestedCustomerRow(profile);
              if (row === null) continue;
              const key = row.customer_id.trim().toUpperCase();
              if (key && !nextMap.has(key))
                nextMap.set(key, row as unknown as TRow);
            }
          }
          byId = nextMap;
          indexCache.set(harvestedPath, harvestedStamp, byId);
        }
        const found = byId.get(normId);
        if (found) return found;
      } catch {
        // signal-honesty: intentional-fallback-invalid-harvested-json
      }
    }

    // 3b. Fallback: 4-week backtest leaderboard (`docs/backtest-4wk-cfb-nba.json`).
    const backtestStamp = await statStamp(backtestPath);
    if (backtestStamp !== null) {
      try {
        let byId = indexCache.getIfFresh(backtestPath, backtestStamp);
        if (!byId) {
          const data = (await Bun.file(backtestPath).json()) as {
            customerLeaderboard?: unknown[];
          };
          const nextMap = new Map<string, TRow>();
          if (Array.isArray(data?.customerLeaderboard)) {
            for (const entry of data.customerLeaderboard) {
              const row = backtestCustomerRow(entry, backtestPath);
              if (row === null) continue;
              const key = row.customer_id.trim().toUpperCase();
              if (key && !nextMap.has(key))
                nextMap.set(key, row as unknown as TRow);
            }
          }
          byId = nextMap;
          indexCache.set(backtestPath, backtestStamp, byId);
        }
        const stripped = normId.replace(/_\d+$/, "");
        const found =
          byId.get(normId) ??
          (stripped !== normId ? byId.get(stripped) : undefined);
        if (found) return found;
      } catch {
        // signal-honesty: intentional-fallback-invalid-backtest-json
      }
    }

    // 4. Fallback: open wagers captured tonight. The capture writes { LIST }; its rows are pending
    // tickets, so the row carries identity and the sample but no lifetime aggregates unless DOD6
    // matches the customer's settled lifetime record.
    const liveWagersPath = resolve(cwd, "data/live-wagers.json");
    const liveWagersStamp = await statStamp(liveWagersPath);
    if (liveWagersStamp !== null) {
      try {
        const rows = liveWagerRows(await Bun.file(liveWagersPath).json());
        const row = liveWagersCustomerRow(normId, rows);
        if (row !== null) {
          const ranked = options.rankedLookup?.(normId) ?? null;
          const dod = options.dodLookup
            ? await options.dodLookup(normId)
            : null;
          if (ranked === null && dod === null) {
            return row as unknown as TRow;
          }
          const enriched: SourcedRow = { ...row };
          if (
            enriched.master_agent === undefined &&
            ranked?.masterAgent &&
            ranked.masterAgent.trim() !== ""
          ) {
            enriched.master_agent = ranked.masterAgent.trim();
          }
          if (ranked?.lastWagerAt && enriched.last_active_at === undefined) {
            enriched.last_active_at = ranked.lastWagerAt;
          }
          if (dod !== null) {
            if (
              dod.clvBps !== null &&
              Number.isFinite(dod.clvBps) &&
              enriched.clv_bps === undefined
            ) {
              enriched.clv_bps = dod.clvBps;
            }
            if (dod.clvLegs > 0 && enriched.clv_legs === undefined) {
              enriched.clv_legs = dod.clvLegs;
            }
            if (
              dod.sharpScore !== null &&
              Number.isFinite(dod.sharpScore) &&
              enriched.sharp_score === undefined
            ) {
              enriched.sharp_score = dod.sharpScore;
            }
            if (
              dod.lifetimeNetUsd !== null &&
              Number.isFinite(dod.lifetimeNetUsd) &&
              enriched.lifetime_net_usd === undefined
            ) {
              enriched.lifetime_net_usd = dod.lifetimeNetUsd;
            }
          }
          return enriched as unknown as TRow;
        }
      } catch {
        // signal-honesty: intentional-fallback-invalid-live-wagers-json
      }
    }

    // 5. Fallback: cached 30d rankings and/or DOD6 lifetime binary spine.
    // Signal honesty: 30d handle is never written as lifetime_volume_usd, and
    // recommendedLimitUsd is never written as wager_limit_usd.
    const ranked = options.rankedLookup?.(normId) ?? null;
    const dod = options.dodLookup ? await options.dodLookup(normId) : null;
    if (ranked !== null || dod !== null) {
      const synth: SourcedRow = {
        customer_id: normId,
        provenance: ranked !== null ? "rankings-30d" : "dod6-spine",
        status: "Active",
        recent_tickets: [],
      };
      if (ranked !== null) {
        if (ranked.agentId && ranked.agentId.trim() !== "") {
          synth.agent_id = ranked.agentId.trim();
        }
        if (ranked.masterAgent && ranked.masterAgent.trim() !== "") {
          synth.master_agent = ranked.masterAgent.trim();
        }
        if (
          typeof ranked.totalWagers === "number" &&
          Number.isFinite(ranked.totalWagers) &&
          ranked.totalWagers > 0
        ) {
          synth.total_wagers = ranked.totalWagers;
        }
        if (
          typeof ranked.avgStakeUsd === "number" &&
          Number.isFinite(ranked.avgStakeUsd) &&
          ranked.avgStakeUsd > 0
        ) {
          synth.average_bet_usd = ranked.avgStakeUsd;
        }
        if (ranked.lastWagerAt && ranked.lastWagerAt.trim() !== "") {
          synth.last_active_at = ranked.lastWagerAt.trim();
        }
        if (ranked.dominantSport && ranked.dominantSport.trim() !== "") {
          synth.context_type = ranked.dominantSport.trim();
        }
      }
      if (dod !== null) {
        if (dod.clvBps !== null && Number.isFinite(dod.clvBps)) {
          synth.clv_bps = dod.clvBps;
        }
        if (dod.clvLegs > 0) {
          synth.clv_legs = dod.clvLegs;
        }
        if (dod.sharpScore !== null && Number.isFinite(dod.sharpScore)) {
          synth.sharp_score = dod.sharpScore;
        }
        if (
          dod.lifetimeNetUsd !== null &&
          Number.isFinite(dod.lifetimeNetUsd)
        ) {
          synth.lifetime_net_usd = dod.lifetimeNetUsd;
        }
      }
      return synth as unknown as TRow;
    }

    return null;
  };

  return {
    findCustomerRow,
    clearCache: () => indexCache.clear(),
  };
}

type JsonRow = Record<string, unknown>;

/** A synthesized row: `customer_id` is required; every other field is optional and unmeasured unless mapped. */
type SourcedRow = Record<string, unknown> & { customer_id: string };

const jsonRow = (value: unknown): JsonRow | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRow)
    : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmptyText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const jsonRows = (value: unknown): readonly JsonRow[] =>
  Array.isArray(value)
    ? value.filter((row): row is JsonRow => jsonRow(row) !== null)
    : [];

/**
 * `data/customer-profiles.json` stores built profiles, not book rows. Lift the book aggregates back
 * into the row field names every other source uses; the ticket sample is not stored there.
 */
export function profileDocumentRow(value: unknown): SourcedRow | null {
  const profile = jsonRow(value);
  if (!profile) return null;
  const id =
    nonEmptyText(profile.customer_id) ?? nonEmptyText(profile.customerId);
  if (id === null) return null;
  const book = jsonRow(profile.book);
  if (book === null) {
    // A row-shaped entry (fixture or older artifact): keep its fields, normalize the id only.
    return { ...profile, customer_id: id };
  }
  const volume = finiteNumber(book.lifetimeVolumeUsd);
  const net = finiteNumber(book.lifetimeNetUsd);
  const hold = finiteNumber(book.holdPct);
  const clv = finiteNumber(book.clvBps);
  const sharp = finiteNumber(book.sharpScore);
  const limit = finiteNumber(book.wagerLimitUsd);
  const delay = finiteNumber(book.delaySeconds);
  const agent = nonEmptyText(profile.agentId);
  const masterAgent = nonEmptyText(profile.masterAgent);
  const status = nonEmptyText(profile.status);
  const contextType = nonEmptyText(profile.contextType);
  return {
    customer_id: id.toUpperCase(),
    ...(agent === null ? {} : { agent_id: agent }),
    ...(masterAgent === null ? {} : { master_agent: masterAgent }),
    ...(status === null ? {} : { status }),
    ...(contextType === null ? {} : { context_type: contextType }),
    ...(volume === null ? {} : { lifetime_volume_usd: volume }),
    ...(net === null ? {} : { lifetime_net_usd: net }),
    ...(hold === null ? {} : { hold_pct: hold }),
    ...(clv === null ? {} : { clv_bps: clv }),
    ...(sharp === null ? {} : { sharp_score: sharp }),
    ...(limit === null ? {} : { wager_limit_usd: limit }),
    ...(delay === null ? {} : { delay_seconds: delay }),
  };
}

/** The capture writes `LIST`; a bare array and the older `wagers` shape are still accepted. */
function liveWagerRows(raw: unknown): readonly JsonRow[] {
  const direct = jsonRows(raw);
  if (direct.length > 0) return direct;
  const doc = jsonRow(raw);
  if (!doc) return [];
  for (const key of ["LIST", "wagers"]) {
    const rows = jsonRows(doc[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

function liveWagerCustomerId(row: JsonRow): string | null {
  return (
    (
      nonEmptyText(row.CustomerID) ??
      nonEmptyText(row.customerId) ??
      nonEmptyText(row.Login) ??
      nonEmptyText(row.login)
    )?.toUpperCase() ?? null
  );
}

function liveTicket(row: JsonRow): Record<string, unknown> {
  const risk =
    finiteNumber(row.AmountWagered) ?? finiteNumber(row.amountWagered);
  const toWin = finiteNumber(row.ToWinAmount) ?? finiteNumber(row.toWinAmount);
  const number = finiteNumber(row.WagerNumber) ?? finiteNumber(row.wagerNumber);
  const writer =
    nonEmptyText(row.TicketWriter) ?? nonEmptyText(row.ticketWriter);
  const placedAt =
    nonEmptyText(row.InsertDateTime) ?? nonEmptyText(row.insertedAt);
  const selection = nonEmptyText(row.ShortDesc) ?? nonEmptyText(row.shortDesc);
  return {
    ...(number === null ? {} : { wager_number: number }),
    ...(risk === null ? {} : { risk_usd: risk }),
    ...(toWin === null ? {} : { win_usd: toWin }),
    ...(selection === null ? {} : { selection }),
    ...(writer === null ? {} : { channel: writer }),
    ...(placedAt === null ? {} : { placed_at: placedAt }),
  };
}

/**
 * Map one harvested profile. `ltvUsd` is the DOD6 lifetime net and `dodClvBps` is null when CLV
 * was never measured; the harvester publishes no lifetime volume, so that field stays absent.
 */
export function harvestedCustomerRow(value: unknown): SourcedRow | null {
  const profile = jsonRow(value);
  if (!profile) return null;
  const id = nonEmptyText(profile.id) ?? nonEmptyText(profile.canonicalId);
  if (id === null) return null;
  const agent = nonEmptyText(profile.agentId);
  const masterAgent = nonEmptyText(profile.masterAgent);
  const net = finiteNumber(profile.ltvUsd);
  const hold = finiteNumber(profile.holdPct);
  const clv = finiteNumber(profile.dodClvBps);
  const sharp = finiteNumber(profile.dodSharpScore);
  const tickets: Record<string, unknown>[] = [];
  for (const sample of jsonRows(profile.sampleWagers)) {
    const netUsd = finiteNumber(sample.netUsd);
    const riskUsd = finiteNumber(sample.stakeUsd);
    const league = nonEmptyText(sample.sport);
    const market = nonEmptyText(sample.market);
    const selection = nonEmptyText(sample.line);
    const placedAt = nonEmptyText(sample.time);
    const result =
      netUsd === null ? null : netUsd > 0 ? "WIN" : netUsd < 0 ? "LOSS" : null;
    tickets.push({
      ...(league === null ? {} : { league }),
      ...(market === null ? {} : { market }),
      ...(selection === null ? {} : { selection }),
      ...(riskUsd === null ? {} : { risk_usd: riskUsd }),
      ...(netUsd === null ? {} : { net_usd: netUsd }),
      ...(result === null ? {} : { result }),
      ...(placedAt === null ? {} : { placed_at: placedAt }),
    });
  }
  return {
    customer_id: id.toUpperCase(),
    provenance: "harvested-live-profiles",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    ...(masterAgent === null ? {} : { master_agent: masterAgent }),
    ...(net === null ? {} : { lifetime_net_usd: net }),
    ...(hold === null ? {} : { hold_pct: hold }),
    ...(clv === null ? {} : { clv_bps: clv }),
    ...(sharp === null ? {} : { sharp_score: sharp }),
    recent_tickets: tickets,
  };
}

function backtestCustomerRow(
  value: unknown,
  sourcePath: string,
): SourcedRow | null {
  const rec = jsonRow(value);
  if (!rec) return null;
  const id =
    nonEmptyText(rec.customerId) ??
    nonEmptyText(rec.customer_id) ??
    nonEmptyText(rec.id);
  if (id === null) return null;

  const totalWagers =
    finiteNumber(rec.totalParlayTickets) ??
    finiteNumber(rec.totalWagers) ??
    finiteNumber(rec.tickets);
  const volume =
    finiteNumber(rec.totalParlayHandleUsd) ??
    finiteNumber(rec.totalRiskUsd) ??
    finiteNumber(rec.riskUsd) ??
    finiteNumber(rec.volumeUsd);
  const net =
    finiteNumber(rec.baselineDeskNetUsd) ??
    finiteNumber(rec.netUsd) ??
    finiteNumber(rec.pnlUsd);
  const hold = finiteNumber(rec.baselineHoldPct) ?? finiteNumber(rec.holdPct);
  const clv = finiteNumber(rec.avgClvBps) ?? finiteNumber(rec.clvBps);
  const sharp = finiteNumber(rec.sharpScore) ?? finiteNumber(rec.score);
  const explicitAvgBet =
    finiteNumber(rec.averageBetUsd) ??
    finiteNumber(rec.avgStakeUsd) ??
    finiteNumber(rec.avgRiskUsd);
  const avgBet =
    explicitAvgBet ??
    (volume !== null && totalWagers !== null && totalWagers > 0
      ? Math.round((volume / totalWagers) * 100) / 100
      : null);
  const agent = nonEmptyText(rec.agentId);
  const masterAgent = nonEmptyText(rec.masterAgent);
  const contextType =
    nonEmptyText(rec.contextType) ??
    nonEmptyText(rec.archetype) ??
    nonEmptyText(rec.tier);
  const lastActiveAt = nonEmptyText(rec.lastActiveAt);

  return {
    customer_id: id.toUpperCase(),
    provenance: "backtest-leaderboard",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    ...(masterAgent === null ? {} : { master_agent: masterAgent }),
    ...(contextType === null ? {} : { context_type: contextType }),
    ...(totalWagers === null ? {} : { total_wagers: totalWagers }),
    ...(volume === null ? {} : { lifetime_volume_usd: volume }),
    ...(net === null ? {} : { lifetime_net_usd: net }),
    ...(hold === null ? {} : { hold_pct: hold }),
    ...(clv === null ? {} : { clv_bps: clv }),
    ...(sharp === null ? {} : { sharp_score: sharp }),
    ...(avgBet === null ? {} : { average_bet_usd: avgBet }),
    ...(lastActiveAt === null ? {} : { last_active_at: lastActiveAt }),
    recent_tickets: [],
    backtest_source_path: sourcePath,
  };
}

function liveWagersCustomerRow(
  customerId: string,
  rows: readonly JsonRow[],
): SourcedRow | null {
  const id = customerId.trim().toUpperCase();
  if (id === "") return null;
  const mine: JsonRow[] = [];
  for (const row of rows) {
    if (liveWagerCustomerId(row) === id) mine.push(row);
  }
  if (mine.length === 0) return null;
  let agent: string | null = null;
  const tickets: Record<string, unknown>[] = [];
  for (const row of mine) {
    agent ??=
      nonEmptyText(row.AgentID) ??
      nonEmptyText(row.agentId) ??
      nonEmptyText(row.AgentLogin);
    if (tickets.length < 10) tickets.push(liveTicket(row));
  }
  return {
    customer_id: id,
    provenance: "live-wagers",
    status: "Active",
    ...(agent === null ? {} : { agent_id: agent }),
    recent_tickets: tickets,
  };
}

export interface CustomersCohortInput {
  readonly backtestLeaderboard: ReadonlyArray<Record<string, unknown>>;
  readonly fixtures: ReadonlyArray<Record<string, unknown>>;
  readonly keyNumberBuyerIds: Iterable<string>;
  readonly hookSyndicateIds: Iterable<string>;
  readonly localBookRows?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly provenance?: DashboardSourceProvenance | undefined;
}

export interface CustomersCohortPayload {
  readonly cohorts: CustomersCohortsSummary;
  readonly backtestTop: ReadonlyArray<Record<string, unknown>>;
  /** Every backtest-cohort customer, not just the leaderboard's top 20. */
  readonly backtestAll: ReadonlyArray<Record<string, unknown>>;
  readonly fixtures: ReadonlyArray<Record<string, unknown>>;
  readonly book?: ReadonlyArray<Record<string, unknown>>;
  readonly provenance: DashboardSourceProvenance;
}

/** Dynamically compute surveillance cohort counts with zero hardcoded numbers. */
export function computeCustomersCohortPayload(
  input: CustomersCohortInput,
): CustomersCohortPayload {
  const uniqueSurveillanceIds = new Set<string>();
  const keyNumberSet = new Set<string>();
  const hookSyndicateSet = new Set<string>();

  for (const row of input.backtestLeaderboard) {
    const id = row.customer ?? row.customerId ?? row.customer_id;
    if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
  }
  for (const row of input.fixtures) {
    const id = row.customer_id ?? row.customerId;
    if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
  }
  if (input.localBookRows) {
    for (const row of input.localBookRows) {
      const id = row.customer_id ?? row.customerId;
      if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
    }
  }
  for (const key of input.keyNumberBuyerIds) {
    const norm = key.trim().toUpperCase();
    if (norm) {
      keyNumberSet.add(norm);
      uniqueSurveillanceIds.add(norm);
    }
  }
  for (const key of input.hookSyndicateIds) {
    const norm = key.trim().toUpperCase();
    if (norm) {
      hookSyndicateSet.add(norm);
      uniqueSurveillanceIds.add(norm);
    }
  }

  const nowIso = new Date().toISOString();
  const localBookRows =
    input.localBookRows && input.localBookRows.length > 0
      ? input.localBookRows
      : undefined;
  const hasLocalBook = localBookRows !== undefined;
  const provenance: DashboardSourceProvenance =
    input.provenance ??
    (hasLocalBook
      ? {
          kind: "capture",
          label: "Enriched Local Book + Backtest",
          sourcePath: "enriched_customers_full.json",
          observedAt: nowIso,
        }
      : input.backtestLeaderboard.length > 0 || input.fixtures.length > 0
        ? {
            kind: "fixture",
            label: "Backtest & Synthetic Fixtures",
            sourcePath: "tests/fixtures/backtest/enriched_customers_full.json",
            observedAt: nowIso,
          }
        : {
            kind: "unavailable",
            label: "No Customer Corpora Found",
            sourcePath: null,
            observedAt: nowIso,
          });

  return {
    cohorts: {
      backtestCount: input.backtestLeaderboard.length,
      keyNumberSharpsCount: keyNumberSet.size,
      hookSyndicateCount: hookSyndicateSet.size,
      fixtureCount: input.fixtures.length,
      fullBookSpecCount: hasLocalBook
        ? input.localBookRows!.length
        : input.fixtures.length,
      uniqueSurveillanceCount: uniqueSurveillanceIds.size,
    },
    backtestTop: input.backtestLeaderboard.slice(0, 20),
    backtestAll: input.backtestLeaderboard,
    fixtures: input.fixtures,
    ...(localBookRows ? { book: localBookRows } : {}),
    provenance,
  };
}
