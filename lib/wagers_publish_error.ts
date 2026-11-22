// Wire contract shared by the publisher's stderr and bridge rollup state.
const stages = [
  "arguments",
  "preflight",
  "summary-read",
  "manifest-read",
  "ticker-read",
  "ticker-decode",
  "chunk-write",
  "wagers-promote",
  "rings-promote",
  "summary-write",
] as const;
export type WagersPublishStage = (typeof stages)[number];

const failures = {
  ERR_WAGERS_ARGUMENTS: [64, "Invalid publisher arguments."],
  ERR_CF_R2_CREDENTIALS_MISSING: [65, "Missing R2 credentials or endpoint."],
  ERR_CF_TOKEN_BLEED_10000: [
    77,
    "Conflicting Cloudflare tokens are configured.",
  ],
  ERR_DOD_LEGACY_FALLBACK_REMOVED: [78, "A retired fallback is enabled."],
  ERR_OPS_RECONCILIATION_GAP: [
    65,
    "The reconciliation gap must be a zero integer.",
  ],
  ERR_R2_MANIFEST_CAS_REJECTED: [
    74,
    "Manifest promotion lost its compare-and-swap.",
  ],
  ERR_R2_CHUNK_MERKLE_MISMATCH: [74, "Chunk integrity verification failed."],
  ERR_R2_CHUNK_PUT_RETRY: [74, "Chunk upload exhausted its attempts."],
  ERR_R2_SINK_BACKPRESSURE: [65, "The R2 manifest operation failed."],
  ERR_WAGERS_SUMMARY_INVALID: [
    65,
    "The local GS Live summary is unreadable or invalid.",
  ],
  ERR_WAGERS_SUMMARY_CLOCK: [
    65,
    "The GS Live summary has an invalid capture time or window.",
  ],
  ERR_WAGERS_SUMMARY_POLICY: [
    65,
    "The summary failed the publication content checks.",
  ],
  ERR_WAGERS_TICKER_READ: [74, "Reading the R2 ticker source failed."],
  ERR_WAGERS_TICKER_INVALID: [65, "The ticker source could not be decoded."],
  ERR_WAGERS_R2_WRITE: [74, "The R2 write or its verification failed."],
  ERR_WAGERS_INTERNAL: [70, "The publisher encountered an unexpected error."],
} as const;
export type WagersPublishCode = keyof typeof failures;

export function isWagersPublishCode(code: unknown): code is WagersPublishCode {
  return typeof code === "string" && Object.hasOwn(failures, code);
}

export const WAGERS_LATEST_KEY = "manifests/wagers-by-state/latest" as const;

export function tickerReadback(
  generation: number,
  expectedSha256: string,
  observedSha256: string | null,
) {
  const outcome =
    observedSha256 === null
      ? ("unavailable" as const)
      : observedSha256 === expectedSha256
        ? ("matched" as const)
        : ("different" as const);
  return {
    manifestKey: WAGERS_LATEST_KEY,
    generation,
    expectedSha256,
    observedSha256,
    outcome,
  };
}

export type TickerReadback = ReturnType<typeof tickerReadback>;

function isGeneration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

// Ignore an invalid optional extension while retaining the valid v1 failure.
function parseReadback(value: unknown): TickerReadback | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { manifestKey, generation, expectedSha256, observedSha256, outcome } =
    value as Record<string, unknown>;
  if (
    manifestKey !== WAGERS_LATEST_KEY ||
    !isGeneration(generation) ||
    !isDigest(expectedSha256) ||
    (observedSha256 !== null && !isDigest(observedSha256))
  )
    return undefined;
  const result = tickerReadback(generation, expectedSha256, observedSha256);
  return result.outcome === outcome ? result : undefined;
}

export class WagersPublishError extends Error {
  readonly exitCode: number;
  constructor(
    readonly code: WagersPublishCode,
    readonly stage: WagersPublishStage,
    // Last confirmed promotion in this invocation. A lost acknowledgement can leave this null.
    readonly confirmedTickerGeneration: number | null = null,
    cause?: unknown,
    readonly tickerReadback?: TickerReadback,
  ) {
    super(code + ": " + failures[code][1], { cause });
    this.name = "WagersPublishError";
    this.exitCode = failures[code][0];
  }

  toJSON() {
    return {
      kind: "wagers-publish-error" as const,
      schemaVersion: 1 as const,
      code: this.code,
      exitCode: this.exitCode,
      stage: this.stage,
      message: failures[this.code][1],
      confirmedTickerGeneration: this.confirmedTickerGeneration,
      ...(this.tickerReadback && { tickerReadback: this.tickerReadback }),
    };
  }
}

export type WagersPublishFailure = ReturnType<WagersPublishError["toJSON"]>;

function isPublishStage(value: unknown): value is WagersPublishStage {
  return stages.some((stage) => stage === value);
}

// Rebuild the message from the catalog. Never persist extra child-supplied fields.
export function readWagersPublishFailure(
  stderr: string,
  exitCode: number,
): WagersPublishFailure | null {
  const trimmed = stderr.trimEnd();
  const line = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  if (!line || line.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const { code, stage, confirmedTickerGeneration: gen } = record;
    if (
      record.kind !== "wagers-publish-error" ||
      record.schemaVersion !== 1 ||
      !isWagersPublishCode(code) ||
      failures[code][0] !== exitCode ||
      record.exitCode !== exitCode ||
      !isPublishStage(stage)
    )
      return null;
    if (gen !== null && !isGeneration(gen)) return null;
    const evidence =
      stage === "wagers-promote" &&
      gen === null &&
      (code === "ERR_WAGERS_R2_WRITE" || code === "ERR_R2_SINK_BACKPRESSURE")
        ? parseReadback(record.tickerReadback)
        : undefined;
    return new WagersPublishError(
      code,
      stage,
      gen,
      undefined,
      evidence,
    ).toJSON();
  } catch {
    return null;
  }
}
