#!/usr/bin/env bun
/**
 * apply_captures.ts — upgrade evidence-ledger rows from live capture records.
 *
 * Why this exists: the docs release records its evidence honestly in
 * docs/evidence/ledger.json (tier A = captured request AND response, tier B =
 * observed request side only). Capturing a real response should be able to move
 * a row from B to A without hand-editing the ledger or guessing. This tool is
 * the only sanctioned path for that upgrade: it validates the capture store,
 * plans conservative B→A upgrades, and (with `--write`) applies them atomically
 * through the same generators and gate that produce the committed docs.
 *
 * Capture store contract (schemaVersion 1, owned by the capture tooling):
 *   docs/evidence/captures/<YYYY-MM-DD>/<slug>.<method>.json
 *   docs/evidence/captures/**\/manifest.json            (optional index)
 *   docs/evidence/captures/applied-<YYYY-MM-DD>.json    (written by --write)
 *
 * Record shape:
 *   { schemaVersion: 1, mode: "live"|"mock", capturedAt,
 *     operation: { path, method, operationId? },
 *     request:  { url, method, headers, contentType, bodySha256, bodySkeleton|null },
 *     response: { status, contentType, bodySha256, bodySkeleton, bytes } | null,
 *     redaction: { policyVersion, clean, fieldsRedacted[], piiRedacted },
 *     provenance: { portalHost, proxy, auth, bunVersion }, samples? }
 *
 * Safety model:
 *   - Read-only operations only (hard-coded allowlist from the capture contract).
 *   - mode must be "live" and redaction.clean must be true.
 *   - Request must be present; response must be present, 2xx, with a bodySkeleton.
 *   - Mock/offline captures never upgrade evidence (refused, not silently skipped).
 *   - Contradicted ledger rows are left untouched; the tool cannot paper over a
 *     contradiction that still needs human evidence review.
 *   - Only B→A upgrades; C rows are not promoted by this tool.
 *   - Idempotent: the same capture digest applied twice is a no-op.
 *   - Default is dry-run. `--write` backs up the ledger/spec/markdown, applies
 *     the ledger atomically, regenerates spec + markdown, runs the docs gate,
 *     and restores everything on any failure.
 *
 * Usage:
 *   bun run scripts/apply_captures.ts [--captures DIR] [--dry-run] [--json]
 *   bun run scripts/apply_captures.ts [--captures DIR] --write [--json]
 *   bun run scripts/apply_captures.ts --root <dir> ...   # temp copy / tests
 */

import { canonicalJson, sha256Hex } from "./capture/json.ts";
import { parseCaptureProvenance } from "./capture/parse_capture_provenance.ts";
import { normalizeProvenance } from "./capture/recorder.ts";
import { deriveTierWithReason } from "./capture/tier.ts";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_ROOT = resolve(import.meta.dir, "..");
const LEDGER_REL = join("docs", "evidence", "ledger.json");
const SPEC_REL = join("docs", "openapi.json");
const MD_REL = join("docs", "api-reference.md");
const CAPTURES_REL = join("docs", "evidence", "captures");

/** Read-only Manager and Report operations from the capture contract. Never add mutations. */
export const READ_ONLY_OPERATIONS = [
  "getWeeklyFigureByAgentLite",
  "getWebLog",
  "getInfoPlayer",
  "getSportsCustomerAdmin",
  "getCustomerAdmin",
  "getBetTicker",
  "getBetTickerConfig",
  "getConfigWebReportsPending",
  "getPending",
  "getSportsVigSetup",
  "getInfoManager",
  "getCustomerNotes",
  "Pending",
  "PendingDelete",
  "getDailyFiguresByCustomer",
  "getGradedWagerByCustomer",
  "getTransactions",
  "getGrading",
  "getTicketDetailPrint",
  "getAccountInfoOwner",
  "getConfigWebReports",
  "getConfigWebReportsCustomerAdmin",
  "getNewUsersInfo",
  "getSportsType",
  "getAuthorizations",
  "getMessage",
  "getNewEmailsCount",
  "getListAgenstByAgent",
  "searchCustomerAdmin",
  "getReportPlayerAnalysis",
  "getScoresLiveDynamic",
  "getReportDeletedTransactions",
  "getHeriarchy",
  "getMasterSheet",
  "authenticateCustomer",
  "verifySession",
  "search",
  "getWeeklyFigure",
  "getAgentPerformance",
  "getSettledFigure",
  "getDeletedWagerReport",
  "getDailyFigure",
  "getMessages",
  "get3rdPartyLimits",
  "getAnalysis",
  "getScores",
  "getAgentTree",
  "getBilling",
  "getRules",
  "getFinancialReport",
  "getDeleteWager",
  "getTransactionList",
  "getDeletedTransactionHistory",
  "getCryptoInfo",
  "getMail",
  "getTeaserProfile",
  "getPerformancePlayer",
  "getWagersByFigureDate",
  "getCasinoSummaryDetails",
] as const;

/** Known mutations, listed only so refusals can explain what was attempted. */
export const MUTATION_OPERATIONS = [
  "updateByColumn",
  "vigSetupInsert",
  "deleteSportsVigSetup",
  "createPlayer",
  "adjustBalance",
  "deleteWager",
  "deleteBet",
  "updateCustomerNotes",
  "delete-wager",
  "gameAdmin",
] as const;

export const TIERS = ["A", "B", "C", "D", "E"] as const;
export type Tier = (typeof TIERS)[number];

export const ISSUE_CODES = {
  CAPTURE_PARSE: "E_CAPTURE_PARSE",
  SCHEMA_VERSION: "E_SCHEMA_VERSION",
  MODE_NOT_LIVE: "E_MODE_NOT_LIVE",
  OP_MISSING: "E_OP_MISSING",
  OP_NOT_ALLOWED: "E_OP_NOT_ALLOWED",
  OP_METHOD: "E_OP_METHOD",
  REQUEST_MISSING: "E_REQUEST_MISSING",
  RESPONSE_MISSING: "E_RESPONSE_MISSING",
  RESPONSE_STATUS: "E_RESPONSE_STATUS",
  RESPONSE_SKELETON: "E_RESPONSE_SKELETON",
  REDACTION: "E_REDACTION",
  REDACTION_POLICY: "E_REDACTION_POLICY",
  CAPTURED_AT: "E_CAPTURED_AT",
  PROVENANCE: "E_PROVENANCE",
  LEDGER_PARSE: "E_LEDGER_PARSE",
  LEDGER_SHAPE: "E_LEDGER_SHAPE",
  LEDGER_COUNTS: "E_LEDGER_COUNTS",
  LEDGER_ROW_MISSING: "E_LEDGER_ROW_MISSING",
  SPEC_PARSE: "E_SPEC_PARSE",
  SPEC_OP_MISSING: "E_SPEC_OP_MISSING",
  STORE_MISSING: "E_STORE_MISSING",
  MANIFEST: "E_MANIFEST",
  LOCK_HELD: "E_LOCK_HELD",
  WRITE_FAILED: "E_WRITE_FAILED",
} as const;
export type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES];

/* -------------------------------------------------------------------------- */
/* Shared types                                                               */
/* -------------------------------------------------------------------------- */

export interface TierCounts {
  readonly A: number;
  readonly B: number;
  readonly C: number;
  readonly D: number;
  readonly E: number;
  readonly total: number;
}

export interface CaptureIssue {
  readonly code: IssueCode;
  readonly message: string;
}

export interface UpgradeEntry {
  readonly file: string;
  readonly operation: string;
  readonly path: string;
  readonly method: string;
  readonly digest: string;
  readonly capturedAt: string;
  readonly evidenceSource: string;
  readonly responseStatus: number;
  readonly responseBodySha256: string | null;
  readonly responseBytes?: number;
  readonly emptyEnvelope?: boolean;
  /** Explicit derivation reason from `deriveTierWithReason`. */
  readonly tierReason?: string;
  /** True when this capture resolves the row's contradiction flag. */
  readonly resolvesContradiction: boolean;
  /** The contradictedReason moved into row.resolution.previousReason. */
  readonly previousContradictionReason: string | null;
}

export interface SkipEntry {
  readonly file: string;
  readonly operation: string;
  readonly path: string;
  readonly reason: string;
}

export interface RejectionEntry {
  readonly file: string;
  readonly operation: string | null;
  readonly code: string;
  readonly message: string;
}

export interface Plan {
  readonly upgrades: readonly UpgradeEntry[];
  readonly skips: readonly SkipEntry[];
  readonly rejections: readonly RejectionEntry[];
  readonly countsBefore: TierCounts;
  readonly countsAfter: TierCounts;
  readonly capturesFound: number;
  /** Files whose JSON is object-shaped with schemaVersion 1 (valid or not). */
  readonly captureShapedRecords: number;
}

export interface StepResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable side effects so tests never spawn, format or touch the network. */
export interface ApplyDeps {
  readonly regenerateSpec: (root: string) => StepResult;
  readonly regenerateMarkdown: (root: string) => StepResult;
  /** Optional: refresh dist/ so the docs gate's staging-parity check is current. */
  readonly stageDist?: (root: string) => StepResult;
  readonly verifyDocs: (root: string) => StepResult;
  readonly formatFile: (path: string, root: string) => StepResult;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

export interface ApplyOptions {
  readonly root: string;
  readonly capturesDir: string;
  readonly write: boolean;
  readonly json: boolean;
}

export type FailureKind = "input-error" | "write-failed";

export interface ApplyResult {
  readonly ok: boolean;
  readonly failureKind: FailureKind | null;
  readonly mode: "dry-run" | "write";
  readonly capturesDir: string;
  readonly capturesFound: number;
  readonly upgrades: readonly UpgradeEntry[];
  readonly skips: readonly SkipEntry[];
  readonly rejections: readonly RejectionEntry[];
  readonly countsBefore: TierCounts | null;
  readonly countsAfter: TierCounts | null;
  readonly applied: boolean;
  readonly auditRecord: string | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Small typed readers                                                        */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isHexSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export { canonicalJson, sha256Hex };

function toTier(value: unknown): Tier | undefined {
  return typeof value === "string" &&
    (TIERS as readonly string[]).includes(value)
    ? (value as Tier)
    : undefined;
}

function operationNameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  return segments.length === 0 ? "" : (segments[segments.length - 1] ?? "");
}

function emptyCounts(): Record<Tier, number> & { total: number } {
  return { A: 0, B: 0, C: 0, D: 0, E: 0, total: 0 };
}

export function keyOf(path: string, method: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/* -------------------------------------------------------------------------- */
/* Ledger and spec loading                                                    */
/* -------------------------------------------------------------------------- */

export interface LedgerRowView {
  readonly index: number;
  readonly path: string;
  readonly method: string;
  readonly tag: string;
  readonly tier: Tier;
  readonly capturedResponse: boolean;
  readonly contradicted: boolean;
  readonly contradictedReason: string | null;
  readonly evidence: readonly unknown[];
}

export interface LedgerView {
  readonly document: Record<string, unknown>;
  readonly rows: readonly LedgerRowView[];
  readonly surfaces: readonly Record<string, unknown>[];
}

export interface LoadedLedger {
  readonly view?: LedgerView;
  readonly issues: readonly CaptureIssue[];
}

export function loadLedgerFile(path: string): LoadedLedger {
  if (!existsSync(path)) {
    return {
      issues: [
        {
          code: ISSUE_CODES.LEDGER_PARSE,
          message: `ledger not found: ${path}`,
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      issues: [
        {
          code: ISSUE_CODES.LEDGER_PARSE,
          message: `ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  if (!isRecord(parsed)) {
    return {
      issues: [
        {
          code: ISSUE_CODES.LEDGER_SHAPE,
          message: "ledger root must be a JSON object",
        },
      ],
    };
  }
  const rawOperations = parsed.operations;
  if (!Array.isArray(rawOperations)) {
    return {
      issues: [
        {
          code: ISSUE_CODES.LEDGER_SHAPE,
          message: "ledger.operations must be an array",
        },
      ],
    };
  }
  const issues: CaptureIssue[] = [];
  const rows: LedgerRowView[] = [];
  rawOperations.forEach((row, index) => {
    const label = `ledger.operations[${index}]`;
    if (!isRecord(row)) {
      issues.push({
        code: ISSUE_CODES.LEDGER_SHAPE,
        message: `${label} must be an object`,
      });
      return;
    }
    const path = readString(row, "path");
    const method = readString(row, "method");
    const tier = toTier(row.tier);
    if (path === undefined || path === "") {
      issues.push({
        code: ISSUE_CODES.LEDGER_SHAPE,
        message: `${label}.path must be a non-empty string`,
      });
      return;
    }
    if (method === undefined || method === "") {
      issues.push({
        code: ISSUE_CODES.LEDGER_SHAPE,
        message: `${label}.method must be a non-empty string`,
      });
      return;
    }
    if (tier === undefined) {
      issues.push({
        code: ISSUE_CODES.LEDGER_SHAPE,
        message: `${label}.tier must be one of ${TIERS.join("|")}`,
      });
      return;
    }
    const evidence = row.evidence;
    if (!Array.isArray(evidence)) {
      issues.push({
        code: ISSUE_CODES.LEDGER_SHAPE,
        message: `${label}.evidence must be an array`,
      });
      return;
    }
    rows.push({
      index,
      path,
      method,
      tag: readString(row, "tag") ?? "untagged",
      tier,
      capturedResponse: row.capturedResponse === true,
      contradicted: row.contradicted === true,
      contradictedReason: readString(row, "contradictedReason") ?? null,
      evidence,
    });
  });
  const rawSurfaces = parsed.surfaces;
  const surfaces: Record<string, unknown>[] = Array.isArray(rawSurfaces)
    ? rawSurfaces.filter(isRecord)
    : [];
  if (issues.length > 0) return { issues };
  return { view: { document: parsed, rows, surfaces }, issues: [] };
}

export function tierCountsOf(rows: readonly LedgerRowView[]): TierCounts {
  const counts = emptyCounts();
  for (const row of rows) counts[row.tier] += 1;
  counts.total = rows.length;
  return counts;
}

export function surfaceCountsOf(surfaces: readonly Record<string, unknown>[]): {
  readonly D: number;
  readonly E: number;
  readonly total: number;
} {
  let d = 0;
  let e = 0;
  for (const surface of surfaces) {
    if (surface.tier === "D") d += 1;
    if (surface.tier === "E") e += 1;
  }
  return { D: d, E: e, total: surfaces.length };
}

export function countsMatchDeclared(ledger: Record<string, unknown>): boolean {
  const rawCounts = ledger.counts;
  if (!isRecord(rawCounts)) return false;
  const rawOperations = ledger.operations;
  if (!Array.isArray(rawOperations)) return false;
  const rows: LedgerRowView[] = [];
  for (let index = 0; index < rawOperations.length; index += 1) {
    const row = rawOperations[index];
    if (!isRecord(row)) return false;
    const path = readString(row, "path");
    const method = readString(row, "method");
    const tier = toTier(row.tier);
    if (path === undefined || method === undefined || tier === undefined) {
      return false;
    }
    const evidence = row.evidence;
    rows.push({
      index,
      path,
      method,
      tag: readString(row, "tag") ?? "untagged",
      tier,
      capturedResponse: row.capturedResponse === true,
      contradicted: row.contradicted === true,
      contradictedReason: readString(row, "contradictedReason") ?? null,
      evidence: Array.isArray(evidence) ? evidence : [],
    });
  }
  const actual = tierCountsOf(rows);
  for (const tier of TIERS) {
    const declared = rawCounts[tier];
    if (typeof declared !== "number" || declared !== actual[tier]) return false;
  }
  return rawCounts.total === actual.total;
}

export interface SpecView {
  readonly keys: ReadonlySet<string>;
}

export function loadSpecKeys(path: string): {
  readonly view?: SpecView;
  readonly issues: readonly CaptureIssue[];
} {
  if (!existsSync(path)) {
    return {
      issues: [
        { code: ISSUE_CODES.SPEC_PARSE, message: `spec not found: ${path}` },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      issues: [
        {
          code: ISSUE_CODES.SPEC_PARSE,
          message: `spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.paths)) {
    return {
      issues: [
        {
          code: ISSUE_CODES.SPEC_PARSE,
          message: "spec.paths must be an object",
        },
      ],
    };
  }
  const keys = new Set<string>();
  for (const [path, pathItem] of Object.entries(parsed.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const method of Object.keys(pathItem)) keys.add(keyOf(path, method));
  }
  return { view: { keys }, issues: [] };
}

/* -------------------------------------------------------------------------- */
/* Capture digests and store manifest                                         */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic sha256 of a capture record: sorted object keys, compact JSON.
 * This matches the `captureHash` the capture tooling writes into the store
 * manifest, so a ledger evidence id stays stable across re-serialization.
 */
export function captureRecordDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export interface ManifestIndex {
  /** relative file path (POSIX) → captureHash from the manifest. */
  readonly hashes: ReadonlyMap<string, string>;
  readonly issues: readonly CaptureIssue[];
}

/**
 * Read every `manifest.json` in the store (root and per-date) and index the
 * capture hashes. The manifest is an index, not an authority: a file listed but
 * missing, or a hash that disagrees with the record, is reported as an issue.
 */
export function loadManifestIndex(capturesDir: string): ManifestIndex {
  const hashes = new Map<string, string>();
  const issues: CaptureIssue[] = [];
  const manifestFiles: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Catalog, 500 diagnostics, schema templates, and runtime capability proofs
        // are not upgradeable ledger operations; keep them out of the manifest walk.
        if (NON_CAPTURE_DIRS.has(entry)) continue;
        walk(full);
      } else if (entry === "manifest.json") manifestFiles.push(full);
    }
  };
  walk(capturesDir);
  for (const manifestPath of manifestFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      issues.push({
        code: ISSUE_CODES.MANIFEST,
        message: `manifest is not valid JSON (${relative(capturesDir, manifestPath)}): ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      issues.push({
        code: ISSUE_CODES.MANIFEST,
        message: `manifest must be schemaVersion 1 (${relative(capturesDir, manifestPath)})`,
      });
      continue;
    }
    const captures = parsed.captures;
    if (!Array.isArray(captures)) continue;
    for (const rawEntry of captures) {
      if (!isRecord(rawEntry)) continue;
      const file = readString(rawEntry, "file");
      const hash = readString(rawEntry, "captureHash");
      if (file === undefined || hash === undefined) continue;
      hashes.set(file.split("\\").join("/"), hash);
    }
  }
  return { hashes, issues };
}

/* -------------------------------------------------------------------------- */
/* Capture validation                                                         */
/* -------------------------------------------------------------------------- */

export interface CaptureRecordView {
  readonly operation: {
    readonly path: string;
    readonly method: string;
    readonly operationId: string | null;
  };
  readonly mode: string;
  readonly capturedAt: string;
  readonly portalHost: string;
  readonly requestUrl: string;
  readonly requestMethod: string;
  readonly requestBodySha256: string;
  readonly responseStatus: number;
  readonly responseBodySha256: string | null;
  readonly responseBytes: number;
  readonly emptyEnvelope: boolean;
}

export interface ParsedCapture {
  readonly record?: CaptureRecordView;
  readonly issues: readonly CaptureIssue[];
}

export function parseCaptureValue(value: unknown): ParsedCapture {
  const issues: CaptureIssue[] = [];
  if (!isRecord(value)) {
    return {
      issues: [
        {
          code: ISSUE_CODES.CAPTURE_PARSE,
          message: "capture record must be a JSON object",
        },
      ],
    };
  }
  if (value.schemaVersion !== 1) {
    issues.push({
      code: ISSUE_CODES.SCHEMA_VERSION,
      message: `schemaVersion must be 1 (found ${JSON.stringify(value.schemaVersion)})`,
    });
  }
  const mode = readString(value, "mode");
  if (mode !== "live") {
    issues.push({
      code: ISSUE_CODES.MODE_NOT_LIVE,
      message: `mode must be "live" (found ${JSON.stringify(value.mode)}); mock/offline captures never upgrade evidence — re-capture with the live gate`,
    });
  }
  const capturedAt = readString(value, "capturedAt");
  if (capturedAt === undefined || Number.isNaN(Date.parse(capturedAt))) {
    issues.push({
      code: ISSUE_CODES.CAPTURED_AT,
      message: "capturedAt must be an ISO-8601 timestamp",
    });
  }

  const operation = value.operation;
  let operationPath: string | undefined;
  let operationMethod: string | undefined;
  let operationId: string | null = null;
  if (!isRecord(operation)) {
    issues.push({
      code: ISSUE_CODES.OP_MISSING,
      message: "operation must be an object with {path, method}",
    });
  } else {
    operationPath = readString(operation, "path");
    operationMethod = readString(operation, "method");
    const maybeId = operation.operationId;
    operationId = typeof maybeId === "string" ? maybeId : null;
    if (operationPath === undefined || !operationPath.startsWith("/")) {
      issues.push({
        code: ISSUE_CODES.OP_MISSING,
        message:
          "operation.path must be an absolute API path (e.g. /cloud/api/Manager/getWebLog)",
      });
    }
    if (operationMethod === undefined || operationMethod === "") {
      issues.push({
        code: ISSUE_CODES.OP_MISSING,
        message: "operation.method must be a non-empty string",
      });
    }
  }
  if (operationPath !== undefined) {
    const operationName = operationNameOf(operationPath);
    const allow = READ_ONLY_OPERATIONS as readonly string[];
    if (!allow.includes(operationName)) {
      const mutations = MUTATION_OPERATIONS as readonly string[];
      issues.push({
        code: ISSUE_CODES.OP_NOT_ALLOWED,
        message: mutations.includes(operationName)
          ? `refused: "${operationName}" is a state mutation; this tool only accepts read-only operations (${READ_ONLY_OPERATIONS.join(", ")})`
          : `operation "${operationName}" is not on the read-only allowlist (${READ_ONLY_OPERATIONS.join(", ")})`,
      });
    }
  }
  if (
    operationMethod !== undefined &&
    operationMethod.toUpperCase() !== "POST"
  ) {
    issues.push({
      code: ISSUE_CODES.OP_METHOD,
      message: `operation.method must be POST for the allowlisted Manager reads (found ${operationMethod})`,
    });
  }

  const request = value.request;
  let requestUrl: string | undefined;
  let requestMethod: string | undefined;
  let requestBodySha256: string | undefined;
  if (!isRecord(request)) {
    issues.push({
      code: ISSUE_CODES.REQUEST_MISSING,
      message:
        "request is required (url, method, bodySha256); a response without its request cannot prove the wire contract",
    });
  } else {
    requestUrl = readString(request, "url");
    requestMethod = readString(request, "method");
    requestBodySha256 = readString(request, "bodySha256");
    if (requestUrl === undefined || !/^https?:\/\//.test(requestUrl)) {
      issues.push({
        code: ISSUE_CODES.REQUEST_MISSING,
        message: "request.url must be an absolute http(s) URL",
      });
    }
    if (requestMethod === undefined || requestMethod === "") {
      issues.push({
        code: ISSUE_CODES.REQUEST_MISSING,
        message: "request.method must be a non-empty string",
      });
    }
    if (requestBodySha256 === undefined || !isHexSha256(requestBodySha256)) {
      issues.push({
        code: ISSUE_CODES.REQUEST_MISSING,
        message:
          "request.bodySha256 must be a lowercase hex sha256 of the request body",
      });
    }
  }

  const response = value.response;
  let responseStatus: number | undefined;
  let responseBodySha256: string | null = null;
  let responseBytes = 0;
  let emptyEnvelope = false;
  if (response === null || response === undefined) {
    issues.push({
      code: ISSUE_CODES.RESPONSE_MISSING,
      message:
        "response is missing; tier A requires a real captured response (2xx with bodySkeleton)",
    });
  } else if (!isRecord(response)) {
    issues.push({
      code: ISSUE_CODES.RESPONSE_MISSING,
      message: "response must be an object or null",
    });
  } else {
    const status = readNumber(response, "status");
    responseStatus = status;
    responseBytes = readNumber(response, "bytes") ?? 0;
    if (
      status === undefined ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 299
    ) {
      issues.push({
        code: ISSUE_CODES.RESPONSE_STATUS,
        message: `response.status must be a 2xx integer (found ${JSON.stringify(response.status)})`,
      });
    }
    const skeleton = response.bodySkeleton;
    if (skeleton === null || skeleton === undefined) {
      issues.push({
        code: ISSUE_CODES.RESPONSE_SKELETON,
        message:
          "response.bodySkeleton is required; a captured status without a body shape cannot replace an inferred schema",
      });
    } else if (
      isRecord(skeleton) &&
      skeleton.type === "object" &&
      isRecord(skeleton.fields) &&
      Object.keys(skeleton.fields).length === 1 &&
      isRecord(skeleton.fields.LIST) &&
      skeleton.fields.LIST.type === "string"
    ) {
      emptyEnvelope = true;
    }
    const maybeSha = readString(response, "bodySha256");
    responseBodySha256 =
      maybeSha !== undefined && isHexSha256(maybeSha) ? maybeSha : null;
  }

  const redaction = value.redaction;
  if (!isRecord(redaction)) {
    issues.push({
      code: ISSUE_CODES.REDACTION,
      message:
        "redaction report is required; captures must document what was redacted before persist",
    });
  } else {
    if (redaction.clean !== true) {
      issues.push({
        code: ISSUE_CODES.REDACTION,
        message:
          "redaction.clean must be true; the capture may contain secrets, credentials or PII",
      });
    }
    if (redaction.policyVersion !== 1) {
      issues.push({
        code: ISSUE_CODES.REDACTION_POLICY,
        message: `redaction.policyVersion must be 1 (found ${JSON.stringify(redaction.policyVersion)})`,
      });
    }
  }

  const provenance = value.provenance;
  let portalHost: string | undefined;
  if (!isRecord(provenance)) {
    issues.push({
      code: ISSUE_CODES.PROVENANCE,
      message: "provenance is required (portalHost, proxy, auth, bunVersion)",
    });
  } else {
    portalHost = readString(provenance, "portalHost");
    if (portalHost === undefined || portalHost === "") {
      issues.push({
        code: ISSUE_CODES.PROVENANCE,
        message: "provenance.portalHost must name the captured host",
      });
    }
  }

  if (
    issues.length > 0 ||
    operationPath === undefined ||
    operationMethod === undefined ||
    capturedAt === undefined ||
    requestUrl === undefined ||
    requestMethod === undefined ||
    requestBodySha256 === undefined ||
    responseStatus === undefined ||
    portalHost === undefined
  ) {
    return { issues };
  }
  return {
    issues: [],
    record: {
      operation: { path: operationPath, method: operationMethod, operationId },
      mode: mode ?? "unknown",
      capturedAt,
      portalHost,
      requestUrl,
      requestMethod,
      requestBodySha256,
      responseStatus,
      responseBodySha256,
      responseBytes,
      emptyEnvelope,
    },
  };
}

const NON_CAPTURE_FILES = new Set(["manifest.json", "run.json"]);
const NON_CAPTURE_DIRS = new Set([
  "catalog",
  "pending-500s",
  "schema",
  "runtime",
]);

function isCaptureFile(name: string): boolean {
  if (!name.endsWith(".json")) return false;
  if (NON_CAPTURE_FILES.has(name)) return false;
  if (name.startsWith("applied-")) return false;
  if (name.startsWith("_")) return false;
  return true;
}

/** Recursively collect capture JSON files in deterministic order. */
export function listCaptureFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (NON_CAPTURE_DIRS.has(entry)) continue;
        walk(full);
      } else if (isCaptureFile(entry)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

function existingCaptureDigests(evidence: readonly unknown[]): Set<string> {
  const digests = new Set<string>();
  for (const entry of evidence) {
    if (!isRecord(entry)) continue;
    const source = readString(entry, "source");
    if (source === undefined || !source.startsWith("capture:")) continue;
    const parts = source.split(":");
    const digest = parts[parts.length - 1];
    if (digest !== undefined && digest !== "") digests.add(digest);
  }
  return digests;
}

export interface BuildPlanInput {
  readonly capturesDir: string;
  readonly ledger: LedgerView;
  readonly spec: SpecView;
  readonly manifest: ManifestIndex;
}

export function buildPlan(input: BuildPlanInput): Plan {
  const files = listCaptureFiles(input.capturesDir);
  const discovered = new Set(
    files.map((file) =>
      relative(input.capturesDir, file).split("\\").join("/"),
    ),
  );
  const missingFromStore: RejectionEntry[] = [];
  for (const listed of input.manifest.hashes.keys()) {
    if (discovered.has(listed)) continue;
    missingFromStore.push({
      file: listed,
      operation: null,
      code: ISSUE_CODES.MANIFEST,
      message:
        "manifest lists a capture file that is missing from the store; re-run the capture or refresh the manifest",
    });
  }
  const rowIndex = new Map<string, LedgerRowView>();
  for (const row of input.ledger.rows)
    rowIndex.set(keyOf(row.path, row.method), row);
  const plannedRows = new Set<string>();
  const upgrades: UpgradeEntry[] = [];
  const skips: SkipEntry[] = [];
  const rejections: RejectionEntry[] = [];
  const hypothetical: LedgerRowView[] = [...input.ledger.rows];
  let captureShapedRecords = 0;

  for (const file of files) {
    const relativePath = relative(input.capturesDir, file)
      .split("\\")
      .join("/");
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      rejections.push({
        file: relativePath,
        operation: null,
        code: ISSUE_CODES.CAPTURE_PARSE,
        message: `cannot read capture: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      rejections.push({
        file: relativePath,
        operation: null,
        code: ISSUE_CODES.CAPTURE_PARSE,
        message: `capture is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (isRecord(parsedValue) && parsedValue.schemaVersion === 1) {
      captureShapedRecords += 1;
    }
    const parsed = parseCaptureValue(parsedValue);
    if (parsed.record === undefined) {
      const first = parsed.issues[0];
      rejections.push({
        file: relativePath,
        operation:
          isRecord(parsedValue) && isRecord(parsedValue.operation)
            ? (readString(parsedValue.operation, "path") ?? null)
            : null,
        code: first?.code ?? ISSUE_CODES.CAPTURE_PARSE,
        message: parsed.issues.map((issue) => issue.message).join("; "),
      });
      continue;
    }
    const record = parsed.record;
    const digest = captureRecordDigest(parsedValue);
    const manifestDigest = input.manifest.hashes.get(relativePath);
    if (manifestDigest !== undefined && manifestDigest !== digest) {
      rejections.push({
        file: relativePath,
        operation: operationNameOf(record.operation.path),
        code: ISSUE_CODES.MANIFEST,
        message: `manifest captureHash ${manifestDigest} does not match the record (${digest}); refresh the manifest instead of trusting a stale index`,
      });
      continue;
    }
    const key = keyOf(record.operation.path, record.operation.method);
    const row = rowIndex.get(key);
    if (row === undefined) {
      rejections.push({
        file: relativePath,
        operation: record.operation.path,
        code: ISSUE_CODES.LEDGER_ROW_MISSING,
        message: `no ledger row for ${key}; the ledger is append-only for operations — add the operation first or discard the capture`,
      });
      continue;
    }
    if (!input.spec.keys.has(key)) {
      rejections.push({
        file: relativePath,
        operation: record.operation.path,
        code: ISSUE_CODES.SPEC_OP_MISSING,
        message: `no spec operation for ${key}; regenerate docs/openapi.json (docs:openapi) before applying captures`,
      });
      continue;
    }
    const operationName = operationNameOf(record.operation.path);
    if (row.capturedResponse) {
      skips.push({
        file: relativePath,
        operation: operationName,
        path: record.operation.path,
        reason: "row already has capturedResponse:true (idempotent no-op)",
      });
      continue;
    }
    if (existingCaptureDigests(row.evidence).has(digest)) {
      skips.push({
        file: relativePath,
        operation: operationName,
        path: record.operation.path,
        reason: `same capture sha256 ${digest} already applied (idempotent no-op)`,
      });
      continue;
    }
    if (row.tier !== "B" && row.tier !== "C") {
      skips.push({
        file: relativePath,
        operation: operationName,
        path: record.operation.path,
        reason: row.contradicted
          ? `contradicted tier ${row.tier}: only a contradicted B row can be resolved by a live capture`
          : `tier ${row.tier}: this tool upgrades B/C→A; D/E rows are not upgradable`,
      });
      continue;
    }
    if (plannedRows.has(key)) {
      skips.push({
        file: relativePath,
        operation: operationName,
        path: record.operation.path,
        reason:
          "row already planned by an earlier capture in this run (one upgrade per row)",
      });
      continue;
    }
    const date = record.capturedAt.slice(0, 10);
    let tierReason: string | undefined;
    if (isRecord(parsedValue) && isRecord(parsedValue.provenance)) {
      try {
        const prov = normalizeProvenance(
          parseCaptureProvenance(parsedValue.provenance),
        );
        const derived = deriveTierWithReason({
          provenance: prov,
          response: {
            status: record.responseStatus,
            contentType: "application/json",
            bodySha256: record.responseBodySha256 ?? "0".repeat(64),
            bodySkeleton: { type: "null", nullable: true },
            bytes: record.responseBytes,
          },
        });
        tierReason = derived.reason;
      } catch {
        // Legacy records without 5-axis fields keep undefined tierReason.
      }
    }
    plannedRows.add(key);
    upgrades.push({
      file: relativePath,
      operation: operationName,
      path: record.operation.path,
      method: record.operation.method.toUpperCase(),
      digest,
      capturedAt: record.capturedAt,
      evidenceSource: `capture:${date}:${digest}`,
      responseStatus: record.responseStatus,
      responseBodySha256: record.responseBodySha256,
      responseBytes: record.responseBytes,
      emptyEnvelope: record.emptyEnvelope,
      ...(tierReason === undefined ? {} : { tierReason }),
      resolvesContradiction: row.contradicted,
      previousContradictionReason: row.contradictedReason,
    });
    const hypotheticalIndex = hypothetical.findIndex(
      (candidate) => keyOf(candidate.path, candidate.method) === key,
    );
    const target = hypothetical[hypotheticalIndex];
    if (target !== undefined) {
      hypothetical[hypotheticalIndex] = {
        ...target,
        tier: "A",
        capturedResponse: true,
      };
    }
  }

  return {
    upgrades,
    skips,
    rejections: [
      ...missingFromStore,
      ...input.manifest.issues.map((issue) => ({
        file: "manifest.json",
        operation: null,
        code: issue.code,
        message: issue.message,
      })),
      ...rejections,
    ],
    countsBefore: tierCountsOf(input.ledger.rows),
    countsAfter: tierCountsOf(hypothetical),
    capturesFound: files.length,
    captureShapedRecords,
  };
}

/* -------------------------------------------------------------------------- */
/* Applying a plan to the ledger document                                     */
/* -------------------------------------------------------------------------- */

export interface ApplyPlanResult {
  readonly ledger: Record<string, unknown>;
  readonly changed: boolean;
  readonly countsBefore: TierCounts;
  readonly countsAfter: TierCounts;
}

function upgradeNote(upgrade: UpgradeEntry): string {
  const sha = upgrade.responseBodySha256 ?? "not recorded";
  const tagPrefix = upgrade.emptyEnvelope ? "[A-empty] " : "";
  const envelopeNote = upgrade.emptyEnvelope
    ? ' Envelope-only 200 response ({"LIST":""}); item row schema is unverified beyond the outer LIST envelope until a capture with rows is recorded.'
    : "";
  const crossPrefixNote =
    upgrade.path === "/cloud/api/Manager/getTransactions"
      ? " Cross-prefix routing observed: POST /cloud/api/Manager/getTransactions returns 200 while POST /cloud/api/Report/getTransactions returns 500."
      : "";
  return `${tagPrefix}Live capture ${upgrade.capturedAt} from a ${upgrade.responseStatus} response (response bodySha256 ${sha}); request and response were captured live with redaction clean (policy v1).${envelopeNote}${crossPrefixNote}`;
}

/**
 * Apply the planned upgrades to an in-memory ledger document.
 *
 * Only upgraded rows change: tier → A, capturedResponse → true, one appended
 * `capture:<date>:<sha256>` evidence entry, and the stale `requiredCapture`
 * cleared to null. Derived aggregates (`counts`, `surfaceCounts`, `countsByTag`)
 * are recomputed from the rows, never incremented by hand.
 */
export function applyPlanToLedger(
  document: Record<string, unknown>,
  plan: Plan,
  resolvedAt: string,
): ApplyPlanResult {
  const ledger = structuredClone(document);
  const operations = ledger.operations;
  if (!Array.isArray(operations)) {
    throw new Error("ledger.operations must be an array");
  }
  const rows: LedgerRowView[] = [];
  const tagsByIndex = new Map<number, string>();
  for (let index = 0; index < operations.length; index += 1) {
    const rawRow = operations[index];
    if (!isRecord(rawRow)) continue;
    const path = readString(rawRow, "path");
    const method = readString(rawRow, "method");
    const tier = toTier(rawRow.tier);
    if (path === undefined || method === undefined || tier === undefined) {
      continue;
    }
    const tag = readString(rawRow, "tag") ?? "untagged";
    tagsByIndex.set(index, tag);
    rows.push({
      index,
      path,
      method,
      tag,
      tier,
      capturedResponse: rawRow.capturedResponse === true,
      contradicted: rawRow.contradicted === true,
      contradictedReason: readString(rawRow, "contradictedReason") ?? null,
      evidence: Array.isArray(rawRow.evidence) ? rawRow.evidence : [],
    });
  }
  const countsBefore = tierCountsOf(rows);
  const upgradedIndexes = new Set<number>();
  for (const upgrade of plan.upgrades) {
    const key = keyOf(upgrade.path, upgrade.method);
    const row = rows.find(
      (candidate) => keyOf(candidate.path, candidate.method) === key,
    );
    if (row === undefined) continue;
    const rawRow = operations[row.index];
    if (!isRecord(rawRow)) continue;
    const evidence = Array.isArray(rawRow.evidence) ? [...rawRow.evidence] : [];
    evidence.push({
      source: upgrade.evidenceSource,
      kind: "capture",
      note: upgradeNote(upgrade),
      ...(upgrade.tierReason === undefined
        ? {}
        : { reason: upgrade.tierReason }),
    });
    const upgradedRow: Record<string, unknown> = {
      ...rawRow,
      tier: "A",
      capturedResponse: true,
      evidence,
      requiredCapture: null,
    };
    if (upgrade.resolvesContradiction) {
      upgradedRow.contradicted = false;
      upgradedRow.contradictedReason = null;
      upgradedRow.resolution = {
        resolvedBy: `capture:${upgrade.file}`,
        resolvedAt,
        previousReason: upgrade.previousContradictionReason ?? "",
      };
    }
    operations[row.index] = upgradedRow;
    upgradedIndexes.add(row.index);
  }
  const nextRows = rows.map((row) =>
    upgradedIndexes.has(row.index)
      ? {
          ...row,
          tier: "A" as Tier,
          capturedResponse: true,
          contradicted: false,
          contradictedReason: null,
        }
      : row,
  );
  const counts = tierCountsOf(nextRows);
  ledger.counts = { ...counts };
  const surfaces = Array.isArray(ledger.surfaces)
    ? ledger.surfaces.filter(isRecord)
    : [];
  ledger.surfaceCounts = { ...surfaceCountsOf(surfaces) };
  const byTag: Record<string, Record<Tier | "total", number>> = {};
  for (const row of nextRows) {
    const tag = tagsByIndex.get(row.index) ?? "untagged";
    const bucket = byTag[tag] ?? { A: 0, B: 0, C: 0, D: 0, E: 0, total: 0 };
    bucket[row.tier] = (bucket[row.tier] ?? 0) + 1;
    bucket.total = (bucket.total ?? 0) + 1;
    byTag[tag] = bucket;
  }
  ledger.countsByTag = byTag;
  return {
    ledger,
    changed: upgradedIndexes.size > 0,
    countsBefore,
    countsAfter: counts,
  };
}

/* -------------------------------------------------------------------------- */
/* Side effects and the apply pipeline                                        */
/* -------------------------------------------------------------------------- */

function spawnStep(cmd: readonly string[], cwd: string): StepResult {
  const result = Bun.spawnSync({
    cmd: [...cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

export function defaultDeps(): ApplyDeps {
  return {
    regenerateSpec: (root) =>
      spawnStep(
        [process.execPath, "run", join(root, "scripts", "generate_openapi.ts")],
        root,
      ),
    regenerateMarkdown: (root) =>
      spawnStep(
        [process.execPath, "run", join(root, "scripts", "generate_docs.ts")],
        root,
      ),
    stageDist: (root) =>
      spawnStep([process.execPath, "run", "docs:stage"], root),
    verifyDocs: (root) =>
      spawnStep(
        [process.execPath, "run", join(root, "scripts", "verify_docs.ts")],
        root,
      ),
    formatFile: (path, root) =>
      spawnStep([process.execPath, "fmt", path], root),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, data);
  renameSync(tempPath, path);
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface Backup {
  readonly path: string;
  readonly existed: boolean;
  readonly bytes: Buffer;
}

function backupFiles(paths: readonly string[]): Backup[] {
  return paths.map((path) =>
    existsSync(path)
      ? { path, existed: true, bytes: readFileSync(path) }
      : { path, existed: false, bytes: Buffer.alloc(0) },
  );
}

function restoreBackups(backups: readonly Backup[]): void {
  for (const backup of backups) {
    if (!backup.existed) {
      rmSync(backup.path, { force: true });
      continue;
    }
    atomicWrite(backup.path, backup.bytes);
  }
}

interface Lock {
  readonly release: () => void;
}

function acquireLock(
  dir: string,
  now: Date,
): { readonly lock?: Lock; readonly error?: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".apply.lock");
  let handle: number;
  try {
    handle = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    );
  } catch {
    return {
      error: `another apply appears to be running (lock: ${path}); inspect running processes before removing the lock`,
    };
  }
  try {
    writeSync(
      handle,
      `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`,
    );
  } finally {
    closeSync(handle);
  }
  return { lock: { release: () => rmSync(path, { force: true }) } };
}

/**
 * Explain a plan with zero upgrades instead of leaving the operator wondering
 * whether the tool is broken. A mock-only or fixture-only store is a PASS: no
 * evidence tier changes, and the message says exactly why.
 */
function noUpgradeWarnings(plan: Plan): string[] {
  if (plan.capturesFound === 0) {
    return [
      `no capture files found under the store; run capture:evidence:live to produce upgradeable captures (mock captures never upgrade evidence)`,
    ];
  }
  if (plan.upgrades.length > 0) return [];
  if (plan.captureShapedRecords === 0) {
    return [
      `none of the ${plan.capturesFound} file(s) parsed as a schemaVersion-1 capture record; if this is tests/fixtures/captures (transport fixtures) or a mock store, that is expected — mock captures never upgrade evidence. Run capture:evidence:live to produce upgradeable captures.`,
    ];
  }
  return [
    `no upgrade planned: ${plan.captureShapedRecords} capture record(s) parsed but all were refused or skipped (mock, non-B, or idempotent); evidence tiers are unchanged — this is a PASS with nothing to upgrade.`,
  ];
}

function tail(text: string, limit = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= limit
    ? trimmed
    : trimmed.slice(trimmed.length - limit);
}

export function summarizeCounts(counts: TierCounts): string {
  return `A${counts.A} B${counts.B} C${counts.C} D${counts.D} E${counts.E} (total ${counts.total})`;
}

interface ResultOverrides {
  readonly ok?: boolean;
  readonly failureKind?: FailureKind | null;
  readonly capturesFound?: number;
  readonly upgrades?: readonly UpgradeEntry[];
  readonly skips?: readonly SkipEntry[];
  readonly rejections?: readonly RejectionEntry[];
  readonly countsBefore?: TierCounts | null;
  readonly countsAfter?: TierCounts | null;
  readonly applied?: boolean;
  readonly auditRecord?: string | null;
  readonly errors?: readonly string[];
  readonly warnings?: readonly string[];
}

function baseResult(
  options: ApplyOptions,
  overrides: ResultOverrides,
): ApplyResult {
  return {
    ok: overrides.ok ?? false,
    failureKind:
      overrides.failureKind === undefined
        ? "input-error"
        : overrides.failureKind,
    mode: options.write ? "write" : "dry-run",
    capturesDir: resolve(options.capturesDir),
    capturesFound: overrides.capturesFound ?? 0,
    upgrades: overrides.upgrades ?? [],
    skips: overrides.skips ?? [],
    rejections: overrides.rejections ?? [],
    countsBefore: overrides.countsBefore ?? null,
    countsAfter: overrides.countsAfter ?? null,
    applied: overrides.applied ?? false,
    auditRecord: overrides.auditRecord ?? null,
    errors: overrides.errors ?? [],
    warnings: overrides.warnings ?? [],
  };
}

/**
 * Apply (or dry-run) the capture store against a root.
 *
 * Exported for tests: inject `deps` to avoid spawning generators/verifier and
 * to force individual pipeline failures.
 */
export function applyCaptures(
  options: ApplyOptions,
  deps: ApplyDeps = defaultDeps(),
): ApplyResult {
  const root = resolve(options.root);
  const capturesDir = resolve(options.capturesDir);
  const ledgerPath = join(root, LEDGER_REL);
  const specPath = join(root, SPEC_REL);
  const markdownPath = join(root, MD_REL);

  if (!existsSync(capturesDir)) {
    return baseResult(options, {
      errors: [
        `${ISSUE_CODES.STORE_MISSING}: capture store not found: ${capturesDir} (run the capture tooling first, or pass --captures <dir>)`,
      ],
    });
  }
  const loaded = loadLedgerFile(ledgerPath);
  if (loaded.view === undefined) {
    return baseResult(options, {
      errors: loaded.issues.map((issue) => `${issue.code}: ${issue.message}`),
    });
  }
  const ledger = loaded.view;
  if (!countsMatchDeclared(ledger.document)) {
    return baseResult(options, {
      errors: [
        `${ISSUE_CODES.LEDGER_COUNTS}: ledger.counts does not match its operation rows; repair the ledger before applying captures`,
      ],
    });
  }
  const spec = loadSpecKeys(specPath);
  if (spec.view === undefined) {
    return baseResult(options, {
      errors: spec.issues.map((issue) => `${issue.code}: ${issue.message}`),
    });
  }
  const manifest = loadManifestIndex(capturesDir);
  const plan = buildPlan({ capturesDir, ledger, spec: spec.view, manifest });
  const warnings = noUpgradeWarnings(plan);

  if (!options.write || plan.upgrades.length === 0) {
    return baseResult(options, {
      ok: true,
      failureKind: null,
      warnings,
      capturesFound: plan.capturesFound,
      upgrades: plan.upgrades,
      skips: plan.skips,
      rejections: plan.rejections,
      countsBefore: plan.countsBefore,
      countsAfter:
        plan.upgrades.length > 0 ? plan.countsAfter : plan.countsBefore,
      applied: false,
    });
  }

  const lockState = acquireLock(capturesDir, deps.now());
  if (lockState.lock === undefined) {
    return baseResult(options, {
      errors: [
        `${ISSUE_CODES.LOCK_HELD}: ${lockState.error ?? "lock unavailable"}`,
      ],
    });
  }
  const lock = lockState.lock;
  const backups = backupFiles([ledgerPath, specPath, markdownPath]);
  let auditPath: string | null = null;
  try {
    const applied = applyPlanToLedger(
      ledger.document,
      plan,
      deps.now().toISOString(),
    );
    atomicWrite(ledgerPath, `${JSON.stringify(applied.ledger, null, 2)}\n`);
    const formatted = deps.formatFile(ledgerPath, root);
    if (!formatted.ok) {
      throw new Error(
        `repo formatter rejected the upgraded ledger (exit ${formatted.code}): ${tail(formatted.stderr || formatted.stdout)}`,
      );
    }
    const specStep = deps.regenerateSpec(root);
    if (!specStep.ok) {
      const details = specStep.stderr || specStep.stdout;
      const hint = /ledger counts mismatch/i.test(details)
        ? " The generator derives counts from the ledger rows; a mismatch means the ledger was hand-edited or half-written — recompute counts (apply_captures does this) and retry."
        : /capture|tier A/i.test(details)
          ? " Tier-A rows are rendered only from a valid live capture in the store; fix the rejected capture record (see the generator's reasons) and re-run."
          : "";
      throw new Error(
        `docs/openapi.json regeneration failed (exit ${specStep.code}): ${tail(details)}.${hint}`,
      );
    }
    const markdownStep = deps.regenerateMarkdown(root);
    if (!markdownStep.ok) {
      throw new Error(
        `docs/api-reference.md regeneration failed (exit ${markdownStep.code}): ${tail(markdownStep.stderr || markdownStep.stdout)}`,
      );
    }
    const stageStep = deps.stageDist?.(root);
    if (stageStep !== undefined && !stageStep.ok) {
      throw new Error(
        `dist staging failed (exit ${stageStep.code}): ${tail(stageStep.stderr || stageStep.stdout)}`,
      );
    }
    const verifyStep = deps.verifyDocs(root);
    if (!verifyStep.ok) {
      throw new Error(
        `docs gate rejected the upgraded evidence (exit ${verifyStep.code}): ${tail(verifyStep.stderr || verifyStep.stdout)}`,
      );
    }
    const date = deps.now().toISOString().slice(0, 10);
    auditPath = join(capturesDir, `applied-${date}.json`);
    atomicWriteJson(auditPath, {
      schemaVersion: 1,
      appliedAt: deps.now().toISOString(),
      tool: "scripts/apply_captures.ts",
      capturesDir,
      ledgerCountsBefore: plan.countsBefore,
      ledgerCountsAfter: applied.countsAfter,
      upgrades: plan.upgrades,
      skips: plan.skips,
      rejections: plan.rejections,
      verify: { ok: true, exitCode: verifyStep.code },
    });
    return baseResult(options, {
      ok: true,
      failureKind: null,
      warnings,
      capturesFound: plan.capturesFound,
      upgrades: plan.upgrades,
      skips: plan.skips,
      rejections: plan.rejections,
      countsBefore: plan.countsBefore,
      countsAfter: applied.countsAfter,
      applied: true,
      auditRecord: auditPath,
    });
  } catch (error) {
    restoreBackups(backups);
    // Keep dist/ consistent with the restored docs (best effort).
    deps.stageDist?.(root);
    if (auditPath !== null) rmSync(auditPath, { force: true });
    return baseResult(options, {
      failureKind: "write-failed",
      warnings,
      capturesFound: plan.capturesFound,
      upgrades: plan.upgrades,
      skips: plan.skips,
      rejections: plan.rejections,
      countsBefore: plan.countsBefore,
      countsAfter: null,
      errors: [
        `${ISSUE_CODES.WRITE_FAILED}: ${error instanceof Error ? error.message : String(error)} — ledger, spec and markdown were restored`,
      ],
    });
  } finally {
    lock.release();
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

const USAGE = `apply_captures — upgrade evidence-ledger rows from live capture records

Usage:
  bun run scripts/apply_captures.ts [--captures DIR] [--dry-run] [--json] [--root DIR]
  bun run scripts/apply_captures.ts [--captures DIR] --write [--json] [--root DIR]

Options:
  --captures DIR  capture store (default: <root>/docs/evidence/captures)
  --dry-run       validate + print the upgrade plan; never writes (default)
  --write         apply B->A upgrades, regenerate spec + markdown, run the docs gate
  --json          machine-readable output
  --root DIR      repository root to operate on (default: this checkout)
  --help          show this help

Rules: live read-only captures only (${READ_ONLY_OPERATIONS.join(", ")});
mock/offline, redaction-dirty, mutation and response-less captures are refused.
Tier B and C rows are upgraded to A from a valid live capture; a contradicted B
row is resolved by such a capture (the previous reason is preserved). --write
regenerates spec + markdown, re-stages dist/, runs the docs gate, and restores
ledger/spec/markdown on any failure.
`;

export interface CliOptions {
  readonly options: ApplyOptions;
}

export interface CliParseFailure {
  readonly error: string;
}

export function parseCliArgs(
  argv: readonly string[],
  defaultRoot: string = DEFAULT_ROOT,
): CliOptions | CliParseFailure {
  let root = defaultRoot;
  let capturesDir: string | undefined;
  let write = false;
  let dryRun = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") return { error: USAGE };
    if (argument === "--write") {
      write = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--captures" || argument === "--root") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: `${argument} requires a path\n${USAGE}` };
      }
      if (argument === "--captures") capturesDir = resolve(next);
      else root = resolve(next);
      index += 1;
      continue;
    }
    return { error: `unknown argument: ${argument}\n${USAGE}` };
  }
  if (write && dryRun) {
    return { error: `choose either --write or --dry-run, not both\n${USAGE}` };
  }
  return {
    options: {
      root: resolve(root),
      capturesDir: capturesDir ?? join(resolve(root), CAPTURES_REL),
      write,
      json,
    },
  };
}

function printHumanResult(result: ApplyResult, deps: ApplyDeps): void {
  const log = deps.log;
  if (!result.ok && result.failureKind === "input-error") {
    log("apply_captures — input error (nothing was read or written)");
    log(`captures: ${result.capturesDir}`);
    for (const error of result.errors) log(`ERROR: ${error}`);
    return;
  }
  log(
    `apply_captures — ${
      result.mode === "dry-run" ? "DRY RUN (no files will be written)" : "write"
    }`,
  );
  log(`captures: ${result.capturesDir}`);
  log(
    `found: ${result.capturesFound} file(s); planned upgrades: ${result.upgrades.length}`,
  );
  if (result.upgrades.length > 0) {
    log("");
    log("PLANNED UPGRADES");
    for (const upgrade of result.upgrades) {
      const suffix = upgrade.resolvesContradiction
        ? "  (resolves contradiction)"
        : "";
      log(`  B→A${suffix}  ${upgrade.operation}  ${upgrade.path}`);
      log(`       ${upgrade.evidenceSource}  capture: ${upgrade.file}`);
    }
  }
  if (result.skips.length > 0) {
    log("");
    log("SKIPPED");
    for (const skip of result.skips) {
      log(`  - ${skip.operation}: ${skip.reason} (${skip.file})`);
    }
  }
  if (result.rejections.length > 0) {
    log("");
    log("REFUSED");
    for (const rejection of result.rejections) {
      log(`  - [${rejection.code}] ${rejection.file}: ${rejection.message}`);
    }
  }
  if (result.countsBefore !== null && result.countsAfter !== null) {
    log("");
    log(
      `counts: ${summarizeCounts(result.countsBefore)} → ${summarizeCounts(result.countsAfter)}`,
    );
  }
  log("");
  if (result.mode === "dry-run") {
    log("No files written. Re-run with --write to apply.");
  } else if (result.applied) {
    log(
      `applied ${result.upgrades.length} upgrade(s); docs regenerated and verified; audit: ${result.auditRecord ?? "not written"}`,
    );
  } else {
    log("nothing to apply (idempotent no-op)");
  }
  for (const warning of result.warnings) log(`NOTE: ${warning}`);
  for (const error of result.errors) log(`ERROR: ${error}`);
}

function toJsonPayload(result: ApplyResult): Record<string, unknown> {
  return {
    ok: result.ok,
    failureKind: result.failureKind,
    mode: result.mode,
    capturesDir: result.capturesDir,
    capturesFound: result.capturesFound,
    upgrades: result.upgrades,
    skips: result.skips,
    rejections: result.rejections,
    countsBefore: result.countsBefore,
    countsAfter: result.countsAfter,
    applied: result.applied,
    auditRecord: result.auditRecord,
    errors: result.errors,
    warnings: result.warnings,
  };
}

export function main(
  argv: readonly string[],
  deps: ApplyDeps = defaultDeps(),
  defaultRoot: string = DEFAULT_ROOT,
): number {
  const parsed = parseCliArgs(argv, defaultRoot);
  if ("error" in parsed) {
    const isHelp = parsed.error.startsWith("apply_captures");
    const text = parsed.error.endsWith("\n")
      ? parsed.error
      : `${parsed.error}\n`;
    if (isHelp) process.stdout.write(text);
    else process.stderr.write(text);
    return isHelp ? 0 : 2;
  }
  const result = applyCaptures(parsed.options, deps);
  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(toJsonPayload(result), null, 2)}\n`);
  } else {
    printHumanResult(result, deps);
  }
  if (result.ok) return 0;
  return result.failureKind === "write-failed" ? 1 : 2;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `apply_captures crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 2;
  }
}
