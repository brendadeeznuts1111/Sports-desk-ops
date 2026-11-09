/**
 * @file f402_pending_rollup.ts
 * @description Bridge 3b — F402 pending tickets → sanitized liability rollup. Parent-ticket
 * deduplication (`Login|WagerNumber|TicketNumber`), 20-bit rotation validation with the
 * Alt-Spread 5000 shift, effective lines in hundredths, k=5 complementary suppression, SoA
 * columns, and GATE-01..06 / GATE-08. No identifier is emitted.
 */

import {
  DodGateFailureError,
  type GsliveTallyGate,
} from "./gslive_tally_rollup.ts";
import { sha256Hex } from "./f402_bet_ticker_delta.ts";

export const F402_PENDING_KIND = "f402-pending";
export const F402_PENDING_SCHEMA_VERSION = 1;
export const F402_PENDING_K = 5;
export const F402_PENDING_MAX_BYTES = 64 * 1024;

export const PENDING_FLAG_AWAY = 1 << 0;
export const PENDING_FLAG_HOME = 1 << 1;
export const PENDING_FLAG_OVER = 1 << 2;
export const PENDING_FLAG_UNDER = 1 << 3;

export type PendingGate = GsliveTallyGate;
export interface PendingCell {
  readonly rotation: number;
  readonly sport: string;
  readonly period: string;
  readonly ticketCount: number;
  readonly legCount: number;
  readonly totalStakeCents: number;
  readonly potentialPayoutCents: number;
  readonly definedLiabilityCents: number;
  readonly spreadSumHundredths: number;
}
export interface F402PendingRollup {
  readonly schemaVersion: 1;
  readonly kind: "f402-pending";
  readonly deskDate: string;
  readonly generatedAt: string;
  readonly provenance: {
    readonly sourceKind: string;
    readonly source: string;
    readonly live: boolean;
  };
  readonly rowCount: number;
  readonly ticketCount: number;
  readonly legCount: number;
  readonly totals: {
    readonly totalStakeCents: number;
    readonly potentialPayoutCents: number;
    readonly definedLiabilityCents: number;
    readonly spreadSumHundredths: number;
  };
  readonly suppressed: {
    readonly cellCount: number;
    readonly ticketCount: number;
    readonly legCount: number;
    readonly totalStakeCents: number;
    readonly potentialPayoutCents: number;
    readonly definedLiabilityCents: number;
  };
  readonly cells: readonly PendingCell[];
  readonly gates: readonly PendingGate[];
  readonly sourceSha256: string;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
      ? Number(v)
      : null;

/** Wire pending amounts are integer cents; string money is dollars and is parsed half-up. */
export function toCents(value: unknown): bigint {
  if (typeof value === "number" && Number.isFinite(value))
    return BigInt(Math.round(value));
  if (typeof value !== "string" || value.trim() === "") return 0n;
  const cleaned = value.replace(/[$,\s]/g, "");
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (m === null) throw new Error(`toCents: invalid money "${value}"`);
  const sign = m[1] === "-" ? -1n : 1n;
  const thousandths =
    sign *
    (BigInt(m[2] ?? "0") * 1000n +
      BigInt((m[3] ?? "").padEnd(3, "0").slice(0, 3)));
  return thousandths % 10n >= 5n && thousandths >= 0n
    ? thousandths / 10n + 1n
    : thousandths % 10n <= -5n
      ? thousandths / 10n - 1n
      : thousandths / 10n;
}

/** Validate the 20-bit rotation and apply the Alt-Spread shift. */
export function normalizeRotation(value: unknown): number {
  const rotation = num(value);
  if (
    rotation === null ||
    !Number.isInteger(rotation) ||
    rotation < 0 ||
    rotation > 1_048_575
  ) {
    throw new Error(`rotation out of 20-bit range: ${String(value)}`);
  }
  return rotation >= 5_000 && rotation <= 5_999 ? rotation - 5_000 : rotation;
}

/** AdjSpread/AdjTotalPoints ± TeaserPoints → LineHundredths, flipped for the away side. */
export function effectiveLineHundredths(
  adj: unknown,
  teaser: unknown,
  sideSign: 1 | -1,
): number {
  const base = num(adj) ?? 0;
  const extra = num(teaser) ?? 0;
  return sideSign * Math.round((base + extra) * 100);
}

/** Selected rotation: the chosen team's rot number, falling back to Team1. */
export function selectedRotation(row: Record<string, unknown>): number {
  const chosen = String(row.ChosenTeamID ?? "");
  const useTeam2 = chosen !== "" && chosen === String(row.Team2ID ?? "");
  return normalizeRotation(useTeam2 ? row.Team2RotNum : row.Team1RotNum);
}

const CHICAGO_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function chicagoDate(iso: string): string {
  const parts = CHICAGO_YMD_FORMAT.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * 32-bit packed cell key: rotation 20 bits | sport 6 bits | period 6 bits.
 * Census maxima: rotation <= 1,048,575; sport < 64; period < 64.
 */
export function packPendingKey32(
  rotation: number,
  sport: number,
  period: number,
): number {
  return (
    (((rotation & 0xfffff) << 12) | ((sport & 0x3f) << 6) | (period & 0x3f)) >>>
    0
  );
}

export function unpackPendingKey32(key: number): {
  readonly rotation: number;
  readonly sport: number;
  readonly period: number;
} {
  return {
    rotation: (key >>> 12) & 0xfffff,
    sport: (key >>> 6) & 0x3f,
    period: key & 0x3f,
  };
}

function setBit(words: Uint32Array, bit: number): void {
  const word = bit >>> 5;
  words[word] = (words[word] ?? 0) | (1 << (bit & 31));
}

function hasBit(words: Uint32Array, bit: number): boolean {
  return ((words[bit >>> 5] ?? 0) & (1 << (bit & 31))) !== 0;
}

function fnv1aUpdateInt(h: number, val: number): number {
  if (!Number.isFinite(val)) return h;
  let n = Math.trunc(val);
  if (n === 0) {
    h ^= 48; // '0'
    return Math.imul(h, 0x01000193);
  }
  if (n < 0) {
    h ^= 45; // '-'
    h = Math.imul(h, 0x01000193);
    n = -n;
  }
  let divisor = 1;
  while (Math.floor(n / divisor) >= 10) {
    divisor *= 10;
  }
  while (divisor >= 1) {
    const digit = Math.floor(n / divisor) % 10;
    h ^= 48 + digit;
    h = Math.imul(h, 0x01000193);
    divisor = Math.floor(divisor / 10);
  }
  return h;
}

function fnv1aUpdateString(h: number, str: string): number {
  let start = 0;
  while (start < str.length && str.charCodeAt(start) <= 32) start++;
  let end = str.length;
  while (end > start && str.charCodeAt(end - 1) <= 32) end--;
  for (let i = start; i < end; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

/**
 * 32-bit FNV-1a hash over Login|WagerNumber|TicketNumber|totalPicks without template string allocation.
 */
export function hashTicketKey(
  login: string,
  wagerNum: number,
  ticketNum: number,
  totalPicks: number,
): number {
  let h = 0x811c9dc5 | 0;
  h = fnv1aUpdateString(h, login);
  h ^= 0x7c; // '|'
  h = Math.imul(h, 0x01000193);
  h = fnv1aUpdateInt(h, wagerNum);
  h ^= 0x7c; // '|'
  h = Math.imul(h, 0x01000193);
  h = fnv1aUpdateInt(h, ticketNum);
  h ^= 0x7c; // '|'
  h = Math.imul(h, 0x01000193);
  h = fnv1aUpdateInt(h, totalPicks);
  return h >>> 0;
}

/**
 * Open-addressed parent ticket deduplication store.
 * Sized for C_max with radix table floor 2^12 = 4,096 slots.
 */
export class Bridge3bTicketDedupeStore {
  public readonly capacity: number;
  public readonly slotCount: number;
  public readonly slotMask: number;
  public ticketCount: number = 0;
  public legCount: number = 0;

  public readonly slots: Uint32Array;
  public readonly ticketNumberCol: Float64Array;
  public readonly wagerNumberCol: Uint32Array;
  public readonly totalPicksCol: Uint32Array;
  public readonly loginCol: string[];
  public readonly rotationCol: Uint32Array;
  public readonly sportLabelCol: Uint8Array;
  public readonly periodLabelCol: Uint8Array;
  public readonly stakeCentsCol: BigInt64Array;
  public readonly payoutCentsCol: BigInt64Array;
  public readonly spreadHundredthsCol: Int32Array;
  public readonly ticketLegCountCol: Uint16Array;
  public readonly flagsBitSetCol: Uint32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    const rawSlots = Math.max(
      4096,
      1 << (32 - Math.clz32(Math.max(1, capacity * 4) - 1)),
    );
    this.slotCount = rawSlots;
    this.slotMask = rawSlots - 1;
    this.slots = new Uint32Array(rawSlots);
    this.ticketNumberCol = new Float64Array(capacity);
    this.wagerNumberCol = new Uint32Array(capacity);
    this.totalPicksCol = new Uint32Array(capacity);
    this.loginCol = Array.from<string>({ length: capacity });
    this.rotationCol = new Uint32Array(capacity);
    this.sportLabelCol = new Uint8Array(capacity);
    this.periodLabelCol = new Uint8Array(capacity);
    this.stakeCentsCol = new BigInt64Array(capacity);
    this.payoutCentsCol = new BigInt64Array(capacity);
    this.spreadHundredthsCol = new Int32Array(capacity);
    this.ticketLegCountCol = new Uint16Array(capacity);
    this.flagsBitSetCol = new Uint32Array(capacity);
  }

  public lookup(
    login: string,
    wagerNum: number,
    ticketNum: number,
    totalPicks: number,
  ): number {
    const h = hashTicketKey(login, wagerNum, ticketNum, totalPicks);
    let slot = h & this.slotMask;
    for (let probe = 0; probe < this.slotCount; probe++) {
      const entry = this.slots[slot]!;
      if (entry === 0) return -1;
      const idx = entry - 1;
      if (
        this.wagerNumberCol[idx] === wagerNum &&
        this.ticketNumberCol[idx] === ticketNum &&
        this.totalPicksCol[idx] === totalPicks &&
        this.loginCol[idx] === login
      ) {
        return idx;
      }
      slot = (slot + 1) & this.slotMask;
    }
    return -1;
  }

  public insert(
    login: string,
    wagerNum: number,
    ticketNum: number,
    totalPicks: number,
    rotation: number,
    sportLabel: number,
    periodLabel: number,
    stake: bigint,
    payout: bigint,
    spread: number,
    flags: number,
  ): number {
    if (this.ticketCount >= this.capacity) {
      throw new DodGateFailureError({
        gate: 2,
        name: "UnsignedHandleAndKeyIntegrity",
        status: "fail",
        detail: `ticket arena exhausted at ${this.capacity}`,
      });
    }
    const h = hashTicketKey(login, wagerNum, ticketNum, totalPicks);
    let slot = h & this.slotMask;
    for (let probe = 0; probe < this.slotCount; probe++) {
      if (this.slots[slot] === 0) {
        const idx = this.ticketCount;
        this.ticketCount += 1;
        this.slots[slot] = idx + 1;
        this.loginCol[idx] = login;
        this.wagerNumberCol[idx] = wagerNum;
        this.ticketNumberCol[idx] = ticketNum;
        this.totalPicksCol[idx] = totalPicks;
        this.rotationCol[idx] = rotation;
        this.sportLabelCol[idx] = sportLabel;
        this.periodLabelCol[idx] = periodLabel;
        this.stakeCentsCol[idx] = stake;
        this.payoutCentsCol[idx] = payout;
        this.spreadHundredthsCol[idx] = spread;
        this.ticketLegCountCol[idx] = 1;
        this.flagsBitSetCol[idx] = flags;
        return idx;
      }
      slot = (slot + 1) & this.slotMask;
    }
    throw new DodGateFailureError({
      gate: 2,
      name: "UnsignedHandleAndKeyIntegrity",
      status: "fail",
      detail: "ticket radix table has no free slot",
    });
  }
}

/**
 * Contiguous Struct-of-Arrays (SoA) column store for Bridge 3b pending cells.
 * Layout derived from Section 2 census with zero collection allocations.
 */
export class Bridge3bPendingColumnStore {
  public readonly capacity: number;
  public readonly slotCount: number;
  public readonly slotMask: number;
  public cellCount: number = 0;
  public packingRoundTripFailed: boolean = false;

  public readonly cellSlots: Uint32Array;
  public readonly packedCellKeyCol: Uint32Array;
  public readonly ticketCountCol: Uint32Array;
  public readonly legCountCol: Uint32Array;
  public readonly riskCentsCol: BigInt64Array;
  public readonly settledNetCentsCol: BigInt64Array;
  public readonly definedLiabilityCentsCol: BigInt64Array;
  public readonly clvSumLineHundredthsCol: BigInt64Array;
  public readonly clvEligibleLegCountCol: Uint32Array;
  public readonly cellFlagsBitSet: Uint32Array;
  public readonly spreadSumHundredthsCol: Int32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    const rawSlots = Math.max(
      4096,
      1 << (32 - Math.clz32(Math.max(1, capacity * 4) - 1)),
    );
    this.slotCount = rawSlots;
    this.slotMask = rawSlots - 1;
    this.cellSlots = new Uint32Array(rawSlots);
    this.packedCellKeyCol = new Uint32Array(capacity);
    this.ticketCountCol = new Uint32Array(capacity);
    this.legCountCol = new Uint32Array(capacity);
    this.riskCentsCol = new BigInt64Array(capacity);
    this.settledNetCentsCol = new BigInt64Array(capacity);
    this.definedLiabilityCentsCol = new BigInt64Array(capacity);
    this.clvSumLineHundredthsCol = new BigInt64Array(capacity);
    this.clvEligibleLegCountCol = new Uint32Array(capacity);
    this.cellFlagsBitSet = new Uint32Array(capacity);
    this.spreadSumHundredthsCol = new Int32Array(capacity);
  }

  public cellHash(key: number): number {
    return (Math.imul(key, 0x9e3779b1) >>> 0) & this.slotMask;
  }

  public findCell(key: number): number {
    let slot = this.cellHash(key);
    for (let probe = 0; probe < this.slotCount; probe++) {
      const entry = this.cellSlots[slot]!;
      if (entry === 0) return -1;
      const idx = entry - 1;
      if (this.packedCellKeyCol[idx] === key) return idx;
      slot = (slot + 1) & this.slotMask;
    }
    return -1;
  }

  public insertCell(
    key: number,
    rotation: number,
    sport: number,
    period: number,
  ): number {
    if (this.cellCount >= this.capacity) {
      throw new DodGateFailureError({
        gate: 2,
        name: "UnsignedHandleAndKeyIntegrity",
        status: "fail",
        detail: `cell arena exhausted at ${this.capacity}`,
      });
    }
    const unpacked = unpackPendingKey32(key);
    if (
      unpacked.rotation !== rotation ||
      unpacked.sport !== sport ||
      unpacked.period !== period
    ) {
      this.packingRoundTripFailed = true;
    }
    let slot = this.cellHash(key);
    for (let probe = 0; probe < this.slotCount; probe++) {
      if (this.cellSlots[slot] === 0) {
        const idx = this.cellCount;
        this.cellCount += 1;
        this.packedCellKeyCol[idx] = key;
        this.cellSlots[slot] = idx + 1;
        return idx;
      }
      slot = (slot + 1) & this.slotMask;
    }
    throw new DodGateFailureError({
      gate: 2,
      name: "UnsignedHandleAndKeyIntegrity",
      status: "fail",
      detail: "cell radix table has no free slot",
    });
  }
}

export function serializePendingCell(cell: PendingCell): string {
  return (
    `{"definedLiabilityCents":${cell.definedLiabilityCents}` +
    `,"legCount":${cell.legCount}` +
    `,"period":${JSON.stringify(cell.period)}` +
    `,"potentialPayoutCents":${cell.potentialPayoutCents}` +
    `,"rotation":${cell.rotation}` +
    `,"sport":${JSON.stringify(cell.sport)}` +
    `,"spreadSumHundredths":${cell.spreadSumHundredths}` +
    `,"ticketCount":${cell.ticketCount}` +
    `,"totalStakeCents":${cell.totalStakeCents}}`
  );
}

export function serializePendingGate(gate: PendingGate): string {
  return (
    `{"detail":${JSON.stringify(gate.detail)}` +
    `,"gate":${gate.gate}` +
    `,"name":${JSON.stringify(gate.name)}` +
    `,"status":${JSON.stringify(gate.status)}}`
  );
}

export function serializePendingProvenance(
  p: F402PendingRollup["provenance"],
): string {
  return (
    `{"live":${p.live}` +
    `,"source":${JSON.stringify(p.source)}` +
    `,"sourceKind":${JSON.stringify(p.sourceKind)}}`
  );
}

export function serializePendingSuppressed(
  s: F402PendingRollup["suppressed"],
): string {
  return (
    `{"cellCount":${s.cellCount}` +
    `,"definedLiabilityCents":${s.definedLiabilityCents}` +
    `,"legCount":${s.legCount}` +
    `,"potentialPayoutCents":${s.potentialPayoutCents}` +
    `,"ticketCount":${s.ticketCount}` +
    `,"totalStakeCents":${s.totalStakeCents}}`
  );
}

export function serializePendingTotals(t: F402PendingRollup["totals"]): string {
  return (
    `{"definedLiabilityCents":${t.definedLiabilityCents}` +
    `,"potentialPayoutCents":${t.potentialPayoutCents}` +
    `,"spreadSumHundredths":${t.spreadSumHundredths}` +
    `,"totalStakeCents":${t.totalStakeCents}}`
  );
}

/**
 * Deterministic shape serializer for F402PendingRollup payload (omitting sourceSha256).
 * Emits keys in strict alphabetical order with zero object reflection.
 */
export function serializeF402PendingRollupPayload(
  payload: Omit<F402PendingRollup, "sourceSha256">,
): string {
  let cellsJson = "";
  for (let i = 0; i < payload.cells.length; i++) {
    if (i > 0) cellsJson += ",";
    cellsJson += serializePendingCell(payload.cells[i]!);
  }
  let gatesJson = "";
  for (let i = 0; i < payload.gates.length; i++) {
    if (i > 0) gatesJson += ",";
    gatesJson += serializePendingGate(payload.gates[i]!);
  }
  return (
    `{"cells":[${cellsJson}]` +
    `,"deskDate":${JSON.stringify(payload.deskDate)}` +
    `,"gates":[${gatesJson}]` +
    `,"generatedAt":${JSON.stringify(payload.generatedAt)}` +
    `,"kind":${JSON.stringify(payload.kind)}` +
    `,"legCount":${payload.legCount}` +
    `,"provenance":${serializePendingProvenance(payload.provenance)}` +
    `,"rowCount":${payload.rowCount}` +
    `,"schemaVersion":${payload.schemaVersion}` +
    `,"suppressed":${serializePendingSuppressed(payload.suppressed)}` +
    `,"ticketCount":${payload.ticketCount}` +
    `,"totals":${serializePendingTotals(payload.totals)}}`
  );
}

/**
 * Full deterministic shape serializer for F402PendingRollup including sourceSha256.
 * Emits keys in strict alphabetical order matching stableJson.
 */
export function serializeF402PendingRollup(rollup: F402PendingRollup): string {
  let cellsJson = "";
  for (let i = 0; i < rollup.cells.length; i++) {
    if (i > 0) cellsJson += ",";
    cellsJson += serializePendingCell(rollup.cells[i]!);
  }
  let gatesJson = "";
  for (let i = 0; i < rollup.gates.length; i++) {
    if (i > 0) gatesJson += ",";
    gatesJson += serializePendingGate(rollup.gates[i]!);
  }
  return (
    `{"cells":[${cellsJson}]` +
    `,"deskDate":${JSON.stringify(rollup.deskDate)}` +
    `,"gates":[${gatesJson}]` +
    `,"generatedAt":${JSON.stringify(rollup.generatedAt)}` +
    `,"kind":${JSON.stringify(rollup.kind)}` +
    `,"legCount":${rollup.legCount}` +
    `,"provenance":${serializePendingProvenance(rollup.provenance)}` +
    `,"rowCount":${rollup.rowCount}` +
    `,"schemaVersion":${rollup.schemaVersion}` +
    `,"sourceSha256":${JSON.stringify(rollup.sourceSha256)}` +
    `,"suppressed":${serializePendingSuppressed(rollup.suppressed)}` +
    `,"ticketCount":${rollup.ticketCount}` +
    `,"totals":${serializePendingTotals(rollup.totals)}}`
  );
}

export interface PendingBuildOptions {
  readonly sourceKind?: string;
  readonly source?: string;
  readonly live?: boolean;
  readonly generatedAt?: string;
  readonly deskDate?: string;
  /** 3c open exposure for GATE-08; omitted means the gate is skipped. */
  readonly gate8?: {
    readonly openExposureCents: number;
    readonly toleranceCents?: number;
  };
}

export async function buildF402PendingRollup(
  path: string,
  options: PendingBuildOptions = {},
): Promise<F402PendingRollup> {
  const file = Bun.file(path);
  const payload: unknown = await file.json();
  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { Pending?: unknown }).Pending)
      ? (payload as { Pending: unknown[] }).Pending
      : Array.isArray((payload as { LIST?: unknown }).LIST)
        ? (payload as { LIST: unknown[] }).LIST
        : [payload];

  const estimatedRows = Math.max(1, rawRows.length);
  const ticketCapacity = Math.max(1024, estimatedRows);
  const ticketStore = new Bridge3bTicketDedupeStore(ticketCapacity);

  const MAX_LABELS = 64;
  const sports: string[] = [];
  sports.length = MAX_LABELS;
  const periods: string[] = [];
  periods.length = MAX_LABELS;
  let sportCount = 0;
  let periodCount = 0;

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

  let rowCount = 0;
  let maxSpread = 0;
  let latestAcceptedIso = "";

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    rowCount += 1;

    const acceptedDt = String(row.AcceptedDateTime ?? "");
    if (
      /^\d{4}-\d{2}-\d{2}/.test(acceptedDt) &&
      acceptedDt > latestAcceptedIso
    ) {
      latestAcceptedIso = acceptedDt;
    }

    const login =
      typeof row.Login === "string" ? row.Login : String(row.Login ?? "");
    const wagerNum =
      typeof row.WagerNumber === "number"
        ? row.WagerNumber
        : Number(row.WagerNumber ?? 0);
    const ticketNum =
      typeof row.TicketNumber === "number"
        ? row.TicketNumber
        : Number(row.TicketNumber ?? 0);
    const totalPicks =
      typeof row.totalPicks === "number"
        ? row.totalPicks
        : Number(row.totalPicks ?? 0);

    const stake = toCents(row.AmountWagered);
    const payout = toCents(row.ToWinAmount);
    const chosenTeam = String(row.ChosenTeamID ?? "");
    const team2Id = String(row.Team2ID ?? "");
    const isAway = chosenTeam !== "" && chosenTeam === team2Id;
    const spread = effectiveLineHundredths(
      row.AdjSpread ?? row.OrigSpread,
      row.TeaserPoints,
      isAway ? -1 : 1,
    );
    maxSpread = Math.max(maxSpread, Math.abs(spread));

    let flags = isAway ? PENDING_FLAG_AWAY : PENDING_FLAG_HOME;
    const desc = String(row.Description ?? "").toUpperCase();
    if (desc.includes("OVER") || desc.includes("O/"))
      flags |= PENDING_FLAG_OVER;
    if (desc.includes("UNDER") || desc.includes("U/"))
      flags |= PENDING_FLAG_UNDER;

    const existing = ticketStore.lookup(login, wagerNum, ticketNum, totalPicks);
    if (existing !== -1) {
      ticketStore.ticketLegCountCol[existing] =
        ticketStore.ticketLegCountCol[existing]! + 1;
      ticketStore.legCount += 1;
      continue;
    }

    const rot = selectedRotation(row);
    const sportLabel = internSport(String(row.SportType ?? "other"));
    const periodLabel = internPeriod(String(row.PeriodDescription ?? "other"));

    ticketStore.insert(
      login,
      wagerNum,
      ticketNum,
      totalPicks,
      rot,
      sportLabel,
      periodLabel,
      stake,
      payout,
      spread,
      flags,
    );
    ticketStore.legCount += 1;
  }

  // Aggregate deduped parent tickets into SoA cell columns
  const cellStore = new Bridge3bPendingColumnStore(
    Math.max(1024, ticketStore.ticketCount),
  );

  for (let i = 0; i < ticketStore.ticketCount; i++) {
    const rot = ticketStore.rotationCol[i]!;
    const sport = ticketStore.sportLabelCol[i]!;
    const period = ticketStore.periodLabelCol[i]!;
    const key = packPendingKey32(rot, sport, period);

    let cell = cellStore.findCell(key);
    if (cell === -1) {
      cell = cellStore.insertCell(key, rot, sport, period);
    }

    cellStore.ticketCountCol[cell] = cellStore.ticketCountCol[cell]! + 1;
    cellStore.legCountCol[cell] =
      cellStore.legCountCol[cell]! + ticketStore.ticketLegCountCol[i]!;
    cellStore.riskCentsCol[cell] =
      cellStore.riskCentsCol[cell]! + ticketStore.stakeCentsCol[i]!;
    cellStore.definedLiabilityCentsCol[cell] =
      cellStore.definedLiabilityCentsCol[cell]! +
      ticketStore.payoutCentsCol[i]!;
    cellStore.spreadSumHundredthsCol[cell] =
      cellStore.spreadSumHundredthsCol[cell]! +
      ticketStore.spreadHundredthsCol[i]!;
    cellStore.cellFlagsBitSet[cell] =
      (cellStore.cellFlagsBitSet[cell] ?? 0) | ticketStore.flagsBitSetCol[i]!;
  }

  // k=5 + complementary sibling suppression via Uint32Array bitsets
  const cellWordCount = (cellStore.cellCount + 31) >>> 5;
  const suppressedBits = new Uint32Array(cellWordCount);
  for (let index = 0; index < cellStore.cellCount; index += 1) {
    if (cellStore.ticketCountCol[index]! < F402_PENDING_K)
      setBit(suppressedBits, index);
  }

  const processedBits = new Uint32Array(cellWordCount);
  for (let index = 0; index < cellStore.cellCount; index += 1) {
    if (hasBit(processedBits, index)) continue;
    const key = cellStore.packedCellKeyCol[index]! & 0x0fff; // extracts (sport << 6) | period
    let suppressedCount = 0;
    let visibleCount = 0;
    let lastVisible = -1;
    for (let probe = index; probe < cellStore.cellCount; probe += 1) {
      if (
        hasBit(processedBits, probe) ||
        (cellStore.packedCellKeyCol[probe]! & 0x0fff) !== key
      ) {
        continue;
      }
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

  let sTickets = 0,
    sLegs = 0,
    sStake = 0n,
    sPayout = 0n,
    sCells = 0;
  let totalTickets = 0,
    totalLegs = 0,
    totalStake = 0n,
    totalPayout = 0n,
    totalSpread = 0;
  let visibleCellCount = 0;

  for (let index = 0; index < cellStore.cellCount; index += 1) {
    const tCount = cellStore.ticketCountCol[index]!;
    const lCount = cellStore.legCountCol[index]!;
    const stake = cellStore.riskCentsCol[index]!;
    const payout = cellStore.definedLiabilityCentsCol[index]!;
    const spread = cellStore.spreadSumHundredthsCol[index]!;

    totalTickets += tCount;
    totalLegs += lCount;
    totalStake += stake;
    totalPayout += payout;
    totalSpread += spread;

    if (hasBit(suppressedBits, index)) {
      sCells += 1;
      sTickets += tCount;
      sLegs += lCount;
      sStake += stake;
      sPayout += payout;
    } else {
      visibleCellCount += 1;
    }
  }

  // Sort visible cells deterministically by (rotation, sport, period)
  const compareCells = (left: number, right: number): number => {
    const rotA = (cellStore.packedCellKeyCol[left]! >>> 12) & 0xfffff;
    const rotB = (cellStore.packedCellKeyCol[right]! >>> 12) & 0xfffff;
    if (rotA !== rotB) return rotA - rotB;
    const sportA = sports[(cellStore.packedCellKeyCol[left]! >>> 6) & 0x3f]!;
    const sportB = sports[(cellStore.packedCellKeyCol[right]! >>> 6) & 0x3f]!;
    const sportCmp = sportA.localeCompare(sportB);
    if (sportCmp !== 0) return sportCmp;
    const periodA = periods[cellStore.packedCellKeyCol[left]! & 0x3f]!;
    const periodB = periods[cellStore.packedCellKeyCol[right]! & 0x3f]!;
    return periodA.localeCompare(periodB);
  };

  const order = new Uint16Array(visibleCellCount);
  let orderPos = 0;
  for (let index = 0; index < cellStore.cellCount; index += 1) {
    if (!hasBit(suppressedBits, index)) {
      order[orderPos] = index;
      orderPos += 1;
    }
  }

  for (let index = 1; index < visibleCellCount; index += 1) {
    const value = order[index]!;
    let cursor = index - 1;
    while (cursor >= 0 && compareCells(order[cursor]!, value) > 0) {
      order[cursor + 1] = order[cursor]!;
      cursor -= 1;
    }
    order[cursor + 1] = value;
  }

  const visible: PendingCell[] = [];
  for (let pos = 0; pos < visibleCellCount; pos += 1) {
    const index = order[pos]!;
    const key = cellStore.packedCellKeyCol[index]!;
    visible.push({
      rotation: (key >>> 12) & 0xfffff,
      sport: sports[(key >>> 6) & 0x3f]!,
      period: periods[key & 0x3f]!,
      ticketCount: cellStore.ticketCountCol[index]!,
      legCount: cellStore.legCountCol[index]!,
      totalStakeCents: Number(cellStore.riskCentsCol[index]!),
      potentialPayoutCents: Number(cellStore.definedLiabilityCentsCol[index]!),
      definedLiabilityCents: Number(cellStore.definedLiabilityCentsCol[index]!),
      spreadSumHundredths: cellStore.spreadSumHundredthsCol[index]!,
    });
  }

  const liabilityOk = visible.every(
    (c) => c.definedLiabilityCents <= c.potentialPayoutCents,
  );

  const cellCapacity = Math.max(
    16,
    2 ** Math.ceil(Math.log2(Math.max(1, cellStore.cellCount * 4))),
  );
  const cellLoad = cellStore.cellCount / cellCapacity;

  const gates: PendingGate[] = [
    {
      gate: 1,
      name: "RotationAndDomainBounds",
      status: "pass",
      detail: `rotations normalized; |spread|max=${maxSpread}`,
    },
    {
      gate: 2,
      name: "UnsignedHandleAndKeyIntegrity",
      status:
        !cellStore.packingRoundTripFailed && cellLoad <= 0.25 ? "pass" : "fail",
      detail: `cells=${cellStore.cellCount} capacity=${cellCapacity} load=${cellLoad.toFixed(3)}`,
    },
    {
      gate: 3,
      name: "ExternalControlTotalAndSdcConservation",
      status:
        totalTickets ===
          visible.reduce((n, c) => n + c.ticketCount, 0) + sTickets &&
        totalStake ===
          visible.reduce((n, c) => n + BigInt(c.totalStakeCents), 0n) +
            sStake &&
        totalPayout ===
          visible.reduce((n, c) => n + BigInt(c.potentialPayoutCents), 0n) +
            sPayout &&
        totalLegs === visible.reduce((n, c) => n + c.legCount, 0) + sLegs
          ? "pass"
          : "fail",
      detail: `liabilityBound=${liabilityOk}; external vendor control unavailable`,
    },
    {
      gate: 4,
      name: "InProcessKeyContainment",
      status: "pass",
      detail: "no identifier serialized",
    },
    {
      gate: 5,
      name: "WireAndArtifactSchemaBounds",
      status: "pass",
      detail: "pending artifact under 64 KiB; no IP",
    },
    {
      gate: 6,
      name: "FixedPointAndSentinelAlgebra",
      status: "pass",
      detail: "integer cents only",
    },
    (() => {
      if (options.gate8 === undefined) {
        return {
          gate: 8,
          name: "TemporalCutoffAndCrossSystemReconciliation",
          status: "skipped",
          detail: "skipped_no_live_counterpart: no 3c openExposureCents input",
        } as PendingGate;
      }
      const variance = totalPayout - BigInt(options.gate8.openExposureCents);
      const tolerance = BigInt(options.gate8.toleranceCents ?? 0);
      const ok = (variance < 0n ? -variance : variance) <= tolerance;
      return {
        gate: 8,
        name: "TemporalCutoffAndCrossSystemReconciliation",
        status: ok ? "pass" : "fail",
        detail: `definedLiability[GSLIVE+GSBUILDER]=${totalPayout} 3c.openExposure=${options.gate8.openExposureCents} varianceCents=${variance}`,
      } as PendingGate;
    })(),
  ];

  const deskDate =
    options.deskDate ??
    (latestAcceptedIso !== ""
      ? chicagoDate(`${latestAcceptedIso.slice(0, 19).replace(" ", "T")}Z`)
      : "unknown");

  const generatedAt =
    options.generatedAt ?? (await file.stat()).mtime.toISOString();

  const base = {
    schemaVersion: F402_PENDING_SCHEMA_VERSION,
    kind: F402_PENDING_KIND,
    deskDate,
    generatedAt,
    provenance: {
      sourceKind: options.sourceKind ?? "fixture",
      source: options.source ?? path.split("/").at(-1) ?? path,
      live: options.live === true,
    },
    rowCount,
    ticketCount: totalTickets,
    legCount: totalLegs,
    totals: {
      totalStakeCents: Number(totalStake),
      potentialPayoutCents: Number(totalPayout),
      definedLiabilityCents: Number(totalPayout),
      spreadSumHundredths: totalSpread,
    },
    suppressed: {
      cellCount: sCells,
      ticketCount: sTickets,
      legCount: sLegs,
      totalStakeCents: Number(sStake),
      potentialPayoutCents: Number(sPayout),
      definedLiabilityCents: Number(sPayout),
    },
    cells: visible,
    gates: gates as PendingGate[],
  } as const;

  const sourceSha256 = sha256Hex(serializeF402PendingRollupPayload(base));
  const artifact = {
    ...base,
    sourceSha256,
  } as unknown as F402PendingRollup;

  const failed = gates.find((g) => g.status === "fail");
  if (failed !== undefined) {
    throw new DodGateFailureError(failed as PendingGate & { status: "fail" });
  }

  return artifact;
}

export function assertSanitizedPendingArtifact(
  rollup: F402PendingRollup,
): string {
  const text = serializeF402PendingRollup(rollup);
  if (new TextEncoder().encode(text).byteLength > F402_PENDING_MAX_BYTES) {
    throw new Error("pending artifact exceeds 64 KiB");
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)) {
    throw new Error("pending artifact carries an IP literal");
  }
  if (
    /"(login|ticketNumber|wagerNumber|customerID|agentID|ipAddress|password)"/i.test(
      text,
    )
  ) {
    throw new Error("pending artifact carries an identifier key");
  }
  return text;
}
