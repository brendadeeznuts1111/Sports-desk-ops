/**
 * @file live_bets.ts
 * @description Derives the live-bets scoreboard view from real F402 `Report/Pending` rows.
 *
 * The row shape and units are the ones already established by `combo_identity.ts`
 * (`F402CustomerReportPendingRow`): `AmountWagered` / `ToWinAmount` are integer cents.
 *
 * Two rules this module keeps:
 *  - Credentials never cross the boundary: `Password`, `NameFirst` and `Login` are dropped
 *    on the way in (`stripPII`), so a derived artifact cannot leak them.
 *  - No invented sportsbook semantics: the source reports `Team1`/`Team2` and a rotation
 *    number, not "home"/"away". Those are exposed as `team1`/`team2` rather than guessed
 *    from rotation parity.
 */

import {
  asLineHundredths,
  asSettledCents,
  parseAsBasisPoints,
  parseAsCents,
  parseAsEpochMs,
  type AmericanOdds,
  type BasisPoints,
  type Brand,
  type Cents,
  type EpochMs,
  type LineHundredths,
  type SettledCents,
} from "../design/domain-branded-types.ts";
import {
  computeF402EffectiveLine,
  extractF402RotationNumber,
  getF402TicketGroupKey,
  parseLineHundredths,
  type F402CustomerReportPendingRow,
} from "./combo_identity.ts";
import {
  evaluateDeskRisk,
  INVALID_AMERICAN_ODDS,
  recordDeskRiskEvaluation,
  scrubDeskIpLiterals,
  tokenizeCustomerId,
  tokenizeTicketId,
  ZERO_CENTS,
  type CustomerDesk,
  type DeskPosition,
  type DeskPositionLeg,
  type DeskRiskProvenance,
  type DeskRiskTelemetrySnapshot,
  type RiskEvaluation,
} from "./desk-parser.ts";
import {
  agentLoginKey,
  detectAgentLoginCollisions,
  generalRowsAboveLevel,
  maxGeneralLevel,
  type AgentLoginCollision,
} from "./f402_hierarchy_agents.ts";
import {
  trimPaddedField,
  type F402AgentTypeWire,
  type ListAgentsByAgentGeneralWireRow,
} from "./f402_list_agents_by_agent.ts";

export {
  asLineHundredths,
  asSettledCents,
  parseAsBasisPoints,
  parseAsCents,
  parseAsEpochMs,
  parseLineHundredths,
};
export type {
  AmericanOdds,
  BasisPoints,
  Brand,
  Cents,
  EpochMs,
  LineHundredths,
  SettledCents,
};

/**
 * Canonical agent identity — trimmed and upper-cased exactly like the portal's
 * `baseHeriarchy` keys. Built only through {@link agentKeyOf}, which delegates to
 * `agentLoginKey`, so a scoreboard lookup can never miss a hierarchy row by case.
 */
export type AgentKey = Brand<string, "AgentKey">;

/** `TicketNumber-WagerNumber`, the composite key the portal itself uses. */
export type TicketKey = Brand<string, "TicketKey">;

/** Customer identifier as reported (`customerID`, trimmed and upper-cased). */
export type CustomerKey = Brand<string, "CustomerKey">;

function asAgentKey(value: string): AgentKey {
  return value as AgentKey;
}

function asCustomerKey(value: string): CustomerKey {
  return value as CustomerKey;
}

/** Canonical agent key for any wire row that carries `AgentID`/`agentID`/`Login`. */
export function agentKeyOf(
  row: Pick<ListAgentsByAgentGeneralWireRow, "AgentID" | "Login"> & {
    readonly agentID?: string | undefined;
    readonly AgentID?: string | undefined;
  },
): AgentKey {
  // `agentLoginKey` is the authoritative normalization (trim + uppercase, login first).
  const asHierarchyRow = {
    Login: row.Login ?? row.agentID ?? row.AgentID,
    AgentID: row.AgentID ?? row.agentID,
  } as ListAgentsByAgentGeneralWireRow;
  return asAgentKey(agentLoginKey(asHierarchyRow));
}

export function customerKeyOf(value: unknown): CustomerKey {
  return asCustomerKey(
    trimPaddedField(
      value === null || value === undefined ? "" : String(value),
    ).toUpperCase(),
  );
}

export function ticketKeyOf(
  row: Pick<F402CustomerReportPendingRow, "TicketNumber" | "WagerNumber">,
): TicketKey {
  return getF402TicketGroupKey(row) as TicketKey;
}

export const TEAM_LOGO_CDN = "https://cdn.fastassets.io/images/team-logos/";

/** Keys that must never survive derivation into an artifact or an API response. */
export const PII_KEYS = ["Password", "NameFirst", "Login"] as const;

export interface LiveBetTeam {
  /** `Team1ID` / `Team2ID`, trimmed. */
  readonly name: string;
  /** `ShortName1` / `ShortName2`, trimmed, falling back to `name`. */
  readonly shortName: string;
  /** `Team1FinalScore` / `Team2FinalScore`; 0 while the game is pending. */
  readonly score: number;
  /** CDN file name from `LogoTeam1` / `LogoTeam2`, e.g. `"Arsenal FC.png"`. */
  readonly logo: string | null;
  /** Absolute CDN URL for `logo`, or null when the feed sent no logo name. */
  readonly logoUrl: string | null;
  /** `Team1RotNum` / `Team2RotNum`. */
  readonly rotationNumber: number | null;
}

/** The agent behind a wager, resolved against the portal hierarchy when it is available. */
export interface AgentRef {
  /** Canonical key (`agentLoginKey`: trimmed, upper-cased) — the hierarchy lookup key. */
  readonly key: AgentKey;
  /** As reported by the feed, trimmed. Empty when the report is customer-scoped. */
  readonly id: string;
  /** `GENERAL.Level`, or null when no hierarchy row matched. */
  readonly level: number | null;
  readonly agentType: F402AgentTypeWire | null;
}

export interface LiveBetGame {
  readonly ticketNumber: string;
  readonly wagerNumber: string;
  /** `TicketNumber-WagerNumber`, the composite key the portal itself uses. */
  readonly ticketKey: TicketKey;
  readonly agent: AgentRef;
  readonly customerID: CustomerKey;
  readonly status: string;
  readonly sport: string;
  readonly subSport: string;
  readonly period: string;
  readonly wagerType: string;
  /** `totalPicks` — legs in the ticket (parlays/teasers exceed 1). */
  readonly picks: number;
  readonly description: string;
  /** The side the customer actually took, when the feed reports it. */
  readonly chosenTeam: string | null;
  /** Integer cents. */
  readonly wagered: number;
  /** Integer cents. */
  readonly toWin: number;
  readonly gameDateTime: string | null;
  readonly acceptedAt: string | null;
  readonly team1: LiveBetTeam;
  readonly team2: LiveBetTeam;
}

/** One hierarchy row, reduced to the fields the scoreboard uses. */
export interface HierarchyAgent {
  readonly key: AgentKey;
  readonly id: string;
  readonly level: number | null;
  readonly agentType: F402AgentTypeWire | null;
  readonly seqNumber: number | null;
}

export type HierarchyIndex = ReadonlyMap<AgentKey, HierarchyAgent>;

export interface AggregateBucket {
  games: number;
  wagered: number;
  toWin: number;
}

export interface LiveBetsSummary {
  totalGames: number;
  totalWagered: number;
  totalToWin: number;
  totalPending: number;
  bySubSport: Record<string, AggregateBucket>;
  byAgent: Record<string, AggregateBucket>;
  /** Where the numbers came from; a fixture must never be mistaken for a capture. */
  dataSource: string;
  capturedAt: string | null;
}

export interface LiveBetsArtifact {
  readonly schemaVersion: 1;
  readonly dataSource: string;
  readonly capturedAt: string | null;
  readonly operation: string;
  readonly pendingCount: number;
  /** Agent rollup, resolved against the hierarchy when the capture included one. */
  readonly agents: AgentScope;
  readonly games: readonly LiveBetGame[];
}

/** Raw row plus the lowercase field spellings the live `Report/Pending` feed actually uses. */
export type PendingRow = F402CustomerReportPendingRow & {
  readonly agentID?: string | undefined;
  readonly customerID?: string | undefined;
  readonly AgentID?: string | undefined;
  readonly CustomerID?: string | undefined;
  readonly PeriodDescription?: string | undefined;
  readonly ShortName1?: string | undefined;
  readonly ShortName2?: string | undefined;
  readonly Team1FinalScore?: number | string | undefined;
  readonly Team2FinalScore?: number | string | undefined;
  readonly LogoTeam1?: string | null | undefined;
  readonly LogoTeam2?: string | null | undefined;
  readonly Outcome?: string | undefined;
  readonly AcceptedDateTime?: string | undefined;
  readonly FinalMoney?: number | string | undefined;
  readonly Price?: number | string | undefined;
};

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function cents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function logoName(value: unknown): string | null {
  const name = text(value);
  return name === "" ? null : name;
}

export function logoUrlFor(name: string | null): string | null {
  return name === null ? null : TEAM_LOGO_CDN + encodeURIComponent(name);
}

/**
 * Removes credential-bearing fields from a raw row. Unknown fields are preserved so a
 * caller can still inspect the payload, but these three can never be read back out.
 */
export function stripPII(
  row: PendingRow,
): Omit<PendingRow, (typeof PII_KEYS)[number]> {
  const copy: Record<string, unknown> = { ...row };
  for (const key of PII_KEYS) delete copy[key];
  return copy as Omit<PendingRow, (typeof PII_KEYS)[number]>;
}

function team(
  name: unknown,
  shortName: unknown,
  score: unknown,
  logo: unknown,
  rotationNumber: unknown,
): LiveBetTeam {
  const resolvedName = text(name);
  const resolvedShort = text(shortName);
  const resolvedLogo = logoName(logo);
  return {
    name: resolvedName,
    shortName: resolvedShort === "" ? resolvedName : resolvedShort,
    score: intOrNull(score) ?? 0,
    logo: resolvedLogo,
    logoUrl: logoUrlFor(resolvedLogo),
    rotationNumber: intOrNull(rotationNumber),
  };
}

/** Maps one real `Report/Pending` row onto the scoreboard shape. */
export function toLiveBetGame(
  row: PendingRow,
  hierarchy?: HierarchyIndex,
): LiveBetGame {
  return {
    ticketNumber: text(row.TicketNumber),
    wagerNumber: text(row.WagerNumber),
    ticketKey: ticketKeyOf(row),
    agent: resolveAgent(row, hierarchy),
    customerID: customerKeyOf(row.customerID ?? row.CustomerID),
    status: text(row.WagerStatus ?? row.Outcome),
    sport: text(row.SportType),
    subSport: text(row.SportSubType),
    period: text(row.PeriodDescription),
    wagerType: text(row.WagerType),
    picks: intOrNull(row.totalPicks) ?? 1,
    description: text(row.Description),
    chosenTeam: text(row.ChosenTeamID) === "" ? null : text(row.ChosenTeamID),
    wagered: cents(row.AmountWagered),
    toWin: cents(row.ToWinAmount),
    gameDateTime: text(row.GameDateTime) === "" ? null : text(row.GameDateTime),
    acceptedAt:
      text(row.AcceptedDateTime) === "" ? null : text(row.AcceptedDateTime),
    team1: team(
      row.Team1ID,
      row.ShortName1,
      row.Team1FinalScore,
      row.LogoTeam1,
      row.Team1RotNum,
    ),
    team2: team(
      row.Team2ID,
      row.ShortName2,
      row.Team2FinalScore,
      row.LogoTeam2,
      row.Team2RotNum,
    ),
  };
}

/** Resolves one report row's agent against the hierarchy index (null level when unmatched). */
export function resolveAgent(
  row: Pick<
    PendingRow,
    "agentID" | "AgentID" | "customerID" | "CustomerID" | "Login"
  >,
  hierarchy?: HierarchyIndex,
): AgentRef {
  const id = text(row.agentID ?? row.AgentID);
  const key =
    id === ""
      ? // Customer-scoped reports omit the agent; the customer's login is not the agent,
        // so leave the key empty rather than inventing one.
        asAgentKey("")
      : agentKeyOf({ AgentID: id });
  const found = key === "" ? undefined : hierarchy?.get(key);
  return {
    key,
    id,
    level: found?.level ?? null,
    agentType: found?.agentType ?? null,
  };
}

export interface HierarchyBuild {
  readonly index: HierarchyIndex;
  /** Login keys that map to more than one `AgentID`; those keys are never indexed. */
  readonly collisions: readonly AgentLoginCollision[];
}

/**
 * Builds the lookup used to attach `Level`/`AgentType` to wagers.
 *
 * `detectAgentLoginCollisions` defines what a collision is for this repository, and the index
 * never guesses between the rows: `onCollision: "throw"` (default) refuses to build,
 * `"skip"` omits the ambiguous keys and reports them so a caller can surface the gap.
 */
export function buildHierarchyIndex(
  rows: readonly ListAgentsByAgentGeneralWireRow[],
  options?: { readonly onCollision?: "throw" | "skip" },
): HierarchyBuild {
  const collisions = detectAgentLoginCollisions(rows);
  const onCollision = options?.onCollision ?? "throw";
  if (collisions.length > 0 && onCollision === "throw") {
    throw new Error(
      `agent hierarchy has login collisions: ${JSON.stringify(collisions)}`,
    );
  }

  const ambiguous = new Set(collisions.map((c) => c.key));
  const index = new Map<AgentKey, HierarchyAgent>();

  for (const row of rows) {
    const id = trimPaddedField(row.AgentID) || trimPaddedField(row.Login);
    const key = agentKeyOf(row);
    if (key === "" || ambiguous.has(key)) continue;

    const level =
      typeof row.Level === "number" && Number.isFinite(row.Level)
        ? row.Level
        : null;
    const seqNumber =
      typeof row.SeqNumber === "number" && Number.isFinite(row.SeqNumber)
        ? row.SeqNumber
        : null;

    index.set(key, {
      key,
      id,
      level,
      agentType: row.AgentType ?? null,
      seqNumber,
    });
  }
  return { index, collisions };
}

/** Accepts `{GENERAL: [...]}` (the wire envelope) or a bare row array. */
export function readHierarchyRows(
  payload: unknown,
): ListAgentsByAgentGeneralWireRow[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (row): row is ListAgentsByAgentGeneralWireRow =>
        typeof row === "object" && row !== null,
    );
  }
  if (typeof payload === "object" && payload !== null) {
    const general = (payload as { GENERAL?: unknown }).GENERAL;
    if (Array.isArray(general)) {
      return general.filter(
        (row): row is ListAgentsByAgentGeneralWireRow =>
          typeof row === "object" && row !== null,
      );
    }
  }
  return [];
}

/**
 * Reads the committed `data/agent-index.json` (identity + level for every `GENERAL` row).
 * Ambiguous keys carry `i: string[]` and `l: null`, so they are never attributed a level.
 */
export function hierarchyIndexFromAgentIndex(payload: unknown): HierarchyIndex {
  const index = new Map<AgentKey, HierarchyAgent>();
  if (typeof payload !== "object" || payload === null) return index;

  const agents = (payload as { agents?: unknown }).agents;
  if (typeof agents !== "object" || agents === null) return index;

  for (const [rawKey, wire] of Object.entries(
    agents as Record<
      string,
      {
        i?: string | string[];
        l?: number | null;
        t?: string | null;
        s?: number | null;
      }
    >,
  )) {
    const key = agentKeyOf({ AgentID: rawKey });
    if (key === "") continue;
    if (Array.isArray(wire.i)) continue; // ambiguous by construction
    const level = wire.l;
    index.set(key, {
      key,
      id: (wire.i ?? rawKey).trim(),
      level: typeof level === "number" && Number.isFinite(level) ? level : null,
      agentType: (wire.t as F402AgentTypeWire | null) ?? null,
      seqNumber:
        typeof wire.s === "number" && Number.isFinite(wire.s) ? wire.s : null,
    });
  }
  return index;
}

/**
 * Builds the same index from the committed `data/agent-tree.json` (structure + level), so
 * level resolution needs no access to the gitignored capture the tree came from.
 */
export function hierarchyIndexFromTree(tree: {
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly l?: number | null;
        readonly t?: string | null;
        readonly a?: boolean;
      }
    >
  >;
}): HierarchyIndex {
  const index = new Map<AgentKey, HierarchyAgent>();
  for (const [rawKey, wire] of Object.entries(tree.nodes)) {
    const key = agentKeyOf({ AgentID: rawKey });
    // An ambiguous key belongs to several agents; attributing a level would be a guess.
    if (key === "" || wire.a === true) continue;
    index.set(key, {
      key,
      id: rawKey.trim(),
      level:
        typeof wire.l === "number" && Number.isFinite(wire.l) ? wire.l : null,
      agentType: (wire.t as F402AgentTypeWire | null) ?? null,
      seqNumber: null,
    });
  }
  return index;
}

function isRow(value: unknown): value is PendingRow {
  return (
    typeof value === "object" &&
    value !== null &&
    ("TicketNumber" in value || "ticketNumber" in value)
  );
}

/**
 * Accepts every capture shape in this repo: a bare row, an array of rows, the live
 * `{"Pending": [...]}` envelope, or a probe file wrapping the envelope in a preview.
 */
export function readPendingRows(payload: unknown): PendingRow[] {
  if (Array.isArray(payload)) return payload.filter(isRow);
  if (typeof payload !== "object" || payload === null) return [];

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.Pending)) return record.Pending.filter(isRow);
  if (isRow(record)) return [record];

  // Probe captures keep the body inside `result.preview` (truncated, prefixed).
  const result = record.result as Record<string, unknown> | undefined;
  const preview = typeof result?.preview === "string" ? result.preview : null;
  if (preview !== null) return extractRowsFromPreview(preview);

  return [];
}

/**
 * Pulls the complete JSON objects out of a truncated `"Pending":[ ... ]` preview.
 * A row cut off by the preview limit is dropped rather than half-parsed.
 */
export function extractRowsFromPreview(preview: string): PendingRow[] {
  const start = preview.indexOf('"Pending"');
  const arrayStart = preview.indexOf("[", start >= 0 ? start : 0);
  if (arrayStart < 0) return [];

  const rows: PendingRow[] = [];
  let i = arrayStart + 1;
  while (i < preview.length) {
    while (i < preview.length && /[\s,]/.test(preview[i] as string)) i++;
    if (preview[i] !== "{") break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = i;
    for (; end < preview.length; end++) {
      const ch = preview[end] as string;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }

    try {
      const parsed: unknown = JSON.parse(preview.slice(i, end));
      if (isRow(parsed)) rows.push(parsed);
    } catch {
      break; // Truncated by the preview limit: stop, do not invent the tail.
    }
    i = end;
  }
  return rows;
}

function emptyBucket(): AggregateBucket {
  return { games: 0, wagered: 0, toWin: 0 };
}

export type LiveArtifactSourceKind = "live" | "capture";

export interface BuildArtifactOptions {
  readonly operation: string;
  readonly capturedAt: string | null;
  /** Hierarchy rows to resolve `Level`/`AgentType`; omit when none were captured. */
  readonly hierarchy?: readonly ListAgentsByAgentGeneralWireRow[];
  /** Prebuilt index (e.g. from the committed agent tree); wins over `hierarchy`. */
  readonly hierarchyIndex?: HierarchyIndex;
  /**
   * Provenance prefix on `dataSource`: `capture:` (default) or `live:` for a desk live read.
   * The derived games and totals are identical; only the label changes.
   */
  readonly sourceKind?: LiveArtifactSourceKind;
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dedupeLastByCompositeKey(rows: readonly PendingRow[]): PendingRow[] {
  const n = rows.length;
  if (n === 0) return [];
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    const rowA = rows[a]!;
    const rowB = rows[b]!;
    const cmpT = compareAscii(text(rowA.TicketNumber), text(rowB.TicketNumber));
    if (cmpT !== 0) return cmpT;
    const cmpW = compareAscii(text(rowA.WagerNumber), text(rowB.WagerNumber));
    if (cmpW !== 0) return cmpW;
    return a - b;
  });
  const hasSameCompositeNext = (k: number): boolean => {
    if (k + 1 >= n) return false;
    const curRow = rows[order[k]!]!;
    const nextRow = rows[order[k + 1]!]!;
    return (
      text(curRow.TicketNumber) === text(nextRow.TicketNumber) &&
      text(curRow.WagerNumber) === text(nextRow.WagerNumber)
    );
  };
  let keepCount = 0;
  for (let k = 0; k < n; k++) {
    if (!hasSameCompositeNext(k)) keepCount++;
  }
  const deduped = Array<PendingRow>(keepCount);
  let writeIdx = 0;
  for (let k = 0; k < n; k++) {
    if (!hasSameCompositeNext(k)) {
      deduped[writeIdx++] = rows[order[k]!]!;
    }
  }
  return deduped;
}

/**
 * Builds the committed artifact from captured rows. Dedupes by `TicketNumber-WagerNumber`
 * (the portal's own composite key) via zero-Map sorted-run scan and refuses to emit a row
 * that still carries PII.
 */
export function buildArtifact(
  rows: readonly PendingRow[],
  options: BuildArtifactOptions,
): LiveBetsArtifact {
  const dedupedRows = dedupeLastByCompositeKey(rows);
  const cleaned = dedupedRows.map(stripPII);
  let piiMask = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const record = cleaned[i] as Record<string, unknown>;
    for (let j = 0; j < PII_KEYS.length; j++) {
      if (PII_KEYS[j]! in record) {
        piiMask |= 1 << j;
      }
    }
  }
  if (piiMask !== 0) {
    const leftover: string[] = [];
    for (let j = 0; j < PII_KEYS.length; j++) {
      if ((piiMask & (1 << j)) !== 0) leftover.push(PII_KEYS[j]!);
    }
    throw new Error(
      `refusing to build artifact: PII keys survived stripping: ${leftover.join(", ")}`,
    );
  }

  const capturedAt = options.capturedAt;
  const prefix = options.sourceKind === "live" ? "live" : "capture";
  const dataSource = `${prefix}:${options.operation}${
    capturedAt === null ? "" : `@${capturedAt}`
  }`;

  const built =
    options.hierarchy === undefined
      ? undefined
      : buildHierarchyIndex(options.hierarchy, { onCollision: "skip" });

  const hierarchyIndex = options.hierarchyIndex ?? built?.index;

  // Stable, chronological order so the artifact is byte-identical across rebuilds and the
  // scoreboard lists the earliest game first. Ticket key breaks ties deterministically.
  const games = cleaned
    .map((row) => toLiveBetGame(row, hierarchyIndex))
    .sort((a, b) => {
      const aStart = a.gameDateTime ?? a.acceptedAt ?? "";
      const bStart = b.gameDateTime ?? b.acceptedAt ?? "";
      if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      return a.ticketKey < b.ticketKey ? -1 : a.ticketKey > b.ticketKey ? 1 : 0;
    });

  return {
    schemaVersion: 1,
    dataSource,
    capturedAt,
    operation: options.operation,
    pendingCount: cleaned.length,
    agents: summarizeAgents(
      games,
      options.hierarchy,
      built?.collisions ?? [],
      hierarchyIndex === undefined
        ? undefined
        : maxLevelInIndex(hierarchyIndex),
    ),
    games,
  };
}

/** Same as {@link buildArtifact} with `sourceKind: "live"` for live Pending reads. */
export function livePendingArtifact(
  rows: readonly PendingRow[],
  options: Omit<BuildArtifactOptions, "sourceKind">,
): LiveBetsArtifact {
  return buildArtifact(rows, { ...options, sourceKind: "live" });
}

/** Deepest level carried by an index, ignoring ambiguous agents (which have none). */
export function maxLevelInIndex(index: HierarchyIndex): number | null {
  let max: number | null = null;
  for (const agent of index.values()) {
    if (agent.level === null) continue;
    max = max === null ? agent.level : Math.max(max, agent.level);
  }
  return max;
}

/** Per-agent rollup, resolved against the hierarchy when rows were supplied. */
export interface AgentScopeEntry {
  readonly key: AgentKey;
  readonly id: string;
  readonly level: number | null;
  readonly agentType: F402AgentTypeWire | null;
  readonly games: number;
  readonly wagered: number;
  readonly toWin: number;
}

export interface AgentScope {
  readonly agents: AgentScopeEntry[];
  /** Keys that reported an id but matched no hierarchy row (or matched an ambiguous one). */
  readonly unresolved: AgentKey[];
  /** Wagers whose report omitted the agent entirely (customer-scoped reports). */
  readonly unassignedGames: number;
  /** Deepest level in the supplied hierarchy, or null when no hierarchy was supplied. */
  readonly maxLevel: number | null;
  readonly hierarchyLoaded: boolean;
  /** Login keys that several `AgentID`s share; wagers on them cannot be levelled. */
  readonly collisions: readonly AgentLoginCollision[];
}

/**
 * Rolls wagers up by canonical agent key.
 *
 * `maxLevel` comes from `maxGeneralLevel` rather than from the matched games, so it describes
 * the hierarchy that was actually loaded instead of claiming depth from a partial sample.
 */
export function summarizeAgents(
  games: readonly LiveBetGame[],
  hierarchy?: readonly ListAgentsByAgentGeneralWireRow[],
  collisions: readonly AgentLoginCollision[] = [],
  /** Depth of a prebuilt index (agent tree); used when no raw hierarchy rows are supplied. */
  maxLevelOverride?: number | null,
): AgentScope {
  const byKey = new Map<AgentKey, AgentScopeEntry>();
  let unassignedGames = 0;

  for (const game of games) {
    const { key, id, level, agentType } = game.agent;
    if (key === "") {
      unassignedGames += 1;
      continue;
    }
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        id,
        level,
        agentType,
        games: 1,
        wagered: game.wagered,
        toWin: game.toWin,
      });
    } else {
      byKey.set(key, {
        ...existing,
        games: existing.games + 1,
        wagered: existing.wagered + game.wagered,
        toWin: existing.toWin + game.toWin,
      });
    }
  }

  const agents = [...byKey.values()].sort((a, b) => b.wagered - a.wagered);
  const hierarchyLoaded =
    hierarchy !== undefined || maxLevelOverride !== undefined;
  const unresolved = hierarchyLoaded
    ? agents.filter((agent) => agent.level === null).map((agent) => agent.key)
    : [];

  return {
    agents,
    unresolved,
    unassignedGames,
    maxLevel:
      hierarchy !== undefined
        ? maxGeneralLevel(hierarchy)
        : (maxLevelOverride ?? null),
    hierarchyLoaded,
    collisions,
  };
}

/** Agents deeper than `level` in the supplied hierarchy; exposed for scope queries. */
export function agentsAboveLevel(
  hierarchy: readonly ListAgentsByAgentGeneralWireRow[],
  level: number,
): ListAgentsByAgentGeneralWireRow[] {
  return generalRowsAboveLevel(hierarchy, level);
}

/**
 * Aggregates are derived, never hand-maintained: a stale literal is a lie in an API response.
 * `dataSource` travels with the numbers so a consumer can tell a fixture from a capture.
 */
export function summarizeGames(
  games: readonly LiveBetGame[],
  pendingCount: number,
  dataSource: string,
  capturedAt: string | null,
): LiveBetsSummary {
  const totals = emptyBucket();
  const bySubSport: Record<string, AggregateBucket> = {};
  const byAgent: Record<string, AggregateBucket> = {};

  for (const g of games) {
    totals.games += 1;
    totals.wagered += g.wagered;
    totals.toWin += g.toWin;

    const sportKey = g.subSport || "unknown";
    const sportBucket = (bySubSport[sportKey] ??= emptyBucket());
    sportBucket.games += 1;
    sportBucket.wagered += g.wagered;
    sportBucket.toWin += g.toWin;

    const rawAgentKey = g.agent?.key ?? "";
    const agentKey = rawAgentKey === "" ? "unassigned" : rawAgentKey;
    const agentBucket = (byAgent[agentKey] ??= emptyBucket());
    agentBucket.games += 1;
    agentBucket.wagered += g.wagered;
    agentBucket.toWin += g.toWin;
  }

  return {
    totalGames: totals.games,
    totalWagered: totals.wagered,
    totalToWin: totals.toWin,
    totalPending: pendingCount,
    bySubSport,
    byAgent,
    dataSource,
    capturedAt,
  };
}

const MAX_SAFE_CENTS_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_CENTS_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const INTEGER_STR_RE = /^[+-]?\d+$/;

function coerceIntegerCentsBigInt(
  raw: unknown,
): { readonly ok: true; readonly value: bigint } | { readonly ok: false } {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) return { ok: false };
    return { ok: true, value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!INTEGER_STR_RE.test(trimmed)) return { ok: false };
    const value = BigInt(trimmed);
    if (value < MIN_SAFE_CENTS_BIGINT || value > MAX_SAFE_CENTS_BIGINT) {
      return { ok: false };
    }
    return { ok: true, value };
  }
  return { ok: false };
}

function parseAmericanOddsStrictBigInt(
  raw: unknown,
): { readonly ok: true; readonly odds: AmericanOdds } | { readonly ok: false } {
  let nBig: bigint;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) return { ok: false };
    nBig = BigInt(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!INTEGER_STR_RE.test(trimmed)) return { ok: false };
    nBig = BigInt(trimmed);
  } else {
    return { ok: false };
  }
  if (nBig > -100n && nBig < 100n) return { ok: false };
  if (nBig < MIN_SAFE_CENTS_BIGINT || nBig > MAX_SAFE_CENTS_BIGINT) {
    return { ok: false };
  }
  return { ok: true, odds: Number(nBig) as AmericanOdds };
}

function deriveAmericanOddsBigInt(
  stakeCents: bigint,
  toWinCents: bigint,
): { readonly ok: boolean; readonly odds: AmericanOdds } {
  if (stakeCents <= 0n || toWinCents <= 0n) {
    return { ok: false, odds: INVALID_AMERICAN_ODDS };
  }
  let oddsBig: bigint;
  if (toWinCents >= stakeCents) {
    oddsBig = (toWinCents * 100n + stakeCents / 2n) / stakeCents;
    if (oddsBig < 100n) oddsBig = 100n;
  } else {
    oddsBig = -((stakeCents * 100n + toWinCents / 2n) / toWinCents);
    if (oddsBig > -100n) oddsBig = -100n;
  }
  if (oddsBig < MIN_SAFE_CENTS_BIGINT || oddsBig > MAX_SAFE_CENTS_BIGINT) {
    return { ok: false, odds: INVALID_AMERICAN_ODDS };
  }
  return { ok: true, odds: Number(oddsBig) as AmericanOdds };
}

function normalizeDeskWagerStatus(raw: unknown): string {
  const s = text(raw).toUpperCase();
  if (s === "" || s === "P" || s === "PENDING") return "pending";
  if (s === "W" || s === "WON") return "won";
  if (s === "L" || s === "LOST") return "lost";
  if (s === "X" || s === "V" || s === "C" || s === "SETTLED") return "settled";
  return s.toLowerCase();
}

export interface DeduplicatedParentTicket {
  readonly ticketKey: TicketKey;
  readonly ticketNumber: string;
  readonly wagerNumber: string;
  readonly customerKey: CustomerKey;
  readonly totalPicks: number;
  readonly observedLegs: number;
  /** Legs the ticket declares but the capture did not carry; never assumed resolved. */
  readonly missingPicks: number;
  readonly status: string;
  readonly wagerType: string;
  readonly stakeCents: Cents;
  readonly toWinCents: Cents;
  readonly settledCents: SettledCents;
  readonly priceOdds: AmericanOdds;
  readonly unresolvedGapCents: bigint;
  readonly hasCoercionError: boolean;
  readonly legs: readonly DeskPositionLeg[];
}

/**
 * Zero-Map / zero-Set sorted-run parlay deduplicator keyed by
 * `(TicketNumber, WagerNumber, totalPicks)`. Checks `unresolvedGapCents === 0n`
 * across all leg rows in each contiguous run and preserves structured `DeskPositionLeg`
 * rotation + `LineHundredths` effective-line math. A run carrying fewer leg rows than
 * `totalPicks` reports `missingPicks > 0` and is flagged, so a partial capture degrades
 * the desk-risk evaluation instead of reading as a complete ticket.
 */
export function dedupeParentPendingTickets(
  rows: readonly PendingRow[],
): DeduplicatedParentTicket[] {
  const n = rows.length;
  if (n === 0) return [];

  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  order.sort((a, b) => {
    const rowA = rows[a]!;
    const rowB = rows[b]!;
    const cmpTicket = compareAscii(
      text(rowA.TicketNumber),
      text(rowB.TicketNumber),
    );
    if (cmpTicket !== 0) return cmpTicket;
    const cmpWager = compareAscii(
      text(rowA.WagerNumber),
      text(rowB.WagerNumber),
    );
    if (cmpWager !== 0) return cmpWager;
    const picksA = intOrNull(rowA.totalPicks) ?? 1;
    const picksB = intOrNull(rowB.totalPicks) ?? 1;
    if (picksA !== picksB) return picksA - picksB;
    return a - b;
  });

  const sameParentGroup = (
    row: PendingRow,
    ticketNumber: string,
    wagerNumber: string,
    totalPicks: number,
  ): boolean =>
    text(row.TicketNumber) === ticketNumber &&
    text(row.WagerNumber) === wagerNumber &&
    Math.max(1, intOrNull(row.totalPicks) ?? 1) === totalPicks;

  let groupCount = 0;
  for (let scanStart = 0; scanStart < n;) {
    const firstRow = rows[order[scanStart]!]!;
    const ticketNumber = text(firstRow.TicketNumber);
    const wagerNumber = text(firstRow.WagerNumber);
    const totalPicks = Math.max(1, intOrNull(firstRow.totalPicks) ?? 1);
    let scanEnd = scanStart + 1;
    while (
      scanEnd < n &&
      sameParentGroup(
        rows[order[scanEnd]!]!,
        ticketNumber,
        wagerNumber,
        totalPicks,
      )
    ) {
      scanEnd++;
    }
    groupCount++;
    scanStart = scanEnd;
  }

  const result = Array<DeduplicatedParentTicket>(groupCount);
  let groupIdx = 0;
  let runStart = 0;
  while (runStart < n) {
    const firstRow = rows[order[runStart]!]!;
    const ticketNumber = text(firstRow.TicketNumber);
    const wagerNumber = text(firstRow.WagerNumber);
    const totalPicks = Math.max(1, intOrNull(firstRow.totalPicks) ?? 1);

    let runEnd = runStart + 1;
    while (
      runEnd < n &&
      sameParentGroup(
        rows[order[runEnd]!]!,
        ticketNumber,
        wagerNumber,
        totalPicks,
      )
    ) {
      runEnd++;
    }

    const observedLegs = runEnd - runStart;
    const legs = Array<DeskPositionLeg>(observedLegs);
    let minStakeBig = 0n;
    let maxStakeBig = 0n;
    let stakeInitialized = false;
    let stakeCoercionError = false;
    let toWinBig = 0n;
    let toWinCoercionError = false;
    let oddsCoercionError = false;
    let legLineCoercionError = false;
    let priceOdds: AmericanOdds = INVALID_AMERICAN_ODDS;
    let priceResolved = false;

    for (let k = runStart; k < runEnd; k++) {
      const row = rows[order[k]!]!;
      const stakeRes = coerceIntegerCentsBigInt(row.AmountWagered);
      if (!stakeRes.ok) {
        stakeCoercionError = true;
      } else {
        if (!stakeInitialized) {
          minStakeBig = stakeRes.value;
          maxStakeBig = stakeRes.value;
          stakeInitialized = true;
        } else {
          if (stakeRes.value < minStakeBig) minStakeBig = stakeRes.value;
          if (stakeRes.value > maxStakeBig) maxStakeBig = stakeRes.value;
        }
      }

      if (k === runStart) {
        const toWinRes = coerceIntegerCentsBigInt(row.ToWinAmount);
        if (!toWinRes.ok) {
          toWinCoercionError = true;
        } else {
          toWinBig = toWinRes.value;
        }

        const explicitOddsRaw = row.FinalMoney ?? row.Price;
        if (explicitOddsRaw !== undefined && explicitOddsRaw !== "") {
          const parsedOdds = parseAmericanOddsStrictBigInt(explicitOddsRaw);
          if (parsedOdds.ok) {
            priceOdds = parsedOdds.odds;
            priceResolved = true;
          } else {
            oddsCoercionError = true;
          }
        }
      }

      const rot = extractF402RotationNumber(row);
      let effSide = "UNKNOWN";
      let effLine: LineHundredths | null = null;
      try {
        const eff = computeF402EffectiveLine(row);
        effSide = eff.side;
        effLine = eff.effectiveLineHundredths;
      } catch {
        // signal-honesty: intentional-line-coercion-flag
        legLineCoercionError = true;
      }

      const team1 = text(row.Team1ID);
      const team2 = text(row.Team2ID);
      const market =
        team1 !== "" && team2 !== ""
          ? `${team1} vs ${team2}`
          : text(row.Description) || text(row.SportSubType) || "UNKNOWN";
      const chosen = text(row.ChosenTeamID);
      const side = chosen !== "" ? `${chosen} ${effSide}`.trim() : effSide;

      legs[k - runStart] = {
        legIndex: k - runStart,
        market,
        side,
        rawRotNum: rot.rawRotNum,
        canonicalRotNum: rot.canonicalRotNum,
        isAltSpreadRotation: rot.isAltSpreadRotation,
        effectiveLineHundredths: effLine,
      };
    }

    const unresolvedGapCents = stakeInitialized
      ? maxStakeBig - minStakeBig
      : 0n;
    const representativeStake = stakeInitialized ? minStakeBig : 0n;
    const missingPicks = Math.max(0, totalPicks - observedLegs);

    if (!priceResolved && !oddsCoercionError) {
      if (!stakeCoercionError && !toWinCoercionError && stakeInitialized) {
        const derived = deriveAmericanOddsBigInt(representativeStake, toWinBig);
        priceOdds = derived.odds;
        if (!derived.ok) oddsCoercionError = true;
      } else {
        oddsCoercionError = true;
      }
    }

    const stakeCents: Cents =
      !stakeCoercionError &&
      stakeInitialized &&
      representativeStake >= MIN_SAFE_CENTS_BIGINT &&
      representativeStake <= MAX_SAFE_CENTS_BIGINT
        ? (Number(representativeStake) as Cents)
        : ZERO_CENTS;
    const toWinCents: Cents =
      !toWinCoercionError &&
      toWinBig >= MIN_SAFE_CENTS_BIGINT &&
      toWinBig <= MAX_SAFE_CENTS_BIGINT
        ? (Number(toWinBig) as Cents)
        : ZERO_CENTS;

    const status = normalizeDeskWagerStatus(
      firstRow.WagerStatus ?? firstRow.Outcome,
    );
    const settledCents =
      status === "won"
        ? asSettledCents(toWinCents)
        : status === "lost"
          ? asSettledCents(-stakeCents)
          : asSettledCents(0);

    const hasCoercionError =
      stakeCoercionError ||
      toWinCoercionError ||
      oddsCoercionError ||
      legLineCoercionError ||
      unresolvedGapCents !== 0n ||
      missingPicks > 0 ||
      observedLegs > totalPicks;

    result[groupIdx++] = {
      ticketKey: ticketKeyOf(firstRow),
      ticketNumber,
      wagerNumber,
      customerKey: customerKeyOf(firstRow.customerID ?? firstRow.CustomerID),
      totalPicks,
      observedLegs,
      missingPicks,
      status,
      wagerType: text(firstRow.WagerType),
      stakeCents,
      toWinCents,
      settledCents,
      priceOdds,
      unresolvedGapCents,
      hasCoercionError,
      legs,
    };

    runStart = runEnd;
  }

  return result;
}

export interface BridgePendingToDeskOptions {
  readonly customerId?: string | undefined;
  readonly customerName?: string | undefined;
  readonly tier?: string | undefined;
  readonly maxStakeCents: Cents;
  readonly currency?: string | undefined;
  readonly hasValidMaxStake?: boolean | undefined;
}

/**
 * Maps deduplicated parent pending tickets onto `CustomerDesk` so `evaluateDeskRisk`
 * evaluates parent ticket stake exposure once per `(TicketNumber, WagerNumber, totalPicks)`
 * and retains structured leg metadata instead of flattening into an unkeyed `side` string.
 */
export function bridgePendingRowsToDesk(
  rows: readonly PendingRow[],
  options: BridgePendingToDeskOptions,
): {
  readonly desk: CustomerDesk;
  readonly parentTickets: readonly DeduplicatedParentTicket[];
  readonly unresolvedGapCentsTotal: bigint;
} {
  const parentTickets = dedupeParentPendingTickets(rows);
  let unresolvedGapCentsTotal = 0n;
  const hasValidMaxStake =
    options.hasValidMaxStake ??
    (Number.isSafeInteger(options.maxStakeCents) && options.maxStakeCents >= 0);

  const positions: DeskPosition[] = parentTickets.map((ticket) => {
    unresolvedGapCentsTotal += ticket.unresolvedGapCents;
    const isSingle = ticket.totalPicks <= 1 && ticket.legs.length === 1;
    const singleLeg = isSingle ? ticket.legs[0]! : null;
    let exposureBps = parseAsBasisPoints(0, true);
    if (hasValidMaxStake && options.maxStakeCents > 0) {
      const stakeBig = BigInt(ticket.stakeCents);
      const maxBig = BigInt(options.maxStakeCents);
      const bpsBig =
        stakeBig >= 0n
          ? (stakeBig * 10_000n + maxBig / 2n) / maxBig
          : -((-stakeBig * 10_000n + maxBig / 2n) / maxBig);
      const safeBps =
        bpsBig > MAX_SAFE_CENTS_BIGINT
          ? Number.MAX_SAFE_INTEGER
          : bpsBig < MIN_SAFE_CENTS_BIGINT
            ? Number.MIN_SAFE_INTEGER
            : Number(bpsBig);
      exposureBps = parseAsBasisPoints(safeBps, true);
    }

    return {
      id: ticket.ticketKey,
      market:
        singleLeg !== null
          ? singleLeg.market
          : `COMPOSITE:${ticket.totalPicks}-LEG`,
      side:
        singleLeg !== null ? singleLeg.side : `PARLAY(${ticket.totalPicks})`,
      stake: ticket.stakeCents,
      price: ticket.priceOdds,
      status: ticket.status,
      day: null,
      hasCoercionError: ticket.hasCoercionError,
      totalPicks: ticket.totalPicks,
      legs: ticket.legs,
      effectiveLineHundredths:
        singleLeg !== null ? singleLeg.effectiveLineHundredths : null,
      exposureBps,
      settledCents: ticket.settledCents,
    };
  });

  const inferredCustomerId =
    options.customerId ?? (parentTickets[0]?.customerKey || "DESK");

  const desk: CustomerDesk = {
    customer: {
      id: inferredCustomerId,
      name: options.customerName ?? "",
      tier: options.tier ?? "standard",
    },
    limits: {
      max_stake: options.maxStakeCents,
      currency: options.currency ?? "USD",
      hasValidMaxStake,
    },
    positions,
    diagnostics: [],
  };

  return { desk, parentTickets, unresolvedGapCentsTotal };
}

/**
 * End-to-end risk bridge: deduplicates parent tickets, runs `evaluateDeskRisk`,
 * records provenance + `pendingAtMax` / `degradedPending` telemetry in `desk-parser.ts`
 * and `audit_log.ts`, and returns the complete result.
 */
export function evaluatePendingExposureRisk(
  rows: readonly PendingRow[],
  options: BridgePendingToDeskOptions,
  provenance: DeskRiskProvenance = {
    sourceKind: "none",
    dataWindowMaxEpochMs: null,
    r2PublishedAtEpochMs: null,
  },
): {
  readonly desk: CustomerDesk;
  readonly parentTickets: readonly DeduplicatedParentTicket[];
  readonly evaluation: RiskEvaluation;
  readonly telemetry: DeskRiskTelemetrySnapshot;
  readonly unresolvedGapCentsTotal: bigint;
} {
  const bridged = bridgePendingRowsToDesk(rows, options);
  const { evaluation, telemetry } = recordDeskRiskEvaluation(
    bridged.desk,
    provenance,
    bridged.unresolvedGapCentsTotal,
  );
  return {
    ...bridged,
    evaluation,
    telemetry,
  };
}

export { evaluateDeskRisk };

/**
 * Sanitizes `LiveBetGame` arrays before sending to non-loopback / untrusted peers:
 * tokenizes `customerID`, `ticketNumber`, `ticketKey` and scrubs raw IP literals.
 * Returns `games` verbatim on trusted loopback peers.
 *
 * Scope: agent keys and ids are internal hierarchy identifiers under the desk's PII policy
 * (`DESK_FORBIDDEN_KEYS` gates customerID/login/IP, not agentID), so they pass through
 * unchanged. Tokenizing them would break agent links for remote peers and is a separate
 * policy decision; this boundary is stated here so it is not mistaken for an omission.
 */
export function sanitizeLiveBetGamesForPeer<T extends LiveBetGame>(
  games: readonly T[],
  trustedPeer: boolean,
): readonly T[] {
  if (trustedPeer) return games;
  return games.map((game) => ({
    ...game,
    customerID: tokenizeCustomerId(game.customerID) as CustomerKey,
    ticketNumber: tokenizeTicketId(game.ticketNumber),
    ticketKey: tokenizeTicketId(game.ticketKey) as TicketKey,
    description: scrubDeskIpLiterals(game.description),
  }));
}
