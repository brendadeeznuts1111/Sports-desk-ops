#!/usr/bin/env bun
/**
 * @file publish_wagers_snapshot.ts
 * @description Publish the canonical `wagers-by-state` SoA chunk + immutable generation record +
 * If-Match CAS manifest (`manifests/wagers-by-state/latest`) to `sportsdesk-ops-reports`, and
 * optionally update the sanitized Bridge 1 summary (`wagers-by-state/latest.json`) when a local
 * summary artifact (`--from`) is supplied by the cron pipeline.
 *
 * Enforces:
 *  - Token boundary (`ERR_CF_TOKEN_BLEED_10000`, exit 77)
 *  - Pre-promotion dollar conservation (`BigInt(unresolved_gap_cents) === 0n`, exit 65)
 *  - Zero manifest CAS rebases on HTTP 412 (`ERR_R2_MANIFEST_CAS_REJECTED`, exit 74)
 *
 * Failures emit one versioned wagers-publish-error JSON line on stderr.
 * A non-null confirmedTickerGeneration records the acknowledged ticker promotion
 * even if the subsequent rings or summary write fails. Null conveys no acknowledgement.
 *
 * Usage:
 *   bun run wagers:publish-snapshot --from scratch/gslive-wagers-by-state.summary.json --dry-run
 *   bun run wagers:publish-snapshot --ticker-only
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  WagersPublishError,
  isWagersPublishCode,
  type WagersPublishStage,
  type WagersPublishCode,
} from "../lib/wagers_publish_error.ts";
import { portalIso } from "../lib/bet_flags.ts";
import { sha256Hex, stableJson } from "../lib/f402_bet_ticker_delta.ts";
import { R2S3Client } from "../lib/r2_s3_client.ts";
import {
  type CasR2ClientLike,
  type R2CasEnv,
  R2_BUCKET,
  assertR2TokenIsolationAndEnv,
  assertZeroReconciliationGapCents,
  createScopedR2S3Client,
  R2ManifestCasError,
  probeR2ManifestState,
  promoteCanonicalManifestWithCas,
  writeContentAddressedChunkWithRetry,
} from "../lib/r2_manifest_cas.ts";
import {
  LIVE_WAGER_TYPE_CODE3,
  PairwiseWagerColumnStore,
  SOURCE_BRIDGE_IDS,
  asLineHundredths,
  encodePairwiseSoAChunk,
  packSubSportComboKey15,
  parseDualSurfaceBetGroupToken,
  parseFixedPointDecimalToBigInt,
} from "../src/lib/customer_pairwise_cross_ref.ts";
import {
  SYNDICATE_RINGS_MANIFEST_KEY,
  type SyndicateRingsSnapshotManifest,
} from "../src/lib/syndicate_adjacency_rollup.ts";

const LEGACY_SUMMARY_KEY = "wagers-by-state/latest.json";
const LIVE_WAGERS_SOURCE_KEY = "live-wagers/latest.json";
const WAGERS_BY_STATE_MANIFEST_KEY = "manifests/wagers-by-state/latest";

const FORBIDDEN =
  /^(login|customerid|customer|agent|agentid|agentlogin|ticket|ticketnumber|wagernumber|betgroupid|ipaddress|ip|userid|playername|team1|team2)$/i;

export interface WagersByStateCanonicalManifest {
  readonly domain: "[Ops & Governance]";
  readonly sink_id: "wagers-by-state";
  readonly r2_bucket: string;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly chunk_key: string;
  readonly circuit_state: "CLOSED" | "OPEN";
  readonly unresolved_gap_cents: string;
}

export interface RawTickerRow {
  readonly WagerNumber?: unknown;
  readonly CustomerID?: unknown;
  readonly Login?: unknown;
  readonly AmountWagered?: unknown;
  readonly InsertDateTime?: unknown;
  readonly TicketWriter?: unknown;
  readonly ShortDesc?: unknown;
}

export interface LiveTickerDocument {
  readonly observedAt?: unknown;
  readonly LIST?: readonly RawTickerRow[];
}

export interface PublishWagersSnapshotResult {
  readonly dryRun: boolean;
  readonly manifestKey: string;
  readonly generationKey: string | null;
  readonly chunkKey: string;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly hydratedRows: number;
  readonly unresolved_gap_cents: string;
  readonly prevETag: string | null;
  readonly newETag: string | null;
  readonly syndicateRingsInitialized: boolean;
  readonly legacySummaryUpdated: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function walkKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => walkKeys(v, path));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    path ? `${path}.${k}` : k,
    ...walkKeys(v, path ? `${path}.${k}` : k),
  ]);
}

const CHICAGO_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function chicagoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    throw new WagersPublishError("ERR_WAGERS_SUMMARY_CLOCK", "summary-read");
  const parts = CHICAGO_YMD_FORMAT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const SPORT_CODE6_MAP: ReadonlyArray<readonly [RegExp, number]> = [
  [/football|nfl|cfb|ncaaf/i, 1],
  [/baseball|mlb|ncaa\s*baseball/i, 2],
  [/basketball|nba|cbb|ncaab|wnba/i, 3],
  [/hockey|nhl/i, 4],
  [/soccer|mls|epl|uefa|champions/i, 5],
];

function inferSportCode6(textValue: string): number {
  for (const [pattern, code] of SPORT_CODE6_MAP) {
    if (pattern.test(textValue)) return code;
  }
  return 1;
}

function inferPeriodCode4(segment: string): number {
  if (/\b(?:1st\s+Half|1H)\b/i.test(segment)) return 1;
  if (/\b(?:2nd\s+Half|2H)\b/i.test(segment)) return 2;
  if (/\b(?:1st\s+Quarter|1Q)\b/i.test(segment)) return 3;
  if (/\b(?:2nd\s+Quarter|2Q)\b/i.test(segment)) return 4;
  if (/\b(?:3rd\s+Quarter|3Q)\b/i.test(segment)) return 5;
  if (/\b(?:4th\s+Quarter|4Q)\b/i.test(segment)) return 6;
  return 0;
}

function parseInsertDateTimeEpochMs(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
  }
  const iso = portalIso(raw);
  if (iso === null) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseSafeDecimalHundredths(raw: string): number {
  const cleaned = raw.trim().replaceAll("\u00BD", ".5").replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) {
    return 0;
  }
  const scaled = parseFixedPointDecimalToBigInt(cleaned, 2);
  const absLimit = 2_000_000_000n;
  if (scaled > absLimit || scaled < -absLimit) return 0;
  return Number(scaled);
}

function parseLegAttributes(
  rawRot: number,
  segment: string,
  ticketPrefix: string,
  prevContext: string,
): {
  readonly subSportCode6: number;
  readonly wagerTypeCode3: number;
  readonly periodCode4: number;
  readonly marketKindCode2: number;
  readonly sideCode2: number;
  readonly lineHundredths: number;
  readonly oddsAmerican: number;
} {
  const headOnly = segment.split(/\s+-\s+(?:buying|For)\b/i)[0] ?? segment;
  const subSportCode6 = inferSportCode6(
    `${prevContext} ${segment} ${ticketPrefix}`,
  );
  const isLive =
    /^L[:.]/i.test(ticketPrefix) || (rawRot >= 9000 && rawRot <= 9999);
  const wagerTypeCode3 = isLive ? LIVE_WAGER_TYPE_CODE3 : 0;
  const periodCode4 = inferPeriodCode4(segment);

  const totalMatch =
    /\b([OU])\s*([0-9]+(?:\.[0-9]+|\u00BD)?)\b/i.exec(headOnly) ??
    /\b(Over|Under)\s*([0-9]+(?:\.[0-9]+|\u00BD)?)\b/i.exec(headOnly);
  if (totalMatch) {
    const marketKindCode2 = 1;
    const sideCode2 = totalMatch[1]!.toUpperCase().startsWith("U") ? 1 : 0;
    const lineHundredths = parseSafeDecimalHundredths(totalMatch[2]!);
    const tailAfterTotal = headOnly.slice(
      (totalMatch.index ?? 0) + totalMatch[0].length,
    );
    const oddsMatch = /[+-]\d{3,4}/.exec(tailAfterTotal);
    const oddsAmerican = oddsMatch ? Math.trunc(Number(oddsMatch[0])) : -110;
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2,
      sideCode2,
      lineHundredths,
      oddsAmerican,
    };
  }

  const numericTokens: string[] = [];
  const tokRe = /(?:^|\s)([+-]?\d+(?:\.\d+)?\u00BD?|[+-]?\u00BD)(?=$|[\s,])/g;
  let tokMatch: RegExpExecArray | null;
  while ((tokMatch = tokRe.exec(headOnly)) !== null) {
    numericTokens.push(tokMatch[1]!);
  }
  const lastTok = numericTokens[numericTokens.length - 1];
  const prevTok =
    numericTokens.length >= 2
      ? numericTokens[numericTokens.length - 2]
      : undefined;

  const explicitMl =
    /^M[:.]/i.test(ticketPrefix) || /\bML\b|Money\s*Line/i.test(segment);
  if (
    explicitMl ||
    (numericTokens.length === 1 &&
      lastTok !== undefined &&
      Math.abs(parseSafeDecimalHundredths(lastTok)) >= 10_000)
  ) {
    const oddsVal = lastTok
      ? Math.trunc(parseSafeDecimalHundredths(lastTok) / 100)
      : -110;
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2: 2,
      sideCode2: rawRot & 1 ? 0 : 1,
      lineHundredths: 0,
      oddsAmerican: oddsVal,
    };
  }

  if (prevTok !== undefined && lastTok !== undefined) {
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2: 0,
      sideCode2: rawRot & 1 ? 0 : 1,
      lineHundredths: parseSafeDecimalHundredths(prevTok),
      oddsAmerican: Math.trunc(parseSafeDecimalHundredths(lastTok) / 100),
    };
  }

  if (lastTok !== undefined) {
    return {
      subSportCode6,
      wagerTypeCode3,
      periodCode4,
      marketKindCode2: 0,
      sideCode2: rawRot & 1 ? 0 : 1,
      lineHundredths: parseSafeDecimalHundredths(lastTok),
      oddsAmerican: -110,
    };
  }

  return {
    subSportCode6,
    wagerTypeCode3,
    periodCode4,
    marketKindCode2: 0,
    sideCode2: rawRot & 1 ? 0 : 1,
    lineHundredths: 0,
    oddsAmerican: -110,
  };
}

export function buildPairwiseStoreFromLiveTickerDoc(
  doc: LiveTickerDocument,
  fallbackNowMs = Date.now(),
): {
  readonly store: PairwiseWagerColumnStore;
  readonly dataWindowMaxEpochMs: number;
} {
  const rows = Array.isArray(doc.LIST) ? doc.LIST : [];
  let estimatedLegs = 0;
  for (const row of rows) {
    const matches = String(row.ShortDesc ?? "").match(/#\d{3,6}\b/g);
    if (matches) estimatedLegs += matches.length;
  }

  const store = new PairwiseWagerColumnStore(Math.max(1, estimatedLegs));
  const observedMs =
    typeof doc.observedAt === "string"
      ? Date.parse(doc.observedAt)
      : fallbackNowMs;
  const fallbackEpochMs = Number.isFinite(observedMs)
    ? observedMs
    : fallbackNowMs;
  let maxEpochMs = 0;

  for (const row of rows) {
    const writer = String(row.TicketWriter ?? "")
      .trim()
      .toUpperCase();
    if (writer === "ALERT") {
      continue;
    }

    const rawCustomer = String(row.CustomerID ?? row.Login ?? "").trim();
    if (rawCustomer.length === 0) continue;

    const descRaw = String(row.ShortDesc ?? "").replaceAll("&#189;", "\u00BD");
    const legRe = /#(\d{3,6})\b([^#]*)/g;
    const prefix = descRaw.slice(0, 32);
    const bridgeId =
      writer === "GSLIVE"
        ? SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C
        : SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB;

    const wagerGroup64 = /^M\.G\d+/i.test(descRaw)
      ? parseDualSurfaceBetGroupToken(descRaw.split(/\s+/)[0] ?? "")
      : typeof row.WagerNumber === "number" && Number.isFinite(row.WagerNumber)
        ? BigInt(Math.trunc(row.WagerNumber))
        : 0n;

    const placedMs =
      parseInsertDateTimeEpochMs(row.InsertDateTime) || fallbackEpochMs;
    if (placedMs > maxEpochMs) maxEpochMs = placedMs;

    const stakeNum =
      typeof row.AmountWagered === "number" &&
      Number.isFinite(row.AmountWagered)
        ? BigInt(Math.trunc(row.AmountWagered))
        : 0n;

    let match: RegExpExecArray | null;
    while ((match = legRe.exec(descRaw)) !== null) {
      const rawRot = Number(match[1]);
      if (!Number.isInteger(rawRot) || rawRot < 0 || rawRot > 0x0fffff) {
        continue;
      }
      const prevContext = descRaw.slice(
        Math.max(0, match.index - 24),
        match.index,
      );
      const attrs = parseLegAttributes(
        rawRot,
        match[2] ?? "",
        prefix,
        prevContext,
      );
      const key15 = packSubSportComboKey15(
        attrs.subSportCode6,
        attrs.wagerTypeCode3,
        attrs.periodCode4,
        attrs.marketKindCode2,
      );
      store.appendLeg(
        rawCustomer,
        wagerGroup64,
        rawRot,
        key15,
        asLineHundredths(attrs.lineHundredths),
        attrs.oddsAmerican,
        stakeNum,
        placedMs,
        bridgeId,
        attrs.sideCode2,
      );
    }
  }

  return {
    store,
    dataWindowMaxEpochMs: maxEpochMs > 0 ? maxEpochMs : fallbackEpochMs,
  };
}

function buildSanitizedSummaryArtifact(
  summaryPath: string,
  nowMs: number,
): {
  readonly summary: Record<string, unknown>;
  readonly bodyBytes: Uint8Array;
  readonly deskDate: string;
  readonly generatedAt: string;
  readonly sourceKind: string;
  readonly artifactSha: string;
  readonly observedEndMs: number | null;
} {
  const raw = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<
    string,
    unknown
  >;
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const window = (raw.window ?? {}) as Record<string, unknown>;
  const observedEnd = text(window.observedEnd) || null;
  const windowEndMs = observedEnd === null ? null : Date.parse(observedEnd);
  const isLive = source.kind === "live-ajax.php";
  const capturedAt = isLive ? text(source.capturedAt) : observedEnd;
  const capturedMs = Date.parse(capturedAt ?? "");
  if (
    !capturedAt ||
    !Number.isFinite(capturedMs) ||
    (isLive && capturedMs > nowMs)
  ) {
    throw new WagersPublishError("ERR_WAGERS_SUMMARY_CLOCK", "summary-read");
  }
  const requestEndSec = int(source.toEpochSec);
  if (
    isLive &&
    (requestEndSec === null ||
      !Number.isSafeInteger(requestEndSec) ||
      requestEndSec <= 0)
  ) {
    throw new WagersPublishError("ERR_WAGERS_SUMMARY_CLOCK", "summary-read");
  }
  const coverageMs =
    isLive && requestEndSec !== null
      ? Math.min(capturedMs, requestEndSec * 1000)
      : capturedMs;
  const ageMinutes = Math.max(0, Math.round((nowMs - coverageMs) / 60_000));
  const generatedAt = new Date(nowMs).toISOString();
  const deskDate = chicagoDate(observedEnd ?? capturedAt);
  const rangeStart = text(window.observedStart) || null;
  const sourcePath = text(source.path);
  const sourceKind = sourcePath.endsWith(".json")
    ? "bet-report-json"
    : text(source.kind) || "offline-csv";

  const payload = {
    schemaVersion: 2,
    kind: "gslive-wagers",
    sourceKind,
    capturedAt,
    generatedAt,
    deskDate,
    window: {
      observedStart: rangeStart,
      observedEnd,
      ...(isLive && {
        toMs: coverageMs,
        fromEpochSec: int(source.fromEpochSec),
        toEpochSec: requestEndSec,
      }),
      spanHours: int(window.spanHours),
      snapshotLagMinutes: int(window.snapshotLagMinutes),
    },
    staleness: {
      timestampBasis: !isLive
        ? "window.observedEnd"
        : coverageMs < capturedMs
          ? "source.toEpochSec"
          : "source.capturedAt",
      ageMinutesAtPublish: ageMinutes,
      stale: ageMinutes > 1_440,
      staleAfterMinutes: 1_440,
    },
    source: {
      kind: text(source.kind) || "offline-csv",
      mtime: text(source.mtime) || null,
    },
    moneyScope: raw.moneyScope ?? null,
    identity: raw.identity ?? null,
    totals: raw.totals ?? null,
    states: raw.states ?? null,
    quality: raw.quality ?? null,
    notes: Array.isArray(raw.notes) ? raw.notes : [],
  } as const;

  const artifactSha = sha256Hex(stableJson(payload));
  const artifact = { ...payload, sourceSha256: artifactSha };
  const body = `${JSON.stringify(artifact, null, 2)}\n`;

  const keyPaths = walkKeys(artifact);
  const forbidden = keyPaths.filter((p) =>
    FORBIDDEN.test(p.split(".").at(-1) ?? ""),
  );
  if (forbidden.length > 0) {
    throw new WagersPublishError("ERR_WAGERS_SUMMARY_POLICY", "summary-read");
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(body)) {
    throw new WagersPublishError("ERR_WAGERS_SUMMARY_POLICY", "summary-read");
  }
  const bodyBytes = new TextEncoder().encode(body);
  if (bodyBytes.byteLength > 256 * 1024) {
    throw new WagersPublishError("ERR_WAGERS_SUMMARY_POLICY", "summary-read");
  }

  return {
    summary: {
      key: LEGACY_SUMMARY_KEY,
      bytes: bodyBytes.byteLength,
      deskDate,
      generatedAt,
      capturedAt,
      ageMinutes,
      stale: ageMinutes > 1_440,
      sourceKind: payload.sourceKind,
      sha256: artifactSha,
      summaryMtime: statSync(summaryPath).mtime.toISOString(),
      payload: artifact,
    },
    bodyBytes,
    deskDate,
    generatedAt,
    sourceKind,
    artifactSha,
    observedEndMs: windowEndMs,
  };
}

const stageFallback: Record<WagersPublishStage, WagersPublishCode> = {
  arguments: "ERR_WAGERS_ARGUMENTS",
  preflight: "ERR_WAGERS_INTERNAL",
  "summary-read": "ERR_WAGERS_SUMMARY_INVALID",
  "manifest-read": "ERR_R2_SINK_BACKPRESSURE",
  "ticker-read": "ERR_WAGERS_TICKER_READ",
  "ticker-decode": "ERR_WAGERS_TICKER_INVALID",
  "chunk-write": "ERR_WAGERS_R2_WRITE",
  "wagers-promote": "ERR_WAGERS_R2_WRITE",
  "rings-promote": "ERR_WAGERS_R2_WRITE",
  "summary-write": "ERR_WAGERS_R2_WRITE",
};

function publishError(
  cause: unknown,
  stage: WagersPublishStage,
  generation: number | null = null,
) {
  if (cause instanceof WagersPublishError) return cause;
  const code =
    cause instanceof R2ManifestCasError && isWagersPublishCode(cause.code)
      ? cause.code
      : stageFallback[stage];
  return new WagersPublishError(code, stage, generation, cause);
}

interface WagersPublishOptions {
  readonly client: CasR2ClientLike;
  readonly env?: R2CasEnv;
  readonly unresolvedGapCents?: unknown;
  readonly liveTickerDoc?: LiveTickerDocument;
  readonly summaryPath?: string;
  readonly tickerOnly?: boolean;
  readonly dryRun?: boolean;
  readonly nowMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface PublishProgress {
  stage: WagersPublishStage;
  confirmedGeneration: number | null;
}

export async function publishWagersByStateSnapshotToR2(
  options: WagersPublishOptions,
): Promise<PublishWagersSnapshotResult> {
  const progress: PublishProgress = {
    stage: "preflight",
    confirmedGeneration: null,
  };
  try {
    return await publishSnapshot(options, progress);
  } catch (cause) {
    throw publishError(cause, progress.stage, progress.confirmedGeneration);
  }
}

async function publishSnapshot(
  options: WagersPublishOptions,
  progress: PublishProgress,
): Promise<PublishWagersSnapshotResult> {
  const env = options.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  const normalizedGapCents = String(options.unresolvedGapCents ?? "0").trim();
  assertZeroReconciliationGapCents(normalizedGapCents);

  const nowMs = options.nowMs ?? Date.now();
  progress.stage = "summary-read";
  const hasSummaryFile =
    !options.tickerOnly &&
    options.summaryPath !== undefined &&
    existsSync(options.summaryPath);
  const summaryArtifact = hasSummaryFile
    ? buildSanitizedSummaryArtifact(options.summaryPath!, nowMs)
    : null;

  // STAGE_0_PREFLIGHT: probe current manifest ETags and hydrated live-wagers source.
  progress.stage = "manifest-read";
  const [wagersProbe, ringsProbe] = await Promise.all([
    probeR2ManifestState<WagersByStateCanonicalManifest>(
      options.client,
      WAGERS_BY_STATE_MANIFEST_KEY,
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    ),
    probeR2ManifestState<SyndicateRingsSnapshotManifest>(
      options.client,
      SYNDICATE_RINGS_MANIFEST_KEY,
      options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    ),
  ]);

  let tickerDoc: LiveTickerDocument;
  if (options.liveTickerDoc !== undefined) {
    tickerDoc = options.liveTickerDoc;
  } else {
    progress.stage = "ticker-read";
    const rawTicker = await options.client.file(LIVE_WAGERS_SOURCE_KEY).text();
    progress.stage = "ticker-decode";
    tickerDoc = JSON.parse(rawTicker) as LiveTickerDocument;
  }

  progress.stage = "ticker-decode";
  if (
    !Array.isArray(tickerDoc?.LIST) ||
    tickerDoc.LIST.some(
      (row) => row === null || typeof row !== "object" || Array.isArray(row),
    )
  )
    throw new WagersPublishError("ERR_WAGERS_TICKER_INVALID", progress.stage);
  const { store, dataWindowMaxEpochMs: tickerMaxMs } =
    buildPairwiseStoreFromLiveTickerDoc(tickerDoc, nowMs);
  const chunkBytes = encodePairwiseSoAChunk(store);
  const chunkHash = sha256Hex(Buffer.from(chunkBytes).toString("latin1"));

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(chunkBytes);
  const merkleRootSha256 = hasher.digest("hex");
  void chunkHash;

  const nextGenerationU32 = wagersProbe.exists
    ? ((wagersProbe.payload.generation_u32 >>> 0) + 1) >>> 0
    : 1;
  const watermarkPrefix =
    summaryArtifact?.artifactSha.slice(0, 16) ?? merkleRootSha256.slice(0, 16);
  const watermarkCursor = `${watermarkPrefix}:${store.length}`;
  const dataWindowMaxEpochMs =
    summaryArtifact !== null &&
    summaryArtifact.observedEndMs !== null &&
    summaryArtifact.observedEndMs > tickerMaxMs
      ? summaryArtifact.observedEndMs
      : tickerMaxMs;

  if (options.dryRun) {
    return {
      dryRun: true,
      manifestKey: WAGERS_BY_STATE_MANIFEST_KEY,
      generationKey: null,
      chunkKey: `chunks/${merkleRootSha256}.bin`,
      generation_u32: nextGenerationU32,
      merkle_root_sha256: merkleRootSha256,
      watermark_cursor: watermarkCursor,
      data_window_max_epoch_ms: dataWindowMaxEpochMs,
      r2_published_at_epoch_ms: 0,
      hydratedRows: store.length,
      unresolved_gap_cents: normalizedGapCents,
      prevETag: wagersProbe.etag,
      newETag: null,
      syndicateRingsInitialized: false,
      legacySummaryUpdated: false,
    };
  }

  // A bundled deployment may not expose the source module as a local file.
  const moduleSha = await Bun.file(import.meta.path)
    .arrayBuffer()
    .then(
      (bytes) => Bun.SHA256.hash(bytes, "hex"),
      () => undefined,
    );
  const declaredCommit = (env.GIT_SHA || env.SPORTSDESK_GIT_SHA || "").trim();
  const publisherMetadata: Record<string, string> = {
    "publisher-bun-version": Bun.version,
  };
  if (moduleSha) publisherMetadata["publisher-module-sha256"] = moduleSha;
  if (/^[0-9a-f]{40}$/i.test(declaredCommit))
    publisherMetadata["publisher-reported-commit"] = declaredCommit;

  progress.stage = "chunk-write";
  const uploadedChunk = await writeContentAddressedChunkWithRetry(
    options.client,
    chunkBytes,
    {
      contentType: "application/octet-stream",
      expectedSha256: merkleRootSha256,
      maxRetries: 2,
      baseDelayMs: 15,
    },
  );

  const publishedEpochMs = options.nowMs ?? Date.now();
  const wagersManifest: WagersByStateCanonicalManifest = {
    domain: "[Ops & Governance]",
    sink_id: "wagers-by-state",
    r2_bucket: env.R2_BUCKET_NAME?.trim() || R2_BUCKET,
    generation_u32: nextGenerationU32,
    merkle_root_sha256: uploadedChunk.merkleRootSha256,
    watermark_cursor: watermarkCursor,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: publishedEpochMs,
    chunk_key: uploadedChunk.chunkKey,
    circuit_state: "CLOSED",
    unresolved_gap_cents: normalizedGapCents,
  };

  progress.stage = "wagers-promote";
  const wagersPromo = await promoteCanonicalManifestWithCas({
    client: options.client,
    sinkId: "wagers-by-state",
    manifestKey: WAGERS_BY_STATE_MANIFEST_KEY,
    prevETag: wagersProbe.etag,
    nextGenerationU32,
    merkleRootSha256: uploadedChunk.merkleRootSha256,
    manifest: wagersManifest,
    unresolvedGapCents: normalizedGapCents,
    metadata: {
      pii: "none",
      ...publisherMetadata,
      domain: "ops-governance",
      "sink-id": "wagers-by-state",
      "generation-u32": String(nextGenerationU32),
      "merkle-root-sha256": uploadedChunk.merkleRootSha256,
    },
    ...(options.fetchImpl === undefined
      ? {}
      : { fetchImpl: options.fetchImpl }),
  });

  progress.confirmedGeneration = nextGenerationU32;
  let syndicateRingsInitialized = false;
  if (!ringsProbe.exists) {
    progress.stage = "rings-promote";
    const ringsHasher = new Bun.CryptoHasher("sha256");
    ringsHasher.update(
      `gen:1|spine:${nextGenerationU32}|merkle:${uploadedChunk.merkleRootSha256}\n`,
    );
    const ringsMerkle = ringsHasher.digest("hex");
    const ringsManifest: SyndicateRingsSnapshotManifest = {
      domain: "[DOD Spine]",
      r2_bucket: R2_BUCKET,
      manifest_key: SYNDICATE_RINGS_MANIFEST_KEY,
      generation_u32: 1,
      spine_generation_u32: nextGenerationU32,
      merkle_root_sha256: ringsMerkle,
      data_window_max_epoch_ms: dataWindowMaxEpochMs,
      r2_published_at_epoch_ms: publishedEpochMs,
      poison_bit: 0,
      circuit_state: "CLOSED",
      unresolved_gap_cents: "0",
      active_edge_count_u32: 0,
      ring_count_u32: 0,
      rings: [],
    };
    await promoteCanonicalManifestWithCas({
      client: options.client,
      sinkId: "syndicate-rings",
      manifestKey: SYNDICATE_RINGS_MANIFEST_KEY,
      prevETag: null,
      nextGenerationU32: 1,
      merkleRootSha256: ringsMerkle,
      manifest: ringsManifest,
      unresolvedGapCents: "0",
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
    syndicateRingsInitialized = true;
  }

  let legacySummaryUpdated = false;
  if (summaryArtifact !== null) {
    progress.stage = "summary-write";
    await options.client.writeWithMetadata(
      LEGACY_SUMMARY_KEY,
      summaryArtifact.bodyBytes,
      {
        type: "application/json",
        metadata: {
          pii: "none",
          ...publisherMetadata,
          "schema-version": "2",
          "desk-date": summaryArtifact.deskDate,
          "generated-at": summaryArtifact.generatedAt,
          sha256: summaryArtifact.artifactSha,
          source: `gslive-wagers-${summaryArtifact.sourceKind}`,
        },
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      },
    );
    legacySummaryUpdated = true;
  }

  return {
    dryRun: false,
    manifestKey: wagersPromo.manifestKey,
    generationKey: wagersPromo.generationKey,
    chunkKey: uploadedChunk.chunkKey,
    generation_u32: nextGenerationU32,
    merkle_root_sha256: uploadedChunk.merkleRootSha256,
    watermark_cursor: watermarkCursor,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: publishedEpochMs,
    hydratedRows: store.length,
    unresolved_gap_cents: normalizedGapCents,
    prevETag: wagersProbe.etag,
    newETag: wagersPromo.newETag,
    syndicateRingsInitialized,
    legacySummaryUpdated,
  };
}

function parsePublisherArgs() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        from: {
          type: "string",
          default: "scratch/gslive-wagers-by-state.summary.json",
        },
        "ticker-only": { type: "boolean", default: false },
        "gap-cents": { type: "string", default: "0" },
        "dry-run": { type: "boolean", default: false },
      },
    });
  } catch (cause) {
    throw publishError(cause, "arguments");
  }
}

async function runCli(): Promise<void> {
  const { values } = parsePublisherArgs();
  assertR2TokenIsolationAndEnv(Bun.env);
  let client: CasR2ClientLike;
  if (Bun.env.R2_ACCESS_KEY_ID && Bun.env.R2_SECRET_ACCESS_KEY) {
    client = createScopedR2S3Client(Bun.env);
  } else {
    const resolvedClient = await R2S3Client.fromEnvOrSecrets();
    if (resolvedClient === null) {
      throw new WagersPublishError(
        "ERR_CF_R2_CREDENTIALS_MISSING",
        "preflight",
      );
    }
    client = resolvedClient;
  }

  const result = await publishWagersByStateSnapshotToR2({
    client,
    env: Bun.env,
    unresolvedGapCents: values["gap-cents"],
    summaryPath: values.from,
    tickerOnly: values["ticker-only"],
    dryRun: Boolean(values["dry-run"]),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  runCli().catch((err: unknown) => {
    const failure = publishError(err, "preflight");
    console.error(JSON.stringify(failure));
    process.exitCode = failure.exitCode;
  });
}
