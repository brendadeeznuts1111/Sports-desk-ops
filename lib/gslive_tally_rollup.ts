/**
 * @file gslive_tally_rollup.ts
 * @description Bridge 3c — streaming GSLive `betReport-all.json` → sanitized tally rollup.
 *
 * The capture is a single JSON document (`{r:{bets:[…]}}`); this module walks the `bets` array
 * in bounded chunks (never loading the 55 MB document) and folds each leg into a deduped
 * `M.G<betGroupId>` wager, then into cache-contiguous SoA cell columns:
 *
 *   ticketCount | legCount | riskCents | settledNetCents | clvSumLineHundredths | clvEligibleLegCount
 *
 * Accounting rules from `docs/design/bridge3c_gslive_tally.md`: one risk/net per betGroupId;
 * `type=0` is a one-leg GSLIVE straight, `type=1` a GSBUILDER SGP (2–8 legs, never multiplied);
 * fixed-point cents with banker's rounding; `NULL_CLV_SENTINEL_BIGINT` when `fc` is missing; k=5
 * suppression with complementary sibling suppression; GATE-01..06 + GATE-08 evaluation.
 *
 * No identifier, ticket, wager/group key, login, agent, IP or raw row is emitted: cells carry only
 * bounded labels and integer aggregates.
 */

import { stat } from "node:fs/promises";

import { sha256Hex, stableJson } from "./f402_bet_ticker_delta.ts";
import {
  classifyDelayElapsedSec,
  parseGsliveTimestampMs,
} from "./gslive_bet_event_log.ts";

export const GSLIVE_TALLY_KIND = "gslive-tally";
export const GSLIVE_TALLY_SCHEMA_VERSION = 1;
export const GSLIVE_TALLY_K = 5;
export const GSLIVE_TALLY_MAX_ARTIFACT_BYTES = 256 * 1024;
/** GATE-05 derived ceiling for B_max=118: min(256 KiB, max(64 KiB, ceil(118×512×1.25)+12 KiB)) = 86 KiB. */
export const GSLIVE_TALLY_DERIVED_CEILING_BYTES = 86 * 1024;
export const NULL_CLV_SENTINEL_BIGINT = -2147483648n;

const CHANNEL_CODES = ["GSLIVE", "GSBUILDER"] as const;
export type GsliveTallyChannel = (typeof CHANNEL_CODES)[number];
const SETTLEMENT_CODES = { 1: "win", 2: "lose", 3: "push" } as const;
type GsliveSettlementState = "win" | "lose" | "push" | "other";
const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** Signed cents; fixed-point only. */
export type Cents = bigint;

/**
 * Parse a dollar string ("−12,037.64", "+$4,719.695", "100") to integer cents with half-up
 * rounding on the third decimal, matching the four-harness oracle. Overflow throws.
 */
export function parseCentsStrict(value: unknown): Cents {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : null;
  if (raw === null) throw new Error("parseCentsStrict: not a money value");
  const cleaned = raw.replace(/[$,\s]/g, "");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (match === null)
    throw new Error(`parseCentsStrict: invalid money "${raw}"`);
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const thousandths = sign * (whole * 1_000n + BigInt(fraction));
  const quotient = thousandths / 10n;
  const remainder = thousandths % 10n;
  const cents =
    (remainder >= 5n && thousandths >= 0n) ||
    (remainder <= -5n && thousandths < 0n)
      ? quotient + (thousandths >= 0n ? 1n : -1n)
      : quotient;
  if (
    cents > 9_223_372_036_854_775_807n ||
    cents < -9_223_372_036_854_775_808n
  ) {
    throw new Error("parseCentsStrict: overflow");
  }
  return cents;
}

/** Parse a line/price ("2.86") to hundredths; null when absent or unparseable. */
export function parseLineHundredths(value: unknown): bigint | null {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (raw === "") return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (match === null) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const thousandths = sign * (whole * 1_000n + BigInt(fraction));
  const quotient = thousandths / 10n;
  const remainder = thousandths % 10n;
  return (remainder >= 5n && thousandths >= 0n) ||
    (remainder <= -5n && thousandths < 0n)
    ? quotient + (thousandths >= 0n ? 1n : -1n)
    : quotient;
}

/** Money field that may legitimately be absent/null; 0n only when there is nothing to parse. */
function parseCentsIfPresent(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return parseCentsStrict(value);
}

/** Round-half-to-even integer division (banker's rounding); b must be > 0. */
export function roundDivHalfEven(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= 0n)
    throw new Error("roundDivHalfEven: denominator must be positive");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Settled-only ROI in basis points with banker's rounding, plus the signed cent residual that
 * makes `roiBps × settledStake + residual === netCents × 10000` exact.
 */
export function computeSettledRoiBasisPoints(
  netCents: bigint,
  settledStakedCents: bigint,
): { readonly roiBps: bigint | null; readonly roundingResidualCents: bigint } {
  if (settledStakedCents === 0n)
    return { roiBps: null, roundingResidualCents: 0n };
  const scaled = netCents * 10_000n;
  const roiBps = roundDivHalfEven(scaled, settledStakedCents);
  return {
    roiBps,
    roundingResidualCents: scaled - roiBps * settledStakedCents,
  };
}

/** Stream the `bets` array of a bet-report document without loading the whole file. */
export async function* streamBetReportBets(
  path: string,
  options: { readonly chunkBytes?: number } = {},
): AsyncGenerator<Record<string, unknown>> {
  const _chunkBytes =
    options.chunkBytes !== undefined &&
    Number.isSafeInteger(options.chunkBytes) &&
    options.chunkBytes > 0
      ? options.chunkBytes
      : DEFAULT_CHUNK_BYTES;
  const reader = new Response(Bun.file(path)).textStream().getReader();
  let buffer = "";
  let found = false;
  const readMore = async (): Promise<boolean> => {
    const next = await reader.read();
    if (next.done === true) return false;
    buffer += next.value;
    return true;
  };
  try {
    while (!found) {
      const match = /"bets"\s*:\s*\[/.exec(buffer);
      if (match !== null) {
        buffer = buffer.slice(match.index + match[0].length);
        found = true;
        break;
      }
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-32);
      if (!(await readMore()))
        throw new Error("streamBetReportBets: no bets array found");
    }
    while (true) {
      buffer = buffer.replace(/^[\s,]+/, "");
      while (buffer === "") {
        if (!(await readMore()))
          throw new Error("streamBetReportBets: truncated bets array");
        buffer = buffer.replace(/^[\s,]+/, "");
      }
      if (buffer.startsWith("]")) return;
      if (!buffer.startsWith("{")) {
        throw new Error(
          `streamBetReportBets: unexpected token "${buffer.slice(0, 8)}"`,
        );
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end === -1) {
        if (buffer.length > MAX_OBJECT_BYTES)
          throw new Error("streamBetReportBets: object too large");
        if (!(await readMore()))
          throw new Error("streamBetReportBets: truncated object");
        continue;
      }
      const slice = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const parsed: unknown = JSON.parse(slice);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("streamBetReportBets: bet is not an object");
      }
      yield parsed as Record<string, unknown>;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface GsliveTallyCell {
  readonly channel: GsliveTallyChannel;
  readonly sport: string;
  readonly period: string;
  readonly settlementState: GsliveSettlementState;
  readonly ticketCount: number;
  readonly legCount: number;
  readonly riskCents: number;
  readonly settledNetCents: number;
  readonly clvSumLineHundredths: number;
  readonly clvEligibleLegCount: number;
}

export interface GsliveTallyGate {
  readonly gate: number;
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail?: string;
}

export interface GsliveTallyRollup {
  readonly schemaVersion: typeof GSLIVE_TALLY_SCHEMA_VERSION;
  readonly kind: typeof GSLIVE_TALLY_KIND;
  readonly deskDate: string;
  readonly generatedAt: string;
  readonly window: {
    readonly fromEpochSec: number | null;
    readonly toEpochSec: number | null;
  };
  readonly rowCount: number;
  readonly malformedRowCount: number;
  readonly distinctTicketCount: number;
  readonly distinctBetGroupCount: number;
  readonly totals: {
    readonly ticketCount: number;
    readonly legCount: number;
    readonly riskCents: number;
    readonly settledNetCents: number;
    readonly clvSumLineHundredths: number;
    readonly clvEligibleLegCount: number;
    readonly holdBps: number | null;
    readonly roiBps: number | null;
    readonly roundingResidualCents: number;
    readonly openExposureCents: number;
    readonly freePlayTickets: number;
    readonly anomalyCounts: {
      readonly oddsDrift: number;
      readonly reversedCredit: number;
      readonly manualLog: number;
      readonly suspectedBot: number;
      readonly adminUser: number;
      readonly delayMismatch: number;
    };
  };
  readonly suppressed: {
    readonly cellCount: number;
    readonly ticketCount: number;
    readonly legCount: number;
    readonly riskCents: number;
    readonly settledNetCents: number;
    readonly clvSumLineHundredths: number;
    readonly clvEligibleLegCount: number;
  };
  readonly cells: readonly GsliveTallyCell[];
  readonly clv: {
    readonly clvSumLineHundredths: number;
    readonly clvEligibleLegCount: number;
    readonly value: null;
    readonly sentinel: string;
  };
  readonly gates: readonly GsliveTallyGate[];
  readonly sourceSha256: string;
}

export class DodGateFailureError extends Error {
  constructor(readonly gate: GsliveTallyGate & { readonly status: "fail" }) {
    super(
      `GATE-0${gate.gate} ${gate.name} failed${gate.detail ? `: ${gate.detail}` : ""}`,
    );
    this.name = "DodGateFailureError";
  }
}

function chicagoDate(epochSec: number): string {
  const TemporalApi = (
    globalThis as {
      Temporal?: {
        Instant?: {
          fromEpochMilliseconds(ms: number): {
            toZonedDateTimeISO(zone: string): {
              year: number;
              month: number;
              day: number;
            };
          };
        };
      };
    }
  ).Temporal;
  if (TemporalApi?.Instant !== undefined) {
    const zoned = TemporalApi.Instant.fromEpochMilliseconds(
      epochSec * 1000,
    ).toZonedDateTimeISO("America/Chicago");
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSec * 1000));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function bitWidth(value: number): number {
  let bits = 0;
  let abs = Math.abs(Math.trunc(value));
  while (abs > 0) {
    bits += 1;
    abs = Math.floor(abs / 2);
  }
  return bits;
}

/**
 * 24-bit cell key: channel 6 | sport 6 | period 6 | settlementState 6. The census maxima are
 * 2/14/14/3; the spare bits stay zero and the pack/decode round-trip is checked by GATE-02.
 */
function packKey(
  channel: number,
  sport: number,
  period: number,
  state: number,
): number {
  return (
    ((channel & 0x3f) << 18) |
    ((sport & 0x3f) << 12) |
    ((period & 0x3f) << 6) |
    (state & 0x3f)
  );
}

/** Set a bit in a Uint32 bitset; the array is fixed-capacity by construction. */
function setBit(words: Uint32Array, bit: number): void {
  const word = bit >>> 5;
  words[word] = (words[word] ?? 0) | (1 << (bit & 31));
}

function hasBit(words: Uint32Array, bit: number): boolean {
  return ((words[bit >>> 5] ?? 0) & (1 << (bit & 31))) !== 0;
}

/** Hamming weight over the fixed bitset words. */
function popcount(words: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < words.length; index += 1) {
    let value = words[index]!;
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    count += (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

/** Fold the streamed bets into deduped groups and cell columns. */
export async function buildGsliveTallyRollup(
  path: string,
  options: {
    readonly deskDate?: string;
    readonly chunkBytes?: number;
    readonly generatedAt?: string;
  } = {},
): Promise<GsliveTallyRollup> {
  const fileStat = await stat(path);
  const generatedAt = options.generatedAt ?? fileStat.mtime.toISOString();
  let fromEpochSec: number | null = null;
  let toEpochSec: number | null = null;

  // Fixed-capacity arenas. The census C_max=22,611 and B_max=118; 4× headroom keeps the
  // radix load ≤0.25 and lets GATE-02 fail closed instead of growing a collection.
  const GROUP_SLOT_BITS = 17;
  const GROUP_SLOT_COUNT = 1 << GROUP_SLOT_BITS; // 131,072 slots
  const GROUP_SLOT_MASK = GROUP_SLOT_COUNT - 1;
  const MAX_GROUPS = GROUP_SLOT_COUNT >>> 2; // 32,768, load ≤ 0.25
  const MAX_CELLS = 256; // census B_max=118, 2× headroom
  const MAX_LABELS = 64; // census sport/period cardinality is 14 each
  const CELL_SLOT_COUNT = 1 << 10; // 1,024 slots, load ≤ 0.25 at 256 cells
  const CELL_SLOT_MASK = CELL_SLOT_COUNT - 1;
  const CELL_WORD_COUNT = (MAX_CELLS + 31) >>> 5;

  // Group dedupe: open-addressed gid slots plus SoA columns. No Map, no per-row object.
  const groupSlots = new Uint32Array(GROUP_SLOT_COUNT);
  const groupGid = new Uint32Array(MAX_GROUPS);
  // `Bun.allocUnsafe` skips ~131 KiB of zeroing per rollup (4×32,768-byte columns). Safe
  // because only indices `0..groupCount-1` are read (see the aggregation loop below) and every
  // new index is fully written before `groupCount` advances. See
  // docs/bun-upstream-reference.md "When to use `Bun.allocUnsafe` (and when NOT to)".
  const groupType = Bun.allocUnsafe(MAX_GROUPS);
  const groupState = Bun.allocUnsafe(MAX_GROUPS);
  const groupSportLabel = Bun.allocUnsafe(MAX_GROUPS);
  const groupPeriodLabel = Bun.allocUnsafe(MAX_GROUPS);
  const groupLegs = new Uint16Array(MAX_GROUPS);
  const groupRisk = new BigInt64Array(MAX_GROUPS);
  const groupSettled = new BigInt64Array(MAX_GROUPS);
  const groupResultSum = new BigInt64Array(MAX_GROUPS);
  const groupClvSum = new BigInt64Array(MAX_GROUPS);
  const groupClvEligible = new Uint32Array(MAX_GROUPS);
  const groupFreePlayBits = new Uint32Array((MAX_GROUPS + 31) >>> 5);
  const groupOpenBits = new Uint32Array((MAX_GROUPS + 31) >>> 5);
  const groupSettledBits = new Uint32Array((MAX_GROUPS + 31) >>> 5);

  // Inline label tables: fixed 64 slots each, linear search over ≤14 observed values.
  const sports: string[] = [];
  sports.length = MAX_LABELS;
  const periods: string[] = [];
  periods.length = MAX_LABELS;
  let sportCount = 0;
  let periodCount = 0;
  let groupCount = 0;

  const anomalyCounts = {
    oddsDrift: 0,
    reversedCredit: 0,
    manualLog: 0,
    suspectedBot: 0,
    adminUser: 0,
    delayMismatch: 0,
  };
  let rowCount = 0;
  let malformedRowCount = 0;
  let maxGroupId = 0;
  let maxTicket = 0;

  const groupHash = (gid: number): number =>
    (Math.imul(gid, 0x9e3779b1) >>> 0) & GROUP_SLOT_MASK;

  const findGroup = (gid: number): number => {
    let slot = groupHash(gid);
    for (let probe = 0; probe < GROUP_SLOT_COUNT; probe += 1) {
      const entry = groupSlots[slot]!;
      if (entry === 0) return -1;
      const index = entry - 1;
      if (groupGid[index] === gid) return index;
      slot = (slot + 1) & GROUP_SLOT_MASK;
    }
    return -1;
  };

  const insertGroup = (gid: number): number => {
    if (groupCount >= MAX_GROUPS) {
      throw new DodGateFailureError({
        gate: 2,
        name: "UnsignedHandleAndKeyIntegrity",
        status: "fail",
        detail: `group arena exhausted at ${MAX_GROUPS} (C_max census 22,611)`,
      });
    }
    let slot = groupHash(gid);
    for (let probe = 0; probe < GROUP_SLOT_COUNT; probe += 1) {
      if (groupSlots[slot] === 0) {
        const index = groupCount;
        groupCount += 1;
        groupGid[index] = gid;
        groupSlots[slot] = index + 1;
        return index;
      }
      slot = (slot + 1) & GROUP_SLOT_MASK;
    }
    throw new DodGateFailureError({
      gate: 2,
      name: "UnsignedHandleAndKeyIntegrity",
      status: "fail",
      detail: "group radix table has no free slot",
    });
  };

  const internSport = (value: string): number => {
    for (let index = 0; index < sportCount; index += 1) {
      if (sports[index] === value) return index;
    }
    if (sportCount >= MAX_LABELS) {
      throw new DodGateFailureError({
        gate: 2,
        name: "UnsignedHandleAndKeyIntegrity",
        status: "fail",
        detail: `sport label cardinality exceeds ${MAX_LABELS}`,
      });
    }
    sports[sportCount] = value;
    sportCount += 1;
    return sportCount - 1;
  };

  const internPeriod = (value: string): number => {
    for (let index = 0; index < periodCount; index += 1) {
      if (periods[index] === value) return index;
    }
    if (periodCount >= MAX_LABELS) {
      throw new DodGateFailureError({
        gate: 2,
        name: "UnsignedHandleAndKeyIntegrity",
        status: "fail",
        detail: `period label cardinality exceeds ${MAX_LABELS}`,
      });
    }
    periods[periodCount] = value;
    periodCount += 1;
    return periodCount - 1;
  };

  for await (const row of streamBetReportBets(
    path,
    options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes },
  )) {
    rowCount += 1;
    if (fromEpochSec === null && typeof row.from === "number")
      fromEpochSec = row.from;
    const gidText =
      typeof row.betGroupId === "string" ? row.betGroupId.trim() : "";
    const type = typeof row.type === "string" ? row.type.trim() : "";
    const state = Number(row.state);
    const ticket =
      typeof row.ticketNumber === "string"
        ? Number(row.ticketNumber)
        : Number.POSITIVE_INFINITY;
    // The arena key is the 32-bit numeric betGroupId. Non-numeric or over-width keys fail the
    // domain instead of being silently folded into another group.
    if (
      gidText === "" ||
      !/^\d+$/.test(gidText) ||
      (gidText.length > 1 && gidText[0] === "0") ||
      (type !== "0" && type !== "1") ||
      !Number.isInteger(state) ||
      state < 0 ||
      state > 255 ||
      !Number.isFinite(ticket)
    ) {
      malformedRowCount += 1;
      continue;
    }
    const gid = Number(gidText);
    if (!Number.isSafeInteger(gid) || gid > 0xffffffff) {
      malformedRowCount += 1;
      continue;
    }
    maxGroupId = Math.max(maxGroupId, gid);
    maxTicket = Math.max(maxTicket, ticket);
    const logMs = parseGsliveTimestampMs(row.logTime);
    const acceptMs = parseGsliveTimestampMs(row.acceptTime, logMs ?? undefined);
    const delaySec = Number(row.delay);
    if (String(row.fVal ?? "") !== String(row.fVal_new ?? ""))
      anomalyCounts.oddsDrift += 1;
    if (row.reversedCredit !== null && row.reversedCredit !== undefined)
      anomalyCounts.reversedCredit += 1;
    if (String(row.manualLogExists ?? "0") !== "0")
      anomalyCounts.manualLog += 1;
    if (String(row.isSuspectedBot ?? "0") !== "0")
      anomalyCounts.suspectedBot += 1;
    if (row.adminUser !== null && row.adminUser !== undefined)
      anomalyCounts.adminUser += 1;
    if (acceptMs !== null && logMs !== null && Number.isFinite(delaySec)) {
      const elapsedSec = classifyDelayElapsedSec(
        acceptMs,
        Math.floor(logMs / 1000),
        delaySec,
      );
      if (elapsedSec < -1 || elapsedSec > 5) anomalyCounts.delayMismatch += 1;
    }
    const betDetails = (() => {
      try {
        const parsed: unknown = JSON.parse(String(row.betDetails ?? "{}"));
        return parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })();
    const f = parseLineHundredths(betDetails.f);
    const fc = parseLineHundredths(betDetails.fc);
    const clvLine = f !== null && fc !== null && fc !== 0n ? f - fc : null;
    const parentSettled = parseCentsIfPresent(row.betGroupResult);
    const legResult = parseCentsIfPresent(row.result) ?? 0n;
    const existing = findGroup(gid);
    if (existing >= 0) {
      groupLegs[existing] = groupLegs[existing]! + 1;
      groupResultSum[existing] = groupResultSum[existing]! + legResult;
      if (!hasBit(groupSettledBits, existing) && parentSettled !== null) {
        groupSettled[existing] = parentSettled;
        setBit(groupSettledBits, existing);
      }
      if (clvLine !== null) {
        groupClvSum[existing] = groupClvSum[existing]! + clvLine;
        groupClvEligible[existing] = groupClvEligible[existing]! + 1;
      }
      continue;
    }
    const index = insertGroup(gid);
    groupType[index] = type === "0" ? 0 : 1;
    groupState[index] = state;
    groupSportLabel[index] = internSport(
      String(row.displaySportId ?? "other").trim() || "other",
    );
    groupPeriodLabel[index] = internPeriod(
      String(row.period ?? "other").trim() || "other",
    );
    groupRisk[index] = parseCentsStrict(row.bet);
    if (parentSettled !== null) {
      groupSettled[index] = parentSettled;
      setBit(groupSettledBits, index);
    }
    groupResultSum[index] = legResult;
    const freePlayValue = row.isFreePlay;
    if (
      freePlayValue !== null &&
      freePlayValue !== undefined &&
      String(freePlayValue).trim() !== "" &&
      String(freePlayValue).trim() !== "0"
    ) {
      setBit(groupFreePlayBits, index);
    }
    if (!(state === 1 || state === 2 || state === 3)) {
      setBit(groupOpenBits, index);
    }
    groupLegs[index] = 1;
    groupClvSum[index] = clvLine ?? 0n;
    groupClvEligible[index] = clvLine === null ? 0 : 1;
  }

  // GATE-01 domain bounds: observed width budgets (betGroupId ≤ 32 bits, ticket ≤ 32 bits).
  const gate01: GsliveTallyGate = {
    gate: 1,
    name: "RotationAndDomainBounds",
    status:
      bitWidth(maxGroupId) <= 32 && bitWidth(maxTicket) <= 32 ? "pass" : "fail",
    detail: `betGroupId≤${bitWidth(maxGroupId)}b ticket≤${bitWidth(maxTicket)}b`,
  };

  // Cell arena: packed 24-bit keys, open-addressed slots, cache-contiguous SoA columns.
  const cellSlots = new Uint16Array(CELL_SLOT_COUNT);
  const cellKey = new Uint32Array(MAX_CELLS);
  const cellChannel = Bun.allocUnsafe(MAX_CELLS);
  const cellSportLabel = Bun.allocUnsafe(MAX_CELLS);
  const cellPeriodLabel = Bun.allocUnsafe(MAX_CELLS);
  const cellState = Bun.allocUnsafe(MAX_CELLS);
  const cellTickets = new Uint32Array(MAX_CELLS);
  const cellLegs = new Uint32Array(MAX_CELLS);
  const cellRisk = new BigInt64Array(MAX_CELLS);
  const cellSettled = new BigInt64Array(MAX_CELLS);
  const cellClvSum = new BigInt64Array(MAX_CELLS);
  const cellClvEligible = new Uint32Array(MAX_CELLS);
  let cellCount = 0;
  let packingRoundTripFailed = false;

  const cellHash = (key: number): number =>
    (Math.imul(key, 0x9e3779b1) >>> 0) & CELL_SLOT_MASK;

  const findCell = (key: number): number => {
    let slot = cellHash(key);
    for (let probe = 0; probe < CELL_SLOT_COUNT; probe += 1) {
      const entry = cellSlots[slot]!;
      if (entry === 0) return -1;
      const index = entry - 1;
      if (cellKey[index] === key) return index;
      slot = (slot + 1) & CELL_SLOT_MASK;
    }
    return -1;
  };

  const insertCell = (
    key: number,
    channel: number,
    sportLabel: number,
    periodLabel: number,
    stateIndex: number,
  ): number => {
    if (cellCount >= MAX_CELLS) {
      throw new DodGateFailureError({
        gate: 5,
        name: "WireAndArtifactSchemaBounds",
        status: "fail",
        detail: `cell arena exhausted at ${MAX_CELLS} (B_max census 118)`,
      });
    }
    let slot = cellHash(key);
    for (let probe = 0; probe < CELL_SLOT_COUNT; probe += 1) {
      if (cellSlots[slot] === 0) {
        const index = cellCount;
        cellCount += 1;
        cellKey[index] = key;
        cellChannel[index] = channel;
        cellSportLabel[index] = sportLabel;
        cellPeriodLabel[index] = periodLabel;
        cellState[index] = stateIndex;
        cellSlots[slot] = index + 1;
        return index;
      }
      slot = (slot + 1) & CELL_SLOT_MASK;
    }
    throw new DodGateFailureError({
      gate: 5,
      name: "WireAndArtifactSchemaBounds",
      status: "fail",
      detail: "cell radix table has no free slot",
    });
  };

  let freePlayTickets = 0;
  let rawRisk = 0n;
  let rawSettled = 0n;
  let openExposure = 0n;
  let rawLegs = 0;
  let clvSumTotal = 0n;
  let clvEligibleTotal = 0;
  for (let group = 0; group < groupCount; group += 1) {
    const type = groupType[group]!;
    if (type === 0 && groupLegs[group] !== 1) {
      throw new DodGateFailureError({
        gate: 1,
        name: "RotationAndDomainBounds",
        status: "fail",
        detail: `GSLIVE group with ${groupLegs[group]} legs`,
      });
    }
    const channelIndex = type;
    const settlement =
      (SETTLEMENT_CODES as Record<number, GsliveSettlementState>)[
        groupState[group]!
      ] ?? "other";
    const stateIndex =
      settlement === "win"
        ? 0
        : settlement === "lose"
          ? 1
          : settlement === "push"
            ? 2
            : 3;
    const sportLabel = groupSportLabel[group]!;
    const periodLabel = groupPeriodLabel[group]!;
    const key = packKey(channelIndex, sportLabel, periodLabel, stateIndex);
    let cell = findCell(key);
    if (cell < 0) {
      cell = insertCell(key, channelIndex, sportLabel, periodLabel, stateIndex);
      const unpackedChannel = (key >>> 18) & 0x3f;
      const unpackedSport = (key >>> 12) & 0x3f;
      const unpackedPeriod = (key >>> 6) & 0x3f;
      const unpackedState = key & 0x3f;
      if (
        unpackedChannel !== channelIndex ||
        unpackedSport !== sportLabel ||
        unpackedPeriod !== periodLabel ||
        unpackedState !== stateIndex
      ) {
        packingRoundTripFailed = true;
      }
    }
    const freePlay = hasBit(groupFreePlayBits, group);
    if (freePlay) freePlayTickets += 1;
    cellTickets[cell] = cellTickets[cell]! + 1;
    cellLegs[cell] = cellLegs[cell]! + groupLegs[group]!;
    rawLegs += groupLegs[group]!;
    const settled = hasBit(groupSettledBits, group)
      ? groupSettled[group]!
      : groupResultSum[group]!;
    rawRisk += freePlay ? 0n : groupRisk[group]!;
    rawSettled += freePlay ? 0n : settled;
    clvSumTotal += groupClvSum[group]!;
    clvEligibleTotal += groupClvEligible[group]!;
    if (hasBit(groupOpenBits, group)) {
      openExposure += freePlay ? 0n : groupRisk[group]!;
    }
    cellRisk[cell] = cellRisk[cell]! + (freePlay ? 0n : groupRisk[group]!);
    cellSettled[cell] = cellSettled[cell]! + (freePlay ? 0n : settled);
    cellClvSum[cell] = cellClvSum[cell]! + groupClvSum[group]!;
    cellClvEligible[cell] = cellClvEligible[cell]! + groupClvEligible[group]!;
  }

  // GATE-02: unsigned handles; radix capacity is the next power of two ≥ 4×cells.
  const capacity = Math.max(
    16,
    2 ** Math.ceil(Math.log2(Math.max(1, cellCount * 4))),
  );
  const load = cellCount / capacity;
  const gate02: GsliveTallyGate = {
    gate: 2,
    name: "UnsignedHandleAndKeyIntegrity",
    status: !packingRoundTripFailed && load <= 0.25 ? "pass" : "fail",
    detail: `cells=${cellCount} capacity=${capacity} load=${load.toFixed(3)}`,
  };

  // k=5 + complementary sibling suppression, as a bitset over cell indices.
  const suppressedBits = new Uint32Array(CELL_WORD_COUNT);
  for (let index = 0; index < cellCount; index += 1) {
    if (cellTickets[index]! < GSLIVE_TALLY_K) setBit(suppressedBits, index);
  }
  const siblingKey = (index: number): number =>
    (cellSportLabel[index]! << 8) |
    (cellPeriodLabel[index]! << 2) |
    cellState[index]!;
  const processedBits = new Uint32Array(CELL_WORD_COUNT);
  for (let index = 0; index < cellCount; index += 1) {
    if (hasBit(processedBits, index)) continue;
    const key = siblingKey(index);
    let suppressedCount = 0;
    let visibleCount = 0;
    let lastVisible = -1;
    for (let probe = index; probe < cellCount; probe += 1) {
      if (hasBit(processedBits, probe) || siblingKey(probe) !== key) continue;
      setBit(processedBits, probe);
      if (hasBit(suppressedBits, probe)) {
        suppressedCount += 1;
      } else {
        visibleCount += 1;
        lastVisible = probe;
      }
    }
    if (suppressedCount > 0 && visibleCount === 1) {
      setBit(suppressedBits, lastVisible);
    }
  }
  const suppressedCellCount = popcount(suppressedBits);

  // Deterministic order: the same channel|sport|period|state string comparison as before,
  // without materializing the strings or a dynamic array. `compareField` reproduces the
  // separator (`|`, 0x7c) comparison when one label is a prefix of the other, which a plain
  // field-by-field compare gets wrong (e.g. sport "2" vs "220").
  const stateLabels = ["win", "lose", "push", "other"] as const;
  const compareField = (left: string, right: string): number => {
    const shared = Math.min(left.length, right.length);
    for (let index = 0; index < shared; index += 1) {
      const delta = left.charCodeAt(index) - right.charCodeAt(index);
      if (delta !== 0) return delta;
    }
    if (left.length === right.length) return 0;
    const separator = 0x7c;
    return left.length < right.length
      ? separator - right.charCodeAt(shared)
      : left.charCodeAt(shared) - separator;
  };
  const compareCells = (left: number, right: number): number => {
    const channel = compareField(
      CHANNEL_CODES[cellChannel[left]!]!,
      CHANNEL_CODES[cellChannel[right]!]!,
    );
    if (channel !== 0) return channel;
    const sport = compareField(
      sports[cellSportLabel[left]!]!,
      sports[cellSportLabel[right]!]!,
    );
    if (sport !== 0) return sport;
    const period = compareField(
      periods[cellPeriodLabel[left]!]!,
      periods[cellPeriodLabel[right]!]!,
    );
    if (period !== 0) return period;
    return compareField(
      stateLabels[cellState[left]!]!,
      stateLabels[cellState[right]!]!,
    );
  };
  const order = new Uint16Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) order[index] = index;
  for (let index = 1; index < cellCount; index += 1) {
    const value = order[index]!;
    let cursor = index - 1;
    while (cursor >= 0 && compareCells(order[cursor]!, value) > 0) {
      order[cursor + 1] = order[cursor]!;
      cursor -= 1;
    }
    order[cursor + 1] = value;
  }

  const cells: GsliveTallyCell[] = [];
  let visibleRisk = 0n,
    visibleSettled = 0n,
    suppressedRisk = 0n,
    suppressedSettled = 0n;
  let visibleTickets = 0,
    suppressedTickets = 0,
    visibleLegs = 0,
    suppressedLegs = 0;
  let visibleClvSum = 0n,
    suppressedClvSum = 0n,
    visibleClvEligible = 0,
    suppressedClvEligible = 0;
  for (let position = 0; position < cellCount; position += 1) {
    const index = order[position]!;
    const cell: GsliveTallyCell = {
      channel: CHANNEL_CODES[cellChannel[index]!]!,
      sport: sports[cellSportLabel[index]!]!,
      period: periods[cellPeriodLabel[index]!]!,
      settlementState: stateLabels[cellState[index]!]!,
      ticketCount: cellTickets[index]!,
      legCount: cellLegs[index]!,
      riskCents: Number(cellRisk[index]!),
      settledNetCents: Number(cellSettled[index]!),
      clvSumLineHundredths: Number(cellClvSum[index]!),
      clvEligibleLegCount: cellClvEligible[index]!,
    };
    if (hasBit(suppressedBits, index)) {
      suppressedTickets += cell.ticketCount;
      suppressedLegs += cell.legCount;
      suppressedRisk += BigInt(cell.riskCents);
      suppressedSettled += BigInt(cell.settledNetCents);
      suppressedClvSum += BigInt(cell.clvSumLineHundredths);
      suppressedClvEligible += cell.clvEligibleLegCount;
    } else {
      cells.push(cell);
      visibleTickets += cell.ticketCount;
      visibleLegs += cell.legCount;
      visibleRisk += BigInt(cell.riskCents);
      visibleSettled += BigInt(cell.settledNetCents);
      visibleClvSum += BigInt(cell.clvSumLineHundredths);
      visibleClvEligible += cell.clvEligibleLegCount;
    }
  }

  const holdBps =
    rawRisk === 0n
      ? null
      : Number(roundDivHalfEven((rawRisk - rawSettled) * 10_000n, rawRisk));
  const { roiBps, roundingResidualCents } = computeSettledRoiBasisPoints(
    rawSettled,
    rawRisk,
  );
  // The document window sits AFTER the bets array; read only the file tail.
  if (fromEpochSec === null || toEpochSec === null) {
    try {
      const tailStart = Math.max(0, fileStat.size - 8192);
      const tail = await Bun.file(path).slice(tailStart, fileStat.size).text();
      const fromMatch = /"from"\s*:\s*(\d+)/.exec(tail);
      const toMatch = /"to"\s*:\s*(\d+)/.exec(tail);
      if (fromEpochSec === null && fromMatch !== null) {
        fromEpochSec = Number(fromMatch[1]);
      }
      if (toEpochSec === null && toMatch !== null)
        toEpochSec = Number(toMatch[1]);
    } catch {
      /* window stays null */
    }
  }
  const effectiveDeskDate =
    options.deskDate ??
    (toEpochSec !== null
      ? chicagoDate(toEpochSec)
      : fromEpochSec !== null
        ? chicagoDate(fromEpochSec)
        : "unknown");

  const conservation: Array<[string, bigint, bigint, bigint]> = [
    [
      "ticketCount",
      BigInt(visibleTickets + suppressedTickets),
      BigInt(visibleTickets),
      BigInt(suppressedTickets),
    ],
    [
      "legCount",
      BigInt(visibleLegs + suppressedLegs),
      BigInt(visibleLegs),
      BigInt(suppressedLegs),
    ],
    ["riskCents", visibleRisk + suppressedRisk, visibleRisk, suppressedRisk],
    [
      "settledNetCents",
      visibleSettled + suppressedSettled,
      visibleSettled,
      suppressedSettled,
    ],
    [
      "clvEligibleLegCount",
      BigInt(visibleClvEligible + suppressedClvEligible),
      BigInt(visibleClvEligible),
      BigInt(suppressedClvEligible),
    ],
    [
      "clvSumLineHundredths",
      visibleClvSum + suppressedClvSum,
      visibleClvSum,
      suppressedClvSum,
    ],
  ];
  const rawTotals: Array<[string, bigint]> = [
    ["ticketCount", BigInt(groupCount)],
    ["legCount", BigInt(rawLegs)],
    ["riskCents", rawRisk],
    ["settledNetCents", rawSettled],
    ["clvEligibleLegCount", BigInt(clvEligibleTotal)],
    ["clvSumLineHundredths", clvSumTotal],
  ];
  const gate03Failures = rawTotals.filter(([name, raw]) => {
    const row = conservation.find(([metric]) => metric === name);
    return row === undefined || row[1] !== raw;
  });
  const gate03: GsliveTallyGate = {
    gate: 3,
    name: "ExternalControlTotalAndSdcConservation",
    status: gate03Failures.length === 0 ? "pass" : "fail",
    detail:
      gate03Failures.length === 0
        ? "internal conservation holds; external markets-report/users-report control unavailable in this capture; SDC sign-off not present"
        : `conservation failed for ${gate03Failures.map(([name]) => name).join(",")}`,
  };

  const artifactWithoutHash = {
    schemaVersion: GSLIVE_TALLY_SCHEMA_VERSION,
    kind: GSLIVE_TALLY_KIND,
    deskDate: effectiveDeskDate,
    generatedAt,
    window: { fromEpochSec, toEpochSec },
    rowCount,
    malformedRowCount,
    distinctTicketCount: groupCount,
    distinctBetGroupCount: groupCount,
    totals: {
      ticketCount: groupCount,
      legCount: rawLegs,
      riskCents: Number(rawRisk),
      settledNetCents: Number(rawSettled),
      clvSumLineHundredths: Number(clvSumTotal),
      clvEligibleLegCount: clvEligibleTotal,
      holdBps,
      roiBps: roiBps === null ? null : Number(roiBps),
      roundingResidualCents: Number(roundingResidualCents),
      openExposureCents: Number(openExposure),
      anomalyCounts,
      freePlayTickets,
    },
    suppressed: {
      cellCount: suppressedCellCount,
      ticketCount: suppressedTickets,
      legCount: suppressedLegs,
      riskCents: Number(suppressedRisk),
      settledNetCents: Number(suppressedSettled),
      clvSumLineHundredths: Number(suppressedClvSum),
      clvEligibleLegCount: suppressedClvEligible,
    },
    cells,
    clv: {
      clvSumLineHundredths: Number(clvSumTotal),
      clvEligibleLegCount: clvEligibleTotal,
      value: null,
      sentinel: NULL_CLV_SENTINEL_BIGINT.toString(),
    },
    gates: [] as GsliveTallyGate[],
  } as const;

  const artifactText = stableJson(artifactWithoutHash);
  const sourceSha256 = sha256Hex(artifactText);
  const artifact = {
    ...artifactWithoutHash,
    sourceSha256,
  } as unknown as GsliveTallyRollup;

  // GATE-04: no persisted handle keys; GATE-05: artifact bounds/PII; GATE-06: integer algebra.
  const forbiddenKey =
    /^(betGroupId|ticketNumber|wagerNumber|login|agent|ipAddress|userID|partnerUserID|playerId)$/;
  const walkForbidden = (value: unknown): string[] => {
    if (value === null || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(walkForbidden);
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => (forbiddenKey.test(key) ? [key] : walkForbidden(child)),
    );
  };
  const gate04: GsliveTallyGate = {
    gate: 4,
    name: "InProcessKeyContainment",
    status:
      walkForbidden(artifact).length === 0 &&
      !["betGroupId", "ticketNumber"].some((key) =>
        artifactText.includes(`"${key}"`),
      )
        ? "pass"
        : "fail",
    detail: "no persisted handle keys; keys never serialized",
  };
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(artifact, null, 2)}\n`,
  ).byteLength;
  const ipLiteral = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(artifactText);
  const gate05: GsliveTallyGate = {
    gate: 5,
    name: "WireAndArtifactSchemaBounds",
    status:
      bytes <= GSLIVE_TALLY_DERIVED_CEILING_BYTES && !ipLiteral
        ? "pass"
        : "fail",
    detail: `bytes=${bytes} ceiling=${GSLIVE_TALLY_DERIVED_CEILING_BYTES} ip=${ipLiteral}`,
  };
  const numbersAreIntegers = ((): boolean => {
    const walk = (value: unknown): boolean => {
      if (typeof value === "number") return Number.isInteger(value);
      if (value === null || typeof value !== "object") return true;
      return Array.isArray(value)
        ? value.every(walk)
        : Object.values(value as Record<string, unknown>).every(walk);
    };
    return walk(artifact);
  })();
  const gate06: GsliveTallyGate = {
    gate: 6,
    name: "FixedPointAndSentinelAlgebra",
    status:
      numbersAreIntegers && (clvEligibleTotal > 0 || clvSumTotal === 0n)
        ? "pass"
        : "fail",
    detail: `integers=${numbersAreIntegers} clvEligible=${clvEligibleTotal} sentinel=${NULL_CLV_SENTINEL_BIGINT}`,
  };
  const gate08: GsliveTallyGate = {
    gate: 8,
    name: "TemporalCutoffAndCrossSystemReconciliation",
    status: "skipped",
    detail:
      "no 3b/3d rollups available for cross-system identity; pointer write enforced by the sink (daily verified before pointer)",
  };
  const gates: GsliveTallyGate[] = [
    gate01,
    gate02,
    gate03,
    gate04,
    gate05,
    gate06,
    gate08,
  ];
  const withGates = { ...artifact, gates } as unknown as GsliveTallyRollup;
  const failed = gates.find((gate) => gate.status === "fail");
  if (failed !== undefined)
    throw new DodGateFailureError(
      failed as GsliveTallyGate & { status: "fail" },
    );
  return withGates;
}

/** Fail-closed serializer guard used by the sink and tests. */
export function assertSanitizedGsliveTallyArtifact(
  artifact: GsliveTallyRollup,
): string {
  const text = stableJson(artifact);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > GSLIVE_TALLY_MAX_ARTIFACT_BYTES)
    throw new Error(
      `gslive tally artifact exceeds ${GSLIVE_TALLY_MAX_ARTIFACT_BYTES} bytes`,
    );
  const forbidden =
    /^(betGroupId|ticketNumber|wagerNumber|login|agent|ipAddress|userID|partnerUserID|playerId)$/;
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (forbidden.test(key))
        throw new Error(`gslive tally artifact carries forbidden key "${key}"`);
      walk(child);
    }
  };
  walk(artifact);
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text))
    throw new Error("gslive tally artifact carries an IP literal");
  return text;
}
