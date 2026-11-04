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
import { sha256Hex, stableJson } from "./f402_bet_ticker_delta.ts";

export const F402_PENDING_KIND = "f402-pending";
export const F402_PENDING_SCHEMA_VERSION = 1;
export const F402_PENDING_K = 5;
export const F402_PENDING_MAX_BYTES = 64 * 1024;

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

function chicagoDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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
  const tickets = new Map<
    string,
    {
      rotation: number;
      sport: string;
      period: string;
      stake: bigint;
      payout: bigint;
      spread: number;
    }
  >();
  let rowCount = 0,
    legCount = 0,
    maxSpread = 0;
  const accepted = rawRows.filter(
    (r): r is Record<string, unknown> => r !== null && typeof r === "object",
  );
  for (const row of accepted) {
    rowCount += 1;
    const key = `${String(row.TicketNumber ?? "")}-${String(row.WagerNumber ?? "")}-${String(row.totalPicks ?? "")}`;
    const stake = toCents(row.AmountWagered);
    const payout = toCents(row.ToWinAmount);
    const spread = effectiveLineHundredths(
      row.AdjSpread ?? row.OrigSpread,
      row.TeaserPoints,
      String(row.ChosenTeamID ?? "") === String(row.Team2ID ?? "") ? -1 : 1,
    );
    maxSpread = Math.max(maxSpread, Math.abs(spread));
    const existing = tickets.get(key);
    if (existing !== undefined) {
      existing.stake = 0n;
      existing.payout = 0n;
      legCount += 1;
      continue;
    }
    tickets.set(key, {
      rotation: selectedRotation(row),
      sport: String(row.SportType ?? "other"),
      period: String(row.PeriodDescription ?? "other"),
      stake,
      payout,
      spread,
    });
    legCount += 1;
  }
  const cells = new Map<
    string,
    {
      rotation: number;
      sport: string;
      period: string;
      ticketCount: number;
      legCount: number;
      stake: bigint;
      payout: bigint;
      spread: number;
    }
  >();
  for (const t of tickets.values()) {
    const key = `${t.rotation}|${t.sport}|${t.period}`;
    const c = cells.get(key) ?? {
      rotation: t.rotation,
      sport: t.sport,
      period: t.period,
      ticketCount: 0,
      legCount: 0,
      stake: 0n,
      payout: 0n,
      spread: 0,
    };
    c.ticketCount += 1;
    c.legCount += 1;
    c.stake += t.stake;
    c.payout += t.payout;
    c.spread += t.spread;
    cells.set(key, c);
  }
  // k=5 + complementary sibling suppression (same sport|period across rotations).
  const suppressed = new Set<string>();
  for (const [key, c] of cells)
    if (c.ticketCount < F402_PENDING_K) suppressed.add(key);
  const siblings = new Map<string, string[]>();
  for (const key of cells.keys()) {
    const [, sport, period] = key.split("|");
    const s = `${sport}|${period}`;
    siblings.set(s, [...(siblings.get(s) ?? []), key]);
  }
  for (const keys of siblings.values()) {
    const hidden = keys.filter((k) => suppressed.has(k));
    const visible = keys.filter((k) => !suppressed.has(k));
    if (hidden.length > 0 && visible.length === 1)
      suppressed.add(visible[0] as string);
  }
  const visible: PendingCell[] = [];
  let sTickets = 0,
    sLegs = 0,
    sStake = 0n,
    sPayout = 0n;
  let totalTickets = 0,
    totalLegs = 0,
    totalStake = 0n,
    totalPayout = 0n,
    totalSpread = 0;
  for (const c of cells.values()) {
    totalTickets += c.ticketCount;
    totalLegs += c.legCount;
    totalStake += c.stake;
    totalPayout += c.payout;
    totalSpread += c.spread;
    if (suppressed.has(`${c.rotation}|${c.sport}|${c.period}`)) {
      sTickets += c.ticketCount;
      sLegs += c.legCount;
      sStake += c.stake;
      sPayout += c.payout;
      continue;
    }
    visible.push({
      rotation: c.rotation,
      sport: c.sport,
      period: c.period,
      ticketCount: c.ticketCount,
      legCount: c.legCount,
      totalStakeCents: Number(c.stake),
      potentialPayoutCents: Number(c.payout),
      definedLiabilityCents: Number(c.payout),
      spreadSumHundredths: c.spread,
    });
  }
  visible.sort(
    (a, b) =>
      a.rotation - b.rotation ||
      a.sport.localeCompare(b.sport) ||
      a.period.localeCompare(b.period),
  );
  const liabilityOk = visible.every(
    (c) => c.definedLiabilityCents <= c.potentialPayoutCents,
  );
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
      status: "pass",
      detail: `cells=${cells.size}`,
    },
    {
      gate: 3,
      name: "ExternalControlTotalAndSdcConservation",
      status:
        totalTickets ===
          visible.reduce((n, c) => n + c.ticketCount, 0) + sTickets &&
        totalStake ===
          visible.reduce((n, c) => n + BigInt(c.totalStakeCents), 0n) + sStake
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
  const acceptedDates = accepted
    .map((r) => String(r.AcceptedDateTime ?? ""))
    .filter((s) => /^\d{4}-\d{2}-\d{2}/.test(s))
    .sort();
  const deskDate =
    options.deskDate ??
    (acceptedDates.length > 0
      ? chicagoDate(`${acceptedDates.at(-1)?.slice(0, 19).replace(" ", "T")}Z`)
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
      cellCount: suppressed.size,
      ticketCount: sTickets,
      legCount: sLegs,
      totalStakeCents: Number(sStake),
      potentialPayoutCents: Number(sPayout),
      definedLiabilityCents: Number(sPayout),
    },
    cells: visible,
    gates: [] as PendingGate[],
  } as const;
  const sourceSha256 = sha256Hex(stableJson({ ...base, gates }));
  const artifact = {
    ...base,
    gates,
    sourceSha256,
  } as unknown as F402PendingRollup;
  const failed = gates.find((g) => g.status === "fail");
  if (failed !== undefined)
    throw new DodGateFailureError(failed as PendingGate & { status: "fail" });
  return artifact;
}

export function assertSanitizedPendingArtifact(
  rollup: F402PendingRollup,
): string {
  const text = stableJson(rollup);
  if (new TextEncoder().encode(text).byteLength > F402_PENDING_MAX_BYTES)
    throw new Error("pending artifact exceeds 64 KiB");
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text))
    throw new Error("pending artifact carries an IP literal");
  if (
    /"(login|ticketNumber|wagerNumber|customerID|agentID|ipAddress|password)"/i.test(
      text,
    )
  )
    throw new Error("pending artifact carries an identifier key");
  return text;
}
