#!/usr/bin/env bun
// packages/sportsdesk-ops/src/bin/sportsdesk-fraud-cross-ref.ts
/**
 * Live R2-backed pairwise customer wager cross-reference subcommand for `bun x sportsdesk-fraud cross-ref`.
 *
 * Zero local `.json` / `.jsonl` / `.sqlite` / `.dodbin` reads and zero `.json` pointer fallbacks:
 * strictly hydrates contiguous SoA `PairwiseWagerColumnStore` binary chunks directly from
 * `sportsdesk-ops-reports` R2 CAS manifests (`manifests/wagers-by-state/latest` and
 * `manifests/syndicate-rings/latest`) via `Bun.S3Client`.
 */

import { parseArgs } from "node:util";
import {
  hydratePairwiseColumnStoreFromSoAChunk,
  evaluateColumnarPairwiseCrossRef,
  PairwiseWagerColumnStore,
  SOURCE_BRIDGE_IDS,
  type PairwiseCrossRefResult,
  type PairwiseOverlapRecord,
  type SourceBridgeId2,
} from "../../../../src/lib/customer_pairwise_cross_ref.ts";
import {
  SYNDICATE_RINGS_MANIFEST_KEY,
  type SyndicateRingsSnapshotManifest,
} from "../../../../src/lib/syndicate_adjacency_rollup.ts";
import {
  R2ManifestCasError,
  R2_BUCKET,
  RETIRED_FALLBACK_ENV_KEYS,
  assertZeroReconciliationGapCents,
  mapR2ErrorExitCode,
  resolveR2EndpointFromEnv,
} from "../lib/r2_manifest_cas.ts";

export { R2_BUCKET, SYNDICATE_RINGS_MANIFEST_KEY };
export const WAGERS_BY_STATE_MANIFEST_KEY =
  "manifests/wagers-by-state/latest" as const;

const FORBIDDEN_LOCAL_EXT_RE = /\.(?:json|jsonl|sqlite|dodbin)(?:$|\?)/i;

export interface PairwiseR2FileLike {
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export interface PairwiseR2Reader {
  file(key: string): PairwiseR2FileLike;
}

export interface WagersByStateR2Manifest {
  readonly domain?: string;
  readonly sink_id?: string;
  readonly r2_bucket?: string;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly chunk_key: string;
  readonly circuit_state: string;
  readonly unresolved_gap_cents?: string;
}

export interface PairwiseCrossRefJsonAnalysis {
  readonly customerA: string;
  readonly customerB: string;
  readonly bridgeFilter: SourceBridgeId2 | "ALL";
  readonly totalWagersA: number;
  readonly totalWagersB: number;
  readonly catalogDistinctEvents: number;
  readonly distinctEventsA: number;
  readonly distinctEventsB: number;
  readonly sharedEventsCount: number;
  readonly sameSideCount: number;
  readonly oppositeSideCount: number;
  readonly differentMarketCount: number;
  readonly suppressedBroadcastSurgeCount: number;
  readonly liveBotFollowsAtoB: number;
  readonly liveBotFollowsBtoA: number;
  readonly pregameApiBotFollowsAtoB: number;
  readonly pregameApiBotFollowsBtoA: number;
  readonly pregameFollowsAtoB: number;
  readonly pregameFollowsBtoA: number;
  readonly avgSameSideLagMsU32: number;
  readonly minSameSideLagMsU32: number;
  readonly customerALeadShareBps: number;
  readonly bAbsentParticipationBps: number;
  readonly bPresentParticipationBps: number;
  readonly liftRatioBps: number;
  readonly inferredRoleB: PairwiseCrossRefResult["inferredRoleB"];
  readonly overlaps: readonly PairwiseOverlapRecord[];
}

export interface PairwiseCrossRefR2Payload {
  readonly schemaVersion: 1;
  readonly command: "cross-ref";
  readonly domain: string;
  readonly sink_id: string;
  readonly r2_bucket: string;
  readonly generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly watermark_cursor: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly circuit_state: string;
  readonly unresolved_gap_cents: string;
  readonly manifests: {
    readonly wagersByState: {
      readonly key: typeof WAGERS_BY_STATE_MANIFEST_KEY;
      readonly generation_u32: number;
      readonly merkle_root_sha256: string;
      readonly watermark_cursor: string;
      readonly data_window_max_epoch_ms: number;
      readonly r2_published_at_epoch_ms: number;
      readonly chunk_key: string;
      readonly circuit_state: string;
    };
    readonly syndicateRings: {
      readonly key: typeof SYNDICATE_RINGS_MANIFEST_KEY;
      readonly domain: string;
      readonly generation_u32: number;
      readonly spine_generation_u32: number;
      readonly merkle_root_sha256: string;
      readonly data_window_max_epoch_ms: number;
      readonly r2_published_at_epoch_ms: number;
      readonly poison_bit: 0 | 1;
      readonly circuit_state: "CLOSED" | "OPEN";
      readonly active_edge_count_u32: number;
      readonly ring_count_u32: number;
    };
  };
  readonly hydratedRows: number;
  readonly analysis: PairwiseCrossRefJsonAnalysis;
}

export class PairwiseCrossRefError extends Error {
  public readonly exitCode: number;
  public readonly errorCode: string;

  constructor(
    errorCode: string,
    message: string,
    exitCode: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PairwiseCrossRefError";
    this.errorCode = errorCode;
    this.exitCode = exitCode;
  }
}

export const CROSS_REF_HELP = `
sportsdesk-fraud cross-ref — live R2-backed columnar pairwise customer wager cross-reference

Usage:
  bun x sportsdesk-fraud cross-ref <customerA> <customerB> [options]

Options:
  --bridge <all|f402|gslive>   Filter evaluation to one bridge or all bridges (default: all)
  --max-overlaps <n>           Maximum sample overlaps emitted in --json output (default: 16)
  -j, --json                   Emit single JSON object with R2 lineage envelope on stdout
  -h, --help                   Show this help

Governance:
  Hydrates contiguous SoA chunks via Bun.S3Client from sportsdesk-ops-reports R2 manifests:
    - ${WAGERS_BY_STATE_MANIFEST_KEY}
    - ${SYNDICATE_RINGS_MANIFEST_KEY}
  Local file flags (--input, --file) and .json/.jsonl/.sqlite/.dodbin paths fail closed
  with ERR_OPS_LOCAL_JSON_FORBIDDEN (exit 78).
`.trim();

/**
 * Live runtime preflight for pairwise cross-reference CLI.
 * Rejects retired env keys (exit 78), token bleed (exit 77), local file flags/extensions (exit 78),
 * and missing R2 credentials (exit 65).
 */
export function assertPairwiseCrossRefLivePreflight(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of RETIRED_FALLBACK_ENV_KEYS) {
    if (env[key]) {
      throw new PairwiseCrossRefError(
        "ERR_DOD_LEGACY_FALLBACK_REMOVED",
        `ERR_DOD_LEGACY_FALLBACK_REMOVED: ${key}`,
        78,
      );
    }
  }
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new PairwiseCrossRefError(
      "ERR_CF_TOKEN_BLEED_10000",
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  }
  for (const token of argv) {
    if (
      token === "--input" ||
      token.startsWith("--input=") ||
      token === "--file" ||
      token.startsWith("--file=") ||
      FORBIDDEN_LOCAL_EXT_RE.test(token)
    ) {
      throw new PairwiseCrossRefError(
        "ERR_OPS_LOCAL_JSON_FORBIDDEN",
        `ERR_OPS_LOCAL_JSON_FORBIDDEN: local file input is forbidden (${token})`,
        78,
      );
    }
  }
  const endpoint = resolveR2Endpoint(env);
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !endpoint) {
    throw new PairwiseCrossRefError(
      "ERR_CF_R2_CREDENTIALS_MISSING",
      "ERR_CF_R2_CREDENTIALS_MISSING",
      65,
    );
  }
}

export function resolveR2Endpoint(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return resolveR2EndpointFromEnv(env);
}

function createR2ReaderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PairwiseR2Reader {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const endpoint = resolveR2Endpoint(env);
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new PairwiseCrossRefError(
      "ERR_CF_R2_CREDENTIALS_MISSING",
      "ERR_CF_R2_CREDENTIALS_MISSING",
      65,
    );
  }
  return new Bun.S3Client({
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket: env.R2_BUCKET_NAME?.trim() || R2_BUCKET,
  });
}

async function readR2JsonManifest<T>(
  r2: PairwiseR2Reader,
  key: string,
): Promise<T> {
  let raw: string;
  try {
    raw = await r2.file(key).text();
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} returned invalid JSON`,
      65,
      cause,
    );
  }
}

async function readR2BinaryChunk(
  r2: PairwiseR2Reader,
  key: string,
): Promise<Uint8Array> {
  if (FORBIDDEN_LOCAL_EXT_RE.test(key)) {
    throw new PairwiseCrossRefError(
      "ERR_OPS_LOCAL_JSON_FORBIDDEN",
      `ERR_OPS_LOCAL_JSON_FORBIDDEN: chunk_key cannot reference local JSON/SQLite (${key})`,
      78,
    );
  }
  try {
    return await r2.file(key).bytes();
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${key} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }
}

function projectJsonAnalysis(
  result: PairwiseCrossRefResult,
): PairwiseCrossRefJsonAnalysis {
  return {
    customerA: result.customerA,
    customerB: result.customerB,
    bridgeFilter: result.bridgeFilter,
    totalWagersA: result.totalWagersA,
    totalWagersB: result.totalWagersB,
    catalogDistinctEvents: result.catalogDistinctEvents,
    distinctEventsA: result.distinctEventsA,
    distinctEventsB: result.distinctEventsB,
    sharedEventsCount: result.sharedEventsCount,
    sameSideCount: result.sameSideCount,
    oppositeSideCount: result.oppositeSideCount,
    differentMarketCount: result.differentMarketCount,
    suppressedBroadcastSurgeCount: result.suppressedBroadcastSurgeCount,
    liveBotFollowsAtoB: result.liveBotFollowsAtoB,
    liveBotFollowsBtoA: result.liveBotFollowsBtoA,
    pregameApiBotFollowsAtoB: result.pregameApiBotFollowsAtoB,
    pregameApiBotFollowsBtoA: result.pregameApiBotFollowsBtoA,
    pregameFollowsAtoB: result.pregameFollowsAtoB,
    pregameFollowsBtoA: result.pregameFollowsBtoA,
    avgSameSideLagMsU32: result.avgSameSideLagMsU32,
    minSameSideLagMsU32: result.minSameSideLagMsU32,
    customerALeadShareBps: result.customerALeadShareBps,
    bAbsentParticipationBps: result.bAbsentParticipationBps,
    bPresentParticipationBps: result.bPresentParticipationBps,
    liftRatioBps: result.liftRatioBps,
    inferredRoleB: result.inferredRoleB,
    overlaps: result.overlaps,
  };
}

export async function executePairwiseCrossRefFromR2(params: {
  readonly r2: PairwiseR2Reader;
  readonly customerA: string;
  readonly customerB: string;
  readonly bridgeFilter?: SourceBridgeId2 | "ALL";
  readonly maxSampleOverlaps?: number;
}): Promise<PairwiseCrossRefR2Payload> {
  const [wagersManifest, ringsManifest] = await Promise.all([
    readR2JsonManifest<WagersByStateR2Manifest>(
      params.r2,
      WAGERS_BY_STATE_MANIFEST_KEY,
    ),
    readR2JsonManifest<SyndicateRingsSnapshotManifest>(
      params.r2,
      SYNDICATE_RINGS_MANIFEST_KEY,
    ),
  ]);

  if (
    typeof wagersManifest.chunk_key !== "string" ||
    wagersManifest.chunk_key.trim().length === 0
  ) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: ${WAGERS_BY_STATE_MANIFEST_KEY} missing chunk_key`,
      65,
    );
  }

  try {
    assertZeroReconciliationGapCents(
      wagersManifest.unresolved_gap_cents ?? "0",
    );
    assertZeroReconciliationGapCents(ringsManifest.unresolved_gap_cents ?? "0");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new PairwiseCrossRefError(
      "ERR_OPS_RECONCILIATION_GAP",
      message,
      cause instanceof R2ManifestCasError ? cause.exitCode : 65,
      cause,
    );
  }

  if ((ringsManifest.poison_bit ?? 0) !== 0) {
    throw new PairwiseCrossRefError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: ${SYNDICATE_RINGS_MANIFEST_KEY} has poison_bit=${String(ringsManifest.poison_bit)}`,
      65,
    );
  }

  const chunkBytes = await readR2BinaryChunk(
    params.r2,
    wagersManifest.chunk_key,
  );
  if (chunkBytes.byteLength < 16) {
    throw new PairwiseCrossRefError(
      "ERR_SOA_BINARY_TRUNCATED",
      "ERR_SOA_BINARY_TRUNCATED: R2 SoA chunk smaller than 16-byte header",
      65,
    );
  }
  const declaredRowCount = new DataView(
    chunkBytes.buffer,
    chunkBytes.byteOffset,
    16,
  ).getUint32(8, true);

  const store = new PairwiseWagerColumnStore(Math.max(1, declaredRowCount));
  let hydratedRows: number;
  try {
    hydratedRows = hydratePairwiseColumnStoreFromSoAChunk(
      chunkBytes,
      "ALL",
      store,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const exitCode = message.includes("ERR_BRIDGE_CHANNEL_CONTAMINATION")
      ? 70
      : 65;
    throw new PairwiseCrossRefError(
      message.split(":")[0] ?? "ERR_SOA_BINARY_TRUNCATED",
      message,
      exitCode,
      cause,
    );
  }

  const crossRef = evaluateColumnarPairwiseCrossRef(
    store,
    params.customerA,
    params.customerB,
    {
      bridgeFilter: params.bridgeFilter ?? "ALL",
      maxSampleOverlaps: params.maxSampleOverlaps ?? 16,
    },
  );

  const generationU32 = wagersManifest.generation_u32 >>> 0;
  const ringsCircuitState =
    ringsManifest.circuit_state === "OPEN" ? "OPEN" : "CLOSED";
  const ringsPoisonBit: 0 | 1 = (ringsManifest.poison_bit ?? 0) === 1 ? 1 : 0;

  return {
    schemaVersion: 1,
    command: "cross-ref",
    domain: wagersManifest.domain ?? "[Ops & Governance]",
    sink_id: wagersManifest.sink_id ?? "wagers-by-state",
    r2_bucket: wagersManifest.r2_bucket ?? R2_BUCKET,
    generation_u32: generationU32,
    merkle_root_sha256: wagersManifest.merkle_root_sha256,
    watermark_cursor: wagersManifest.watermark_cursor,
    data_window_max_epoch_ms: wagersManifest.data_window_max_epoch_ms,
    r2_published_at_epoch_ms: wagersManifest.r2_published_at_epoch_ms,
    circuit_state: wagersManifest.circuit_state ?? "CLOSED",
    unresolved_gap_cents: "0",
    manifests: {
      wagersByState: {
        key: WAGERS_BY_STATE_MANIFEST_KEY,
        generation_u32: generationU32,
        merkle_root_sha256: wagersManifest.merkle_root_sha256,
        watermark_cursor: wagersManifest.watermark_cursor,
        data_window_max_epoch_ms: wagersManifest.data_window_max_epoch_ms,
        r2_published_at_epoch_ms: wagersManifest.r2_published_at_epoch_ms,
        chunk_key: wagersManifest.chunk_key,
        circuit_state: wagersManifest.circuit_state ?? "CLOSED",
      },
      syndicateRings: {
        key: SYNDICATE_RINGS_MANIFEST_KEY,
        domain: ringsManifest.domain ?? "[DOD Spine]",
        generation_u32: ringsManifest.generation_u32 >>> 0,
        spine_generation_u32: ringsManifest.spine_generation_u32 >>> 0,
        merkle_root_sha256: ringsManifest.merkle_root_sha256,
        data_window_max_epoch_ms:
          ringsManifest.data_window_max_epoch_ms ??
          ringsManifest.r2_published_at_epoch_ms,
        r2_published_at_epoch_ms: ringsManifest.r2_published_at_epoch_ms,
        poison_bit: ringsPoisonBit,
        circuit_state: ringsCircuitState,
        active_edge_count_u32: ringsManifest.active_edge_count_u32 >>> 0,
        ring_count_u32: ringsManifest.ring_count_u32 >>> 0,
      },
    },
    hydratedRows,
    analysis: projectJsonAnalysis(crossRef),
  };
}

function parseBridgeFilter(raw: string | undefined): SourceBridgeId2 | "ALL" {
  if (raw === undefined || raw.toLowerCase() === "all") return "ALL";
  const normalized = raw.toLowerCase();
  if (normalized === "f402") return SOURCE_BRIDGE_IDS.FANTASY_402_BRIDGE_3AB;
  if (normalized === "gslive") return SOURCE_BRIDGE_IDS.PARTNER_118_BRIDGE_3C;
  throw new PairwiseCrossRefError(
    "usage_error",
    `cross-ref: invalid --bridge value "${raw}" (expected all|f402|gslive)`,
    2,
  );
}

export function formatPairwiseCrossRefHumanReport(
  payload: PairwiseCrossRefR2Payload,
): string {
  const { analysis, manifests } = payload;
  const lines = [
    `[Pairwise Cross-Ref] ${analysis.customerA} vs ${analysis.customerB} (bridge=${String(analysis.bridgeFilter)}, catalogEvents=${analysis.catalogDistinctEvents})`,
    `  R2 Lineage                 : bucket=${payload.r2_bucket} gen=${payload.generation_u32} circuit=${payload.circuit_state} watermark=${payload.watermark_cursor}`,
    `  Manifests                  : wagers=${manifests.wagersByState.key}@gen${manifests.wagersByState.generation_u32} rings=${manifests.syndicateRings.key}@gen${manifests.syndicateRings.generation_u32} (rings=${manifests.syndicateRings.ring_count_u32})`,
    `  Wagers (A / B)             : ${analysis.totalWagersA} / ${analysis.totalWagersB} (hydrated=${payload.hydratedRows})`,
    `  Shared Canonical Events    : ${analysis.sharedEventsCount} (A=${analysis.distinctEventsA}, B=${analysis.distinctEventsB})`,
    `  Overlaps (Same / Opp / Mkt): ${analysis.sameSideCount} / ${analysis.oppositeSideCount} / ${analysis.differentMarketCount}`,
    `  Live <=1.5s Follows (A->B) : ${analysis.liveBotFollowsAtoB} (B->A: ${analysis.liveBotFollowsBtoA}, Surge Suppressed: ${analysis.suppressedBroadcastSurgeCount})`,
    `  Pregame Follows (A->B)     : ${analysis.pregameFollowsAtoB} [API<=5s: ${analysis.pregameApiBotFollowsAtoB}] (B->A: ${analysis.pregameFollowsBtoA} [API<=5s: ${analysis.pregameApiBotFollowsBtoA}])`,
    `  Same-Side Lag (Avg / Min)  : ${analysis.avgSameSideLagMsU32}ms / ${analysis.minSameSideLagMsU32}ms`,
    `  Customer A Lead Share      : ${analysis.customerALeadShareBps} bps`,
    `  Participation Lift         : ${analysis.bPresentParticipationBps} bps (A present) vs ${analysis.bAbsentParticipationBps} bps (A absent) -> ${analysis.liftRatioBps >= 0 ? "+" : ""}${analysis.liftRatioBps} bps [${analysis.inferredRoleB}]`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runPairwiseCrossRefCli(
  argv: readonly string[] = Bun.argv.slice(2),
  options?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly r2?: PairwiseR2Reader;
    readonly jsonDefault?: boolean;
  },
): Promise<PairwiseCrossRefR2Payload | null> {
  if (argv.includes("-h") || argv.includes("--help")) {
    // Reject forbidden local flags even alongside --help.
    for (const token of argv) {
      if (
        token === "--input" ||
        token.startsWith("--input=") ||
        token === "--file" ||
        token.startsWith("--file=") ||
        FORBIDDEN_LOCAL_EXT_RE.test(token)
      ) {
        throw new PairwiseCrossRefError(
          "ERR_OPS_LOCAL_JSON_FORBIDDEN",
          `ERR_OPS_LOCAL_JSON_FORBIDDEN: local file input is forbidden (${token})`,
          78,
        );
      }
    }
    process.stdout.write(`${CROSS_REF_HELP}\n`);
    return null;
  }

  const env = options?.env ?? Bun.env;
  assertPairwiseCrossRefLivePreflight(argv, env);

  let parsed: ReturnType<
    typeof parseArgs<{
      readonly options: {
        readonly bridge: { readonly type: "string" };
        readonly "max-overlaps": { readonly type: "string" };
        readonly json: { readonly type: "boolean"; readonly short: "j" };
        readonly help: { readonly type: "boolean"; readonly short: "h" };
      };
      readonly strict: true;
      readonly allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        bridge: { type: "string" },
        "max-overlaps": { type: "string" },
        json: { type: "boolean", short: "j", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (cause) {
    throw new PairwiseCrossRefError(
      "usage_error",
      `cross-ref: ${cause instanceof Error ? cause.message : String(cause)}`,
      2,
      cause,
    );
  }

  const [customerA, customerB, ...extraPositionals] = parsed.positionals;
  if (!customerA || !customerB) {
    throw new PairwiseCrossRefError(
      "usage_error",
      "cross-ref: requires <customerA> <customerB>",
      2,
    );
  }
  if (extraPositionals.length > 0) {
    throw new PairwiseCrossRefError(
      "usage_error",
      `cross-ref: unexpected argument "${extraPositionals[0]}"`,
      2,
    );
  }

  const bridgeFilter = parseBridgeFilter(parsed.values.bridge);
  const rawMaxOverlaps = parsed.values["max-overlaps"];
  const maxSampleOverlaps =
    rawMaxOverlaps === undefined ? 16 : Number(rawMaxOverlaps);
  if (
    !Number.isInteger(maxSampleOverlaps) ||
    maxSampleOverlaps < 0 ||
    maxSampleOverlaps > 1024
  ) {
    throw new PairwiseCrossRefError(
      "usage_error",
      `cross-ref: --max-overlaps must be an integer in [0, 1024]`,
      2,
    );
  }

  const r2 = options?.r2 ?? createR2ReaderFromEnv(env);
  const payload = await executePairwiseCrossRefFromR2({
    r2,
    customerA,
    customerB,
    bridgeFilter,
    maxSampleOverlaps,
  });

  const emitJson = Boolean(parsed.values.json || options?.jsonDefault);
  if (emitJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(formatPairwiseCrossRefHumanReport(payload));
  }
  return payload;
}

if (import.meta.main) {
  runPairwiseCrossRefCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    if (err instanceof PairwiseCrossRefError) {
      process.exit(err.exitCode);
    }
    process.exit(mapR2ErrorExitCode(err));
  });
}
