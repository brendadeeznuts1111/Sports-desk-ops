/**
 * GSLive Manager Tools `users-report` control plane.
 *
 * The endpoint is the manager's per-player report:
 *   GET /manager-tools/reports/?from=<epochSec>&to=<epochSec>&partnerId=118&kind=users-report
 *
 * It is the same-book, windowed aggregate control named by the tally design (GATE-03) but never
 * captured. This module provides (a) a session-gated, read-only capture that redacts player
 * identity before anything is written, and (b) a comparison scaffold that joins the redacted rows
 * to `getBetReport` ticket aggregates by numeric userID or hashed partner login.
 *
 * Honesty rules:
 *   - A non-2xx response is a failed capture, never an empty report.
 *   - An error envelope (`{e:<non-zero>, r:[], d}`) is a refusal, never an empty report.
 *   - Strings (logins, names) are replaced with `sha256:...` prefixes; only numeric/boolean cells
 *     are kept verbatim. The raw response is never persisted; only its sha256 is recorded.
 *   - Comparison output is candidate evidence from a second encoding, not external settlement
 *     truth; `settlementVerification` stays unverified.
 */

export const USERS_REPORT_BASE_URL =
  "https://plive.sportswidgets.pro/manager-tools/reports/";
export const USERS_REPORT_KIND = "users-report";
export const USERS_REPORT_PARTNER_ID = 118;
export const USERS_REPORT_STRING_HASH_HEX = 16;

export type UsersReportErrorCode =
  "auth_expired" | "http_error" | "report_error" | "invalid_response";

export class UsersReportError extends Error {
  readonly code: UsersReportErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: UsersReportErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "UsersReportError";
    this.code = code;
    this.details = details;
  }
}

export interface UsersReportRequest {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly partnerId?: number;
}

/** Build the authenticated report URL (parameters only; no secrets). */
export function buildUsersReportUrl(request: UsersReportRequest): string {
  if (!Number.isInteger(request.fromEpochSec) || request.fromEpochSec < 0) {
    throw new UsersReportError(
      "invalid_response",
      "users-report: fromEpochSec must be a non-negative integer",
    );
  }
  if (
    !Number.isInteger(request.toEpochSec) ||
    request.toEpochSec < request.fromEpochSec
  ) {
    throw new UsersReportError(
      "invalid_response",
      "users-report: toEpochSec must be an integer >= fromEpochSec",
    );
  }
  const partnerId = request.partnerId ?? USERS_REPORT_PARTNER_ID;
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    throw new UsersReportError(
      "invalid_response",
      "users-report: partnerId must be a positive integer",
    );
  }
  const params = new URLSearchParams();
  params.set("from", String(request.fromEpochSec));
  params.set("to", String(request.toEpochSec));
  params.set("partnerId", String(partnerId));
  params.set("kind", USERS_REPORT_KIND);
  return `${USERS_REPORT_BASE_URL}?${params.toString()}`;
}

/** Stable short hash used to redact identity strings while keeping joins possible. */
export function usersReportStringHash(value: string): string {
  return Bun.CryptoHasher.hash("sha256", value, "hex").slice(
    0,
    USERS_REPORT_STRING_HASH_HEX,
  );
}

type RedactedCell = number | boolean | null | string;

export interface RedactedUsersReport {
  readonly rows: readonly Readonly<Record<string, RedactedCell>>[];
  readonly columns: readonly string[];
  readonly numericColumns: readonly string[];
  readonly stringColumns: readonly string[];
  readonly rowCount: number;
}

export interface UsersReportCapture extends UsersReportRequest {
  readonly url: string;
  readonly partnerId: number;
  readonly capturedAt: string;
  /** sha256 of the raw response body; the body itself is never stored. */
  readonly rawSha256: string | null;
  readonly envelope: "array" | "object-r";
  /** Manager session provenance (env`, `keychain`, `session-file`, …), never a cookie. */
  readonly sessionSource: string;
  readonly report: RedactedUsersReport;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function redactCell(value: unknown): RedactedCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return `sha256:${usersReportStringHash(value)}`;
  // Nested objects/arrays are not expected in this report; hash their JSON so nothing leaks.
  try {
    return `sha256:${usersReportStringHash(JSON.stringify(value))}`;
  } catch {
    return "sha256:unserializable";
  }
}

/** Redact a report's rows: numeric/boolean cells kept, every string hashed. */
export function redactUsersReportRows(
  rows: readonly unknown[],
): RedactedUsersReport {
  const columns: string[] = [];
  const seenColumns = new Set<string>();
  const numeric = new Set<string>();
  const strings = new Set<string>();
  const out: Record<string, RedactedCell>[] = [];
  for (const raw of rows) {
    const record = asRecord(raw);
    if (record === null) continue;
    const row: Record<string, RedactedCell> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!seenColumns.has(key)) {
        seenColumns.add(key);
        columns.push(key);
      }
      const cell = redactCell(value);
      row[key] = cell;
      if (typeof cell === "number") numeric.add(key);
      else if (typeof cell === "string") strings.add(key);
    }
    out.push(row);
  }
  return {
    rows: out,
    columns,
    numericColumns: columns.filter((column) => numeric.has(column)),
    stringColumns: columns.filter((column) => strings.has(column)),
    rowCount: out.length,
  };
}

function parseReportRows(raw: unknown): {
  rows: readonly unknown[];
  envelope: "array" | "object-r";
} {
  if (Array.isArray(raw)) return { rows: raw, envelope: "array" };
  const record = asRecord(raw);
  if (record === null) {
    throw new UsersReportError(
      "invalid_response",
      "users-report: response is neither an array nor an object",
    );
  }
  const rows = record["r"];
  const errorCode = record["e"];
  const description = record["d"];
  if (Array.isArray(rows)) {
    if (errorCode === 0 || errorCode === "0" || errorCode === undefined) {
      return { rows, envelope: "object-r" };
    }
    throw new UsersReportError(
      "report_error",
      `users-report: report refused with e=${String(errorCode)}${
        typeof description === "string" && description !== ""
          ? ` (${description})`
          : ""
      }`,
      { e: errorCode },
    );
  }
  throw new UsersReportError(
    "invalid_response",
    "users-report: response has no rows array; a non-array body is an error, never an empty report",
    { keys: Object.keys(record).sort() },
  );
}

/** Transport seam: same shape as `fetch`, without requiring Bun's extra fetch properties. */
export type UsersReportFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface UsersReportFetchOptions extends UsersReportRequest {
  readonly cookieHeader: string;
  readonly sessionSource?: string;
  readonly sessionGate?: string;
  readonly fetchImpl?: UsersReportFetch;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

/**
 * Fetch one users-report and return the redacted artifact. Session-gated: a missing/expired
 * session fails closed with `auth_expired`; nothing is written here.
 */
export async function captureUsersReport(
  options: UsersReportFetchOptions,
): Promise<UsersReportCapture> {
  if (options.cookieHeader.trim() === "") {
    throw new UsersReportError(
      "auth_expired",
      "users-report: no GSLive manager session (cookie header is empty); reauthenticate before capturing",
    );
  }
  const request: UsersReportRequest = {
    fromEpochSec: options.fromEpochSec,
    toEpochSec: options.toEpochSec,
    ...(options.partnerId === undefined
      ? {}
      : { partnerId: options.partnerId }),
  };
  const base = options.baseUrl ?? USERS_REPORT_BASE_URL;
  const url = buildUsersReportUrl(request).replace(USERS_REPORT_BASE_URL, base);
  const headers: Record<string, string> = {
    accept: "application/json",
    cookie: options.cookieHeader,
    referer: "https://plive.sportswidgets.pro/manager-tools/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
  };
  if (options.sessionGate !== undefined && options.sessionGate !== "") {
    headers["x-gs-session"] = options.sessionGate;
  }
  const fetchImpl: UsersReportFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    throw new UsersReportError(
      "http_error",
      `user-report fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new UsersReportError(
        "auth_expired",
        `users-report: HTTP ${status} — AUTH_EXPIRED (login required); reauthenticate, then retry once`,
        { status },
      );
    }
    throw new UsersReportError("http_error", `users-report: HTTP ${status}`, {
      status,
    });
  }
  const text = await response.text();
  const rawSha256 = Bun.CryptoHasher.hash("sha256", text, "hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new UsersReportError(
      "invalid_response",
      "users-report: response body is not JSON (an HTML login page means the session expired)",
      { bytes: text.length, sha256: rawSha256 },
    );
  }
  const { rows, envelope } = parseReportRows(parsed);
  const report = redactUsersReportRows(rows);
  const partnerId = request.partnerId ?? USERS_REPORT_PARTNER_ID;
  return {
    url,
    fromEpochSec: request.fromEpochSec,
    toEpochSec: request.toEpochSec,
    partnerId,
    capturedAt: new Date().toISOString(),
    rawSha256,
    envelope,
    sessionSource: options.sessionSource ?? "unknown",
    report,
  };
}

/* -------------------------------------------------------------------------- */
/* Artifact provenance + freshness                                             */
/* -------------------------------------------------------------------------- */

export type UsersReportArtifactStatus =
  "fresh" | "stale" | "unverified_provenance";

export interface UsersReportArtifactAssessment {
  readonly artifact: UsersReportCapture;
  readonly capturedAtMs: number | null;
  readonly ageMinutes: number | null;
  readonly status: UsersReportArtifactStatus;
  readonly reasons: readonly string[];
}

function isHexDigest(value: unknown, length: number): boolean {
  return (
    typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
  );
}

/**
 * Validate a captured artifact before comparing: it must carry its own provenance (capture kind,
 * capturedAt, raw response digest) and be recent enough for the comparison to mean anything.
 * A bare redacted report without provenance is refused rather than trusted.
 */
export function readUsersReportArtifact(
  raw: unknown,
  options: { readonly nowMs?: number; readonly maxAgeMinutes: number },
): UsersReportArtifactAssessment {
  const record = asRecord(raw);
  if (record === null) {
    throw new UsersReportError(
      "invalid_response",
      "users-report artifact is not a JSON object",
    );
  }
  const reasons: string[] = [];
  if (record["kind"] !== "gslive-users-report-capture") {
    throw new UsersReportError(
      "invalid_response",
      "users-report artifact is not a capture (kind must be gslive-users-report-capture); a bare report has no provenance",
    );
  }
  if (!isHexDigest(record["rawSha256"], 64)) {
    throw new UsersReportError(
      "invalid_response",
      "users-report artifact has no valid rawSha256 provenance",
    );
  }
  const rawSha256Text = record["rawSha256"] as string;
  const capturedAtText =
    typeof record["capturedAt"] === "string" ? record["capturedAt"] : "";
  const capturedAtMs =
    capturedAtText === "" ? Number.NaN : Date.parse(capturedAtText);
  if (!Number.isFinite(capturedAtMs)) {
    throw new UsersReportError(
      "invalid_response",
      "users-report artifact has no parseable capturedAt",
    );
  }
  const reportRecord = asRecord(record["report"]);
  if (reportRecord === null) {
    throw new UsersReportError(
      "invalid_response",
      "users-report artifact has no redacted report block",
    );
  }
  const rows = reportRecord["rows"];
  const columns = reportRecord["columns"];
  const numericColumns = reportRecord["numericColumns"];
  const stringColumns = reportRecord["stringColumns"];
  if (
    !Array.isArray(rows) ||
    !Array.isArray(columns) ||
    !Array.isArray(numericColumns) ||
    !Array.isArray(stringColumns)
  ) {
    throw new UsersReportError(
      "invalid_response",
      "users-report artifact report block is missing rows/columns metadata",
    );
  }
  const nowMs = options.nowMs ?? Date.now();
  const ageMinutes = Math.max(0, (nowMs - capturedAtMs) / 60_000);
  const status: UsersReportArtifactStatus =
    ageMinutes > options.maxAgeMinutes ? "stale" : "fresh";
  if (status === "stale") {
    reasons.push(
      `capturedAt is ${ageMinutes.toFixed(1)} minutes old (max ${options.maxAgeMinutes})`,
    );
  }
  return {
    artifact: {
      url: typeof record["url"] === "string" ? record["url"] : "",
      fromEpochSec:
        typeof record["fromEpochSec"] === "number" ? record["fromEpochSec"] : 0,
      toEpochSec:
        typeof record["toEpochSec"] === "number" ? record["toEpochSec"] : 0,
      partnerId:
        typeof record["partnerId"] === "number"
          ? record["partnerId"]
          : USERS_REPORT_PARTNER_ID,
      capturedAt: capturedAtText,
      rawSha256: rawSha256Text,
      sessionSource:
        typeof record["sessionSource"] === "string"
          ? record["sessionSource"]
          : "unknown",
      envelope: record["envelope"] === "object-r" ? "object-r" : "array",
      report: {
        rows: rows as RedactedUsersReport["rows"],
        columns: columns as string[],
        numericColumns: numericColumns as string[],
        stringColumns: stringColumns as string[],
        rowCount:
          typeof reportRecord["rowCount"] === "number"
            ? reportRecord["rowCount"]
            : rows.length,
      },
    },
    capturedAtMs,
    ageMinutes,
    status,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Same-book control artifact (produced by compare/verify, read by status)     */
/* -------------------------------------------------------------------------- */

export const USERS_REPORT_CONTROL_REL_PATH =
  "reports/security/users-report-control.json";
export const USERS_REPORT_CONTROL_KIND = "users-report-control";
export const USERS_REPORT_CONTROL_SCHEMA_VERSION = 1 as const;
/** Status treats a control older than this as stale (operators regenerate after a fresh capture). */
export const USERS_REPORT_CONTROL_MAX_AGE_MINUTES = 24 * 60;

export type UsersReportControlStatus =
  | "unavailable"
  | "ok"
  | "stale"
  | "scope_mismatch"
  | "no_join"
  | "invalid"
  | "unverified_corpus";

export interface UsersReportControlView {
  readonly status: UsersReportControlStatus;
  readonly generatedAt: string | null;
  readonly ageMinutes: number | null;
  readonly maxAgeMinutes: number;
  readonly report: {
    readonly path: string | null;
    readonly capturedAt: string | null;
    readonly rawSha256: string | null;
    readonly rowCount: number | null;
    readonly sessionSource: string | null;
  };
  readonly corpus: {
    readonly path: string | null;
    readonly sha256: string | null;
    readonly verified: boolean | null;
    readonly from: number | null;
    readonly to: number | null;
    readonly tickets: number | null;
  };
  readonly scope: { readonly match: boolean | null };
  readonly join: {
    readonly idColumn: string | null;
    readonly idKind: string | null;
    readonly matchedIds: number | null;
    readonly unmatchedReportIds: number | null;
    readonly duplicateIdRows: number | null;
  } | null;
  readonly candidateCount: number;
  readonly note: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Stream a file's sha256; null when it cannot be read. */
export async function sha256FileHex(path: string): Promise<string | null> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
    return hasher.digest("hex");
  } catch {
    return null;
  }
}

function unavailableControl(
  maxAgeMinutes: number,
  note: string,
): UsersReportControlView {
  return {
    status: "unavailable",
    generatedAt: null,
    ageMinutes: null,
    maxAgeMinutes,
    report: {
      path: null,
      capturedAt: null,
      rawSha256: null,
      rowCount: null,
      sessionSource: null,
    },
    corpus: {
      path: null,
      sha256: null,
      verified: null,
      from: null,
      to: null,
      tickets: null,
    },
    scope: { match: null },
    join: null,
    candidateCount: 0,
    note,
  };
}

/**
 * Validate a same-book control artifact produced by the compare/verify workflow.
 *
 * `corpusSha256` is the CURRENT digest of the corpus path the artifact names (or null when it
 * cannot be read). A control whose recorded corpus digest differs is `unverified_corpus`, never
 * `ok`: the comparison may describe a different corpus than the one on disk.
 */
export function readUsersReportControl(
  raw: unknown,
  options: {
    readonly nowMs?: number;
    readonly maxAgeMinutes: number;
    readonly corpusSha256?: string | null;
  },
): UsersReportControlView {
  const maxAgeMinutes = options.maxAgeMinutes;
  if (raw === null || raw === undefined) {
    return unavailableControl(
      maxAgeMinutes,
      "no users-report control artifact; capture and compare first",
    );
  }
  const record = asRecord(raw);
  if (record === null) {
    return unavailableControl(
      maxAgeMinutes,
      "control artifact is not an object",
    );
  }
  const invalid = (note: string): UsersReportControlView => ({
    ...unavailableControl(maxAgeMinutes, note),
    generatedAt: stringOrNull(record["generatedAt"]),
  });
  if (record["kind"] !== USERS_REPORT_CONTROL_KIND) {
    return invalid("control artifact has the wrong kind");
  }
  if (record["schemaVersion"] !== USERS_REPORT_CONTROL_SCHEMA_VERSION) {
    return invalid("control artifact has an unsupported schemaVersion");
  }
  const generatedAt = stringOrNull(record["generatedAt"]);
  const generatedAtMs =
    generatedAt === null ? Number.NaN : Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    return invalid("control artifact has no parseable generatedAt");
  }
  const report = asRecord(record["report"]);
  const corpus = asRecord(record["corpus"]);
  const scope = asRecord(record["scope"]);
  const join = asRecord(record["join"]);
  const candidates = Array.isArray(record["candidates"])
    ? record["candidates"]
    : [];
  const reportedStatus = stringOrNull(record["status"]);
  const nowMs = options.nowMs ?? Date.now();
  const ageMinutes = Math.max(0, (nowMs - generatedAtMs) / 60_000);
  const base: UsersReportControlView = {
    status: "invalid",
    generatedAt,
    ageMinutes,
    maxAgeMinutes,
    report: {
      path: stringOrNull(report?.["path"]),
      capturedAt: stringOrNull(report?.["capturedAt"]),
      rawSha256: stringOrNull(report?.["rawSha256"]),
      rowCount: numberOrNull(report?.["rowCount"]),
      sessionSource: stringOrNull(report?.["sessionSource"]),
    },
    corpus: {
      path: stringOrNull(corpus?.["path"]),
      sha256: stringOrNull(corpus?.["sha256"]),
      verified: null,
      from: numberOrNull(corpus?.["from"]),
      to: numberOrNull(corpus?.["to"]),
      tickets: numberOrNull(corpus?.["tickets"]),
    },
    scope: {
      match:
        scope?.["match"] === true
          ? true
          : scope?.["match"] === false
            ? false
            : null,
    },
    join:
      join === null
        ? null
        : {
            idColumn: stringOrNull(join["idColumn"]),
            idKind: stringOrNull(join["idKind"]),
            matchedIds: numberOrNull(join["matchedIds"]),
            unmatchedReportIds: numberOrNull(join["unmatchedReportIds"]),
            duplicateIdRows: numberOrNull(join["duplicateIdRows"]),
          },
    candidateCount: candidates.length,
    note: stringOrNull(record["note"]),
  };
  if (ageMinutes > maxAgeMinutes) {
    return {
      ...base,
      status: "stale",
      note: `control is ${ageMinutes.toFixed(1)} minutes old (max ${maxAgeMinutes})`,
    };
  }
  if (record["status"] === "scope_mismatch") {
    return { ...base, status: "scope_mismatch" };
  }
  if (record["status"] === "no_join") return { ...base, status: "no_join" };
  if (record["status"] !== "ok") {
    return {
      ...base,
      status: "invalid",
      note: `control status is ${String(reportedStatus)}`,
    };
  }
  const recordedCorpusSha = base.corpus.sha256;
  const currentCorpusSha = options.corpusSha256 ?? null;
  if (recordedCorpusSha === null) {
    return {
      ...base,
      status: "unverified_corpus",
      note: "control records no corpus digest",
    };
  }
  if (currentCorpusSha === null) {
    return {
      ...base,
      corpus: { ...base.corpus, verified: null },
      status: "unverified_corpus",
      note: "corpus digest cannot be read; control provenance unverified",
    };
  }
  if (recordedCorpusSha !== currentCorpusSha) {
    return {
      ...base,
      corpus: { ...base.corpus, verified: false },
      status: "unverified_corpus",
      note: "control corpus digest differs from the corpus on disk",
    };
  }
  return {
    ...base,
    status: "ok",
    corpus: { ...base.corpus, verified: true },
  };
}

/* -------------------------------------------------------------------------- */
/* Control artifact builder                                                    */
/* -------------------------------------------------------------------------- */

export interface UsersReportControlInput {
  readonly status: "ok" | "scope_mismatch" | "no_join";
  readonly reportPath: string;
  readonly capture: UsersReportCapture;
  readonly corpusPath: string;
  readonly corpusSha256: string | null;
  readonly corpusFrom: number | null;
  readonly corpusTo: number | null;
  readonly corpusTickets: number;
  readonly scopeMatch: boolean;
  readonly join: {
    readonly idColumn: string;
    readonly idKind: string;
    readonly matchedIds: number;
    readonly unmatchedReportIds: number;
    readonly duplicateIdRows: number;
  } | null;
  readonly candidates: readonly UsersReportMetricCandidate[];
  readonly note: string;
  readonly generatedAt?: string;
}

/** Build the versioned same-book control artifact written by compare/verify. */
export function buildUsersReportControlArtifact(
  input: UsersReportControlInput,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: USERS_REPORT_CONTROL_SCHEMA_VERSION,
    kind: USERS_REPORT_CONTROL_KIND,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: input.status,
    report: {
      path: input.reportPath,
      capturedAt: input.capture.capturedAt,
      rawSha256: input.capture.rawSha256,
      rowCount: input.capture.report.rowCount,
      sessionSource: input.capture.sessionSource,
      fromEpochSec: input.capture.fromEpochSec,
      toEpochSec: input.capture.toEpochSec,
      partnerId: input.capture.partnerId,
    },
    corpus: {
      path: input.corpusPath,
      sha256: input.corpusSha256,
      from: input.corpusFrom,
      to: input.corpusTo,
      tickets: input.corpusTickets,
    },
    scope: { match: input.scopeMatch },
    join: input.join,
    candidateCount: input.candidates.length,
    candidates: input.candidates,
    note: input.note,
  };
}

/* -------------------------------------------------------------------------- */
/* Comparison scaffold                                                         */
/* -------------------------------------------------------------------------- */

export interface TicketAggregate {
  readonly stakeCents: number;
  readonly resultCents: number;
  readonly tickets: number;
}

export interface CorpusAggregates {
  readonly byUserId: ReadonlyMap<string, TicketAggregate>;
  readonly byPartnerHash: ReadonlyMap<string, TicketAggregate>;
}

function dollarsToCents(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
  }
  return null;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function addAggregate(
  map: Map<
    string,
    { stakeCents: number; resultCents: number; tickets: number }
  >,
  key: string | null,
  stakeCents: number,
  resultCents: number,
): void {
  if (key === null) return;
  const current = map.get(key) ?? {
    stakeCents: 0,
    resultCents: 0,
    tickets: 0,
  };
  current.stakeCents += stakeCents;
  current.resultCents += resultCents;
  current.tickets += 1;
  map.set(key, current);
}

/**
 * Aggregate `getBetReport` rows by ticket (one `betGroupId` counted once) per numeric userID and
 * per hashed partner login (the same `sha256:16` redaction the report capture uses).
 */
export function aggregateCorpusTickets(
  bets: readonly unknown[],
): CorpusAggregates {
  const tickets = new Map<
    string,
    {
      userId: string | null;
      partnerId: string | null;
      bet: unknown;
      result: unknown;
    }
  >();
  for (const raw of bets) {
    const record = asRecord(raw);
    if (record === null) continue;
    const betGroupId = textOf(record["betGroupId"]);
    if (betGroupId === null) continue;
    if (tickets.has(betGroupId)) continue;
    tickets.set(betGroupId, {
      userId: textOf(record["userID"]),
      partnerId: textOf(record["partnerUserID"]),
      bet: record["bet"],
      result: record["betGroupResult"],
    });
  }
  const users = new Map<
    string,
    { stakeCents: number; resultCents: number; tickets: number }
  >();
  const partners = new Map<
    string,
    { stakeCents: number; resultCents: number; tickets: number }
  >();
  for (const ticket of tickets.values()) {
    const stake = dollarsToCents(ticket.bet) ?? 0;
    const result = dollarsToCents(ticket.result) ?? 0;
    addAggregate(users, ticket.userId, stake, result);
    addAggregate(
      partners,
      ticket.partnerId === null
        ? null
        : `sha256:${usersReportStringHash(ticket.partnerId)}`,
      stake,
      result,
    );
  }
  return { byUserId: users, byPartnerHash: partners };
}

export interface UsersReportMetricCandidate {
  readonly column: string;
  readonly reportSum: number;
  readonly corpusStakeCents: number;
  readonly corpusResultCents: number;
  readonly corpusTickets: number;
  readonly stakeDeltaCents: number;
  readonly resultDeltaCents: number;
  readonly ticketDelta: number;
}

export interface UsersReportComparison {
  readonly idColumn: string;
  readonly idKind: "userId" | "partnerHash";
  /** Report ids that resolve to a corpus account. */
  readonly overlap: number;
  readonly reportRows: number;
  readonly corpusTickets: number;
  readonly candidates: readonly UsersReportMetricCandidate[];
  readonly note: string;
}

/**
 * Join a redacted users-report to corpus ticket aggregates. The identifier column is discovered
 * from overlap (a numeric column matching `userID`, or a `sha256:` column matching the hashed
 * partner login). Numeric report columns are then ranked against the corpus's stake/result/ticket
 * totals — candidates, not assertions; a human confirms the metric mapping.
 */
export function compareUsersReportToCorpus(
  report: RedactedUsersReport,
  corpus: CorpusAggregates,
): UsersReportComparison {
  const corpusUserIds = corpus.byUserId;
  const corpusPartnerHashes = corpus.byPartnerHash;
  let best: {
    column: string;
    kind: "userId" | "partnerHash";
    overlap: number;
  } | null = null;
  for (const column of report.numericColumns) {
    let overlap = 0;
    for (const row of report.rows) {
      const cell = row[column];
      if (typeof cell === "number" && corpusUserIds.has(String(cell))) {
        overlap += 1;
      }
    }
    if (overlap > 0 && (best === null || overlap > best.overlap)) {
      best = { column, kind: "userId", overlap };
    }
  }
  for (const column of report.stringColumns) {
    let overlap = 0;
    for (const row of report.rows) {
      const cell = row[column];
      if (typeof cell === "string" && corpusPartnerHashes.has(cell)) {
        overlap += 1;
      }
    }
    if (overlap > 0 && (best === null || overlap > best.overlap)) {
      best = { column, kind: "partnerHash", overlap };
    }
  }
  if (best === null) {
    throw new UsersReportError(
      "invalid_response",
      "users-report comparison: no column matches corpus userID or hashed partner login",
      {
        numericColumns: report.numericColumns,
        stringColumns: report.stringColumns,
      },
    );
  }
  const corpusTickets =
    best.kind === "userId"
      ? [...corpusUserIds.values()].reduce((sum, a) => sum + a.tickets, 0)
      : [...corpusPartnerHashes.values()].reduce(
          (sum, a) => sum + a.tickets,
          0,
        );
  const corpusStakeCents =
    best.kind === "userId"
      ? [...corpusUserIds.values()].reduce((sum, a) => sum + a.stakeCents, 0)
      : [...corpusPartnerHashes.values()].reduce(
          (sum, a) => sum + a.stakeCents,
          0,
        );
  const corpusResultCents =
    best.kind === "userId"
      ? [...corpusUserIds.values()].reduce((sum, a) => sum + a.resultCents, 0)
      : [...corpusPartnerHashes.values()].reduce(
          (sum, a) => sum + a.resultCents,
          0,
        );
  const candidates: UsersReportMetricCandidate[] = report.numericColumns
    .filter((column) => column !== best.column)
    .map((column) => {
      let reportSum = 0;
      for (const row of report.rows) {
        const cell = row[column];
        if (typeof cell === "number") reportSum += cell;
      }
      return {
        column,
        reportSum,
        corpusStakeCents,
        corpusResultCents,
        corpusTickets,
        stakeDeltaCents: Math.round(reportSum * 100) - corpusStakeCents,
        resultDeltaCents: Math.round(reportSum * 100) - corpusResultCents,
        ticketDelta: Math.round(reportSum) - corpusTickets,
      };
    })
    .sort(
      (left, right) =>
        Math.abs(left.stakeDeltaCents) +
        Math.abs(left.resultDeltaCents) -
        (Math.abs(right.stakeDeltaCents) + Math.abs(right.resultDeltaCents)),
    )
    .slice(0, 5);
  return {
    idColumn: best.column,
    idKind: best.kind,
    overlap: best.overlap,
    reportRows: report.rowCount,
    corpusTickets,
    candidates,
    note: "Candidate metric matches from a second encoding in the same book. Not external settlement truth; confirm the column mapping before quoting any delta.",
  };
}
