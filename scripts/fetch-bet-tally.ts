/** Per-state tally from the Manager Tools `ajax.php` endpoint (GSLive Partner 118).
 *
 *  Sends `state:""` (the SPA's "All" option) and tallies states client-side, because the
 *  endpoint's `state` field is a filter: sending `"rejected"` narrows the result to it.
 *
 *  Session handling follows `fetch-config.ts`: the `GSID` session GUID comes from the
 *  environment (the SSOT `.env`, mounted from `.1password/environments.toml`). It is never a
 *  literal in this file, never printed, and never accepted from a chat prompt — a cookie that
 *  appeared in plaintext is a credential incident: revoke it and re-provision.
 *
 *  Observed state vocabulary (`~/turbo-cap/.../.data/exports/bet-report.csv`, exported
 *  2026-10-24 20:54, bet times 2026-10-18..2026-10-24): `pending`, `win`, `lose`, `push`,
 *  `cashout`, `half win`, `half lose`, `cancel`, `cancel after confirmation`; the endpoint can
 *  also return numeric codes (see `GSLIVE_NUMERIC_STATE_MAP`). `rejected`/`settled`/`void` are
 *  NOT in that vocabulary, so a probe list built from them measures nothing.
 *
 *  Usage:
 *    GSID=... bun run bet:tally
 *    GSID=... bun run bet:tally --from 1793163600 --to 1793771999
 *    bun run bet:tally --dry-run                 # print the request body; no network, no secret
 *
 *  Writes `scratch/bet-tally.json` (gitignored) and prints a compact table.
 */

import { parseArgs } from "node:util";

import { sessionFromGsliveProfile } from "../lib/gslive_session.ts";
import {
  requireManagerSession,
  sessionGateFromEnv,
} from "../lib/manager_session.ts";

import { z } from "zod";
import { argv, env, write } from "bun";

export const AJAX_URL =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php";

/**
 * Session endpoint the SPA uses for both flows: `POST {"checkSession":true}` returns
 * `ganchrowSessionId` (sent as the JS-readable `x-gs-session` header on `ajax.php`), and
 * `POST {"username","password"}` is the credential login. The credential flow is used by
 * `lib/gslive_auto_session.ts`; no credential or cookie value is logged.
 */
export const SIGNIN_URL =
  "https://plive.sportswidgets.pro/api/v3/manager-tools/signin/";

/** The SPA's "All" option. Empty string, not a missing key. */
export const ALL_STATES = "";

/** Observed GSLive wager states, from the retained export cited in the header. */
export const GSLIVE_STATES = [
  "pending",
  "win",
  "lose",
  "push",
  "cashout",
  "half win",
  "half lose",
  "cancel",
  "cancel after confirmation",
] as const;

/** Numeric state codes the endpoint may return instead of the labels above. */
export const GSLIVE_NUMERIC_STATE_MAP: Readonly<Record<number, string>> = {
  0: "pending",
  1: "win",
  2: "lose",
  3: "push",
  4: "cancel",
  5: "cancel after confirmation",
  6: "cashout",
  7: "half win",
  8: "half lose",
};

/** `dateFilterBy` values the endpoint accepts. `logTime` is the desk's report-link default. */
export const BET_REPORT_DATE_FILTERS = [
  "calcTime",
  "betTime",
  "logTime",
] as const;

export type DateFilterBy = (typeof BET_REPORT_DATE_FILTERS)[number];

const STATE_FIELD_CANDIDATES = ["state", "status", "betState", "betStatus"];

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

export interface BetReportPayload {
  readonly action: "getBetReport";
  readonly partnerUserId: string;
  readonly agent: string;
  readonly eventId: string;
  readonly freeBetId: string;
  readonly state: string;
  readonly sId: string;
  readonly minVolume: string;
  readonly maxTimeUntilScore: string;
  readonly mId: string;
  readonly from: number;
  readonly fromTime: number;
  readonly to: number;
  readonly toTime: number;
  readonly betId: string;
  readonly betGroupId: string;
  readonly group: null;
  readonly dateFilterBy: DateFilterBy;
  readonly partnerIds: string;
  readonly period: null;
}

export interface BetTally {
  readonly field: string;
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
  /** Number of distinct state labels seen, including "(missing)". */
  readonly distinct: number;
}

export interface BetTallyOptions {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  /** Full `Cookie` header value. Callers build it from the environment; never a literal. */
  readonly cookieHeader: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  /** Optional second gate some builds require alongside the cookie. */
  readonly sessionGate?: string;
  /** "auto" probes per-state only when the bulk tally looks defaulted or empty. */
  readonly probe?: "auto" | "always" | "never";
  readonly states?: readonly string[];
  readonly dateFilterBy?: DateFilterBy;
}

export interface BetTallyResult extends BetTally {
  /** When the request was made, so a tallied number carries its own age. */
  readonly capturedAt: string;
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly dateFilterBy: DateFilterBy;
  /** Per-state row counts when probed, `null` when not probed. */
  readonly perState: Readonly<Record<string, number>> | null;
  /**
   * True when every per-state probe returned an identical payload: the server ignores the
   * `state` field, so neither the bulk count nor a sum of per-state counts is a per-state tally.
   */
  readonly filterIgnored: boolean;
  /** A probed state whose payload is identical to the bulk payload — the likely default. */
  readonly defaultState: string | null;
  readonly warnings: readonly string[];
}

/** Build the request body. `group:null` is required: grouping collapses rows, not bets. */
export function buildBetReportPayload(opts: {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly state?: string;
  readonly dateFilterBy?: DateFilterBy;
}): BetReportPayload {
  return {
    action: "getBetReport",
    partnerUserId: "",
    agent: "",
    eventId: "",
    freeBetId: "",
    state: opts.state ?? ALL_STATES,
    sId: "",
    minVolume: "0",
    maxTimeUntilScore: "0",
    mId: "",
    from: opts.fromEpochSec,
    fromTime: 0,
    to: opts.toEpochSec,
    toTime: 86399,
    betId: "",
    betGroupId: "",
    group: null,
    dateFilterBy: opts.dateFilterBy ?? "calcTime",
    partnerIds: "",
    period: null,
  };
}

/** Normalise the `--date-filter-by` flag; unknown values keep the observed `calcTime` default. */
export function parseDateFilterBy(value: string | undefined): DateFilterBy {
  for (const filter of BET_REPORT_DATE_FILTERS) {
    if (value === filter) return filter;
  }
  if (value !== undefined && value !== "") {
    console.warn(
      `bet-report: unknown --date-filter-by ${JSON.stringify(value)}; using calcTime`,
    );
  }
  return "calcTime";
}

/**
 * Session resolution moved to `lib/manager_session.ts` so the daemon can read it without
 * importing this CLI. These re-exports keep the script's public surface unchanged.
 */
export {
  cookieHeaderFromEnv,
  GSID_SECRET,
  GSID_SECRET_PRE_RENAME,
  GSID_SECRET_LEGACY,
  resolveManagerSession,
  requireManagerSession,
  sessionGateFromEnv,
} from "../lib/manager_session.ts";
export type {
  SecretReader,
  ManagerSessionSource,
  ActiveManagerSession,
  NoManagerSession,
  ManagerSession,
} from "../lib/manager_session.ts";

const envelopeSchema = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const ROW_COLLECTIONS = [
  "bets",
  "rows",
  "data",
  "items",
  "result",
  "list",
] as const;

/**
 * Extract bet rows from the endpoint's polymorphic envelope. Zero rows is a real observation;
 * a payload that is neither an array nor a row-bearing object throws, so an HTML login page or
 * an error envelope cannot degrade into "no bets".
 */
export function extractBetRows(payload: unknown): readonly unknown[] {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `unexpected getBetReport payload: ${describeShape(payload)} (expected an array or object)`,
    );
  }
  if (Array.isArray(parsed.data)) return parsed.data;

  for (const key of ROW_COLLECTIONS) {
    const value = parsed.data[key];
    if (Array.isArray(value)) return value;
  }
  // Live `getBetReport` wraps the rows one level down: `{ r: { bets: [...] }, e, d, from, to }`.
  const nested = parsed.data["r"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    for (const key of ROW_COLLECTIONS) {
      const value = (nested as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw new Error(
    `unexpected getBetReport envelope: object without an array under ${ROW_COLLECTIONS.join("/")} or r.<collection> (keys: ${
      Object.keys(parsed.data).join(", ") || "(none)"
    })`,
  );
}

function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const rowSchema = z.record(z.string(), z.unknown());

/** Pick the field the rows actually carry, not just the first row's. */
export function selectStateField(rows: readonly unknown[]): string {
  let best = "state";
  let bestScore = -1;
  for (const field of STATE_FIELD_CANDIDATES) {
    let score = 0;
    for (const row of rows) {
      const parsed = rowSchema.safeParse(row);
      if (parsed.success && parsed.data[field] !== undefined) score += 1;
    }
    if (score > bestScore) {
      best = field;
      bestScore = score;
    }
  }
  return best;
}

/** Map one state cell to a label. Numeric codes resolve through the observed map. */
export function stateLabel(row: unknown, field: string): string {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) return "(non-object row)";
  const value = parsed.data[field];
  if (value === undefined || value === null) return "(missing)";
  if (typeof value === "number") {
    return GSLIVE_NUMERIC_STATE_MAP[value] ?? `(code ${value})`;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? "(empty)" : trimmed;
  }
  return `(${typeof value})`;
}

export function tallyRows(rows: readonly unknown[]): BetTally {
  const field = selectStateField(rows);
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const label = stateLabel(row, field);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return {
    field,
    total: rows.length,
    counts,
    distinct: Object.keys(counts).length,
  };
}

/** Render an ASCII table. Guards the percentage division for an empty window. */
export function formatTally(tally: BetTally): string {
  const sorted = Object.entries(tally.counts).sort((a, b) => b[1] - a[1]);
  const width = Math.max(5, ...sorted.map(([label]) => label.length));
  const lines = [
    `field = ${tally.field}   total = ${tally.total}`,
    "",
    `${tally.field.padEnd(width)} ${"count".padStart(8)} ${"pct".padStart(7)}`,
    "-".repeat(width + 17),
  ];
  for (const [label, count] of sorted) {
    const pct =
      tally.total === 0
        ? "0.0%"
        : `${((count / tally.total) * 100).toFixed(1)}%`;
    lines.push(
      `${label.padEnd(width)} ${String(count).padStart(8)} ${pct.padStart(7)}`,
    );
  }
  return lines.join("\n");
}

/** Compare probe payloads by their tallied content, not by row count alone. */
function payloadSignature(rows: readonly unknown[]): string {
  const tally = tallyRows(rows);
  return JSON.stringify(
    Object.entries(tally.counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * GSLive labels JSON bodies as `text/html` on both `signin` and `ajax.php`; the body, not the
 * header, is the reliable signal. Detect a login page by its leading `<`, keep the status/content
 * type in the error, and never echo the request (the cookie is in it).
 */
async function readManagerJson(
  response: Response,
  label: string,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    throw new Error(
      `${label} returned HTTP ${response.status} (${contentType || "no content-type"})` +
        (contentType.includes("html")
          ? "; an HTML login page means the session expired"
          : ""),
    );
  }
  const text = await response.text();
  const trimmed = text.trimStart();
  if (trimmed === "" || trimmed.startsWith("<")) {
    throw new Error(
      `${label} returned HTTP ${response.status} (${contentType || "no content-type"}); ` +
        "an HTML login page means the session expired",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} returned HTTP ${response.status} (${contentType || "no content-type"}) ` +
        "with a non-JSON body",
    );
  }
}

async function postBetReport(opts: {
  // Generated or supplied verbatim; both are JSON-serialised unchanged.
  readonly payload: unknown;
  readonly cookieHeader: string;
  readonly sessionGate: string;
  readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs: number;
  /** Endpoint override for a local stand-in or proxy. Defaults to `AJAX_URL`. */
  readonly url?: string;
}): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    cookie: opts.cookieHeader,
    referer: "https://plive.sportswidgets.pro/manager-tools/",
    "user-agent": USER_AGENT,
  };
  if (opts.sessionGate !== "") headers["x-gs-session"] = opts.sessionGate;

  const response = await opts.fetchImpl(opts.url ?? AJAX_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.payload),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    // Never echo the request headers or body: the cookie is in them.
    throw new Error(
      `getBetReport returned HTTP ${response.status} (${contentType || "no content-type"}); ` +
        "an HTML login page means the session expired",
    );
  }
  return await readManagerJson(response, "getBetReport");
}

export interface FetchBetRowsOptions {
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  /** Defaults to the SPA's "All" option. */
  readonly state?: string;
  readonly cookieHeader: string;
  readonly sessionGate?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  readonly dateFilterBy?: DateFilterBy;
  /** Endpoint override for a local stand-in or proxy. Defaults to `AJAX_URL`. */
  readonly url?: string;
}

/** Fetch the raw wager rows for one state filter (default All) from `ajax.php`. */
export async function fetchBetReportRows(
  opts: FetchBetRowsOptions,
): Promise<readonly unknown[]> {
  const payload = await postBetReport({
    payload: buildBetReportPayload({
      fromEpochSec: opts.fromEpochSec,
      toEpochSec: opts.toEpochSec,
      state: opts.state ?? ALL_STATES,
      dateFilterBy: opts.dateFilterBy ?? "calcTime",
    }),
    cookieHeader: opts.cookieHeader,
    sessionGate: opts.sessionGate ?? "",
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? 15_000,
    ...(opts.url === undefined ? {} : { url: opts.url }),
  });
  return extractBetRows(payload);
}

/**
 * Schema for a supplied manager request body: the same wire shape, parsed once at the boundary.
 * `passthrough` keeps any extra keys the operator's body carries so it is sent verbatim.
 */
export const betReportRequestSchema = z
  .object({
    action: z.literal("getBetReport"),
    state: z.string().optional(),
    from: z.number().int(),
    to: z.number().int(),
    fromTime: z.number().int().optional(),
    toTime: z.number().int().optional(),
    group: z.null().optional(),
    dateFilterBy: z
      .union([
        z.literal("calcTime"),
        z.literal("betTime"),
        z.literal("logTime"),
      ])
      .optional(),
  })
  .passthrough();

export type BetReportRequest = z.infer<typeof betReportRequestSchema>;

export function parseBetReportRequest(payload: unknown): BetReportRequest {
  const parsed = betReportRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid getBetReport payload: ${issues}`);
  }
  return parsed.data;
}

export interface FetchBetRowsFromPayloadOptions {
  readonly payload: unknown;
  readonly cookieHeader: string;
  readonly sessionGate?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  /** Endpoint override for a local stand-in or proxy. Defaults to `AJAX_URL`. */
  readonly url?: string;
}

/** POST a caller-supplied manager body verbatim and return its rows. */
export async function fetchBetReportRowsFromPayload(
  opts: FetchBetRowsFromPayloadOptions,
): Promise<readonly unknown[]> {
  const payload = parseBetReportRequest(opts.payload);
  const raw = await postBetReport({
    payload,
    cookieHeader: opts.cookieHeader,
    sessionGate: opts.sessionGate ?? "",
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? 15_000,
    ...(opts.url === undefined ? {} : { url: opts.url }),
  });
  return extractBetRows(raw);
}

const signinResponseSchema = z
  .object({
    ganchrowSessionId: z.string().min(1).optional(),
    adminUserName: z.string().optional(),
    agentName: z.string().optional(),
  })
  .passthrough();

export interface BootstrapSessionOptions {
  readonly cookieHeader: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

/**
 * Exchange the provisioned GSID cookie for the app's `x-gs-session` value. The response body is
 * never printed: it names the operator and agent. Errors carry status/content-type only.
 */
export async function bootstrapGanchrowSession(
  opts: BootstrapSessionOptions,
): Promise<string> {
  const response = await (opts.fetchImpl ?? fetch)(SIGNIN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: opts.cookieHeader,
      referer: "https://plive.sportswidgets.pro/manager-tools/",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ checkSession: true }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    throw new Error(
      `signin returned HTTP ${response.status} (${contentType || "no content-type"}); ` +
        "an HTML response means the GSID session is expired",
    );
  }
  const parsed = signinResponseSchema.safeParse(
    await readManagerJson(response, "signin"),
  );
  if (!parsed.success) {
    throw new Error(
      "signin response did not match { ganchrowSessionId, adminUserName, agentName }",
    );
  }
  const sessionId = parsed.data.ganchrowSessionId?.trim() ?? "";
  if (sessionId === "") {
    throw new Error(
      "signin succeeded but carried no ganchrowSessionId; continuing without x-gs-session",
    );
  }
  return sessionId;
}

export async function runBetTally(
  opts: BetTallyOptions,
): Promise<BetTallyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const probe = opts.probe ?? "auto";
  const states = opts.states ?? GSLIVE_STATES;
  const dateFilterBy = opts.dateFilterBy ?? "calcTime";
  const sessionGate = opts.sessionGate ?? "";
  const warnings: string[] = [];
  const capturedAt = new Date().toISOString();

  const post = (state: string): Promise<readonly unknown[]> =>
    fetchBetReportRows({
      fromEpochSec: opts.fromEpochSec,
      toEpochSec: opts.toEpochSec,
      state,
      cookieHeader: opts.cookieHeader,
      sessionGate,
      fetchImpl,
      timeoutMs,
      dateFilterBy,
    });

  const bulkRows = await post(ALL_STATES);
  const tally = tallyRows(bulkRows);

  const shouldProbe =
    probe === "always" ||
    (probe === "auto" &&
      states.length > 0 &&
      (tally.total === 0 || tally.distinct <= 1));

  if (!shouldProbe) {
    return {
      ...tally,
      capturedAt,
      fromEpochSec: opts.fromEpochSec,
      toEpochSec: opts.toEpochSec,
      dateFilterBy,
      perState: null,
      filterIgnored: false,
      defaultState: null,
      warnings,
    };
  }

  const perState: Record<string, number> = {};
  const signatures = new Map<string, string>();
  for (const state of states) {
    const rows = await post(state);
    perState[state] = rows.length;
    signatures.set(state, payloadSignature(rows));
  }

  const nonEmpty = Object.values(perState).filter((count) => count > 0).length;
  const distinctSignatures = new Set(signatures.values());
  const filterIgnored = nonEmpty > 0 && distinctSignatures.size === 1;
  if (filterIgnored) {
    warnings.push(
      "every probed state returned an identical payload: the server is ignoring the `state` field, " +
        "so neither the bulk count nor a sum of per-state counts is a per-state tally",
    );
  }

  const bulkSignature = payloadSignature(bulkRows);
  const defaultState = filterIgnored
    ? (states.find((state) => signatures.get(state) === bulkSignature) ?? null)
    : null;
  if (defaultState !== null) {
    warnings.push(
      `the bulk payload matches state ${JSON.stringify(defaultState)}: \`state:""\` is being ` +
        "treated as that state's filter, not as All",
    );
  }

  return {
    ...tally,
    capturedAt,
    fromEpochSec: opts.fromEpochSec,
    toEpochSec: opts.toEpochSec,
    dateFilterBy,
    perState,
    filterIgnored,
    defaultState,
    warnings,
  };
}

async function main(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      from: { type: "string" },
      to: { type: "string" },
      out: { type: "string", default: "scratch/bet-tally.json" },
      "date-filter-by": { type: "string", default: "calcTime" },
      probe: { type: "string", default: "auto" },
      timeout: { type: "string", default: "15000" },
      "dry-run": { type: "boolean", default: false },
      "bootstrap-session": { type: "boolean", default: false },
      "webview-profile": { type: "string" },
    },
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const fromEpochSec =
    values.from === undefined ? nowSec - 604_800 : Number(values.from);
  const toEpochSec = values.to === undefined ? nowSec : Number(values.to);
  if (!Number.isFinite(fromEpochSec) || !Number.isFinite(toEpochSec)) {
    throw new Error("--from and --to must be epoch seconds");
  }
  if (fromEpochSec > toEpochSec) throw new Error("--from must be <= --to");

  const dateFilterBy = parseDateFilterBy(values["date-filter-by"]);
  const probe =
    values.probe === "always" || values.probe === "never"
      ? values.probe
      : "auto";

  if (values["dry-run"]) {
    console.error(
      JSON.stringify(
        buildBetReportPayload({ fromEpochSec, toEpochSec, dateFilterBy }),
        null,
        2,
      ),
    );
    return;
  }

  const webviewProfile =
    values["webview-profile"]?.trim() ??
    (env.GSLIVE_WEBVIEW_PROFILE ?? "").trim();
  const session =
    webviewProfile === ""
      ? await requireManagerSession(env)
      : await sessionFromGsliveProfile({ profileDir: webviewProfile });
  const cookieHeader = session.cookieHeader;
  let sessionGate = sessionGateFromEnv(env);
  if (values["bootstrap-session"] && sessionGate === "") {
    sessionGate = await bootstrapGanchrowSession({ cookieHeader });
  }

  const result = await runBetTally({
    fromEpochSec,
    toEpochSec,
    cookieHeader,
    sessionGate,
    probe,
    timeoutMs: Number(values.timeout) || 15_000,
  });

  console.log(formatTally(result));
  for (const warning of result.warnings) console.log(`\n!! ${warning}`);
  if (result.filterIgnored) {
    console.log("\nfilter ignored: the tally above is NOT a per-state count.");
    console.log("Likely default state:", result.defaultState ?? "(unknown)");
  }
  console.log(
    `\nwindow ${new Date(fromEpochSec * 1000).toISOString()} .. ${new Date(
      toEpochSec * 1000,
    ).toISOString()} (dateFilterBy=${dateFilterBy})`,
  );

  const out = values.out;
  if (out !== "-") {
    await write(out, JSON.stringify(result, null, 2));
    console.log(`wrote ${out}`);
  }
}

if (import.meta.main) {
  try {
    await main(argv.slice(2));
  } catch (error) {
    console.error(
      `bet-tally: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
