/**
 * @file packages/backend/src/bet_ticker.ts
 * @description Bet-Ticker (`getBetTicker` + `Report/Pending` + R2 Bridge 3a) service with sentinel `ALERT`/`BLOCKED` twin exclusion.
 */

import { basename, relative, resolve } from "node:path";
import type {
  BetTickerApiResponse,
  BetTickerBridge3aSnapshot,
  BetTickerCaptureHealthSummary,
  BetTickerChannelBucket,
  BetTickerPendingGamesSummary,
  BetTickerTicketRow,
  BetTickerTypeBucket,
  DashboardSourceProvenance,
} from "@sportsdesk-ops/contracts";
import { BoundedStampCache, statStamp } from "./cache.ts";
import {
  classifyWagerCandidateSource,
  isSentinelTickerWriter,
  type ParsedShortDescLike,
} from "./wagers.ts";

const WAGER_TYPE_LABELS: Readonly<Record<string, string>> = {
  S: "Spread",
  M: "Moneyline",
  P: "Parlay",
  L: "Live / Alt",
  T: "Teaser",
  I: "If-Bet",
  C: "Contest / Futures",
};

function labelForWagerType(code: string): string {
  const upper = code.trim().toUpperCase();
  return WAGER_TYPE_LABELS[upper] ?? (upper || "Unknown");
}

function toCents(rawDollarOrCents: unknown): number {
  const parsed = Number(rawDollarOrCents);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function normalizeWriterKey(ticketWriter: string): string {
  const trimmed = ticketWriter.trim();
  return trimmed || "Unknown";
}

function countLegsFromShortDesc(
  rawDesc: string,
  parsedLegsCount: number,
): number {
  if (parsedLegsCount > 0) return parsedLegsCount;
  const nonEmptyLines = rawDesc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[A-Z]\.G?\d+/i.test(l));
  return Math.max(1, nonEmptyLines.length);
}

export interface BetTickerServiceOptions {
  readonly cwd?: string | undefined;
  readonly candidatePaths?: readonly string[] | undefined;
  readonly pendingBetsPath?: string | undefined;
  readonly captureHealthPath?: string | undefined;
  readonly parseShortDesc: (raw: unknown) => ParsedShortDescLike;
  readonly getSharpCustomerIds: () =>
    Promise<ReadonlySet<string>> | ReadonlySet<string>;
  readonly getBridge3aSnapshot?:
    (() => Promise<BetTickerBridge3aSnapshot>) | undefined;
}

interface CachedCaptureData {
  readonly rawList: readonly Record<string, unknown>[];
  readonly observedAt: string | null;
  readonly provenanceBase: Omit<DashboardSourceProvenance, "observedAt">;
}

export function createBetTickerService(options: BetTickerServiceOptions) {
  const cwd = options.cwd ?? process.cwd();
  const candidatePaths = options.candidatePaths ?? [
    resolve(cwd, "data/live-wagers.json"),
    resolve(cwd, "tests/fixtures/live-wagers.partial.json"),
    resolve(cwd, "tests/fixtures/live-wagers-LIST-100.json"),
    resolve(cwd, "tests/fixtures/live-wagers-list-sample.json"),
  ];
  const pendingBetsPath =
    options.pendingBetsPath ?? resolve(cwd, "data/live-bets.json");
  const captureHealthPath =
    options.captureHealthPath ?? resolve(cwd, "data/capture-health.json");

  const captureCache = new BoundedStampCache<CachedCaptureData>(8);
  const pendingCache = new BoundedStampCache<BetTickerPendingGamesSummary>(4);
  const healthCache = new BoundedStampCache<BetTickerCaptureHealthSummary>(4);

  function safeRelPath(absPath: string): string {
    const rel = relative(cwd, absPath).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") && !rel.startsWith("/")
      ? rel
      : basename(absPath);
  }

  async function loadCaptureFeed(): Promise<CachedCaptureData | null> {
    for (const candidatePath of candidatePaths) {
      const stamp = await statStamp(candidatePath);
      if (stamp === null) continue;
      const hit = captureCache.getIfFresh(candidatePath, stamp);
      if (hit !== undefined) return hit;

      try {
        const json = (await Bun.file(candidatePath).json()) as
          | {
              observedAt?: unknown;
              LIST?: unknown;
              wagers?: unknown;
            }
          | unknown[]
          | null;
        const list = Array.isArray(json)
          ? json
          : Array.isArray(json?.LIST)
            ? json.LIST
            : Array.isArray(json?.wagers)
              ? json.wagers
              : null;
        if (!list || list.length === 0) continue;

        const desc = classifyWagerCandidateSource(candidatePath, cwd);
        const obs =
          !Array.isArray(json) && typeof json?.observedAt === "string"
            ? json.observedAt
            : null;
        const cached: CachedCaptureData = {
          rawList: list.filter(
            (row): row is Record<string, unknown> =>
              typeof row === "object" && row !== null,
          ),
          observedAt: obs,
          provenanceBase: {
            kind: desc.kind,
            label: desc.label,
            sourcePath: desc.sourcePath,
          },
        };
        captureCache.set(candidatePath, stamp, cached);
        return cached;
      } catch {
        // signal-honesty: intentional-fallback-next-bet-ticker-capture
      }
    }
    return null;
  }

  async function loadPendingSummary(): Promise<BetTickerPendingGamesSummary> {
    const stamp = await statStamp(pendingBetsPath);
    if (stamp === null) {
      return {
        available: false,
        gameCount: 0,
        pendingCount: 0,
        totalWageredCents: 0,
        totalToWinCents: 0,
        capturedAt: null,
        dataSource: null,
        sourcePath: null,
      };
    }
    const hit = pendingCache.getIfFresh(pendingBetsPath, stamp);
    if (hit !== undefined) return hit;

    try {
      const json = (await Bun.file(pendingBetsPath).json()) as {
        pendingCount?: unknown;
        capturedAt?: unknown;
        dataSource?: unknown;
        games?: Array<{ wagered?: unknown; toWin?: unknown }>;
      };
      const games = Array.isArray(json.games) ? json.games : [];
      let totalWageredCents = 0;
      let totalToWinCents = 0;
      for (const g of games) {
        totalWageredCents += Number(g?.wagered) || 0;
        totalToWinCents += Number(g?.toWin) || 0;
      }
      const summary: BetTickerPendingGamesSummary = {
        available: true,
        gameCount: games.length,
        pendingCount: Number(json.pendingCount ?? games.length) || games.length,
        totalWageredCents,
        totalToWinCents,
        capturedAt:
          typeof json.capturedAt === "string" ? json.capturedAt : null,
        dataSource:
          typeof json.dataSource === "string" ? json.dataSource : null,
        sourcePath: safeRelPath(pendingBetsPath),
      };
      pendingCache.set(pendingBetsPath, stamp, summary);
      return summary;
    } catch {
      // signal-honesty: intentional-pending-bets-unparseable-fallback
      return {
        available: false,
        gameCount: 0,
        pendingCount: 0,
        totalWageredCents: 0,
        totalToWinCents: 0,
        capturedAt: null,
        dataSource: null,
        sourcePath: null,
      };
    }
  }

  async function loadCaptureHealth(
    nowMs: number,
  ): Promise<BetTickerCaptureHealthSummary> {
    const stamp = await statStamp(captureHealthPath);
    if (stamp === null) {
      return {
        available: false,
        status: null,
        capturedAt: null,
        ageSeconds: null,
        rowCount: null,
        sourcePath: null,
      };
    }
    const hit = healthCache.getIfFresh(captureHealthPath, stamp);
    if (hit !== undefined) return hit;

    try {
      const json = (await Bun.file(captureHealthPath).json()) as {
        updatedAt?: unknown;
        sources?: {
          getBetTicker?: {
            outcome?: unknown;
            finishedAt?: unknown;
            rows?: unknown;
          };
        };
      };
      const tickerSource = json.sources?.getBetTicker;
      const capturedAt =
        typeof tickerSource?.finishedAt === "string"
          ? tickerSource.finishedAt
          : typeof json.updatedAt === "string"
            ? json.updatedAt
            : null;
      const capturedMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
      const ageSeconds = Number.isFinite(capturedMs)
        ? Math.max(0, Math.round((nowMs - capturedMs) / 1000))
        : null;
      const summary: BetTickerCaptureHealthSummary = {
        available: true,
        status:
          typeof tickerSource?.outcome === "string"
            ? tickerSource.outcome
            : "unknown",
        capturedAt,
        ageSeconds,
        rowCount:
          typeof tickerSource?.rows === "number" ? tickerSource.rows : null,
        sourcePath: safeRelPath(captureHealthPath),
      };
      healthCache.set(captureHealthPath, stamp, summary);
      return summary;
    } catch {
      // signal-honesty: intentional-capture-health-unparseable-fallback
      return {
        available: false,
        status: null,
        capturedAt: null,
        ageSeconds: null,
        rowCount: null,
        sourcePath: null,
      };
    }
  }

  async function getPayload(
    filters: {
      readonly writer?: string | undefined;
      readonly wagerType?: string | undefined;
    } = {},
  ): Promise<BetTickerApiResponse> {
    const nowDate = new Date();
    const nowIso = nowDate.toISOString();
    const [capture, sharpIds, pendingGames, captureHealth, bridge3aR2] =
      await Promise.all([
        loadCaptureFeed(),
        options.getSharpCustomerIds(),
        loadPendingSummary(),
        loadCaptureHealth(nowDate.getTime()),
        options.getBridge3aSnapshot
          ? options.getBridge3aSnapshot()
          : Promise.resolve<BetTickerBridge3aSnapshot>({
              available: false,
              publicUrl: "",
              state: "error",
              lastModified: null,
              ageSeconds: null,
              generatedAt: null,
              deskDate: null,
              deskHour: null,
              watermark: null,
              rowCount: 0,
              ticketCount: 0,
              legCount: 0,
              alertTwinCount: 0,
              orphanCount: 0,
              byChannel: {},
              byWagerType: {},
            }),
      ]);

    const rawList = capture?.rawList ?? [];
    const byWriterMap = new Map<
      string,
      {
        writer: string;
        count: number;
        wageredCents: number;
        volumeCents: number;
        toWinCents: number;
        isSentinelNoise: boolean;
      }
    >();
    const byTypeMap = new Map<
      string,
      {
        wagerType: string;
        label: string;
        count: number;
        wageredCents: number;
        volumeCents: number;
        toWinCents: number;
      }
    >();
    const byRule: Record<string, number> = {};
    const allTickets: BetTickerTicketRow[] = [];

    let actionableTicketCount = 0;
    let sentinelNoiseCount = 0;
    let totalWageredCents = 0;
    let totalVolumeCents = 0;
    let totalToWinCents = 0;
    let volumeDiffersCount = 0;
    let vipCount = 0;
    let liveCount = 0;
    let flagCount = 0;

    for (let idx = 0; idx < rawList.length; idx++) {
      const item = rawList[idx]!;
      const wagerNumber = Number(item.WagerNumber ?? item.wagerNumber ?? 0);
      const ticketId = String(
        item.WagerNumber ?? item.ticketId ?? `W-${109280 + idx}`,
      );
      const customerId = String(
        item.CustomerID ?? item.customerId ?? item.Login ?? `CUST-${idx}`,
      ).trim();
      const agentId = String(item.AgentID ?? item.agentId ?? "AG01").trim();
      const masterAgent = String(
        item.AgentLogin ?? item.masterAgent ?? "MASTER_A",
      ).trim();
      const ticketWriter = normalizeWriterKey(
        String(item.TicketWriter ?? item.ticketWriter ?? "Internet"),
      );
      const writerLower = ticketWriter.toLowerCase();
      const isSentinel = isSentinelTickerWriter(ticketWriter);
      const wagerType = String(item.WagerType ?? item.wagerType ?? "S")
        .trim()
        .toUpperCase();
      const wagerTypeLabel = labelForWagerType(wagerType);
      const amountWageredCents = toCents(
        item.AmountWagered ?? item.amountWagered ?? item.riskUsd ?? 0,
      );
      const volumeAmountCents =
        item.VolumeAmount !== undefined || item.volumeAmount !== undefined
          ? toCents(item.VolumeAmount ?? item.volumeAmount)
          : isSentinel
            ? 0
            : amountWageredCents;
      const toWinAmountCents = toCents(
        item.ToWinAmount ?? item.toWinAmount ?? item.toWinUsd ?? 0,
      );
      const volumeDiffers =
        !isSentinel && volumeAmountCents !== amountWageredCents;
      const vip =
        item.VIP === true ||
        item.vip === true ||
        String(item.VIP ?? "").trim() === "1";

      const rawDesc = String(
        item.ShortDesc ?? item.shortDesc ?? item.description ?? "",
      );
      const parsed = options.parseShortDesc(rawDesc);
      const firstLeg = parsed.legs[0];
      const live = Boolean(parsed.isLive) || Boolean(item.live);
      const legCount = countLegsFromShortDesc(rawDesc, parsed.legs.length);
      const sport = String(
        firstLeg?.sport?.toUpperCase() || item.sport || "MULTI",
      );
      const selection = String(
        firstLeg?.pick || firstLeg?.game || item.selection || "—",
      );

      const alertFlags: string[] = [];
      if (isSentinel) {
        alertFlags.push("ALERT_SENTINEL_TWIN");
      } else {
        if (amountWageredCents >= 1_000_000) {
          alertFlags.push("WHALE_STAKE");
        } else if (amountWageredCents >= 500_000) {
          alertFlags.push("HIGH_STAKE");
        }
        if (sharpIds.has(customerId.toUpperCase())) {
          alertFlags.push("SHARP_ORIGINATOR");
        }
        if (vip) {
          alertFlags.push("VIP_TICKET");
        }
        if (live) {
          alertFlags.push("IN_PLAY_LIVE");
        }
        if (volumeDiffers) {
          alertFlags.push("VOLUME_DIFFERS");
        }
      }
      for (const flag of alertFlags) {
        byRule[flag] = (byRule[flag] ?? 0) + 1;
        flagCount++;
      }

      const writerBucket = byWriterMap.get(ticketWriter) ?? {
        writer: ticketWriter,
        count: 0,
        wageredCents: 0,
        volumeCents: 0,
        toWinCents: 0,
        isSentinelNoise: isSentinel,
      };
      writerBucket.count++;
      writerBucket.wageredCents += isSentinel ? 0 : amountWageredCents;
      writerBucket.volumeCents += isSentinel ? 0 : volumeAmountCents;
      writerBucket.toWinCents += isSentinel ? 0 : toWinAmountCents;
      byWriterMap.set(ticketWriter, writerBucket);

      if (isSentinel) {
        sentinelNoiseCount++;
      } else {
        actionableTicketCount++;
        totalWageredCents += amountWageredCents;
        totalVolumeCents += volumeAmountCents;
        totalToWinCents += toWinAmountCents;
        if (volumeDiffers) volumeDiffersCount++;
        if (vip) vipCount++;
        if (live) liveCount++;

        const typeBucket = byTypeMap.get(wagerType) ?? {
          wagerType,
          label: wagerTypeLabel,
          count: 0,
          wageredCents: 0,
          volumeCents: 0,
          toWinCents: 0,
        };
        typeBucket.count++;
        typeBucket.wageredCents += amountWageredCents;
        typeBucket.volumeCents += volumeAmountCents;
        typeBucket.toWinCents += toWinAmountCents;
        byTypeMap.set(wagerType, typeBucket);
      }

      allTickets.push({
        wagerNumber: Number.isFinite(wagerNumber) ? wagerNumber : idx + 1,
        ticketId,
        customerId,
        agentId,
        masterAgent,
        ticketWriter,
        writer: writerLower,
        wagerType,
        wagerTypeLabel,
        amountWageredCents,
        volumeAmountCents,
        toWinAmountCents,
        volumeDiffers,
        isSentinelNoise: isSentinel,
        vip,
        live,
        insertedAt:
          typeof item.InsertDateTime === "string" ? item.InsertDateTime : null,
        legCount,
        shortDesc: rawDesc.trim(),
        sport,
        selection,
        alertFlags,
      });
    }

    const filterWriter = filters.writer?.trim().toLowerCase();
    const filterType = filters.wagerType?.trim().toUpperCase();
    const filteredTickets = allTickets.filter((t) => {
      if (filterWriter && filterWriter !== "all") {
        if (
          t.writer !== filterWriter &&
          t.ticketWriter.toLowerCase() !== filterWriter
        ) {
          return false;
        }
      }
      if (filterType && filterType !== "ALL") {
        if (t.wagerType !== filterType) return false;
      }
      return true;
    });

    const byWriter: BetTickerChannelBucket[] = [...byWriterMap.values()].sort(
      (a, b) => b.volumeCents - a.volumeCents || b.count - a.count,
    );
    const byWagerType: BetTickerTypeBucket[] = [...byTypeMap.values()].sort(
      (a, b) => b.volumeCents - a.volumeCents || b.count - a.count,
    );

    const provenance: DashboardSourceProvenance = capture
      ? {
          kind: capture.provenanceBase.kind,
          label: capture.provenanceBase.label,
          sourcePath: capture.provenanceBase.sourcePath,
          observedAt: capture.observedAt ?? nowIso,
        }
      : {
          kind: "unavailable",
          label: "Unavailable (no bet-ticker capture)",
          sourcePath: null,
          observedAt: nowIso,
        };

    return {
      schemaVersion: 1,
      observedAt: nowIso,
      autoExecute: false,
      provenance,
      localFeed: {
        rawRowCount: rawList.length,
        actionableTicketCount,
        sentinelNoiseCount,
        totalWageredCents,
        totalVolumeCents,
        totalToWinCents,
        volumeDiffersCount,
        vipCount,
        liveCount,
        flagCount,
        byRule,
        byWriter,
        byWagerType,
        tickets: filteredTickets,
      },
      bridge3aR2,
      pendingGames,
      captureHealth,
    };
  }

  return {
    getPayload,
    clearCache: () => {
      captureCache.clear();
      pendingCache.clear();
      healthCache.clear();
    },
  };
}
