import {
  asLineHundredths,
  asSettledCents,
  parseAsBasisPoints,
  parseAsEpochMs,
  type AmericanOdds,
  type BasisPoints,
  type Brand,
  type Cents,
  type EpochMs,
  type LineHundredths,
  type SettledCents,
} from "../design/domain-branded-types.ts";
import { writeAuditEntry } from "./audit_log.ts";

export { asLineHundredths, asSettledCents, parseAsBasisPoints, parseAsEpochMs };
export type {
  AmericanOdds,
  BasisPoints,
  Brand,
  Cents,
  EpochMs,
  LineHundredths,
  SettledCents,
};

export type DeskFormat = "toml" | "yaml" | "json" | "jsonl" | "xml";

export type DeskCompression =
  "gzip" | "deflate" | "deflate-raw" | "brotli" | "zstd";

export type DeskStreamSource =
  | ReadableStream<Uint8Array>
  | ReadableStream<string>
  | ReadableStream<string | Uint8Array>
  | Response
  | Request
  | Blob
  | Uint8Array
  | ArrayBuffer;

export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticCode =
  | "COERCION_INVALID_CENTS"
  | "COERCION_SUBCENT_PRECISION"
  | "COERCION_INVALID_AMERICAN_ODDS"
  | "COERCION_INVALID_DATE"
  | "MISSING_REQUIRED_FIELD"
  | "DEFAULTED_STATUS"
  | "FIELD_ATTRIBUTE_CHILD_CONFLICT"
  | "NON_RECORD_ARRAY_ELEMENT"
  | "MIXED_POSITION_CONTAINERS"
  | "MULTIPLE_LIMIT_BLOCKS"
  | "MISSING_MAX_STAKE"
  | "EMPTY_JSONL_STREAM"
  | "CYCLIC_DOCUMENT_REFERENCE";

export const ZERO_CENTS: Cents = 0 as Cents;
export const INVALID_AMERICAN_ODDS: AmericanOdds = 0 as AmericanOdds;

export interface DeskDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly path: string;
  readonly ticketId?: string | undefined;
  readonly message: string;
  readonly rawValue?: unknown;
}

export interface DeskCustomer {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
}

export interface DeskLimits {
  readonly max_stake: Cents;
  readonly currency: string;
  readonly hasValidMaxStake: boolean;
}

export interface DeskPositionLeg {
  readonly legIndex: number;
  readonly market: string;
  readonly side: string;
  readonly rawRotNum: number | null;
  readonly canonicalRotNum: number | null;
  readonly isAltSpreadRotation: boolean;
  readonly effectiveLineHundredths: LineHundredths | null;
}

export interface DeskPosition {
  readonly id: string;
  readonly market: string;
  readonly side: string;
  readonly stake: Cents;
  readonly price: AmericanOdds;
  readonly status: string;
  readonly day: Temporal.PlainDate | null;
  readonly hasCoercionError: boolean;
  readonly totalPicks?: number | undefined;
  readonly legs?: readonly DeskPositionLeg[] | undefined;
  readonly effectiveLineHundredths?: LineHundredths | null | undefined;
  readonly exposureBps?: BasisPoints | undefined;
  readonly settledCents?: SettledCents | undefined;
}

export interface CustomerDesk {
  readonly customer: DeskCustomer;
  readonly limits: DeskLimits;
  readonly positions: readonly DeskPosition[];
  readonly diagnostics: readonly DeskDiagnostic[];
}

export interface RiskEvaluation {
  readonly pendingAtMax: readonly DeskPosition[];
  readonly degradedPending: readonly DeskPosition[];
  readonly requiresArsenalAlert: boolean;
}

export interface ParseDeskStreamOptions {
  readonly compression?: DeskCompression | undefined;
  readonly xmlOptions?: { readonly compact?: boolean | undefined } | undefined;
}

type UnknownRecord = Record<string, unknown>;

const POSITION_SIGNAL_KEYS = new Set([
  "id",
  "@id",
  "market",
  "@market",
  "stake",
  "@stake",
  "price",
  "@price",
  "side",
  "@side",
]);

const ENVELOPE_WRAPPER_KEYS = [
  "desk",
  "root",
  "snapshot",
  "customer_desk",
] as const;

const DECIMAL_CENTS_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const SUBCENT_EXPONENT_RE = /^[+-]?\d+(?:\.\d+)?e-\d+$/i;
const INTEGER_ODDS_RE = /^([+-]?)(\d+)$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Converts a bounds-checked BigInt in [MIN_SAFE_INTEGER, MAX_SAFE_INTEGER]
 * into a JS number using integer digit accumulation (zero float coercion).
 */
function safeBigIntToInteger(value: bigint): number {
  if (value === 0n) return 0;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  let acc = 0;
  for (let i = 0; i < digits.length; i++) {
    acc = acc * 10 + (digits.charCodeAt(i) - 48);
  }
  return negative ? -acc : acc;
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    // signal-honesty: intentional-cyclic-diagnostic-fallback
    return Bun.inspect(value, { depth: 2 });
  }
}

function scalarToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return `${value}`;
  }
  return formatDiagnosticValue(value);
}

function omitKey(record: UnknownRecord, keyToOmit: string): UnknownRecord {
  const out: UnknownRecord = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== keyToOmit) {
      out[k] = v;
    }
  }
  return out;
}

function toArrayBufferBackedUint8Array(
  bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function isRecord(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Temporal.PlainDate) &&
    !(value instanceof Temporal.PlainDateTime) &&
    !(value instanceof Temporal.Instant)
  );
}

function normalizeXmlTreeNode(
  node: UnknownRecord,
  diagnostics?: DeskDiagnostic[],
  path = "root",
  ancestors: Set<object> = new Set(),
): UnknownRecord {
  if (ancestors.has(node)) {
    diagnostics?.push({
      code: "CYCLIC_DOCUMENT_REFERENCE",
      severity: "warning",
      path,
      message: `Cyclic reference detected at ${path}; breaking cycle.`,
    });
    return {};
  }

  if (
    typeof node.name !== "string" ||
    (!Array.isArray(node.children) && !isRecord(node.attributes))
  ) {
    return node;
  }

  ancestors.add(node);
  try {
    const out: UnknownRecord = {};
    if (isRecord(node.attributes)) {
      for (const [attrKey, attrVal] of Object.entries(node.attributes)) {
        out[`@${attrKey}`] = attrVal;
      }
    }
    if (Array.isArray(node.children)) {
      const textChunks: string[] = [];
      for (const child of node.children) {
        if (typeof child === "string") {
          if (child.trim().length > 0) textChunks.push(child);
        } else if (isRecord(child) && typeof child.name === "string") {
          const childName = child.name;
          const normalizedChild = normalizeXmlTreeNode(
            child,
            diagnostics,
            `${path}.${childName}`,
            ancestors,
          );
          const childKeys = Object.keys(normalizedChild);
          const collapsedValue =
            childKeys.length === 1 && childKeys[0] === "#text"
              ? normalizedChild["#text"]
              : normalizedChild;
          const existing = out[childName];
          if (existing === undefined) {
            out[childName] = collapsedValue;
          } else if (Array.isArray(existing)) {
            existing.push(collapsedValue);
          } else {
            out[childName] = [existing, collapsedValue];
          }
        }
      }
      if (textChunks.length > 0) {
        out["#text"] = textChunks.join("");
      }
    }
    return out;
  } finally {
    ancestors.delete(node);
  }
}

export function asRecords(
  value: unknown,
  diagnostics?: DeskDiagnostic[],
  path = "root",
): UnknownRecord[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    const out: UnknownRecord[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (isRecord(item)) {
        out.push(normalizeXmlTreeNode(item, diagnostics, `${path}[${index}]`));
      } else {
        diagnostics?.push({
          code: "NON_RECORD_ARRAY_ELEMENT",
          severity: "warning",
          path: `${path}[${index}]`,
          message: `Filtered non-record element at ${path}[${index}]`,
          rawValue: item,
        });
      }
    }
    return out;
  }
  if (isRecord(value)) {
    return [normalizeXmlTreeNode(value, diagnostics, path)];
  }
  diagnostics?.push({
    code: "NON_RECORD_ARRAY_ELEMENT",
    severity: "warning",
    path,
    message: `Expected record or array at ${path}`,
    rawValue: value,
  });
  return [];
}

function unwrapScalar(
  raw: unknown,
  diagnostics?: DeskDiagnostic[],
  path = "scalar",
): unknown {
  if (isRecord(raw)) {
    const normalized = normalizeXmlTreeNode(raw, diagnostics, path);
    if (normalized["#text"] !== undefined) {
      return normalized["#text"];
    }
  }
  return raw;
}

export function field(
  record: UnknownRecord,
  key: string,
  diagnostics?: DeskDiagnostic[],
  path = "record",
  ticketId?: string,
): unknown {
  const plainRaw = unwrapScalar(record[key], diagnostics, `${path}.${key}`);
  const attrRaw = unwrapScalar(
    record[`@${key}`],
    diagnostics,
    `${path}.@${key}`,
  );

  if (
    plainRaw !== undefined &&
    attrRaw !== undefined &&
    scalarToText(plainRaw).trim() !== scalarToText(attrRaw).trim()
  ) {
    diagnostics?.push({
      code: "FIELD_ATTRIBUTE_CHILD_CONFLICT",
      severity: "warning",
      path: `${path}.${key}`,
      ticketId,
      message: `Both '${key}' (${scalarToText(plainRaw)}) and '@${key}' (${scalarToText(attrRaw)}) exist with different values; using '${key}'`,
      rawValue: { [key]: plainRaw, [`@${key}`]: attrRaw },
    });
  }

  if (plainRaw !== undefined) return plainRaw;
  if (attrRaw !== undefined) return attrRaw;
  if (key === "side" && record["#text"] !== undefined) {
    return unwrapScalar(record["#text"], diagnostics, `${path}.#text`);
  }
  return undefined;
}

function isSinglePositionRecord(record: UnknownRecord): boolean {
  if ("position" in record || "positions" in record) return false;
  for (const key of Object.keys(record)) {
    if (POSITION_SIGNAL_KEYS.has(key)) return true;
  }
  return false;
}

export function collectPositions(
  root: unknown,
  diagnostics?: DeskDiagnostic[],
  path = "root",
): UnknownRecord[] {
  if (Array.isArray(root)) {
    return asRecords(root, diagnostics, path);
  }
  if (!isRecord(root)) return [];

  const normalizedRoot = normalizeXmlTreeNode(root, diagnostics, path);
  const collected: UnknownRecord[] = [];
  let containerSources = 0;

  if (normalizedRoot.positions !== undefined) {
    const posContainer = normalizedRoot.positions;
    if (Array.isArray(posContainer)) {
      collected.push(
        ...asRecords(posContainer, diagnostics, `${path}.positions`),
      );
      containerSources++;
    } else if (isRecord(posContainer)) {
      const normPosContainer = normalizeXmlTreeNode(
        posContainer,
        diagnostics,
        `${path}.positions`,
      );
      if (normPosContainer.position !== undefined) {
        collected.push(
          ...asRecords(
            normPosContainer.position,
            diagnostics,
            `${path}.positions.position`,
          ),
        );
        containerSources++;
      } else if (isSinglePositionRecord(normPosContainer)) {
        collected.push(normPosContainer);
        containerSources++;
      }
    }
  }

  if (normalizedRoot.position !== undefined) {
    collected.push(
      ...asRecords(normalizedRoot.position, diagnostics, `${path}.position`),
    );
    containerSources++;
  }

  if (containerSources > 1) {
    diagnostics?.push({
      code: "MIXED_POSITION_CONTAINERS",
      severity: "warning",
      path,
      message:
        "Both 'positions' and sibling 'position' containers were present; merged all positions in document order.",
    });
  }

  if (collected.length === 0 && isSinglePositionRecord(normalizedRoot)) {
    collected.push(normalizedRoot);
  }

  return collected;
}

/**
 * Parses a dollar-denominated string or finite number into integer Cents
 * using BigInt decimal string arithmetic (zero float multiplication).
 */
export function coerceCents(
  raw: unknown,
  fieldName: string,
  diagnostics: DeskDiagnostic[],
  path: string,
  ticketId?: string,
  options?: { readonly requirePositive?: boolean | undefined },
): { readonly value: Cents; readonly ok: boolean } {
  const pushErr = (code: DiagnosticCode, message: string) => {
    diagnostics.push({
      code,
      severity: "error",
      path: `${path}.${fieldName}`,
      ticketId,
      message,
      rawValue: raw,
    });
    return { value: ZERO_CENTS, ok: false } as const;
  };

  if (raw === undefined) {
    return pushErr(
      "MISSING_REQUIRED_FIELD",
      `Missing required currency field '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}`,
    );
  }

  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return pushErr(
        "COERCION_INVALID_CENTS",
        `Non-finite numeric value for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${String(raw)}`,
      );
    }
    text = raw.toString();
    if (SUBCENT_EXPONENT_RE.test(text)) {
      return pushErr(
        "COERCION_SUBCENT_PRECISION",
        `Sub-cent precision (>2 decimals) for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${text}`,
      );
    }
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else {
    return pushErr(
      "COERCION_INVALID_CENTS",
      `Invalid currency value for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${formatDiagnosticValue(raw)}`,
    );
  }

  const match = DECIMAL_CENTS_RE.exec(text);
  if (!match) {
    return pushErr(
      "COERCION_INVALID_CENTS",
      `Invalid decimal currency string for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${formatDiagnosticValue(raw)}`,
    );
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const wholePart = BigInt(match[2]!);
  const rawFrac = match[3] ?? "";

  if (rawFrac.length > 2) {
    return pushErr(
      "COERCION_SUBCENT_PRECISION",
      `Sub-cent precision (>2 decimals) for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${formatDiagnosticValue(raw)}`,
    );
  }

  const fracCents = BigInt(rawFrac.padEnd(2, "0"));
  const totalCents = sign * (wholePart * 100n + fracCents);

  if (totalCents < MIN_SAFE_BIGINT || totalCents > MAX_SAFE_BIGINT) {
    return pushErr(
      "COERCION_INVALID_CENTS",
      `Cents overflow for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${text}`,
    );
  }

  if (totalCents < 0n || (options?.requirePositive && totalCents <= 0n)) {
    return pushErr(
      "COERCION_INVALID_CENTS",
      `Expected ${options?.requirePositive ? "positive" : "non-negative"} amount for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${text}`,
    );
  }

  return { value: safeBigIntToInteger(totalCents) as Cents, ok: true };
}

/**
 * Parses American odds strictly as an integer (<= -100 or >= 100)
 * without float coercion.
 */
export function coerceAmericanOdds(
  raw: unknown,
  fieldName: string,
  diagnostics: DeskDiagnostic[],
  path: string,
  ticketId?: string,
): { readonly value: AmericanOdds; readonly ok: boolean } {
  const pushErr = (code: DiagnosticCode, message: string) => {
    diagnostics.push({
      code,
      severity: "error",
      path: `${path}.${fieldName}`,
      ticketId,
      message,
      rawValue: raw,
    });
    return { value: INVALID_AMERICAN_ODDS, ok: false } as const;
  };

  if (raw === undefined) {
    return pushErr(
      "MISSING_REQUIRED_FIELD",
      `Missing required odds field '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}`,
    );
  }

  let oddsBig: bigint;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) {
      return pushErr(
        "COERCION_INVALID_AMERICAN_ODDS",
        `American odds must be an integer for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${String(raw)}`,
      );
    }
    oddsBig = BigInt(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    const match = INTEGER_ODDS_RE.exec(trimmed);
    if (!match) {
      return pushErr(
        "COERCION_INVALID_AMERICAN_ODDS",
        `Invalid American odds string for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${formatDiagnosticValue(raw)}`,
      );
    }
    const sign = match[1] === "-" ? -1n : 1n;
    oddsBig = sign * BigInt(match[2]!);
  } else {
    return pushErr(
      "COERCION_INVALID_AMERICAN_ODDS",
      `Invalid American odds type for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${formatDiagnosticValue(raw)}`,
    );
  }

  if (
    oddsBig < -2147483648n ||
    oddsBig > 2147483647n ||
    (oddsBig > -100n && oddsBig < 100n)
  ) {
    return pushErr(
      "COERCION_INVALID_AMERICAN_ODDS",
      `American odds out of valid range (<= -100 or >= 100) for '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}: ${oddsBig.toString()}`,
    );
  }

  return { value: safeBigIntToInteger(oddsBig) as AmericanOdds, ok: true };
}

export function coercePlainDate(
  raw: unknown,
  fieldName: string,
  diagnostics: DeskDiagnostic[],
  path: string,
  ticketId?: string,
): { readonly value: Temporal.PlainDate | null; readonly ok: boolean } {
  if (raw instanceof Temporal.PlainDate) {
    return { value: raw, ok: true };
  }
  if (raw instanceof Temporal.PlainDateTime) {
    return { value: raw.toPlainDate(), ok: true };
  }
  if (raw instanceof Temporal.Instant) {
    return {
      value: raw.toZonedDateTimeISO("UTC").toPlainDate(),
      ok: true,
    };
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return {
      value: Temporal.PlainDate.from(raw.toISOString().slice(0, 10)),
      ok: true,
    };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const datePrefix = trimmed.includes("T")
        ? trimmed.slice(0, trimmed.indexOf("T"))
        : trimmed;
      try {
        return { value: Temporal.PlainDate.from(datePrefix), ok: true };
      } catch {
        // signal-honesty: intentional-invalid-date-coercion-diagnostic
      }
    }
  }

  diagnostics.push({
    code:
      raw === undefined ? "MISSING_REQUIRED_FIELD" : "COERCION_INVALID_DATE",
    severity: "error",
    path: `${path}.${fieldName}`,
    ticketId,
    message:
      raw === undefined
        ? `Missing required date field '${fieldName}'${ticketId ? ` on ticket ${ticketId}` : ""}`
        : `Ticket ${ticketId ?? "<unknown>"} had an invalid ${fieldName}: ${formatDiagnosticValue(raw)}`,
    rawValue: raw,
  });
  return { value: null, ok: false };
}

function unwrapEnvelope(
  doc: unknown,
  diagnostics?: DeskDiagnostic[],
  path = "root",
  seenWrappers: WeakSet<object> = new WeakSet(),
): UnknownRecord {
  if (!isRecord(doc)) return {};
  seenWrappers.add(doc);
  const norm = normalizeXmlTreeNode(doc, diagnostics, path);

  if (typeof doc.name === "string" && Array.isArray(doc.children)) {
    return norm;
  }

  for (const wrapperKey of ENVELOPE_WRAPPER_KEYS) {
    const rawInner = norm[wrapperKey];
    if (isRecord(rawInner)) {
      const nextPath = `${path}.${wrapperKey}`;
      if (seenWrappers.has(rawInner)) {
        diagnostics?.push({
          code: "CYCLIC_DOCUMENT_REFERENCE",
          severity: "warning",
          path: nextPath,
          message: `Cyclic wrapper alias '${wrapperKey}' detected at ${nextPath}; stopped unwrapping cycle.`,
        });
        return omitKey(norm, wrapperKey);
      }
      seenWrappers.add(rawInner);
      const inner = normalizeXmlTreeNode(rawInner, diagnostics, nextPath);
      const merged: UnknownRecord = { ...inner };
      for (const [k, v] of Object.entries(norm)) {
        if (k !== wrapperKey && !(k in merged)) {
          merged[k] = v;
        }
      }
      return unwrapEnvelope(merged, diagnostics, nextPath, seenWrappers);
    }
  }

  const keys = Object.keys(norm);
  if (keys.length === 1) {
    const singleKey = keys[0]!;
    const rawInner = norm[singleKey];
    if (
      !POSITION_SIGNAL_KEYS.has(singleKey) &&
      singleKey !== "positions" &&
      singleKey !== "position" &&
      isRecord(rawInner)
    ) {
      const nextPath = `${path}.${singleKey}`;
      if (seenWrappers.has(rawInner)) {
        diagnostics?.push({
          code: "CYCLIC_DOCUMENT_REFERENCE",
          severity: "warning",
          path: nextPath,
          message: `Cyclic wrapper alias '${singleKey}' detected at ${nextPath}; stopped unwrapping cycle.`,
        });
        return omitKey(norm, singleKey);
      }
      seenWrappers.add(rawInner);
      return unwrapEnvelope(rawInner, diagnostics, nextPath, seenWrappers);
    }
  }

  return norm;
}

function resolveCustomerAndLimits(
  root: UnknownRecord,
  diagnostics: DeskDiagnostic[],
): { readonly customer: DeskCustomer; readonly limits: DeskLimits } {
  const customerRecords = asRecords(
    root.customer,
    diagnostics,
    "root.customer",
  );
  const primaryCustomer: UnknownRecord = customerRecords[0] ?? root;

  const customerIdRaw =
    field(primaryCustomer, "id", diagnostics, "customer") ??
    field(root, "customer_id", diagnostics, "root") ??
    field(root, "id", diagnostics, "root");
  const customerNameRaw =
    field(primaryCustomer, "name", diagnostics, "customer") ??
    field(root, "customer_name", diagnostics, "root") ??
    field(root, "name", diagnostics, "root");
  const customerTierRaw =
    field(primaryCustomer, "tier", diagnostics, "customer") ??
    field(root, "tier", diagnostics, "root");

  const limitCandidates: UnknownRecord[] = [
    ...asRecords(root.limits, diagnostics, "root.limits"),
    ...asRecords(primaryCustomer.limits, diagnostics, "customer.limits"),
  ];

  if (limitCandidates.length > 1) {
    diagnostics.push({
      code: "MULTIPLE_LIMIT_BLOCKS",
      severity: "warning",
      path: "root.limits",
      message: `Found ${limitCandidates.length} limit blocks; selecting the most restrictive valid max_stake.`,
    });
  }

  const validMaxStakes: Cents[] = [];
  let resolvedCurrency: string | undefined;

  for (let i = 0; i < limitCandidates.length; i++) {
    const candidate = limitCandidates[i]!;
    const rawMax = field(candidate, "max_stake", diagnostics, `limits[${i}]`);
    if (rawMax !== undefined) {
      const coerced = coerceCents(
        rawMax,
        "max_stake",
        diagnostics,
        `limits[${i}]`,
        undefined,
        { requirePositive: true },
      );
      if (coerced.ok) {
        validMaxStakes.push(coerced.value);
      }
    }
    if (resolvedCurrency === undefined) {
      const cur = field(candidate, "currency", diagnostics, `limits[${i}]`);
      if (cur !== undefined && scalarToText(cur).trim().length > 0) {
        resolvedCurrency = scalarToText(cur).trim();
      }
    }
  }

  if (validMaxStakes.length === 0) {
    const fallbackMax =
      field(root, "max_stake", diagnostics, "root") ??
      field(primaryCustomer, "max_stake", diagnostics, "customer");
    if (fallbackMax !== undefined) {
      const coerced = coerceCents(
        fallbackMax,
        "max_stake",
        diagnostics,
        "root",
        undefined,
        { requirePositive: true },
      );
      if (coerced.ok) {
        validMaxStakes.push(coerced.value);
      }
    }
  }

  const hasValidMaxStake = validMaxStakes.length > 0;
  if (!hasValidMaxStake) {
    diagnostics.push({
      code: "MISSING_MAX_STAKE",
      severity: "error",
      path: "limits.max_stake",
      message:
        "No valid positive max_stake found in limits or wrapper attributes.",
    });
  }

  const maxStake: Cents = hasValidMaxStake
    ? (Math.min(...validMaxStakes) as Cents)
    : ZERO_CENTS;
  const currency =
    resolvedCurrency ??
    scalarToText(field(root, "currency", diagnostics, "root") ?? "USD").trim();

  return {
    customer: {
      id: customerIdRaw !== undefined ? scalarToText(customerIdRaw).trim() : "",
      name:
        customerNameRaw !== undefined
          ? scalarToText(customerNameRaw).trim()
          : "",
      tier:
        customerTierRaw !== undefined
          ? scalarToText(customerTierRaw).trim()
          : "",
    },
    limits: {
      max_stake: maxStake,
      currency: currency || "USD",
      hasValidMaxStake,
    },
  };
}

function normalizePositionRecord(
  record: UnknownRecord,
  index: number,
  diagnostics: DeskDiagnostic[],
): DeskPosition {
  const path = `positions[${index}]`;
  const rawId = field(record, "id", diagnostics, path);
  const ticketId =
    rawId !== undefined && scalarToText(rawId).trim().length > 0
      ? scalarToText(rawId).trim()
      : undefined;

  if (ticketId === undefined) {
    diagnostics.push({
      code: "MISSING_REQUIRED_FIELD",
      severity: "error",
      path: `${path}.id`,
      message: `Missing required field 'id' at ${path}`,
    });
  }

  const rawMarket = field(record, "market", diagnostics, path, ticketId);
  const market =
    rawMarket !== undefined && scalarToText(rawMarket).trim().length > 0
      ? scalarToText(rawMarket).trim()
      : "";
  if (market.length === 0) {
    diagnostics.push({
      code: "MISSING_REQUIRED_FIELD",
      severity: "error",
      path: `${path}.market`,
      ticketId,
      message: `Missing required field 'market'${ticketId ? ` on ticket ${ticketId}` : ""}`,
    });
  }

  const rawSide = field(record, "side", diagnostics, path, ticketId);
  const side =
    rawSide !== undefined && scalarToText(rawSide).trim().length > 0
      ? scalarToText(rawSide).trim()
      : "";
  if (side.length === 0) {
    diagnostics.push({
      code: "MISSING_REQUIRED_FIELD",
      severity: "error",
      path: `${path}.side`,
      ticketId,
      message: `Missing required field 'side'${ticketId ? ` on ticket ${ticketId}` : ""}`,
    });
  }

  const rawStake = field(record, "stake", diagnostics, path, ticketId);
  const stakeRes = coerceCents(rawStake, "stake", diagnostics, path, ticketId);

  const rawPrice = field(record, "price", diagnostics, path, ticketId);
  const priceRes = coerceAmericanOdds(
    rawPrice,
    "price",
    diagnostics,
    path,
    ticketId,
  );

  const rawStatus = field(record, "status", diagnostics, path, ticketId);
  let status = "pending";
  if (rawStatus !== undefined && scalarToText(rawStatus).trim().length > 0) {
    status = scalarToText(rawStatus).trim();
  } else {
    diagnostics.push({
      code: "DEFAULTED_STATUS",
      severity: "warning",
      path: `${path}.status`,
      ticketId,
      message: `Missing 'status'${ticketId ? ` on ticket ${ticketId}` : ""}; defaulted to 'pending'`,
    });
  }

  const rawDay =
    field(record, "day", diagnostics, path, ticketId) ??
    field(record, "date", diagnostics, path, ticketId);
  const dayRes = coercePlainDate(rawDay, "day", diagnostics, path, ticketId);

  const hasCoercionError =
    ticketId === undefined ||
    market.length === 0 ||
    side.length === 0 ||
    !stakeRes.ok ||
    !priceRes.ok ||
    !dayRes.ok;

  return {
    id: ticketId ?? "",
    market,
    side,
    stake: stakeRes.value,
    price: priceRes.value,
    status,
    day: dayRes.value,
    hasCoercionError,
  };
}

export function normalizeDesk(doc: unknown): CustomerDesk {
  const diagnostics: DeskDiagnostic[] = [];
  if (Array.isArray(doc)) {
    const rawPositions = collectPositions(doc, diagnostics, "root");
    const positions = rawPositions.map((rec, idx) =>
      normalizePositionRecord(rec, idx, diagnostics),
    );
    diagnostics.push({
      code: "MISSING_MAX_STAKE",
      severity: "error",
      path: "limits.max_stake",
      message: "Top-level position array has no customer or limits metadata.",
    });
    return {
      customer: { id: "", name: "", tier: "" },
      limits: {
        max_stake: ZERO_CENTS,
        currency: "USD",
        hasValidMaxStake: false,
      },
      positions,
      diagnostics,
    };
  }

  const root = unwrapEnvelope(doc, diagnostics, "root");
  const { customer, limits } = resolveCustomerAndLimits(root, diagnostics);
  const rawPositions = collectPositions(root, diagnostics, "root");
  const positions = rawPositions.map((rec, idx) =>
    normalizePositionRecord(rec, idx, diagnostics),
  );

  return {
    customer,
    limits,
    positions,
    diagnostics,
  };
}

function createJsonlDeskAccumulator(): {
  ingestRecord(parsed: unknown, recordIdx: number): void;
  finalize(): CustomerDesk;
} {
  const diagnostics: DeskDiagnostic[] = [];
  const mergedEnvelope: UnknownRecord = {};
  const positionRecords: UnknownRecord[] = [];
  const positionIndexById = new Map<string, number>();
  let recordCount = 0;

  const pushOrUpsertPosition = (rec: UnknownRecord): void => {
    const idVal = rec.id ?? rec["@id"];
    const key =
      idVal !== undefined && scalarToText(idVal).trim().length > 0
        ? scalarToText(idVal).trim()
        : undefined;
    if (key !== undefined && positionIndexById.has(key)) {
      positionRecords[positionIndexById.get(key)!] = rec;
    } else {
      if (key !== undefined) {
        positionIndexById.set(key, positionRecords.length);
      }
      positionRecords.push(rec);
    }
  };

  return {
    ingestRecord(parsed: unknown, recordIdx: number): void {
      recordCount++;
      const unwrapped = unwrapEnvelope(
        parsed,
        diagnostics,
        `jsonl[${recordIdx}]`,
      );
      const recordType =
        typeof unwrapped.type === "string" ? unwrapped.type.toLowerCase() : "";

      if (recordType === "activity" || recordType === "heartbeat") {
        return;
      }

      if (isRecord(unwrapped.customer)) {
        mergedEnvelope.customer = {
          ...(isRecord(mergedEnvelope.customer) ? mergedEnvelope.customer : {}),
          ...unwrapped.customer,
        };
      }
      if (unwrapped.limits !== undefined) {
        const existingLimits = asRecords(mergedEnvelope.limits);
        const nextLimits = asRecords(unwrapped.limits);
        mergedEnvelope.limits = [...existingLimits, ...nextLimits];
      }

      for (const metaKey of [
        "customer_id",
        "customer_name",
        "tier",
        "max_stake",
        "currency",
      ]) {
        if (unwrapped[metaKey] !== undefined) {
          mergedEnvelope[metaKey] = unwrapped[metaKey];
        }
      }

      const nestedPositions = collectPositions(
        unwrapped,
        diagnostics,
        `jsonl[${recordIdx}]`,
      );
      for (const pos of nestedPositions) {
        pushOrUpsertPosition(pos);
      }
    },
    finalize(): CustomerDesk {
      if (recordCount === 0) {
        diagnostics.push({
          code: "EMPTY_JSONL_STREAM",
          severity: "error",
          path: "jsonl",
          message: "JSONL input contained zero records.",
        });
        return {
          customer: { id: "", name: "", tier: "" },
          limits: {
            max_stake: ZERO_CENTS,
            currency: "USD",
            hasValidMaxStake: false,
          },
          positions: [],
          diagnostics,
        };
      }

      mergedEnvelope.positions = positionRecords;
      const desk = normalizeDesk(mergedEnvelope);
      return {
        ...desk,
        diagnostics: [...diagnostics, ...desk.diagnostics],
      };
    },
  };
}

function parseJsonlDesk(input: string): CustomerDesk {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const acc = createJsonlDeskAccumulator();
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    acc.ingestRecord(JSON.parse(lines[lineIdx]!), lineIdx);
  }
  return acc.finalize();
}

export function parseDesk(
  input: string,
  format: DeskFormat,
  xmlOptions?: { readonly compact?: boolean | undefined },
): CustomerDesk {
  switch (format) {
    case "toml":
      return normalizeDesk(Bun.TOML.parse(input));
    case "yaml":
      return normalizeDesk(Bun.YAML.parse(input));
    case "json":
      return normalizeDesk(JSON.parse(input));
    case "jsonl":
      return parseJsonlDesk(input);
    case "xml":
      return normalizeDesk(
        Bun.XML.parse(
          input,
          xmlOptions?.compact === false ? { compact: false } : undefined,
        ),
      );
  }
}

/**
 * Compresses a desk payload using Web-standard CompressionStream
 * (gzip, deflate, deflate-raw, plus Bun brotli and zstd extensions).
 */
export async function compressDeskPayload(
  input: string | Uint8Array,
  compression: DeskCompression,
): Promise<Uint8Array> {
  const encoded =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const compressedStream = new Blob([toArrayBufferBackedUint8Array(encoded)])
    .stream()
    .pipeThrough(new CompressionStream(compression));
  return new Response(compressedStream).bytes();
}

function toByteStream(
  source: Exclude<DeskStreamSource, ReadableStream<string>>,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  if (source instanceof ReadableStream) {
    return source as ReadableStream<Uint8Array<ArrayBuffer>>;
  }
  if (source instanceof Response || source instanceof Request) {
    return (
      (source.body as ReadableStream<Uint8Array<ArrayBuffer>> | null) ??
      new Blob([]).stream()
    );
  }
  if (source instanceof Blob) {
    return source.stream();
  }
  if (source instanceof ArrayBuffer) {
    return new Blob([source]).stream();
  }
  return new Blob([toArrayBufferBackedUint8Array(source)]).stream();
}

async function* iterateDecodedTextChunks(
  source: DeskStreamSource,
  compression?: DeskCompression,
): AsyncGenerator<string, void, undefined> {
  if (compression !== undefined) {
    const byteStream =
      source instanceof ReadableStream
        ? (source as ReadableStream<Uint8Array<ArrayBuffer>>)
        : toByteStream(source);
    const decompressed = byteStream.pipeThrough(
      new DecompressionStream(compression),
    );
    for await (const textChunk of new Response(decompressed).textStream()) {
      yield textChunk;
    }
    return;
  }

  if (source instanceof Response || source instanceof Request) {
    for await (const textChunk of source.textStream()) {
      yield textChunk;
    }
    return;
  }

  if (source instanceof Blob) {
    for await (const textChunk of new Response(source).textStream()) {
      yield textChunk;
    }
    return;
  }

  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    const body =
      source instanceof ArrayBuffer
        ? source
        : toArrayBufferBackedUint8Array(source);
    for await (const textChunk of new Response(body).textStream()) {
      yield textChunk;
    }
    return;
  }

  const reader = source.getReader();
  try {
    const first = await reader.read();
    if (first.done) {
      return;
    }
    if (typeof first.value === "string") {
      yield first.value;
      // One decoder for the whole stream: decoding each chunk separately loses a
      // multi-byte character split across chunk boundaries and allocates per chunk.
      const decoder = new TextDecoder();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (typeof next.value === "string") {
          const pending = decoder.decode();
          if (pending !== "") yield pending;
          yield next.value;
        } else {
          const text = decoder.decode(next.value, { stream: true });
          if (text !== "") yield text;
        }
      }
      const tail = decoder.decode();
      if (tail !== "") yield tail;
      return;
    }

    const firstBytes = toArrayBufferBackedUint8Array(first.value);
    const restByteStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(firstBytes);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        if (typeof next.value === "string") {
          controller.enqueue(
            toArrayBufferBackedUint8Array(new TextEncoder().encode(next.value)),
          );
        } else {
          controller.enqueue(toArrayBufferBackedUint8Array(next.value));
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    for await (const textChunk of new Response(restByteStream).textStream()) {
      yield textChunk;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Incrementally parses a streamed (optionally compressed) desk document
 * using DecompressionStream, Response.textStream(), and Bun.JSONL.parseChunk().
 */
export async function parseDeskStream(
  source: DeskStreamSource,
  format: DeskFormat,
  options?: ParseDeskStreamOptions,
): Promise<CustomerDesk> {
  if (format === "jsonl") {
    const acc = createJsonlDeskAccumulator();
    let remainder = "";
    let recordIdx = 0;

    for await (const chunk of iterateDecodedTextChunks(
      source,
      options?.compression,
    )) {
      remainder += chunk;
      const lastNewline = remainder.lastIndexOf("\n");
      if (lastNewline < 0) continue;

      const completeSlice = remainder.slice(0, lastNewline + 1);
      remainder = remainder.slice(lastNewline + 1);

      if (completeSlice.trim().length > 0) {
        const parsedChunk = Bun.JSONL.parseChunk(completeSlice);
        if (parsedChunk.error !== null) {
          throw parsedChunk.error;
        }
        for (const item of parsedChunk.values) {
          acc.ingestRecord(item, recordIdx++);
        }
      }
    }

    if (remainder.trim().length > 0) {
      const finalChunk = Bun.JSONL.parseChunk(remainder);
      if (finalChunk.error !== null) {
        throw finalChunk.error;
      }
      if (!finalChunk.done) {
        throw new SyntaxError(
          "desk-parser: truncated JSONL record at end of stream",
        );
      }
      for (const item of finalChunk.values) {
        acc.ingestRecord(item, recordIdx++);
      }
    }

    return acc.finalize();
  }

  const chunks: string[] = [];
  for await (const chunk of iterateDecodedTextChunks(
    source,
    options?.compression,
  )) {
    chunks.push(chunk);
  }
  return parseDesk(chunks.join(""), format, options?.xmlOptions);
}

function positionMentionsArsenal(pos: DeskPosition): boolean {
  if (pos.market.toLowerCase().includes("arsenal")) return true;
  return (
    pos.legs?.some(
      (leg) =>
        leg.market.toLowerCase().includes("arsenal") ||
        leg.side.toLowerCase().includes("arsenal"),
    ) === true
  );
}

export function evaluateDeskRisk(desk: CustomerDesk): RiskEvaluation {
  const pendingAtMax: DeskPosition[] = [];
  const degradedPending: DeskPosition[] = [];

  for (const pos of desk.positions) {
    if (pos.status !== "pending") continue;
    if (!desk.limits.hasValidMaxStake || pos.hasCoercionError) {
      degradedPending.push(pos);
      if (desk.limits.hasValidMaxStake && pos.stake >= desk.limits.max_stake) {
        pendingAtMax.push(pos);
      }
      continue;
    }
    if (pos.stake >= desk.limits.max_stake) {
      pendingAtMax.push(pos);
    }
  }

  const requiresArsenalAlert =
    pendingAtMax.some(positionMentionsArsenal) ||
    degradedPending.some(positionMentionsArsenal);

  return {
    pendingAtMax,
    degradedPending,
    requiresArsenalAlert,
  };
}

export function riskPendingAtMax(desk: CustomerDesk): DeskPosition[] {
  const { pendingAtMax, degradedPending } = evaluateDeskRisk(desk);
  const seen = new Set<DeskPosition>(pendingAtMax);
  const combined = [...pendingAtMax];
  for (const pos of degradedPending) {
    if (!seen.has(pos)) combined.push(pos);
  }
  return combined;
}

export type DeskRiskSourceKind = "live" | "capture" | "fixture" | "none";

export interface DeskRiskProvenance {
  readonly sourceKind: DeskRiskSourceKind;
  readonly dataWindowMaxEpochMs: EpochMs | null;
  readonly r2PublishedAtEpochMs: EpochMs | null;
}

export interface DeskRiskTelemetrySnapshot {
  readonly pendingAtMaxCount: number;
  readonly degradedPendingCount: number;
  readonly requiresArsenalAlert: boolean;
  readonly unresolvedGapCentsTotal: string;
  readonly provenance: DeskRiskProvenance;
  readonly updatedAt: string;
}

export interface DeskR2WriteClient {
  writeWithMetadata(
    key: string,
    data: Uint8Array | string,
    options?: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ): Promise<number>;
}

const DESK_IPV4_TEST_RE =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
const DESK_IPV6_COMPRESSED_TEST_RE =
  /(?:^|[\s[("'])((?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{0,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5}|::ffff:(?:\d{1,3}\.){3}\d{1,3}|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)(?=$|[\s\],"/%'])/i;
const DESK_IPV6_FULL_TEST_RE = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;

const DESK_FORBIDDEN_KEYS = new Set([
  "password",
  "namefirst",
  "login",
  "loginid",
  "ip",
  "ipaddress",
  "remoteaddr",
  "customerid",
  "rawvalue",
]);

function sha256Prefix12(value: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12);
}

export function tokenizeCustomerId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return "";
  return trimmed.startsWith("cust_")
    ? trimmed
    : `cust_${sha256Prefix12(trimmed)}`;
}

export function tokenizeTicketId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return "";
  return trimmed.startsWith("tkt_")
    ? trimmed
    : `tkt_${sha256Prefix12(trimmed)}`;
}

function hasDeskRawIpText(text: string): boolean {
  return (
    DESK_IPV4_TEST_RE.test(text) ||
    DESK_IPV6_COMPRESSED_TEST_RE.test(text) ||
    DESK_IPV6_FULL_TEST_RE.test(text)
  );
}

export function scrubDeskIpLiterals(text: string): string {
  return text
    .replace(
      /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
      "[REDACTED_IP]",
    )
    .replace(
      /(?:^|[\s[("'])((?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{0,4}:){1,6}:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5}|::ffff:(?:\d{1,3}\.){3}\d{1,3}|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)(?=$|[\s\],"/%'])/gi,
      " [REDACTED_IP]",
    )
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[REDACTED_IP]");
}

function sanitizeDeskPosition(pos: DeskPosition): DeskPosition {
  return {
    ...pos,
    id: tokenizeTicketId(pos.id),
  };
}

function sanitizeDeskDiagnostic(diag: DeskDiagnostic): DeskDiagnostic {
  const base: DeskDiagnostic = {
    code: diag.code,
    severity: diag.severity,
    path: diag.path,
    message: scrubDeskIpLiterals(diag.message),
    ...(diag.ticketId !== undefined
      ? { ticketId: tokenizeTicketId(diag.ticketId) }
      : {}),
  };
  return base;
}

/**
 * Strips/tokenizes PII (`customer.id`, `customer.name`, `ticketId`, `DeskPosition.id`,
 * `DeskDiagnostic.rawValue`, IPv4/IPv6 literals) prior to R2 writes or non-loopback HTTP responses.
 */
export function sanitizeCustomerDesk(desk: CustomerDesk): CustomerDesk {
  return {
    customer: {
      id: tokenizeCustomerId(desk.customer.id),
      name: desk.customer.name === "" ? "" : "[REDACTED]",
      tier: desk.customer.tier,
    },
    limits: desk.limits,
    positions: desk.positions.map(sanitizeDeskPosition),
    diagnostics: desk.diagnostics.map(sanitizeDeskDiagnostic),
  };
}

function validateDeskObjectTree(
  value: unknown,
  path: string,
  visited: Set<object>,
): void {
  if (typeof value === "string") {
    if (hasDeskRawIpText(value)) {
      throw new Error(`Desk payload PII gate failed: raw IP at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateDeskObjectTree(value[i], `${path}[${i}]`, visited);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (DESK_FORBIDDEN_KEYS.has(key.toLowerCase())) {
      if (key === "rawValue" && entry === undefined) continue;
      throw new Error(
        `Desk payload PII gate failed: forbidden field "${key}" at ${childPath}`,
      );
    }
    validateDeskObjectTree(entry, childPath, visited);
  }
}

function assertSanitizedDeskSection(desk: Record<string, unknown>): void {
  const customer = desk.customer;
  if (isRecord(customer)) {
    if (
      typeof customer.id === "string" &&
      customer.id !== "" &&
      !customer.id.startsWith("cust_")
    ) {
      throw new Error(
        "Desk payload PII gate failed: customer.id must be tokenized (cust_*)",
      );
    }
    if (
      typeof customer.name === "string" &&
      customer.name !== "" &&
      customer.name !== "[REDACTED]"
    ) {
      throw new Error(
        "Desk payload PII gate failed: customer.name must be redacted",
      );
    }
  }
  if (Array.isArray(desk.positions)) {
    for (const pos of desk.positions) {
      if (
        isRecord(pos) &&
        typeof pos.id === "string" &&
        pos.id !== "" &&
        !pos.id.startsWith("tkt_")
      ) {
        throw new Error(
          "Desk payload PII gate failed: position.id must be tokenized (tkt_*)",
        );
      }
    }
  }
  if (Array.isArray(desk.diagnostics)) {
    for (const diag of desk.diagnostics) {
      if (!isRecord(diag)) continue;
      if (diag.rawValue !== undefined) {
        throw new Error(
          "Desk payload PII gate failed: diagnostic.rawValue must be omitted",
        );
      }
      if (
        typeof diag.ticketId === "string" &&
        diag.ticketId !== "" &&
        !diag.ticketId.startsWith("tkt_")
      ) {
        throw new Error(
          "Desk payload PII gate failed: diagnostic.ticketId must be tokenized (tkt_*)",
        );
      }
    }
  }
}

/** Verifies zero PII, redacted customer fields, tokenized ids, and zero raw IPv4/IPv6 strings before R2/remote serialization. */
export function assertSanitizedDeskPayload(payload: unknown): Uint8Array {
  validateDeskObjectTree(payload, "$", new Set());
  if (isRecord(payload)) {
    const deskSection = isRecord(payload.desk) ? payload.desk : payload;
    assertSanitizedDeskSection(deskSection);
    if (isRecord(payload.risk)) {
      for (const bucket of [
        payload.risk.pendingAtMax,
        payload.risk.degradedPending,
      ]) {
        if (!Array.isArray(bucket)) continue;
        for (const pos of bucket) {
          if (
            isRecord(pos) &&
            typeof pos.id === "string" &&
            pos.id !== "" &&
            !pos.id.startsWith("tkt_")
          ) {
            throw new Error(
              "Desk payload PII gate failed: risk position.id must be tokenized (tkt_*)",
            );
          }
        }
      }
    }
  }
  return new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`);
}

export function formatDeskForPeer(
  desk: CustomerDesk,
  isTrustedLoopback: boolean,
): CustomerDesk {
  return isTrustedLoopback ? desk : sanitizeCustomerDesk(desk);
}

export async function publishDeskRiskSnapshotToR2(options: {
  readonly client: DeskR2WriteClient;
  readonly key: string;
  readonly desk: CustomerDesk;
  readonly risk: RiskEvaluation;
  readonly provenance: DeskRiskProvenance;
}): Promise<number> {
  const sanitizedDesk = sanitizeCustomerDesk(options.desk);
  const sanitizedRisk: RiskEvaluation = {
    pendingAtMax: options.risk.pendingAtMax.map(sanitizeDeskPosition),
    degradedPending: options.risk.degradedPending.map(sanitizeDeskPosition),
    requiresArsenalAlert: options.risk.requiresArsenalAlert,
  };
  const payload = {
    schemaVersion: 1,
    kind: "desk-risk-snapshot",
    desk: sanitizedDesk,
    risk: sanitizedRisk,
    provenance: options.provenance,
    data_window_max_epoch_ms: options.provenance.dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: options.provenance.r2PublishedAtEpochMs,
  };
  const body = assertSanitizedDeskPayload(payload);
  return options.client.writeWithMetadata(options.key, body, {
    type: "application/json",
    metadata: {
      pii: "none",
      "schema-version": "1",
      "source-kind": options.provenance.sourceKind,
      ...(options.provenance.dataWindowMaxEpochMs !== null
        ? {
            "data-window-max-epoch-ms": String(
              options.provenance.dataWindowMaxEpochMs,
            ),
          }
        : {}),
      ...(options.provenance.r2PublishedAtEpochMs !== null
        ? {
            "r2-published-at-epoch-ms": String(
              options.provenance.r2PublishedAtEpochMs,
            ),
          }
        : {}),
    },
  });
}

let latestDeskRiskTelemetry: DeskRiskTelemetrySnapshot | null = null;

export function getLatestDeskRiskTelemetry(): DeskRiskTelemetrySnapshot | null {
  return latestDeskRiskTelemetry;
}

export function resetDeskRiskTelemetryForTests(): void {
  latestDeskRiskTelemetry = null;
}

/**
 * Evaluates desk risk, stores latest signal-honesty telemetry (for `/health` and `/api/kpis`),
 * and emits `pendingAtMaxCount` + `degradedPendingCount` + provenance to `lib/audit_log.ts`.
 */
export function recordDeskRiskEvaluation(
  desk: CustomerDesk,
  provenance: DeskRiskProvenance,
  unresolvedGapCentsTotal: bigint = 0n,
): {
  readonly evaluation: RiskEvaluation;
  readonly telemetry: DeskRiskTelemetrySnapshot;
} {
  const evaluation = evaluateDeskRisk(desk);
  const updatedAt = new Date().toISOString();
  const telemetry: DeskRiskTelemetrySnapshot = {
    pendingAtMaxCount: evaluation.pendingAtMax.length,
    degradedPendingCount: evaluation.degradedPending.length,
    requiresArsenalAlert: evaluation.requiresArsenalAlert,
    unresolvedGapCentsTotal: unresolvedGapCentsTotal.toString(),
    provenance,
    updatedAt,
  };
  latestDeskRiskTelemetry = telemetry;
  try {
    writeAuditEntry({
      ts: updatedAt,
      category: "wager",
      action: "desk_risk_evaluated",
      success: true,
      target: "desk-risk",
      details: {
        pendingAtMaxCount: telemetry.pendingAtMaxCount,
        degradedPendingCount: telemetry.degradedPendingCount,
        requiresArsenalAlert: telemetry.requiresArsenalAlert,
        unresolvedGapCentsTotal: telemetry.unresolvedGapCentsTotal,
        sourceKind: provenance.sourceKind,
        dataWindowMaxEpochMs: provenance.dataWindowMaxEpochMs,
        r2PublishedAtEpochMs: provenance.r2PublishedAtEpochMs,
      },
    });
  } catch {
    // signal-honesty: intentional-audit-fs-isolation
  }
  return { evaluation, telemetry };
}
