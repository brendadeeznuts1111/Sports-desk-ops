/**
 * @fileoverview Automated Specification-Grade Naming Police (`specification-grade-naming`
 * & DOD6 v5.4 Frozen Spec Gate Verifier).
 *
 * Enforces fail-closed runtime and static source-code policing across 4 mandatory gates:
 *  - NAMING-GATE-01 (`assertColumnStoreNamingAndUnsignedHandles`):
 *      Verifies `<metricName><Unit>Col` suffixes, rejects signed `Int32Array`/`BigInt64Array`
 *      on Handle/Key/Word/Rotation/BitSet columns, and rejects IEEE-754 float arrays on
 *      Cents/BasisPoints/LineHundredths columns.
 *  - NAMING-GATE-02 (`assertBridgeAndChannelTaxonomicSeparation`):
 *      Verifies disjointness and canonical pattern compliance across `TransportBridgeId`
 *      (`^BRIDGE_[0-9]{2}_[A-Z0-9_]+$`) and `ExtendedSignalChannelCode` (11 frozen wire
 *      tokens + `^CROSS_VENUE_[A-Z0-9_]+$`), contiguous ordinals, and non-null sentinels.
 *  - NAMING-GATE-03 (`assertRecordHasNoNullOrBooleanFields`):
 *      Verifies that specification records replace boolean flags with `BitSet32` bitmasks.
 *  - NAMING-GATE-04 (`auditSourceCodeNamingCompliance`):
 *      Strips comments and scans TypeScript source text for banned informal abbreviations
 *      (`xmkt`, `shortDesc`, `slaMaxAgeMs`, `wsTopic`, `userPtr`, `comboHash`, `customerMap`),
 *      banned hot-path heap structures (`new Map`, `new Set`, `boolean[]`, `Array<boolean>`),
 *      `parseFloat(`, and generic `throw new Error(`.
 */

import {
  DodGateFailureError,
  SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
} from "./bridge_and_channel_router.ts";

const APPROVED_COLUMN_UNIT_SUFFIX_REGEX =
  /(Cents|SettledCents|LifetimeCents|BasisPoints|LineHundredths|EpochDays|DurationMilliseconds|[rR]otationNumber|Word32|Word64|Handle32|Handle64|Key15|Key64|BitSet32|BitSet64)Col$/;

const UNSIGNED_REQUIRED_COLUMN_TOKEN_REGEX =
  /(Handle32|Handle64|Key15|Key64|Word32|Word64|[rR]otationNumber|BitSet32|BitSet64)Col$/;

const FIXED_POINT_INTEGER_COLUMN_TOKEN_REGEX =
  /(Cents|SettledCents|LifetimeCents|BasisPoints|LineHundredths)Col$/;

const CANONICAL_BRIDGE_ID_REGEX = /^BRIDGE_[0-9]{2}_[A-Z0-9_]+$/;

const FROZEN_SPORTSBOOK_WIRE_CHANNELS: Readonly<Record<string, true>> = {
  NON_SPORTS_DROP: true,
  BLOCKED: true,
  GATEWAY: true,
  ALERT: true,
  Internet: true,
  GSLIVE: true,
  GSBUILDER: true,
  LIVE_CWS: true,
  CSLEVEL2: true,
  PHONE: true,
  HOUSE_BOOK: true,
};

const CANONICAL_CROSS_VENUE_CHANNEL_REGEX = /^CROSS_VENUE_[A-Z0-9_]+$/;
const CANONICAL_NEURON_TOKEN_REGEX = /^L(1[89]|2[0-4])\.N[0-9]{4}$/;

/**
 * NAMING-GATE-01: Enforces `<metricName><Unit>Col` suffix contract and unsigned / fixed-point
 * typed array invariants on any DOD6 Structure-of-Arrays (SoA) ColumnStore instance.
 */
export function assertColumnStoreNamingAndUnsignedHandles(
  columnStore: Record<string, unknown>,
  storeSectionName = "SEC_SOA_COLUMN_STORE",
): void {
  const keys = Object.keys(columnStore);
  let colCount = 0;

  for (let i = 0; i < keys.length; i++) {
    const propName = keys[i]!;
    if (propName === "capacity") continue;

    if (!propName.endsWith("Col")) {
      throw new DodGateFailureError({
        gate: 1,
        section: storeSectionName,
        expected:
          "All non-capacity ColumnStore fields must end with '<Unit>Col'",
        actual: propName,
      });
    }

    if (!APPROVED_COLUMN_UNIT_SUFFIX_REGEX.test(propName)) {
      throw new DodGateFailureError({
        gate: 1,
        section: storeSectionName,
        expected: `Approved unit suffix matching ${APPROVED_COLUMN_UNIT_SUFFIX_REGEX.source}`,
        actual: propName,
      });
    }

    const colValue = columnStore[propName];
    colCount += 1;

    if (UNSIGNED_REQUIRED_COLUMN_TOKEN_REGEX.test(propName)) {
      const isUnsignedTypedArray =
        colValue instanceof Uint32Array ||
        colValue instanceof BigUint64Array ||
        colValue instanceof Uint16Array ||
        colValue instanceof Uint8Array;
      if (!isUnsignedTypedArray) {
        const actualType =
          colValue && typeof colValue === "object"
            ? colValue.constructor.name
            : typeof colValue;
        throw new DodGateFailureError({
          gate: 1,
          section: storeSectionName,
          expected: `Unsigned TypedArray (Uint32Array | BigUint64Array) for ${propName}`,
          actual: `${propName} is ${actualType}`,
        });
      }
    }

    if (FIXED_POINT_INTEGER_COLUMN_TOKEN_REGEX.test(propName)) {
      const isFixedPointIntegerArray =
        colValue instanceof Int32Array || colValue instanceof BigInt64Array;
      if (!isFixedPointIntegerArray) {
        const actualType =
          colValue && typeof colValue === "object"
            ? colValue.constructor.name
            : typeof colValue;
        throw new DodGateFailureError({
          gate: 6,
          section: storeSectionName,
          expected: `Fixed-point integer TypedArray (Int32Array | BigInt64Array) for ${propName}`,
          actual: `${propName} is ${actualType}`,
        });
      }
    }
  }

  if (colCount === 0) {
    throw new DodGateFailureError({
      gate: 1,
      section: storeSectionName,
      expected: ">= 1 SoA *Col typed array",
      actual: 0,
    });
  }
}

/**
 * NAMING-GATE-02 & NAMING-GATE-03: Enforces strict taxonomic orthogonality, contiguous ordinals,
 * non-null sentinels, and zero boolean fields across Bridge and Channel specification tables.
 */
export function assertBridgeAndChannelTaxonomicSeparation(
  bridgeTable: Record<string, unknown> = TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  channelTable: Record<
    string,
    unknown
  > = SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
): void {
  const bridgeKeys = Object.keys(bridgeTable);
  const channelKeys = Object.keys(channelTable);

  for (let i = 0; i < bridgeKeys.length; i++) {
    const key = bridgeKeys[i]!;
    if (!CANONICAL_BRIDGE_ID_REGEX.test(key)) {
      throw new DodGateFailureError({
        gate: 7,
        section: "SEC_TRANSPORT_BRIDGE_NAMING_POLICE",
        rowIdx: i,
        expected: CANONICAL_BRIDGE_ID_REGEX.source,
        actual: key,
      });
    }
    if (key in channelTable) {
      throw new DodGateFailureError({
        gate: 7,
        section: "SEC_BRIDGE_CHANNEL_DISJOINTNESS",
        rowIdx: i,
        expected:
          "Disjoint TransportBridgeId and ExtendedSignalChannelCode namespaces",
        actual: `Collision on identifier '${key}'`,
      });
    }

    const spec = bridgeTable[key] as Record<string, unknown>;
    if (spec.bridgeOrdinal4 !== i) {
      throw new DodGateFailureError({
        gate: 7,
        section: "SEC_TRANSPORT_BRIDGE_ORDINAL_CONTIGUITY",
        rowIdx: i,
        expected: i,
        actual: String(spec.bridgeOrdinal4),
      });
    }
    assertRecordHasNoNullOrBooleanFields(spec, `BRIDGE_SPEC:${key}`);
  }

  for (let j = 0; j < channelKeys.length; j++) {
    const key = channelKeys[j]!;
    const isValidChannelName =
      FROZEN_SPORTSBOOK_WIRE_CHANNELS[key] === true ||
      CANONICAL_CROSS_VENUE_CHANNEL_REGEX.test(key);

    if (!isValidChannelName) {
      throw new DodGateFailureError({
        gate: 7,
        section: "SEC_SIGNAL_CHANNEL_NAMING_POLICE",
        rowIdx: j,
        expected: "11 frozen wire tokens or ^CROSS_VENUE_[A-Z0-9_]+$",
        actual: key,
      });
    }

    const spec = channelTable[key] as Record<string, unknown>;
    if (spec.channelOrdinal5 !== j) {
      throw new DodGateFailureError({
        gate: 7,
        section: "SEC_SIGNAL_CHANNEL_ORDINAL_CONTIGUITY",
        rowIdx: j,
        expected: j,
        actual: String(spec.channelOrdinal5),
      });
    }

    const neuronId = String(spec.neuronTokenIdentifier ?? "");
    if (!CANONICAL_NEURON_TOKEN_REGEX.test(neuronId)) {
      throw new DodGateFailureError({
        gate: 7,
        section: "SEC_NEURON_TOKEN_NAMING_POLICE",
        rowIdx: j,
        expected: CANONICAL_NEURON_TOKEN_REGEX.source,
        actual: neuronId,
      });
    }

    assertRecordHasNoNullOrBooleanFields(spec, `CHANNEL_SPEC:${key}`);
  }
}

export function assertRecordHasNoNullOrBooleanFields(
  record: Record<string, unknown>,
  sectionContext: string,
): void {
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) {
    const fieldName = keys[i]!;
    const value = record[fieldName];
    if (value === null || value === undefined) {
      throw new DodGateFailureError({
        gate: 2,
        section: sectionContext,
        expected: `Explicit sentinel (never null/undefined) on field '${fieldName}'`,
        actual: String(value),
      });
    }
    if (typeof value === "boolean") {
      throw new DodGateFailureError({
        gate: 4,
        section: sectionContext,
        expected: `BitSet32 bitmask instead of boolean on field '${fieldName}'`,
        actual: `boolean (${String(value)})`,
      });
    }
  }
}

interface ForbiddenSourcePatternRule {
  readonly ruleId: string;
  readonly regex: RegExp;
  readonly rationale: string;
}

const FORBIDDEN_SOURCE_PATTERNS: readonly ForbiddenSourcePatternRule[] = [
  {
    ruleId: "BANNED_INFORMAL_ABBREVIATION",
    regex:
      /\b(xmkt|shortDesc|slaMaxAgeMs|wsTopic|userPtr|comboHash|customerMap|users)\b/,
    rationale:
      "Use specification-grade identifiers (CROSS_VENUE_*, shortDescriptionPrefix, freshnessSlaDurationMs, webSocketSubscriptionTopic, CustomerPackedHandle32, ComboPackedKey15)",
  },
  {
    ruleId: "BANNED_HOT_PATH_HEAP_CACHE",
    regex: /\bnew\s+(Map|Set|WeakMap|WeakSet)\s*(<|\()/,
    rationale:
      "Zero-Cache DOD6 v5.4 rule bans Map/Set/WeakMap on hot paths; use typed SoA column stores and BitSet32",
  },
  {
    ruleId: "BANNED_BOOLEAN_ARRAY",
    regex: /:\s*boolean\s*\[\]|\bArray\s*<\s*boolean\s*>/,
    rationale:
      "Boolean arrays are banned; use BitSet32 / BitSet64 or Uint32Array bitmasks",
  },
  {
    ruleId: "BANNED_FLOAT_CURRENCY_PARSER",
    regex: /\bparseFloat\s*\(/,
    rationale:
      "IEEE-754 parseFloat is banned for money/lines; use fixed-point integer parsers",
  },
  {
    ruleId: "BANNED_UNTYPED_ERROR_THROW",
    regex: /\bthrow\s+new\s+(Error|RangeError|TypeError)\s*\(/,
    rationale:
      "Spine modules must throw structured DodGateFailureError({ gate, section, rowIdx, expected, actual })",
  },
];

/**
 * NAMING-GATE-04: Strips comments and audits TypeScript source code for banned abbreviations,
 * hot-path heap caches, boolean arrays, float parsers, and untyped Error throws.
 */
export function auditSourceCodeNamingCompliance(
  sourceText: string,
  moduleName = "bridge_and_channel_router.ts",
): void {
  const uncommentedSource = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  for (let i = 0; i < FORBIDDEN_SOURCE_PATTERNS.length; i++) {
    const rule = FORBIDDEN_SOURCE_PATTERNS[i]!;
    const match = rule.regex.exec(uncommentedSource);
    if (match) {
      throw new DodGateFailureError({
        gate: 8,
        section: `SEC_SOURCE_NAMING_POLICE:${moduleName}:${rule.ruleId}`,
        expected: rule.rationale,
        actual: `Matched forbidden token '${match[0]}'`,
      });
    }
  }
}
