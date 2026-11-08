/**
 * @file schema/rsk06_telemetry_matrix.ts
 * @artifact ART-SCHEMA-RSK06-TELEMETRY-MATRIX
 * @taxonomy L0_SCHEMA_AND_TYPES / RUNTIME (DOC-33 / DOC-37)
 * @specification Formal Enforceable Schema Contract for the 22-Row RSK-06 Telemetry Matrix (v2.3.0)
 * @description Decouples register_def (static definitions) from register_state (runtime snapshot).
 *              Enforces pure-shape Resource_Type (COUNT, CURRENCY_CENTS), role-gated Measurement_Confidence,
 *              one-rule Bound (populated iff boundType != EXACT), paired divergenceCount + divergenceUnit,
 *              structured Health, boundaryOp, and predicateExpression, complete Monotonicity across
 *              all CURSOR/EPOCH types, pure deriveLag() + deriveValidity() with zero magic constants,
 *              and strictly prefix-free column naming across all attributes.
 */

export const RSK06_MATRIX_SCHEMA_VERSION = "2.3.0" as const;
export const CATEGORY_COMPAT_SUNSET_DATE = "2026-12-01" as const;

// ============================================================================
// 1. AXIS ENUMS & CANONICAL VOCABULARIES
// ============================================================================

export type Rsk06Layer =
  | "CONTRACT"
  | "SPINE_HEADER"
  | "REPO"
  | "TELEMETRY"
  | "DERIVED"
  | "ENV"
  | "HUMAN";

export type Rsk06Role =
  "INSTRUCTION" | "CHECK" | "HANDLE" | "OBSERVATION" | "EVIDENCE";

/**
 * Pure data shape (domain subject lives in Target, Stream, or Measure).
 */
export type Rsk06ResourceType =
  | "CURSOR"
  | "INVARIANT"
  | "GATE"
  | "EPOCH"
  | "BITMASK"
  | "CHECKSUM"
  | "GIT_SHA"
  | "BUNDLE_FILE_ID"
  | "SNAPSHOT_FILE_ID"
  | "COUNT"
  | "CURRENCY_CENTS"
  | "NOT_APPLICABLE";

export type Rsk06AccessMode =
  "READ" | "PUSH" | "PULL" | "STREAM" | "QUERY" | "NOT_APPLICABLE";

export type Rsk06Stream =
  | "BET_TICKER"
  | "TWINS"
  | "BUN_CRON"
  | "R2_REMOTE"
  | "LOCAL_STREAM"
  | "TICKETS"
  | "SETTLED"
  | "NOT_APPLICABLE";

export type Rsk06Measure = "OPERATIONAL" | "FINANCIAL" | "NOT_APPLICABLE";

export type Rsk06Monotonicity =
  "CUMULATIVE" | "GAUGE" | "BOUNDARY" | "HEAD" | "NOT_APPLICABLE";

export type Rsk06Lifecycle =
  "PENDING" | "STAGED" | "ACTIVE" | "DEPLOYED" | "RETIRED" | "NOT_APPLICABLE";

export type Rsk06Validity =
  | "FRESH"
  | "STALE"
  | "EXPIRED"
  | "UNVERIFIED"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export type Rsk06GateScope =
  "DISPATCH" | "INTEGRITY" | "INVARIANT" | "NOT_APPLICABLE";

export type Rsk06GateState = "HOLD" | "PASS" | "FAIL" | "NOT_APPLICABLE";

export type Rsk06Health = "OK" | "FROZEN" | "STALLED" | "NOT_APPLICABLE";

export type Rsk06MeasurementConfidence =
  "EXACT" | "SAMPLED" | "ESTIMATED" | "NOT_APPLICABLE";

export type Rsk06ConfirmationState =
  "CONFIRMED" | "PROVISIONAL" | "NOT_APPLICABLE";

export type Rsk06BoundaryOp =
  "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NOT_APPLICABLE";

export type Rsk06LagUnit = "EPOCH" | "ID" | "TIME_S" | "NOT_APPLICABLE";

export type Rsk06BoundType =
  "EXACT" | "LOWER_BOUND" | "UPPER_BOUND" | "NOT_APPLICABLE";

export type Rsk06DivergenceUnit = "COMMITS" | "ID" | "NOT_APPLICABLE";

export type Rsk06LegacyCategoryCompat =
  "CONTRACT" | "WATERMARK" | "INTEGRITY" | "RESOURCE" | "COUNTER" | "BOOK";

// ============================================================================
// 2. SWEEP CONTEXT INTERFACE
// ============================================================================

export interface SweepContext {
  readonly evalEpoch: number;
  readonly confirmedHostCommit: string;
  readonly collectedAt: string;
}

// ============================================================================
// 3. STATIC DEFINITION INTERFACE (register_def)
// ============================================================================

export interface Rsk06RegisterDefinition {
  readonly rowNumber: number;
  readonly register: string;
  readonly layer: Rsk06Layer;
  readonly role: Rsk06Role;
  readonly target: string;
  readonly resourceType: Rsk06ResourceType;
  readonly mode: Rsk06AccessMode;
  readonly stream: Rsk06Stream;
  readonly measure: Rsk06Measure;
  readonly monotonicity: Rsk06Monotonicity;
  readonly categoryCompat: Rsk06LegacyCategoryCompat;
}

// ============================================================================
// 4. RUNTIME SNAPSHOT STATE INTERFACE (register_state)
// ============================================================================

export interface Rsk06RegisterState {
  readonly rowNumber: number;
  readonly register: string;
  readonly resourceIdentifier: string;
  readonly lifecycle: Rsk06Lifecycle;
  readonly validity: Rsk06Validity;
  readonly gateScope: Rsk06GateScope;
  readonly gateState: Rsk06GateState;
  readonly health: Rsk06Health;
  readonly boundaryOp: Rsk06BoundaryOp;
  readonly predicateExpression: string | null;
  readonly measurementConfidence: Rsk06MeasurementConfidence;
  readonly confirmationState: Rsk06ConfirmationState;
  readonly lagAmount: number | null;
  readonly lagUnit: Rsk06LagUnit;
  readonly boundLimit: number | null;
  readonly boundType: Rsk06BoundType;
  readonly divergenceCount: number | null;
  readonly divergenceUnit: Rsk06DivergenceUnit;
  readonly notes: string;
}

// ============================================================================
// 5. PURE DERIVATION FUNCTIONS
// ============================================================================

export function deriveRole(
  layer: Rsk06Layer,
  resourceType: Rsk06ResourceType,
): Rsk06Role {
  if (layer === "CONTRACT") return "INSTRUCTION";
  if (layer === "REPO") return "HANDLE";
  if (layer === "SPINE_HEADER") {
    if (resourceType === "BITMASK" || resourceType === "CHECKSUM")
      return "CHECK";
    return "OBSERVATION";
  }
  return "OBSERVATION";
}

export function deriveCategoryCompat(
  layer: Rsk06Layer,
  resourceType: Rsk06ResourceType,
  registerName: string,
): Rsk06LegacyCategoryCompat {
  if (layer === "CONTRACT") return "CONTRACT";
  if (layer === "REPO") return "RESOURCE";
  if (layer === "SPINE_HEADER") {
    if (resourceType === "BITMASK" || resourceType === "CHECKSUM")
      return "INTEGRITY";
    return "WATERMARK";
  }
  if (registerName.includes("Watermark")) return "WATERMARK";
  if (
    resourceType === "COUNT" &&
    (registerName.includes("Counter") || registerName.includes("Ticks"))
  ) {
    return "COUNTER";
  }
  if (registerName.startsWith("ep04") || registerName.startsWith("ep05"))
    return "BOOK";
  return "RESOURCE";
}

export function deriveLag(
  def: Rsk06RegisterDefinition,
  state: Rsk06RegisterState,
  ctx: SweepContext,
  allStates: readonly Rsk06RegisterState[],
): number | null {
  if (def.register === "spineEpochWatermark") {
    const epochVal = Number(state.resourceIdentifier);
    return Math.max(0, ctx.evalEpoch - epochVal);
  }
  if (def.register === "ep09RemoteR2Watermark") {
    const localStreamState = allStates.find(
      (s) => s.register === "ep09LocalStreamWatermark",
    );
    if (localStreamState) {
      const r2Id = Number(state.resourceIdentifier.replace("M.G", ""));
      const localId = Number(
        localStreamState.resourceIdentifier.replace("M.G", ""),
      );
      return Math.max(0, localId - r2Id);
    }
  }
  return null;
}

export function deriveValidity(
  def: Rsk06RegisterDefinition,
  state: Rsk06RegisterState,
  ctx: SweepContext,
  allStates: readonly Rsk06RegisterState[],
): Rsk06Validity {
  if (def.layer === "CONTRACT") {
    return "FRESH";
  }
  if (def.register === "spineEpochWatermark") {
    const lagVal = deriveLag(def, state, ctx, allStates);
    return lagVal !== null && lagVal > 0 ? "STALE" : "FRESH";
  }
  if (def.register === "spinePoisonBit" || def.register === "spineCrc32c") {
    return "FRESH";
  }
  if (def.register === "ep09RemoteR2Watermark") {
    const lagVal = deriveLag(def, state, ctx, allStates);
    return lagVal !== null && lagVal > 0 ? "STALE" : "FRESH";
  }
  if (state.resourceIdentifier === "LEG_COUNT_UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  return "FRESH";
}

// ============================================================================
// 6. LEGAL TRIPLE MATRIX & VALIDATOR
// ============================================================================

export interface LegalTripleConstraint {
  readonly layer: Rsk06Layer;
  readonly role: Rsk06Role;
  readonly allowedResourceTypes: readonly Rsk06ResourceType[];
  readonly allowedModes: readonly Rsk06AccessMode[];
}

export const LEGAL_TRIPLES_ALLOW_SET: readonly LegalTripleConstraint[] = [
  {
    layer: "CONTRACT",
    role: "INSTRUCTION",
    allowedResourceTypes: ["CURSOR", "INVARIANT", "GATE"],
    allowedModes: ["NOT_APPLICABLE"],
  },
  {
    layer: "SPINE_HEADER",
    role: "OBSERVATION",
    allowedResourceTypes: ["EPOCH"],
    allowedModes: ["READ"],
  },
  {
    layer: "SPINE_HEADER",
    role: "CHECK",
    allowedResourceTypes: ["BITMASK", "CHECKSUM"],
    allowedModes: ["READ"],
  },
  {
    layer: "REPO",
    role: "HANDLE",
    allowedResourceTypes: ["GIT_SHA", "BUNDLE_FILE_ID", "SNAPSHOT_FILE_ID"],
    allowedModes: ["PUSH", "PULL"],
  },
  {
    layer: "TELEMETRY",
    role: "OBSERVATION",
    allowedResourceTypes: ["CURSOR", "COUNT", "CURRENCY_CENTS"],
    allowedModes: ["STREAM", "PULL", "QUERY"],
  },
  {
    layer: "DERIVED",
    role: "OBSERVATION",
    allowedResourceTypes: ["COUNT"],
    allowedModes: ["QUERY"],
  },
];

export function validateRegisterDefinition(def: Rsk06RegisterDefinition): {
  readonly valid: boolean;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const match = LEGAL_TRIPLES_ALLOW_SET.find(
    (t) => t.layer === def.layer && t.role === def.role,
  );
  if (!match) {
    errors.push(
      `Disallowed combination: Layer='${def.layer}' + Role='${def.role}'`,
    );
    return { valid: false, errors };
  }

  if (!match.allowedResourceTypes.includes(def.resourceType)) {
    errors.push(
      `Illegal ResourceType '${def.resourceType}' for Layer='${def.layer}', Role='${def.role}'`,
    );
  }

  if (!match.allowedModes.includes(def.mode)) {
    errors.push(
      `Illegal AccessMode '${def.mode}' for Layer='${def.layer}', Role='${def.role}'`,
    );
  }

  if (def.layer === "TELEMETRY" && def.stream === "NOT_APPLICABLE") {
    errors.push(
      `Telemetry register '${def.register}' must declare a stream source`,
    );
  }

  if (
    (def.resourceType === "EPOCH" || def.resourceType === "CURSOR") &&
    def.monotonicity === "NOT_APPLICABLE"
  ) {
    errors.push(
      `ResourceType '${def.resourceType}' on '${def.register}' must declare Monotonicity`,
    );
  }

  return { valid: errors.length === 0, errors };
}

export function validateRegisterState(
  def: Rsk06RegisterDefinition,
  state: Rsk06RegisterState,
): {
  readonly valid: boolean;
  readonly errors: string[];
} {
  const errors: string[] = [];

  // Enforce Gate_State <=> Gate_Scope
  const hasGateState = state.gateState !== "NOT_APPLICABLE";
  const hasGateScope = state.gateScope !== "NOT_APPLICABLE";
  if (hasGateState !== hasGateScope) {
    errors.push(
      `Row ${state.rowNumber} (${state.register}): Gate_State='${state.gateState}' requires Gate_Scope, but found Gate_Scope='${state.gateScope}'`,
    );
  }

  // D1: One-Rule Bound check: boundLimit populated iff boundType != NOT_APPLICABLE and boundType != EXACT
  const hasBound = state.boundLimit !== null;
  const isBoundTypeNonExact =
    state.boundType !== "NOT_APPLICABLE" && state.boundType !== "EXACT";
  if (hasBound !== isBoundTypeNonExact) {
    errors.push(
      `Row ${state.rowNumber} (${state.register}): boundLimit=${state.boundLimit} violates one-rule Bound (must be populated iff boundType is LOWER_BOUND or UPPER_BOUND)`,
    );
  }

  // D2: Measurement_Confidence role-gated: measurementConfidence != NOT_APPLICABLE <=> Role == OBSERVATION
  const hasConfidence = state.measurementConfidence !== "NOT_APPLICABLE";
  const isObservation = def.role === "OBSERVATION";
  if (hasConfidence !== isObservation) {
    errors.push(
      `Row ${state.rowNumber} (${state.register}): measurementConfidence='${state.measurementConfidence}' is role-gated to OBSERVATION (Role is '${def.role}')`,
    );
  }

  // D4: lagAmount/lagUnit and divergenceCount/divergenceUnit pairing
  if ((state.lagAmount !== null) !== (state.lagUnit !== "NOT_APPLICABLE")) {
    errors.push(
      `Row ${state.rowNumber} (${state.register}): lagAmount and lagUnit must be paired`,
    );
  }
  if (
    (state.divergenceCount !== null) !==
    (state.divergenceUnit !== "NOT_APPLICABLE")
  ) {
    errors.push(
      `Row ${state.rowNumber} (${state.register}): divergenceCount and divergenceUnit must be paired`,
    );
  }

  // D5: Extended Notes lint: no state words or operator leaks without structured fields
  const forbiddenStateWords = ["frozen", "provisional", "stale", "deployed"];
  const notesLower = state.notes.toLowerCase();
  for (const word of forbiddenStateWords) {
    if (notesLower.includes(word)) {
      errors.push(
        `Notes lint: Forbidden state word '${word}' found in notes of row ${state.rowNumber} (${state.register}); must live in structured field`,
      );
    }
  }

  const forbiddenOperators = [">", "<", ">=", "<=", "===", "&", "|"];
  for (const op of forbiddenOperators) {
    if (state.notes.includes(op)) {
      errors.push(
        `Notes lint: Operator '${op}' found in notes of row ${state.rowNumber} (${state.register}); must live in boundaryOp or predicateExpression`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// 7. THE 22 CANONICAL STATIC DEFINITIONS (register_def)
// ============================================================================

export const CANONICAL_22_REGISTER_DEFS: readonly Rsk06RegisterDefinition[] = [
  {
    rowNumber: 1,
    register: "inputLastWatermark",
    layer: "CONTRACT",
    role: "INSTRUCTION",
    target: "GSLive Ingest Stream",
    resourceType: "CURSOR",
    mode: "NOT_APPLICABLE",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "BOUNDARY",
    categoryCompat: "CONTRACT",
  },
  {
    rowNumber: 2,
    register: "inputTargetInvariant",
    layer: "CONTRACT",
    role: "INSTRUCTION",
    target: "Delay Bitset Register",
    resourceType: "INVARIANT",
    mode: "NOT_APPLICABLE",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "CONTRACT",
  },
  {
    rowNumber: 3,
    register: "inputFailureGate",
    layer: "CONTRACT",
    role: "INSTRUCTION",
    target: "Manager Wire Dispatcher",
    resourceType: "GATE",
    mode: "NOT_APPLICABLE",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "CONTRACT",
  },
  {
    rowNumber: 4,
    register: "spineEpochWatermark",
    layer: "SPINE_HEADER",
    role: "OBSERVATION",
    target: "SEC_00 Binary Header",
    resourceType: "EPOCH",
    mode: "READ",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "CUMULATIVE",
    categoryCompat: "WATERMARK",
  },
  {
    rowNumber: 5,
    register: "spinePoisonBit",
    layer: "SPINE_HEADER",
    role: "CHECK",
    target: "SEC_00 Binary Header",
    resourceType: "BITMASK",
    mode: "READ",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "INTEGRITY",
  },
  {
    rowNumber: 6,
    register: "spineCrc32c",
    layer: "SPINE_HEADER",
    role: "CHECK",
    target: "SEC_00 Binary Header",
    resourceType: "CHECKSUM",
    mode: "READ",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "INTEGRITY",
  },
  {
    rowNumber: 7,
    register: "gitHeadCommit",
    layer: "REPO",
    role: "HANDLE",
    target: "git HEAD (sandbox)",
    resourceType: "GIT_SHA",
    mode: "PUSH",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "RESOURCE",
  },
  {
    rowNumber: 8,
    register: "gitBundleResource",
    layer: "REPO",
    role: "HANDLE",
    target: "Google Drive Bundle",
    resourceType: "BUNDLE_FILE_ID",
    mode: "PULL",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "RESOURCE",
  },
  {
    rowNumber: 9,
    register: "activeSnapshotResource",
    layer: "REPO",
    role: "HANDLE",
    target: "Google Drive Snapshot",
    resourceType: "SNAPSHOT_FILE_ID",
    mode: "PULL",
    stream: "NOT_APPLICABLE",
    measure: "NOT_APPLICABLE",
    monotonicity: "NOT_APPLICABLE",
    categoryCompat: "RESOURCE",
  },
  {
    rowNumber: 10,
    register: "ep03BetTickerWatermark",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Fantasy402 Bet Ticker",
    resourceType: "CURSOR",
    mode: "STREAM",
    stream: "BET_TICKER",
    measure: "NOT_APPLICABLE",
    monotonicity: "CUMULATIVE",
    categoryCompat: "WATERMARK",
  },
  {
    rowNumber: 11,
    register: "ep03MatchedTwinsCounter",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Syndicate Detection Engine",
    resourceType: "COUNT",
    mode: "STREAM",
    stream: "TWINS",
    measure: "OPERATIONAL",
    monotonicity: "CUMULATIVE",
    categoryCompat: "COUNTER",
  },
  {
    rowNumber: 12,
    register: "ep03BunCronTicksCounter",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "BunCron Polling Daemon",
    resourceType: "COUNT",
    mode: "STREAM",
    stream: "BUN_CRON",
    measure: "OPERATIONAL",
    monotonicity: "CUMULATIVE",
    categoryCompat: "COUNTER",
  },
  {
    rowNumber: 13,
    register: "ep09RemoteR2Watermark",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Cloudflare R2 Sink",
    resourceType: "CURSOR",
    mode: "PULL",
    stream: "R2_REMOTE",
    measure: "NOT_APPLICABLE",
    monotonicity: "CUMULATIVE",
    categoryCompat: "WATERMARK",
  },
  {
    rowNumber: 14,
    register: "ep09LocalStreamWatermark",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "GSLive Ingest Stream",
    resourceType: "CURSOR",
    mode: "STREAM",
    stream: "LOCAL_STREAM",
    measure: "NOT_APPLICABLE",
    monotonicity: "HEAD",
    categoryCompat: "WATERMARK",
  },
  {
    rowNumber: 15,
    register: "ep04PendingStraightTickets",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Open Ticket Book",
    resourceType: "COUNT",
    mode: "QUERY",
    stream: "TICKETS",
    measure: "FINANCIAL",
    monotonicity: "GAUGE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 16,
    register: "ep04PendingParlayTickets",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Open Ticket Book",
    resourceType: "COUNT",
    mode: "QUERY",
    stream: "TICKETS",
    measure: "FINANCIAL",
    monotonicity: "GAUGE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 17,
    register: "ep04PendingTotalTickets",
    layer: "DERIVED",
    role: "OBSERVATION",
    target: "Open Ticket Book",
    resourceType: "COUNT",
    mode: "QUERY",
    stream: "TICKETS",
    measure: "FINANCIAL",
    monotonicity: "GAUGE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 18,
    register: "ep04PendingLegCount",
    layer: "DERIVED",
    role: "OBSERVATION",
    target: "Open Ticket Book",
    resourceType: "COUNT",
    mode: "QUERY",
    stream: "TICKETS",
    measure: "FINANCIAL",
    monotonicity: "GAUGE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 19,
    register: "ep04PendingRiskExposure",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Open Ticket Book",
    resourceType: "CURRENCY_CENTS",
    mode: "QUERY",
    stream: "TICKETS",
    measure: "FINANCIAL",
    monotonicity: "GAUGE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 20,
    register: "ep05SettledBetsCount",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Settled Ledger",
    resourceType: "COUNT",
    mode: "QUERY",
    stream: "SETTLED",
    measure: "FINANCIAL",
    monotonicity: "CUMULATIVE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 21,
    register: "ep05SettledStakedVolume",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Settled Ledger",
    resourceType: "CURRENCY_CENTS",
    mode: "QUERY",
    stream: "SETTLED",
    measure: "FINANCIAL",
    monotonicity: "CUMULATIVE",
    categoryCompat: "BOOK",
  },
  {
    rowNumber: 22,
    register: "ep05SettledHouseNetRevenue",
    layer: "TELEMETRY",
    role: "OBSERVATION",
    target: "Settled Ledger",
    resourceType: "CURRENCY_CENTS",
    mode: "QUERY",
    stream: "SETTLED",
    measure: "FINANCIAL",
    monotonicity: "CUMULATIVE",
    categoryCompat: "BOOK",
  },
];

// ============================================================================
// 8. CANONICAL RUNTIME SNAPSHOT STATE (register_state)
// ============================================================================

export const CANONICAL_SWEEP_CONTEXT: SweepContext = {
  evalEpoch: 20765,
  confirmedHostCommit: "4f5a551",
  collectedAt: "2026-11-07T19:01:22-06:00",
};

export const CANONICAL_22_REGISTER_STATES: readonly Rsk06RegisterState[] = [
  {
    rowNumber: 1,
    register: "inputLastWatermark",
    resourceIdentifier: "M.G319775995",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "DISPATCH",
    gateState: "PASS",
    health: "OK",
    boundaryOp: "GT",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Boundary watermark filter evaluating strictly above the boundary.",
  },
  {
    rowNumber: 2,
    register: "inputTargetInvariant",
    resourceIdentifier: "delay_queue_zero_overlap",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "INVARIANT",
    gateState: "PASS",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: "(T1 | T2 | T3) & VIPShield === 0",
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Enforces orthogonal VIP registers across all words.",
  },
  {
    rowNumber: 3,
    register: "inputFailureGate",
    resourceIdentifier: "UNBLOCKED_HOLD_AWAITING_AWAKE_HUMAN_APPROVER",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "DISPATCH",
    gateState: "HOLD",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes:
      "Deliberate safety dispatcher hold requiring human approver sign-off.",
  },
  {
    rowNumber: 4,
    register: "spineEpochWatermark",
    resourceIdentifier: "20763",
    lifecycle: "DEPLOYED",
    validity: "STALE",
    gateScope: "INTEGRITY",
    gateState: "PASS",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: 2,
    lagUnit: "EPOCH",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Stamped UTC header timestamp.",
  },
  {
    rowNumber: 5,
    register: "spinePoisonBit",
    resourceIdentifier: "0x00000000",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "INTEGRITY",
    gateState: "PASS",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes:
      "Bit verification proves header was not loaded from retired CSV snapshot.",
  },
  {
    rowNumber: 6,
    register: "spineCrc32c",
    resourceIdentifier: "0x758D6336",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "INTEGRITY",
    gateState: "PASS",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Castagnoli CRC32C verified across 2048-byte header.",
  },
  {
    rowNumber: 7,
    register: "gitHeadCommit",
    resourceIdentifier: "31d0357f84d7ac5ffb6c1bbcbce47dfed0c9a30f",
    lifecycle: "PENDING",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "PROVISIONAL",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: 10,
    divergenceUnit: "COMMITS",
    notes: "Commits ahead of confirmed host repository.",
  },
  {
    rowNumber: 8,
    register: "gitBundleResource",
    resourceIdentifier: "11HOnTGvDF7QP2tuvOUuhN9x_GRRrgfkI",
    lifecycle: "STAGED",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "sportsdesk-final bundle staged for host pull.",
  },
  {
    rowNumber: 9,
    register: "activeSnapshotResource",
    resourceIdentifier: "1vwI4W32Sbw2Jqanc-xESI-KlCcsgxW7Z",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "NOT_APPLICABLE",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Active content-addressed JSON backing delay queue.",
  },
  {
    rowNumber: 10,
    register: "ep03BetTickerWatermark",
    resourceIdentifier: "89571514",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Highest wager number ingested via Bridge 3a.",
  },
  {
    rowNumber: 11,
    register: "ep03MatchedTwinsCounter",
    resourceIdentifier: "1569",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Cumulative synchronized twin hits detected.",
  },
  {
    rowNumber: 12,
    register: "ep03BunCronTicksCounter",
    resourceIdentifier: "237476",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Total background ticker ingestion loop iterations executed.",
  },
  {
    rowNumber: 13,
    register: "ep09RemoteR2Watermark",
    resourceIdentifier: "M.G318706282",
    lifecycle: "DEPLOYED",
    validity: "STALE",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "FROZEN",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: 1069713,
    lagUnit: "ID",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Global betGroupIds behind local stream.",
  },
  {
    rowNumber: 14,
    register: "ep09LocalStreamWatermark",
    resourceIdentifier: "M.G319775995",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Live workstation GSLive stream head cursor.",
  },
  {
    rowNumber: 15,
    register: "ep04PendingStraightTickets",
    resourceIdentifier: "548",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Single-leg open straight parent tickets queried via Manager.",
  },
  {
    rowNumber: 16,
    register: "ep04PendingParlayTickets",
    resourceIdentifier: "246",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Unique parent multi-leg parlay tickets queried via Manager.",
  },
  {
    rowNumber: 17,
    register: "ep04PendingTotalTickets",
    resourceIdentifier: "794",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Total open parent tickets.",
  },
  {
    rowNumber: 18,
    register: "ep04PendingLegCount",
    resourceIdentifier: "LEG_COUNT_UNAVAILABLE",
    lifecycle: "ACTIVE",
    validity: "UNAVAILABLE",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: 1040,
    boundType: "LOWER_BOUND",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Bounded unknown; individual arrays unaggregated.",
  },
  {
    rowNumber: 19,
    register: "ep04PendingRiskExposure",
    resourceIdentifier: "35428000",
    lifecycle: "ACTIVE",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Total open risk liability in integer cents.",
  },
  {
    rowNumber: 20,
    register: "ep05SettledBetsCount",
    resourceIdentifier: "1963812",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Cumulative settled wager count via Report/getGrading.",
  },
  {
    rowNumber: 21,
    register: "ep05SettledStakedVolume",
    resourceIdentifier: "86543382253",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Cumulative settled turnover volume in integer cents.",
  },
  {
    rowNumber: 22,
    register: "ep05SettledHouseNetRevenue",
    resourceIdentifier: "3719484410",
    lifecycle: "DEPLOYED",
    validity: "FRESH",
    gateScope: "NOT_APPLICABLE",
    gateState: "NOT_APPLICABLE",
    health: "OK",
    boundaryOp: "NOT_APPLICABLE",
    predicateExpression: null,
    measurementConfidence: "EXACT",
    confirmationState: "CONFIRMED",
    lagAmount: null,
    lagUnit: "NOT_APPLICABLE",
    boundLimit: null,
    boundType: "NOT_APPLICABLE",
    divergenceCount: null,
    divergenceUnit: "NOT_APPLICABLE",
    notes: "Net house win across settled wagers in integer cents.",
  },
];
