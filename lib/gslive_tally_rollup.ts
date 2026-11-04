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

import { open, stat } from "node:fs/promises";

import { sha256Hex, stableJson } from "./f402_bet_ticker_delta.ts";

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
  const chunkBytes =
    options.chunkBytes !== undefined &&
    Number.isSafeInteger(options.chunkBytes) &&
    options.chunkBytes > 0
      ? options.chunkBytes
      : DEFAULT_CHUNK_BYTES;
  const handle = await open(path, "r");
  const decoder = new TextDecoder();
  let buffer = "";
  let found = false;
  let eof = false;
  const readMore = async (): Promise<boolean> => {
    const chunk = new Uint8Array(chunkBytes);
    const { bytesRead } = await handle.read(chunk, 0, chunkBytes, null);
    if (bytesRead === 0) {
      eof = true;
      return false;
    }
    buffer += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
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
    buffer += decoder.decode();
    while (true) {
      buffer = buffer.replace(/^[\s,]+/, "");
      while (buffer === "") {
        if (!(await readMore()))
          throw new Error("streamBetReportBets: truncated bets array");
        buffer = decoder.decode() + buffer;
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
    await handle.close();
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

function packKey(
  channel: number,
  sport: number,
  period: number,
  state: number,
): bigint {
  return (
    (BigInt(channel) << 24n) |
    (BigInt(sport) << 16n) |
    (BigInt(period) << 8n) |
    BigInt(state)
  );
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

  interface Group {
    readonly gid: string;
    readonly type: string;
    readonly state: number;
    readonly sport: string;
    readonly period: string;
    readonly risk: bigint;
    settled: bigint | null;
    resultSum: bigint;
    readonly freePlay: boolean;
    readonly open: boolean;
    legs: number;
    clvSum: bigint;
    clvEligible: number;
  }
  const groups = new Map<string, Group>();
  let rowCount = 0;
  let malformedRowCount = 0;
  let maxGroupId = 0;
  let maxTicket = 0;

  for await (const row of streamBetReportBets(
    path,
    options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes },
  )) {
    rowCount += 1;
    if (fromEpochSec === null && typeof row.from === "number")
      fromEpochSec = row.from;
    const gid = typeof row.betGroupId === "string" ? row.betGroupId.trim() : "";
    const type = typeof row.type === "string" ? row.type.trim() : "";
    const state = Number(row.state);
    const ticket =
      typeof row.ticketNumber === "string"
        ? Number(row.ticketNumber)
        : Number.POSITIVE_INFINITY;
    if (
      gid === "" ||
      (type !== "0" && type !== "1") ||
      !Number.isInteger(state) ||
      !Number.isFinite(ticket)
    ) {
      malformedRowCount += 1;
      continue;
    }
    maxGroupId = Math.max(maxGroupId, Number(gid) || 0);
    maxTicket = Math.max(maxTicket, ticket);
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
    const existing = groups.get(gid);
    if (existing !== undefined) {
      existing.legs += 1;
      existing.resultSum += legResult;
      if (existing.settled === null && parentSettled !== null) {
        existing.settled = parentSettled;
      }
      if (clvLine !== null) {
        existing.clvSum += clvLine;
        existing.clvEligible += 1;
      }
      continue;
    }
    const freePlayValue = row.isFreePlay;
    const freePlay =
      freePlayValue !== null &&
      freePlayValue !== undefined &&
      String(freePlayValue).trim() !== "" &&
      String(freePlayValue).trim() !== "0";
    groups.set(gid, {
      gid,
      type,
      state,
      sport: String(row.displaySportId ?? "other").trim() || "other",
      period: String(row.period ?? "other").trim() || "other",
      risk: parseCentsStrict(row.bet),
      settled: parentSettled,
      resultSum: legResult,
      freePlay,
      open: !(state === 1 || state === 2 || state === 3),
      legs: 1,
      clvSum: clvLine ?? 0n,
      clvEligible: clvLine === null ? 0 : 1,
    });
  }

  // GATE-01 domain bounds: observed width budgets (betGroupId ≤ 32 bits, ticket ≤ 32 bits).
  const gate01: GsliveTallyGate = {
    gate: 1,
    name: "RotationAndDomainBounds",
    status:
      bitWidth(maxGroupId) <= 32 && bitWidth(maxTicket) <= 32 ? "pass" : "fail",
    detail: `betGroupId≤${bitWidth(maxGroupId)}b ticket≤${bitWidth(maxTicket)}b`,
  };

  // SoA cell columns.
  const labelKey = new Map<string, number>();
  const channels: GsliveTallyChannel[] = [];
  const sports: string[] = [];
  const periods: string[] = [];
  const states: GsliveSettlementState[] = [];
  const ticketCounts: number[] = [];
  const legCounts: number[] = [];
  const risks: bigint[] = [];
  const settleds: bigint[] = [];
  const clvSums: bigint[] = [];
  const clvEligibles: number[] = [];
  let packingRoundTripFailed = false;
  let freePlayTickets = 0;
  let rawRisk = 0n;
  let rawSettled = 0n;
  let openExposure = 0n;
  let rawLegs = 0;
  let clvSumTotal = 0n;
  let clvEligibleTotal = 0;
  for (const group of groups.values()) {
    if (group.type === "0" && group.legs !== 1) {
      throw new DodGateFailureError({
        gate: 1,
        name: "RotationAndDomainBounds",
        status: "fail",
        detail: `GSLIVE group with ${group.legs} legs`,
      });
    }
    const channel: GsliveTallyChannel =
      group.type === "0" ? "GSLIVE" : "GSBUILDER";
    const settlement: GsliveSettlementState =
      (SETTLEMENT_CODES as Record<number, GsliveSettlementState>)[
        group.state
      ] ?? "other";
    const key = `${channel}|${group.sport}|${group.period}|${settlement}`;
    let index = labelKey.get(key);
    if (index === undefined) {
      index = channels.length;
      labelKey.set(key, index);
      channels.push(channel);
      sports.push(group.sport);
      periods.push(group.period);
      states.push(settlement);
      ticketCounts.push(0);
      legCounts.push(0);
      risks.push(0n);
      settleds.push(0n);
      clvSums.push(0n);
      clvEligibles.push(0);
      const channelIndex = channel === "GSLIVE" ? 0 : 1;
      const sportIndex = Number(group.sport) || 255;
      const periodIndex = Math.min(periods.length + 1, 255);
      const stateIndex =
        settlement === "win"
          ? 0
          : settlement === "lose"
            ? 1
            : settlement === "push"
              ? 2
              : 3;
      const packed = packKey(channelIndex, sportIndex, periodIndex, stateIndex);
      const unpackedChannel = Number((packed >> 24n) & 0xffn);
      const unpackedSport = Number((packed >> 16n) & 0xffn);
      const unpackedPeriod = Number((packed >> 8n) & 0xffn);
      const unpackedState = Number(packed & 0xffn);
      if (
        unpackedChannel !== channelIndex ||
        unpackedSport !== sportIndex ||
        unpackedPeriod !== periodIndex ||
        unpackedState !== stateIndex
      ) {
        packingRoundTripFailed = true;
      }
    }
    const freePlay = group.freePlay;
    if (freePlay) freePlayTickets += 1;
    ticketCounts[index] = (ticketCounts[index] ?? 0) + 1;
    legCounts[index] = (legCounts[index] ?? 0) + group.legs;
    rawLegs += group.legs;
    const settled = group.settled ?? group.resultSum;
    rawRisk += freePlay ? 0n : group.risk;
    rawSettled += freePlay ? 0n : settled;
    clvSumTotal += group.clvSum;
    clvEligibleTotal += group.clvEligible;
    if (group.open) openExposure += freePlay ? 0n : group.risk;
    risks[index] = (risks[index] ?? 0n) + (freePlay ? 0n : group.risk);
    settleds[index] = (settleds[index] ?? 0n) + (freePlay ? 0n : settled);
    clvSums[index] = (clvSums[index] ?? 0n) + group.clvSum;
    clvEligibles[index] = (clvEligibles[index] ?? 0) + group.clvEligible;
  }

  const cellCount = channels.length;
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

  // k=5 + complementary sibling suppression.
  const suppressedIndices = new Set<number>();
  for (let index = 0; index < cellCount; index += 1) {
    if ((ticketCounts[index] ?? 0) < GSLIVE_TALLY_K)
      suppressedIndices.add(index);
  }
  const siblingGroups = new Map<string, number[]>();
  for (let index = 0; index < cellCount; index += 1) {
    const key = `${sports[index]}|${periods[index]}|${states[index]}`;
    const list = siblingGroups.get(key) ?? [];
    list.push(index);
    siblingGroups.set(key, list);
  }
  for (const indices of siblingGroups.values()) {
    const suppressed = indices.filter((index) => suppressedIndices.has(index));
    const visible = indices.filter((index) => !suppressedIndices.has(index));
    if (suppressed.length > 0 && visible.length === 1)
      suppressedIndices.add(visible[0] as number);
    if (suppressed.length > 0 && visible.length === 0) continue;
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
  const order = Array.from({ length: cellCount }, (_, index) => index).sort(
    (a, b) => {
      const left = `${channels[a]}|${sports[a]}|${periods[a]}|${states[a]}`;
      const right = `${channels[b]}|${sports[b]}|${periods[b]}|${states[b]}`;
      return left < right ? -1 : left > right ? 1 : 0;
    },
  );
  for (const index of order) {
    const cell: GsliveTallyCell = {
      channel: channels[index] as GsliveTallyChannel,
      sport: sports[index] as string,
      period: periods[index] as string,
      settlementState: states[index] as GsliveSettlementState,
      ticketCount: ticketCounts[index] ?? 0,
      legCount: legCounts[index] ?? 0,
      riskCents: Number(risks[index] ?? 0n),
      settledNetCents: Number(settleds[index] ?? 0n),
      clvSumLineHundredths: Number(clvSums[index] ?? 0n),
      clvEligibleLegCount: clvEligibles[index] ?? 0,
    };
    if (suppressedIndices.has(index)) {
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
    ["ticketCount", BigInt(groups.size)],
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
    distinctTicketCount: groups.size,
    distinctBetGroupCount: groups.size,
    totals: {
      ticketCount: groups.size,
      legCount: rawLegs,
      riskCents: Number(rawRisk),
      settledNetCents: Number(rawSettled),
      clvSumLineHundredths: Number(clvSumTotal),
      clvEligibleLegCount: clvEligibleTotal,
      holdBps,
      roiBps: roiBps === null ? null : Number(roiBps),
      roundingResidualCents: Number(roundingResidualCents),
      openExposureCents: Number(openExposure),
      freePlayTickets,
    },
    suppressed: {
      cellCount: suppressedIndices.size,
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
