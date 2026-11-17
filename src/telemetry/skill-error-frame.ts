/**
 * @file src/telemetry/skill-error-frame.ts
 * @description Deterministic 256-byte error frame for the `bun-ci-governor` lane.
 *
 * The frame is written into a caller-owned SharedArrayBuffer slot. A single-word CAS
 * (index 1, bytes 4..7) claims the slot: 0 FREE -> 1 WRITING -> 2 COMMITTED. The slot is
 * one-shot: after COMMITTED the reader owns it, and a writer that finds it non-FREE gets
 * `ERR_TELEMETRY_FRAME_BUSY` instead of corrupting a published frame.
 *
 * This module deliberately contains no R2 writer and no lane flusher; callers inject those.
 */

export const TELEMETRY_FRAME_BYTES = 256 as const;
export const BUN_CI_GOVERNOR_LANE = "bun-ci-governor" as const;
export const BUN_CI_GOVERNOR_SKILL_ORDINAL = 1 as const;
export const BUN_CI_GOVERNOR_R2_KEY =
  "telemetry/errors/bun-ci-governor/latest" as const;

export const TELEMETRY_FRAME_STATE = {
  FREE: 0,
  WRITING: 1,
  COMMITTED: 2,
} as const;

export type LaneR2Key = typeof BUN_CI_GOVERNOR_R2_KEY;

export enum ErrorClassCode {
  T1_TERMINAL = 1,
  T2_ISOLATED = 2,
  T3_TRANSIENT = 3,
}

export type PreflightErrorCode =
  | "ERR_INSP_SECRET_REDACTION_LEAK"
  | "ERR_CF_TOKEN_BLEED_10000"
  | "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE";

export interface PreflightErrorSpec {
  readonly code: PreflightErrorCode;
  readonly errorClass: ErrorClassCode;
  readonly idx5: number;
  readonly exitCode: number;
  readonly retryable: boolean;
}

export const PREFLIGHT_ERROR_SPECS: Readonly<
  Record<PreflightErrorCode, PreflightErrorSpec>
> = {
  ERR_INSP_SECRET_REDACTION_LEAK: {
    code: "ERR_INSP_SECRET_REDACTION_LEAK",
    errorClass: ErrorClassCode.T1_TERMINAL,
    idx5: 0,
    exitCode: 77,
    retryable: false,
  },
  ERR_CF_TOKEN_BLEED_10000: {
    code: "ERR_CF_TOKEN_BLEED_10000",
    errorClass: ErrorClassCode.T1_TERMINAL,
    idx5: 1,
    exitCode: 77,
    retryable: false,
  },
  ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE: {
    code: "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
    errorClass: ErrorClassCode.T3_TRANSIENT,
    idx5: 3,
    exitCode: 75,
    retryable: true,
  },
};

/**
 * Packs [15:11] skill5 | [10:9] class2 | [8:4] idx5 | [3:0] (exit - 64)4.
 */
function assertFrameRange(sab: SharedArrayBuffer, byteOffset: number): void {
  if (!(sab instanceof SharedArrayBuffer)) {
    throw new TypeError(
      "SkillErrorTelemetryFrame256B requires a SharedArrayBuffer",
    );
  }
  if (
    byteOffset < 0 ||
    (byteOffset & 3) !== 0 ||
    sab.byteLength - byteOffset < TELEMETRY_FRAME_BYTES
  ) {
    throw new RangeError(
      "SkillErrorTelemetryFrame256B requires 256 bytes at a 4-byte boundary",
    );
  }
}

export function packSkillErrorCodeU16(
  skillOrdinalU8: number,
  errorClass: ErrorClassCode,
  idx5: number,
  exitCode: number,
): number {
  const exitOffset = exitCode - 64;
  if (
    !Number.isInteger(skillOrdinalU8) ||
    skillOrdinalU8 < 0 ||
    skillOrdinalU8 > 31 ||
    !Number.isInteger(idx5) ||
    idx5 < 0 ||
    idx5 > 31 ||
    !Number.isInteger(exitOffset) ||
    exitOffset < 0 ||
    exitOffset > 15 ||
    (errorClass !== ErrorClassCode.T1_TERMINAL &&
      errorClass !== ErrorClassCode.T2_ISOLATED &&
      errorClass !== ErrorClassCode.T3_TRANSIENT)
  ) {
    throw new RangeError(
      `Out-of-range SkillErrorTelemetryFrame256B bitfields: skill=${skillOrdinalU8}, class=${errorClass}, idx=${idx5}, exit=${exitCode}`,
    );
  }
  return (
    ((skillOrdinalU8 & 0x1f) << 11) |
    ((errorClass & 0x03) << 9) |
    ((idx5 & 0x1f) << 4) |
    (exitOffset & 0x0f)
  );
}

export interface DnsStatsForFrame {
  readonly errors: number;
  readonly totalCount: number;
  readonly size: number;
}

export interface EncodeFrameOptions {
  /** Test seam; defaults to Date.now(). */
  readonly nowMs?: number;
  /** Test seam; defaults to Bun.dns.getCacheStats(). */
  readonly dnsStats?: DnsStatsForFrame;
}

export interface EncodedTelemetryFrame {
  readonly frame: Uint8Array;
  readonly errorCodeU16: number;
  readonly exitCode: number;
}

function writeUtf8Field(target: Uint8Array, value: string): void {
  // Target is zero-padded by the caller's fill; encodeInto truncates at a code-point boundary.
  new TextEncoder().encodeInto(value, target);
}

/**
 * Encode and publish one frame at `byteOffset` in `sab`.
 *
 * Throws `ERR_TELEMETRY_FRAME_BUSY` when the slot is not FREE (the CAS lost), so a published
 * frame can never be overwritten in place.
 */
export function encodePreflightErrorFrame256B(
  sab: SharedArrayBuffer,
  byteOffset: number,
  errorCode: PreflightErrorCode,
  sanitizedDetail: string,
  consecutiveFailCount = 1,
  options?: EncodeFrameOptions,
): EncodedTelemetryFrame {
  if (!(sab instanceof SharedArrayBuffer)) {
    throw new TypeError(
      "SkillErrorTelemetryFrame256B requires a SharedArrayBuffer",
    );
  }
  if (
    byteOffset < 0 ||
    (byteOffset & 3) !== 0 ||
    sab.byteLength - byteOffset < TELEMETRY_FRAME_BYTES
  ) {
    throw new RangeError(
      "SkillErrorTelemetryFrame256B requires 256 bytes at a 4-byte boundary",
    );
  }

  const spec = PREFLIGHT_ERROR_SPECS[errorCode];
  const errorCodeU16 = packSkillErrorCodeU16(
    BUN_CI_GOVERNOR_SKILL_ORDINAL,
    spec.errorClass,
    spec.idx5,
    spec.exitCode,
  );

  const words = new Int32Array(sab, byteOffset, TELEMETRY_FRAME_BYTES / 4);
  const prev = Atomics.compareExchange(
    words,
    1,
    TELEMETRY_FRAME_STATE.FREE,
    TELEMETRY_FRAME_STATE.WRITING,
  );
  if (prev !== 0) {
    throw new Error("ERR_TELEMETRY_FRAME_BUSY: Slot 1 CAS claim collided");
  }

  const view = new DataView(sab, byteOffset, TELEMETRY_FRAME_BYTES);
  const bytes = new Uint8Array(sab, byteOffset, TELEMETRY_FRAME_BYTES);
  bytes.fill(0, 8, TELEMETRY_FRAME_BYTES);

  const dns = options?.dnsStats ?? Bun.dns.getCacheStats();
  const dnsErrorRatioBps =
    dns.totalCount > 0
      ? Math.min(10_000, Math.round((dns.errors / dns.totalCount) * 10_000))
      : 0;
  const circuitStateU8 =
    spec.errorClass === ErrorClassCode.T1_TERMINAL || consecutiveFailCount >= 4
      ? 2
      : 0;

  view.setUint32(0, 0x45524631, true); // "ERF1"
  view.setBigUint64(8, BigInt(options?.nowMs ?? Date.now()), true);
  view.setUint16(16, errorCodeU16, true);
  view.setUint8(18, BUN_CI_GOVERNOR_SKILL_ORDINAL);
  view.setUint8(19, spec.exitCode);
  view.setUint8(20, Math.min(255, Math.max(0, consecutiveFailCount)));
  view.setUint8(21, circuitStateU8);
  view.setUint16(22, dnsErrorRatioBps, true);
  view.setUint32(24, dns.size >>> 0, true);
  view.setUint32(28, dns.totalCount >>> 0, true);
  writeUtf8Field(bytes.subarray(32, 96), BUN_CI_GOVERNOR_LANE);
  writeUtf8Field(bytes.subarray(96, 160), spec.code);
  writeUtf8Field(bytes.subarray(160, 256), sanitizedDetail);

  // Publish: 1 (WRITING) -> 2 (COMMITTED), then wake the lane flusher.
  Atomics.store(words, 1, TELEMETRY_FRAME_STATE.COMMITTED);
  Atomics.notify(words, 1, 1);

  return { frame: bytes, errorCodeU16, exitCode: spec.exitCode };
}

export interface DecodedTelemetryFrame {
  readonly errorCodeU16: number;
  readonly spec: PreflightErrorSpec;
  readonly occurredAtEpochMs: number;
  readonly skillOrdinalU8: number;
  readonly exitCode: number;
  readonly consecutiveFailCount: number;
  readonly circuitStateU8: number;
  readonly dnsErrorRatioBps: number;
  readonly dnsCacheSizeU32: number;
  readonly dnsTotalCountU32: number;
  readonly lane: string;
  readonly code: string;
  readonly detail: string;
}

function readUtf8Field(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder()
    .decode(bytes.subarray(start, end))
    .replace(/\0+$/u, "");
}

/**
 * Decode a COMMITTED frame without consuming it. The slot stays committed so a reader can
 * retry; use `consumePreflightErrorFrame256B` to claim it and return it to FREE.
 */
export function readPreflightErrorFrame256B(
  sab: SharedArrayBuffer,
  byteOffset: number,
): DecodedTelemetryFrame {
  assertFrameRange(sab, byteOffset);
  const words = new Int32Array(sab, byteOffset, TELEMETRY_FRAME_BYTES / 4);
  const state = Atomics.load(words, 1);
  if (state === TELEMETRY_FRAME_STATE.FREE) {
    throw new Error("ERR_TELEMETRY_FRAME_NOT_READY: slot is FREE");
  }
  if (state !== TELEMETRY_FRAME_STATE.COMMITTED) {
    throw new Error("ERR_TELEMETRY_FRAME_NOT_READY: slot is still WRITING");
  }

  const view = new DataView(sab, byteOffset, TELEMETRY_FRAME_BYTES);
  const bytes = new Uint8Array(sab, byteOffset, TELEMETRY_FRAME_BYTES);
  if (view.getUint32(0, true) !== 0x45524631) {
    throw new Error("ERR_TELEMETRY_FRAME_CORRUPT: bad magic");
  }

  const errorCodeU16 = view.getUint16(16, true);
  const skillOrdinalU8 = view.getUint8(18);
  const exitCode = view.getUint8(19);
  const lane = readUtf8Field(bytes, 32, 96);
  const code = readUtf8Field(bytes, 96, 160) as PreflightErrorCode;
  const spec = PREFLIGHT_ERROR_SPECS[code];
  if (spec === undefined || lane !== BUN_CI_GOVERNOR_LANE) {
    throw new Error("ERR_TELEMETRY_FRAME_CORRUPT: unknown lane or code");
  }
  if (
    skillOrdinalU8 !== BUN_CI_GOVERNOR_SKILL_ORDINAL ||
    exitCode !== spec.exitCode
  ) {
    throw new Error("ERR_TELEMETRY_FRAME_CORRUPT: skill or exit mismatch");
  }
  const expectedCode = packSkillErrorCodeU16(
    skillOrdinalU8,
    spec.errorClass,
    spec.idx5,
    exitCode,
  );
  if (expectedCode !== errorCodeU16) {
    throw new Error("ERR_TELEMETRY_FRAME_CORRUPT: discriminator mismatch");
  }

  return {
    errorCodeU16,
    spec,
    occurredAtEpochMs: Number(view.getBigUint64(8, true)),
    skillOrdinalU8,
    exitCode,
    consecutiveFailCount: view.getUint8(20),
    circuitStateU8: view.getUint8(21),
    dnsErrorRatioBps: view.getUint16(22, true),
    dnsCacheSizeU32: view.getUint32(24, true),
    dnsTotalCountU32: view.getUint32(28, true),
    lane,
    code,
    detail: readUtf8Field(bytes, 160, 256),
  };
}

/**
 * Atomically claim and decode a frame: COMMITTED -> FREE. Only one consumer wins; a second
 * consume throws. The returned frame stays valid as a copy of the field values.
 */
export function consumePreflightErrorFrame256B(
  sab: SharedArrayBuffer,
  byteOffset: number,
): DecodedTelemetryFrame {
  const decoded = readPreflightErrorFrame256B(sab, byteOffset);
  const words = new Int32Array(sab, byteOffset, TELEMETRY_FRAME_BYTES / 4);
  const prev = Atomics.compareExchange(
    words,
    1,
    TELEMETRY_FRAME_STATE.COMMITTED,
    TELEMETRY_FRAME_STATE.FREE,
  );
  if (prev !== TELEMETRY_FRAME_STATE.COMMITTED) {
    throw new Error(
      "ERR_TELEMETRY_FRAME_CONSUMED: another reader claimed the slot",
    );
  }
  return decoded;
}

/**
 * Poll for a COMMITTED frame without consuming it. Returns when the writer publishes, or
 * throws `ERR_TELEMETRY_FRAME_TIMEOUT` after `timeoutMs`.
 */
export async function waitForPreflightErrorFrame256B(
  sab: SharedArrayBuffer,
  byteOffset: number,
  timeoutMs = 2_000,
): Promise<DecodedTelemetryFrame> {
  assertFrameRange(sab, byteOffset);
  const words = new Int32Array(sab, byteOffset, TELEMETRY_FRAME_BYTES / 4);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (Atomics.load(words, 1) === TELEMETRY_FRAME_STATE.COMMITTED) {
      return readPreflightErrorFrame256B(sab, byteOffset);
    }
    await Bun.sleep(2);
  }
  throw new Error("ERR_TELEMETRY_FRAME_TIMEOUT");
}

export interface LaneFrameWriter {
  write(
    path: string,
    data: Uint8Array,
    options?: { readonly type?: string },
  ): Promise<number | undefined>;
}

/**
 * Default lane flusher: write the 256-byte frame to the governor key through an injected
 * S3-like writer. Tests use a fake; production passes a sealed S3Client.
 */
export function createR2LaneFlusher(
  writer: LaneFrameWriter,
): (frame: Uint8Array, r2Key?: LaneR2Key) => Promise<void> {
  return async (frame, r2Key = BUN_CI_GOVERNOR_R2_KEY) => {
    await writer.write(r2Key, frame, { type: "application/octet-stream" });
  };
}
