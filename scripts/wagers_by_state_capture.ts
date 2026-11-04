#!/usr/bin/env bun
/** Automated live capture of the per-state wager table from `ajax.php`.
 *
 *  One command derives the v2 artifact the plugin reads (`sportsdesk_wagers`), and nothing in
 *  this path can read the offline CSV: the only input is the `getBetReport` response. On top of
 *  the artifact it maintains the automation contract in
 *  `scratch/wagers-automation.schema.v1.json`:
 *
 *    - `scratch/wagers-by-state.history.jsonl` — one line per SUCCESSFUL capture (bounded)
 *    - `scratch/wagers-by-state.tickets.json`  — ticket -> state join key for the next delta
 *    - `scratch/wagers-by-state.alerts.json`   — deterministic, thresholded alerts
 *    - `scratch/wagers-by-state.status.json`   — authoritative attempt journal
 *
 *    GSID=... bun run wagers:capture                        # one capture now
 *    GSID=... bun run wagers:capture --payload scratch/ajax-getBetReport-body.json
 *    GSID=... bun run wagers:watch --cron "0,15,30,45 * * * *"    # initial capture + in-process Bun.cron
 *    bun run wagers:capture --dry-run                       # endpoint + body, no network, no journal
 *    bun run wagers:capture --print-schedule                # next OS-level fire, no session needed
 *    bun run wagers:capture --install-os                    # register an OS job (launchd/crontab)
 *    bun run wagers:capture --uninstall-os                  # remove the registered OS job
 *
 *  Alerts: `--pending-warn-hours` (24), `--spike-pct` (25), `--spike-min` (20),
 *  `--cadence-minutes` (30). `--fail-on-alert` exits 1 after a successful capture when any
 *  warn/critical alert is raised; the artifact and every automation file are still written.
 *
 *  Safety: a failed read never overwrites the last good artifact and never appends history,
 *  rewrites tickets or alerts. Every attempt is appended to the status journal (capped, last
 *  success and last failure), and a run without a provisioned GSID fails before any request.
 *  No file written here carries cookie material or customer identifiers: history/alerts carry
 *  counts, deltas, timestamps and alert text only.
 *
 *  The session comes from the environment (SSOT `.env` mount). A cookie pasted into chat, a
 *  commit or a script is a credential incident: revoke it and provision again.
 */

import { mkdir, rename } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  sessionFromGsliveProfile,
  sessionFromRunningChrome,
} from "../lib/gslive_session.ts";
import {
  createWagersLiveSink,
  resolveWagersGatewayUrl,
  type WagersLiveSink,
  type WagersLiveSinkResult,
} from "../lib/wagers_live_sink.ts";
import {
  alertThresholdsFromConfig,
  DEFAULT_CAPTURE_CRON,
  DEFAULT_KEEP_RUNS,
  DEFAULT_WAGERS_CAPTURE_CONFIG_PATH,
  loadWagersCaptureConfig,
  type WagersCaptureConfig,
} from "../lib/wagers_capture_config.ts";

import {
  formatCronScheduleLine,
  installOsCronJob,
  isBunOsCronInvocation,
  osCronWorkerPath,
  previewCronSchedule,
  removeOsCronJob,
  startInProcessCron,
  type CronSchedulePreview,
} from "../lib/bun_cron.ts";
import {
  AJAX_URL,
  bootstrapGanchrowSession,
  parseBetReportRequest,
  parseDateFilterBy,
  resolveManagerSession,
  type ManagerSession,
  type ManagerSessionSource,
  sessionGateFromEnv,
  type DateFilterBy,
} from "./fetch-bet-tally.ts";
import {
  appendWagersHistory,
  buildTicketStateMap,
  buildWagersAlertsDoc,
  buildWagersHistoryLine,
  captureWagersSnapshot,
  computeWagersDelta,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_WAGERS_ALERT_THRESHOLDS,
  deriveWagersAlerts,
  formatWagerQuality,
  formatWagerTable,
  hasBlockingAlert,
  readWagersArtifactCapturedAt,
  readWagersHistory,
  readWagersTickets,
  recordCaptureRun,
  WAGER_COLUMNS,
  wagersHistoryStates,
  wrapReportLine,
  writeJsonAtomic,
  writeTextAtomic,
  type CaptureRun,
  type WagerReport,
  type WagersAlert,
  type WagersAlertThresholds,
  type WagersHistoryDelta,
  type WagersHistoryLine,
  type WagersTicketsDoc,
} from "./gslive_wagers_by_state.ts";
import {
  Archive,
  CryptoHasher,
  argv,
  env,
  file,
  inspect,
  isStandaloneExecutable,
  nanoseconds,
  randomUUIDv7,
  revision,
  sleep,
  version,
} from "bun";

/** Re-exported so the CLI/tests decide the `--fail-on-alert` exit from the outcome alone. */
export { hasBlockingAlert };

/** OS-level `Bun.cron` job title (launchd/crontab identifier). */
export const WAGERS_CAPTURE_CRON_TITLE = "sportsdesk-wagers-capture";
/** Re-exported for callers that only import this module. */
export { DEFAULT_CAPTURE_CRON };

/** Names whose values never appear in a trace, request or response. */
const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "set-cookie",
  "x-gs-session",
]);
const KNOWN_ROW_FIELDS = new Set<string>(WAGER_COLUMNS);
const MAX_SHAPE_DEPTH = 4;
/** Request-body fields that can carry account/ticket identifiers; values are masked in the trace. */
const SENSITIVE_PAYLOAD_KEYS = new Set([
  "partnerUserId",
  "agent",
  "betId",
  "betGroupId",
  "freeBetId",
  "mId",
  "eventId",
  "sId",
]);

/** Print the payload's full key shape while masking identifier values. */
export function redactPayloadForTrace(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return body;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const isEmpty = value === "" || value === null || value === undefined;
    redacted[key] =
      SENSITIVE_PAYLOAD_KEYS.has(key) && !isEmpty ? "<redacted>" : value;
  }
  return JSON.stringify(redacted);
}

/** Mask only credential values; every other header value is shown in full. */
function maskCredentialHeader(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower) && lower !== "cookie") {
    return "<redacted>";
  }
  if (lower !== "cookie") return value;
  return value
    .split(";")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? part.trim() : `${part.slice(0, eq).trim()}=<redacted>`;
    })
    .join("; ");
}

function describeValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array(0)";
    const first = describeValue(value[0], depth + 1);
    const homogeneous = value.every(
      (entry) => describeValue(entry, depth + 1) === first,
    );
    return `array(${value.length}) of ${homogeneous ? first : "mixed"}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (depth >= MAX_SHAPE_DEPTH) return `{${entries.length} keys}`;
    return `{${entries
      .map(([key, entry]) => `${key}: ${describeValue(entry, depth + 1)}`)
      .join(", ")}}`;
  }
  return typeof value;
}

/** Describe a JSON response by its full nested shape (keys, types, counts), never values. */
export function describeJsonShape(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `unparseable (${text.length} B)`;
  }
  return describeValue(parsed, 0);
}

/** Row-field coverage against the producer's contract, by field names only. */
function describeRowCoverage(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let rows: unknown[] | null = null;
  if (Array.isArray(parsed)) rows = parsed;
  else if (parsed !== null && typeof parsed === "object") {
    const bets = (parsed as Record<string, unknown>).bets;
    if (Array.isArray(bets)) rows = bets;
  }
  if (rows === null) return null;
  const objects = rows.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
  if (objects.length === 0) {
    return `rows ${rows.length}: no object rows to inspect`;
  }
  const present = new Set<string>();
  for (const row of objects) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const unknown = [...present]
    .filter((key) => !KNOWN_ROW_FIELDS.has(key))
    .sort();
  const notPresent = WAGER_COLUMNS.filter((key) => !present.has(key));
  return (
    `rows ${rows.length} (${objects.length} objects): ${present.size} fields; ` +
    `unknown [${unknown.join(", ") || "none"}]; ` +
    `not-present [${notPresent.join(", ") || "none"}]`
  );
}

export type VerboseFetchMode = "curl" | "true";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function parseVerboseFetchMode(value: string): VerboseFetchMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "curl" || normalized === "true") return normalized;
  throw new Error("--verbose-fetch must be 'curl' or 'true'");
}

/**
 * Native `BUN_CONFIG_VERBOSE_FETCH` prints credential header values. It is therefore restricted
 * to a loopback endpoint and requires the operator to acknowledge credential echo explicitly.
 * `--debug-wire` is the safe alternative for real endpoints.
 */
export function assertVerboseFetchAllowed(options: {
  readonly endpoint: string;
  readonly mode: string;
  readonly allowCredentialEcho: boolean;
}): VerboseFetchMode {
  const mode = parseVerboseFetchMode(options.mode);
  let hostname: string;
  try {
    hostname = new URL(options.endpoint).hostname;
  } catch {
    throw new Error(
      `--verbose-fetch needs an absolute endpoint URL, got ${options.endpoint}`,
    );
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      "--verbose-fetch is loopback-only: BUN_CONFIG_VERBOSE_FETCH prints the Cookie value " +
        `verbatim, so ${hostname} is refused. Use --debug-wire for the live manager endpoint.`,
    );
  }
  if (!options.allowCredentialEcho) {
    throw new Error(
      "--verbose-fetch prints credential header values. If this loopback endpoint carries a real " +
        "session, re-run with GSLIVE_ALLOW_CREDENTIAL_ECHO=1 to acknowledge that echo.",
    );
  }
  return mode;
}

export interface WireTraceOptions {
  /** Full response text is written here (gitignored scratch/), never printed. */
  readonly responsePath: string;
  readonly log?: (line: string) => void;
}

/**
 * Debug fetch that prints the complete request/response shape with only `Cookie`/`x-gs-session`
 * values masked. The full response body goes to `responsePath` (gitignored) so row values do not
 * land in the terminal/session log; the console gets the body shape only.
 */
export function createWireTraceFetch(
  options: WireTraceOptions,
): (url: string, init: RequestInit) => Promise<Response> {
  const log = options.log ?? ((line: string) => console.error(line));
  return async (url, init) => {
    const startedAt = nanoseconds();
    const headers = new Headers(init.headers);
    log(`[wire] > ${init.method ?? "GET"} ${url}`);
    for (const [name, value] of headers) {
      log(`[wire] > ${name}: ${maskCredentialHeader(name, value)}`);
    }
    const body = typeof init.body === "string" ? init.body : "";
    if (body !== "") {
      log(`[wire] > payload(${body.length} B): ${redactPayloadForTrace(body)}`);
      try {
        parseBetReportRequest(JSON.parse(body));
        log(`[wire] > payload contract: valid (parser accepted all fields)`);
      } catch (error) {
        log(`[wire] > payload contract: INVALID (${sanitizeError(error)})`);
      }
    }
    const response = await fetch(url, init);
    const elapsedMs = (nanoseconds() - startedAt) / 1e6;
    log(
      `[wire] < HTTP ${response.status} ${response.statusText} in ${elapsedMs.toFixed(1)} ms ` +
        "(local trace timing, not endpoint latency)",
    );
    for (const [name, value] of response.headers) {
      log(`[wire] < ${name}: ${maskCredentialHeader(name, value)}`);
    }
    const text = await response.clone().text();
    await Bun.write(options.responsePath, text);
    const sha = new CryptoHasher("sha256").update(text).digest("hex");
    log(
      `[wire] < body(${text.length} B, sha256 ${sha}) saved to ${options.responsePath}`,
    );
    log(`[wire] < body shape: ${describeJsonShape(text)}`);
    const coverage = describeRowCoverage(text);
    if (coverage !== null) log(`[wire] < row fields: ${coverage}`);
    return response;
  };
}

/** Remove cookie-shaped text from an error before it is journaled. */
export function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/GSID=[^;\s"']+/gi, "GSID=<redacted>")
    .replace(/_ga=[^;\s"']+/gi, "_ga=<redacted>")
    .slice(0, 300);
}

/** History/tickets/alerts live next to the artifact the plugin reads. */
export interface WagersAutomationPaths {
  readonly history: string;
  readonly tickets: string;
  readonly alerts: string;
}

/** Sibling SHA-256 sidecar for the artifact (content integrity; outside the frozen contract). */
export function sha256PathForArtifact(artifactPath: string): string {
  const slash = artifactPath.lastIndexOf("/");
  const dir = slash === -1 ? "." : artifactPath.slice(0, slash);
  return `${dir === "." ? "" : `${dir}/`}wagers-by-state.sha256`;
}

/**
 * Portable capture bundle: artifact, history, alerts, journal and the SHA-256 sidecar in one
 * `Bun.Archive` tar. The ticket-state document (ticket ids) is deliberately excluded.
 */
export async function writeCaptureArchive(
  archivePath: string,
  input: {
    readonly artifactText: string;
    readonly artifactSha256: string;
    readonly historyPath: string;
    readonly alertsPath: string;
    readonly statusPath: string;
    readonly report: Pick<WagerReport, "source" | "totals">;
  },
): Promise<string> {
  const readOptional = async (path: string): Promise<string | null> =>
    (await file(path).exists()) ? await file(path).text() : null;
  const entries: Record<string, string> = {
    "artifact.json": input.artifactText,
    "artifact.sha256": `${input.artifactSha256}\n`,
    "manifest.json": JSON.stringify(
      {
        schemaVersion: 1,
        kind: "wagers-by-state-capture-bundle",
        capturedAt:
          input.report.source.kind === "live-ajax.php"
            ? input.report.source.capturedAt
            : null,
        sourceKind: input.report.source.kind,
        artifactSha256: input.artifactSha256,
        runtime: { bun: version, revision },
        totals: input.report.totals,
        files: {
          artifact: "artifact.json",
          history: "history.jsonl",
          alerts: "alerts.json",
          journal: "status.json",
        },
        excluded: ["wagers-by-state.tickets.json (contains ticket ids)"],
      },
      null,
      2,
    ),
  };
  const [history, alerts, journal] = await Promise.all([
    readOptional(input.historyPath),
    readOptional(input.alertsPath),
    readOptional(input.statusPath),
  ]);
  if (history !== null) entries["history.jsonl"] = history;
  if (alerts !== null) entries["alerts.json"] = alerts;
  if (journal !== null) entries["status.json"] = journal;
  const slash = archivePath.lastIndexOf("/");
  const dir = slash === -1 ? "." : archivePath.slice(0, slash);
  if (dir !== ".") await mkdir(dir, { recursive: true });
  const tmp = `${archivePath}.tmp-${randomUUIDv7()}`;
  await Archive.write(tmp, entries);
  await rename(tmp, archivePath);
  return archivePath;
}

export function automationPathsForArtifact(
  artifactPath: string,
): WagersAutomationPaths {
  const slash = artifactPath.lastIndexOf("/");
  const dir = slash === -1 ? "." : artifactPath.slice(0, slash);
  const prefix = dir === "." ? "" : `${dir}/`;
  return {
    history: `${prefix}wagers-by-state.history.jsonl`,
    tickets: `${prefix}wagers-by-state.tickets.json`,
    alerts: `${prefix}wagers-by-state.alerts.json`,
  };
}

export interface LiveCaptureConfig {
  readonly cookieHeader: string;
  readonly sessionGate?: string;
  readonly payload?: unknown;
  readonly fromEpochSec: number;
  readonly toEpochSec: number;
  readonly dateFilterBy: DateFilterBy;
  readonly timeoutMs?: number;
  readonly ajaxUrl?: string;
  readonly artifactPath: string;
  readonly statusPath: string;
  readonly keepRuns?: number;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Defaults are siblings of `artifactPath`, so a temp artifact keeps the run isolated. */
  readonly historyPath?: string;
  readonly ticketsPath?: string;
  readonly alertsPath?: string;
  readonly keepHistory?: number;
  /** Overrides for the deterministic alert thresholds. */
  readonly alertThresholds?: WagersAlertThresholds;
  /** Extra attempts after a transient failure (5xx/timeout/network). Default 2. */
  readonly retries?: number;
  /** Base backoff between attempts, multiplied by the attempt number. Default 250 ms. */
  readonly retryBackoffMs?: number;
  /** Where the cookie came from; printed in the CLI report, never persisted to the journal. */
  readonly sessionSource?: Exclude<ManagerSessionSource, "none">;
  /** Optional portable tar bundle (artifact + history + alerts + journal; never tickets/secrets). */
  readonly archivePath?: string;
  /** Optional live-bets/R2 sinks; failures are reported, never fatal to the capture. */
  readonly sink?: WagersLiveSink;
}

interface LiveCaptureOutcomeBase {
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Total attempts actually made (1 when the first read succeeded). */
  readonly attempts: number;
  /** Wall time of the whole run, measured with `Bun.nanoseconds()`. */
  readonly durationMs: number;
}

/** A successful capture always has a report and a hash; a failure never has either. */
export interface LiveCaptureSuccess extends LiveCaptureOutcomeBase {
  readonly ok: true;
  readonly report: WagerReport;
  readonly error: null;
  readonly alerts: readonly WagersAlert[];
  readonly alertCodes: readonly string[];
  readonly delta: WagersHistoryDelta | null;
  readonly historyLine: WagersHistoryLine;
  readonly artifactSha256: string;
  readonly archivePath: string | null;
  /** Per-sink outcomes when a live-bets/R2 sink was configured. */
  readonly sinkResults?: readonly WagersLiveSinkResult[];
}

export interface LiveCaptureFailure extends LiveCaptureOutcomeBase {
  readonly ok: false;
  readonly report: null;
  readonly error: string;
  readonly alerts: readonly [];
  readonly alertCodes: readonly [];
  readonly delta: null;
  readonly historyLine: null;
  readonly artifactSha256: null;
  readonly archivePath: null;
}

export type LiveCaptureOutcome = LiveCaptureSuccess | LiveCaptureFailure;

/** Default extra attempts after a transient failure (Bun.sleep backoff between them). */
export const DEFAULT_RETRIES = 2;
/** Default backoff base; the wait is base × attempt. */
export const DEFAULT_RETRY_BACKOFF_MS = 250;

/**
 * A transient failure is worth retrying; an auth/login/contract failure is not. 401/403 and the
 * HTML-login-page detector are deliberately excluded — retrying a bad session only burns calls.
 */
export function isRetryableCaptureError(message: string): boolean {
  return (
    /HTTP 5\d\d/.test(message) ||
    /timed out|timeout/i.test(message) ||
    /fetch failed|ECONN|socket|network/i.test(message)
  );
}

/**
 * One live capture: read `ajax.php`, derive the v2 report, write the artifact, then the ticket
 * join key, the alerts document and one history line, and journal the run.
 *
 * Capture failure is returned, not thrown, so the CLI and the cron can decide independently; on
 * failure no artifact, tickets, alerts or history byte is written. Transient failures are retried
 * with a bounded `Bun.sleep` backoff; each failed attempt is journaled honestly.
 */
export async function runLiveCapture(
  config: LiveCaptureConfig,
): Promise<LiveCaptureOutcome> {
  const startedAt = new Date().toISOString();
  const startedNanos = nanoseconds();
  const durationMs = (): number =>
    Math.max(0, Math.round((nanoseconds() - startedNanos) / 1e6));
  const ajaxUrl = config.ajaxUrl ?? AJAX_URL;
  const paths: WagersAutomationPaths = {
    history:
      config.historyPath ??
      automationPathsForArtifact(config.artifactPath).history,
    tickets:
      config.ticketsPath ??
      automationPathsForArtifact(config.artifactPath).tickets,
    alerts:
      config.alertsPath ??
      automationPathsForArtifact(config.artifactPath).alerts,
  };

  const journal = async (
    ok: boolean,
    report: WagerReport | null,
    error: string | null,
    alertCodes?: readonly string[],
  ): Promise<void> => {
    const run: CaptureRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      ok,
      sourceKind: "live-ajax.php",
      ajaxUrl,
      fromEpochSec: config.fromEpochSec,
      toEpochSec: config.toEpochSec,
      dateFilterBy: config.dateFilterBy,
      legs: report?.totals.legs ?? null,
      wagers: report?.totals.wagers ?? null,
      states: report?.states.length ?? null,
      error,
      ...(alertCodes === undefined ? {} : { alertCodes }),
    };
    try {
      await recordCaptureRun(
        config.statusPath,
        run,
        config.keepRuns ?? DEFAULT_KEEP_RUNS,
      );
    } catch {
      // A journal write failure must not mask the capture result.
    }
  };

  const failure = async (
    error: string,
    attempts: number,
  ): Promise<LiveCaptureOutcome> => {
    await journal(false, null, error);
    return {
      ok: false,
      report: null,
      error,
      startedAt,
      finishedAt: new Date().toISOString(),
      alerts: [],
      alertCodes: [],
      delta: null,
      historyLine: null,
      attempts,
      durationMs: durationMs(),
      artifactSha256: null,
      archivePath: null,
    };
  };

  if (config.cookieHeader === "") {
    return failure(
      "No manager session: provision GSID in the OS keychain " +
        "(`bun run secrets:gslive set`) or through the SSOT environment. ajax.php was not called.",
      1,
    );
  }

  const maxAttempts = 1 + Math.max(0, config.retries ?? DEFAULT_RETRIES);
  const backoffMs = Math.max(
    0,
    config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
  );
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const snapshot = await captureWagersSnapshot({
        cookieHeader: config.cookieHeader,
        fromEpochSec: config.fromEpochSec,
        toEpochSec: config.toEpochSec,
        dateFilterBy: config.dateFilterBy,
        ...(config.sessionGate === undefined
          ? {}
          : { sessionGate: config.sessionGate }),
        ...(config.payload === undefined ? {} : { payload: config.payload }),
        ...(config.timeoutMs === undefined
          ? {}
          : { timeoutMs: config.timeoutMs }),
        ...(config.ajaxUrl === undefined ? {} : { ajaxUrl: config.ajaxUrl }),
        ...(config.fetchImpl === undefined
          ? {}
          : { fetchImpl: config.fetchImpl }),
      });
      const report = snapshot.report;
      const thresholds =
        config.alertThresholds ?? DEFAULT_WAGERS_ALERT_THRESHOLDS;
      const capturedAt =
        report.source.kind === "live-ajax.php"
          ? report.source.capturedAt
          : new Date().toISOString();

      // Every read below happens BEFORE the artifact is replaced, so stale detection and the
      // delta describe the previous capture, not the one being written.
      const previousArtifactCapturedAt = await readWagersArtifactCapturedAt(
        config.artifactPath,
      );
      const previousTickets = await readWagersTickets(paths.tickets);
      const previousHistoryRead = await readWagersHistory(1, paths.history);
      const previousHistory = previousHistoryRead.lines.at(-1) ?? null;

      const tickets = buildTicketStateMap(snapshot.legs);
      const delta =
        previousTickets.doc === null
          ? null
          : computeWagersDelta({
              previousTickets: previousTickets.doc.tickets,
              previousCapturedAt: previousTickets.doc.capturedAt,
              previousStates: previousHistory?.states ?? [],
              currentTickets: tickets,
              currentStates: wagersHistoryStates(report.states),
              toCapturedAt: capturedAt,
            });
      const alerts = deriveWagersAlerts({
        report,
        thresholds,
        delta,
        previousHistory,
        previousTickets,
        previousArtifactCapturedAt,
      });
      const historyLine = buildWagersHistoryLine({ report, delta, alerts });
      const alertsDoc = buildWagersAlertsDoc({ report, alerts });
      const ticketsDoc: WagersTicketsDoc = {
        schemaVersion: 1,
        capturedAt,
        tickets,
      };

      const artifactText = JSON.stringify(report, null, 2);
      const artifactSha256 = new CryptoHasher("sha256")
        .update(artifactText)
        .digest("hex");
      await writeTextAtomic(config.artifactPath, artifactText);
      await writeTextAtomic(
        sha256PathForArtifact(config.artifactPath),
        `${artifactSha256}\n`,
      );
      await writeJsonAtomic(paths.tickets, ticketsDoc);
      await writeJsonAtomic(paths.alerts, alertsDoc);
      await appendWagersHistory(
        paths.history,
        historyLine,
        config.keepHistory ?? DEFAULT_KEEP_HISTORY,
      );
      const alertCodes = alerts.map((alert) => alert.code);
      await journal(true, report, null, alertCodes);
      const archivePath =
        config.archivePath === undefined
          ? null
          : await writeCaptureArchive(config.archivePath, {
              artifactText,
              artifactSha256,
              historyPath: paths.history,
              alertsPath: paths.alerts,
              statusPath: config.statusPath,
              report,
            });

      let sinkResults: readonly WagersLiveSinkResult[] | undefined;
      if (config.sink !== undefined) {
        const sinkOutcome = { historyLine, artifactSha256 };
        try {
          sinkResults = await Promise.all([
            config.sink.publishLiveBets(sinkOutcome),
            config.sink.publishR2(sinkOutcome),
          ]);
          for (const result of sinkResults) {
            if (!result.ok) {
              console.error(`wagers:publish: ${result.error ?? "sink failed"}`);
            }
          }
        } catch (error) {
          console.error(`wagers:publish: ${sanitizeError(error)}`);
          sinkResults = [{ ok: false, error: sanitizeError(error) }];
        }
      }

      return {
        ok: true,
        report,
        error: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        alerts,
        alertCodes,
        delta,
        historyLine,
        attempts: attempt,
        durationMs: durationMs(),
        artifactSha256,
        archivePath,
        ...(sinkResults === undefined ? {} : { sinkResults }),
      };
    } catch (error) {
      lastError = sanitizeError(error);
      await journal(false, null, lastError);
      if (attempt >= maxAttempts || !isRetryableCaptureError(lastError)) {
        return {
          ok: false,
          report: null,
          error: lastError,
          startedAt,
          finishedAt: new Date().toISOString(),
          alerts: [],
          alertCodes: [],
          delta: null,
          historyLine: null,
          attempts: attempt,
          durationMs: durationMs(),
          artifactSha256: null,
          archivePath: null,
        };
      }
      await sleep(backoffMs * attempt);
    }
  }
  return {
    ok: false,
    report: null,
    error: lastError || "capture failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    alerts: [],
    alertCodes: [],
    delta: null,
    historyLine: null,
    attempts: maxAttempts,
    durationMs: durationMs(),
    artifactSha256: null,
    archivePath: null,
  };
}

function severityCounts(alerts: readonly WagersAlert[]): {
  readonly critical: number;
  readonly warn: number;
  readonly info: number;
} {
  let critical = 0;
  let warn = 0;
  let info = 0;
  for (const alert of alerts) {
    if (alert.severity === "critical") critical += 1;
    else if (alert.severity === "warn") warn += 1;
    else info += 1;
  }
  return { critical, warn, info };
}

function formatAlertLine(alerts: readonly WagersAlert[]): string {
  if (alerts.length === 0) return "alerts: none";
  const counts = severityCounts(alerts);
  return (
    `alerts: ${alerts.length} (critical ${counts.critical}, warn ${counts.warn}, ` +
    `info ${counts.info}) ${alerts.map((alert) => alert.code).join(", ")}`
  );
}

/** Print a line through the shared terminal-width wrapper (COLUMNS-aware, token-safe). */
function logWrapped(text: string, role: "prose" | "token" = "prose"): void {
  for (const line of wrapReportLine(text, role)) console.log(line);
}

function reportOutcome(outcome: LiveCaptureOutcome): void {
  if (outcome.ok) {
    console.log(formatWagerTable(outcome.report));
    console.log(`\n${formatWagerQuality(outcome.report)}`);
    console.log("");
    const source = outcome.report.source;
    const endpoint = source.kind === "live-ajax.php" ? source.url : AJAX_URL;
    logWrapped(
      `derived from POST ${endpoint} (getBetReport, state:"")`,
      "token",
    );
    logWrapped(formatAlertLine(outcome.alerts));
    for (const result of outcome.sinkResults ?? []) {
      if (result.ok && result.skipped !== true) {
        console.log(
          `publish: ok${result.url === undefined ? "" : ` ${result.url}`}`,
        );
      } else if (!result.ok) {
        console.error(`publish: ${result.error ?? "failed"}`);
      }
    }
    if (outcome.delta === null) {
      console.log("tickets: baseline capture (delta null)");
    } else {
      console.log(
        `tickets: new ${outcome.delta.newTickets}, gone ${outcome.delta.goneTickets}, ` +
          `migrations ${outcome.delta.migrations.length}, ` +
          `since ${outcome.delta.fromCapturedAt}`,
      );
    }
  } else {
    console.error(`wagers:capture failed: ${outcome.error}`);
  }
}

/** Everything `--print-schedule` / `--install-os` prints, built without side effects. */
export interface WagersOsSchedulePlan {
  readonly title: string;
  readonly schedule: string;
  readonly nextFireIso: string;
  readonly workerPath: string;
  readonly installCommand: string;
  readonly uninstallCommand: string;
}

/**
 * Validate the cron expression and describe the OS-level job. Pure: it never registers anything,
 * so tests can exercise it without touching launchd/crontab.
 */
export function buildWagersOsSchedulePlan(
  schedule: string,
  workerImportMetaUrl: string = import.meta.url,
  standalone: boolean = isStandaloneExecutable,
): WagersOsSchedulePlan {
  if (standalone) {
    throw new Error(
      "OS scheduling needs a source checkout: a standalone Bun executable has no worker file " +
        "path for launchd/crontab to invoke",
    );
  }
  const preview: CronSchedulePreview = previewCronSchedule(schedule);
  return {
    title: WAGERS_CAPTURE_CRON_TITLE,
    schedule,
    nextFireIso: preview.next.toISOString(),
    workerPath: osCronWorkerPath(workerImportMetaUrl),
    installCommand: `bun run wagers:capture --install-os --cron ${JSON.stringify(schedule)}`,
    uninstallCommand: "bun run wagers:capture --uninstall-os",
  };
}

function numberFlag(
  value: string | undefined,
  fallback: number,
  flag: string,
  options?: {
    readonly integer?: boolean;
    readonly minimum?: number;
    readonly maximum?: number;
  },
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  const minimum = options?.minimum ?? 0;
  const maximum = options?.maximum ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${flag} must be a number between ${minimum} and ${
        Number.isFinite(maximum) ? maximum : "infinity"
      }`,
    );
  }
  if (options?.integer && !Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

/**
 * Build the optional live-bets/R2 sink from config plus CLI overrides. Disabled sinks
 * produce no client at all, so a dry-run and a default capture never touch the network.
 */
function buildWagersLiveSink(
  config: WagersCaptureConfig,
  env: typeof Bun.env,
  overrides: {
    readonly liveBets?: boolean;
    readonly r2?: boolean;
    readonly gatewayUrl?: string;
    readonly channel?: string;
  } = {},
): WagersLiveSink | undefined {
  const liveBets = overrides.liveBets === true || config.publish.liveBets;
  const r2 = overrides.r2 === true || config.publish.r2;
  if (!liveBets && !r2) return undefined;
  const gatewayUrl =
    overrides.gatewayUrl?.trim() ||
    config.publish.gatewayUrl.trim() ||
    resolveWagersGatewayUrl(env);
  const channel = overrides.channel?.trim() || config.publish.channel;
  return createWagersLiveSink({
    liveBets,
    r2,
    gatewayUrl,
    channel,
    apiToken: env.BLOB_API_TOKEN ?? "",
  });
}

/** One capture with the default window/paths — the OS-level `scheduled()` worker body. */
async function runScheduledCapture(
  controller: Bun.CronController,
): Promise<void> {
  const { config } = await loadWagersCaptureConfig();
  const paths = automationPathsForArtifact(config.paths.artifact);
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionGate = sessionGateFromEnv(env);
  const profileDir = (
    env.GSLIVE_WEBVIEW_PROFILE ?? config.session.webviewProfile
  ).trim();
  const session =
    profileDir === ""
      ? await resolveManagerSession(env)
      : await sessionFromGsliveProfile({ profileDir });
  const sink = buildWagersLiveSink(config, env);
  const outcome = await runLiveCapture({
    cookieHeader: session.cookieHeader,
    ...(session.source === "none" ? {} : { sessionSource: session.source }),
    ...(sessionGate === "" ? {} : { sessionGate }),
    fromEpochSec: nowSec - config.capture.lookbackDays * 86_400,
    toEpochSec: nowSec,
    dateFilterBy: config.capture.dateFilterBy,
    artifactPath: config.paths.artifact,
    statusPath: config.paths.status,
    historyPath: config.paths.history ?? paths.history,
    ticketsPath: config.paths.tickets ?? paths.tickets,
    alertsPath: config.paths.alerts ?? paths.alerts,
    keepRuns: config.capture.keepRuns,
    keepHistory: config.capture.keepHistory,
    timeoutMs: config.capture.timeoutMs,
    retries: config.capture.retries,
    retryBackoffMs: config.capture.retryBackoffMs,
    alertThresholds: alertThresholdsFromConfig(config),
    ...(sink === undefined ? {} : { sink }),
  });
  console.log(
    JSON.stringify({
      signal: "WAGERS_CAPTURE_OS_FIRE",
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      ok: outcome.ok,
      auth: session.source,
      attempts: outcome.attempts,
      durationMs: outcome.durationMs,
      alertCodes: outcome.alertCodes,
    }),
  );
  if (!outcome.ok) {
    throw new Error(`wagers:capture scheduled run failed: ${outcome.error}`);
  }
}

/**
 * OS-level worker entry: `Bun.cron(path, schedule, title)` imports this module and calls
 * `scheduled()` exactly once per fire. It performs one capture, never arms another schedule.
 */
export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    await runScheduledCapture(controller);
  },
};

async function main(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      once: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      cron: { type: "string" },
      payload: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "date-filter-by": { type: "string" },
      timeout: { type: "string" },
      out: { type: "string" },
      status: { type: "string" },
      "keep-runs": { type: "string" },
      history: { type: "string" },
      tickets: { type: "string" },
      alerts: { type: "string" },
      "keep-history": { type: "string" },
      "pending-warn-hours": { type: "string" },
      "spike-pct": { type: "string" },
      "spike-min": { type: "string" },
      "cadence-minutes": { type: "string" },
      "fail-on-alert": { type: "boolean", default: false },
      "print-schedule": { type: "boolean", default: false },
      "install-os": { type: "boolean", default: false },
      "uninstall-os": { type: "boolean", default: false },
      "ajax-url": { type: "string" },
      "bootstrap-session": { type: "boolean", default: false },
      "webview-profile": { type: "string" },
      "attach-chrome": { type: "boolean", default: false },
      "debug-wire": { type: "boolean", default: false },
      "verbose-fetch": { type: "string" },
      archive: { type: "string" },
      debug: { type: "boolean", default: false },
      retries: { type: "string" },
      "retry-backoff-ms": { type: "string" },
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "publish-live-bets": { type: "boolean", default: false },
      "publish-r2": { type: "boolean", default: false },
      "publish-gateway": { type: "string" },
      "publish-channel": { type: "string" },
    },
  });

  const loadedConfig = await loadWagersCaptureConfig(
    values.config?.trim() || DEFAULT_WAGERS_CAPTURE_CONFIG_PATH,
    { required: values.config !== undefined },
  );
  const cfg = loadedConfig.config;
  const publishLiveBets = values["publish-live-bets"] || cfg.publish.liveBets;
  const publishR2 = values["publish-r2"] || cfg.publish.r2;
  const sink = buildWagersLiveSink(cfg, env, {
    ...(publishLiveBets ? { liveBets: true } : {}),
    ...(publishR2 ? { r2: true } : {}),
    ...(values["publish-gateway"]?.trim()
      ? { gatewayUrl: values["publish-gateway"].trim() }
      : {}),
    ...(values["publish-channel"]?.trim()
      ? { channel: values["publish-channel"].trim() }
      : {}),
  });
  const cron = values.cron ?? cfg.capture.cron;
  const artifactPath = values.out?.trim() || cfg.paths.artifact;
  const statusPath = values.status?.trim() || cfg.paths.status;
  const paths = automationPathsForArtifact(artifactPath);
  const historyPath =
    values.history?.trim() || cfg.paths.history || paths.history;
  const ticketsPath =
    values.tickets?.trim() || cfg.paths.tickets || paths.tickets;
  const alertsPath = values.alerts?.trim() || cfg.paths.alerts || paths.alerts;
  const keepHistory = numberFlag(
    values["keep-history"],
    cfg.capture.keepHistory,
    "--keep-history",
    { integer: true, minimum: 1 },
  );
  const configuredAlerts = alertThresholdsFromConfig(cfg);
  const alertThresholds: WagersAlertThresholds = {
    pendingWarnHours: numberFlag(
      values["pending-warn-hours"],
      configuredAlerts.pendingWarnHours,
      "--pending-warn-hours",
    ),
    spikePct: numberFlag(
      values["spike-pct"],
      configuredAlerts.spikePct,
      "--spike-pct",
    ),
    spikeMin: numberFlag(
      values["spike-min"],
      configuredAlerts.spikeMin,
      "--spike-min",
    ),
    cadenceMinutes: numberFlag(
      values["cadence-minutes"],
      configuredAlerts.cadenceMinutes,
      "--cadence-minutes",
      { minimum: 1 },
    ),
    ...(configuredAlerts.churnPct === undefined
      ? {}
      : { churnPct: configuredAlerts.churnPct }),
    ...(configuredAlerts.churnMin === undefined
      ? {}
      : { churnMin: configuredAlerts.churnMin }),
  };
  const failOnAlert = values["fail-on-alert"];

  const archivePath = values.archive?.trim() || cfg.paths.archive || undefined;
  const webviewProfile =
    values["webview-profile"]?.trim() ||
    (env.GSLIVE_WEBVIEW_PROFILE ?? "").trim() ||
    cfg.session.webviewProfile;
  const resolveSession = async (): Promise<ManagerSession> => {
    if (values["attach-chrome"]) return sessionFromRunningChrome();
    if (webviewProfile === "") return resolveManagerSession(env);
    const session = await sessionFromGsliveProfile({
      profileDir: webviewProfile,
    });
    return { cookieHeader: session.cookieHeader, source: session.source };
  };

  // ---- OS-level scheduling: validate/describe only; installation is an explicit flag. ----
  if (values["print-schedule"]) {
    const plan = buildWagersOsSchedulePlan(cron);
    const preview = previewCronSchedule(cron);
    console.log(formatCronScheduleLine(preview));
    console.log(`OS job: ${plan.title}`);
    console.log(`worker: ${plan.workerPath}`);
    console.log(`install:   ${plan.installCommand}`);
    console.log(`uninstall: ${plan.uninstallCommand}`);
    return;
  }
  if (values["uninstall-os"]) {
    await removeOsCronJob(WAGERS_CAPTURE_CRON_TITLE);
    console.log(`removed OS-level job "${WAGERS_CAPTURE_CRON_TITLE}"`);
    return;
  }
  if (values["install-os"]) {
    if (values["attach-chrome"]) {
      throw new Error(
        "--attach-chrome is a supervised run only: an OS-fired job has no browser to attach to. " +
          "Provision GSID in the keychain or a WebView profile before --install-os.",
      );
    }
    // Fail closed before touching launchd/crontab: an OS fire has no interactive session, so a
    // job installed without a provisioned GSID could only ever journal failures.
    buildWagersOsSchedulePlan(cron);
    if ((await resolveSession()).source === "none") {
      throw new Error(
        "No manager session; refusing to install the OS-level schedule. Provision GSID in " +
          "the OS keychain (`bun run secrets:gslive set`) or the SSOT environment, then " +
          "run --install-os again.",
      );
    }
    await installOsCronJob({
      workerImportMetaUrl: import.meta.url,
      schedule: cron,
      title: WAGERS_CAPTURE_CRON_TITLE,
    });
    console.log(
      `installed OS-level job "${WAGERS_CAPTURE_CRON_TITLE}" · ` +
        formatCronScheduleLine(previewCronSchedule(cron)),
    );
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const payloadPath = values.payload?.trim() ?? "";
  const suppliedPayload =
    payloadPath === ""
      ? undefined
      : parseBetReportRequest(await file(payloadPath).json());
  const fromEpochSec =
    suppliedPayload?.from ??
    (values.from === undefined
      ? nowSec - cfg.capture.lookbackDays * 86_400
      : Number(values.from));
  const toEpochSec =
    suppliedPayload?.to ??
    (values.to === undefined ? nowSec : Number(values.to));
  const dateFilterBy =
    suppliedPayload?.dateFilterBy ??
    parseDateFilterBy(values["date-filter-by"] ?? cfg.capture.dateFilterBy);
  if (!Number.isFinite(fromEpochSec) || !Number.isFinite(toEpochSec)) {
    throw new Error("--from and --to must be epoch seconds");
  }
  if (fromEpochSec > toEpochSec) throw new Error("--from must be <= --to");

  const ajaxUrl = values["ajax-url"]?.trim() ?? "";
  const verboseFetch =
    values["verbose-fetch"] === undefined
      ? null
      : assertVerboseFetchAllowed({
          endpoint: ajaxUrl || AJAX_URL,
          mode: values["verbose-fetch"],
          allowCredentialEcho: env.GSLIVE_ALLOW_CREDENTIAL_ECHO === "1",
        });
  if (verboseFetch !== null) {
    if (values.watch || values["install-os"]) {
      throw new Error(
        "--verbose-fetch is a supervised one-shot trace; it is refused for --watch and --install-os",
      );
    }
    Bun.env.BUN_CONFIG_VERBOSE_FETCH = verboseFetch;
    console.error(
      `wagers:capture: native verbose fetch (${verboseFetch}) enabled for a loopback endpoint; ` +
        "credential header values will be printed",
    );
  }
  const retries = numberFlag(values.retries, cfg.capture.retries, "--retries", {
    integer: true,
    minimum: 0,
    maximum: 10,
  });
  const retryBackoffMs = numberFlag(
    values["retry-backoff-ms"],
    cfg.capture.retryBackoffMs,
    "--retry-backoff-ms",
    { minimum: 0, maximum: 60_000 },
  );
  const timeoutMs = numberFlag(
    values.timeout,
    cfg.capture.timeoutMs,
    "--timeout",
    { integer: true, minimum: 1 },
  );
  const keepRuns = numberFlag(
    values["keep-runs"],
    cfg.capture.keepRuns,
    "--keep-runs",
    {
      integer: true,
      minimum: 1,
    },
  );
  const watch = values.watch;
  if (watch && values["attach-chrome"]) {
    throw new Error(
      "--attach-chrome is one-shot: --watch has no browser tab to attach to between frames. " +
        "Use a WebView profile or the keychain for watch mode.",
    );
  }
  if (values["debug-wire"] && (watch || values["install-os"])) {
    throw new Error(
      "--debug-wire is a one-shot, supervised trace; it is refused for --watch and --install-os",
    );
  }
  const wireTrace = values["debug-wire"]
    ? createWireTraceFetch({
        // Per-invocation path: a second run must not overwrite the first run's evidence.
        // Use the whole UUID: the v7 *prefix* is time-ordered and can repeat within a bucket.
        responsePath: `scratch/wagers-wire-response-${randomUUIDv7()}.json`,
      })
    : undefined;
  if (values["dry-run"]) {
    console.error(
      JSON.stringify(
        {
          endpoint: ajaxUrl || AJAX_URL,
          method: "POST",
          config: loadedConfig.source ?? "(built-in defaults)",
          artifactPath,
          statusPath,
          ...(archivePath === undefined ? {} : { archivePath }),
          historyPath,
          ticketsPath,
          alertsPath,
          keepHistory,
          alertThresholds,
          retries,
          retryBackoffMs,
          failOnAlert,
          publish: {
            liveBets: publishLiveBets,
            r2: publishR2,
          },
          debugWire: values["debug-wire"],
          verboseFetch: verboseFetch ?? false,
          session: values["attach-chrome"]
            ? "running Chrome (attach)"
            : webviewProfile === ""
              ? "keychain then GSID env"
              : `webview profile ${webviewProfile}`,
          source: suppliedPayload === undefined ? "generated" : payloadPath,
          body: suppliedPayload ?? {
            action: "getBetReport",
            state: "",
            from: fromEpochSec,
            to: toEpochSec,
            fromTime: 0,
            toTime: 86399,
            dateFilterBy,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (watch) {
    const preview = previewCronSchedule(cron);
    const session = await resolveSession();
    if (session.source === "none") {
      const outcome = await runLiveCapture({
        cookieHeader: "",
        fromEpochSec,
        toEpochSec,
        dateFilterBy,
        artifactPath,
        statusPath,
        keepRuns,
        historyPath,
        ticketsPath,
        alertsPath,
        keepHistory,
        alertThresholds,
      });
      reportOutcome(outcome);
      throw new Error("no session: refusing to arm the schedule");
    }
    const cookieHeader = session.cookieHeader;
    let sessionGate = sessionGateFromEnv(env);
    if (values["bootstrap-session"] && sessionGate === "") {
      sessionGate = await bootstrapGanchrowSession({ cookieHeader });
      console.log(
        "bootstrapped x-gs-session from POST /api/v3/manager-tools/signin/",
      );
    }
    const base = {
      cookieHeader,
      sessionSource: session.source,
      sessionGate,
      dateFilterBy,
      artifactPath,
      statusPath,
      keepRuns,
      timeoutMs,
      historyPath,
      ticketsPath,
      alertsPath,
      keepHistory,
      alertThresholds,
      ...(sink === undefined ? {} : { sink }),
      ...(suppliedPayload === undefined ? {} : { payload: suppliedPayload }),
      ...(ajaxUrl === "" ? {} : { ajaxUrl }),
    } as const;

    const attempt = async (): Promise<void> => {
      const outcome = await runLiveCapture({
        ...base,
        fromEpochSec,
        toEpochSec,
      });
      if (outcome.ok) {
        console.log(
          `capture ok at ${outcome.finishedAt}: ${outcome.report?.totals.legs ?? 0} legs, ` +
            `${outcome.report?.totals.wagers ?? 0} wagers -> ${artifactPath} ` +
            `(${outcome.durationMs} ms, attempts ${outcome.attempts}, auth ${session.source}, ` +
            `sha256 ${outcome.artifactSha256 ?? "n/a"}); ` +
            formatAlertLine(outcome.alerts),
        );
      } else {
        console.error(
          `capture failed at ${outcome.finishedAt}: ${outcome.error}`,
        );
      }
    };

    await attempt();
    const job = startInProcessCron(cron, attempt);
    logWrapped(
      `wagers:watch armed ${job.cron} (next ${preview.next.toISOString()}); artifact ${artifactPath}; ` +
        `journal ${statusPath}; auth ${session.source}`,
    );
    await new Promise(() => {});
    return;
  }

  const session = await resolveSession();
  if (session.source === "none") {
    const outcome = await runLiveCapture({
      cookieHeader: "",
      fromEpochSec,
      toEpochSec,
      dateFilterBy,
      artifactPath,
      statusPath,
      keepRuns,
      historyPath,
      ticketsPath,
      alertsPath,
      keepHistory,
      alertThresholds,
      ...(sink === undefined ? {} : { sink }),
    });
    reportOutcome(outcome);
    process.exitCode = 1;
    return;
  }
  const cookieHeader = session.cookieHeader;
  let sessionGate = sessionGateFromEnv(env);
  if (values["bootstrap-session"] && sessionGate === "") {
    sessionGate = await bootstrapGanchrowSession({ cookieHeader });
  }
  const outcome = await runLiveCapture({
    cookieHeader,
    sessionSource: session.source,
    sessionGate,
    dateFilterBy,
    fromEpochSec,
    toEpochSec,
    artifactPath,
    statusPath,
    keepRuns,
    timeoutMs,
    historyPath,
    ticketsPath,
    alertsPath,
    keepHistory,
    alertThresholds,
    ...(sink === undefined ? {} : { sink }),
    retries,
    retryBackoffMs,
    ...(archivePath === undefined ? {} : { archivePath }),
    ...(suppliedPayload === undefined ? {} : { payload: suppliedPayload }),
    ...(ajaxUrl === "" ? {} : { ajaxUrl }),
    ...(wireTrace === undefined ? {} : { fetchImpl: wireTrace }),
  });
  reportOutcome(outcome);
  if (outcome.ok) {
    console.log("");
    logWrapped(
      `wrote ${artifactPath} (source live-ajax.php; auth ${session.source}; ` +
        `${outcome.durationMs} ms, attempts ${outcome.attempts}; ` +
        `sha256 ${outcome.artifactSha256 ?? "n/a"}); journal ${statusPath}; ` +
        `history ${historyPath}` +
        (outcome.archivePath === null
          ? ""
          : `; archive ${outcome.archivePath}`),
    );
    if (failOnAlert && hasBlockingAlert(outcome.alerts)) {
      console.error(
        `wagers:capture: alert(s) raised and --fail-on-alert is set ` +
          `(${outcome.alerts.filter((alert) => alert.severity !== "info").length} blocking); ` +
          "the artifact and automation files were still written.",
      );
      process.exitCode = 1;
    }
    return;
  }
  process.exitCode = 1;
}

if (import.meta.main && !isBunOsCronInvocation(argv)) {
  try {
    await main(argv.slice(2));
  } catch (error) {
    // Bun.inspect exposes the cause chain (WebView/CDP failures carry one) only on request.
    console.error(
      argv.includes("--debug")
        ? inspect(error, { depth: 4, colors: false })
        : `wagers:capture: ${sanitizeError(error)}`,
    );
    process.exitCode = 2;
  }
}
