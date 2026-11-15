/**
 * Universal combo index — semantic legs → canonical_combo_id (no price, no wallet).
 */

import {
  competitionFamilyFromDirectory,
  normalizePaddedField,
} from "./candidate_match_evaluation.ts";
import { canonicalJsonString } from "./match_evaluation_canonical.ts";
import type { Sha256Hex } from "../design/domain-branded-types.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";

export type ComboMarketKind =
  "spread" | "moneyline" | "total_over" | "total_under" | "prop" | "unknown";

export type ComboLegSemantic = {
  participantCode: string;
  marketKind: ComboMarketKind;
  /** Semantic line (+1, -3.5, o47.5) — never price/odds. */
  line: string | null;
};

export type CanonicalComboInput = {
  competitionFamily: string;
  period: string;
  legs: ComboLegSemantic[];
  /** Optional game-day bucket (ISO date) — not a liability snapshot. */
  validTimeWindow?: string;
};

export function normalizePeriodSlug(raw: unknown): string {
  const t = normalizePaddedField(raw);
  if (!t) return "game";
  return t.toLowerCase().replace(/\s+/g, "_");
}

export function marketKindFromShortDesc(raw: unknown): ComboMarketKind {
  if (typeof raw !== "string" || raw.trim() === "") return "unknown";
  const c = raw.trim().charAt(0).toUpperCase();
  switch (c) {
    case "S":
      return "spread";
    case "M":
      return "moneyline";
    case "L":
      return "total_over";
    case "E":
      return "total_under";
    case "P":
      return "prop";
    default:
      return "unknown";
  }
}

export function normalizeParticipantCode(raw: unknown): string | null {
  const t = normalizePaddedField(raw);
  return t ? t.toUpperCase() : null;
}

export function normalizeSemanticLine(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s.replace(/\s+/g, "") : null;
}

export function formatLegSignature(leg: ComboLegSemantic): string {
  const line = leg.line ?? "";
  return `${leg.marketKind}|${leg.participantCode}${line}`;
}

/** Sorted leg signatures joined — price-free semantic key. */
export function deriveCanonicalComboId(input: CanonicalComboInput): string {
  const legPart = [...input.legs].map(formatLegSignature).sort().join(";");
  const base = `${input.competitionFamily}|${input.period}|${legPart}`;
  if (input.validTimeWindow) {
    return `${base}|${input.validTimeWindow}`;
  }
  return base;
}

export function hashCanonicalComboId(id: string): Sha256Hex {
  return sha256HexOfBytes(new TextEncoder().encode(id));
}

export type InternalComboWire = {
  sportType?: string;
  sportSubType?: string;
  periodDescription?: string;
  validTimeWindow?: string;
  legs: Array<Record<string, unknown>>;
};

export function projectInternalCombo(
  wire: InternalComboWire,
): CanonicalComboInput | null {
  const sportType = normalizePaddedField(wire.sportType);
  const sportSubType = normalizePaddedField(wire.sportSubType);
  const { competitionFamily } = competitionFamilyFromDirectory(
    sportType,
    sportSubType,
  );
  if (!competitionFamily) return null;

  const legs: ComboLegSemantic[] = [];
  for (const row of wire.legs) {
    const participantCode =
      normalizeParticipantCode(row.ShortName1 ?? row.Team ?? row.team) ??
      normalizeParticipantCode(row.ShortName2);
    if (!participantCode) continue;
    legs.push({
      participantCode,
      marketKind: marketKindFromShortDesc(row.ShortDesc ?? row.shortDesc),
      line: normalizeSemanticLine(row.Line ?? row.line),
    });
  }
  if (legs.length === 0) return null;

  return {
    competitionFamily,
    period: normalizePeriodSlug(wire.periodDescription),
    legs,
    ...(wire.validTimeWindow !== undefined
      ? { validTimeWindow: wire.validTimeWindow }
      : {}),
  };
}

export type PolymarketComboWire = {
  competitionFamily: string;
  period?: string;
  validTimeWindow?: string;
  legs: Array<{
    team?: string;
    participantCode?: string;
    marketKind?: ComboMarketKind | string;
    line?: string | null;
  }>;
};

export function projectPolymarketCombo(
  wire: PolymarketComboWire,
): CanonicalComboInput | null {
  const legs: ComboLegSemantic[] = [];
  for (const row of wire.legs) {
    const participantCode = normalizeParticipantCode(
      row.participantCode ?? row.team,
    );
    if (!participantCode) continue;
    const mk = row.marketKind;
    const marketKind: ComboMarketKind =
      mk === "spread" ||
      mk === "moneyline" ||
      mk === "total_over" ||
      mk === "total_under" ||
      mk === "prop"
        ? mk
        : "unknown";
    legs.push({
      participantCode,
      marketKind,
      line: normalizeSemanticLine(row.line),
    });
  }
  if (legs.length === 0) return null;
  return {
    competitionFamily: wire.competitionFamily.trim().toUpperCase(),
    period: normalizePeriodSlug(wire.period ?? "game"),
    legs,
    ...(wire.validTimeWindow !== undefined
      ? { validTimeWindow: wire.validTimeWindow }
      : {}),
  };
}

/** Which wire family a payload came from; not a VenueId (f402/gslive use the desk wire). */
export type ComboWireSide = "desk" | "polymarket";

export function canonicalComboFromWire(
  side: ComboWireSide,
  wire: InternalComboWire | PolymarketComboWire,
): { canonicalComboId: string; input: CanonicalComboInput } | null {
  const input =
    side === "desk"
      ? projectInternalCombo(wire as InternalComboWire)
      : projectPolymarketCombo(wire as PolymarketComboWire);
  if (!input) return null;
  return { canonicalComboId: deriveCanonicalComboId(input), input };
}

export function serializeComboLegs(legs: ComboLegSemantic[]): string {
  return canonicalJsonString(legs);
}
