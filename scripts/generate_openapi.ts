#!/usr/bin/env bun
/**
 * generate_openapi.ts — deterministic, evidence-led OpenAPI 3.1 generator.
 *
 * Why this exists: docs/openapi.json used to be hand-authored. It advertised a
 * GS wire contract that the evidence package explicitly marks blocked_contract,
 * published an invented getWebLog response row schema, referenced a BearerAuth
 * scheme that was never declared, and documented /api/desk/* routes that no
 * code serves. This generator replaces that spec with one derived from
 * docs/evidence/ledger.json plus first-party sources:
 *
 *   - docs/evidence/ledger.json  (the machine-readable evidence ledger; tier
 *                                counts are derived from its operation rows,
 *                                never pinned to a release baseline)
 *   - docs/EVIDENCE.md           (binds each Tier D surface id to human docs)
 *   - fantasy402_sport_catalog.ts / simulate_bettor_churn_suite.ts (TS types)
 *   - tests/fixtures/fantasy402-sport-catalog-2026-10-21.json (catalog sample)
 *
 * Every operation carries x-evidence {tier, sources, capturedResponse,
 * requiredCapture?, contradicted?, candidateUrl?}. Tier C operations publish no
 * request body and no response content; Tier D operations reference a ledger
 * surfaces[] row by id. Tier A operations are rendered from the live capture
 * store (docs/evidence/captures/<date>/<slug>.<method>.json, schemaVersion 1):
 * the response schema is derived from capture.response.bodySkeleton and the
 * request schema from capture.request.bodySkeleton, so a B->A upgrade performed
 * by scripts/apply_captures.ts produces a real, capture-backed schema. An A row
 * without a valid live capture is a hard error — the generator never invents a
 * response. The generator self-gates through scripts/verify_docs.ts
 * (checkOpenApi + checkLedger) before writing, so the committed JSON can only be
 * what the docs gate would accept.
 *
 * Determinism: no timestamps, no randomness, no environment reads. The output is
 * JSON.stringify(spec, null, 2) + "\n" built from fixed code + sorted ledger
 * order, then reformatted in place with the repository's pinned bun formatter so
 * the committed file is also `bun fmt --check` clean. Running it twice yields
 * identical bytes; CI re-runs it and byte-diffs.
 *
 * Usage:
 *   bun run scripts/generate_openapi.ts                   # write docs/openapi.json
 *   bun run scripts/generate_openapi.ts --out p           # write to another path
 *   bun run scripts/generate_openapi.ts --root R --ledger L --captures C --out P
 *                                                        # temp-dir / test roots
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import { captureRecordDigest } from "./apply_captures.ts";
import { checkLedger, checkOpenApi } from "./verify_docs.ts";
import type { CheckOutcome } from "./verify_docs.ts";
import {
  GSLIVE_OPENAPI_EXTENSION,
  renderGSLiveDocsMarkdown,
} from "../lib/gslive_api_docs.ts";

/* -------------------------------------------------------------------------- */
/* Paths and run options                                                      */
/* -------------------------------------------------------------------------- */

/** The checkout this script lives in; code/type artifacts fall back here. */
const SCRIPT_ROOT = resolve(import.meta.dir, "..");

const LEDGER_REL = join("docs", "evidence", "ledger.json");
const CAPTURES_REL = join("docs", "evidence", "captures");
const SPEC_REL = join("docs", "openapi.json");
const EVIDENCE_MD_REL = join("docs", "EVIDENCE.md");
const CATALOG_TYPE_SOURCE_REL = "catalog/fantasy402_sport_catalog.ts";
const CHURN_TYPE_SOURCE_REL = "services/simulate_bettor_churn_suite.ts";
const CATALOG_FIXTURE_REL = join(
  "tests",
  "fixtures",
  "fantasy402-sport-catalog-2026-10-21.json",
);
const AJAX_PATH_FRAGMENT = "manager-tools/ajax.php";

/**
 * Evidence/artifact root for this run. `--root` overrides it for temp-dir tests
 * that copy only the ledger + capture store; type sources fall back to this
 * checkout when the override does not contain them.
 */
let artifactRoot = SCRIPT_ROOT;

function artifactPath(relPath: string): string {
  const overridden = join(artifactRoot, relPath);
  return existsSync(overridden) ? overridden : join(SCRIPT_ROOT, relPath);
}

function readArtifact(relPath: string): string {
  return readText(artifactPath(relPath));
}

const TAG_INFERRED = "Inferred (Unverified)";
const TAG_CAPTURED = "Live-captured (request unverified)";
const TAG_FORENSIC = "Forensic Surveillance";
const TAG_CUSTOMER = "Customer State Mutations";
const TAG_DAEMON = "Local Desk & Telegram Gateway";
const TAG_SETTLEMENT = "Settlement History";
const TAG_DOWNLINE = "Downline Accounting";

const USED_TAGS = [
  TAG_FORENSIC,
  TAG_CUSTOMER,
  TAG_DAEMON,
  TAG_SETTLEMENT,
  TAG_DOWNLINE,
  TAG_INFERRED,
  TAG_CAPTURED,
] as const;

/** The 11 hand-authored "Tracked Operational Domains" candidates. */
interface TileMetadata {
  readonly domTile: string;
  readonly domSelector: string;
  readonly extractedInputs: readonly string[];
  readonly languageKeys: readonly string[];
}

const TRACKED_TILE_METADATA: Readonly<Record<string, TileMetadata>> = {
  "/cloud/api/Manager/gameAdmin": {
    domTile: "Game Admin",
    domSelector: "div.tile:has-text('Game Admin')",
    extractedInputs: ["rotationNumber", "sportType", "circleLimit", "isLocked"],
    languageKeys: ["L-1034", "L-1052"],
  },
  "/cloud/api/System/getMessages": {
    domTile: "Messaging",
    domSelector: "div.tile:has-text('Messaging')",
    extractedInputs: ["recipientScope", "subject", "messageBody", "priority"],
    languageKeys: ["L-1055", "L-1056"],
  },
  "/cloud/api/Manager/adjustBalance": {
    domTile: "Cashier",
    domSelector: "div.tile:has-text('Cashier')",
    extractedInputs: ["customerID", "amountCents", "transactionType", "notes"],
    languageKeys: ["L-1031", "L-1045", "L-1058"],
  },
  "/cloud/api/Manager/createPlayer": {
    domTile: "Add Customer",
    domSelector: "div.tile:has-text('Add Customer')",
    extractedInputs: [
      "customerID",
      "agentID",
      "password",
      "creditLimit",
      "delaySeconds",
    ],
    languageKeys: ["L-1031", "L-1032", "L-1040"],
  },
  "/cloud/api/Manager/get3rdPartyLimits": {
    domTile: "3rd Party Limits",
    domSelector: "div.tile:has-text('3rd Party Limits')",
    extractedInputs: ["providerID", "sportCategory", "maxLimitCents"],
    languageKeys: ["L-1060", "L-1061"],
  },
  "/cloud/api/Report/getAnalysis": {
    domTile: "Analysis",
    domSelector: "div.tile:has-text('Analysis')",
    extractedInputs: ["period", "sport", "marketCategory", "agentID"],
    languageKeys: ["L-1034", "L-1064"],
  },
  "/cloud/api/Manager/getScores": {
    domTile: "Scores",
    domSelector: "div.tile:has-text('Scores')",
    extractedInputs: [
      "gameID",
      "periodIndex",
      "homeScore",
      "awayScore",
      "isFinal",
    ],
    languageKeys: ["L-1034", "L-1068"],
  },
  "/cloud/api/Manager/getAgentTree": {
    domTile: "Agent Admin",
    domSelector: "div.tile:has-text('Agent Admin')",
    extractedInputs: ["masterAgent", "commissionSplitPercent", "creditCeiling"],
    languageKeys: ["L-1032", "L-1070"],
  },
  "/cloud/api/Manager/getBilling": {
    domTile: "Billing",
    domSelector: "div.tile:has-text('Billing')",
    extractedInputs: ["billingWeek", "ratePerActiveHead", "activeAccountCount"],
    languageKeys: ["L-1050", "L-1072"],
  },
  "/cloud/api/Manager/getRules": {
    domTile: "Rules",
    domSelector: "div.tile:has-text('Rules')",
    extractedInputs: [
      "parlayMaxPayout",
      "teaserTieRule",
      "defaultDelaySeconds",
    ],
    languageKeys: ["L-1040", "L-1075"],
  },
  "/cloud/api/Report/getFinancialReport": {
    domTile: "Transactions History",
    domSelector: "div.tile:has-text('Transactions History')",
    extractedInputs: [
      "customerID",
      "startDate",
      "endDate",
      "transactionFilter",
    ],
    languageKeys: ["L-1031", "L-1033", "L-1058"],
  },
};

/** C operations backed by a repo consumer type -> the documented component. */
const REPO_TYPE_COMPONENTS: Readonly<Record<string, string>> = {
  "/cloud/api/Manager/getBetTicker": "RawBetTickerTick",
  "/cloud/api/Manager/getPending": "RawPendingLeg",
};

/** Human summaries; the path + evidence tier is the authoritative inventory. */
const SUMMARIES: Readonly<Record<string, string>> = {
  "/cloud/api/System/authenticateCustomer":
    "Authenticate agent/customer session",
  "/cloud/api/Manager/getBetTicker": "Bet ticker delta feed",
  "/cloud/api/Manager/getBetTickerConfig": "Ticker configuration",
  "/cloud/api/Manager/getPending": "Pending wager legs snapshot",
  "/cloud/api/Manager/getWebLog":
    "Manager getWebLog (mode B request observed; response not captured)",
  "/cloud/api/Manager/search": "Global account omnisearch",
  "/cloud/api/Manager/updateByColumn": "Padded-field customer mutation",
  "/cloud/api/Manager/getInfoPlayer":
    "Manager getInfoPlayer (request observed; response not captured)",
  "/cloud/api/Manager/vigSetupInsert": "Insert sport vig setup",
  "/cloud/api/Manager/getSportsVigSetup": "Read sport vig setup",
  "/cloud/api/Manager/getInfoManager": "Manager dashboard header",
  "/cloud/api/Report/getWeeklyFigure": "Weekly figure report",
  "/cloud/api/Manager/getAgentPerformance":
    "Agent performance report (request observed; response not captured)",
  "/cloud/api/Report/getSettledFigure": "Settled figure / collections",
  "/cloud/api/Report/delete-wager": "Deleted wagers report",
  "/health": "Daemon health and telemetry probe",
  "/api/watchlist": "Monitored watch-list accounts",
  "/api/telegram/alert": "Dispatch an instant Telegram alert",
  "/api/telegram/report": "Trigger a scheduled Telegram report",
  "/cloud/api/System/verifySession": "Verify an existing session",
  "/cloud/api/Manager/getCustomerNotes": "Read customer notes",
  "/cloud/api/Manager/updateCustomerNotes": "Update customer notes",
  "/cloud/api/Manager/deleteSportsVigSetup": "Delete sport vig setup",
  "/cloud/api/Manager/deleteWager": "Delete a wager",
  "/cloud/api/Report/getDeletedWagerReport": "Deleted wager report",
  "/cloud/api/Report/getDailyFigure": "Daily figure report",
  "/cloud/api/Manager/gameAdmin": "Launcher tile: Game Admin",
  "/cloud/api/System/getMessages": "Launcher tile: Messaging",
  "/cloud/api/Manager/adjustBalance": "Launcher tile: Cashier",
  "/cloud/api/Manager/createPlayer": "Launcher tile: Add Customer",
  "/cloud/api/Manager/get3rdPartyLimits": "Launcher tile: 3rd Party Limits",
  "/cloud/api/Report/getAnalysis": "Launcher tile: Analysis",
  "/cloud/api/Manager/getScores": "Launcher tile: Scores",
  "/cloud/api/Manager/getAgentTree": "Launcher tile: Agent Admin",
  "/cloud/api/Manager/getBilling": "Launcher tile: Billing",
  "/cloud/api/Manager/getRules": "Launcher tile: Rules",
  "/cloud/api/Report/getFinancialReport": "Launcher tile: Transactions History",
};

/* -------------------------------------------------------------------------- */
/* Small typed JSON helpers                                                   */
/* -------------------------------------------------------------------------- */

type JsonObject = { [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`generate_openapi: ${message}`);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function asOptionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, label);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fail(`cannot read ${path}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Ledger model                                                               */
/* -------------------------------------------------------------------------- */

interface EvidenceEntry {
  readonly source: string;
  readonly kind: string;
  readonly note: string;
}

interface LedgerOperation {
  readonly path: string;
  readonly method: string;
  readonly operationId: string | null;
  readonly tag: string;
  readonly tier: string;
  readonly capturedResponse: boolean;
  readonly evidence: readonly EvidenceEntry[];
  readonly requiredCapture: string | null;
  readonly contradicted: boolean;
  readonly candidateUrl: boolean;
  readonly uiObserved: boolean;
}

interface LedgerSurface {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly evidence: readonly EvidenceEntry[];
}

interface LedgerCounts {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
  readonly E: number;
  readonly total: number;
}

interface Ledger {
  readonly counts: LedgerCounts;
  readonly surfaceCounts: {
    readonly D: number;
    readonly E: number;
    readonly total: number;
  };
  readonly operations: readonly LedgerOperation[];
  readonly surfaces: readonly LedgerSurface[];
}

function parseEvidence(raw: unknown, label: string): EvidenceEntry[] {
  if (!Array.isArray(raw)) fail(`${label}.evidence must be an array`);
  return raw.map((entry, index) => {
    if (!isRecord(entry)) fail(`${label}.evidence[${index}] must be an object`);
    return {
      source: asString(entry.source, `${label}.evidence[${index}].source`),
      kind:
        typeof entry.kind === "string"
          ? entry.kind
          : fail(`${label}.evidence[${index}].kind must be a string`),
      note:
        typeof entry.note === "string"
          ? entry.note
          : fail(`${label}.evidence[${index}].note must be a string`),
    };
  });
}

function parseLedgerCounts(raw: unknown): LedgerCounts {
  if (!isRecord(raw)) fail("ledger.counts must be an object");
  return {
    A: asNumber(raw.A, "counts.A"),
    B: asNumber(raw.B, "counts.B"),
    C: asNumber(raw.C, "counts.C"),
    D: asNumber(raw.D, "counts.D"),
    E: asNumber(raw.E, "counts.E"),
    total: asNumber(raw.total, "counts.total"),
  };
}

function parseLedger(raw: unknown): Ledger {
  if (!isRecord(raw)) fail("ledger.json must contain an object");
  const rawOperations = raw.operations;
  if (!Array.isArray(rawOperations)) {
    fail("ledger.operations must be an array");
  }
  const operations: LedgerOperation[] = rawOperations.map((row, index) => {
    if (!isRecord(row)) fail(`ledger.operations[${index}] must be an object`);
    const label = `ledger.operations[${index}]`;
    return {
      path: asString(row.path, `${label}.path`),
      method: asString(row.method, `${label}.method`),
      operationId: asOptionalString(row.operationId, `${label}.operationId`),
      tag: asString(row.tag, `${label}.tag`),
      tier: asString(row.tier, `${label}.tier`),
      capturedResponse: asBoolean(
        row.capturedResponse,
        `${label}.capturedResponse`,
      ),
      evidence: parseEvidence(row.evidence, label),
      requiredCapture: asOptionalString(
        row.requiredCapture,
        `${label}.requiredCapture`,
      ),
      contradicted: asBoolean(row.contradicted, `${label}.contradicted`),
      candidateUrl: row.candidate_url === true,
      uiObserved: row.ui_observed === true,
    };
  });

  const rawSurfaces = raw.surfaces;
  if (!Array.isArray(rawSurfaces)) fail("ledger.surfaces must be an array");
  const surfaces: LedgerSurface[] = rawSurfaces.map((row, index) => {
    if (!isRecord(row)) fail(`ledger.surfaces[${index}] must be an object`);
    const label = `ledger.surfaces[${index}]`;
    return {
      id: asString(row.id, `${label}.id`),
      name: asString(row.name, `${label}.name`),
      tier: asString(row.tier, `${label}.tier`),
      evidence: parseEvidence(row.evidence, label),
    };
  });

  if (!isRecord(raw.surfaceCounts))
    fail("ledger.surfaceCounts must be an object");
  return {
    counts: parseLedgerCounts(raw.counts),
    surfaceCounts: {
      D: asNumber(raw.surfaceCounts.D, "surfaceCounts.D"),
      E: asNumber(raw.surfaceCounts.E, "surfaceCounts.E"),
      total: asNumber(raw.surfaceCounts.total, "surfaceCounts.total"),
    },
    operations,
    surfaces,
  };
}

const OPERATION_TIERS = ["A", "B", "C", "D", "E"] as const;

function isOperationTier(
  value: string,
): value is (typeof OPERATION_TIERS)[number] {
  return (OPERATION_TIERS as readonly string[]).includes(value);
}

function countLedgerOperationTiers(rows: readonly LedgerOperation[]): {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
  readonly E: number;
  readonly total: number;
} {
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0, total: rows.length };
  for (const row of rows) counts[row.tier as "A" | "B" | "C" | "D" | "E"] += 1;
  return counts;
}

/** True when a ledger operation is intentionally absent from the published spec. */
function isRemovedFromSpec(operation: LedgerOperation): boolean {
  return operation.tier === "E" || operation.path.includes(AJAX_PATH_FRAGMENT);
}

/**
 * Validate the ledger is self-consistent instead of pinning a release baseline.
 *
 * Tier counts are derived from the operation rows: `apply_captures.ts` upgrades
 * rows and recomputes `counts`, so the generator must accept any honest
 * distribution (A+B+C+D+E === operations.length) and reject a hand-edited
 * ledger whose declared counts disagree with its rows.
 */
function assertLedgerConsistency(ledger: Ledger): void {
  for (const row of ledger.operations) {
    if (!isOperationTier(row.tier)) {
      fail(
        `ledger row ${row.method.toUpperCase()} ${row.path} has invalid tier "${row.tier}"; expected one of ${OPERATION_TIERS.join("|")}`,
      );
    }
    if (row.tier === "D") {
      fail(
        `ledger row ${row.method.toUpperCase()} ${row.path} uses tier D; D is reserved for surfaces[] rows, so no operation row may use it`,
      );
    }
  }
  const actual = countLedgerOperationTiers(ledger.operations);
  const declared = ledger.counts;
  for (const tier of OPERATION_TIERS) {
    if (declared[tier] !== actual[tier]) {
      fail(
        `ledger counts mismatch: counts.${tier}=${declared[tier]} but ${actual[tier]} operation row(s) have tier ${tier}. Recompute ledger.counts from its rows (scripts/apply_captures.ts does this) instead of hand-editing the ledger.`,
      );
    }
  }
  if (declared.total !== actual.total) {
    fail(
      `ledger counts mismatch: counts.total=${declared.total} but there are ${actual.total} operation rows`,
    );
  }
  const surfaceCounts = { D: 0, E: 0, total: ledger.surfaces.length };
  for (const surface of ledger.surfaces) {
    if (surface.tier === "D") surfaceCounts.D += 1;
    else if (surface.tier === "E") surfaceCounts.E += 1;
    else {
      fail(
        `ledger surface "${surface.id}" has tier "${surface.tier}"; surfaces[] rows must be D or E`,
      );
    }
  }
  for (const tier of ["D", "E", "total"] as const) {
    if (ledger.surfaceCounts[tier] !== surfaceCounts[tier]) {
      fail(
        `ledger surfaceCounts mismatch: surfaceCounts.${tier}=${ledger.surfaceCounts[tier]} but the surfaces[] rows contain ${surfaceCounts[tier]}`,
      );
    }
  }
}

/**
 * Expected spec operation tiers for this ledger: A/B/C operation rows (minus
 * retired E/ajax rows) plus the fixed Tier D surface operations.
 */
function expectedSpecTierCounts(
  ledger: Ledger,
  surfaceOperationCount: number,
): {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
} {
  const counts = { A: 0, B: 0, C: 0, D: surfaceOperationCount };
  for (const operation of ledger.operations) {
    if (isRemovedFromSpec(operation)) continue;
    if (operation.tier === "A") counts.A += 1;
    else if (operation.tier === "B") counts.B += 1;
    else if (operation.tier === "C") counts.C += 1;
    else {
      fail(
        `ledger row ${operation.method.toUpperCase()} ${operation.path} has tier "${operation.tier}" which cannot be rendered in the spec`,
      );
    }
  }
  return counts;
}

function tierOfOperation(operation: JsonObject): string | undefined {
  const evidence = operation["x-evidence"];
  return isRecord(evidence) && typeof evidence.tier === "string"
    ? evidence.tier
    : undefined;
}

function findSurface(ledger: Ledger, surfaceId: string): LedgerSurface {
  const surface = ledger.surfaces.find((row) => row.id === surfaceId);
  if (surface === undefined) {
    fail(`ledger has no surfaces[] row "${surfaceId}"`);
  }
  return surface;
}

/* -------------------------------------------------------------------------- */
/* TypeScript source parsing (real types, not re-authored field lists)        */
/* -------------------------------------------------------------------------- */

interface ParsedField {
  readonly name: string;
  readonly optional: boolean;
  readonly typeText: string;
  readonly description: string | null;
}

interface ParsedType {
  readonly name: string;
  readonly fileName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly fields: readonly ParsedField[];
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Skip over strings and comments while scanning a type body. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "/" && text.charAt(index + 1) === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (character === "/" && text.charAt(index + 1) === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      index += 1;
      while (index < text.length) {
        const inner = text.charAt(index);
        if (inner === "\\") {
          index += 1;
          continue;
        }
        if (inner === quote) break;
        index += 1;
      }
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return fail("unbalanced braces while parsing a TypeScript type");
}

function normalizeDoc(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s*/, "")
    .replace(/\s*\/\*\*?|\*\/\s*$/g, "")
    .trim();
}

const PROPERTY_PATTERN =
  /^(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(\?)?\s*:\s*(.+)$/;

function parseTypeDeclaration(
  source: string,
  fileName: string,
  typeName: string,
): ParsedType {
  const interfaceMatch = new RegExp(
    `export\\s+interface\\s+${typeName}\\b`,
  ).exec(source);
  const typeMatch = new RegExp(`export\\s+type\\s+${typeName}\\s*=`).exec(
    source,
  );
  const candidates = [interfaceMatch, typeMatch].filter(
    (match): match is RegExpExecArray => match !== null,
  );
  if (candidates.length !== 1) {
    fail(
      `${fileName}: expected exactly one declaration of ${typeName}, found ${candidates.length}`,
    );
  }
  const declaration = candidates[0];
  if (declaration === undefined) fail(`${fileName}: ${typeName} not found`);
  const openIndex = source.indexOf("{", declaration.index);
  if (openIndex === -1) {
    fail(
      `${fileName}: ${typeName} has no object body (expected a record type)`,
    );
  }
  const closeIndex = findMatchingBrace(source, openIndex);
  const body = source.slice(openIndex + 1, closeIndex);
  const bodyStartLine = lineAt(source, openIndex);
  const fields: ParsedField[] = [];
  let pendingDoc: string[] = [];
  let inDoc = false;

  for (const [offset, rawLine] of body.split("\n").entries()) {
    const line = rawLine.trim();
    const lineNumber = bodyStartLine + offset;
    if (line === "") continue;
    if (inDoc) {
      if (/^\*?\s*\*\/$/.test(line)) {
        inDoc = false;
        continue;
      }
      pendingDoc.push(normalizeDoc(line.replace(/^\*\s?/, "")));
      continue;
    }
    if (line.startsWith("/**")) {
      const sameLine = /^\/\*\*\s*(.*?)\s*\*\/$/.exec(line);
      if (sameLine !== null) {
        pendingDoc.push(normalizeDoc(sameLine[1] ?? ""));
      } else {
        inDoc = true;
        pendingDoc.push(normalizeDoc(line.replace(/^\/\*\*\s*/, "")));
      }
      continue;
    }
    if (line.startsWith("//")) {
      pendingDoc.push(normalizeDoc(line.replace(/^\/\/\s*/, "")));
      continue;
    }
    const match = PROPERTY_PATTERN.exec(line);
    if (match === null) {
      fail(
        `${fileName}:${lineNumber}: cannot parse ${typeName} property "${line}"`,
      );
    }
    const name = match[1];
    if (name === undefined)
      fail(`${fileName}:${lineNumber}: missing field name`);
    const optional = match[2] === "?";
    let typeText = (match[3] ?? "").trim();
    let inlineComment: string | null = null;
    const commentIndex = typeText.indexOf("//");
    if (commentIndex !== -1) {
      inlineComment = normalizeDoc(typeText.slice(commentIndex + 2));
      typeText = typeText.slice(0, commentIndex).trim();
    }
    if (typeText.endsWith(";")) typeText = typeText.slice(0, -1).trim();
    if (typeText === "") {
      fail(`${fileName}:${lineNumber}: ${typeName}.${name} has no type`);
    }
    const description =
      inlineComment !== null && inlineComment !== ""
        ? inlineComment
        : pendingDoc.length > 0
          ? normalizeDoc(pendingDoc.join(" "))
          : null;
    pendingDoc = [];
    fields.push({ name, optional, typeText, description });
  }
  return {
    name: typeName,
    fileName,
    startLine: lineAt(source, declaration.index),
    endLine: lineAt(source, closeIndex),
    fields,
  };
}

/** Parse `export type Name = "a" | "b" | ...;` into its string-literal values. */
function parseStringUnionAlias(
  source: string,
  fileName: string,
  aliasName: string,
): string[] {
  const match = new RegExp(`export\\s+type\\s+${aliasName}\\s*=`).exec(source);
  if (match === null) fail(`${fileName}: ${aliasName} alias not found`);
  const rest = source.slice(match.index + match[0].length);
  const semicolon = rest.indexOf(";");
  const bodyText = semicolon === -1 ? rest : rest.slice(0, semicolon);
  const values = Array.from(bodyText.matchAll(/"([^"\\]*)"/g), (entry) => {
    const value = entry[1];
    if (value === undefined) fail(`${fileName}: bad literal in ${aliasName}`);
    return value;
  });
  if (values.length === 0) {
    fail(`${fileName}: ${aliasName} has no string literals`);
  }
  const residual = bodyText.replace(/"[^"\\]*"/g, "").replace(/[|\s]/g, "");
  if (residual !== "") {
    fail(`${fileName}: ${aliasName} is not a pure string-literal union`);
  }
  return values;
}

/* -------------------------------------------------------------------------- */
/* TS type -> JSON Schema                                                     */
/* -------------------------------------------------------------------------- */

interface SchemaBuilderContext {
  readonly aliases: ReadonlyMap<string, readonly string[]>;
  readonly componentNameFor: (sourceTypeName: string) => string;
}

function isNamedSourceType(
  typeText: string,
  context: SchemaBuilderContext,
): boolean {
  return (
    /^[A-Z][A-Za-z0-9]*$/.test(typeText) &&
    context.componentNameFor(typeText) !== ""
  );
}

function typeToSchema(
  typeText: string,
  context: SchemaBuilderContext,
): JsonObject {
  const text = typeText.trim();
  if (text.endsWith("[]")) {
    const base = text.slice(0, -2).trim();
    return { type: "array", items: typeToSchema(base, context) };
  }
  const alias = context.aliases.get(text);
  if (alias !== undefined) return { type: "string", enum: [...alias] };
  const unionParts = text.split("|").map((part) => part.trim());
  if (unionParts.length > 1) {
    const knownValues: string[] = [];
    let hasFreeString = false;
    for (const part of unionParts) {
      const literal = /^"([^"\\]*)"$/.exec(part);
      if (literal !== null) {
        knownValues.push(literal[1] ?? "");
        continue;
      }
      if (part === "string") {
        hasFreeString = true;
        continue;
      }
      const aliasValues = context.aliases.get(part);
      if (aliasValues !== undefined) {
        knownValues.push(...aliasValues);
        continue;
      }
      fail(`unsupported union type "${text}" (part "${part}")`);
    }
    if (knownValues.length === 0 && hasFreeString) return { type: "string" };
    if (hasFreeString) {
      return {
        type: "string",
        description: `Wire value or free string. Known values: ${knownValues.join(" | ")}`,
      };
    }
    if (knownValues.length > 0) return { type: "string", enum: knownValues };
    fail(`unsupported union type "${text}"`);
  }
  switch (text) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "Record<string, string>":
      return { type: "object", additionalProperties: { type: "string" } };
    default:
      break;
  }
  if (isNamedSourceType(text, context)) {
    return { $ref: `#/components/schemas/${context.componentNameFor(text)}` };
  }
  return fail(`unsupported TypeScript type "${text}"`);
}

interface ComponentTypeSpec {
  readonly sourceType: string;
  readonly componentName: string;
  readonly source: string;
  readonly fileName: string;
  readonly description: string;
}

function buildSchemaFromType(
  spec: ComponentTypeSpec,
  context: SchemaBuilderContext,
): JsonObject {
  const parsed = parseTypeDeclaration(
    spec.source,
    spec.fileName,
    spec.sourceType,
  );
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of parsed.fields) {
    const schema = typeToSchema(field.typeText, context);
    if (field.description !== null && field.description !== "") {
      schema.description = field.description;
    }
    properties[field.name] = schema;
    if (!field.optional) required.push(field.name);
  }
  // Cite the declaration, not a line range: a line citation is invalidated by any edit above
  // the type, and this file's own regeneration then churns for no semantic reason.
  const schema: JsonObject = {
    type: "object",
    description: `${spec.description} Parsed from ${spec.fileName}#${spec.sourceType}.`,
    properties,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

/* -------------------------------------------------------------------------- */
/* Catalog fixture validation + schema assembly                               */
/* -------------------------------------------------------------------------- */

interface CatalogFixture {
  readonly provider: string;
  readonly capturedAt: string;
  readonly periodsCapturedAt: string;
  readonly sportCount: number;
  readonly subSportCount: number;
  readonly sportPeriodCount: number;
  readonly sports: readonly {
    readonly sport: string;
    readonly subSports: readonly unknown[];
    readonly periods: readonly unknown[];
  }[];
  readonly collisions: readonly {
    readonly code: string;
    readonly sports: readonly string[];
  }[];
}

function parseCatalogFixture(raw: unknown): CatalogFixture {
  if (!isRecord(raw)) fail("catalog fixture must be an object");
  if (!Array.isArray(raw.sports))
    fail("catalog fixture sports must be an array");
  if (!Array.isArray(raw.collisions)) {
    fail("catalog fixture collisions must be an array");
  }
  return {
    provider: asString(raw.provider, "catalog.provider"),
    capturedAt: asString(raw.capturedAt, "catalog.capturedAt"),
    periodsCapturedAt: asString(
      raw.periodsCapturedAt,
      "catalog.periodsCapturedAt",
    ),
    sportCount: asNumber(raw.sportCount, "catalog.sportCount"),
    subSportCount: asNumber(raw.subSportCount, "catalog.subSportCount"),
    sportPeriodCount: asNumber(
      raw.sportPeriodCount,
      "catalog.sportPeriodCount",
    ),
    sports: raw.sports.map((entry, index) => {
      if (!isRecord(entry)) fail(`catalog.sports[${index}] must be an object`);
      if (!Array.isArray(entry.subSports)) {
        fail(`catalog.sports[${index}].subSports must be an array`);
      }
      if (!Array.isArray(entry.periods)) {
        fail(`catalog.sports[${index}].periods must be an array`);
      }
      return {
        sport: asString(entry.sport, `catalog.sports[${index}].sport`),
        subSports: entry.subSports,
        periods: entry.periods,
      };
    }),
    collisions: raw.collisions.map((entry, index) => {
      if (!isRecord(entry))
        fail(`catalog.collisions[${index}] must be an object`);
      if (!Array.isArray(entry.sports)) {
        fail(`catalog.collisions[${index}].sports must be an array`);
      }
      return {
        code: asString(entry.code, `catalog.collisions[${index}].code`),
        sports: entry.sports.map((sport, sportIndex) =>
          asString(sport, `catalog.collisions[${index}].sports[${sportIndex}]`),
        ),
      };
    }),
  };
}

function validateCatalogFixture(fixture: CatalogFixture): {
  readonly computedSubSports: number;
  readonly computedPeriods: number;
} {
  const computedSubSports = fixture.sports.reduce(
    (total, sport) => total + sport.subSports.length,
    0,
  );
  const computedPeriods = fixture.sports.reduce(
    (total, sport) => total + sport.periods.length,
    0,
  );
  const checks: readonly [string, number, number][] = [
    ["sportCount", fixture.sportCount, fixture.sports.length],
    ["subSportCount", fixture.subSportCount, computedSubSports],
    ["sportPeriodCount", fixture.sportPeriodCount, computedPeriods],
  ];
  for (const [field, declared, computed] of checks) {
    if (declared !== computed) {
      fail(
        `catalog fixture drift: ${field}=${declared} but the tree contains ${computed}`,
      );
    }
  }
  if (fixture.collisions.length !== 2) {
    fail(
      `catalog fixture collision registry has ${fixture.collisions.length} ids, expected 2 (Arena, NCAA Extra)`,
    );
  }
  if (fixture.capturedAt > fixture.periodsCapturedAt) {
    fail(
      "catalog fixture timestamps are inverted (capturedAt after periodsCapturedAt)",
    );
  }
  return { computedSubSports, computedPeriods };
}

function buildCatalogSchema(
  context: SchemaBuilderContext,
  fixture: CatalogFixture,
  counts: {
    readonly computedSubSports: number;
    readonly computedPeriods: number;
  },
): JsonObject {
  const base = buildSchemaFromType(
    {
      sourceType: "Fantasy402SportCatalog",
      componentName: "Fantasy402SportCatalog",
      source: readArtifact(CATALOG_TYPE_SOURCE_REL),
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Fantasy402 desk navigation catalog (sub-sport lanes plus per-sport period menus). Reference metadata only, not an ingestion audit record. Surface: surface.fantasy402-sport-catalog (tier D).",
    },
    context,
  );
  base["x-fixture"] = {
    path: "tests/fixtures/fantasy402-sport-catalog-2026-10-21.json",
    provider: fixture.provider,
    capturedAt: fixture.capturedAt,
    periodsCapturedAt: fixture.periodsCapturedAt,
    sportCount: fixture.sports.length,
    subSportCount: counts.computedSubSports,
    sportPeriodCount: counts.computedPeriods,
    collisionIds: fixture.collisions.map((collision) => collision.code),
    caveat:
      "Committed SSOT sample, not a raw wire capture. capturedAt/periodsCapturedAt are fixture-declared.",
  };
  return base;
}

/* -------------------------------------------------------------------------- */
/* Operation builders                                                         */
/* -------------------------------------------------------------------------- */

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(method);
}

function operationIdFor(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      segment
        .split(/[^A-Za-z0-9]+/)
        .filter((token) => token !== "")
        .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
        .join(""),
    )
    .filter((segment) => segment !== "");
  return `${method}${segments.join("")}`;
}

function evidenceOf(operation: LedgerOperation): JsonObject {
  const evidence: JsonObject = {
    tier: operation.tier,
    sources: operation.evidence.map((entry) => entry.source),
    capturedResponse: operation.capturedResponse,
  };
  if (operation.requiredCapture !== null) {
    evidence.requiredCapture = operation.requiredCapture;
  }
  if (operation.contradicted) evidence.contradicted = true;
  if (operation.candidateUrl) evidence.candidateUrl = true;
  return evidence;
}

function evidenceFromSurface(
  surface: LedgerSurface,
  requiredCapture: string,
): JsonObject {
  return {
    tier: surface.tier,
    sources: surface.evidence.map((entry) => entry.source),
    capturedResponse: false,
    requiredCapture,
  };
}

function daemonErrorSchema(): JsonObject {
  return {
    type: "object",
    required: ["success", "error"],
    properties: {
      success: { type: "boolean", const: false },
      error: { type: "string" },
    },
  };
}

function daemonHeaders(): JsonObject {
  return {
    "Content-Security-Policy": { $ref: "#/components/headers/CSPHeader" },
    "X-Content-Type-Options": {
      $ref: "#/components/headers/XContentTypeOptionsHeader",
    },
    "Referrer-Policy": {
      $ref: "#/components/headers/ReferrerPolicyHeader",
    },
  };
}

function daemonSuccessResponse(
  description: string,
  schema: JsonObject,
): JsonObject {
  return {
    description,
    headers: daemonHeaders(),
    content: { "application/json": { schema } },
  };
}

function adminRejectionResponses(): JsonObject {
  return {
    "401": {
      description:
        "Missing or wrong admin token (services/sportsdesk_webview_server.ts:156-175).",
      headers: daemonHeaders(),
      content: { "application/json": { schema: daemonErrorSchema() } },
    },
    "503": {
      description:
        "SPORTSDESK_ADMIN_TOKEN is not set on the server (services/sportsdesk_webview_server.ts:31-37).",
      headers: daemonHeaders(),
      content: { "application/json": { schema: daemonErrorSchema() } },
    },
  };
}

function inferredDescription(operation: LedgerOperation): string {
  const candidate = operation.candidateUrl;
  const repoTypeSources = operation.evidence
    .filter((entry) => entry.kind === "repo-type")
    .map((entry) => entry.source);
  const candidateClause = candidate
    ? "The path and method are candidate values inferred from a UI/DOM observation; they were never observed on the wire. "
    : "The path, method and any previously published field schema were authored in the prior hand-built spec or its generators; no request or response artifact exists in this repository. ";
  const repoTypeComponent = REPO_TYPE_COMPONENTS[operation.path];
  const repoTypeClause =
    repoTypeSources.length > 0
      ? `Repo type evidence: ${repoTypeSources.join(", ")} (a consumer type declaration, not a capture).${
          repoTypeComponent !== undefined
            ? ` See the ${repoTypeComponent} component; it records the field names only and is not used as a response schema here.`
            : ""
        } `
      : "";
  const tileClause =
    TRACKED_TILE_METADATA[operation.path] !== undefined
      ? "The launcher-tile DOM metadata (x-dom-tile, x-dom-selector, x-extracted-inputs) is UI observation only and must not be read as wire parameters. "
      : "";
  return (
    "UNVERIFIED — no capture exists. " +
    candidateClause +
    repoTypeClause +
    tileClause +
    "The request body and the response body/status codes are unknown, so no request schema and no response content are published here."
  );
}

function inferredOperation(
  operation: LedgerOperation,
  summary: string,
): JsonObject {
  const builder: JsonObject = {
    tags: [TAG_INFERRED],
    summary,
    description: inferredDescription(operation),
    operationId: operationIdFor(operation.method, operation.path),
    responses: {
      default: {
        description:
          "Unknown — no response was captured, so no status code or body schema is documented.",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
  const tile = TRACKED_TILE_METADATA[operation.path];
  if (tile !== undefined) {
    builder["x-discovery-status"] = "UNDER_SURVEILLANCE";
    builder["x-dom-tile"] = tile.domTile;
    builder["x-dom-selector"] = tile.domSelector;
    builder["x-extracted-inputs"] = [...tile.extractedInputs];
    builder["x-data-language-keys"] = [...tile.languageKeys];
  }
  return builder;
}

function getWebLogOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_FORENSIC],
    summary:
      "Manager getWebLog (mode B request observed; response not captured)",
    description:
      "The forensic IP-investigation endpoint (operational_guardrails_runbook.md §5.1.1). Request side: a 2026-10-28 Manager HAR (portal v1.0.279) captured one mode-B POST with a form-urlencoded body and no Authorization header, so the 2026-10-28 session was cookie-based. Only mode B was captured; modes A, C and I are inferred from the portal form and still need a capture. Response side: no response body was captured, so the row schema is undocumented and none is published here. The WeblogEntry component (simulate_bettor_churn_suite.ts#RawWebLogEntry) records the four fields the old spec published, but a consumer type is not a capture, so it is not used as a response schema.",
    operationId: operationIdFor(operation.method, operation.path),
    parameters: [{ $ref: "#/components/parameters/XRequestedWith" }],
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            required: [
              "agentID",
              "customerID",
              "start",
              "end",
              "type",
              "actions",
              "ip",
              "operation",
              "RRO",
              "agentOwner",
            ],
            properties: {
              agentID: {
                type: "string",
                description:
                  "Session master agent; the captured value is redacted here.",
                example: "<redacted>",
              },
              customerID: {
                type: "string",
                description:
                  "0 = whole book. Mode C should carry the target account (unverified).",
                example: "0",
              },
              start: {
                type: "string",
                description:
                  "Inclusive start date. Observed as MM/DD/YYYY in mode B; mode C reportedly sends YYYY-MM-DD (unverified).",
                example: "10/28/2026",
              },
              end: {
                type: "string",
                description:
                  "Inclusive end date. Observed as MM/DD/YYYY in mode B; mode C reportedly sends YYYY-MM-DD (unverified).",
                example: "10/28/2026",
              },
              type: {
                type: "string",
                enum: ["A", "B", "C", "I"],
                description:
                  "A: web access log; B: global IP matcher; C: account IP match; I: users by IP. Only B was captured; A, C and I are inferred.",
              },
              actions: {
                type: "string",
                enum: ["ALL"],
                description:
                  "Action filter. ALL was observed; other values are unobserved.",
                example: "ALL",
              },
              ip: {
                type: "string",
                description:
                  "Empty in the observed mode-B request; mode I should carry the IP or /24 prefix (unverified).",
                example: "",
              },
              operation: {
                type: "string",
                enum: ["getWebLog"],
                description: "Echo of the method name.",
              },
              RRO: {
                type: "string",
                enum: ["1"],
                description: "Observed as 1; the meaning is unknown.",
              },
              agentOwner: {
                type: "string",
                description:
                  "Session master agent; the captured value is redacted here.",
                example: "<redacted>",
              },
            },
          },
        },
      },
    },
    security: [{ fantasy402Cookie: [] }],
    responses: {
      "200": {
        description: "Response body was not captured; row schema undocumented",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
}

function getAgentPerformanceOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DOWNLINE],
    summary:
      "Agent performance report (request observed; response not captured)",
    description:
      "Request observed 2026-11-01 on the agent-performance screen: a form-urlencoded POST whose fields are published below in wire order (tests/fixtures/f402-report-requests-observed-2026-11-01.json). Three calls were seen — CP and CPS report kinds — and two details matter: `sport` is padded to 20 characters, and `tipo` is not a constant (0 for CP, -1 for CPS). No response body was ever observed, so no response schema is published and nothing here describes the report's columns.",
    operationId: operationIdFor(operation.method, operation.path),
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            required: [
              "start",
              "end",
              "agentID",
              "type",
              "freePlay",
              "store",
              "sport",
              "subsport",
              "period",
              "wagerType",
              "betType",
              "tipo",
              "debug",
              "operation",
              "RRO",
              "agentOwner",
            ],
            properties: {
              start: { type: "string", description: "M/D/YYYY." },
              end: { type: "string", description: "M/D/YYYY." },
              agentID: { type: "string" },
              type: {
                type: "string",
                description:
                  "Report kind: CP (customer performance) or CPS (sport performance) observed.",
              },
              freePlay: { type: "string", enum: ["Y", "N"] },
              store: {
                type: "string",
                description: "Equals agentID in every observed call.",
              },
              sport: {
                type: "string",
                description:
                  "Sport name padded with spaces to exactly 20 characters (Football, Auto Racing, Tennis, LIVE).",
                minLength: 20,
                maxLength: 20,
              },
              subsport: {
                type: "string",
                description:
                  "Catalog sub-sport code (NFL, NCAAF Live, …); empty string when unfiltered.",
              },
              period: {
                type: "string",
                description:
                  "Portal period number for that sport, or -1 for all periods. LIVE's menu has only 0 (Game).",
              },
              wagerType: {
                type: "string",
                description: "Raw portal code; empty when unfiltered.",
              },
              betType: {
                type: "string",
                description: "Raw portal code; empty when unfiltered.",
              },
              tipo: {
                type: "string",
                description:
                  "Observed as 0 for CP and -1 for CPS; not a constant.",
              },
              debug: { type: "string", enum: ["0"] },
              operation: { type: "string", enum: ["getAgentPerformance"] },
              RRO: { type: "string", enum: ["1"] },
              agentOwner: { type: "string" },
            },
          },
        },
      },
    },
    security: [{ fantasy402Cookie: [] }],
    responses: {
      default: {
        description:
          "Unknown — no response body was observed; no status code or body schema is documented.",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
}

function getInfoPlayerOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_CUSTOMER],
    summary: "Manager getInfoPlayer (request observed; response not captured)",
    description:
      "Read observed in the 2026-10-28 Manager HAR: opening a player sent a form POST with a 7-character trimmed customerID (e.g. CB112_1, not the padded 11-character form the old spec showed), and agentID/agentOwner were the logged-in master on all 19 Manager calls (docs/runbooks/operational_guardrails_runbook.md:213-214). The response was not captured, so no response schema is published. Ledger contradicted: the prior spec's padded example is refuted by the capture.",
    operationId: operationIdFor(operation.method, operation.path),
    requestBody: {
      required: true,
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            additionalProperties: true,
            description:
              "Opaque: a form POST was observed, but only the trimmed customerID and master agentID/agentOwner values are recorded for this call, so the full field list is not published.",
          },
        },
      },
    },
    security: [{ fantasy402Cookie: [] }],
    responses: {
      default: {
        description:
          "Unknown — the response body was not captured; no status code or body schema is documented.",
      },
    },
    "x-evidence": evidenceOf(operation),
  };
}

function healthOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Daemon health and telemetry probe",
    description:
      "Handler-defined contract: services/sportsdesk_webview_server.ts:140-157 returns the daemon's status, bound port/hostname, Bun-reported URL, timestamp, uptime, runtime and NODE_ENV. Verified against the handler source, not an HTTP capture. The daemon binds 0.0.0.0 by default (services/sportsdesk_webview_server.ts:9,345), so the example hostname is 0.0.0.0; the http://127.0.0.1:4020 server target is a loopback client view of that bind.",
    operationId: operationIdFor(operation.method, operation.path),
    responses: {
      "200": daemonSuccessResponse("Healthy daemon status", {
        type: "object",
        required: [
          "status",
          "port",
          "hostname",
          "url",
          "timestamp",
          "uptimeSeconds",
          "runtime",
          "nodeEnv",
        ],
        properties: {
          status: { type: "string", example: "healthy" },
          port: {
            type: "integer",
            description: "Bound port; PORT defaults to 4020.",
            example: 4020,
          },
          hostname: {
            type: "string",
            description:
              "Bound hostname. Bun serves on all interfaces by default (0.0.0.0).",
            example: "0.0.0.0",
          },
          url: {
            type: "string",
            description:
              "server.url as reported by Bun; with hostname 0.0.0.0 the daemon is reachable on all interfaces.",
            example: "http://0.0.0.0:4020/",
          },
          timestamp: {
            type: "string",
            format: "date-time",
            example: "2026-10-30T00:00:00.000Z",
          },
          uptimeSeconds: { type: "integer", example: 1240 },
          runtime: { type: "string", example: "Bun v1.4.4" },
          nodeEnv: { type: "string", example: "production" },
        },
      }),
    },
    "x-evidence": evidenceOf(operation),
  };
}

function watchlistOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Monitored watch-list accounts",
    description:
      "Returns {success, count, data} from telegramService.getWatchList() (services/sportsdesk_webview_server.ts:1435-1438). Requires Authorization: Bearer <SPORTSDESK_ADMIN_TOKEN>; adminRejection returns 503 when the token is unset and 401 otherwise (services/sportsdesk_webview_server.ts:156-175).",
    operationId: operationIdFor(operation.method, operation.path),
    security: [{ daemonBearer: [] }],
    responses: {
      "200": daemonSuccessResponse("Watch-list snapshot", {
        type: "object",
        required: ["success", "count", "data"],
        properties: {
          success: { type: "boolean", const: true },
          count: { type: "integer" },
          data: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              description:
                "Opaque watch-list entry owned by sportsdesk_telegram_bot.ts; its shape was not captured.",
            },
          },
        },
      }),
      ...adminRejectionResponses(),
    },
    "x-evidence": evidenceOf(operation),
  };
}

function telegramAlertOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Dispatch an instant Telegram alert",
    description:
      "Request body {customerId?} defaults to RF2003; dispatches through telegramService.dispatchTestAlert and returns {success, ok, customerId} (services/sportsdesk_webview_server.ts:275-300). Admin-token gated (services/sportsdesk_webview_server.ts:201-212).",
    operationId: operationIdFor(operation.method, operation.path),
    security: [{ daemonBearer: [] }],
    requestBody: {
      required: false,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              customerId: {
                type: "string",
                description: "Customer to alert; defaults to RF2003.",
                example: "RF2003",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": daemonSuccessResponse("Alert dispatch result", {
        type: "object",
        required: ["success", "ok", "customerId"],
        properties: {
          success: { type: "boolean" },
          ok: {
            type: "boolean",
            description: "Whether Telegram accepted the alert.",
          },
          customerId: { type: "string" },
        },
      }),
      "500": {
        description:
          "Dispatch threw (services/sportsdesk_webview_server.ts:290-299).",
        headers: daemonHeaders(),
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["success", "ok", "error"],
              properties: {
                success: { type: "boolean", const: false },
                ok: { type: "boolean", const: false },
                error: { type: "string" },
              },
            },
          },
        },
      },
      ...adminRejectionResponses(),
    },
    "x-evidence": evidenceOf(operation),
  };
}

function telegramReportOperation(operation: LedgerOperation): JsonObject {
  return {
    tags: [TAG_DAEMON],
    summary: "Trigger a scheduled Telegram report",
    description:
      "Report type is selected by the ?type= query parameter and defaults to EVENING_SETTLEMENT; the handler validates it with isReportType and returns {success, ok, reportType} (services/sportsdesk_webview_server.ts:312-332). REPORT_TYPES are MORNING_BRIEFING, MIDDAY_STEAM and EVENING_SETTLEMENT (services/sportsdesk_telegram_bot.ts:77-81). Admin-token gated (services/sportsdesk_webview_server.ts:201-212).",
    operationId: operationIdFor(operation.method, operation.path),
    security: [{ daemonBearer: [] }],
    parameters: [
      {
        name: "type",
        in: "query",
        required: false,
        description:
          "Report type; defaults to EVENING_SETTLEMENT when absent (services/sportsdesk_webview_server.ts:313).",
        schema: {
          type: "string",
          enum: ["MORNING_BRIEFING", "MIDDAY_STEAM", "EVENING_SETTLEMENT"],
          default: "EVENING_SETTLEMENT",
        },
      },
    ],
    responses: {
      "200": daemonSuccessResponse("Report dispatch result", {
        type: "object",
        required: ["success", "ok", "reportType"],
        properties: {
          success: { type: "boolean" },
          ok: {
            type: "boolean",
            description: "Whether Telegram accepted the report.",
          },
          reportType: {
            type: "string",
            enum: ["MORNING_BRIEFING", "MIDDAY_STEAM", "EVENING_SETTLEMENT"],
          },
        },
      }),
      "400": {
        description:
          "type is not one of REPORT_TYPES (services/sportsdesk_webview_server.ts:314-322).",
        headers: daemonHeaders(),
        content: { "application/json": { schema: daemonErrorSchema() } },
      },
      ...adminRejectionResponses(),
    },
    "x-evidence": evidenceOf(operation),
  };
}

const B_OPERATION_BUILDERS: Readonly<
  Record<string, (operation: LedgerOperation) => JsonObject>
> = {
  "/cloud/api/Manager/getAgentPerformance": getAgentPerformanceOperation,
  "/cloud/api/Manager/getWebLog": getWebLogOperation,
  "/cloud/api/Manager/getInfoPlayer": getInfoPlayerOperation,
  "/health": healthOperation,
  "/api/watchlist": watchlistOperation,
  "/api/telegram/alert": telegramAlertOperation,
  "/api/telegram/report": telegramReportOperation,
};

/* -------------------------------------------------------------------------- */
/* Tier D surface operations                                                  */
/* -------------------------------------------------------------------------- */

/** Uppercase HTTP method on a surface spec; mapped to the lowercase path-item key at build time. */
type SurfaceHttpMethod = "GET" | "POST";

/** Map an uppercase surface method to its OpenAPI path-item key (always lowercase). */
function pathItemMethod(httpMethod: SurfaceHttpMethod): HttpMethod {
  switch (httpMethod) {
    case "GET":
      return "get";
    case "POST":
      return "post";
    default:
      return fail(`unsupported surface HTTP method "${String(httpMethod)}"`);
  }
}

interface SurfaceOperationSpec {
  readonly path: string;
  readonly httpMethod: SurfaceHttpMethod;
  readonly surfaceId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly requiredCapture: string;
  readonly responses: JsonObject;
  readonly requestBody?: JsonObject;
  /** Path-item parameters (only the wildcard surfaces need them). */
  readonly parameters?: readonly JsonObject[];
}

function htmlResponse(description: string, contentType: string): JsonObject {
  return {
    description,
    headers: daemonHeaders(),
    content: {
      [contentType]: {
        schema: {
          type: "string",
          description: "Static HTML document served from disk by the daemon.",
        },
      },
    },
  };
}

/** Response object for a handler-verified JSON route: described fields, no captured body. */
function jsonSurfaceResponse(
  description: string,
  properties: JsonObject,
): JsonObject {
  return {
    description,
    headers: daemonHeaders(),
    content: {
      "application/json": {
        schema: { type: "object", properties },
      },
    },
  };
}

function surfaceOperationSpecs(
  ledger: Ledger,
): readonly SurfaceOperationSpec[] {
  const historySurface = findSurface(ledger, "surface.manager-getHistory");
  return [
    {
      path: "/cloud/api/Manager/getHistory",
      httpMethod: "POST",
      surfaceId: historySurface.id,
      tag: TAG_SETTLEMENT,
      summary:
        "Manager getHistory (wired settlement-history poll; no response capture)",
      description:
        "The only upstream Fantasy402 route in this repository with a real fetch client: resolveHistoryPollUrl builds `${SPORTSDESK_PORTAL_HTTP_BASE}/cloud/api/Manager/getHistory` and pollManagerGetHistory POSTs with no request body (lib/fantasy402_settlement_ingest.ts:347-368). The response must be a JSON array or {data: []} or the poll throws (lib/fantasy402_settlement_ingest.ts:369-387). The request contract (agent scope, date window, auth) is therefore unknown, and row field shapes are not captured; tests/fixtures/fantasy402-history-poll.json is a placeholder shape sample. Surface: surface.manager-getHistory (tier D).",
      requiredCapture:
        "Capture one getHistory request/response (redacted) to record the upstream request contract (body/agent scope/date window/auth) and a real response body; this repo only proves the URL, the bodyless POST and the array-or-{data:[]} acceptance.",
      responses: {
        "200": {
          description:
            "JSON array of raw settlement rows, or an object with a data array. Any other shape throws (lib/fantasy402_settlement_ingest.ts:374-387). Row fields are not captured, so only raw/unknown objects are described.",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: true,
                      description:
                        "Raw settlement row; the poll types rows as Record<string, unknown> and no field shapes were captured.",
                    },
                  },
                  {
                    type: "object",
                    required: ["data"],
                    properties: {
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: true,
                          description:
                            "Raw settlement row; field shapes not captured.",
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        default: {
          description:
            "Non-2xx status is not captured; the poll throws on !res.ok (lib/fantasy402_settlement_ingest.ts:369-371).",
        },
      },
    },
    {
      path: "/miniapp",
      httpMethod: "GET",
      surfaceId: "surface.daemon-miniapp",
      tag: TAG_DAEMON,
      summary: "Telegram Mini App dashboard (GET /miniapp)",
      description:
        "Serves telegram-miniapp-dashboard.html as text/html (services/sportsdesk_webview_server.ts:170-177) with Telegram frame-ancestors CSP and no X-Frame-Options (services/sportsdesk_webview_server.ts:87-90). GET /miniapp/ is an alias. Surface: surface.daemon-miniapp (tier D).",
      requiredCapture:
        "HTTP capture of the served /miniapp HTML (the route is handler-verified only; no HTTP response was captured).",
      responses: {
        "200": htmlResponse(
          "Mini App dashboard HTML with the daemon CORS/CSP headers.",
          "text/html",
        ),
      },
    },
    {
      path: "/dashboard",
      httpMethod: "GET",
      surfaceId: "surface.daemon-dashboard",
      tag: TAG_DAEMON,
      summary: "Operator dashboard (GET /dashboard)",
      description:
        "Serves customer-churn-simulation-dashboard.html as text/html (services/sportsdesk_webview_server.ts:160-167). The same handler also answers GET /; the root path is not modelled as an OpenAPI path because the ledger has no dedicated surface row for it. Surface: surface.daemon-dashboard (tier D).",
      requiredCapture:
        "HTTP capture of the served /dashboard HTML (the route is handler-verified only; no HTTP response was captured).",
      responses: {
        "200": htmlResponse(
          "Operator dashboard HTML with the daemon CORS/CSP headers.",
          "text/html",
        ),
      },
    },
    {
      path: "/api/live-bets",
      httpMethod: "GET",
      surfaceId: "surface.daemon-live-bets",
      tag: TAG_DAEMON,
      summary: "Live bets derived from captured Report/Pending rows",
      description:
        "Derives the scoreboard payload from real wager rows (sportsdesk_webview_server.ts#GET /api/live-bets) using lib/live_bets.ts, which strips Password/NameFirst/Login by name and keeps amounts in integer cents. Non-loopback peers must present SPORTSDESK_ADMIN_TOKEN (piiRejection, services/sportsdesk_webview_server.ts:146-153); a unix-socket listener counts every peer as proxied and requires the token unless the deployment sets SPORTSDESK_TRUST_PROXY=1. Scores are joined from the transcribed scoreboard, the sport category from lib/sport_taxonomy.ts, and the position label from lib/game_admin.ts. Surface: surface.daemon-live-bets (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/live-bets against a real Report/Pending capture (the route is handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse(
          "Games, agent rollup and the aggregates derived from them.",
          {
            games: { type: "array", items: { type: "object" } },
            agents: { type: "object" },
            pendingCount: { type: "integer" },
            summary: { type: "object" },
            scoreboard: { type: "object", nullable: true },
            sports: { type: "object" },
            generatedAt: { type: "string", format: "date-time" },
          },
        ),
      },
    },
    {
      path: "/api/live-bets/summary",
      httpMethod: "GET",
      surfaceId: "surface.daemon-live-bets",
      tag: TAG_DAEMON,
      summary: "Aggregates only, without the game list",
      description:
        "Same aggregates as GET /api/live-bets, computed from the same rows in the same request (sportsdesk_webview_server.ts#GET /api/live-bets/summary), so the two responses cannot disagree. Totals are derived, never stored. Surface: surface.daemon-live-bets (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/live-bets/summary (handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse("Derived totals with their data source.", {
          success: { type: "boolean" },
          summary: { type: "object" },
          generatedAt: { type: "string", format: "date-time" },
        }),
      },
    },
    {
      path: "/api/agent-tree",
      httpMethod: "GET",
      surfaceId: "surface.daemon-agent-tree",
      tag: TAG_DAEMON,
      summary: "Agent hierarchy joined with the wager rollup",
      description:
        "Serves data/agent-tree.json plus per-agent exposure (sportsdesk_webview_server.ts#GET /api/agent-tree). The tree is built by scripts/build_agent_tree.ts from the portal's own baseHeriarchy parent pointers; keys are canonical agentLoginKey values, and keys owned by more than one AgentID are flagged rather than levelled. Non-loopback peers must present SPORTSDESK_ADMIN_TOKEN; proxied peers need it too unless SPORTSDESK_TRUST_PROXY=1. Surface: surface.daemon-agent-tree (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/agent-tree (handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse(
          "Parent-keyed agent forest with per-agent wager counts.",
          {
            schemaVersion: { type: "integer" },
            source: { type: "string" },
            agentCount: { type: "integer" },
            roots: { type: "array", items: { type: "string" } },
            collisions: { type: "array", items: { type: "object" } },
            nodes: { type: "object" },
            counts: { type: "object" },
          },
        ),
        "404": jsonSurfaceResponse(
          "No tree built; run bun run build:agent-tree.",
          { error: { type: "string" } },
        ),
      },
    },
    {
      path: "/api/scoreboard",
      httpMethod: "GET",
      surfaceId: "surface.daemon-scoreboard",
      tag: TAG_DAEMON,
      summary: "Transcribed portal scoreboard (games, scores, status)",
      description:
        "Serves data/scoreboard.json with a status summary (sportsdesk_webview_server.ts#GET /api/scoreboard). The games are transcribed from the manager page, not captured from an API, so the payload carries source and observedAt. Surface: surface.daemon-scoreboard (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/scoreboard (handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse("Scoreboard rows with status counts.", {
          schemaVersion: { type: "integer" },
          source: { type: "string" },
          observedAt: { type: "string", nullable: true },
          notes: { type: "array", items: { type: "string" } },
          games: { type: "array", items: { type: "object" } },
          summary: { type: "object" },
        }),
        "404": jsonSurfaceResponse("No scoreboard file present.", {
          error: { type: "string" },
        }),
      },
    },
    {
      path: "/api/sports",
      httpMethod: "GET",
      surfaceId: "surface.daemon-sports-taxonomy",
      tag: TAG_DAEMON,
      summary: "Portal sport taxonomy with counts per category",
      description:
        "Returns the 18 portal categories plus counts for the loaded wagers and the scoreboard (sportsdesk_webview_server.ts#GET /api/sports). All Sports is the absence of a filter and LIVE is a state, so neither is a category. Surface: surface.daemon-sports-taxonomy (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/sports (handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse(
          "Taxonomy and the counts observed per category.",
          {
            success: { type: "boolean" },
            liveFilter: { type: "string" },
            all: { type: "array", items: { type: "string" } },
            wagers: { type: "array", items: { type: "object" } },
            scoreboard: { type: "array", items: { type: "object" } },
          },
        ),
      },
    },
    {
      path: "/api/game-admin",
      httpMethod: "GET",
      surfaceId: "surface.daemon-game-admin",
      tag: TAG_DAEMON,
      summary: "Exposure per fixture with a Straight/Parlay/Teaser split",
      description:
        "The portal manual's Game Admin report (v1.0.280, F.A.Q. #4) reduced to exposure per fixture and position (sportsdesk_webview_server.ts#GET /api/game-admin). preGame is computed from gameDateTime against the request clock and is a fact about the fixture, not a claim about the operator's delete permission. Surface: surface.daemon-game-admin (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/game-admin (handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse(
          "Fixtures ordered by exposure, with positions.",
          {
            success: { type: "boolean" },
            source: { type: "string" },
            games: { type: "array", items: { type: "object" } },
            generatedAt: { type: "string", format: "date-time" },
          },
        ),
      },
    },
    {
      path: "/api/analysis",
      httpMethod: "GET",
      surfaceId: "surface.daemon-analysis",
      tag: TAG_DAEMON,
      summary: "Analysis report, or the reason it is not captured",
      description:
        "Validates the portal's filter vocabulary (services/sportsdesk_webview_server.ts#GET /api/analysis) and answers 200 only when a transcribed report matches the selection; otherwise 501 with the required capture. A 200 carries the rows, the published totals, a recomputed copy and a discrepancies array, so a transcription slip is visible rather than served as fact. Surface: surface.daemon-analysis (tier D).",
      requiredCapture:
        "Only the response of POST /cloud/api/Manager/getAgentPerformance is missing. The request is observed (2026-11-01, type=CP and CPS) and lib/f402_agent_performance_request.ts reproduces it byte for byte; no response body has ever been seen, so no column set is documented. Today a single Customer Performance result (Baseball, agent BILLY666, 2026-11-01) is transcribed from an operator paste.",
      responses: {
        "200": jsonSurfaceResponse("A transcribed analysis report.", {
          success: { type: "boolean" },
          available: { type: "boolean" },
          rows: { type: "array", items: { type: "object" } },
          totals: { type: "object" },
          recomputed: { type: "object" },
          discrepancies: { type: "array", items: { type: "object" } },
        }),
        "501": jsonSurfaceResponse(
          "No transcribed report matches this selection.",
          { success: { type: "boolean" }, requiredCapture: { type: "string" } },
        ),
      },
    },
    {
      path: "/api/analysis/filters",
      httpMethod: "GET",
      surfaceId: "surface.daemon-analysis",
      tag: TAG_DAEMON,
      summary: "Analysis filter vocabulary transcribed from report.js",
      description:
        "Returns the report kinds (CP/CPS/CPV/G), the fourteen activity codes, the two group modes and the four week windows, with their provenance and the required capture (services/sportsdesk_webview_server.ts#GET /api/analysis/filters). Surface: surface.daemon-analysis (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/analysis/filters (handler-verified only).",
      responses: {
        "200": jsonSurfaceResponse("Filter vocabulary with provenance.", {
          success: { type: "boolean" },
          captured: { type: "boolean" },
          reports: { type: "array", items: { type: "object" } },
          activities: { type: "array", items: { type: "object" } },
          groups: { type: "array", items: { type: "object" } },
          weeks: { type: "array", items: { type: "object" } },
        }),
      },
    },
    {
      path: "/api/analysis/reports",
      httpMethod: "GET",
      surfaceId: "surface.daemon-analysis",
      tag: TAG_DAEMON,
      summary: "Transcribed analysis reports and their recorded context",
      description:
        "Lists each stored result with the selection it was run under, so a client can select one instead of reconstructing the filters (services/sportsdesk_webview_server.ts:707-735). Surface: surface.daemon-analysis (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/analysis/reports (handler-verified only).",
      responses: {
        "200": jsonSurfaceResponse("Stored reports with context.", {
          success: { type: "boolean" },
          count: { type: "integer" },
          reports: { type: "array", items: { type: "object" } },
        }),
      },
    },
    {
      path: "/api/agents/search",
      httpMethod: "GET",
      surfaceId: "surface.daemon-agent-search",
      tag: TAG_DAEMON,
      summary: "Agent lookup over the committed hierarchy",
      description:
        "Case-insensitive prefix-first search over data/agent-tree.json (services/sportsdesk_webview_server.ts#GET /api/analysis/reports). Requires q of at least two characters and clamps limit to 100. Loopback-gated, because agent names are identity data. Surface: surface.daemon-agent-search (tier D).",
      requiredCapture:
        "Not a capture gap: the tree is committed and the handler is the contract.",
      responses: {
        "200": jsonSurfaceResponse("Matching agents with their level.", {
          success: { type: "boolean" },
          query: { type: "string" },
          count: { type: "integer" },
          agents: { type: "array", items: { type: "object" } },
        }),
        "400": jsonSurfaceResponse("Query shorter than two characters.", {
          error: { type: "string" },
        }),
      },
    },
    {
      path: "/api/game-admin/board",
      httpMethod: "GET",
      surfaceId: "surface.daemon-game-admin-board",
      tag: TAG_DAEMON,
      summary: "Game Admin board: lines with the money on each side",
      description:
        "Serves the transcribed Admin module: spread, moneyline, total and team-total sides with exposure (services/sportsdesk_webview_server.ts#GET /api/game-admin). Supports the portal's window selector (48 yesterday, 24 today, -1 current board). Abbreviated amounts carry amountExact null and are excluded from sums. Surface: surface.daemon-game-admin-board (tier D).",
      requiredCapture:
        "A Game Admin API capture would replace the transcription; none exists, so source and observedAt travel with the payload.",
      responses: {
        "200": jsonSurfaceResponse(
          "Board games, their sides and the window summary.",
          {
            success: { type: "boolean" },
            window: { type: "string" },
            games: { type: "array", items: { type: "object" } },
            summary: { type: "object" },
          },
        ),
        "400": jsonSurfaceResponse("Unknown window code.", {
          error: { type: "string" },
        }),
      },
    },
    {
      path: "/api/sports/catalog",
      httpMethod: "GET",
      surfaceId: "surface.daemon-sport-catalog",
      tag: TAG_DAEMON,
      summary: "Sub-sports and period menus with their types",
      description:
        "19 sports, 230 sub-sports and 42 period entries from the committed catalog fixture (services/sportsdesk_webview_server.ts:265-273). Period numbers are sport-specific, so periodTypes reports every name a number carries and flags the ambiguous ones; sub-sport codes shared by several sports are marked. Surface: surface.daemon-sport-catalog (tier D).",
      requiredCapture:
        "Not a capture gap: the catalog fixture is the captured artifact.",
      responses: {
        "200": jsonSurfaceResponse("Catalog with derived indexes.", {
          summary: { type: "object" },
          periodTypes: { type: "array", items: { type: "object" } },
          subSports: { type: "array", items: { type: "object" } },
          sports: { type: "array", items: { type: "object" } },
        }),
        "404": jsonSurfaceResponse("Unknown sport or sub-sport.", {
          error: { type: "string" },
        }),
      },
    },
    {
      path: "/api/contests",
      httpMethod: "GET",
      surfaceId: "surface.daemon-contests",
      tag: TAG_DAEMON,
      summary: "Contest / futures list from the sports nav",
      description:
        "Every contest the nav links, keyed by contestNum with sport, market and subject parsed out of the padded type string (services/sportsdesk_webview_server.ts#GET /api/contests). The list is extracted from saved markup by scripts/extract_contests.ts. Surface: surface.daemon-contests (tier D).",
      requiredCapture:
        "A contest API capture would replace the markup extraction; none exists.",
      responses: {
        "200": jsonSurfaceResponse("Contests with their group counts.", {
          success: { type: "boolean" },
          count: { type: "integer" },
          entries: { type: "array", items: { type: "object" } },
        }),
        "404": jsonSurfaceResponse("No contest list extracted.", {
          error: { type: "string" },
        }),
      },
    },
    {
      path: "/api/live-wagers",
      httpMethod: "GET",
      surfaceId: "surface.daemon-live-wagers",
      tag: TAG_DAEMON,
      summary: "Live wager ticker list with parsed legs",
      description:
        "The {LIST: [...]} bet-ticker feed, which differs from Report/Pending: WagerNumber is the ticket id and ShortDesc carries one line per leg (services/sportsdesk_webview_server.ts:740-794). Both ShortDesc grammars are parsed and the compact one is flagged; VolumeAmount differing from AmountWagered is reported, not reconciled. The response carries the file's own provenance — source, observedAt and captureNote — so a partial list reads as partial instead of as the whole ticker. Loopback-gated. Surface: surface.daemon-live-wagers (tier D).",
      requiredCapture:
        "A full ticker capture. data/live-wagers.json currently holds 17 rows salvaged from a partial clipboard paste, and both its `partial: true` flag and its captureNote say so.",
      responses: {
        "200": jsonSurfaceResponse(
          "Wagers with aggregates and their provenance.",
          {
            success: { type: "boolean" },
            summary: { type: "object" },
            all: { type: "object" },
            provenance: { type: "object" },
            wagers: { type: "array", items: { type: "object" } },
          },
        ),
        "404": jsonSurfaceResponse("No live wager capture.", {
          error: { type: "string" },
        }),
      },
    },
    {
      path: "/api/status",
      httpMethod: "GET",
      surfaceId: "surface.daemon-dashboard",
      tag: TAG_DAEMON,
      summary:
        "Daemon status and process telemetry (GET /api/status, GET /status.json)",
      description:
        "Answers {ok, status, checks, health, telegram, timestamp} from the running process instead of fetching itself over the loopback (services/sportsdesk_webview_server.ts:624-680); a self-fetch had no port at all under a unix socket. `ok` and `status` are derived from `checks`, so the degraded branch is reachable, and `cpuUsageSinceStartMicros` is cumulative CPU time rather than utilisation. HEAD is answered like GET. Public by the table's `operational` classification — it carries uptime, memory, pid and bind address, not customer data. Surface: surface.daemon-dashboard (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/status (the route is handler-verified only; no HTTP response was captured).",
      responses: {
        "200": jsonSurfaceResponse(
          "Liveness, per-check results and process telemetry.",
          {
            ok: { type: "boolean" },
            status: { type: "string", enum: ["serving", "degraded"] },
            checks: {
              type: "object",
              additionalProperties: { type: "string", enum: ["ok", "error"] },
            },
            health: { type: "object" },
            telegram: { type: "object", nullable: true },
            timestamp: { type: "string", format: "date-time" },
          },
        ),
      },
    },
    {
      path: "/api/parse-formdata",
      httpMethod: "POST",
      surfaceId: "surface.daemon-dashboard",
      tag: TAG_DAEMON,
      summary: "Form-data parse probe (POST /api/parse-formdata)",
      description:
        "Echoes the fields of one multipart or urlencoded body as {name: string | string[]} (services/sportsdesk_webview_server.ts:403-426). Reads through `req.formData()`, which on 1.4.4 succeeds where `new Blob([await req.arrayBuffer()]).formData()` rejected Bun's own encoding; the body is bounded by the daemon's 1 MiB maxRequestBodySize. Public, and the reason the cap exists. Surface: surface.daemon-dashboard (tier D).",
      requiredCapture:
        "HTTP capture of a POST /api/parse-formdata round trip (multipart and urlencoded).",
      responses: {
        "200": {
          description:
            "The submitted fields; a repeated name becomes an array of strings.",
          headers: daemonHeaders(),
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: {
                  oneOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
              },
            },
          },
        },
        "400": jsonSurfaceResponse("The body is not parseable as form data.", {
          error: { type: "string" },
        }),
        "413": jsonSurfaceResponse(
          "The body exceeded maxRequestBodySize and Bun refused it before the handler ran.",
          { error: { type: "string" } },
        ),
      },
    },
    {
      path: "/api/logo/{name}",
      httpMethod: "GET",
      surfaceId: "surface.daemon-logo-proxy",
      tag: TAG_DAEMON,
      summary: "Team-logo proxy (GET /api/logo/{name})",
      description:
        "Fetches https://cdn.fastassets.io/images/team-logos/{name} and returns the image bytes with an immutable day-long cache (services/sportsdesk_webview_server.ts:530-586). Names are validated by rejecting separators, control characters and `..` rather than by allowlisting the characters the feed happens to use, so a traversal never reaches the upstream URL; a malformed percent-escape is 400, not the 500 it used to be. Public: it returns image bytes for a fixed host and carries no customer data. Surface: surface.daemon-logo-proxy (tier D).",
      requiredCapture:
        "HTTP capture of one logo fetch, including a 404 from the CDN, to record the upstream status passthrough.",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description:
            "Logo file name from the wager feed, e.g. `Arsenal FC.png`; must end in .png/.jpg/.jpeg/.gif/.webp/.svg and contain no separator, control character or `..`.",
          schema: { type: "string" },
          example: "Arsenal FC.png",
        },
      ],
      responses: {
        "200": {
          description: "The upstream image bytes, cached for one day.",
          headers: daemonHeaders(),
          content: {
            "image/png": { schema: { type: "string", format: "binary" } },
          },
        },
        "400": {
          description:
            "Missing, malformed or disallowed name — including a broken percent-escape.",
          headers: daemonHeaders(),
          content: { "text/plain": { schema: { type: "string" } } },
        },
        "502": jsonSurfaceResponse(
          "The upstream answered but not with an image.",
          { error: { type: "string" } },
        ),
      },
    },
    {
      path: "/api/f402/get-pending",
      httpMethod: "GET",
      surfaceId: "surface.daemon-live-bets",
      tag: TAG_DAEMON,
      summary: "Retired Pending endpoint (410 tombstone)",
      description:
        "Answers 410 with a pointer to /api/live-bets (services/sportsdesk_webview_server.ts:590-601). It used to return the same dataset in a different shape; the tombstone makes an old client fail loudly instead of silently reading a fixture that looks live. Surface: surface.daemon-live-bets (tier D).",
      requiredCapture: "HTTP capture of the 410 body (handler-verified only).",
      responses: {
        "410": jsonSurfaceResponse(
          "The endpoint is gone; the body names its replacements.",
          {
            success: { type: "boolean", const: false },
            error: { type: "string" },
          },
        ),
      },
    },
    {
      path: "/api/graph-feed",
      httpMethod: "GET",
      surfaceId: "surface.daemon-graph-data-plane",
      tag: TAG_DAEMON,
      summary: "Graph live feed (GET /api/graph-feed, /graph-live-feed.json)",
      description:
        "Serves docs/graph-live-feed.json — the same dataset docs/graph.html embeds — with no-store caching (services/sportsdesk_webview_server.ts:765-793). It carries agent logins, so it uses the same `pii` guard as the page. Surface: surface.daemon-graph-data-plane (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/graph-feed (the artifact is committed; no HTTP response was captured).",
      responses: {
        "200": {
          description:
            "The graph feed document as stored in docs/graph-live-feed.json.",
          headers: daemonHeaders(),
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
        ...adminRejectionResponses(),
      },
    },
    {
      path: "/api/telegram/status",
      httpMethod: "GET",
      surfaceId: "surface.daemon-telegram-admin-routes",
      tag: TAG_DAEMON,
      summary:
        "Telegram configuration and schedules (GET /api/telegram/status)",
      description:
        "Returns {success, status, schedules, reportTypes} from the bot service and the in-process scheduler (services/sportsdesk_webview_server.ts:1407-1419). Admin-token gated regardless of peer address. Surface: surface.daemon-telegram-admin-routes (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/telegram/status with a valid token.",
      responses: {
        "200": jsonSurfaceResponse(
          "Bot mode, schedules and the report vocabulary.",
          {
            success: { type: "boolean", const: true },
            status: { type: "object" },
            schedules: { type: "array", items: { type: "object" } },
            reportTypes: { type: "array", items: { type: "string" } },
          },
        ),
        ...adminRejectionResponses(),
      },
    },
    {
      path: "/api/telegram/activity",
      httpMethod: "GET",
      surfaceId: "surface.daemon-telegram-admin-routes",
      tag: TAG_DAEMON,
      summary: "Recent Telegram activity (GET /api/telegram/activity)",
      description:
        "Returns {success, entries} from the activity log; `limit` defaults to 50 and clamps to 1..200 (services/sportsdesk_webview_server.ts:1422-1434). Admin-token gated. Surface: surface.daemon-telegram-admin-routes (tier D).",
      requiredCapture:
        "HTTP capture of GET /api/telegram/activity with a valid token.",
      responses: {
        "200": jsonSurfaceResponse("Newest-first activity entries.", {
          success: { type: "boolean", const: true },
          entries: { type: "array", items: { type: "object" } },
        }),
        ...adminRejectionResponses(),
      },
    },
    {
      path: "/api/telegram/webhook",
      httpMethod: "POST",
      surfaceId: "surface.daemon-telegram-admin-routes",
      tag: TAG_DAEMON,
      summary:
        "Register or delete the Telegram webhook (POST /api/telegram/webhook)",
      description:
        'Body {action: "set" | "delete"} calls telegramService.setWebhook()/deleteWebhook() and mirrors the Bot API result as {success, ok, error?}, 502 when Telegram refuses (services/sportsdesk_webview_server.ts:1435-1459). Admin-token gated; this is the control plane, distinct from the secret-checked /telegram/webhook that receives updates. Surface: surface.daemon-telegram-admin-routes (tier D).',
      requiredCapture:
        "HTTP capture of a set and a delete round trip against the Bot API.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["action"],
              properties: {
                action: { type: "string", enum: ["set", "delete"] },
              },
            },
          },
        },
      },
      responses: {
        "200": jsonSurfaceResponse("Telegram accepted the change.", {
          success: { type: "boolean" },
          ok: { type: "boolean" },
          error: { type: "string" },
        }),
        "400": jsonSurfaceResponse('action is missing or not "set"/"delete".', {
          success: { type: "boolean", const: false },
          error: { type: "string" },
        }),
        "502": jsonSurfaceResponse(
          "Telegram answered ok:false; its description is passed through.",
          {
            success: { type: "boolean", const: false },
            ok: { type: "boolean" },
            error: { type: "string" },
          },
        ),
        ...adminRejectionResponses(),
      },
    },
    {
      path: "/api/test/error",
      httpMethod: "GET",
      surfaceId: "surface.daemon-telegram-admin-routes",
      tag: TAG_DAEMON,
      summary: "Error-boundary probe (GET /api/test/error)",
      description:
        "Throws a string so the server's error boundary runs; `?trigger_error=non_error` does the same on any route (services/sportsdesk_webview_server.ts:390-396). Deliberately reachable in production so a deployment can prove the 500 body carries no stack trace. Surface: surface.daemon-telegram-admin-routes (tier D).",
      requiredCapture:
        "HTTP capture of the 500 body in production (asserted by tests/server_error.test.ts, not captured as an artifact).",
      responses: {
        "500": jsonSurfaceResponse(
          "The daemon's structured 500: no stack, no source, only the thrown message.",
          {
            success: { type: "boolean", const: false },
            error: { type: "string", const: "Internal Server Error" },
            message: { type: "string" },
          },
        ),
      },
    },
  ];
}

function surfaceOperation(
  spec: SurfaceOperationSpec,
  ledger: Ledger,
): JsonObject {
  const surface = findSurface(ledger, spec.surfaceId);
  const method = pathItemMethod(spec.httpMethod);
  const operation: JsonObject = {
    tags: [spec.tag],
    summary: spec.summary,
    description: spec.description,
    operationId: operationIdFor(method, spec.path),
    responses: spec.responses,
    "x-evidence": evidenceFromSurface(surface, spec.requiredCapture),
    "x-surface-id": surface.id,
  };
  if (spec.requestBody !== undefined) operation.requestBody = spec.requestBody;
  if (spec.parameters !== undefined)
    operation.parameters = [...spec.parameters];
  return operation;
}

/* -------------------------------------------------------------------------- */
/* Tier A rendering from the live capture store                               */
/* -------------------------------------------------------------------------- */

/** Bounded scalar types emitted by scripts/capture/schema.ts skeletons. */
type SkeletonScalarType = "string" | "number" | "boolean" | "null" | "unknown";

interface SkeletonObjectNode {
  readonly type: "object";
  readonly nullable: boolean;
  readonly fields: Readonly<Record<string, SkeletonNode>>;
  readonly truncated: boolean;
}

interface SkeletonArrayNode {
  readonly type: "array";
  readonly nullable: boolean;
  readonly items: SkeletonNode | null;
  readonly truncated: boolean;
}

interface SkeletonScalarNode {
  readonly type: SkeletonScalarType;
  readonly nullable: boolean;
  readonly enumCandidates: readonly string[];
  readonly truncated: boolean;
}

type SkeletonNode = SkeletonObjectNode | SkeletonArrayNode | SkeletonScalarNode;

const SKELETON_SCALAR_TYPES: readonly SkeletonScalarType[] = [
  "string",
  "number",
  "boolean",
  "null",
  "unknown",
];

function isSkeletonScalarType(value: string): value is SkeletonScalarType {
  return (SKELETON_SCALAR_TYPES as readonly string[]).includes(value);
}

/** Validate a capture bodySkeleton (schema v1) without accepting loose shapes. */
function parseSkeletonNode(raw: unknown, label: string): SkeletonNode {
  if (!isRecord(raw)) fail(`${label} must be an object`);
  const type = raw.type;
  if (typeof type !== "string") fail(`${label}.type must be a string`);
  const nullable = asBoolean(raw.nullable, `${label}.nullable`);
  const truncated = raw.truncated === true;
  if (type === "object") {
    if (!isRecord(raw.fields)) fail(`${label}.fields must be an object`);
    const fields: Record<string, SkeletonNode> = {};
    for (const key of Object.keys(raw.fields).sort()) {
      fields[key] = parseSkeletonNode(
        raw.fields[key],
        `${label}.fields.${key}`,
      );
    }
    return { type: "object", nullable, fields, truncated };
  }
  if (type === "array") {
    const rawItems = raw.items;
    const items =
      rawItems === null || rawItems === undefined
        ? null
        : parseSkeletonNode(rawItems, `${label}.items`);
    return { type: "array", nullable, items, truncated };
  }
  if (!isSkeletonScalarType(type)) {
    fail(
      `${label}.type must be object|array|${SKELETON_SCALAR_TYPES.join("|")}; found "${type}"`,
    );
  }
  const rawEnum = raw.enumCandidates;
  const enumCandidates: string[] = [];
  if (rawEnum !== undefined) {
    if (
      !Array.isArray(rawEnum) ||
      !rawEnum.every((entry) => typeof entry === "string")
    ) {
      fail(`${label}.enumCandidates must be an array of strings`);
    }
    for (const entry of rawEnum) {
      if (typeof entry === "string") enumCandidates.push(entry);
    }
  }
  return { type, nullable, enumCandidates, truncated };
}

/**
 * Convert a capture skeleton into an OpenAPI 3.1 schema.
 *
 * The skeleton is value-free by construction (scripts/capture/schema.ts): only
 * types, field names and safe low-cardinality enum candidates are published.
 * `nullable` becomes a `null` type branch; `truncated` becomes an honest
 * x-capture-truncated marker rather than an implied complete shape.
 */
function skeletonToSchema(node: SkeletonNode): JsonObject {
  const schema: JsonObject = {};
  switch (node.type) {
    case "object": {
      const properties: JsonObject = {};
      for (const key of Object.keys(node.fields).sort()) {
        const child = node.fields[key];
        if (child !== undefined) properties[key] = skeletonToSchema(child);
      }
      schema.type = node.nullable ? ["object", "null"] : "object";
      schema.properties = properties;
      break;
    }
    case "array": {
      schema.type = node.nullable ? ["array", "null"] : "array";
      if (node.items !== null) schema.items = skeletonToSchema(node.items);
      break;
    }
    case "null":
      schema.type = "null";
      break;
    case "unknown":
      schema.description =
        "Unknown shape: the capture recorded a truncated or unrepresentable value.";
      break;
    default: {
      schema.type = node.nullable ? [node.type, "null"] : node.type;
      if (node.type === "string" && node.enumCandidates.length > 0) {
        schema.enum = [...node.enumCandidates];
      }
      break;
    }
  }
  if (node.truncated) schema["x-capture-truncated"] = true;
  return schema;
}

function mediaTypeOf(contentType: string, fallback: string): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "") return fallback;
  if (base.includes("json")) return "application/json";
  if (base.includes("x-www-form-urlencoded")) {
    return "application/x-www-form-urlencoded";
  }
  return base;
}

function firstRequestMediaType(requestBody: unknown): string | undefined {
  if (!isRecord(requestBody)) return undefined;
  const content = requestBody.content;
  if (!isRecord(content)) return undefined;
  const keys = Object.keys(content).sort();
  return keys[0];
}

interface LiveCaptureRecord {
  readonly relativePath: string;
  readonly capturedAt: string;
  readonly capturedAtMs: number;
  readonly path: string;
  readonly method: string;
  readonly status: number;
  readonly responseContentType: string;
  readonly responseBodySha256: string | null;
  readonly responseSkeleton: SkeletonNode;
  readonly requestContentType: string;
  readonly requestSkeleton: SkeletonNode | null;
  readonly digest: string;
  readonly samples: number;
}

interface CaptureStoreLoad {
  readonly captures: readonly LiveCaptureRecord[];
  readonly problems: readonly string[];
}

const NON_CAPTURE_FILES = new Set(["manifest.json", "run.json"]);
const NON_CAPTURE_DIRS = new Set([
  "catalog",
  "pending-500s",
  "schema",
  "runtime",
]);

function isCaptureFileName(name: string): boolean {
  if (!name.endsWith(".json")) return false;
  if (NON_CAPTURE_FILES.has(name)) return false;
  if (name.startsWith("applied-")) return false;
  if (name.startsWith("_")) return false;
  return true;
}

/** Recursively collect capture JSON files in deterministic (sorted) order. */
function listCaptureFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let directory = false;
      try {
        directory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (directory) {
        // Non-endpoint artifact directories (catalog, pending-500s, schema, runtime)
        // are not upgradeable ledger operations.
        if (NON_CAPTURE_DIRS.has(entry)) continue;
        walk(full);
      } else if (isCaptureFileName(entry)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

interface ParsedCaptureRecord {
  readonly capture?: LiveCaptureRecord;
  readonly problem?: string;
}

function stripGeneratorPrefix(message: string): string {
  return message.replace(/^generate_openapi: /, "");
}

/**
 * Parse and validate one capture record for tier-A selection. Selection rules:
 * schemaVersion 1, mode live, redaction.clean, policy v1, 2xx response with a
 * bodySkeleton. Anything else is a recorded problem, never a silent skip.
 */
function parseLiveCapture(
  relativePath: string,
  raw: unknown,
): ParsedCaptureRecord {
  const problem = (message: string): ParsedCaptureRecord => ({
    problem: `${relativePath}: ${message}`,
  });
  if (!isRecord(raw)) return problem("capture record must be a JSON object");
  if (raw.schemaVersion !== 1) {
    return problem(
      `schemaVersion must be 1 (found ${JSON.stringify(raw.schemaVersion)})`,
    );
  }
  if (raw.mode !== "live") {
    return problem(
      `mode must be "live" (found ${JSON.stringify(raw.mode)}); mock/offline captures never back tier A`,
    );
  }
  const capturedAt = typeof raw.capturedAt === "string" ? raw.capturedAt : "";
  const capturedAtMs = Date.parse(capturedAt);
  if (capturedAt === "" || Number.isNaN(capturedAtMs)) {
    return problem("capturedAt must be an ISO-8601 timestamp");
  }
  const operation = raw.operation;
  if (!isRecord(operation)) return problem("operation must be {path, method}");
  const path = typeof operation.path === "string" ? operation.path : "";
  const method =
    typeof operation.method === "string" ? operation.method.toUpperCase() : "";
  if (!path.startsWith("/")) {
    return problem("operation.path must be an absolute API path");
  }
  if (method === "") return problem("operation.method must be non-empty");
  const redaction = raw.redaction;
  if (!isRecord(redaction)) return problem("redaction report is required");
  if (redaction.clean !== true) {
    return problem("redaction.clean must be true");
  }
  if (redaction.policyVersion !== 1) {
    return problem("redaction.policyVersion must be 1");
  }
  const response = raw.response;
  if (!isRecord(response)) {
    return problem(
      "response is required; tier A needs a captured 2xx response",
    );
  }
  const status = response.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 299
  ) {
    return problem(
      `response.status must be a 2xx integer (found ${JSON.stringify(status)})`,
    );
  }
  if (response.bodySkeleton === null || response.bodySkeleton === undefined) {
    return problem("response.bodySkeleton is required");
  }
  let responseSkeleton: SkeletonNode;
  try {
    responseSkeleton = parseSkeletonNode(
      response.bodySkeleton,
      "response.bodySkeleton",
    );
  } catch (error) {
    return problem(
      stripGeneratorPrefix(
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
  const request = raw.request;
  if (!isRecord(request)) {
    return problem(
      "request is required; a response without its request cannot prove the wire contract",
    );
  }
  let requestSkeleton: SkeletonNode | null = null;
  if (request.bodySkeleton !== null && request.bodySkeleton !== undefined) {
    try {
      requestSkeleton = parseSkeletonNode(
        request.bodySkeleton,
        "request.bodySkeleton",
      );
    } catch (error) {
      return problem(
        stripGeneratorPrefix(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  let digest: string;
  try {
    digest = captureRecordDigest(raw);
  } catch (error) {
    return problem(
      `capture record is not canonically hashable: ${stripGeneratorPrefix(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
  return {
    capture: {
      relativePath,
      capturedAt,
      capturedAtMs,
      path,
      method,
      status,
      responseContentType:
        typeof response.contentType === "string" ? response.contentType : "",
      responseBodySha256:
        typeof response.bodySha256 === "string" ? response.bodySha256 : null,
      responseSkeleton,
      requestContentType:
        typeof request.contentType === "string" ? request.contentType : "",
      requestSkeleton,
      digest,
      samples:
        typeof raw.samples === "number" &&
        Number.isInteger(raw.samples) &&
        raw.samples > 0
          ? raw.samples
          : 1,
    },
  };
}

function loadCaptureStore(capturesDir: string): CaptureStoreLoad {
  if (!existsSync(capturesDir)) {
    fail(
      `tier A ledger rows exist but the capture store is missing: ${capturesDir}. Capture live evidence first; the generator never invents a response schema.`,
    );
  }
  const captures: LiveCaptureRecord[] = [];
  const problems: string[] = [];
  for (const file of listCaptureFiles(capturesDir)) {
    const relativePath = relative(capturesDir, file).split("\\").join("/");
    let raw: unknown;
    try {
      raw = JSON.parse(readText(file)) as unknown;
    } catch (error) {
      problems.push(
        `${relativePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (!isRecord(raw) || raw.schemaVersion !== 1) continue;
    const parsed = parseLiveCapture(relativePath, raw);
    if (parsed.capture !== undefined) captures.push(parsed.capture);
    else if (parsed.problem !== undefined) problems.push(parsed.problem);
  }
  return { captures, problems };
}

/**
 * Select the latest valid live capture for an A row (deterministic tie-break on
 * the relative file path). No match is a hard error with the rejected-record
 * reasons, so an A row can never fall back to an invented schema.
 */
function selectCaptureForRow(
  operation: LedgerOperation,
  capturesDir: string,
  store: CaptureStoreLoad,
): LiveCaptureRecord {
  const method = operation.method.toUpperCase();
  const matches = store.captures.filter(
    (capture) => capture.path === operation.path && capture.method === method,
  );
  const latest = pickLatestCapture(matches);
  if (latest === undefined) {
    const details =
      store.problems.length > 0
        ? ` Rejected capture records: ${store.problems.slice(0, 5).join("; ")}`
        : "";
    fail(
      `tier A ledger row ${method} ${operation.path} has no valid live capture under ${capturesDir}; capture it live and re-run apply_captures --write.${details}`,
    );
  }
  return latest;
}

function pickLatestCapture(
  matches: readonly LiveCaptureRecord[],
): LiveCaptureRecord | undefined {
  let latest: LiveCaptureRecord | undefined;
  for (const capture of matches) {
    if (latest === undefined) {
      latest = capture;
      continue;
    }
    if (
      capture.capturedAtMs > latest.capturedAtMs ||
      (capture.capturedAtMs === latest.capturedAtMs &&
        capture.relativePath < latest.relativePath)
    ) {
      latest = capture;
    }
  }
  return latest;
}

/**
 * Render a ledger Tier A operation from its live capture record.
 *
 * The operation keeps the observed request template's summary/tags/security
 * (there is no captured response contract to infer those from) and replaces
 * the description, request schema and response schema with capture-derived
 * content. Only previously observed (tier B) operations are upgradable this
 * way; anything else fails instead of inventing a contract.
 */
function capturedOperation(
  operation: LedgerOperation,
  capture: LiveCaptureRecord,
): JsonObject {
  const method = operation.method.toUpperCase();
  const templateBuilder = B_OPERATION_BUILDERS[operation.path];
  // A previously observed (tier B) operation keeps its hand-observed request
  // template; an inferred (tier C) operation has no template, so the request
  // schema is derived from the live capture's own request skeleton instead.
  const base: JsonObject =
    templateBuilder === undefined
      ? {
          tags: [TAG_CAPTURED],
          summary: `Live-captured ${operation.path} (request template unverified)`,
          parameters: [],
        }
      : templateBuilder(operation);
  const baseRequestBody = base.requestBody;
  const fallbackMedia =
    firstRequestMediaType(baseRequestBody) ??
    (capture.requestSkeleton === null
      ? "application/json"
      : capture.requestContentType);
  const bodyShaNote =
    capture.responseBodySha256 !== null
      ? ` (response body sha256 ${capture.responseBodySha256})`
      : "";
  const description = [
    `Live-captured contract: ${capture.relativePath} (schemaVersion 1, mode live) recorded ${method} ${operation.path} at ${capture.capturedAt} with a ${capture.status} response${bodyShaNote}.`,
    "Request and response were captured live with redaction clean (policy v1).",
    "The response schema is derived from the captured body skeleton and the request schema from the captured request skeleton; no field values are published.",
    templateBuilder === undefined
      ? "The endpoint path/method were previously inferred (tier C); the live capture now evidences both, while the request field template remains unverified."
      : "The request template is the previously observed Manager envelope.",
  ].join(" ");
  const responses: JsonObject = {
    [String(capture.status)]: {
      description: `Captured live ${capture.status} response from ${capture.relativePath}; schema derived from the captured body skeleton.`,
      content: {
        [mediaTypeOf(capture.responseContentType, "application/json")]: {
          schema: skeletonToSchema(capture.responseSkeleton),
        },
      },
    },
    default: {
      description: "Other status codes were not captured by this record.",
    },
  };
  const baseSummary = typeof base.summary === "string" ? base.summary : "";
  const summary =
    baseSummary === ""
      ? `Live-captured ${method} ${operation.path}`
      : baseSummary
          .replace(
            /\(request observed; response not captured\)/i,
            "(request + response captured)",
          )
          .replace(/response not captured/gi, "request + response captured");
  const rendered: JsonObject = {
    ...base,
    summary,
    description,
    responses,
    "x-evidence": {
      tier: "A",
      sources: [`capture:${capture.relativePath}`, `sha256:${capture.digest}`],
      capturedResponse: true,
    },
    "x-capture": {
      file: capture.relativePath,
      sha256: capture.digest,
      capturedAt: capture.capturedAt,
      status: capture.status,
      samples: capture.samples,
    },
  };
  const requestSkeleton = capture.requestSkeleton;
  if (requestSkeleton !== null && requestSkeleton.type !== "null") {
    rendered.requestBody = {
      required: isRecord(baseRequestBody) && baseRequestBody.required === true,
      content: {
        [mediaTypeOf(capture.requestContentType, fallbackMedia)]: {
          schema: skeletonToSchema(requestSkeleton),
        },
      },
    };
  }
  return rendered;
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

function buildSecuritySchemes(): JsonObject {
  return {
    fantasy402Cookie: {
      type: "apiKey",
      in: "cookie",
      name: "session",
      description:
        "Fantasy402 Manager portal session. [OBSERVED] 2026-11-01: a Manager page sends `Authorization: Bearer <token>`, where the token is `sessionStorage.credentials.code` after login. The same request without that header is refused with 401 by openresty, so the cookie alone is not sufficient. The 2026-10-28 HAR carried no Authorization header, which is now contradicted. The cookie name is unrecorded, so 'session' is a placeholder label.",
    },
    daemonBearer: {
      type: "http",
      scheme: "bearer",
      description:
        "Static daemon admin token: Authorization: Bearer <SPORTSDESK_ADMIN_TOKEN>, compared with crypto.timingSafeEqual (services/sportsdesk_webview_server.ts:166-173). The daemon answers 503 when SPORTSDESK_ADMIN_TOKEN is unset and 401 otherwise.",
    },
  };
}

function buildParameters(): JsonObject {
  return {
    XRequestedWith: {
      name: "X-Requested-With",
      in: "header",
      required: true,
      description:
        "Observed on the captured 2026-10-28 mode-B Manager request. Whether the portal enforces it is unverified.",
      schema: { type: "string", enum: ["XMLHttpRequest"] },
    },
  };
}

function buildHeaders(): JsonObject {
  return {
    CSPHeader: {
      description:
        "Content-Security-Policy applied to daemon responses: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram: (services/sportsdesk_webview_server.ts:87-90).",
      schema: { type: "string" },
    },
    XContentTypeOptionsHeader: {
      description:
        "X-Content-Type-Options: nosniff (services/sportsdesk_webview_server.ts:89).",
      schema: { type: "string", enum: ["nosniff"] },
    },
    ReferrerPolicyHeader: {
      description:
        "Referrer-Policy: strict-origin-when-cross-origin (services/sportsdesk_webview_server.ts:90).",
      schema: { type: "string", enum: ["strict-origin-when-cross-origin"] },
    },
  };
}

function buildSchemas(ledger: Ledger): JsonObject {
  const catalogSource = readArtifact(CATALOG_TYPE_SOURCE_REL);
  const churnSource = readArtifact(CHURN_TYPE_SOURCE_REL);
  const catalogFixture = parseCatalogFixture(
    JSON.parse(readArtifact(CATALOG_FIXTURE_REL)) as unknown,
  );
  const catalogCounts = validateCatalogFixture(catalogFixture);
  const tierByPath = new Map<string, string>(
    ledger.operations.map(
      (operation) => [operation.path, operation.tier] as const,
    ),
  );
  const ledgerTierOf = (path: string): string => tierByPath.get(path) ?? "B";

  const sourceToComponent: Readonly<Record<string, string>> = {
    Fantasy402SportCatalog: "Fantasy402SportCatalog",
    Fantasy402SportEntry: "SportEntry",
    Fantasy402SubSport: "SubSport",
    Fantasy402Period: "Period",
    Fantasy402CollisionEntry: "CollisionEntry",
    ExpectedEmptySubSportPaths: "ExpectedEmptySubSportPaths",
    CatalogMigrationRisk: "CatalogMigrationRisk",
    RawBetTickerTick: "RawBetTickerTick",
    RawPendingLegRow: "RawPendingLeg",
    RawWebLogEntry: "WeblogEntry",
  };
  const context: SchemaBuilderContext = {
    aliases: new Map<string, readonly string[]>([
      [
        "RawWagerTypeCode",
        parseStringUnionAlias(
          churnSource,
          "simulate_bettor_churn_suite.ts",
          "RawWagerTypeCode",
        ),
      ],
      [
        "RawTicketWriterChannel",
        parseStringUnionAlias(
          churnSource,
          "simulate_bettor_churn_suite.ts",
          "RawTicketWriterChannel",
        ),
      ],
    ]),
    componentNameFor: (sourceTypeName: string) =>
      sourceToComponent[sourceTypeName] ?? "",
  };

  const catalogTypeSpecs: readonly ComponentTypeSpec[] = [
    {
      sourceType: "Fantasy402SubSport",
      componentName: "SubSport",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description: "Sub-sport lane inside one sport (code plus display name).",
    },
    {
      sourceType: "Fantasy402Period",
      componentName: "Period",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description: "Period menu entry for one sport; period 0 is named Game.",
    },
    {
      sourceType: "Fantasy402SportEntry",
      componentName: "SportEntry",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description: "Per-sport lane: the sub-sport tree plus the period menu.",
    },
    {
      sourceType: "Fantasy402CollisionEntry",
      componentName: "CollisionEntry",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Desk-link code shared across sports (Arena, NCAA Extra). makeDeskLinkId rewrites these to <Sport>|<code>; the collision silently breaks scoped ingestion if it is not represented.",
    },
    {
      sourceType: "ExpectedEmptySubSportPaths",
      componentName: "ExpectedEmptySubSportPaths",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Domain-correct structural empties (sport/code paths) split into stable and volatile LIVE surfaces; not quality defects.",
    },
    {
      sourceType: "CatalogMigrationRisk",
      componentName: "CatalogMigrationRisk",
      source: catalogSource,
      fileName: "fantasy402_sport_catalog.ts",
      description:
        "Migration hazard note attached to catalogue entries that need coordinated link_id migration.",
    },
    {
      sourceType: "RawBetTickerTick",
      componentName: "RawBetTickerTick",
      source: churnSource,
      fileName: "simulate_bettor_churn_suite.ts",
      description:
        ledgerTierOf("/cloud/api/Manager/getBetTicker") === "A"
          ? "Consumer wire type for one bet-ticker row. Field names and number types only. The getBetTicker operation is now tier A: its response schema is derived from the live capture skeleton, while this component remains a consumer type declaration."
          : "Consumer wire type for one bet-ticker row. Field names and number types only; this is a type declaration, not a captured response, so the getBetTicker operation (tier C) publishes no response schema.",
    },
    {
      sourceType: "RawPendingLegRow",
      componentName: "RawPendingLeg",
      source: churnSource,
      fileName: "simulate_bettor_churn_suite.ts",
      description:
        ledgerTierOf("/cloud/api/Manager/getPending") === "A"
          ? "Consumer wire type for one pending wager leg. Risk and ToWin are cents and repeat identically across parlay legs. The getPending operation is now tier A: its response schema is derived from the live capture skeleton, while this component remains a consumer type declaration."
          : "Consumer wire type for one pending wager leg. Risk and ToWin are cents and repeat identically across parlay legs. This is a type declaration, not a captured response; no pending-leg fixture or capture exists, so the getPending operation (tier C) publishes no response schema.",
    },
    {
      sourceType: "RawWebLogEntry",
      componentName: "WeblogEntry",
      source: churnSource,
      fileName: "simulate_bettor_churn_suite.ts",
      description:
        ledgerTierOf("/cloud/api/Manager/getWebLog") === "A"
          ? "Consumer type that declares the four fields the old spec published as the getWebLog response row (customerID, ipAddress, timestamp, agentOwner). The getWebLog operation is now tier A and derives its response schema from the live capture skeleton; this component remains a consumer type declaration and is not used for that schema."
          : "Consumer type that declares the four fields the old spec published as the getWebLog response row (customerID, ipAddress, timestamp, agentOwner). It is NOT used as a response schema here: the getWebLog response body was never captured (docs/runbooks/operational_guardrails_runbook.md:153), so the row schema remains undocumented.",
    },
  ];

  const schemas: JsonObject = {
    Fantasy402SportCatalog: buildCatalogSchema(
      context,
      catalogFixture,
      catalogCounts,
    ),
  };
  for (const spec of catalogTypeSpecs) {
    schemas[spec.componentName] = buildSchemaFromType(spec, context);
  }
  return schemas;
}

/* -------------------------------------------------------------------------- */
/* Spec assembly                                                              */
/* -------------------------------------------------------------------------- */

function buildInfo(ledger: Ledger): JsonObject {
  const evidenceModel =
    ledger.counts.A > 0
      ? "Evidence model: every operation carries x-evidence.tier — A means a captured request and response are verified, B means observed first-party evidence (a captured request or a handler-verified route) without a captured response, C means inferred only with no capture, and D means a real surface missing from the spec; tier-A rows are backed by live capture records in docs/evidence/captures and publish capture-derived response schemas (see docs/EVIDENCE.md)."
      : "Evidence model: every operation carries x-evidence.tier — A means a captured request and response are verified, B means observed first-party evidence (a captured request or a handler-verified route) without a captured response, C means inferred only with no capture, and D means a real surface missing from the spec; this release has no tier-A rows because no response body was ever captured (see docs/EVIDENCE.md).";
  return {
    title: "SportsDesk & Fantasy402 Wire API (evidence-labelled)",
    version: "2026.10.31",
    description: `${evidenceModel}\n\n${renderGSLiveDocsMarkdown()}`,
  };
}

function buildServers(ledger: Ledger): readonly JsonObject[] {
  const cloudDescription =
    ledger.counts.A > 0
      ? "Fantasy402 cloud portal (Manager/Report/System API). Tier-A rows carry live request+response captures; other rows are request-side evidence only."
      : "Fantasy402 cloud portal (Manager/Report/System API). Request-side evidence only; no response body was captured.";
  return [
    {
      url: "https://www.fantasy402.com",
      description: cloudDescription,
    },
    {
      url: "http://127.0.0.1:4020",
      description:
        "SportsDesk local daemon (Bun.serve; binds 0.0.0.0 by default, PORT=4020).",
    },
  ];
}

function buildTags(ledger: Ledger): readonly JsonObject[] {
  const hasCapturedTier = ledger.counts.A > 0;
  const hasCaptureOnlyTierA = ledger.operations.some(
    (operation) =>
      operation.tier === "A" &&
      B_OPERATION_BUILDERS[operation.path] === undefined,
  );
  const tags: JsonObject[] = [
    {
      name: TAG_FORENSIC,
      description: hasCapturedTier
        ? "Cloud Manager surveillance operations with first-party evidence; tier-A rows carry a live request+response capture."
        : "Cloud Manager surveillance operations with first-party evidence (request capture only; no response body captured).",
    },
    {
      name: TAG_CUSTOMER,
      description: hasCapturedTier
        ? "Cloud Manager customer state operations with first-party evidence; tier-A rows carry a live request+response capture."
        : "Cloud Manager customer state operations with first-party evidence (request capture only; no response body captured).",
    },
    {
      name: TAG_DAEMON,
      description:
        "Routes served by sportsdesk_webview_server.ts, verified against the handler source rather than an HTTP capture.",
    },
    {
      name: TAG_DOWNLINE,
      description:
        "Downline accounting reports (weekly figure, agent performance). The agent-performance request was observed on 2026-11-01; no response body has been captured for any of them.",
    },
    {
      name: TAG_SETTLEMENT,
      description:
        "Upstream settlement-history poll wired in code; the request contract and response rows are uncaptured.",
    },
    {
      name: TAG_INFERRED,
      description:
        "Tier C operations: inferred or authored only. No request or response was ever observed; path and method are candidates, not contracts.",
    },
  ];
  if (hasCaptureOnlyTierA) {
    tags.push({
      name: TAG_CAPTURED,
      description:
        "Tier-A operations whose path/method were previously inferred (tier C): the response is live-captured, while the request field template is not observed and remains unverified.",
    });
  }
  return tags;
}

function buildPaths(ledger: Ledger, capturesDir: string): JsonObject {
  const hasTierA = ledger.operations.some(
    (operation) => operation.tier === "A",
  );
  const captureStore = hasTierA ? loadCaptureStore(capturesDir) : undefined;
  const paths: JsonObject = {};
  for (const operation of ledger.operations) {
    if (isRemovedFromSpec(operation)) continue;
    const method = operation.method;
    if (!isHttpMethod(method)) {
      fail(`ledger row ${operation.path} has unsupported method "${method}"`);
    }
    const pathItem = paths[operation.path];
    const builder: JsonObject =
      pathItem !== undefined && isRecord(pathItem) ? pathItem : {};
    if (operation.tier === "A") {
      if (captureStore === undefined) {
        fail("internal: tier A rows exist without a loaded capture store");
      }
      builder[method] = capturedOperation(
        operation,
        selectCaptureForRow(operation, capturesDir, captureStore),
      );
    } else if (operation.tier === "B") {
      const operationBuilder = B_OPERATION_BUILDERS[operation.path];
      if (operationBuilder === undefined) {
        fail(
          `tier B ledger row ${operation.path} has no evidenced operation builder`,
        );
      }
      builder[method] = operationBuilder(operation);
    } else if (operation.tier === "C") {
      const summary =
        SUMMARIES[operation.path] ??
        `${operation.method.toUpperCase()} ${operation.path}`;
      builder[method] = inferredOperation(operation, summary);
    } else {
      fail(`unexpected ledger tier "${operation.tier}" for ${operation.path}`);
    }
    paths[operation.path] = builder;
  }
  for (const spec of surfaceOperationSpecs(ledger)) {
    const existing = paths[spec.path];
    const pathItem: JsonObject =
      existing !== undefined && isRecord(existing) ? existing : {};
    pathItem[pathItemMethod(spec.httpMethod)] = surfaceOperation(spec, ledger);
    paths[spec.path] = pathItem;
  }
  return paths;
}

function buildSpec(ledger: Ledger, capturesDir: string): JsonObject {
  return {
    openapi: "3.1.0",
    info: buildInfo(ledger),
    servers: buildServers(ledger),
    tags: buildTags(ledger),
    paths: buildPaths(ledger, capturesDir),
    ...GSLIVE_OPENAPI_EXTENSION,
    components: {
      securitySchemes: buildSecuritySchemes(),
      parameters: buildParameters(),
      headers: buildHeaders(),
      schemas: buildSchemas(ledger),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Self-gating + output                                                       */
/* -------------------------------------------------------------------------- */

function collectOperationsFromPaths(
  paths: JsonObject,
): { path: string; method: string; operation: JsonObject }[] {
  const operations: { path: string; method: string; operation: JsonObject }[] =
    [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method) || !isRecord(operation)) continue;
      operations.push({ path, method, operation });
    }
  }
  return operations;
}

function tierCounts(operations: readonly { operation: JsonObject }[]): {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
} {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const entry of operations) {
    const evidence = entry.operation["x-evidence"];
    const tier = isRecord(evidence) ? evidence.tier : undefined;
    if (tier === "A" || tier === "B" || tier === "C" || tier === "D") {
      counts[tier] += 1;
    }
  }
  return counts;
}

function reportOutcome(outcome: CheckOutcome): void {
  for (const note of outcome.notes) {
    console.log(`  note: ${note}`);
  }
  for (const issue of outcome.issues) {
    console.error(`  - [${issue.code}] ${issue.message}`);
  }
}

function selfGate(
  spec: JsonObject,
  ledger: Ledger,
  rawLedger: unknown,
  rawText: string,
): void {
  const paths = spec.paths;
  if (!isRecord(paths)) fail("internal: paths missing");
  const operations = collectOperationsFromPaths(paths);
  const expectedTiers = expectedSpecTierCounts(
    ledger,
    surfaceOperationSpecs(ledger).length,
  );
  const expectedOperations =
    expectedTiers.A + expectedTiers.B + expectedTiers.C + expectedTiers.D;
  if (operations.length !== expectedOperations) {
    fail(
      `expected ${expectedOperations} operations from the ledger, generated ${operations.length}`,
    );
  }
  const tiers = tierCounts(operations);
  for (const tier of ["A", "B", "C", "D"] as const) {
    if (tiers[tier] !== expectedTiers[tier]) {
      fail(
        `expected ${expectedTiers[tier]} tier-${tier} operations from the ledger, found ${tiers[tier]}`,
      );
    }
  }

  // Tier A rows must publish a capture-derived schema and no requiredCapture.
  for (const entry of operations) {
    if (tierOfOperation(entry.operation) !== "A") continue;
    const responses = entry.operation.responses;
    const hasResponseContent =
      isRecord(responses) &&
      Object.values(responses).some(
        (response) =>
          isRecord(response) &&
          Object.prototype.hasOwnProperty.call(response, "content"),
      );
    if (!hasResponseContent) {
      fail(
        `tier A operation ${entry.method.toUpperCase()} ${entry.path} must publish a capture-derived response schema`,
      );
    }
    const evidence = entry.operation["x-evidence"];
    if (isRecord(evidence) && "requiredCapture" in evidence) {
      fail(
        `tier A operation ${entry.method.toUpperCase()} ${entry.path} must not carry requiredCapture`,
      );
    }
  }

  // The docs gate still forbids content on getWebLog because the response was
  // never captured at the time it was written. A live tier-A capture is exactly
  // the evidence that lifts that guard; the generator records the gap instead of
  // refusing to render real evidence (verify_docs.ts needs a tier-A exemption).
  const capturedGetWebLog = operations.some(
    (entry) =>
      /\/getWebLog$/i.test(entry.path) &&
      tierOfOperation(entry.operation) === "A",
  );
  const outcomes: readonly CheckOutcome[] = [
    checkOpenApi(spec, rawText),
    checkLedger(rawLedger, spec),
  ].map((outcome) => {
    if (!capturedGetWebLog) return outcome;
    const issues = outcome.issues.filter(
      (issue) => issue.code !== "E_GETWEBLOG_RESPONSE_CONTENT",
    );
    if (issues.length === outcome.issues.length) return outcome;
    return {
      ...outcome,
      issues,
      status: issues.length > 0 ? ("fail" as const) : ("pass" as const),
    };
  });
  let failed = false;
  for (const outcome of outcomes) {
    if (outcome.status === "fail") {
      failed = true;
      console.error(`generate_openapi: gate failed: ${outcome.name}`);
      reportOutcome(outcome);
    }
  }
  if (failed) fail("generated spec does not pass scripts/verify_docs.ts");
  if (capturedGetWebLog) {
    console.error(
      "generate_openapi: note: scripts/verify_docs.ts still rejects captured content on getWebLog (E_GETWEBLOG_RESPONSE_CONTENT); a live tier-A capture requires a tier-A exemption in that gate. The renderer keeps the captured schema.",
    );
  }

  const usedTags = new Set<string>();
  for (const entry of operations) {
    const tags = entry.operation.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags) if (typeof tag === "string") usedTags.add(tag);
    }
  }
  for (const tag of USED_TAGS) {
    if (!usedTags.has(tag))
      fail(`declared tag "${tag}" is unused by any operation`);
  }
  for (const tag of usedTags) {
    if (!(USED_TAGS as readonly string[]).includes(tag)) {
      fail(`operation uses undeclared tag "${tag}"`);
    }
  }

  if (rawText.includes("ajax.php")) {
    fail("generated spec must not mention ajax.php");
  }
  // The GSLive host is documented as an operator console deep-link target, never as a wire
  // server or a path. Keep it out of both structural locations.
  if (JSON.stringify(spec.servers).includes("sportswidgets.pro")) {
    fail("generated spec must not list the GSLive host as an API server");
  }
  if (JSON.stringify(spec.paths).includes("sportswidgets.pro")) {
    fail("generated spec must not publish a GSLive path as a wire operation");
  }
  const credentialPatterns: readonly RegExp[] = [
    /Bearer\s+eyJ[A-Za-z0-9_-]+/,
    /DESK-[A-Za-z0-9]{6,}/,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  ];
  for (const pattern of credentialPatterns) {
    if (pattern.test(rawText)) {
      fail(
        `generated spec still contains a credential-shaped example (${pattern})`,
      );
    }
  }

  const evidenceMd = readArtifact(EVIDENCE_MD_REL);
  for (const entry of operations) {
    const surfaceId = entry.operation["x-surface-id"];
    if (typeof surfaceId !== "string") continue;
    if (!evidenceMd.includes(surfaceId)) {
      fail(
        `surface id "${surfaceId}" does not appear verbatim in docs/EVIDENCE.md`,
      );
    }
  }
  const servers = spec.servers;
  if (!Array.isArray(servers) || servers.length !== 2) {
    fail("the spec must declare exactly two servers");
  }
}

/**
 * Reformat a written artifact with the repository's pinned bun formatter.
 *
 * The committed docs/openapi.json must equal BOTH the generator output and the
 * formatter output: CI's repo-wide `bun run format:check` formats JSON arrays
 * differently from JSON.stringify, and the freshness gate byte-diffs the
 * generated temp file against the committed one. Running the formatter on every
 * output (in place or `--out`) keeps both constraints satisfied.
 *
 * `cwd: ROOT` makes bun resolve the same bunfig.toml formatter settings for an
 * `--out` temp path as it does for docs/openapi.json.
 */
function formatWithRepoFormatter(outputPath: string): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "fmt", outputPath],
    cwd: SCRIPT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    fail(
      `bun fmt failed for ${outputPath} (exit ${String(result.exitCode)}): ${stderr || stdout || "no output"}`,
    );
  }
}

interface GeneratorOptions {
  readonly root: string;
  readonly ledgerPath: string;
  readonly capturesDir: string;
  readonly outputPath: string;
}

const USAGE = `usage: bun run scripts/generate_openapi.ts [--out <path>] [--root <dir>] [--ledger <path>] [--captures <dir>]

  --out       output spec path (default: <root>/docs/openapi.json)
  --root      repository/evidence root for the ledger + capture store
              (default: this checkout; type sources fall back to it)
  --ledger    ledger path override (default: <root>/docs/evidence/ledger.json)
  --captures  live capture store override (default: <root>/docs/evidence/captures)`;

function optionValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const next = argv[index + 1];
  if (next === undefined) fail(`${flag} requires a value`);
  return next;
}

function parseCliOptions(argv: readonly string[]): GeneratorOptions | null {
  let rootArg: string | undefined;
  let ledgerArg: string | undefined;
  let capturesArg: string | undefined;
  let outputArg: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      outputArg = optionValue(argv, index, "--out");
      index += 1;
    } else if (argument === "--root") {
      rootArg = optionValue(argv, index, "--root");
      index += 1;
    } else if (argument === "--ledger") {
      ledgerArg = optionValue(argv, index, "--ledger");
      index += 1;
    } else if (argument === "--captures") {
      capturesArg = optionValue(argv, index, "--captures");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(USAGE);
      process.exitCode = 0;
      return null;
    } else {
      fail(`unknown argument: ${argument}\n${USAGE}`);
    }
  }
  const root =
    rootArg !== undefined ? resolve(process.cwd(), rootArg) : SCRIPT_ROOT;
  return {
    root,
    ledgerPath:
      ledgerArg !== undefined
        ? resolve(process.cwd(), ledgerArg)
        : join(root, LEDGER_REL),
    capturesDir:
      capturesArg !== undefined
        ? resolve(process.cwd(), capturesArg)
        : join(root, CAPTURES_REL),
    outputPath:
      outputArg !== undefined
        ? resolve(process.cwd(), outputArg)
        : join(root, SPEC_REL),
  };
}

function main(argv: readonly string[]): void {
  const options = parseCliOptions(argv);
  if (options === null) return;
  artifactRoot = options.root;
  const rawLedgerText = readText(options.ledgerPath);
  let rawLedger: unknown;
  try {
    rawLedger = JSON.parse(rawLedgerText) as unknown;
  } catch (error) {
    fail(
      `ledger is not valid JSON (${options.ledgerPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ledger = parseLedger(rawLedger);
  assertLedgerConsistency(ledger);
  const spec = buildSpec(ledger, options.capturesDir);
  const rawText = `${JSON.stringify(spec, null, 2)}\n`;
  selfGate(spec, ledger, rawLedger, rawText);

  const paths = spec.paths;
  if (!isRecord(paths)) fail("internal: paths missing");
  const operationCount = collectOperationsFromPaths(paths).length;
  const tiers = tierCounts(collectOperationsFromPaths(paths));

  writeFileSync(options.outputPath, rawText, "utf8");
  formatWithRepoFormatter(options.outputPath);
  const formattedText = readText(options.outputPath);
  JSON.parse(formattedText);
  const digest = createHash("sha256").update(formattedText).digest("hex");
  const display = options.outputPath.startsWith(`${SCRIPT_ROOT}/`)
    ? options.outputPath.slice(SCRIPT_ROOT.length + 1)
    : options.outputPath;
  console.log(
    `generate_openapi: wrote ${display} — ${Object.keys(paths).length} paths / ${operationCount} operations (A${String(tiers.A)} B${String(tiers.B)} C${String(tiers.C)} D${String(tiers.D)}), sha256 ${digest}`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : `generate_openapi: ${String(error)}`,
    );
    process.exitCode = 1;
  }
}
