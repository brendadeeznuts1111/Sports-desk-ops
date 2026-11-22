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

export class WagersPublishError extends Error {
  readonly exitCode: number;
  constructor(
    readonly code: WagersPublishCode,
    readonly stage: WagersPublishStage,
    // Last confirmed promotion in this invocation. A lost acknowledgement can leave this null.
    readonly confirmedTickerGeneration: number | null = null,
    cause?: unknown,
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
    if (
      gen !== null &&
      !(
        typeof gen === "number" &&
        Number.isInteger(gen) &&
        gen >= 0 &&
        gen <= 0xffffffff
      )
    )
      return null;
    return new WagersPublishError(code, stage, gen).toJSON();
  } catch {
    return null;
  }
}
