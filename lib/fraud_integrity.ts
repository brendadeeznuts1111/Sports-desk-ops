/**
 * Bet-group integrity validation for the GSLive `getBetReport` corpus.
 *
 * Runs over EVERY raw component row, before any ticket-level dedupe, and accumulates per-group
 * facts so ownership and financial-field conflicts are detected from the rows that carry them.
 * The summary is a typed, versioned contract for the CLI and (later) the security plugin; nothing
 * here is a fraud detector or a finding.
 *
 * Invariants (status `invalid` when violated):
 *   - one betGroupId belongs to exactly one userID and at most one partnerUserID;
 *   - `betGroupId` and `userID` are present on every row;
 *   - ticket-level fields ({@link DEFAULT_GROUP_INTEGRITY_POLICY.ticketFields}) are identical on
 *     every leg of a group;
 *   - ticket-level numeric fields parse as finite numbers;
 *   - lifecycle / leg-result codes are known (else schema drift) and allowed (else policy breach).
 *
 * Observations (never violations): mixed leg states, partially graded groups, mixed leg results,
 * pending/cancelled legs, supplemental-confirmation categories. Per-leg facts may legitimately
 * differ inside one ticket — e.g. a winning leg in a losing parlay — so they are reported, never
 * counted as a conflict.
 *
 * Status precedence: `unavailable` (no rows) > `invalid` (invariant/policy breach) >
 * `incomplete` (coverage gap or unknown enum drift) > `verified`. Zero violations therefore means
 * "validation completed on every row and nothing broke", not merely "we found nothing".
 */

export const GROUP_INTEGRITY_SCHEMA_VERSION = 1 as const;
export const GROUP_INTEGRITY_DERIVATION_VERSION = "group-integrity@1";

export type GroupIntegrityStatus =
  "verified" | "unavailable" | "incomplete" | "invalid";

/** Which provider enum values the parser knows, and which the policy permits. */
export interface GroupIntegrityPolicy {
  readonly policyVersion: string;
  /** Lifecycle `state` codes the parser understands. */
  readonly knownStates: readonly number[];
  /** Subset of {@link knownStates} this policy permits; known-but-disallowed is a breach. */
  readonly allowedStates: readonly number[];
  /** Per-leg `isWin` codes the parser understands. */
  readonly knownIsWin: readonly number[];
  readonly allowedIsWin: readonly number[];
  /** Raw wire fields repeated verbatim on every leg of one ticket. */
  readonly ticketFields: readonly string[];
  readonly requireGroupId: boolean;
  readonly requireUser: boolean;
  /** Cap on evidence samples; counters stay complete regardless. */
  readonly maxSamplesPerCode: number;
}

export const DEFAULT_GROUP_INTEGRITY_POLICY: GroupIntegrityPolicy = {
  policyVersion: "group-integrity-policy@1",
  knownStates: [-1, 0, 1, 2, 3],
  allowedStates: [-1, 0, 1, 2, 3],
  knownIsWin: [-2, -1, 0, 1],
  allowedIsWin: [-2, -1, 0, 1],
  ticketFields: [
    "betGroupResult",
    "betGroupToWin",
    "bet",
    "betGroupFinalOdds",
    "betGroupPremiumAwarded",
    "exchangeRate",
  ],
  requireGroupId: true,
  requireUser: true,
  maxSamplesPerCode: 20,
};

export interface GroupIntegrityCounters {
  readonly rows: number;
  readonly groups: number;
  /** Rows beyond the first row of their group (the rows dedupe removes financially). */
  readonly duplicateGroupRows: number;
  readonly crossPlayerGroups: number;
  readonly crossPartnerGroups: number;
  readonly missingGroupIdRows: number;
  readonly missingUserRows: number;
  /** Groups with at least one differing ticket-level field. */
  readonly ticketFieldConflicts: number;
  readonly invalidFinancialValues: number;
  /** Rows that are not JSON objects at all. */
  readonly unreadableRows: number;
  readonly missingStateRows: number;
  /** Groups that appear in more than one capture (merge only). */
  readonly overlappingGroups: number;
}

export interface SupplementalCounts {
  readonly accepted: number;
  readonly rejected: number;
  readonly pending: number;
  readonly other: number;
  readonly unparseable: number;
  /** Field absent or null — most rows; not an error. */
  readonly absent: number;
}

export interface GroupIntegrityObservations {
  readonly mixedStateGroups: number;
  /** Groups that contain at least one COMPLETE leg and at least one non-COMPLETE leg. */
  readonly partiallyGradedGroups: number;
  /** Groups whose legs carry more than one `isWin` code (expected in parlays). */
  readonly mixedIsWinGroups: number;
  readonly pendingComponentRows: number;
  readonly canceledComponentRows: number;
  readonly missingPartnerRows: number;
  readonly missingIsWinRows: number;
  readonly supplemental: SupplementalCounts;
  readonly statesSeen: readonly number[];
  readonly isWinSeen: readonly number[];
  readonly unknownStates: readonly number[];
  readonly unknownIsWin: readonly number[];
  readonly disallowedStates: readonly number[];
  readonly disallowedIsWin: readonly number[];
}

export type GroupIntegritySampleDetail = Readonly<
  Record<string, string | number | readonly string[]>
>;

export interface GroupIntegritySample {
  readonly code: string;
  readonly betGroupId: string;
  readonly detail: GroupIntegritySampleDetail;
}

export interface GroupIntegritySource {
  readonly kind: string;
  readonly capturedRows: number;
  readonly capturedAt?: string | null;
  readonly sha256?: string | null;
  /** Merge only: capture ids contributing rows. */
  readonly captures?: readonly string[];
}

export interface GroupIntegritySummary {
  readonly schemaVersion: typeof GROUP_INTEGRITY_SCHEMA_VERSION;
  readonly derivationVersion: string;
  readonly policyVersion: string;
  readonly status: GroupIntegrityStatus;
  readonly counters: GroupIntegrityCounters;
  readonly observations: GroupIntegrityObservations;
  readonly violationCounts: Readonly<Record<string, number>>;
  readonly violations: readonly GroupIntegritySample[];
  readonly source: GroupIntegritySource | null;
}

export interface GroupIntegrityOptions {
  readonly policy?: GroupIntegrityPolicy;
  readonly source?: Omit<GroupIntegritySource, "capturedRows"> & {
    readonly capturedRows?: number;
  };
}

export interface GroupIntegrityCapture {
  readonly captureId: string;
  readonly rows: readonly unknown[];
  readonly capturedAt?: string | null;
  readonly sha256?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Raw-value helpers                                                           */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function intOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Stable text form of a raw ticket-level value: `null` is its own value, not a missing one. */
function fieldKey(value: unknown): string {
  if (value === null || value === undefined) return "\u0000null";
  return String(value).trim();
}

function finiteRawNumber(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number.parseFloat(value));
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Accumulator                                                                 */
/* -------------------------------------------------------------------------- */

interface GroupAccumulator {
  readonly userIds: Set<string>;
  readonly partnerIds: Set<string>;
  readonly ticketValues: Map<string, Set<string>>;
  readonly states: Set<number>;
  readonly isWins: Set<number>;
  rows: number;
  readonly captures: Set<string>;
}

interface ViolationCollector {
  readonly counts: Map<string, number>;
  readonly samples: GroupIntegritySample[];
  readonly maxSamples: number;
}

function makeCollector(maxSamples: number): ViolationCollector {
  return { counts: new Map(), samples: [], maxSamples };
}

function recordViolation(
  collector: ViolationCollector,
  code: string,
  betGroupId: string,
  detail: GroupIntegritySampleDetail,
): void {
  const next = (collector.counts.get(code) ?? 0) + 1;
  collector.counts.set(code, next);
  if (next <= collector.maxSamples) {
    collector.samples.push({ code, betGroupId, detail });
  }
}

function accumulatorFor(
  groups: Map<string, GroupAccumulator>,
  betGroupId: string,
): GroupAccumulator {
  const existing = groups.get(betGroupId);
  if (existing !== undefined) return existing;
  const created: GroupAccumulator = {
    userIds: new Set(),
    partnerIds: new Set(),
    ticketValues: new Map(),
    states: new Set(),
    isWins: new Set(),
    rows: 0,
    captures: new Set(),
  };
  groups.set(betGroupId, created);
  return created;
}

interface MutableState {
  rows: number;
  unreadableRows: number;
  missingGroupIdRows: number;
  missingUserRows: number;
  missingStateRows: number;
  missingPartnerRows: number;
  missingIsWinRows: number;
  invalidFinancialValues: number;
  pendingComponentRows: number;
  canceledComponentRows: number;
  supplemental: {
    accepted: number;
    rejected: number;
    pending: number;
    other: number;
    unparseable: number;
    absent: number;
  };
}

function emptyMutableState(): MutableState {
  return {
    rows: 0,
    unreadableRows: 0,
    missingGroupIdRows: 0,
    missingUserRows: 0,
    missingStateRows: 0,
    missingPartnerRows: 0,
    missingIsWinRows: 0,
    invalidFinancialValues: 0,
    pendingComponentRows: 0,
    canceledComponentRows: 0,
    supplemental: {
      accepted: 0,
      rejected: 0,
      pending: 0,
      other: 0,
      unparseable: 0,
      absent: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Supplemental confirmation                                                   */
/* -------------------------------------------------------------------------- */

function countSupplemental(raw: unknown, state: MutableState): void {
  if (raw === null || raw === undefined || raw === "") {
    state.supplemental.absent += 1;
    return;
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      state.supplemental.unparseable += 1;
      return;
    }
  }
  const record = asRecord(parsed);
  const confirmationState = textOf(record?.["state"]);
  if (confirmationState === null) {
    state.supplemental.other += 1;
    return;
  }
  const normalized = confirmationState.toUpperCase();
  if (normalized === "ACCEPTED") state.supplemental.accepted += 1;
  else if (normalized === "REJECTED") state.supplemental.rejected += 1;
  else if (normalized === "PENDING") state.supplemental.pending += 1;
  else state.supplemental.other += 1;
}

/* -------------------------------------------------------------------------- */
/* Core pass                                                                   */
/* -------------------------------------------------------------------------- */

interface PassResult {
  readonly groups: Map<string, GroupAccumulator>;
  readonly state: MutableState;
  readonly collector: ViolationCollector;
  readonly statesSeen: Set<number>;
  readonly isWinSeen: Set<number>;
  readonly unknownStates: Set<number>;
  readonly unknownIsWin: Set<number>;
  readonly disallowedStates: Set<number>;
  readonly disallowedIsWin: Set<number>;
}

function passRows(
  rows: readonly unknown[],
  captureId: string | null,
  policy: GroupIntegrityPolicy,
): PassResult {
  const groups = new Map<string, GroupAccumulator>();
  const state = emptyMutableState();
  const collector = makeCollector(policy.maxSamplesPerCode);
  const statesSeen = new Set<number>();
  const isWinSeen = new Set<number>();
  const unknownStates = new Set<number>();
  const unknownIsWin = new Set<number>();
  const disallowedStates = new Set<number>();
  const disallowedIsWin = new Set<number>();
  const knownStates = new Set(policy.knownStates);
  const allowedStates = new Set(policy.allowedStates);
  const knownIsWin = new Set(policy.knownIsWin);
  const allowedIsWin = new Set(policy.allowedIsWin);

  for (const raw of rows) {
    state.rows += 1;
    const row = asRecord(raw);
    if (row === null) {
      state.unreadableRows += 1;
      continue;
    }
    const betGroupId = textOf(row["betGroupId"]);
    if (betGroupId === null) {
      if (policy.requireGroupId) {
        state.missingGroupIdRows += 1;
        recordViolation(collector, "BET_GROUP_MISSING_GROUP_ID", "(none)", {
          row: state.rows,
        });
      }
      continue;
    }
    const group = accumulatorFor(groups, betGroupId);
    group.rows += 1;
    if (captureId !== null) group.captures.add(captureId);

    const userId = textOf(row["userID"]);
    if (userId === null) {
      if (policy.requireUser) {
        state.missingUserRows += 1;
        recordViolation(collector, "BET_GROUP_MISSING_USER", betGroupId, {
          row: state.rows,
        });
      }
    } else {
      group.userIds.add(userId);
    }

    const partnerId = textOf(row["partnerUserID"]);
    if (partnerId === null) state.missingPartnerRows += 1;
    else group.partnerIds.add(partnerId);

    const stateCode = intOf(row["state"]);
    if (stateCode === null) {
      state.missingStateRows += 1;
    } else {
      statesSeen.add(stateCode);
      group.states.add(stateCode);
      if (!knownStates.has(stateCode)) {
        unknownStates.add(stateCode);
        recordViolation(collector, "BET_GROUP_UNKNOWN_STATE", betGroupId, {
          state: stateCode,
        });
      } else if (!allowedStates.has(stateCode)) {
        disallowedStates.add(stateCode);
        recordViolation(collector, "BET_GROUP_DISALLOWED_STATE", betGroupId, {
          state: stateCode,
        });
      }
      if (stateCode === 1) state.pendingComponentRows += 1;
      if (stateCode === -1) state.canceledComponentRows += 1;
    }

    const isWin = intOf(row["isWin"]);
    if (isWin === null) {
      state.missingIsWinRows += 1;
    } else {
      isWinSeen.add(isWin);
      group.isWins.add(isWin);
      if (!knownIsWin.has(isWin)) {
        unknownIsWin.add(isWin);
        recordViolation(collector, "BET_GROUP_UNKNOWN_ISWIN", betGroupId, {
          isWin,
        });
      } else if (!allowedIsWin.has(isWin)) {
        disallowedIsWin.add(isWin);
        recordViolation(collector, "BET_GROUP_DISALLOWED_ISWIN", betGroupId, {
          isWin,
        });
      }
      if (isWin === -2) state.canceledComponentRows += 1;
    }

    for (const field of policy.ticketFields) {
      const rawValue = row[field];
      const values = group.ticketValues.get(field) ?? new Set<string>();
      values.add(fieldKey(rawValue));
      group.ticketValues.set(field, values);
      if (!finiteRawNumber(rawValue)) {
        state.invalidFinancialValues += 1;
        recordViolation(collector, "BET_GROUP_INVALID_FINANCIAL", betGroupId, {
          field,
          value: String(rawValue),
        });
      }
    }

    countSupplemental(row["supplementalConfirmation"], state);
  }

  return {
    groups,
    state,
    collector,
    statesSeen,
    isWinSeen,
    unknownStates,
    unknownIsWin,
    disallowedStates,
    disallowedIsWin,
  };
}

/* -------------------------------------------------------------------------- */
/* Summary assembly                                                            */
/* -------------------------------------------------------------------------- */

function sortedNumbers(values: ReadonlySet<number>): readonly number[] {
  return [...values].sort((left, right) => left - right);
}

function assembleSummary(
  pass: PassResult,
  policy: GroupIntegrityPolicy,
  source: GroupIntegritySource | null,
): GroupIntegritySummary {
  const { groups, state } = pass;
  let duplicateGroupRows = 0;
  let mixedStateGroups = 0;
  let partiallyGradedGroups = 0;
  let mixedIsWinGroups = 0;
  let crossPlayerGroups = 0;
  let crossPartnerGroups = 0;
  let ticketFieldConflicts = 0;
  let overlappingGroups = 0;
  for (const [betGroupId, group] of groups) {
    duplicateGroupRows += Math.max(0, group.rows - 1);
    if (group.captures.size > 1) overlappingGroups += 1;
    if (group.states.size > 1) mixedStateGroups += 1;
    if (group.states.has(2) && [...group.states].some((code) => code !== 2)) {
      partiallyGradedGroups += 1;
    }
    if (group.isWins.size > 1) mixedIsWinGroups += 1;
    if (group.userIds.size > 1) {
      crossPlayerGroups += 1;
      recordViolation(
        pass.collector,
        "BET_GROUP_MULTIPLE_PLAYERS",
        betGroupId,
        {
          distinctPlayers: group.userIds.size,
          players: [...group.userIds].sort(),
        },
      );
    }
    if (group.partnerIds.size > 1) {
      crossPartnerGroups += 1;
      recordViolation(
        pass.collector,
        "BET_GROUP_MULTIPLE_PARTNERS",
        betGroupId,
        {
          distinctPartners: group.partnerIds.size,
          partners: [...group.partnerIds].sort(),
        },
      );
    }
    const conflicting = [...group.ticketValues.entries()].filter(
      ([, values]) => values.size > 1,
    );
    if (conflicting.length > 0) {
      ticketFieldConflicts += 1;
      recordViolation(pass.collector, "BET_GROUP_RESULT_CONFLICT", betGroupId, {
        fields: conflicting.map(([field]) => field).sort(),
      });
    }
  }

  const counters: GroupIntegrityCounters = {
    rows: state.rows,
    groups: groups.size,
    duplicateGroupRows,
    crossPlayerGroups,
    crossPartnerGroups,
    missingGroupIdRows: state.missingGroupIdRows,
    missingUserRows: state.missingUserRows,
    ticketFieldConflicts,
    invalidFinancialValues: state.invalidFinancialValues,
    unreadableRows: state.unreadableRows,
    missingStateRows: state.missingStateRows,
    overlappingGroups,
  };

  const observations: GroupIntegrityObservations = {
    mixedStateGroups,
    partiallyGradedGroups,
    mixedIsWinGroups,
    pendingComponentRows: state.pendingComponentRows,
    canceledComponentRows: state.canceledComponentRows,
    missingPartnerRows: state.missingPartnerRows,
    missingIsWinRows: state.missingIsWinRows,
    supplemental: { ...state.supplemental },
    statesSeen: sortedNumbers(pass.statesSeen),
    isWinSeen: sortedNumbers(pass.isWinSeen),
    unknownStates: sortedNumbers(pass.unknownStates),
    unknownIsWin: sortedNumbers(pass.unknownIsWin),
    disallowedStates: sortedNumbers(pass.disallowedStates),
    disallowedIsWin: sortedNumbers(pass.disallowedIsWin),
  };

  const hasInvariantBreach =
    crossPlayerGroups > 0 ||
    crossPartnerGroups > 0 ||
    ticketFieldConflicts > 0 ||
    state.missingGroupIdRows > 0 ||
    state.missingUserRows > 0 ||
    state.invalidFinancialValues > 0 ||
    observations.disallowedStates.length > 0 ||
    observations.disallowedIsWin.length > 0;
  const hasCoverageGap =
    state.unreadableRows > 0 ||
    state.missingStateRows > 0 ||
    observations.supplemental.unparseable > 0 ||
    observations.unknownStates.length > 0 ||
    observations.unknownIsWin.length > 0;

  const status: GroupIntegrityStatus =
    state.rows === 0
      ? "unavailable"
      : hasInvariantBreach
        ? "invalid"
        : hasCoverageGap
          ? "incomplete"
          : "verified";

  return {
    schemaVersion: GROUP_INTEGRITY_SCHEMA_VERSION,
    derivationVersion: GROUP_INTEGRITY_DERIVATION_VERSION,
    policyVersion: policy.policyVersion,
    status,
    counters,
    observations,
    violationCounts: Object.fromEntries(
      [...pass.collector.counts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    violations: pass.collector.samples,
    source,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** Validate one capture's raw component rows (all rows, before ticket dedupe). */
export function buildGroupIntegrity(
  rows: readonly unknown[],
  options: GroupIntegrityOptions = {},
): GroupIntegritySummary {
  const policy = options.policy ?? DEFAULT_GROUP_INTEGRITY_POLICY;
  const pass = passRows(rows, null, policy);
  const source: GroupIntegritySource = {
    kind: options.source?.kind ?? "unknown",
    capturedRows: options.source?.capturedRows ?? rows.length,
    ...(options.source?.capturedAt === undefined
      ? {}
      : { capturedAt: options.source.capturedAt }),
    ...(options.source?.sha256 === undefined
      ? {}
      : { sha256: options.source.sha256 }),
  };
  return assembleSummary(pass, policy, source);
}

/**
 * Validate several captures as one dataset: groups are keyed by `betGroupId` once, so an
 * overlapping ticket is validated across captures instead of being counted twice. Each capture
 * can also be validated independently with {@link buildGroupIntegrity}.
 */
export function mergeGroupIntegrity(
  captures: readonly GroupIntegrityCapture[],
  options: Omit<GroupIntegrityOptions, "source"> = {},
): GroupIntegritySummary {
  const policy = options.policy ?? DEFAULT_GROUP_INTEGRITY_POLICY;
  const mergedGroups = new Map<string, GroupAccumulator>();
  const state = emptyMutableState();
  const collector = makeCollector(policy.maxSamplesPerCode);
  const statesSeen = new Set<number>();
  const isWinSeen = new Set<number>();
  const unknownStates = new Set<number>();
  const unknownIsWin = new Set<number>();
  const disallowedStates = new Set<number>();
  const disallowedIsWin = new Set<number>();

  for (const capture of captures) {
    const pass = passRows(capture.rows, capture.captureId, policy);
    state.rows += pass.state.rows;
    state.unreadableRows += pass.state.unreadableRows;
    state.missingGroupIdRows += pass.state.missingGroupIdRows;
    state.missingUserRows += pass.state.missingUserRows;
    state.missingStateRows += pass.state.missingStateRows;
    state.missingPartnerRows += pass.state.missingPartnerRows;
    state.missingIsWinRows += pass.state.missingIsWinRows;
    state.invalidFinancialValues += pass.state.invalidFinancialValues;
    state.pendingComponentRows += pass.state.pendingComponentRows;
    state.canceledComponentRows += pass.state.canceledComponentRows;
    state.supplemental.accepted += pass.state.supplemental.accepted;
    state.supplemental.rejected += pass.state.supplemental.rejected;
    state.supplemental.pending += pass.state.supplemental.pending;
    state.supplemental.other += pass.state.supplemental.other;
    state.supplemental.unparseable += pass.state.supplemental.unparseable;
    state.supplemental.absent += pass.state.supplemental.absent;
    for (const code of pass.statesSeen) statesSeen.add(code);
    for (const code of pass.isWinSeen) isWinSeen.add(code);
    for (const code of pass.unknownStates) unknownStates.add(code);
    for (const code of pass.unknownIsWin) unknownIsWin.add(code);
    for (const code of pass.disallowedStates) disallowedStates.add(code);
    for (const code of pass.disallowedIsWin) disallowedIsWin.add(code);
    for (const [code, count] of pass.collector.counts) {
      collector.counts.set(code, (collector.counts.get(code) ?? 0) + count);
    }
    for (const sample of pass.collector.samples) {
      if (collector.samples.length < collector.maxSamples) {
        collector.samples.push(sample);
      }
    }
    for (const [betGroupId, incoming] of pass.groups) {
      const target = accumulatorFor(mergedGroups, betGroupId);
      for (const userId of incoming.userIds) target.userIds.add(userId);
      for (const partnerId of incoming.partnerIds) {
        target.partnerIds.add(partnerId);
      }
      for (const [field, values] of incoming.ticketValues) {
        const targetValues =
          target.ticketValues.get(field) ?? new Set<string>();
        for (const value of values) targetValues.add(value);
        target.ticketValues.set(field, targetValues);
      }
      for (const code of incoming.states) target.states.add(code);
      for (const code of incoming.isWins) target.isWins.add(code);
      target.rows += incoming.rows;
      for (const captureId of incoming.captures) {
        target.captures.add(captureId);
      }
    }
  }

  const pass: PassResult = {
    groups: mergedGroups,
    state,
    collector,
    statesSeen,
    isWinSeen,
    unknownStates,
    unknownIsWin,
    disallowedStates,
    disallowedIsWin,
  };
  return assembleSummary(pass, policy, {
    kind: "multi-capture",
    capturedRows: state.rows,
    captures: captures.map((capture) => capture.captureId),
  });
}
