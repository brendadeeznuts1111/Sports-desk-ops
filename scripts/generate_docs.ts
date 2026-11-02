#!/usr/bin/env bun
/**
 * generate_docs.ts — deterministic markdown renderer for the SportsDesk/Fantasy402 API docs.
 *
 * Inputs (required, resolved from the worktree root = process.cwd()):
 *   docs/openapi.json            OpenAPI 3.1 spec with per-operation x-evidence
 *   docs/evidence/ledger.json    evidence ledger (source of truth for tiers/sources/captures)
 *   docs/EVIDENCE.md             evidence standard; its "Limitations" blockquote is quoted verbatim
 *
 * Output:
 *   docs/api-reference.md        unless `--out <path>` is given
 *
 * The output is a pure function of those three files: no timestamps, no network, no randomness.
 * `bun run scripts/generate_docs.ts` twice must produce byte-identical markdown.
 *
 * Self-checks run before the file is written; any failure exits 1 and writes nothing:
 *   - no `undefined` / `[object Object]` renderer output
 *   - every spec path appears in the markdown
 *   - every spec operation has an evidence badge line (tier + sources + capture status)
 *   - appendix rows == ledger tier C rows, and every spec operation appears in the endpoint reference
 *   - tier parity between spec x-evidence and the ledger row (when the ledger has a row)
 *   - no fabricating GS route/gateway literals leak into the docs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { renderGSLiveDocsMarkdown } from "../lib/gslive_api_docs.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type Tier = "A" | "B" | "C" | "D" | "E";

interface Evidence {
  readonly tier: Tier;
  readonly sources: readonly string[];
  readonly capturedResponse: boolean;
  readonly requiredCapture?: string;
  readonly contradicted: boolean;
  readonly contradictionReason?: string;
  readonly candidateUrl: boolean;
  readonly fromSpec: boolean;
}

interface LedgerEvidence {
  readonly source: string;
  readonly kind: string;
  readonly note: string;
}

interface LedgerOperation {
  readonly path: string;
  readonly method: string;
  readonly operationId: string | null;
  readonly tag: string;
  readonly tier: Tier;
  readonly capturedResponse: boolean;
  readonly evidence: readonly LedgerEvidence[];
  readonly requiredCapture: string;
  readonly contradicted: boolean;
  readonly contradictedReason: string | null;
  readonly candidateUrl: boolean;
  readonly uiObserved: boolean;
}

interface LedgerSurface {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly category: string;
  readonly missingFromSpec: boolean;
  readonly what: string;
  readonly members: readonly string[];
  readonly note: string;
}

interface Ledger {
  readonly counts: Record<string, number>;
  readonly surfaceCounts: Record<string, number>;
  readonly tierRules: Record<string, string>;
  readonly operations: readonly LedgerOperation[];
  readonly surfaces: readonly LedgerSurface[];
}

interface SpecOperation {
  readonly path: string;
  readonly method: string;
  readonly operation: Record<string, unknown>;
  readonly pathItem: Record<string, unknown>;
}

interface RenderContext {
  readonly spec: Record<string, unknown>;
  readonly ledger: Ledger;
  readonly evidenceMd: string;
  readonly operations: readonly SpecOperation[];
  readonly evidence: ReadonlyMap<string, Evidence>;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

const TIER_ORDER: readonly Tier[] = ["A", "B", "C", "D", "E"];

/** Fragments that must never be re-published as if they were contracts. */
const FABRICATED_FRAGMENTS: readonly [RegExp, string][] = [
  [/\/manager-tools\/ajax\.php/gi, "the removed fabricated GS route"],
  [/manager-tools\/ajax\.php/gi, "the removed fabricated GS route"],
  [/ajax\.php/gi, "the removed fabricated GS route"],
  // The GSLive host is a real operator console and is now published as a deep link target;
  // only the fabricated ajax.php route is scrubbed.
];

const KIND_LABELS: Readonly<Record<string, string>> = {
  "capture-request": "a capture request, not a capture",
  "capture-scope": "a capture-scope note",
  context: "runbook context only",
  contradiction: "contradicting evidence only",
  "crawler-behaviour": "crawler behaviour, not a wire observation",
  fixture: "a committed fixture, not a wire capture",
  generator: "generator-authored",
  implementation: "implementation code only",
  "implementation-context": "implementation context only",
  "observed-request": "an observed request payload only",
  "repo-type": "a repo TypeScript type only",
  "spec-claim": "the spec's own claim",
  "ui-declaration": "a hand-authored UI/DOM declaration",
  "ui-observation": "a UI/DOM observation only",
  none: "no artifact",
};

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeAngles(value: string): string {
  // Only "&" and "<" need escaping: "<" could start an HTML tag. A mid-line ">"
  // is harmless markdown and mangling "->" would hurt readability.
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Plain inline text; never the string "undefined". */
function text(value: unknown, fallback = "—"): string {
  if (typeof value === "string") return collapse(value) || fallback;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return fallback;
}

function mdText(value: unknown, fallback = "—"): string {
  return escapeAngles(text(value, fallback));
}

function cell(value: unknown, fallback = "—"): string {
  return mdText(value, fallback).replace(/\|/g, "\\|");
}

function code(value: unknown, fallback = "—"): string {
  const raw = text(value, fallback).replace(/`/g, "'");
  return "`" + raw + "`";
}

function tableCellCode(value: unknown, fallback = "—"): string {
  return code(value, fallback).replace(/\|/g, "\\|");
}

function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines: string[] = [];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");
  for (const row of rows) {
    lines.push("| " + row.join(" | ") + " |");
  }
  return lines.join("\n");
}

function sanitizeFabricated(textValue: string): string {
  let result = textValue;
  for (const [pattern, replacement] of FABRICATED_FRAGMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function tierCount(tiers: readonly Tier[], tier: Tier): number {
  return tiers.filter((candidate) => candidate === tier).length;
}

/* -------------------------------------------------------------------------- */
/* JSON loading                                                               */
/* -------------------------------------------------------------------------- */

function loadJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(
      `generate_docs: missing required input ${path} (run from the worktree root)`,
    );
  }
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `generate_docs: ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

function loadLedger(path: string): Ledger {
  const parsed = asRecord(loadJson(path));
  if (parsed === undefined)
    throw new Error(`generate_docs: ${path} must be a JSON object`);

  const operations: LedgerOperation[] = [];
  for (const entry of asArray(parsed.operations)) {
    const row = asRecord(entry);
    if (row === undefined) continue;
    const pathValue = asString(row.path);
    const methodValue = asString(row.method);
    const tierValue = asString(row.tier);
    if (
      pathValue === undefined ||
      methodValue === undefined ||
      tierValue === undefined
    )
      continue;
    if (!isTier(tierValue)) {
      throw new Error(
        `generate_docs: ledger operation ${methodValue} ${pathValue} has invalid tier ${tierValue}`,
      );
    }
    const evidence: LedgerEvidence[] = [];
    for (const rawEvidence of asArray(row.evidence)) {
      const record = asRecord(rawEvidence);
      if (record === undefined) continue;
      evidence.push({
        source: asString(record.source) ?? "none",
        kind: asString(record.kind) ?? "none",
        note: asString(record.note) ?? "",
      });
    }
    operations.push({
      path: pathValue,
      method: methodValue.toLowerCase(),
      operationId: asString(row.operationId) ?? null,
      tag: asString(row.tag) ?? "",
      tier: tierValue,
      capturedResponse: row.capturedResponse === true,
      evidence,
      requiredCapture: asString(row.requiredCapture) ?? "",
      contradicted: row.contradicted === true,
      contradictedReason: asString(row.contradictedReason) ?? null,
      candidateUrl: row.candidate_url === true,
      uiObserved: row.ui_observed === true,
    });
  }

  const surfaces: LedgerSurface[] = [];
  for (const entry of asArray(parsed.surfaces)) {
    const row = asRecord(entry);
    if (row === undefined) continue;
    const id = asString(row.id);
    if (id === undefined) continue;
    surfaces.push({
      id,
      name: asString(row.name) ?? id,
      tier: asString(row.tier) ?? "D",
      category: asString(row.category) ?? "unknown",
      missingFromSpec: row.missingFromSpec === true,
      what: asString(row.what) ?? "",
      members: asArray(row.members).filter(
        (member): member is string => typeof member === "string",
      ),
      note: asString(row.note) ?? "",
    });
  }

  return {
    counts: numericRecord(parsed.counts),
    surfaceCounts: numericRecord(parsed.surfaceCounts),
    tierRules: stringRecord(parsed.tierRules),
    operations,
    surfaces,
  };
}

function numericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const result: Record<string, number> = {};
  if (record === undefined) return result;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "number") result[key] = entry;
  }
  return result;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const result: Record<string, string> = {};
  if (record === undefined) return result;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function isTier(value: string): value is Tier {
  return (TIER_ORDER as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* $ref resolution                                                            */
/* -------------------------------------------------------------------------- */

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveRef(spec: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(
      `generate_docs: unsupported $ref "${ref}" (only local #/ references are resolved)`,
    );
  }
  let cursor: unknown = spec;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    const record = asRecord(cursor);
    if (record === undefined) {
      throw new Error(
        `generate_docs: cannot resolve $ref "${ref}" at segment "${segment}"`,
      );
    }
    cursor = record[segment];
    if (cursor === undefined) {
      throw new Error(
        `generate_docs: unresolved $ref "${ref}" (missing segment "${segment}")`,
      );
    }
  }
  return cursor;
}

function deref(
  spec: Record<string, unknown>,
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 12)
    throw new Error("generate_docs: $ref resolution exceeded depth limit");
  const record = asRecord(value);
  if (record === undefined) return value;
  const ref = asString(record.$ref);
  if (ref === undefined) return record;
  return deref(spec, resolveRef(spec, ref), depth + 1);
}

function schemaType(
  spec: Record<string, unknown>,
  value: unknown,
  depth = 0,
): string {
  if (depth > 6) return "…";
  const schema = asRecord(deref(spec, value));
  if (schema === undefined) return "unknown";
  const type = schema.type;
  let result: string;
  if (Array.isArray(type)) {
    result = type
      .filter((entry): entry is string => typeof entry === "string")
      .join(" | ");
  } else if (typeof type === "string") {
    result = type;
  } else if (isRecord(schema.properties)) {
    result = "object";
  } else if (schema.items !== undefined) {
    result = "array";
  } else if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    result = "union";
  } else {
    result = "object";
  }
  if (schema.format !== undefined && typeof schema.format === "string") {
    result += ` (${schema.format})`;
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum
      .filter((entry): entry is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof entry),
      )
      .map((entry) => String(entry));
    if (values.length > 0) result += ` — one of: ${values.join(", ")}`;
  }
  if (schema.items !== undefined && depth < 3) {
    result += ` of ${schemaType(spec, schema.items, depth + 1)}`;
  }
  return result;
}

interface ResolvedParameter {
  readonly name: string;
  readonly location: string;
  readonly required: boolean;
  readonly description: string;
  readonly schema: Record<string, unknown>;
}

function resolveParameter(
  spec: Record<string, unknown>,
  value: unknown,
): ResolvedParameter {
  const parameter = asRecord(deref(spec, value));
  if (parameter === undefined)
    throw new Error("generate_docs: parameter is not an object");
  const name = asString(parameter.name);
  const location = asString(parameter.in);
  if (name === undefined || location === undefined) {
    throw new Error(
      `generate_docs: parameter is missing "name"/"in" after $ref resolution (${
        asString(asRecord(value)?.$ref) ?? "inline"
      })`,
    );
  }
  return {
    name,
    location,
    required: parameter.required === true,
    description: asString(parameter.description) ?? "",
    schema: asRecord(deref(spec, parameter.schema)) ?? {},
  };
}

function parametersFor(
  spec: Record<string, unknown>,
  operation: SpecOperation,
): ResolvedParameter[] {
  const collected = new Map<string, ResolvedParameter>();
  const sources = [
    asArray(operation.pathItem.parameters),
    asArray(operation.operation.parameters),
  ];
  for (const source of sources) {
    for (const raw of source) {
      const resolved = resolveParameter(spec, raw);
      collected.set(`${resolved.location}:${resolved.name}`, resolved);
    }
  }
  return [...collected.values()];
}

interface RequestContent {
  readonly contentType: string;
  readonly schema: Record<string, unknown>;
}

function requestBodies(
  spec: Record<string, unknown>,
  operation: SpecOperation,
): RequestContent[] {
  const raw = operation.operation.requestBody;
  if (raw === undefined) return [];
  const requestBody = asRecord(deref(spec, raw));
  if (requestBody === undefined) return [];
  const content = asRecord(requestBody.content);
  if (content === undefined) return [];
  const result: RequestContent[] = [];
  for (const [contentType, media] of Object.entries(content)) {
    const mediaRecord = asRecord(media);
    const schema = asRecord(deref(spec, mediaRecord?.schema)) ?? {};
    result.push({ contentType, schema });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

function keyOf(path: string, method: string): string {
  return `${method.toLowerCase()} ${path}`;
}

function isKnownTier(value: string): value is Tier {
  return isTier(value);
}

function specEvidenceOf(
  operation: SpecOperation,
  ledgerRow: LedgerOperation | undefined,
): Evidence {
  const raw = asRecord(operation.operation["x-evidence"]);
  let tier: Tier | undefined;
  let sources: string[] = [];
  let capturedResponse: boolean | undefined;
  let requiredCapture: string | undefined;
  let contradicted = ledgerRow?.contradicted ?? false;
  let contradictionReason = ledgerRow?.contradictedReason ?? undefined;
  let candidateUrl = ledgerRow?.candidateUrl ?? false;

  if (raw !== undefined) {
    const tierValue = asString(raw.tier);
    if (tierValue === undefined || !isKnownTier(tierValue)) {
      throw new Error(
        `generate_docs: ${operation.method.toUpperCase()} ${operation.path} has invalid x-evidence.tier`,
      );
    }
    tier = tierValue;
    sources = asArray(raw.sources)
      .filter((entry): entry is string => typeof entry === "string")
      .map(collapse);
    capturedResponse = raw.capturedResponse === true;
    requiredCapture = asString(raw.requiredCapture);
    if (raw.contradicted === true) contradicted = true;
    if (raw.candidateUrl === true || raw.candidate_url === true)
      candidateUrl = true;
    if (asString(raw.contradictedReason) !== undefined) {
      contradictionReason = asString(raw.contradictedReason);
    }
  }

  if (tier === undefined) {
    // Phase A fallback: a spec without x-evidence still renders from the ledger.
    if (ledgerRow === undefined) {
      throw new Error(
        `generate_docs: ${operation.method.toUpperCase()} ${operation.path} has no x-evidence and no ledger row`,
      );
    }
    tier = ledgerRow.tier;
    sources = ledgerRow.evidence.map((entry) => collapse(entry.source));
    capturedResponse = ledgerRow.capturedResponse;
    requiredCapture =
      ledgerRow.requiredCapture === "" ? undefined : ledgerRow.requiredCapture;
  }

  if (tier === undefined || capturedResponse === undefined) {
    throw new Error(
      `generate_docs: could not determine evidence for ${operation.method} ${operation.path}`,
    );
  }

  if (ledgerRow !== undefined && ledgerRow.tier !== tier) {
    throw new Error(
      `generate_docs: tier mismatch for ${operation.method.toUpperCase()} ${operation.path}: ` +
        `x-evidence says ${tier}, ledger says ${ledgerRow.tier}`,
    );
  }

  const ledgerRequiredCapture = ledgerRow?.requiredCapture;
  const finalRequiredCapture =
    requiredCapture !== undefined && requiredCapture !== ""
      ? requiredCapture
      : ledgerRequiredCapture !== undefined && ledgerRequiredCapture !== ""
        ? ledgerRequiredCapture
        : undefined;

  return {
    tier,
    sources: sources.length > 0 ? sources : ["none"],
    capturedResponse,
    // exactOptionalPropertyTypes: omit optional props instead of assigning undefined.
    ...(finalRequiredCapture === undefined
      ? {}
      : { requiredCapture: finalRequiredCapture }),
    contradicted,
    ...(contradictionReason === undefined ? {} : { contradictionReason }),
    candidateUrl,
    fromSpec: raw !== undefined,
  };
}

function evidenceBadge(evidence: Evidence): string {
  const usableSources = [
    ...new Set(
      evidence.sources.filter(
        (source) =>
          source.trim() !== "none" &&
          !/^docs\/openapi\.json/i.test(source.trim()),
      ),
    ),
  ];
  const sources =
    usableSources.length === 0
      ? "none — authored only"
      : usableSources.map((source) => code(source)).join(", ");
  const capture = evidence.capturedResponse
    ? "response captured"
    : "response not captured";
  const flags: string[] = [
    `**Evidence — tier ${evidence.tier}**`,
    `sources: ${sources}`,
    capture,
  ];
  if (evidence.contradicted)
    flags.push("**contradicted by a concrete artifact**");
  if (evidence.candidateUrl)
    flags.push("candidate URL+method (not observed on the wire)");
  return "> " + flags.join(" · ");
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

const KNOWN_HEADER_NAMES: Readonly<Record<string, string>> = {
  CSPHeader: "Content-Security-Policy",
  XContentTypeOptionsHeader: "X-Content-Type-Options",
  ReferrerPolicyHeader: "Referrer-Policy",
};

function headerDisplayName(componentKey: string, description: string): string {
  const known = KNOWN_HEADER_NAMES[componentKey];
  if (known !== undefined) return known;
  const colon = description.indexOf(":");
  if (colon > 0) {
    const prefix = description.slice(0, colon).trim();
    if (/^[A-Za-z0-9-]+$/.test(prefix)) return prefix;
  }
  return componentKey;
}

function headerValue(
  schema: Record<string, unknown>,
  description: string,
  spec?: Record<string, unknown>,
): string {
  const fromExample = exampleValue(schema, spec);
  if (fromExample !== "—") return fromExample;
  const colon = description.indexOf(":");
  if (colon > 0) {
    const raw = description
      .slice(colon + 1)
      .replace(/[\s.]*\([^()]*\)[\s.]*$/u, "")
      .trim();
    if (raw !== "") return code(raw);
  }
  return "—";
}

function renderParameters(
  spec: Record<string, unknown>,
  parameters: readonly ResolvedParameter[],
): string[] {
  if (parameters.length === 0) return [];
  const lines: string[] = ["**Parameters**", ""];
  const rows: string[][] = [];
  for (const parameter of parameters) {
    rows.push([
      tableCellCode(parameter.name),
      cell(parameter.location),
      parameter.required ? "yes" : "no",
      cell(schemaType(spec, parameter.schema)),
      cell(parameter.description),
    ]);
  }
  lines.push(
    markdownTable(["Name", "In", "Required", "Type", "Description"], rows),
  );
  return lines;
}

function schemaTypeSafe(schema: Record<string, unknown>): string {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    return (
      type
        .filter((entry): entry is string => typeof entry === "string")
        .join(" | ") || "object"
    );
  }
  if (isRecord(schema.properties)) return "object";
  return "object";
}

function renderRequestBodies(
  context: RenderContext,
  operation: SpecOperation,
  evidence: Evidence,
): string[] {
  const bodies = requestBodies(context.spec, operation);
  const discovery = asArray(operation.operation["x-extracted-inputs"]).filter(
    (entry): entry is string => typeof entry === "string",
  );
  const languageKeys = asArray(
    operation.operation["x-data-language-keys"],
  ).filter((entry): entry is string => typeof entry === "string");
  const lines: string[] = [];

  if (discovery.length > 0) {
    lines.push(
      "**Extracted DOM inputs (UI observation — not wire parameters):** " +
        discovery.map((entry) => code(entry)).join(", ") +
        ". These are DOM form-field names from a launcher tile, not a request schema.",
    );
    lines.push("");
  }
  if (languageKeys.length > 0) {
    lines.push(
      "**Observed DOM localization keys (not wire fields):** " +
        languageKeys.map((entry) => code(entry)).join(", ") +
        ".",
    );
    lines.push("");
  }

  for (const body of bodies) {
    lines.push(`**Request body — ${code(body.contentType)}**`, "");
    const properties = asRecord(body.schema.properties);
    if (evidence.tier === "C") {
      const fieldNames =
        properties === undefined ? [] : Object.keys(properties);
      lines.push(
        fieldNames.length > 0
          ? "Declared fields, **authored only** (tier C — no request was observed): " +
              fieldNames.map((field) => code(field)).join(", ") +
              "."
          : "No wire request schema is claimed for this tier C operation.",
      );
      lines.push("");
      continue;
    }
    if (properties === undefined) {
      lines.push(
        schemaType(context.spec, body.schema) === "array"
          ? "Body is a JSON array."
          : "No declared fields.",
      );
      lines.push("");
      continue;
    }
    const required = asArray(body.schema.required).filter(
      (entry): entry is string => typeof entry === "string",
    );
    const rows: string[][] = [];
    for (const [field, rawSchema] of Object.entries(properties)) {
      const resolved = asRecord(deref(context.spec, rawSchema)) ?? {};
      rows.push([
        tableCellCode(field),
        cell(schemaType(context.spec, resolved)),
        required.includes(field) ? "yes" : "no",
        cell(asString(resolved.description)),
        cell(exampleValue(resolved, context.spec)),
      ]);
    }
    lines.push(
      markdownTable(
        ["Field", "Type", "Required", "Description", "Example"],
        rows,
      ),
    );
    lines.push("");
  }
  return lines;
}

function exampleValue(
  schema: Record<string, unknown>,
  spec?: Record<string, unknown>,
): string {
  const example = schema.example;
  if (
    typeof example === "string" ||
    typeof example === "number" ||
    typeof example === "boolean"
  ) {
    return code(String(example));
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum
      .filter((entry): entry is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof entry),
      )
      .map((entry) => String(entry));
    if (values.length > 0) return values.map((entry) => code(entry)).join(", ");
  }
  if (schema.items !== undefined && spec !== undefined) {
    const itemExample = asRecord(deref(spec, schema.items))?.example;
    if (
      typeof itemExample === "string" ||
      typeof itemExample === "number" ||
      typeof itemExample === "boolean"
    ) {
      return code(String(itemExample));
    }
  }
  return "—";
}

function renderResponses(
  context: RenderContext,
  operation: SpecOperation,
  evidence: Evidence,
): string[] {
  const responses = asRecord(operation.operation.responses);
  if (responses === undefined) return [];
  const lines: string[] = ["**Responses**", ""];
  for (const [status, rawResponse] of Object.entries(responses)) {
    const response = asRecord(deref(context.spec, rawResponse));
    if (response === undefined) continue;
    const description = collapse(
      mdText(asString(response.description), "no description declared"),
    );
    const withPeriod = /[.!?]$/.test(description)
      ? description
      : description + ".";
    const statusLabel =
      status === "default"
        ? "Default response (status code not captured)"
        : `HTTP ${mdText(status)}`;
    lines.push(`- **${statusLabel}** — ${withPeriod}`);
    const responseHeaders = asRecord(response.headers);
    if (responseHeaders !== undefined) {
      for (const [headerKey, rawHeader] of Object.entries(responseHeaders)) {
        const header = asRecord(deref(context.spec, rawHeader));
        const headerSchema = asRecord(header?.schema);
        const headerDescription = asString(header?.description) ?? "";
        const displayName = headerDisplayName(headerKey, headerDescription);
        const value = headerValue(
          headerSchema ?? {},
          headerDescription,
          context.spec,
        );
        lines.push(
          `  - response header ${code(displayName)}: ${value === "—" ? "declared, no example" : `value ${value}`}`,
        );
      }
    }
    const content = asRecord(response.content);
    if (content !== undefined) {
      for (const [contentType, media] of Object.entries(content)) {
        const schema =
          asRecord(deref(context.spec, asRecord(media)?.schema)) ?? {};
        const properties = asRecord(schema.properties);
        lines.push(
          `  - content ${code(contentType)}: ${
            evidence.tier === "C"
              ? "schema declared but **authored only** — tier C is unverified, so it is not presented as a contract"
              : "**authored response schema — no response body was captured**"
          }`,
        );
        if (evidence.tier !== "C" && properties !== undefined) {
          for (const [field, rawSchema] of Object.entries(properties)) {
            const resolved = asRecord(deref(context.spec, rawSchema)) ?? {};
            lines.push(
              `    - ${code(field)} (${cell(schemaType(context.spec, resolved))}) — ${mdText(asString(resolved.description), "no description")}`,
            );
          }
        }
      }
    }
  }
  lines.push("");
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

function renderIntro(context: RenderContext): string[] {
  const tiers = context.operations.map((operation) => {
    const evidence = context.evidence.get(
      keyOf(operation.path, operation.method),
    );
    if (evidence === undefined)
      throw new Error(`generate_docs: missing evidence for ${operation.path}`);
    return evidence.tier;
  });
  const tierA = tierCount(tiers, "A");
  const tierB = tierCount(tiers, "B");
  const tierC = tierCount(tiers, "C");
  const tierD = tierCount(tiers, "D");
  const tierE = tierCount(tiers, "E");
  const version =
    asString(asRecord(context.spec.info)?.version) ?? "unversioned";
  const ledgerCounts = context.ledger.counts;

  const lines: string[] = [];
  lines.push("# SportsDesk & Fantasy402 Wire API Reference");
  lines.push("");
  lines.push(
    "Evidence-labelled reference generated from " +
      code("docs/openapi.json") +
      " (version " +
      code(version) +
      ") and " +
      code("docs/evidence/ledger.json") +
      ". Do not edit this file by hand — run " +
      code("bun run scripts/generate_docs.ts") +
      ".",
  );
  lines.push("");
  lines.push("## What is verified vs inferred");
  lines.push("");
  lines.push(
    `1. **Verified (tier B, ${tierB} of ${context.operations.length} operations):** a captured request side or an implementation-verified route exists. **No response body was captured**, so no response shape here is a contract.`,
  );
  lines.push(
    `2. **Inferred (tier C, ${tierC} operations):** authored in the spec, a repo type or a UI/DOM observation. No request or response was observed; treat these as proposals.`,
  );
  lines.push(
    `3. **Captured responses (tier A, ${tierA}) and recovered surfaces (tier D, ${tierD}):** tier A requires a captured response body and ${tierA === 0 ? "none exists" : "the count is above"}; tier D operations are real surfaces recovered from code or fixtures after being absent from the spec. ` +
      (tierE > 0
        ? `${tierE} tier E operation(s) remain documented with no implementation.`
        : "No tier E operation remains in the spec — documented-but-unimplemented paths were removed."),
  );
  lines.push("");
  lines.push(
    "Ledger totals across every recorded row (including rows removed from the final spec): " +
      `A ${ledgerCounts.A ?? 0} · B ${ledgerCounts.B ?? 0} · C ${ledgerCounts.C ?? 0} · E ${ledgerCounts.E ?? 0} · ` +
      `surfaces D ${context.ledger.surfaceCounts.D ?? 0} / E ${context.ledger.surfaceCounts.E ?? 0}. ` +
      "Full model: [docs/EVIDENCE.md](./EVIDENCE.md).",
  );
  lines.push("");
  return lines;
}

function tagOrder(spec: Record<string, unknown>): Map<string, number> {
  const order = new Map<string, number>();
  let index = 0;
  for (const rawTag of asArray(spec.tags)) {
    const name = asString(asRecord(rawTag)?.name);
    if (name === undefined) continue;
    order.set(name, index);
    index += 1;
  }
  return order;
}

function sortedOperations(context: RenderContext): SpecOperation[] {
  const order = tagOrder(context.spec);
  const knownTagCount = order.size;
  return [...context.operations].sort((left, right) => {
    const leftTag = asString(asArray(left.operation.tags)[0]) ?? "";
    const rightTag = asString(asArray(right.operation.tags)[0]) ?? "";
    const leftIndex = order.get(leftTag) ?? knownTagCount;
    const rightIndex = order.get(rightTag) ?? knownTagCount;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    if (leftTag !== rightTag) return leftTag.localeCompare(rightTag);
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return (
      HTTP_METHODS.indexOf(left.method as (typeof HTTP_METHODS)[number]) -
      HTTP_METHODS.indexOf(right.method as (typeof HTTP_METHODS)[number])
    );
  });
}

function renderDomains(context: RenderContext): string[] {
  const order = tagOrder(context.spec);
  const tierByTag = new Map<string, Tier[]>();
  for (const operation of context.operations) {
    const tag = asString(asArray(operation.operation.tags)[0]) ?? "Untagged";
    const evidence = context.evidence.get(
      keyOf(operation.path, operation.method),
    );
    const list = tierByTag.get(tag) ?? [];
    if (evidence !== undefined) list.push(evidence.tier);
    tierByTag.set(tag, list);
  }
  const tags: string[] = [];
  for (const [name] of [...order.entries()].sort((a, b) => a[1] - b[1])) {
    tags.push(name);
  }
  for (const tag of [...tierByTag.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  const lines: string[] = ["## Operational domains", ""];
  const rows: string[][] = [];
  for (const tag of tags) {
    const tiers = tierByTag.get(tag) ?? [];
    const mix =
      tiers.length === 0
        ? "—"
        : TIER_ORDER.filter((tier) => tierCount(tiers, tier) > 0)
            .map((tier) => `${tier} ${tierCount(tiers, tier)}`)
            .join(" · ");
    const description = asString(
      asRecord(
        asArray(context.spec.tags).find(
          (entry) => asString(asRecord(entry)?.name) === tag,
        ),
      )?.description,
    );
    rows.push([
      cell(tag),
      String(tiers.length),
      cell(mix),
      cell(description, "no description declared"),
    ]);
  }
  lines.push(
    markdownTable(
      ["Domain / tag", "Operations", "Evidence tiers", "Purpose"],
      rows,
    ),
  );
  lines.push("");
  return lines;
}

const HEADER_EVIDENCE: Readonly<Record<string, string>> = {
  authorization:
    "Declared for the local daemon (`daemonBearer`) and implementation-verified there (`services/sportsdesk_webview_server.ts:27-47`). The 2026-10-28 Manager HAR sent **no** Authorization header: the observed Manager session is cookie-based (`docs/runbooks/operational_guardrails_runbook.md:153`).",
  cookie:
    "Observed: the 2026-10-28 Manager HAR session is cookie-based (`docs/runbooks/operational_guardrails_runbook.md:153`). Cookie name, lifetime, renewal and scope were **not** captured.",
  "content-type":
    "Observed on the `getWebLog` mode-B request as `application/x-www-form-urlencoded; charset=UTF-8` (`docs/runbooks/operational_guardrails_runbook.md:129-140`); other content types are spec declarations, not captures.",
  "x-requested-with":
    "Observed on the `getWebLog` mode-B request (`XMLHttpRequest`, `docs/runbooks/operational_guardrails_runbook.md:129-140`).",
  accept:
    "Declared in the spec; not present in the captured `getWebLog` request headers.",
  "referrer-policy":
    "Declared for request hygiene; not present in the captured `getWebLog` request headers.",
};

const RESPONSE_HEADER_EVIDENCE: Readonly<Record<string, string>> = {
  "content-security-policy":
    "Implemented for local daemon responses (`services/sportsdesk_webview_server.ts:83-91`). Upstream cloud response headers were not captured.",
  "x-content-type-options":
    "Implemented for local daemon responses (`services/sportsdesk_webview_server.ts:83-91`). Upstream cloud response headers were not captured.",
  "referrer-policy":
    "Implemented for local daemon responses (`services/sportsdesk_webview_server.ts:83-91`). Upstream cloud response headers were not captured.",
};

function renderHeadersMatrix(context: RenderContext): string[] {
  const lines: string[] = ["## Headers matrix", ""];

  const requestHeaders = new Map<
    string,
    { name: string; required: boolean; value: string; description: string }
  >();
  const components = asRecord(context.spec.components);
  const parameters = asRecord(components?.parameters);
  if (parameters !== undefined) {
    for (const rawParameter of Object.values(parameters)) {
      const resolved = resolveParameter(context.spec, rawParameter);
      if (resolved.location !== "header") continue;
      requestHeaders.set(resolved.name.toLowerCase(), {
        name: resolved.name,
        required: resolved.required,
        value: [
          schemaTypeSafe(resolved.schema),
          exampleValue(resolved.schema) === "—"
            ? ""
            : `example ${exampleValue(resolved.schema)}`,
        ]
          .filter((part) => part !== "")
          .join(", "),
        description: resolved.description,
      });
    }
  }
  const securitySchemes = asRecord(components?.securitySchemes);
  if (securitySchemes !== undefined) {
    for (const scheme of Object.values(securitySchemes)) {
      const record = asRecord(scheme);
      if (record === undefined) continue;
      const type = asString(record.type) ?? "";
      if (type === "apiKey" && asString(record.in) === "cookie") {
        requestHeaders.set("cookie", {
          name: "Cookie",
          required: true,
          value: code(asString(record.name) ?? "session cookie"),
          description: "Session cookie used by the cloud Manager surface.",
        });
      }
      if (type === "http" && asString(record.scheme) === "bearer") {
        requestHeaders.set("authorization", {
          name: "Authorization",
          required: true,
          value: "`Bearer <token>`",
          description: "Bearer token used by the local daemon surface.",
        });
      }
    }
  }
  if (!requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", {
      name: "Content-Type",
      required: false,
      value:
        "`application/x-www-form-urlencoded` or `application/json` depending on operation",
      description: "Payload serialization announced by the caller.",
    });
  }

  const requestRows: string[][] = [];
  for (const entry of [...requestHeaders.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const evidence =
      HEADER_EVIDENCE[entry.name.toLowerCase()] ??
      "Declared in the spec; no capture.";
    requestRows.push([
      tableCellCode(entry.name),
      entry.required ? "yes" : "conditional",
      entry.value === "" ? "—" : entry.value,
      cell(entry.description, "no description declared"),
      cell(evidence),
    ]);
  }
  lines.push("### Outbound request headers", "");
  lines.push(
    markdownTable(
      ["Header", "Required", "Declared value", "Purpose", "Evidence"],
      requestRows,
    ),
  );
  lines.push("");

  const responseHeaders = new Map<
    string,
    { value: string; description: string }
  >();
  const declaredHeaders = asRecord(components?.headers);
  if (declaredHeaders !== undefined) {
    for (const [componentKey, rawHeader] of Object.entries(declaredHeaders)) {
      const header = asRecord(deref(context.spec, rawHeader));
      if (header === undefined) continue;
      const schema = asRecord(header.schema) ?? {};
      const description = asString(header.description) ?? "";
      responseHeaders.set(headerDisplayName(componentKey, description), {
        value: headerValue(schema, description, context.spec),
        description,
      });
    }
  }
  if (responseHeaders.size === 0) {
    lines.push("### Inbound response security headers", "");
    lines.push(
      "No response headers are declared in the spec. The local daemon implements `Content-Security-Policy`, `X-Content-Type-Options` and `Referrer-Policy` (`services/sportsdesk_webview_server.ts:83-91`); upstream cloud response headers were not captured.",
    );
    lines.push("");
  } else {
    lines.push("### Inbound response security headers", "");
    const responseRows: string[][] = [];
    for (const [name, entry] of [...responseHeaders.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      responseRows.push([
        tableCellCode(name),
        entry.value === "—" ? "—" : entry.value,
        cell(entry.description, "no description declared"),
        cell(
          RESPONSE_HEADER_EVIDENCE[name.toLowerCase()] ??
            "Declared in `components.headers`; response headers were not captured.",
        ),
      ]);
    }
    lines.push(
      markdownTable(
        ["Header", "Declared value", "Purpose", "Evidence"],
        responseRows,
      ),
    );
    lines.push("");
  }
  return lines;
}

const SCHEME_NOTES: Readonly<Record<string, string>> = {
  fantasy402cookie:
    "Observed: the 2026-10-28 Manager HAR session is cookie-based and sent no Authorization header (`docs/runbooks/operational_guardrails_runbook.md:153`). The 2026-10-31 captures record an `authorization` key with a **redacted** value, so whether the current session also sends a bearer token is **unverified — check this**. No login/`Set-Cookie` exchange was captured, so the cookie name, lifetime, renewal window and scope are **unverified**. Do not assume a JWT lifetime — the earlier “~20–25 minute” claim had no source and was removed.",
  daemonbearer:
    "Implementation-verified: the local daemon compares `Authorization: Bearer <token>` against `SPORTSDESK_ADMIN_TOKEN` in constant time (`services/sportsdesk_webview_server.ts:27-47`), protects `/api/watchlist` and `/api/telegram/*` (`:176-183`) and returns 503 when the token is not configured.",
  bearerAuth:
    "Unverified — declared only for tier C operations; no bearer token exchange was ever captured.",
};

function renderAuth(context: RenderContext): string[] {
  const lines: string[] = ["## Authentication & sessions", ""];
  const components = asRecord(context.spec.components);
  const securitySchemes = asRecord(components?.securitySchemes);

  if (
    securitySchemes === undefined ||
    Object.keys(securitySchemes).length === 0
  ) {
    lines.push(
      "The spec declares no security schemes. The only observed authenticated session is the cookie-based Manager session from the 2026-10-28 HAR (`docs/runbooks/operational_guardrails_runbook.md:153`); the local daemon's bearer check is implementation-verified (`services/sportsdesk_webview_server.ts:27-47`). Everything else is unverified.",
    );
    lines.push("");
  } else {
    for (const [name, rawScheme] of Object.entries(securitySchemes)) {
      const scheme = asRecord(rawScheme);
      if (scheme === undefined) continue;
      lines.push(`### ${code(name)}`);
      lines.push("");
      const type = asString(scheme.type) ?? "unknown";
      const flavor =
        type === "apiKey"
          ? `apiKey in \`${asString(scheme.in) ?? "?"}\` named \`${asString(scheme.name) ?? "?"}\``
          : type === "http"
            ? `http \`${asString(scheme.scheme) ?? "?"}\``
            : type;
      lines.push(`**Declared type:** ${flavor}.`);
      lines.push("");
      const description = asString(scheme.description);
      if (description !== undefined) {
        lines.push(mdText(description));
        lines.push("");
      }
      const note = SCHEME_NOTES[name] ?? SCHEME_NOTES[name.toLowerCase()];
      lines.push(
        note ??
          "Declared in the spec; no authentication exchange was captured for this scheme.",
      );
      lines.push("");
    }
  }

  lines.push("### Session lifecycle", "");
  lines.push(
    "No login, refresh or logout exchange was captured in this release. The only real wire artifact is the 2026-10-28 Manager HAR request capture, which shows a cookie-based session and no `Authorization` header; its response bodies and `Set-Cookie` were not captured. Treat any token lifetime, refresh window or logout behaviour as a **proposal** until captured (see [docs/evidence/capture-requests.md](./evidence/capture-requests.md)).",
  );
  lines.push("");
  return lines;
}

function renderErrorEnvelope(context: RenderContext): string[] {
  const schemas = asRecord(asRecord(context.spec.components)?.schemas);
  if (schemas === undefined) return [];
  const envelope = asRecord(schemas.StandardWireError);
  const sysexit = asRecord(schemas.SysexitCode);
  const classification = asRecord(schemas.WirePayloadErrorClassification);
  if (
    envelope === undefined &&
    sysexit === undefined &&
    classification === undefined
  )
    return [];

  const lines: string[] = [
    "## Error envelope (spec-authored, not captured)",
    "",
  ];
  lines.push(
    "No error response body was captured in this release. The envelope and codes below are **declared by the spec**, not observed behaviour; treat them as proposals.",
  );
  lines.push("");
  if (envelope !== undefined) {
    const properties = asRecord(envelope.properties);
    if (properties !== undefined) {
      const required = asArray(envelope.required).filter(
        (entry): entry is string => typeof entry === "string",
      );
      const rows: string[][] = [];
      for (const [field, rawSchema] of Object.entries(properties)) {
        const resolved = asRecord(deref(context.spec, rawSchema)) ?? {};
        rows.push([
          tableCellCode(field),
          cell(schemaType(context.spec, resolved)),
          required.includes(field) ? "yes" : "no",
          cell(asString(resolved.description), "no description declared"),
        ]);
      }
      lines.push(
        markdownTable(["Field", "Type", "Required", "Description"], rows),
      );
      lines.push("");
    }
  }
  if (classification !== undefined) {
    const values = asArray(classification.enum)
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => code(entry));
    if (values.length > 0) {
      lines.push(`**Declared error codes:** ${values.join(", ")}.`);
      lines.push("");
    }
  }
  if (sysexit !== undefined) {
    const enumValues = asArray(sysexit.enum).map((entry) => text(entry));
    const names = asArray(sysexit["x-enum-varnames"]).map((entry) =>
      text(entry),
    );
    const rows: string[][] = [];
    for (
      let index = 0;
      index < Math.max(enumValues.length, names.length);
      index += 1
    ) {
      rows.push([
        tableCellCode(enumValues[index] ?? "—"),
        cell(names[index] ?? "—"),
      ]);
    }
    lines.push("### Sysexit codes", "");
    lines.push(markdownTable(["Code", "Name"], rows));
    lines.push("");
  }
  return lines;
}

const CONTRADICTION_NOTES: Readonly<Record<string, string>> = {
  "/cloud/api/Manager/getWebLog":
    "The earlier spec required an `Authorization: Bearer` header and published a four-field response row schema; the 2026-10-28 HAR shows a cookie-based session with no Authorization header (the 2026-10-31 captures record a redacted `authorization` key, so a bearer token is unverified), and captured no response body (`docs/runbooks/operational_guardrails_runbook.md:153`). Only the mode-B request side is real.",
  "/cloud/api/Manager/getInfoPlayer":
    "The earlier spec's request example was an 11-character padded `customerID`; the observed read sent a 7-character trimmed ID (`docs/runbooks/operational_guardrails_runbook.md:213`) and the response remains uncaptured.",
};

function contradictionNote(path: string): string {
  return (
    CONTRADICTION_NOTES[path] ??
    "A concrete artifact refutes a claim previously made for this operation; see docs/EVIDENCE.md for the evidence."
  );
}

function renderEndpoint(
  context: RenderContext,
  operation: SpecOperation,
): string[] {
  const evidence = context.evidence.get(
    keyOf(operation.path, operation.method),
  );
  if (evidence === undefined) {
    throw new Error(
      `generate_docs: missing evidence for ${operation.method} ${operation.path}`,
    );
  }
  const lines: string[] = [];
  lines.push(
    `### ${code(operation.method.toUpperCase() + " " + operation.path)}`,
  );
  lines.push("");
  lines.push(evidenceBadge(evidence));
  lines.push("");
  const summary = asString(operation.operation.summary);
  if (summary !== undefined) {
    lines.push(`**${mdText(summary)}**`);
    lines.push("");
  }
  const description = asString(operation.operation.description);
  if (description !== undefined) {
    lines.push(mdText(description));
    lines.push("");
  }
  const tag = asString(asArray(operation.operation.tags)[0]);
  const operationId = asString(operation.operation.operationId);
  const meta: string[] = [];
  if (tag !== undefined) meta.push(`**Tag:** ${cell(tag)}`);
  if (operationId !== undefined)
    meta.push(`**operationId:** ${code(operationId)}`);
  if (meta.length > 0) lines.push("- " + meta.join(" · "));
  const requiredCapture = evidence.requiredCapture;
  if (requiredCapture !== undefined)
    lines.push(`- **Required capture:** ${mdText(requiredCapture)}`);
  if (evidence.contradicted) {
    lines.push(
      `- **Contradiction:** ${mdText(contradictionNote(operation.path))}`,
    );
  }
  if (meta.length > 0 || requiredCapture !== undefined || evidence.contradicted)
    lines.push("");

  const parameters = parametersFor(context.spec, operation);
  lines.push(...renderParameters(context.spec, parameters));
  if (parameters.length > 0) lines.push("");
  lines.push(...renderRequestBodies(context, operation, evidence));
  lines.push(...renderResponses(context, operation, evidence));
  return lines;
}

function whyUnverified(row: LedgerOperation): string {
  const kinds = uniqueSorted(
    row.evidence
      .map((entry) => entry.kind)
      .filter((kind) => kind !== "spec-claim" && kind !== ""),
  );
  if (kinds.length === 0) return "Authored in the spec; no capture exists.";
  if (kinds.length === 1 && kinds[0] === "none")
    return "No artifact exists; authored in the spec.";
  const labels = kinds.map(
    (kind) => KIND_LABELS[kind] ?? kind.replace(/-/g, " "),
  );
  return "Inferred only: " + labels.join("; ") + ".";
}

function renderInferredAppendix(context: RenderContext): string[] {
  const specKeys = new Set(
    context.operations.map((operation) =>
      keyOf(operation.path, operation.method),
    ),
  );
  const tierCRows = context.ledger.operations
    .filter((row) => row.tier === "C")
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.method.localeCompare(right.method),
    );

  const lines: string[] = ["## Inferred, unverified operations", ""];
  lines.push(
    "These rows are **tier C**. They are authored in the spec/generators, declared from a repo type, or inferred from a UI/DOM observation; none has an observed request or response. They remain in the spec deliberately, labelled — **do not treat any of them as a contract**.",
  );
  lines.push("");
  const rows: string[][] = [];
  for (const row of tierCRows) {
    const inSpec = specKeys.has(keyOf(row.path, row.method));
    rows.push([
      cell(row.method.toUpperCase()),
      tableCellCode(row.path) + (inSpec ? "" : " (not in final spec)"),
      cell(whyUnverified(row)),
      cell(
        row.requiredCapture === ""
          ? "Capture a request and response for this operation."
          : row.requiredCapture,
      ),
    ]);
  }
  lines.push(
    markdownTable(
      ["Method", "Path", "Why unverified", "Required capture"],
      rows,
    ),
  );
  lines.push("");
  lines.push(
    `Appendix rows: **${rows.length}** (tier C in the ledger). The capture plan that would upgrade them is [docs/evidence/capture-requests.md](./evidence/capture-requests.md).`,
  );
  lines.push("");
  return lines;
}

function surfaceAppearsInSpec(
  surface: LedgerSurface,
  spec: Record<string, unknown>,
): string {
  const paths = asRecord(spec.paths) ?? {};
  const routeMembers = surface.members.filter(
    (member) =>
      /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//i.test(member.trim()) ||
      member.trim().startsWith("/"),
  );
  if (routeMembers.length === 0) {
    return surface.id === "surface.gs-manager-cli"
      ? "no — blocked contract, see [gs-manager-contracts.md](./gs-manager-contracts.md)"
      : "no — schemas only, no HTTP path";
  }
  const found = routeMembers.filter((member) => {
    const path = member
      .replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "")
      .trim();
    return paths[path] !== undefined;
  });
  if (found.length === 0) {
    return surface.tier === "E"
      ? "no — no implementation exists; removed by design"
      : "no — not present in the spec";
  }
  return `yes (${found.length}/${routeMembers.length} member path(s))`;
}

function renderMissingSurfaces(context: RenderContext): string[] {
  const lines: string[] = ["## Missing surfaces", ""];
  lines.push(
    "Real surfaces recorded by the ledger that the final spec does not (or cannot) present as operations. Full inventory: [docs/evidence/surfaces.md](./evidence/surfaces.md) and [docs/EVIDENCE.md](./EVIDENCE.md).",
  );
  lines.push("");
  const rows: string[][] = [];
  const surfaces = [...context.ledger.surfaces].sort(
    (left, right) =>
      left.tier.localeCompare(right.tier) || left.id.localeCompare(right.id),
  );
  for (const surface of surfaces) {
    rows.push([
      tableCellCode(surface.id),
      cell(surface.tier),
      cell(surface.category),
      cell(surface.name),
      cell(surface.what),
      cell(surfaceAppearsInSpec(surface, context.spec)),
    ]);
  }
  lines.push(
    markdownTable(
      ["Surface", "Tier", "Category", "What it is", "Detail", "In final spec"],
      rows,
    ),
  );
  lines.push("");
  const nonSpec = surfaces.filter(
    (surface) => !surfaceAppearsInSpec(surface, context.spec).startsWith("yes"),
  );
  if (nonSpec.length > 0) {
    lines.push(
      `${nonSpec.length} of ${surfaces.length} ledger surfaces are **not** presented as spec operations; the reason is in the “In final spec” column. The GS report surfaces are documented separately, because no HTTP contract exists for them ([gs-manager-contracts.md](./gs-manager-contracts.md)).`,
    );
    lines.push("");
  }
  return lines;
}

function extractLimitations(markdown: string): string | undefined {
  const headingMatch = /^##\s+Limitations[^\n]*$/m.exec(markdown);
  if (headingMatch === null) return undefined;
  const afterHeading = markdown.slice(
    (headingMatch.index ?? 0) + headingMatch[0].length,
  );
  const block: string[] = [];
  for (const rawLine of afterHeading.split("\n")) {
    const line = rawLine.trim();
    if (line === "" && block.length > 0) break;
    if (line === "" && block.length === 0) continue;
    if (line.startsWith("#")) break;
    if (line.startsWith(">")) {
      block.push(line.replace(/^>\s?/, ""));
    } else if (block.length > 0) {
      break;
    }
  }
  const quoted = collapse(block.join(" "));
  return quoted === "" ? undefined : quoted;
}

const TIER_MEANINGS: Readonly<Record<Tier, string>> = {
  A: "Captured wire contract: a real request AND a real response capture exist. Five operations qualify from the 2026-10-31 live session (getWebLog, getInfoPlayer, getBetTicker, getBetTickerConfig, getSportsVigSetup).",
  B: "Observed first-party evidence: captured request side, observed request payload, or a route verified against its handler source. The response may still be uncaptured.",
  C: "Inferred only: authored in the spec/generators, a repo TypeScript type, or a UI/DOM observation. No request or response was observed.",
  D: "Real surface recovered from code or fixtures after being absent from the earlier spec. No captured response; recorded in `surfaces[]` and, for three rows, as a spec operation.",
  E: "Documented operation with no implementation in this repository.",
};

function renderEvidence(context: RenderContext): string[] {
  const lines: string[] = ["## Evidence & limitations", ""];
  const specTiers = context.operations.map(
    (operation) =>
      context.evidence.get(keyOf(operation.path, operation.method))?.tier,
  );
  lines.push(
    "Tier legend: **A** captured request *and* response · **B** observed request or implementation-verified route (response may be uncaptured) · **C** inferred/authored only · **D** real surface recovered from code/fixtures · **E** documented with no implementation.",
  );
  lines.push("");
  const rows: string[][] = TIER_ORDER.map((tier) => [
    tier,
    cell(TIER_MEANINGS[tier]),
    String(
      tier === "D" || tier === "E"
        ? (context.ledger.surfaceCounts[tier] ?? 0)
        : "",
    ),
    String(specTiers.filter((candidate) => candidate === tier).length),
  ]);
  lines.push(
    "Counts below are ledger totals (all recorded rows, including rows removed from the final spec). The last two columns show the release split: ledger surfaces and operations present in the final spec.",
  );
  lines.push("");
  lines.push(
    markdownTable(
      ["Tier", "Meaning", "Ledger surfaces", "Spec operations"],
      rows,
    ),
  );
  lines.push("");

  const limitations = extractLimitations(context.evidenceMd);
  if (limitations !== undefined) {
    lines.push("> " + limitations);
    lines.push("");
  } else {
    lines.push(
      "No operation in this release has a captured response body. Every response schema is authored unless its badge says otherwise. Treat anything not marked tier B as a proposal to be confirmed by capture, not as a contract.",
    );
    lines.push("");
  }

  const contradictedAbsent = context.ledger.operations.filter((row) => {
    if (!row.contradicted) return false;
    return !context.operations.some(
      (operation) =>
        keyOf(operation.path, operation.method) === keyOf(row.path, row.method),
    );
  });
  if (contradictedAbsent.length > 0) {
    lines.push(
      `**Removed contradicted claim${contradictedAbsent.length === 1 ? "" : "s"}:** ` +
        `${contradictedAbsent.length} ledger row${contradictedAbsent.length === 1 ? "" : "s"} contradicted by a concrete artifact ${contradictedAbsent.length === 1 ? "is" : "are"} not ${contradictedAbsent.length === 1 ? "an operation" : "operations"} in the final spec. ` +
        "The GS extract contradicted the fabricated steam-ingestion route and its partner gateway; that surface is now documented as blocked, without an HTTP contract, in [gs-manager-contracts.md](./gs-manager-contracts.md). See [docs/EVIDENCE.md](./EVIDENCE.md) for the quotes.",
    );
    lines.push("");
  }

  lines.push(
    "Sources: [docs/openapi.json](./openapi.json) · [docs/evidence/ledger.json](./evidence/ledger.json) · [docs/EVIDENCE.md](./EVIDENCE.md) · [docs/evidence/capture-requests.md](./evidence/capture-requests.md) · [docs/evidence/surfaces.md](./evidence/surfaces.md) · [docs/gs-manager-contracts.md](./gs-manager-contracts.md).",
  );
  lines.push("");
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Assembly + self-checks                                                     */
/* -------------------------------------------------------------------------- */

function collectSpecOperations(spec: Record<string, unknown>): SpecOperation[] {
  const paths = asRecord(spec.paths);
  if (paths === undefined)
    throw new Error("generate_docs: docs/openapi.json has no paths object");
  const operations: SpecOperation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = asRecord(rawItem);
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const operation = asRecord(pathItem[method]);
      if (operation === undefined) continue;
      operations.push({ path, method, operation, pathItem });
    }
  }
  return operations;
}

function ledgerIndex(ledger: Ledger): Map<string, LedgerOperation> {
  const index = new Map<string, LedgerOperation>();
  for (const row of ledger.operations)
    index.set(keyOf(row.path, row.method), row);
  return index;
}

function render(context: RenderContext): string {
  const lines: string[] = [];
  lines.push(...renderIntro(context));
  lines.push(...renderGSLiveDocsMarkdown().split("\n"));
  lines.push("");
  lines.push(...renderDomains(context));
  lines.push(...renderHeadersMatrix(context));
  lines.push(...renderAuth(context));
  lines.push(...renderErrorEnvelope(context));
  lines.push("## Endpoint reference");
  lines.push("");
  lines.push(
    "One section per operation present in the final spec. Each section starts with its evidence badge; parameters, request bodies and responses are shown only as far as the evidence tier allows.",
  );
  lines.push("");
  for (const operation of sortedOperations(context)) {
    lines.push(...renderEndpoint(context, operation));
  }
  lines.push(...renderInferredAppendix(context));
  lines.push(...renderMissingSurfaces(context));
  lines.push(...renderEvidence(context));
  return (
    sanitizeFabricated(
      lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd(),
    ) + "\n"
  );
}

function assertOutput(context: RenderContext, markdown: string): void {
  const problems: string[] = [];
  const operationCount = context.operations.length;
  const specPaths = new Set(
    context.operations.map((operation) => operation.path),
  );

  if (markdown.length < 2000)
    problems.push(`output is only ${markdown.length} chars`);
  const undefinedMatches = markdown.match(/undefined/gi);
  if (undefinedMatches !== null) {
    problems.push(
      `output contains ${undefinedMatches.length} "undefined" token(s) — a renderer path failed`,
    );
  }
  if (markdown.includes("[object Object]"))
    problems.push("output contains [object Object]");

  const missingPaths = [...specPaths].filter(
    (path) => !markdown.includes(path),
  );
  if (missingPaths.length > 0)
    problems.push(
      `missing spec path(s): ${missingPaths.slice(0, 5).join(", ")}`,
    );

  const badgeCount = markdown
    .split("\n")
    .filter((line) => line.startsWith("> **Evidence — tier ")).length;
  if (badgeCount !== operationCount) {
    problems.push(
      `evidence badge lines ${badgeCount} != spec operations ${operationCount}`,
    );
  }

  const tierC = context.ledger.operations.filter(
    (row) => row.tier === "C",
  ).length;
  const appendixSection = markdown.slice(
    markdown.indexOf("## Inferred, unverified operations"),
    markdown.indexOf("## Missing surfaces"),
  );
  const appendixRows = appendixSection
    .split("\n")
    .filter((line) =>
      /^\|\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)\s*\|/.test(line),
    ).length;
  if (appendixRows !== tierC) {
    problems.push(
      `appendix rows ${appendixRows} != ledger tier C rows ${tierC}`,
    );
  }

  for (const [pattern] of FABRICATED_FRAGMENTS) {
    const probe = new RegExp(pattern.source, "i");
    if (probe.test(markdown)) {
      problems.push(
        `output re-publishes a fabricated-contract literal: ${pattern.source}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "generate_docs: self-check failed:\n  - " + problems.join("\n  - "),
    );
  }
}

/**
 * Run the repository formatter (bunfig.toml style options) on the rendered file.
 *
 * CI runs the repo-wide formatter, so the committed markdown must be BOTH the
 * generator's output AND formatter-clean. Formatting is deterministic: the
 * freshness gate re-runs this whole generator (write + format) and byte-compares.
 */
function formatMarkdown(outPath: string, root: string): void {
  const result = Bun.spawnSync([process.execPath, "fmt", outPath], {
    cwd: root,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    throw new Error(
      `generate_docs: repo formatter failed on ${outPath} (exit ${result.exitCode}): ` +
        (stderr || stdout || "no output"),
    );
  }
}

function parseArgs(argv: readonly string[], root: string): { out: string } {
  let out = join(root, "docs", "api-reference.md");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("generate_docs: --out requires a path");
      }
      out = isAbsolute(value) ? value : resolve(root, value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "Usage: bun run scripts/generate_docs.ts [--out <path>]\n\n" +
          "Renders docs/api-reference.md from docs/openapi.json + docs/evidence/ledger.json\n" +
          "(and the Limitations blockquote in docs/EVIDENCE.md). Deterministic.\n",
      );
      process.exit(0);
    } else {
      throw new Error(
        `generate_docs: unknown argument "${argument}" (use --out <path> or --help)`,
      );
    }
  }
  return { out };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const root = process.cwd();
  const { out } = parseArgs(argv, root);
  const spec = asRecord(loadJson(join(root, "docs", "openapi.json")));
  if (spec === undefined)
    throw new Error("generate_docs: docs/openapi.json must be a JSON object");
  const ledger = loadLedger(join(root, "docs", "evidence", "ledger.json"));
  const evidencePath = join(root, "docs", "EVIDENCE.md");
  const evidenceMd = existsSync(evidencePath)
    ? readFileSync(evidencePath, "utf8")
    : "";

  const operations = collectSpecOperations(spec);
  const rowsByKey = ledgerIndex(ledger);
  const evidence = new Map<string, Evidence>();
  for (const operation of operations) {
    const row = rowsByKey.get(keyOf(operation.path, operation.method));
    evidence.set(
      keyOf(operation.path, operation.method),
      specEvidenceOf(operation, row),
    );
  }

  const context: RenderContext = {
    spec,
    ledger,
    evidenceMd,
    operations,
    evidence,
  };
  const markdown = render(context);
  assertOutput(context, markdown);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, markdown, "utf8");
  formatMarkdown(out, root);
  const formatted = readFileSync(out, "utf8");
  // Re-run the content guards on the formatted bytes: the committed file must
  // pass both the generator invariants and the repo formatter.
  assertOutput(context, formatted);
  const tierCounts = TIER_ORDER.map((tier) =>
    TIER_ORDER.includes(tier)
      ? `${tier}:${[...evidence.values()].filter((entry) => entry.tier === tier).length}`
      : "",
  )
    .filter((entry) => entry !== "")
    .join(" ");
  process.stdout.write(
    `generate_docs: wrote ${out} (${formatted.length} chars formatted, ${operations.length} operations, ${tierCounts}, ` +
      `appendix ${ledger.operations.filter((row) => row.tier === "C").length} tier-C rows, 0 undefined)\n`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
