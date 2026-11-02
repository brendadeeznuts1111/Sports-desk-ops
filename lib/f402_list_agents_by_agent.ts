/**
 * Parse Manager `getListAgenstByAgent` responses (`{ GENERAL, PLAYERS, EXTRA }`).
 * `GENERAL` is the flat agent tree; `PLAYERS` may include plaintext passwords — redact before logs.
 */

export type F402AgentTypeWire = "A" | "M" | (string & {});

/** Commission / product rate columns on `GENERAL` rows (PascalCase on wire). */
export interface ListAgentsByAgentGeneralWireRates {
  readonly AmigoTechRate?: number;
  readonly BetBuilderRate?: number;
  readonly CasinoHeadCountRateM?: number;
  readonly CrashRate?: number;
  readonly ExtPropsRate?: number;
  readonly FantasyRate?: number;
  readonly FlashBetsRate?: number;
  readonly GitCasinoRate?: number;
  readonly HeadCountRateM?: number;
  readonly InetHeadCountRateM?: number;
  readonly LiveBetting2RateM?: number;
  readonly LiveBettingRateM?: number;
  readonly LiveCasinoRateM?: number;
  readonly PropBuilderRateM?: number;
}

/** Raw wire row (PascalCase keys from JSON). */
export interface ListAgentsByAgentGeneralWireRow extends ListAgentsByAgentGeneralWireRates {
  readonly AgentID?: string;
  readonly Login?: string;
  readonly SeqNumber?: number;
  readonly Level?: number;
  readonly AgentType?: F402AgentTypeWire;
  readonly [key: string]: unknown;
}

export interface ListAgentsByAgentPlayerWireRow {
  readonly customerID?: string;
  readonly Login?: string;
  readonly NameFirst?: string;
  readonly Password?: string;
  readonly Agent?: string;
  readonly [key: string]: unknown;
}

/** Normalized player row — never includes `Password` (use wire + redact for audits). */
export interface AgentTreePlayerRow {
  readonly customerId: string;
  readonly login: string;
  readonly nameFirst: string;
  readonly agent: string;
}

/** Observed manager-boot capture scale (~5.7k PLAYERS, ~2.5k GENERAL — not ~57k). */
export const F402_PLAYERS_TYPICAL_COUNT = 5763;

export interface PlayerCustomerIdShape {
  readonly trimmed: string;
  readonly hasNumericSuffix: boolean;
  readonly suffix: string | null;
  readonly hasEllipsis: boolean;
}

export function parsePlayerCustomerIdShape(
  customerId: string,
): PlayerCustomerIdShape {
  const trimmed = customerId.trim();
  const suffixMatch = trimmed.match(/_(\d+)$/);
  return {
    trimmed,
    hasNumericSuffix: suffixMatch !== null,
    suffix: suffixMatch?.[1] ?? null,
    hasEllipsis: trimmed.includes(".."),
  };
}

export function isBlankPaddedField(raw: string | undefined): boolean {
  return trimPaddedField(raw) === "";
}

export function normalizeAgentTreePlayerRow(
  wire: ListAgentsByAgentPlayerWireRow,
): AgentTreePlayerRow | null {
  const customerId = trimPaddedField(wire.customerID);
  const login = trimPaddedField(wire.Login);
  if (customerId === "" && login === "") return null;
  return {
    customerId: customerId || login,
    login: login || customerId,
    nameFirst: trimPaddedField(wire.NameFirst),
    agent: trimPaddedField(wire.Agent),
  };
}

export function normalizeAgentTreePlayerRows(
  wireRows: readonly ListAgentsByAgentPlayerWireRow[],
): AgentTreePlayerRow[] {
  const out: AgentTreePlayerRow[] = [];
  for (const row of wireRows) {
    const normalized = normalizeAgentTreePlayerRow(row);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

export interface ListAgentsByAgentPlayerSummary {
  readonly playerCount: number;
  readonly distinctAgents: number;
  readonly emptyNameFirstCount: number;
  readonly blankPasswordCount: number;
  readonly hasPortalDummyRow: boolean;
  readonly customerIdWithSuffixCount: number;
  readonly customerIdEllipsisCount: number;
}

export function summarizeListAgentsByAgentPlayers(
  players: readonly ListAgentsByAgentPlayerWireRow[],
): ListAgentsByAgentPlayerSummary {
  const agents = new Set<string>();
  let emptyNameFirstCount = 0;
  let blankPasswordCount = 0;
  let customerIdWithSuffixCount = 0;
  let customerIdEllipsisCount = 0;

  for (const wire of players) {
    const normalized = normalizeAgentTreePlayerRow(wire);
    if (normalized?.agent) agents.add(normalized.agent);
    if (normalized && normalized.nameFirst === "") emptyNameFirstCount += 1;
    if (isBlankPaddedField(wire.Password)) blankPasswordCount += 1;
    const id = trimPaddedField(wire.customerID);
    if (id !== "") {
      const shape = parsePlayerCustomerIdShape(id);
      if (shape.hasNumericSuffix) customerIdWithSuffixCount += 1;
      if (shape.hasEllipsis) customerIdEllipsisCount += 1;
    }
  }

  const first = normalizeAgentTreePlayerRow(players[0] ?? {});
  const hasPortalDummyRow =
    first !== null && first.customerId === "1_0" && first.nameFirst === "Dummy";

  return {
    playerCount: players.length,
    distinctAgents: agents.size,
    emptyNameFirstCount,
    blankPasswordCount,
    hasPortalDummyRow,
    customerIdWithSuffixCount,
    customerIdEllipsisCount,
  };
}

export interface ListAgentsByAgentEnvelope {
  readonly GENERAL: ListAgentsByAgentGeneralWireRow[];
  readonly PLAYERS: ListAgentsByAgentPlayerWireRow[];
  readonly EXTRA?: boolean;
}

/** Normalized commission rates (camelCase). */
export interface AgentTreeGeneralRates {
  readonly amigoTechRate: number;
  readonly betBuilderRate: number;
  readonly casinoHeadCountRateM: number;
  readonly crashRate: number;
  readonly extPropsRate: number;
  readonly fantasyRate: number;
  readonly flashBetsRate: number;
  readonly gitCasinoRate: number;
  readonly headCountRateM: number;
  readonly inetHeadCountRateM: number;
  readonly liveBetting2RateM: number;
  readonly liveBettingRateM: number;
  readonly liveCasinoRateM: number;
  readonly propBuilderRateM: number;
}

/** Normalized agent tree row (camelCase primitives for TS consumers). */
export interface AgentTreeGeneralRow {
  readonly seqNumber: number;
  readonly level: number;
  readonly agentType: string;
  readonly agentId: string;
  readonly login: string;
  readonly rates: AgentTreeGeneralRates;
}

export function trimPaddedField(raw: string | undefined): string {
  return (raw ?? "").trim();
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function rateOrZero(value: unknown): number {
  const parsed = num(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeAgentTreeGeneralRates(
  wire: ListAgentsByAgentGeneralWireRates,
): AgentTreeGeneralRates {
  return {
    amigoTechRate: rateOrZero(wire.AmigoTechRate),
    betBuilderRate: rateOrZero(wire.BetBuilderRate),
    casinoHeadCountRateM: rateOrZero(wire.CasinoHeadCountRateM),
    crashRate: rateOrZero(wire.CrashRate),
    extPropsRate: rateOrZero(wire.ExtPropsRate),
    fantasyRate: rateOrZero(wire.FantasyRate),
    flashBetsRate: rateOrZero(wire.FlashBetsRate),
    gitCasinoRate: rateOrZero(wire.GitCasinoRate),
    headCountRateM: rateOrZero(wire.HeadCountRateM),
    inetHeadCountRateM: rateOrZero(wire.InetHeadCountRateM),
    liveBetting2RateM: rateOrZero(wire.LiveBetting2RateM),
    liveBettingRateM: rateOrZero(wire.LiveBettingRateM),
    liveCasinoRateM: rateOrZero(wire.LiveCasinoRateM),
    propBuilderRateM: rateOrZero(wire.PropBuilderRateM),
  };
}

export function parseListAgentsByAgentEnvelope(
  raw: unknown,
): ListAgentsByAgentEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("getListAgenstByAgent envelope must be an object");
  const obj = raw as Record<string, unknown>;
  const general = obj.GENERAL;
  const players = obj.PLAYERS;
  if (!Array.isArray(general)) throw new Error("GENERAL must be an array");
  if (!Array.isArray(players)) throw new Error("PLAYERS must be an array");
  const extra = obj.EXTRA;
  return {
    GENERAL: general as ListAgentsByAgentGeneralWireRow[],
    PLAYERS: players as ListAgentsByAgentPlayerWireRow[],
    ...(extra === undefined ? {} : { EXTRA: Boolean(extra) }),
  };
}

export function normalizeAgentTreeGeneralRow(
  wire: ListAgentsByAgentGeneralWireRow,
): AgentTreeGeneralRow | null {
  const seqNumber = num(wire.SeqNumber);
  const level = num(wire.Level);
  if (!Number.isFinite(seqNumber) || !Number.isFinite(level)) return null;
  const agentType = trimPaddedField(wire.AgentType);
  const agentId = trimPaddedField(wire.AgentID);
  const login = trimPaddedField(wire.Login);
  if (agentType === "" && agentId === "" && login === "") return null;
  return {
    seqNumber,
    level,
    agentType: agentType || "unknown",
    agentId: agentId || login,
    login: login || agentId,
    rates: normalizeAgentTreeGeneralRates(wire),
  };
}

export function normalizeAgentTreeGeneralRows(
  wireRows: readonly ListAgentsByAgentGeneralWireRow[],
): AgentTreeGeneralRow[] {
  const out: AgentTreeGeneralRow[] = [];
  for (const row of wireRows) {
    const normalized = normalizeAgentTreeGeneralRow(row);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

/** First `GENERAL` row in live captures is typically `5183` (= seq at array index 0). */
export const F402_GENERAL_SEQ_BASE_AT_INDEX_ZERO = 5183;

export interface GeneralSeqIndexCheck {
  readonly ok: boolean;
  readonly base: number;
  readonly firstMismatch: {
    readonly index: number;
    readonly expected: number;
    readonly actual: number;
  } | null;
}

/** True when each row’s `SeqNumber` equals `base + arrayIndex` (default base = row 0 seq). */
export function generalSeqNumbersMatchBasePlusIndex(
  general: readonly ListAgentsByAgentGeneralWireRow[],
  base?: number,
): GeneralSeqIndexCheck {
  if (general.length === 0) {
    return {
      ok: true,
      base: base ?? F402_GENERAL_SEQ_BASE_AT_INDEX_ZERO,
      firstMismatch: null,
    };
  }
  const resolvedBase =
    base ??
    (Number.isFinite(num(general[0]!.SeqNumber))
      ? num(general[0]!.SeqNumber)
      : F402_GENERAL_SEQ_BASE_AT_INDEX_ZERO);
  for (let i = 0; i < general.length; i++) {
    const actual = num(general[i]!.SeqNumber);
    const expected = resolvedBase + i;
    if (actual !== expected) {
      return {
        ok: false,
        base: resolvedBase,
        firstMismatch: { index: i, expected, actual },
      };
    }
  }
  return { ok: true, base: resolvedBase, firstMismatch: null };
}

export interface ListAgentsByAgentSummary {
  readonly generalCount: number;
  readonly playerCount: number;
  readonly players: ListAgentsByAgentPlayerSummary;
  readonly agentTypeCounts: Readonly<Record<string, number>>;
  readonly levelMin: number | null;
  readonly levelMax: number | null;
  readonly seqNumberMin: number | null;
  readonly seqNumberMax: number | null;
  readonly seqNumberStrictlyConsecutive: boolean;
  readonly seqNumberEqualsBasePlusIndex: boolean;
  readonly seqNumberBase: number | null;
  readonly duplicateSeqNumbers: readonly number[];
}

export function summarizeListAgentsByAgent(
  envelope: ListAgentsByAgentEnvelope,
): ListAgentsByAgentSummary {
  const normalized = normalizeAgentTreeGeneralRows(envelope.GENERAL);
  const agentTypeCounts: Record<string, number> = {};
  let levelMin: number | null = null;
  let levelMax: number | null = null;
  let seqMin: number | null = null;
  let seqMax: number | null = null;
  const seqSeen = new Map<number, number>();

  for (const row of normalized) {
    agentTypeCounts[row.agentType] = (agentTypeCounts[row.agentType] ?? 0) + 1;
    levelMin = levelMin === null ? row.level : Math.min(levelMin, row.level);
    levelMax = levelMax === null ? row.level : Math.max(levelMax, row.level);
    seqMin = seqMin === null ? row.seqNumber : Math.min(seqMin, row.seqNumber);
    seqMax = seqMax === null ? row.seqNumber : Math.max(seqMax, row.seqNumber);
    seqSeen.set(row.seqNumber, (seqSeen.get(row.seqNumber) ?? 0) + 1);
  }

  let seqNumberStrictlyConsecutive = normalized.length <= 1;
  if (normalized.length > 1) {
    seqNumberStrictlyConsecutive = true;
    for (let i = 1; i < normalized.length; i++) {
      if (normalized[i]!.seqNumber !== normalized[i - 1]!.seqNumber + 1) {
        seqNumberStrictlyConsecutive = false;
        break;
      }
    }
  }

  const duplicateSeqNumbers = [...seqSeen.entries()]
    .filter(([, count]) => count > 1)
    .map(([seq]) => seq)
    .sort((a, b) => a - b);

  const seqIndexCheck = generalSeqNumbersMatchBasePlusIndex(envelope.GENERAL);

  return {
    generalCount: envelope.GENERAL.length,
    playerCount: envelope.PLAYERS.length,
    players: summarizeListAgentsByAgentPlayers(envelope.PLAYERS),
    agentTypeCounts,
    levelMin,
    levelMax,
    seqNumberMin: seqMin,
    seqNumberMax: seqMax,
    seqNumberStrictlyConsecutive,
    seqNumberEqualsBasePlusIndex: seqIndexCheck.ok,
    seqNumberBase: envelope.GENERAL.length > 0 ? seqIndexCheck.base : null,
    duplicateSeqNumbers,
  };
}

/** One-line probe hint (no PII; safe for stderr). */
export function describeListAgentsByAgentProbeResponse(
  rawBody: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  try {
    const envelope = parseListAgentsByAgentEnvelope(parsed);
    const summary = summarizeListAgentsByAgent(envelope);
    const parts = [
      `GENERAL=${summary.generalCount}`,
      `PLAYERS=${summary.playerCount}`,
      `seqBase=${summary.seqNumberBase ?? "?"}`,
      `seqIndex=${summary.seqNumberEqualsBasePlusIndex ? "ok" : "mismatch"}`,
      `level=${summary.levelMin ?? "?"}-${summary.levelMax ?? "?"}`,
      `dummyRow=${summary.players.hasPortalDummyRow}`,
    ];
    return parts.join(" ");
  } catch {
    return null;
  }
}

/** Shallow-copy envelope with player `Password` redacted. */
export function redactListAgentsByAgentEnvelope(
  envelope: ListAgentsByAgentEnvelope,
): ListAgentsByAgentEnvelope {
  return {
    ...envelope,
    PLAYERS: envelope.PLAYERS.map((row) => {
      if (!("Password" in row)) return row;
      return { ...row, Password: "<redacted>" };
    }),
  };
}
