/**
 * verify_docs.ts — self-guarding verification gate for the SportsDesk docs delivery.
 *
 * Why this exists: the deployed Scalar docs were found to be untrustworthy
 * (fabricated GS wire contract, invented getWebLog response schema, dangling
 * BearerAuth refs, unpinned CDN Scalar, no dist/live checks). Each reviewed
 * failure is encoded below as an explicit, actionable gate so it cannot return.
 *
 * Usage:
 *   bun run scripts/verify_docs.ts                 # local/repo gate
 *   bun run scripts/verify_docs.ts --strict        # require the P3 generator
 *   bun run scripts/verify_docs.ts --live <url>    # compare deployed spec hash
 *   bun run scripts/verify_docs.ts --root <path>   # run against another checkout
 *
 * Design: every check is an exported pure function over in-memory data so the
 * unit tests can prove the gate bites. Only `runChecks`/`main` touch the disk.
 * Stdlib only (bun + node builtins); no third-party dependencies.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { resolveCitation } from "../lib/ledger_consistency.ts";
import { loadManifestIndex } from "./apply_captures.ts";

/* -------------------------------------------------------------------------- */
/* Shared types                                                               */
/* -------------------------------------------------------------------------- */

/** Evidence tiers from docs/EVIDENCE.md (ledger also carries E for surfaces). */
export const TIERS = ["A", "B", "C", "D"] as const;
export type Tier = (typeof TIERS)[number];

/** Ledger-only tier: documented-but-not-implemented surface. */
export const LEDGER_TIERS = ["A", "B", "C", "D", "E"] as const;
export type LedgerTier = (typeof LEDGER_TIERS)[number];

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Machine-readable issue codes; tests assert on these. */
export const CODES = {
  SPEC_MISSING: "E_SPEC_MISSING",
  SPEC_STALE: "E_SPEC_STALE",
  SPEC_GENERATOR_FAILED: "E_SPEC_GENERATOR_FAILED",
  SPEC_GENERATOR_MISSING: "E_SPEC_GENERATOR_MISSING",
  SPEC_PARSE: "E_SPEC_PARSE",
  SPEC_NOT_OBJECT: "E_SPEC_NOT_OBJECT",
  OPENAPI_VERSION: "E_OPENAPI_VERSION",
  INFO_INVALID: "E_INFO_INVALID",
  SERVERS_MISSING: "E_SERVERS_MISSING",
  SERVER_FABRICATED: "E_SERVER_FABRICATED",
  SERVER_REQUIRED: "E_SERVER_REQUIRED",
  PATHS_MISSING: "E_PATHS_MISSING",
  NO_OPERATIONS: "E_NO_OPERATIONS",
  FORBIDDEN_PATH: "E_FORBIDDEN_PATH",
  TAGS_DECLARED_MISSING: "E_TAGS_DECLARED_MISSING",
  TAG_UNDECLARED: "E_TAG_UNDECLARED",
  TAG_UNUSED: "E_TAG_UNUSED",
  TAG_DUPLICATE: "E_TAG_DUPLICATE",
  OP_TAG_MISSING: "E_OP_TAG_MISSING",
  EVIDENCE_MISSING: "E_EVIDENCE_MISSING",
  EVIDENCE_TIER_INVALID: "E_EVIDENCE_TIER_INVALID",
  EVIDENCE_SOURCES: "E_EVIDENCE_SOURCES",
  EVIDENCE_SOURCES_EMPTY: "E_EVIDENCE_SOURCES_EMPTY",
  EVIDENCE_CAPTURED_FLAG: "E_EVIDENCE_CAPTURED_FLAG",
  EVIDENCE_TIER_CAPTURE_CONFLICT: "E_EVIDENCE_TIER_CAPTURE_CONFLICT",
  RESPONSES_MISSING: "E_RESPONSES_MISSING",
  GETWEBLOG_RESPONSE_MISSING: "E_GETWEBLOG_RESPONSE_MISSING",
  GETWEBLOG_RESPONSE_CONTENT: "E_GETWEBLOG_RESPONSE_CONTENT",
  GETWEBLOG_TIER_A_CAPTURE_INVALID: "E_GETWEBLOG_TIER_A_CAPTURE_INVALID",
  TIER_C_RESPONSE_CONTENT: "E_TIER_C_RESPONSE_CONTENT",
  OPID_DUPLICATE: "E_OPID_DUPLICATE",
  SECURITY_SCHEMES_MISSING: "E_SECURITY_SCHEMES_MISSING",
  SECURITY_SCHEME_REQUIRED: "E_SECURITY_SCHEME_REQUIRED",
  SECURITY_SCHEME_INVALID: "E_SECURITY_SCHEME_INVALID",
  SECURITY_REF_DANGLING: "E_SECURITY_REF_DANGLING",
  SECURITY_SHAPE: "E_SECURITY_SHAPE",
  REF_DANGLING: "E_REF_DANGLING",
  LEDGER_MISSING: "E_LEDGER_MISSING",
  LEDGER_PARSE: "E_LEDGER_PARSE",
  LEDGER_SHAPE: "E_LEDGER_SHAPE",
  LEDGER_OP_MISSING: "E_LEDGER_OP_MISSING",
  LEDGER_OP_EXTRA: "E_LEDGER_OP_EXTRA",
  LEDGER_TIER_MISMATCH: "E_LEDGER_TIER_MISMATCH",
  LEDGER_EVIDENCE_WEAK: "E_LEDGER_EVIDENCE_WEAK",
  LEDGER_CAPTURED_CONFLICT: "E_LEDGER_CAPTURED_CONFLICT",
  LEDGER_COUNTS_MISSING: "E_LEDGER_COUNTS_MISSING",
  LEDGER_COUNT_MISMATCH: "E_LEDGER_COUNT_MISMATCH",
  MD_MISSING: "E_MD_MISSING",
  MD_EMPTY: "E_MD_EMPTY",
  MD_UNDEFINED: "E_MD_UNDEFINED",
  MD_TOO_SMALL: "E_MD_TOO_SMALL",
  MD_STALE: "E_MD_STALE",
  MD_GENERATOR_FAILED: "E_MD_GENERATOR_FAILED",
  MD_GENERATOR_MISSING: "E_MD_GENERATOR_MISSING",
  HTML_MISSING: "E_HTML_MISSING",
  SCALAR_MISSING: "E_SCALAR_MISSING",
  SCALAR_UNPINNED: "E_SCALAR_UNPINNED",
  SCALAR_SRI: "E_SCALAR_SRI",
  SCALAR_CROSSORIGIN: "E_SCALAR_CROSSORIGIN",
  OPENAPI_REF: "E_OPENAPI_REF",
  LEGACY_REDOC: "E_LEGACY_REDOC",
  HEADERS_MISSING: "E_HEADERS_MISSING",
  HEADER_REQUIRED: "E_HEADER_REQUIRED",
  HEADER_CSP_CDN: "E_HEADER_CSP_CDN",
  DIST_STALE: "E_DIST_STALE",
  DIST_MISSING_FILE: "E_DIST_MISSING_FILE",
  PKG_UNREADABLE: "E_PKG_UNREADABLE",
  PKG_SCRIPT_MISSING: "E_PKG_SCRIPT_MISSING",
  PKG_SCRIPT_INVALID: "E_PKG_SCRIPT_INVALID",
  LIVE_SPEC_FETCH: "E_LIVE_SPEC_FETCH",
  LIVE_SPEC_DRIFT: "E_LIVE_SPEC_DRIFT",
} as const;

export type IssueCode = (typeof CODES)[keyof typeof CODES];

export interface Issue {
  readonly code: IssueCode;
  readonly message: string;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckOutcome {
  readonly name: string;
  readonly status: CheckStatus;
  readonly issues: readonly Issue[];
  readonly notes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(code: IssueCode, message: string): Issue {
  return { code, message };
}

function passed(name: string, notes: readonly string[] = []): CheckOutcome {
  return { name, status: "pass", issues: [], notes };
}

function failed(
  name: string,
  issues: readonly Issue[],
  notes: readonly string[] = [],
): CheckOutcome {
  return { name, status: "fail", issues, notes };
}

function skipped(name: string, notes: readonly string[]): CheckOutcome {
  return { name, status: "skip", issues: [], notes };
}

function show(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function truncate(text: string, limit = 160): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

export function sha256(bytes: Buffer | string): string {
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

function isSpecTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

function isLedgerTier(value: string): value is LedgerTier {
  return (LEDGER_TIERS as readonly string[]).includes(value);
}

/** Locate a literal needle in raw JSON text and return a `file:line` label. */
function locateLine(rawText: string | undefined, needle: string): string {
  if (rawText === undefined) return "";
  const needleIndex = rawText.indexOf(needle);
  if (needleIndex === -1) return "";
  const line = rawText.slice(0, needleIndex).split("\n").length;
  return ` at line ${line}`;
}

export interface Operation {
  readonly path: string;
  readonly method: HttpMethod;
  readonly operation: Record<string, unknown>;
}

/** Every path/method pair in the spec, in declaration order. */
export function collectOperations(spec: unknown): Operation[] {
  const operations: Operation[] = [];
  if (!isRecord(spec)) return operations;
  const paths = spec.paths;
  if (!isRecord(paths)) return operations;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (isHttpMethod(method) && isRecord(operation)) {
        operations.push({ path, method, operation });
      }
    }
  }
  return operations;
}

export interface SecurityReference {
  readonly scheme: string;
  readonly location: string;
}

/** Every security scheme name referenced by root security or an operation. */
export function collectSecurityRefs(spec: unknown): SecurityReference[] {
  const references: SecurityReference[] = [];
  if (!isRecord(spec)) return references;
  collectSecurityRequirements(spec.security, "root security", references);
  for (const operation of collectOperations(spec)) {
    const location = `${operation.method.toUpperCase()} ${operation.path}`;
    collectSecurityRequirements(
      operation.operation.security,
      location,
      references,
    );
  }
  return references;
}

function collectSecurityRequirements(
  requirements: unknown,
  location: string,
  references: SecurityReference[],
): void {
  if (!Array.isArray(requirements)) return;
  for (const requirement of requirements) {
    if (!isRecord(requirement)) continue;
    for (const scheme of Object.keys(requirement)) {
      references.push({ scheme, location });
    }
  }
}

interface LocalReference {
  readonly ref: string;
  readonly location: string;
}

function collectReferences(
  value: unknown,
  location: string,
  references: LocalReference[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectReferences(entry, `${location}[${index}]`, references),
    );
    return;
  }
  if (!isRecord(value)) return;
  const ref = value["$ref"];
  if (typeof ref === "string") references.push({ ref, location });
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") continue;
    collectReferences(child, `${location}.${key}`, references);
  }
}

/** Resolve a local JSON pointer (`#/a/b`) against the spec root. */
export function resolvesLocalRef(root: unknown, ref: string): boolean {
  if (!ref.startsWith("#/")) return true; // external refs are out of scope
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cursor)) return false;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return false;
    cursor = cursor[segment];
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Check: OpenAPI spec structure / evidence / fabricated-contract guards      */
/* -------------------------------------------------------------------------- */

const REQUIRED_SECURITY_SCHEMES = ["fantasy402Cookie", "daemonBearer"] as const;
const FORBIDDEN_PATH_FRAGMENTS = [
  "/manager-tools/ajax.php",
  "ajax.php",
] as const;
const FORBIDDEN_SERVER_FRAGMENTS = ["plive.sportswidgets.pro"] as const;

const VALID_SCHEME_TYPES = [
  "apiKey",
  "http",
  "oauth2",
  "openIdConnect",
  "mutualTLS",
] as const;

function validateSecurityScheme(
  name: string,
  scheme: unknown,
  issues: Issue[],
): void {
  if (!isRecord(scheme)) {
    issues.push(
      problem(
        CODES.SECURITY_SCHEME_INVALID,
        `components.securitySchemes.${name} must be an object`,
      ),
    );
    return;
  }
  const type = scheme.type;
  if (
    typeof type !== "string" ||
    !(VALID_SCHEME_TYPES as readonly string[]).includes(type)
  ) {
    issues.push(
      problem(
        CODES.SECURITY_SCHEME_INVALID,
        `components.securitySchemes.${name}.type must be one of ${VALID_SCHEME_TYPES.join("|")}; found ${show(type)}`,
      ),
    );
    return;
  }
  if (type === "apiKey") {
    if (typeof scheme.name !== "string" || scheme.name === "") {
      issues.push(
        problem(
          CODES.SECURITY_SCHEME_INVALID,
          `components.securitySchemes.${name} is apiKey but has no cookie/header "name"`,
        ),
      );
    }
    if (
      scheme.in !== "cookie" &&
      scheme.in !== "header" &&
      scheme.in !== "query"
    ) {
      issues.push(
        problem(
          CODES.SECURITY_SCHEME_INVALID,
          `components.securitySchemes.${name} is apiKey but "in" must be cookie|header|query`,
        ),
      );
    }
  }
  if (type === "http" && typeof scheme.scheme !== "string") {
    issues.push(
      problem(
        CODES.SECURITY_SCHEME_INVALID,
        `components.securitySchemes.${name} is http but has no "scheme" (e.g. bearer)`,
      ),
    );
  }
}

const CAPTURE_STORE_PREFIX = "docs/evidence/captures/";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * A tier-A operation that publishes response content must name the live
 * capture record its schema was derived from (`x-capture`). This is what keeps
 * the getWebLog 200-content allowance honest: content is only legal when a real
 * captured response exists, not when a tier-B row is hand-edited to claim one.
 */
function validateTierACaptureProvenance(
  value: unknown,
  label: string,
): string | undefined {
  if (!isRecord(value)) {
    return `${label}: x-evidence.tier="A" with capturedResponse=true and a 200 content schema, but no x-capture object names the live capture record`;
  }
  const file = value.file;
  if (typeof file !== "string" || file.trim() === "") {
    return `${label}: x-capture.file must be a non-empty path to the live capture record`;
  }
  const normalizedFile = file.replace(/^\.\//, "").replace(/\\/g, "/");
  const underCaptureStore =
    normalizedFile.includes(CAPTURE_STORE_PREFIX) ||
    (!normalizedFile.startsWith("/") &&
      !normalizedFile.split("/").includes(".."));
  if (!underCaptureStore || !normalizedFile.endsWith(".json")) {
    return `${label}: x-capture.file ${JSON.stringify(file)} must be a .json record under docs/evidence/captures/ (paths relative to the capture store are allowed)`;
  }
  const sha256Value = value.sha256;
  if (
    typeof sha256Value !== "string" ||
    !SHA256_HEX_PATTERN.test(sha256Value)
  ) {
    return `${label}: x-capture.sha256 must be a 64-character hex sha256; found ${show(sha256Value)}`;
  }
  const capturedAt = value.capturedAt;
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) {
    return `${label}: x-capture.capturedAt must be an ISO-8601 timestamp; found ${show(capturedAt)}`;
  }
  const status = value.status;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 299
  ) {
    return `${label}: x-capture.status must be a 2xx integer HTTP status; found ${show(status)}`;
  }
  const samples = value.samples;
  if (
    typeof samples !== "number" ||
    !Number.isInteger(samples) ||
    samples < 1
  ) {
    return `${label}: x-capture.samples must be an integer >= 1; found ${show(samples)}`;
  }
  return undefined;
}

/**
 * Validate spec structure, evidence completeness, tag consistency, security
 * references and the fabricated-contract regression guards.
 *
 * `rawText` enables `file:line` hints for the forbidden-server/path guards.
 */
export function checkOpenApi(spec: unknown, rawText?: string): CheckOutcome {
  const name = "openapi.json (valid, evidence, tags, security, no fabrication)";
  const issues: Issue[] = [];
  const notes: string[] = [];

  if (!isRecord(spec)) {
    return failed(name, [
      problem(
        CODES.SPEC_NOT_OBJECT,
        "docs/openapi.json must contain a JSON object at the top level",
      ),
    ]);
  }

  if (spec.openapi !== "3.1.0") {
    issues.push(
      problem(
        CODES.OPENAPI_VERSION,
        `"openapi" must be exactly "3.1.0"; found ${show(spec.openapi)}`,
      ),
    );
  }

  const info = spec.info;
  const hasInfo =
    isRecord(info) &&
    typeof info.title === "string" &&
    info.title.trim() !== "" &&
    typeof info.version === "string" &&
    info.version.trim() !== "";
  if (!hasInfo) {
    issues.push(
      problem(
        CODES.INFO_INVALID,
        `"info.title" and "info.version" must be non-empty strings`,
      ),
    );
  }

  // Servers: expected real targets present, fabricated GS gateway absent.
  const servers = spec.servers;
  const serverUrls: string[] = [];
  if (!Array.isArray(servers) || servers.length === 0) {
    issues.push(
      problem(
        CODES.SERVERS_MISSING,
        `"servers" must list at least https://www.fantasy402.com and http://127.0.0.1:4020`,
      ),
    );
  } else {
    for (const server of servers) {
      if (isRecord(server) && typeof server.url === "string") {
        serverUrls.push(server.url);
      }
    }
    for (const url of serverUrls) {
      for (const fragment of FORBIDDEN_SERVER_FRAGMENTS) {
        if (url.includes(fragment)) {
          const location = locateLine(rawText, fragment);
          issues.push(
            problem(
              CODES.SERVER_FABRICATED,
              `docs/openapi.json${location}: server "${url}" contains fabricated ${fragment}; the GS partner gateway is blocked_contract and must not be presented as a documented server`,
            ),
          );
        }
      }
    }
    if (!serverUrls.some((url) => url.includes("fantasy402.com"))) {
      issues.push(
        problem(
          CODES.SERVER_REQUIRED,
          `docs/openapi.json: servers must include the real cloud target (https://www.fantasy402.com)`,
        ),
      );
    }
    if (!serverUrls.some((url) => url.includes("127.0.0.1:4020"))) {
      issues.push(
        problem(
          CODES.SERVER_REQUIRED,
          `docs/openapi.json: servers must include the local daemon target (http://127.0.0.1:4020)`,
        ),
      );
    }
  }

  const paths = spec.paths;
  if (!isRecord(paths) || Object.keys(paths).length === 0) {
    issues.push(
      problem(CODES.PATHS_MISSING, `"paths" must be a non-empty object`),
    );
  }

  // Forbidden fabricated path (guard once per matching path key).
  if (isRecord(paths)) {
    for (const path of Object.keys(paths)) {
      for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
        if (path.includes(fragment)) {
          const location = locateLine(rawText, path);
          issues.push(
            problem(
              CODES.FORBIDDEN_PATH,
              `docs/openapi.json${location}: path "${path}" is a fabricated wire contract (ajax.php is blocked_contract: no URL/method/auth/response was ever captured). Remove it from the spec; document the GS surfaces in docs/gs-manager-contracts.md as blocked.`,
            ),
          );
          break;
        }
      }
    }
  }

  // Security schemes + references.
  const components = isRecord(spec.components) ? spec.components : undefined;
  const securitySchemes =
    components !== undefined && isRecord(components.securitySchemes)
      ? components.securitySchemes
      : undefined;
  if (securitySchemes === undefined) {
    issues.push(
      problem(
        CODES.SECURITY_SCHEMES_MISSING,
        `"components.securitySchemes" is required; declare fantasy402Cookie (apiKey cookie) and daemonBearer (http bearer) and reference them from operations`,
      ),
    );
  } else {
    const schemeNames = Object.keys(securitySchemes);
    if (schemeNames.length === 0) {
      issues.push(
        problem(
          CODES.SECURITY_SCHEMES_MISSING,
          `"components.securitySchemes" is empty; declare fantasy402Cookie and daemonBearer`,
        ),
      );
    }
    for (const required of REQUIRED_SECURITY_SCHEMES) {
      if (!schemeNames.includes(required)) {
        issues.push(
          problem(
            CODES.SECURITY_SCHEME_REQUIRED,
            `components.securitySchemes.${required} is required; found [${schemeNames.join(", ")}]`,
          ),
        );
      }
    }
    for (const [schemeName, scheme] of Object.entries(securitySchemes)) {
      validateSecurityScheme(schemeName, scheme, issues);
    }
  }
  for (const reference of collectSecurityRefs(spec)) {
    const declared =
      securitySchemes !== undefined &&
      Object.prototype.hasOwnProperty.call(securitySchemes, reference.scheme);
    if (!declared) {
      issues.push(
        problem(
          CODES.SECURITY_REF_DANGLING,
          `${reference.location} references security scheme "${reference.scheme}" which is not declared in components.securitySchemes`,
        ),
      );
    }
  }

  // Every local $ref must resolve (catches dangling refs before a viewer does).
  const references: LocalReference[] = [];
  collectReferences(spec, "$", references);
  for (const reference of references) {
    if (!reference.ref.startsWith("#/")) continue;
    if (!resolvesLocalRef(spec, reference.ref)) {
      issues.push(
        problem(
          CODES.REF_DANGLING,
          `${reference.location} has dangling local $ref "${reference.ref}"`,
        ),
      );
    }
  }

  // Operations: evidence, tags, responses, fabricated-response guards.
  const operations = collectOperations(spec);
  if (operations.length === 0) {
    issues.push(
      problem(
        CODES.NO_OPERATIONS,
        `docs/openapi.json declares no path operations; expected the evidenced surface list`,
      ),
    );
  }
  const usedTags = new Set<string>();
  const operationIds = new Map<string, string>();
  for (const operation of operations) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`;

    // x-evidence
    const evidence = operation.operation["x-evidence"];
    let operationTier: string | undefined;
    let operationCapturedResponse: boolean | undefined;
    if (!isRecord(evidence)) {
      issues.push(
        problem(
          CODES.EVIDENCE_MISSING,
          `${label}: missing x-evidence object ({tier: "A"|"B"|"C"|"D", sources: [...], capturedResponse: boolean}); every operation must state its evidence tier`,
        ),
      );
    } else {
      const tier = evidence.tier;
      operationTier = typeof tier === "string" ? tier : undefined;
      if (typeof tier !== "string" || !isSpecTier(tier)) {
        issues.push(
          problem(
            CODES.EVIDENCE_TIER_INVALID,
            `${label}: x-evidence.tier must be one of A|B|C|D; found ${show(tier)}`,
          ),
        );
      } else {
        const sources = evidence.sources;
        if (!Array.isArray(sources)) {
          issues.push(
            problem(
              CODES.EVIDENCE_SOURCES,
              `${label}: x-evidence.sources must be an array of source strings (use ["none"] for tier C)`,
            ),
          );
        } else if ((tier === "A" || tier === "B") && sources.length === 0) {
          issues.push(
            problem(
              CODES.EVIDENCE_SOURCES_EMPTY,
              `${label}: tier ${tier} requires at least one concrete source; use tier C with sources ["none"] when no capture exists`,
            ),
          );
        }
        const capturedResponse = evidence.capturedResponse;
        operationCapturedResponse =
          typeof capturedResponse === "boolean" ? capturedResponse : undefined;
        if (typeof capturedResponse !== "boolean") {
          issues.push(
            problem(
              CODES.EVIDENCE_CAPTURED_FLAG,
              `${label}: x-evidence.capturedResponse must be a boolean (true only when a real response capture exists)`,
            ),
          );
        } else if (tier === "A" && !capturedResponse) {
          issues.push(
            problem(
              CODES.EVIDENCE_TIER_CAPTURE_CONFLICT,
              `${label}: tier A means a real response capture exists; capturedResponse is false`,
            ),
          );
        }
      }
    }

    // tags
    const opTags = operation.operation.tags;
    if (
      !Array.isArray(opTags) ||
      opTags.length === 0 ||
      !opTags.every((tag) => typeof tag === "string")
    ) {
      issues.push(
        problem(
          CODES.OP_TAG_MISSING,
          `${label}: every operation needs at least one string tag`,
        ),
      );
    } else {
      for (const tag of opTags) {
        if (typeof tag === "string") usedTags.add(tag);
      }
    }

    // security shape
    if (
      operation.operation.security !== undefined &&
      !Array.isArray(operation.operation.security)
    ) {
      issues.push(
        problem(
          CODES.SECURITY_SHAPE,
          `${label}: "security" must be an array of requirement objects`,
        ),
      );
    }

    // responses
    const responses = operation.operation.responses;
    if (!isRecord(responses) || Object.keys(responses).length === 0) {
      issues.push(
        problem(
          CODES.RESPONSES_MISSING,
          `${label}: "responses" must be non-empty`,
        ),
      );
    } else {
      const isWebLogOperation = /\/getWebLog$/i.test(operation.path);
      for (const [code, response] of Object.entries(responses)) {
        if (!isRecord(response)) continue;
        const hasContent = Object.prototype.hasOwnProperty.call(
          response,
          "content",
        );
        // Tier B content is intentionally left untouched here (the reviewed
        // failure was the getWebLog schema invented below tier A, not every B
        // schema). Tier C content is still rejected by the general guard below.
        if (isWebLogOperation && code === "200" && hasContent) {
          const tierAWithCapturedResponse =
            operationTier === "A" && operationCapturedResponse === true;
          if (!tierAWithCapturedResponse) {
            issues.push(
              problem(
                CODES.GETWEBLOG_RESPONSE_CONTENT,
                `${label}: getWebLog 200 response declares "content" while x-evidence.tier=${show(operationTier)} / capturedResponse=${show(operationCapturedResponse)}; published content is only legal for a tier-A operation with a real captured response. Keep only a description below tier A.`,
              ),
            );
          } else {
            const captureProblem = validateTierACaptureProvenance(
              operation.operation["x-capture"],
              label,
            );
            if (captureProblem !== undefined) {
              issues.push(
                problem(CODES.GETWEBLOG_TIER_A_CAPTURE_INVALID, captureProblem),
              );
            }
          }
        }
        if (hasContent) {
          const tier = isRecord(operation.operation["x-evidence"])
            ? operation.operation["x-evidence"]["tier"]
            : undefined;
          if (tier === "C") {
            issues.push(
              problem(
                CODES.TIER_C_RESPONSE_CONTENT,
                `${label}: tier C is UNVERIFIED; it must not declare response "content"/schema, only a description stating the response is unknown`,
              ),
            );
          }
        }
      }
      if (
        isWebLogOperation &&
        !Object.prototype.hasOwnProperty.call(responses, "200")
      ) {
        issues.push(
          problem(
            CODES.GETWEBLOG_RESPONSE_MISSING,
            `${label}: getWebLog must document a 200 response with a description (no content schema)`,
          ),
        );
      }
    }

    // operationId uniqueness (when declared)
    const operationId = operation.operation.operationId;
    if (typeof operationId === "string" && operationId !== "") {
      const previous = operationIds.get(operationId);
      if (previous !== undefined) {
        issues.push(
          problem(
            CODES.OPID_DUPLICATE,
            `${label}: operationId "${operationId}" is already used by ${previous}`,
          ),
        );
      } else {
        operationIds.set(operationId, label);
      }
    }
  }

  // Declared tags must equal used tags (tag drift was a reviewed failure).
  const declaredTags = spec.tags;
  if (!Array.isArray(declaredTags)) {
    issues.push(
      problem(
        CODES.TAGS_DECLARED_MISSING,
        `"tags" must be declared and equal to the tags used by operations; used tags: [${[...usedTags].sort().join(", ")}]`,
      ),
    );
  } else {
    const declaredNames: string[] = [];
    for (const tag of declaredTags) {
      if (isRecord(tag) && typeof tag.name === "string")
        declaredNames.push(tag.name);
    }
    const declaredSet = new Set(declaredNames);
    const duplicates = declaredNames.filter(
      (tag, index) => declaredNames.indexOf(tag) !== index,
    );
    for (const duplicate of new Set(duplicates)) {
      issues.push(
        problem(
          CODES.TAG_DUPLICATE,
          `"tags" declares "${duplicate}" more than once`,
        ),
      );
    }
    const undeclared = [...usedTags]
      .filter((tag) => !declaredSet.has(tag))
      .sort();
    if (undeclared.length > 0) {
      issues.push(
        problem(
          CODES.TAG_UNDECLARED,
          `operations use tags not declared in "tags": [${undeclared.join(", ")}] — add them to the top-level tags list`,
        ),
      );
    }
    const unused = declaredNames.filter((tag) => !usedTags.has(tag)).sort();
    if (unused.length > 0) {
      issues.push(
        problem(
          CODES.TAG_UNUSED,
          `"tags" declares unused tags: [${[...new Set(unused)].join(", ")}] — remove them or tag an operation`,
        ),
      );
    }
  }

  if (rawText !== undefined && issues.length === 0) {
    notes.push(
      `parsed ${operations.length} operations, ${serverUrls.length} servers`,
    );
  }
  return issues.length > 0 ? failed(name, issues, notes) : passed(name, notes);
}

/* -------------------------------------------------------------------------- */
/* Check: docs/api-reference.md content                                       */
/* -------------------------------------------------------------------------- */

export function checkMarkdownText(markdown: string): CheckOutcome {
  const name = "api-reference.md (no undefined renderer output)";
  const issues: Issue[] = [];
  if (markdown.trim() === "") {
    return failed(name, [
      problem(CODES.MD_EMPTY, "docs/api-reference.md is empty"),
    ]);
  }
  if (markdown.length < 2000) {
    issues.push(
      problem(
        CODES.MD_TOO_SMALL,
        `docs/api-reference.md is only ${markdown.length} chars; the generated reference must cover the spec's operations`,
      ),
    );
  }
  const undefinedMatches = markdown.match(/undefined \(undefined\)/g);
  if (undefinedMatches !== null) {
    issues.push(
      problem(
        CODES.MD_UNDEFINED,
        `docs/api-reference.md contains ${undefinedMatches.length} "undefined (undefined)" occurrence(s); the generator is not resolving $ref parameters/headers — fix scripts/generate_docs.ts`,
      ),
    );
  }
  return issues.length > 0 ? failed(name, issues) : passed(name);
}

/* -------------------------------------------------------------------------- */
/* Check: docs/index.html (pinned Scalar + SRI)                               */
/* -------------------------------------------------------------------------- */

const PINNED_SCALAR =
  /@scalar\/api-reference@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:[/?#]|$)/;
const SRI_SHA384 = /integrity\s*=\s*["']sha384-[A-Za-z0-9+/]{64}={0,2}["']/i;

export function checkIndexHtml(html: string): CheckOutcome {
  const name = "index.html (pinned Scalar + SRI + openapi ref)";
  const issues: Issue[] = [];
  if (html.trim() === "") {
    return failed(name, [
      problem(CODES.HTML_MISSING, "docs/index.html is empty"),
    ]);
  }

  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  const scalarTags = scriptTags.filter((tag) =>
    /@scalar\/api-reference/i.test(tag),
  );

  if (scalarTags.length === 0) {
    issues.push(
      problem(
        CODES.SCALAR_MISSING,
        `docs/index.html does not load @scalar/api-reference; the portal must render docs/openapi.json with the pinned Scalar bundle`,
      ),
    );
  }

  for (const tag of scalarTags) {
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    const src = srcMatch?.[1] ?? "";
    if (
      src === "" ||
      src.toLowerCase().includes("@latest") ||
      !PINNED_SCALAR.test(src)
    ) {
      issues.push(
        problem(
          CODES.SCALAR_UNPINNED,
          `docs/index.html: Scalar script src must be version-pinned as @scalar/api-reference@<semver> (not @latest / not bare); found ${show(src)}`,
        ),
      );
    }
    if (!SRI_SHA384.test(tag)) {
      issues.push(
        problem(
          CODES.SCALAR_SRI,
          `docs/index.html: pinned Scalar script tag needs a real integrity="sha384-<64 base64 chars>" subresource-integrity digest`,
        ),
      );
    }
    if (!/\bcrossorigin\b/i.test(tag)) {
      issues.push(
        problem(
          CODES.SCALAR_CROSSORIGIN,
          `docs/index.html: Scalar script tag with SRI must also declare crossorigin (SRI is not enforced without it)`,
        ),
      );
    }
  }

  if (!html.includes("openapi.json")) {
    issues.push(
      problem(
        CODES.OPENAPI_REF,
        `docs/index.html does not reference openapi.json; Scalar needs data-url="./openapi.json"`,
      ),
    );
  } else if (!/data-url\s*=\s*["']\.?\/?openapi\.json["']/i.test(html)) {
    issues.push(
      problem(
        CODES.OPENAPI_REF,
        `docs/index.html: Scalar must load the co-deployed spec via data-url="./openapi.json"`,
      ),
    );
  }

  if (/redoc\.standalone\.js/i.test(html)) {
    issues.push(
      problem(
        CODES.LEGACY_REDOC,
        `docs/index.html still loads legacy Redoc (redoc.standalone.js); the portal must be Scalar-only`,
      ),
    );
  }

  return issues.length > 0 ? failed(name, issues) : passed(name);
}

/* -------------------------------------------------------------------------- */
/* Check: functions/_headers                                                  */
/* -------------------------------------------------------------------------- */

const REQUIRED_HEADERS = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Content-Type-Options",
  "Referrer-Policy",
] as const;

function headerLine(headers: string, headerName: string): string | undefined {
  const pattern = new RegExp(`^[ \\t]*${headerName}[ \\t]*:.*$`, "im");
  const match = pattern.exec(headers);
  return match?.[0];
}

export function checkHeaders(headers: string): CheckOutcome {
  const name = "_headers (security headers)";
  const issues: Issue[] = [];
  if (headers.trim() === "") {
    return failed(name, [
      problem(
        CODES.HEADERS_MISSING,
        "_headers is empty; declare CSP, HSTS, X-Content-Type-Options and Referrer-Policy",
      ),
    ]);
  }
  for (const headerName of REQUIRED_HEADERS) {
    if (headerLine(headers, headerName) === undefined) {
      issues.push(
        problem(
          CODES.HEADER_REQUIRED,
          `functions/_headers: missing "${headerName}" directive (Cloudflare Pages serves headers only when _headers is at the deploy root)`,
        ),
      );
    }
  }
  const csp = headerLine(headers, "Content-Security-Policy");
  if (csp !== undefined && !/cdn\.jsdelivr\.net/i.test(csp)) {
    issues.push(
      problem(
        CODES.HEADER_CSP_CDN,
        `functions/_headers: Content-Security-Policy must allow cdn.jsdelivr.net (where the pinned Scalar bundle loads from), otherwise the portal renders blank`,
      ),
    );
  }
  return issues.length > 0 ? failed(name, issues) : passed(name);
}

/* -------------------------------------------------------------------------- */
/* Check: evidence ledger ↔ spec parity                                       */
/* -------------------------------------------------------------------------- */

interface LedgerOperation {
  readonly path: string;
  readonly method: string;
  readonly tier: string;
  readonly capturedResponse: boolean;
  readonly evidence: readonly unknown[];
  readonly contradicted: boolean;
}

function readLedgerOperations(
  ledger: Record<string, unknown>,
  issues: Issue[],
): LedgerOperation[] {
  const rawOperations = ledger.operations;
  if (!Array.isArray(rawOperations)) {
    issues.push(
      problem(
        CODES.LEDGER_SHAPE,
        `docs/evidence/ledger.json: "operations" must be an array with one row per operation`,
      ),
    );
    return [];
  }
  const operations: LedgerOperation[] = [];
  rawOperations.forEach((row, index) => {
    const label = `docs/evidence/ledger.json operations[${index}]`;
    if (!isRecord(row)) {
      issues.push(problem(CODES.LEDGER_SHAPE, `${label} must be an object`));
      return;
    }
    const path = row.path;
    const method = row.method;
    const tier = row.tier;
    const capturedResponse = row.capturedResponse;
    const evidence = row.evidence;
    if (typeof path !== "string" || path === "") {
      issues.push(
        problem(CODES.LEDGER_SHAPE, `${label}.path must be a non-empty string`),
      );
      return;
    }
    if (typeof method !== "string" || method === "") {
      issues.push(
        problem(
          CODES.LEDGER_SHAPE,
          `${label}.method must be a non-empty string`,
        ),
      );
      return;
    }
    if (typeof tier !== "string" || !isLedgerTier(tier)) {
      issues.push(
        problem(
          CODES.LEDGER_SHAPE,
          `${label}.tier must be one of ${LEDGER_TIERS.join("|")}; found ${show(tier)}`,
        ),
      );
      return;
    }
    if (typeof capturedResponse !== "boolean") {
      issues.push(
        problem(
          CODES.LEDGER_SHAPE,
          `${label}.capturedResponse must be a boolean (true only for a real response capture)`,
        ),
      );
      return;
    }
    if (!Array.isArray(evidence)) {
      issues.push(
        problem(
          CODES.LEDGER_SHAPE,
          `${label}.evidence must be an array (use ["none"] when nothing exists)`,
        ),
      );
      return;
    }
    operations.push({
      path,
      method,
      tier,
      capturedResponse,
      evidence,
      contradicted: row.contradicted === true,
    });
  });
  return operations;
}

function tierCountsFromOperations(
  operations: readonly LedgerOperation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tier of LEDGER_TIERS) counts.set(tier, 0);
  for (const operation of operations) {
    counts.set(operation.tier, (counts.get(operation.tier) ?? 0) + 1);
  }
  return counts;
}

/** Lowercase, punctuation-free form used to match ledger surfaces to docs text. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface SurfaceRow {
  readonly id: string;
  readonly tier: string | undefined;
  readonly text: string;
  readonly raw: string;
}

function collectSurfaceRows(ledger: Record<string, unknown>): SurfaceRow[] {
  const rawSurfaces = ledger.surfaces;
  if (!Array.isArray(rawSurfaces)) return [];
  const surfaces: SurfaceRow[] = [];
  for (const surface of rawSurfaces) {
    if (!isRecord(surface)) continue;
    const id =
      typeof surface.id === "string"
        ? surface.id
        : typeof surface.name === "string"
          ? surface.name
          : "surface";
    const raw = JSON.stringify(surface);
    surfaces.push({
      id,
      tier: typeof surface.tier === "string" ? surface.tier : undefined,
      text: normalizeText(raw),
      raw,
    });
  }
  return surfaces;
}

/** Match the spec path against a ledger surface row (prose or quoted path). */
function surfaceMentionsPath(
  surface: SurfaceRow,
  path: string,
  candidates: readonly string[],
): boolean {
  for (const candidate of candidates) {
    if (candidate !== "" && surface.text.includes(candidate)) return true;
  }
  if (path === "/") {
    return /GET \/(?![A-Za-z0-9])/.test(surface.raw);
  }
  return path.length > 1 && surface.raw.includes(path);
}

export type OperationCoverageKind = "operation" | "surface";

export interface OperationCoverage {
  readonly kind: OperationCoverageKind;
  readonly label: string;
  readonly tier: string | undefined;
}

/**
 * Find how the ledger covers a spec operation: either an explicit operations[]
 * row, or (for real-but-unimplemented surfaces) a surfaces[] row. Tier D is
 * reserved for surfaces in the P1 ledger, so a surface-covered spec operation
 * must itself be tier D.
 */
export function findOperationCoverage(
  ledger: unknown,
  path: string,
  method: string,
): OperationCoverage | undefined {
  if (!isRecord(ledger)) return undefined;
  const key = `${method.toUpperCase()} ${path}`;
  const rawOperations = ledger.operations;
  if (Array.isArray(rawOperations)) {
    for (const row of rawOperations) {
      if (!isRecord(row)) continue;
      if (typeof row.path !== "string" || typeof row.method !== "string") {
        continue;
      }
      if (`${row.method.toUpperCase()} ${row.path}` === key) {
        return {
          kind: "operation",
          label: key,
          tier: typeof row.tier === "string" ? row.tier : undefined,
        };
      }
    }
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  const candidates: string[] = [normalizeText(path)];
  const last = segments[segments.length - 1];
  if (last !== undefined && last.length >= 5)
    candidates.push(normalizeText(last));
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    if (parent !== undefined && last !== undefined) {
      candidates.push(normalizeText(`${parent} ${last}`));
    }
  }
  for (const surface of collectSurfaceRows(ledger)) {
    if (surfaceMentionsPath(surface, path, candidates)) {
      return { kind: "surface", label: surface.id, tier: surface.tier };
    }
  }
  return undefined;
}

interface DeclaredCounts {
  readonly byTier: Map<string, number>;
  readonly total: number | undefined;
  readonly source: string;
}

function tierNumberMap(value: unknown): Map<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = new Map<string, number>();
  for (const tier of LEDGER_TIERS) {
    const count = value[tier];
    if (typeof count === "number") numbers.set(tier, count);
  }
  return numbers.size > 0 ? numbers : undefined;
}

function readDeclaredCounts(counts: unknown): DeclaredCounts | undefined {
  if (!isRecord(counts)) return undefined;
  const candidates: Array<[string, unknown]> = [
    ["counts", counts],
    ["counts.byTier", counts.byTier],
    ["counts.tiers", counts.tiers],
    ["counts.tierCounts", counts.tierCounts],
  ];
  for (const [source, value] of candidates) {
    const byTier = tierNumberMap(value);
    if (byTier !== undefined) {
      const total = typeof counts.total === "number" ? counts.total : undefined;
      return { byTier, total, source };
    }
  }
  return undefined;
}

/** Whether any entry names a capture that exists in the store. */
function evidenceCitesResolvedCapture(
  evidence: readonly unknown[],
  context: {
    readonly root: string;
    readonly captureFiles?: ReadonlySet<string>;
  },
): boolean {
  return evidence.some((entry) => {
    if (!isRecord(entry) || typeof entry["source"] !== "string") return false;
    const source = entry["source"].trim();
    if (!source.startsWith("capture:")) return false;
    const target = source.slice("capture:".length);
    if (context.captureFiles !== undefined) {
      return context.captureFiles.has(target);
    }
    // Without the store index, only the shape can be judged — refuse rather than guess.
    return /^\d{4}-\d{2}-\d{2}\//.test(target);
  });
}

/**
 * Whether any evidence entry names an artifact that actually exists.
 *
 * This used to accept any non-empty string, which is why eight tier-A rows citing
 * `capture:<date>:<sha256>` ids that matched nothing passed the gate: the array was not empty,
 * so it was "concrete". Emptiness is not evidence — resolution is.
 */
function evidenceIsConcrete(
  evidence: readonly unknown[],
  context: {
    readonly root: string;
    readonly captureFiles?: ReadonlySet<string>;
  },
): boolean {
  return evidence.some((entry) => {
    const text =
      typeof entry === "string" ? entry.trim() : JSON.stringify(entry);
    if (text === undefined || text === "") return false;
    const lowered = text.toLowerCase();
    if (lowered === "none" || lowered === '["none"]') return false;

    // A structured entry names its artifact in `source`; fall back to the raw text otherwise.
    const source =
      isRecord(entry) && typeof entry["source"] === "string"
        ? entry["source"].trim()
        : text;

    if (source.startsWith("capture:")) {
      // Without the store index the shape can still be refused: capture:<date>/<file> is the
      // form docs/openapi.json uses, and capture:<date>:<hash> names nothing at all.
      const target = source.slice("capture:".length);
      if (context.captureFiles === undefined)
        return /^\d{4}-\d{2}-\d{2}\//.test(target);
      return context.captureFiles.has(target);
    }

    const match =
      /^([\w./-]+\.(?:ts|tsx|js|json|md|yml|yaml|html|sh))(?::\d+(?:-\d+)?)?$/.exec(
        source,
      );
    if (match === null) return false;
    return resolveCitation(match[1] ?? "", context.root) !== undefined;
  });
}

export function checkLedger(
  ledger: unknown,
  spec: unknown,
  options: {
    readonly root?: string;
    readonly captureFiles?: ReadonlySet<string>;
  } = {},
): CheckOutcome {
  const name = "evidence ledger (shape, tier parity, counts)";
  const root = options.root ?? resolve(import.meta.dir, "..");
  // exactOptionalPropertyTypes: an explicit `captureFiles: undefined` is not the same as absent,
  // and the resolvers distinguish "no store loaded" from "store says no".
  type EvidenceContext = {
    readonly root: string;
    readonly captureFiles?: ReadonlySet<string>;
  };
  const evidenceContext: EvidenceContext =
    options.captureFiles === undefined
      ? { root }
      : { root, captureFiles: options.captureFiles };
  const issues: Issue[] = [];
  const notes: string[] = [];
  if (!isRecord(ledger)) {
    return failed(name, [
      problem(
        CODES.LEDGER_SHAPE,
        "docs/evidence/ledger.json must contain a JSON object with operations/surfaces/counts",
      ),
    ]);
  }
  if (typeof ledger.schemaVersion !== "number") {
    issues.push(
      problem(
        CODES.LEDGER_SHAPE,
        `docs/evidence/ledger.json: "schemaVersion" must be a number`,
      ),
    );
  }
  const ledgerOperations = readLedgerOperations(ledger, issues);
  if (!Array.isArray(ledger.surfaces)) {
    issues.push(
      problem(
        CODES.LEDGER_SHAPE,
        `docs/evidence/ledger.json: "surfaces" must be an array (D/E surfaces that are not spec operations)`,
      ),
    );
  }

  // capturedResponse rules: honest capture flag only.
  for (const operation of ledgerOperations) {
    if (operation.tier === "A" && !operation.capturedResponse) {
      issues.push(
        problem(
          CODES.LEDGER_CAPTURED_CONFLICT,
          `${operation.method.toUpperCase()} ${operation.path}: tier A means a real response capture exists, but capturedResponse is false`,
        ),
      );
    }
    if (
      operation.capturedResponse &&
      operation.tier !== "A" &&
      operation.tier !== "B"
    ) {
      issues.push(
        problem(
          CODES.LEDGER_CAPTURED_CONFLICT,
          `${operation.method.toUpperCase()} ${operation.path}: capturedResponse is true but tier ${operation.tier} does not claim an observed capture (A/B)`,
        ),
      );
    }
    if (
      operation.tier === "A" &&
      !evidenceCitesResolvedCapture(operation.evidence, evidenceContext)
    ) {
      issues.push(
        problem(
          CODES.LEDGER_EVIDENCE_WEAK,
          `${operation.method.toUpperCase()} ${operation.path}: tier A means a response was captured, so it must cite a capture:<date>/<file> that exists in docs/evidence/captures; a resolvable spec or source file is not a capture`,
        ),
      );
    }
    if (
      (operation.tier === "A" || operation.tier === "B") &&
      !evidenceIsConcrete(operation.evidence, evidenceContext)
    ) {
      issues.push(
        problem(
          CODES.LEDGER_EVIDENCE_WEAK,
          `${operation.method.toUpperCase()} ${operation.path}: tier ${operation.tier} needs at least one concrete evidence source (file:line / capture / fixture); use tier C with ["none"] when there is none`,
        ),
      );
    }
  }

  // Parity against the real spec. Every spec operation must be covered by a
  // ledger operations[] row, or by a tier-D surfaces[] row (a real surface
  // intentionally not modelled as an implemented operation). Retired ledger
  // rows stay allowed only when they are documented-not-implemented (tier E)
  // or explicitly contradicted, so the ledger remains an append-only record.
  const specOperations = collectOperations(spec);
  const ledgerIndex = new Map<string, LedgerOperation>();
  for (const operation of ledgerOperations) {
    const key = `${operation.method.toUpperCase()} ${operation.path}`;
    if (ledgerIndex.has(key)) {
      issues.push(
        problem(
          CODES.LEDGER_SHAPE,
          `docs/evidence/ledger.json has a duplicate row for ${key}`,
        ),
      );
      continue;
    }
    ledgerIndex.set(key, operation);
  }
  const specIndex = new Map<string, Operation>();
  for (const operation of specOperations) {
    const key = `${operation.method.toUpperCase()} ${operation.path}`;
    specIndex.set(key, operation);
    if (ledgerIndex.has(key)) continue;
    const coverage = findOperationCoverage(
      ledger,
      operation.path,
      operation.method,
    );
    if (coverage === undefined) {
      issues.push(
        problem(
          CODES.LEDGER_OP_MISSING,
          `docs/evidence/ledger.json is missing a row for ${key}; every spec operation needs a ledger row (or a tier D surfaces[] row if it is a real-but-unimplemented surface)`,
        ),
      );
      continue;
    }
    const evidence = operation.operation["x-evidence"];
    const specTier = isRecord(evidence) ? evidence.tier : undefined;
    if (coverage.tier !== undefined && specTier !== coverage.tier) {
      issues.push(
        problem(
          CODES.LEDGER_TIER_MISMATCH,
          `${key}: spec x-evidence.tier=${show(specTier)} but ledger surface ${coverage.label} is tier ${coverage.tier}; surface-backed spec operations must be tier ${coverage.tier}`,
        ),
      );
    } else {
      notes.push(
        `${key}: covered by ledger surface ${coverage.label} (tier ${coverage.tier ?? "unknown"})`,
      );
    }
  }
  for (const [key, operation] of ledgerIndex) {
    if (specIndex.has(key)) {
      const specOperation = specIndex.get(key);
      if (specOperation === undefined) continue;
      const evidence = specOperation.operation["x-evidence"];
      const specTier = isRecord(evidence) ? evidence.tier : undefined;
      if (typeof specTier === "string" && specTier !== operation.tier) {
        issues.push(
          problem(
            CODES.LEDGER_TIER_MISMATCH,
            `${key}: spec x-evidence.tier="${specTier}" but ledger tier="${operation.tier}"`,
          ),
        );
      }
      continue;
    }
    if (operation.tier === "E" || operation.contradicted) {
      notes.push(
        `ledger row ${key} (tier ${operation.tier}${operation.contradicted ? ", contradicted" : ""}) is documented but not in the spec; allowed as a retired/contradicted surface row`,
      );
      continue;
    }
    issues.push(
      problem(
        CODES.LEDGER_OP_EXTRA,
        `docs/evidence/ledger.json has a row for ${key} but docs/openapi.json has no such operation; remove the stale row or add the evidenced operation`,
      ),
    );
  }

  // Declared counts must match the rows (honesty in the human summary).
  const actualCounts = tierCountsFromOperations(ledgerOperations);
  const declaredCounts = readDeclaredCounts(ledger.counts);
  if (declaredCounts === undefined) {
    issues.push(
      problem(
        CODES.LEDGER_COUNTS_MISSING,
        `docs/evidence/ledger.json: "counts" must declare per-tier totals (e.g. {"A":1,"B":4,"C":36,"D":7,"E":0})`,
      ),
    );
  } else {
    for (const tier of LEDGER_TIERS) {
      const declared = declaredCounts.byTier.get(tier);
      const actual = actualCounts.get(tier) ?? 0;
      if (declared === undefined) {
        if (actual > 0) {
          issues.push(
            problem(
              CODES.LEDGER_COUNT_MISMATCH,
              `docs/evidence/ledger.json: ${declaredCounts.source}.${tier} is not declared but ${actual} row(s) have tier ${tier}`,
            ),
          );
        }
      } else if (declared !== actual) {
        issues.push(
          problem(
            CODES.LEDGER_COUNT_MISMATCH,
            `docs/evidence/ledger.json: ${declaredCounts.source}.${tier}=${declared} but ${actual} operation row(s) have tier ${tier}`,
          ),
        );
      }
    }
    if (
      declaredCounts.total !== undefined &&
      declaredCounts.total !== ledgerOperations.length
    ) {
      issues.push(
        problem(
          CODES.LEDGER_COUNT_MISMATCH,
          `docs/evidence/ledger.json: counts.total=${declaredCounts.total} but there are ${ledgerOperations.length} operation rows`,
        ),
      );
    }
  }

  return issues.length > 0 ? failed(name, issues, notes) : passed(name, notes);
}

/* -------------------------------------------------------------------------- */
/* Check: generated artifact freshness (spec + markdown byte diffs)           */
/* -------------------------------------------------------------------------- */

function bunExecutable(): string {
  const executable = process.execPath;
  return /[\\/]bun(?:\.exe)?$/.test(executable) ? executable : "bun";
}

function firstDifference(committed: Buffer, regenerated: Buffer): string {
  const left = committed.toString("utf8").split("\n");
  const right = regenerated.toString("utf8").split("\n");
  const lineCount = Math.max(left.length, right.length);
  for (let index = 0; index < lineCount; index += 1) {
    const before = left[index];
    const after = right[index];
    if (before === after) continue;
    const shownBefore = truncate(before ?? "<end of file>");
    const shownAfter = truncate(after ?? "<end of file>");
    return `first difference at line ${index + 1}: committed ${JSON.stringify(shownBefore)} vs regenerated ${JSON.stringify(shownAfter)}`;
  }
  return `byte length differs (committed ${committed.length} vs regenerated ${regenerated.length})`;
}

interface GeneratedBytes {
  readonly bytes: Buffer | undefined;
  readonly failure: string | undefined;
}

/**
 * Render a deterministic generator's committed output. Prefers the generator's
 * `--out <path>` mode so the worktree is never mutated; falls back to in-place
 * generation with save/restore for generators without --out support.
 */
function renderGeneratedFile(
  root: string,
  scriptRelativePath: string,
  committedRelativePath: string,
): GeneratedBytes {
  const bun = bunExecutable();
  const timeout = 120_000;
  const committedPath = join(root, committedRelativePath);
  const committed = existsSync(committedPath)
    ? readFileSync(committedPath)
    : undefined;
  const tempDir = mkdtempSync(join(tmpdir(), "sportsdesk-docs-gen-"));
  try {
    const renderedPath = join(tempDir, "generated");
    const withOut = spawnSync(
      bun,
      ["run", scriptRelativePath, "--out", renderedPath],
      { cwd: root, encoding: "utf8", timeout },
    );
    if (withOut.status === 0 && existsSync(renderedPath)) {
      return { bytes: readFileSync(renderedPath), failure: undefined };
    }
    const inPlace = spawnSync(bun, ["run", scriptRelativePath], {
      cwd: root,
      encoding: "utf8",
      timeout,
    });
    try {
      if (inPlace.status !== 0) {
        const stderr = typeof inPlace.stderr === "string" ? inPlace.stderr : "";
        const stdout = typeof inPlace.stdout === "string" ? inPlace.stdout : "";
        return {
          bytes: undefined,
          failure: `${scriptRelativePath} exited ${String(inPlace.status)}: ${truncate((stderr || stdout).trim() || "no output")}`,
        };
      }
      if (!existsSync(committedPath)) {
        return {
          bytes: undefined,
          failure: `${scriptRelativePath} produced no output at ${committedRelativePath}`,
        };
      }
      return { bytes: readFileSync(committedPath), failure: undefined };
    } finally {
      if (committed !== undefined) {
        writeFileSync(committedPath, committed);
      } else {
        rmSync(committedPath, { force: true });
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function renderMarkdownToTemp(root: string): CheckOutcome {
  const name = "api-reference.md freshness (generator output = committed)";
  const generatorPath = join(root, "scripts", "generate_docs.ts");
  const markdownPath = join(root, "docs", "api-reference.md");
  if (!existsSync(generatorPath)) {
    return skipped(name, [
      "scripts/generate_docs.ts does not exist yet (P3); freshness diff skipped",
    ]);
  }
  if (!existsSync(markdownPath)) {
    return failed(name, [
      problem(CODES.MD_MISSING, `missing docs/api-reference.md`),
    ]);
  }
  const committed = readFileSync(markdownPath);
  const generated = renderGeneratedFile(
    root,
    "scripts/generate_docs.ts",
    "docs/api-reference.md",
  );
  if (generated.failure !== undefined) {
    return failed(name, [
      problem(CODES.MD_GENERATOR_FAILED, generated.failure),
    ]);
  }
  if (generated.bytes === undefined) {
    return failed(name, [
      problem(
        CODES.MD_GENERATOR_FAILED,
        "scripts/generate_docs.ts produced no output to compare against docs/api-reference.md",
      ),
    ]);
  }
  if (committed.equals(generated.bytes)) {
    return passed(name, [`bytes identical (sha256 ${sha256(committed)})`]);
  }
  return failed(name, [
    problem(
      CODES.MD_STALE,
      `docs/api-reference.md is stale: regenerate with \`bun run scripts/generate_docs.ts\` and commit the result. ${firstDifference(committed, generated.bytes)}`,
    ),
  ]);
}

/**
 * Run scripts/generate_docs.ts into a temp path and byte-compare the committed
 * markdown. In --strict mode a missing generator is a failure (P3 deliverable);
 * otherwise it is skipped so Phase A is not blocked on P3.
 */
export function checkMarkdownFreshness(
  root: string,
  options: { strict: boolean },
): CheckOutcome {
  const name = "api-reference.md freshness (generator output = committed)";
  const generatorPath = join(root, "scripts", "generate_docs.ts");
  if (!existsSync(generatorPath) && options.strict) {
    return failed(name, [
      problem(
        CODES.MD_GENERATOR_MISSING,
        `scripts/generate_docs.ts is required (--strict); the committed markdown must be reproducible from the spec + ledger`,
      ),
    ]);
  }
  return renderMarkdownToTemp(root);
}

/**
 * Byte-compare the committed spec against scripts/generate_openapi.ts output,
 * so a hand-edited docs/openapi.json cannot drift from the evidence ledger.
 */
export function checkOpenApiFreshness(
  root: string,
  options: { strict: boolean },
): CheckOutcome {
  const name = "openapi.json freshness (generator output = committed)";
  const generatorPath = join(root, "scripts", "generate_openapi.ts");
  const specPath = join(root, "docs", "openapi.json");
  if (!existsSync(generatorPath)) {
    return options.strict
      ? failed(name, [
          problem(
            CODES.SPEC_GENERATOR_MISSING,
            `scripts/generate_openapi.ts is required (--strict); the committed spec must be reproducible from the evidence ledger`,
          ),
        ])
      : skipped(name, [
          "scripts/generate_openapi.ts does not exist yet (P2); freshness diff skipped",
        ]);
  }
  if (!existsSync(specPath)) {
    return failed(name, [
      problem(CODES.SPEC_MISSING, `missing docs/openapi.json`),
    ]);
  }
  const committed = readFileSync(specPath);
  const generated = renderGeneratedFile(
    root,
    "scripts/generate_openapi.ts",
    "docs/openapi.json",
  );
  if (generated.failure !== undefined) {
    return failed(name, [
      problem(CODES.SPEC_GENERATOR_FAILED, generated.failure),
    ]);
  }
  if (generated.bytes === undefined) {
    return failed(name, [
      problem(
        CODES.SPEC_GENERATOR_FAILED,
        "scripts/generate_openapi.ts produced no output to compare against docs/openapi.json",
      ),
    ]);
  }
  if (committed.equals(generated.bytes)) {
    return passed(name, [`bytes identical (sha256 ${sha256(committed)})`]);
  }
  return failed(name, [
    problem(
      CODES.SPEC_STALE,
      `docs/openapi.json is stale: regenerate with \`bun run scripts/generate_openapi.ts\` and commit the result. ${firstDifference(committed, generated.bytes)}`,
    ),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Check: dist/ staging parity                                                */
/* -------------------------------------------------------------------------- */

function compareStaged(
  distDir: string,
  sourceDir: string,
  fileName: string,
  issues: Issue[],
): void {
  const sourcePath = join(sourceDir, fileName);
  const stagedPath = join(distDir, fileName);
  if (!existsSync(stagedPath)) {
    issues.push(
      problem(
        CODES.DIST_MISSING_FILE,
        `dist/${fileName} is missing; run \`bun run docs:stage\` after editing docs/${fileName}`,
      ),
    );
    return;
  }
  if (!existsSync(sourcePath)) return;
  const source = readFileSync(sourcePath);
  const staged = readFileSync(stagedPath);
  if (!source.equals(staged)) {
    issues.push(
      problem(
        CODES.DIST_STALE,
        `dist/${fileName} differs from docs/${fileName} (sha256 ${sha256(source)} vs ${sha256(staged)}); run \`bun run docs:stage\` and deploy the result`,
      ),
    );
  }
}

export function checkDistParity(root: string): CheckOutcome {
  const name = "dist/ staging parity (docs → dist byte-identical)";
  const docsDir = join(root, "docs");
  const distDir = join(root, "dist");
  if (!existsSync(distDir)) {
    return skipped(name, [
      "dist/ does not exist (gitignored); run `bun run docs:stage` first to check staging parity",
    ]);
  }
  const issues: Issue[] = [];
  for (const fileName of ["openapi.json", "index.html"]) {
    compareStaged(distDir, docsDir, fileName, issues);
  }
  // Same layout migration as checkHeaders: the source moved to infra/pages/, and
  // `docs:stage` copies from there. Accept either so the gate reflects the tree.
  const headersSource = [
    join(root, "infra", "pages", "_headers"),
    join(root, "functions", "_headers"),
  ].find((p) => existsSync(p));
  if (headersSource !== undefined) {
    compareStaged(distDir, dirname(headersSource), "_headers", issues);
  } else {
    issues.push(
      problem(
        CODES.HEADERS_MISSING,
        `functions/_headers is missing; the deploy root must contain _headers (docs:stage copies it to dist/_headers)`,
      ),
    );
  }
  return issues.length > 0 ? failed(name, issues) : passed(name);
}

/* -------------------------------------------------------------------------- */
/* Check: package.json docs pipeline scripts                                  */
/* -------------------------------------------------------------------------- */

interface ScriptRequirement {
  readonly script: string;
  readonly mustInclude: readonly string[];
  readonly message: string;
}

const SCRIPT_REQUIREMENTS: readonly ScriptRequirement[] = [
  {
    script: "verify:docs",
    mustInclude: ["scripts/verify_docs.ts"],
    message: "must run the docs gate",
  },
  {
    script: "docs:openapi",
    mustInclude: ["scripts/generate_openapi.ts"],
    message: "must regenerate docs/openapi.json from the evidence ledger",
  },
  {
    script: "test:docs",
    mustInclude: ["tests/api_reference.test.ts", "tests/docs_evidence.test.ts"],
    message: "must run both invariant + ledger parity tests",
  },
  {
    script: "docs:stage",
    // "_headers" rather than a directory: the source moved functions/ -> infra/pages/
    // in the layout commit and the staging script was updated, this requirement was not.
    mustInclude: ["_headers", "dist/_headers"],
    message: "must copy the _headers source into dist/_headers",
  },
  {
    script: "docs:deploy",
    mustInclude: ["test:docs", "verify:docs", "fantasy402-docs"],
    message:
      "must gate deployment (test:docs && verify:docs) and target the real Pages project fantasy402-docs",
  },
  {
    script: "docs:verify:live",
    mustInclude: ["--live", "fantasy402-docs-4ay"],
    message: "must compare the deployed spec against the committed spec",
  },
];

export function checkPackageScripts(root: string): CheckOutcome {
  const name = "package.json docs pipeline scripts";
  const packagePath = join(root, "package.json");
  const issues: Issue[] = [];
  if (!existsSync(packagePath)) {
    return failed(name, [
      problem(CODES.PKG_UNREADABLE, `missing package.json`),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    return failed(name, [
      problem(
        CODES.PKG_UNREADABLE,
        `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    return failed(name, [
      problem(CODES.PKG_UNREADABLE, `package.json.scripts must be an object`),
    ]);
  }
  for (const requirement of SCRIPT_REQUIREMENTS) {
    const command = parsed.scripts[requirement.script];
    if (typeof command !== "string") {
      issues.push(
        problem(
          CODES.PKG_SCRIPT_MISSING,
          `package.json scripts.${requirement.script} is missing (${requirement.message})`,
        ),
      );
      continue;
    }
    for (const fragment of requirement.mustInclude) {
      if (!command.includes(fragment)) {
        issues.push(
          problem(
            CODES.PKG_SCRIPT_INVALID,
            `package.json scripts.${requirement.script} must include ${JSON.stringify(fragment)} (${requirement.message}); found ${JSON.stringify(command)}`,
          ),
        );
      }
    }
  }
  return issues.length > 0 ? failed(name, issues) : passed(name);
}

/* -------------------------------------------------------------------------- */
/* Check: --live deployed spec hash                                           */
/* -------------------------------------------------------------------------- */

/**
 * Fetch `<url>/openapi.json` and compare its sha256 against the committed
 * docs/openapi.json. Off by default (only runs with --live <url>).
 */
export async function checkLive(
  baseUrl: string,
  committedSpecPath: string,
): Promise<CheckOutcome> {
  const name = `live spec parity (${baseUrl})`;
  const committed = readFileSync(committedSpecPath);
  let specUrl: string;
  try {
    specUrl = new URL(
      "openapi.json",
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    ).toString();
  } catch {
    return failed(name, [
      problem(CODES.LIVE_SPEC_FETCH, `invalid --live URL: ${baseUrl}`),
    ]);
  }
  try {
    const response = await fetch(specUrl);
    if (!response.ok) {
      return failed(name, [
        problem(
          CODES.LIVE_SPEC_FETCH,
          `${specUrl} returned HTTP ${response.status}; the deployed spec is unreachable`,
        ),
      ]);
    }
    const deployed = Buffer.from(await response.arrayBuffer());
    const committedHash = sha256(committed);
    const deployedHash = sha256(deployed);
    if (committedHash === deployedHash) {
      return passed(name, [`${specUrl} sha256 ${deployedHash}`]);
    }
    return failed(name, [
      problem(
        CODES.LIVE_SPEC_DRIFT,
        `deployed spec differs from committed: ${specUrl} sha256 ${deployedHash} vs docs/openapi.json sha256 ${committedHash}. Run \`bun run docs:deploy\` (gated) to publish the committed spec.`,
      ),
    ]);
  } catch (error) {
    return failed(name, [
      problem(
        CODES.LIVE_SPEC_FETCH,
        `failed to fetch ${specUrl}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }
}

/* -------------------------------------------------------------------------- */
/* Runner + CLI                                                               */
/* -------------------------------------------------------------------------- */

export interface RunOptions {
  readonly root: string;
  readonly strict: boolean;
  readonly live: string | undefined;
}

type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

function parseJson(text: string): ParseResult {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkSpecFile(root: string): CheckOutcome {
  const name = "openapi.json (valid, evidence, tags, security, no fabrication)";
  const specPath = join(root, "docs", "openapi.json");
  if (!existsSync(specPath)) {
    return failed(name, [
      problem(CODES.SPEC_MISSING, `missing docs/openapi.json`),
    ]);
  }
  const rawText = readFileSync(specPath, "utf8");
  const parsed = parseJson(rawText);
  if (!parsed.ok) {
    return failed(name, [
      problem(
        CODES.SPEC_PARSE,
        `docs/openapi.json is not valid JSON: ${parsed.message}`,
      ),
    ]);
  }
  return checkOpenApi(parsed.value, rawText);
}

async function checkLedgerFile(
  root: string,
  spec: unknown,
): Promise<CheckOutcome> {
  const name = "evidence ledger (shape, tier parity, counts)";
  const ledgerPath = join(root, "docs", "evidence", "ledger.json");
  if (!existsSync(ledgerPath)) {
    return failed(name, [
      problem(
        CODES.LEDGER_MISSING,
        `missing docs/evidence/ledger.json; the evidence ledger is the source of truth for tiers (P1 deliverable)`,
      ),
    ]);
  }
  const parsed = parseJson(readFileSync(ledgerPath, "utf8"));
  if (!parsed.ok) {
    return failed(name, [
      problem(
        CODES.LEDGER_PARSE,
        `docs/evidence/ledger.json is not valid JSON: ${parsed.message}`,
      ),
    ]);
  }
  if (spec === undefined) {
    return skipped(name, ["spec unreadable; ledger↔spec parity cannot run"]);
  }
  // The capture store decides whether a tier-A citation resolves; loadManifestIndex recomputes
  // every captureHash from the record, so a stale manifest cannot vouch for itself.
  const capturesDir = join(root, "docs", "evidence", "captures");
  const captureFiles = existsSync(capturesDir)
    ? new Set((await loadManifestIndex(capturesDir)).hashes.keys())
    : undefined;
  return checkLedger(
    parsed.value,
    spec,
    captureFiles === undefined ? { root } : { root, captureFiles },
  );
}

function checkMarkdownFile(root: string): CheckOutcome {
  const name = "api-reference.md (no undefined renderer output)";
  const markdownPath = join(root, "docs", "api-reference.md");
  if (!existsSync(markdownPath)) {
    return failed(name, [
      problem(CODES.MD_MISSING, `missing docs/api-reference.md`),
    ]);
  }
  return checkMarkdownText(readFileSync(markdownPath, "utf8"));
}

function checkIndexFile(root: string): CheckOutcome {
  const name = "index.html (pinned Scalar + SRI + openapi ref)";
  const indexPath = join(root, "docs", "index.html");
  if (!existsSync(indexPath)) {
    return failed(name, [
      problem(CODES.HTML_MISSING, `missing docs/index.html`),
    ]);
  }
  return checkIndexHtml(readFileSync(indexPath, "utf8"));
}

function checkHeadersFile(root: string): CheckOutcome {
  const name = "_headers (security headers)";
  // The layout commit "group design tokens, schema preload, and infra paths" moved
  // this file from functions/_headers to infra/pages/_headers, and `docs:stage` copies
  // from the new path — but this check and docs/README.md still named the old one, so
  // the gate failed on a tree that was actually correct. Accept either layout and say
  // which one was found, so the next migration does not need a code change to be legal.
  const candidates = [
    join(root, "infra", "pages", "_headers"),
    join(root, "functions", "_headers"),
  ];
  const headersPath = candidates.find((p) => existsSync(p));
  if (headersPath === undefined) {
    return failed(name, [
      problem(
        CODES.HEADERS_MISSING,
        `missing _headers; Cloudflare Pages only serves security headers from the deploy root ` +
          `(looked for infra/pages/_headers and functions/_headers)`,
      ),
    ]);
  }
  const outcome = checkHeaders(readFileSync(headersPath, "utf8"));
  // Report the path that was actually read, so a reader can tell the two layouts apart.
  return {
    ...outcome,
    name: `${relative(root, headersPath)} (security headers)`,
  };
}

async function readSpecForLive(root: string): Promise<CheckOutcome> {
  const specPath = join(root, "docs", "openapi.json");
  if (!existsSync(specPath)) {
    return failed("live spec parity", [
      problem(CODES.SPEC_MISSING, `missing docs/openapi.json`),
    ]);
  }
  return passed("live spec parity", [specPath]);
}

/** Run every check against a worktree root. */
export async function runChecks(options: RunOptions): Promise<CheckOutcome[]> {
  const specPath = join(options.root, "docs", "openapi.json");
  let spec: unknown = undefined;
  if (existsSync(specPath)) {
    const parsed = parseJson(readFileSync(specPath, "utf8"));
    if (parsed.ok) spec = parsed.value;
  }

  const outcomes: CheckOutcome[] = [
    checkSpecFile(options.root),
    checkOpenApiFreshness(options.root, { strict: options.strict }),
    await checkLedgerFile(options.root, spec),
    checkMarkdownFile(options.root),
    checkIndexFile(options.root),
    checkHeadersFile(options.root),
    checkPackageScripts(options.root),
    checkMarkdownFreshness(options.root, { strict: options.strict }),
    checkDistParity(options.root),
  ];

  if (options.live !== undefined) {
    const committedSpec = await readSpecForLive(options.root);
    if (committedSpec.status === "fail") {
      outcomes.push(committedSpec);
    } else {
      outcomes.push(await checkLive(options.live, specPath));
    }
  }

  return outcomes;
}

/** Print a deterministic report and return the process exit code. */
export function reportOutcomes(outcomes: readonly CheckOutcome[]): number {
  let failures = 0;
  let skips = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "fail") failures += 1;
    if (outcome.status === "skip") skips += 1;
    console.log(`${outcome.status.toUpperCase().padEnd(4)} ${outcome.name}`);
    for (const note of outcome.notes) console.log(`     note: ${note}`);
    for (const issue of outcome.issues) {
      console.log(`     - [${issue.code}] ${issue.message}`);
    }
  }
  const passedCount = outcomes.length - failures - skips;
  console.log(
    `\ndocs gate: ${outcomes.length} checks, ${passedCount} pass, ${failures} fail, ${skips} skip`,
  );
  console.log(failures > 0 ? "RESULT: FAIL" : "RESULT: PASS");
  return failures > 0 ? 1 : 0;
}

const USAGE =
  "usage: bun run scripts/verify_docs.ts [--strict] [--live <url>] [--root <path>]";

/** Parse CLI args; returns a human error string on bad input. */
export function parseCliArgs(argv: readonly string[]): RunOptions | string {
  const defaultRoot = resolve(import.meta.dir, "..");
  let root = defaultRoot;
  let strict = false;
  let live: string | undefined = undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") {
      strict = true;
    } else if (argument === "--root") {
      const next = argv[index + 1];
      if (next === undefined) return `--root requires a path\n${USAGE}`;
      root = resolve(next);
      index += 1;
    } else if (argument === "--live") {
      const next = argv[index + 1];
      if (next === undefined) return `--live requires a base URL\n${USAGE}`;
      live = next;
      index += 1;
    } else {
      return `unknown argument: ${argument}\n${USAGE}`;
    }
  }
  return { root, strict, live };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseCliArgs(argv);
  if (typeof options === "string") {
    console.error(options);
    return 2;
  }
  const outcomes = await runChecks(options);
  return reportOutcomes(outcomes);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(
        `verify_docs crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      process.exitCode = 2;
    },
  );
}
