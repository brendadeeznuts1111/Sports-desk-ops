/**
 * @file lib/health_cli.ts
 * @description Structured `/health` (`schemaVersion: 1`) and `/status` CLI prober and formatter.
 *
 * Shared by `./bin/dx health`, `scripts/health_check.ts` (`bun run health`),
 * `cli/sportsdesk_cli.ts health`, and the in-dashboard Terminal PTY (`health` / `status`).
 */

import type {
  CompanionDaemonDegradedReason,
  CompanionDaemonHealthSnapshot,
  HealthStatus,
  NormalizedAlertMetrics,
} from "../packages/backend/src/health.ts";

export interface HealthCliFlags {
  readonly port: number;
  readonly url: string | null;
  readonly daemonUrl: string;
  readonly status: boolean;
  readonly alerts: boolean;
  readonly schedules: boolean;
  readonly daemonOnly: boolean;
  readonly dashboardOnly: boolean;
  readonly strict: boolean;
  readonly noDriftFail: boolean;
  readonly timeoutMs: number;
  readonly watch: boolean;
  readonly intervalSec: number;
  readonly json: boolean;
  readonly noColor: boolean;
  readonly help: boolean;
  readonly hasExplicitDashboardTarget: boolean;
  readonly hasExplicitDaemonTarget: boolean;
}

export type HealthCliParseResult =
  | { readonly ok: true; readonly flags: HealthCliFlags }
  | { readonly ok: false; readonly error: string };

export interface ParsedStructuredHealth {
  readonly schemaVersion: number | null;
  readonly status: HealthStatus;
  readonly service: string | null;
  readonly timestamp: string | null;
  readonly build: {
    readonly bunVersion: string | null;
    readonly expectedBunVersion: string | null;
    readonly bunVersionDrift: boolean;
  } | null;
  readonly runtime: {
    readonly uptimeSeconds: number | null;
    readonly rssBytes: number | null;
    readonly heapUsedBytes: number | null;
  } | null;
  readonly server: {
    readonly port: number | null;
    readonly pendingRequests: number | null;
    readonly pendingWebSockets: number | null;
    readonly wsBackpressureBytes: number | null;
  } | null;
  readonly dependencies: {
    readonly dbStatus: string | null;
    readonly r2Status: string | null;
    readonly r2LastSnapshotAgeMs: number | null;
  } | null;
  readonly sessions: {
    readonly active: number | null;
    readonly purged: number | null;
  } | null;
  readonly alerts: NormalizedAlertMetrics | null;
  readonly daemon4020: CompanionDaemonHealthSnapshot | null;
}

export interface HealthTargetProbe {
  readonly name: string;
  readonly target: "dashboard" | "daemon";
  readonly url: string;
  readonly port: number;
  readonly ok: boolean;
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly statusLabel: string;
  readonly latencyMs: number;
  readonly healthStatus: HealthStatus;
  readonly structured: ParsedStructuredHealth | null;
  readonly rawPayload: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface ScheduleRowSummary {
  readonly id: string;
  readonly name: string;
  readonly scheduleTime: string;
  readonly tz: string | null;
  readonly reportType: string;
  readonly enabled: boolean;
}

export interface StatusSummaryProbe {
  readonly ok: boolean;
  readonly url: string;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly error: string | null;
  readonly status: string | null;
  readonly live: {
    readonly tickerStatus: string | null;
    readonly pendingStatus: string | null;
    readonly refreshTicks: number | null;
    readonly lastTickOk: boolean | null;
  } | null;
  readonly telegramMode: string | null;
  readonly telegramModeReason: string | null;
  readonly schedules: readonly ScheduleRowSummary[];
}

export interface SportsDeskHealthReport {
  readonly timestamp: string;
  readonly dashboardUrl: string;
  readonly daemonUrl: string;
  readonly overallStatus: HealthStatus;
  readonly bunVersionDrift: boolean;
  readonly allHealthy: boolean;
  readonly strict: boolean;
  readonly noDriftFail: boolean;
  readonly exitCode: 0 | 1;
  readonly dashboard: HealthTargetProbe | null;
  readonly daemon: HealthTargetProbe | null;
  readonly statusProbe: StatusSummaryProbe | null;
}

export interface ProbeSportsDeskHealthOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly localHealthPayload?: Record<string, unknown> | null | undefined;
  readonly localStatusPayload?: Record<string, unknown> | null | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface HealthCliIo {
  readonly stdout?: ((text: string) => void) | undefined;
  readonly stderr?: ((text: string) => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly localHealthPayload?:
    | (() =>
        | Promise<Record<string, unknown> | null>
        | Record<string, unknown>
        | null)
    | undefined;
  readonly localStatusPayload?:
    | (() =>
        | Promise<Record<string, unknown> | null>
        | Record<string, unknown>
        | null)
    | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_DASHBOARD_PORT = 4022;
const DEFAULT_DAEMON_ORIGIN = "http://127.0.0.1:4020";

export function healthHelpText(): string {
  return `SportsDesk Health & Status Diagnostics (schemaVersion: 1)

Usage:
  ./bin/dx health [options]
  bun run health [options]
  bun run cli health [options]

Options:
  -p, --port <N>          Dashboard port to probe (default: PORT env or 4022)
  --url <ORIGIN>          Dashboard origin URL (http/https), overrides --port
  --daemon-url <ORIGIN>   Companion API daemon origin URL (default: SPORTSDESK_API_ORIGIN or http://127.0.0.1:4020)
  --status                Also probe /api/status (or /status.json with --daemon-only)
  --alerts                Show expanded alert queue, backlog, dead-letter & latency fields
  --schedules             Include scheduler rows table (implies --status)
  --dashboard-only        Probe only the Dashboard server (/health + optional /api/status)
  --daemon-only           Probe only the Companion API daemon (/health + optional /status.json)
  --strict                Exit 1 when overallStatus !== "ok" or bunVersionDrift is true
  --no-drift-fail         With --strict, ignore bunVersionDrift alone
  --timeout-ms <N>        Per-request HTTP timeout in ms (100..30000, default: 2000)
  -w, --watch             Continuously poll on an interval until Ctrl+C
  --interval <SEC>        Watch polling interval in seconds (0.5..300, default: 5; requires --watch)
  --json                  Emit machine-readable JSON (schemaVersion: 1)
  --no-color              Disable ANSI color sequences (also honors NO_COLOR)
  -h, --help              Show this help and exit

Examples:
  ./bin/dx health
  ./bin/dx health --port 4024 --status --alerts --schedules
  bun run health -- --port 4024 --strict --no-drift-fail --json
  bun run cli health --daemon-only --json
  ./bin/dx health --port 4024 --watch --interval 3`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeHttpOrigin(raw: string, flagName: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (flagName && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
    // Strip path/query/hash so origin comparisons stay canonical.
    return parsed.origin;
  }
  return parsed.origin;
}

function defaultPortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env.PORT?.trim();
  if (!raw) return DEFAULT_DASHBOARD_PORT;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return DEFAULT_DASHBOARD_PORT;
}

function defaultDaemonFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env.SPORTSDESK_API_ORIGIN?.trim();
  if (!raw) return DEFAULT_DAEMON_ORIGIN;
  return (
    normalizeHttpOrigin(raw, "SPORTSDESK_API_ORIGIN") ?? DEFAULT_DAEMON_ORIGIN
  );
}

function portFromUrl(rawUrl: string): number {
  try {
    const u = new URL(rawUrl);
    if (u.port) {
      const p = Number(u.port);
      if (Number.isInteger(p) && p > 0) return p;
    }
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return DEFAULT_DASHBOARD_PORT;
  }
}

export function parseHealthCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): HealthCliParseResult {
  let port = defaultPortFromEnv(env);
  let url: string | null = null;
  let daemonUrl = defaultDaemonFromEnv(env);
  let status = false;
  let alerts = false;
  let schedules = false;
  let daemonOnly = false;
  let dashboardOnly = false;
  let strict = false;
  let noDriftFail = false;
  let timeoutMs = 2000;
  let watch = false;
  let intervalSec = 5;
  let intervalSpecified = false;
  let json = false;
  let noColor = Boolean(env.NO_COLOR && env.NO_COLOR !== "0");
  let help = false;
  let hasExplicitDashboardTarget = false;
  let hasExplicitDaemonTarget = false;

  const takeValue = (
    index: number,
    inline: string | undefined,
    flag: string,
  ):
    | { readonly ok: true; readonly value: string; readonly nextIndex: number }
    | { readonly ok: false; readonly error: string } => {
    if (inline !== undefined) {
      return { ok: true, value: inline, nextIndex: index };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      return {
        ok: false,
        error: `health: ${flag} expects a value (see '--help')`,
      };
    }
    return { ok: true, value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    const eqIdx = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eqIdx === -1 ? raw : raw.slice(0, eqIdx);
    const inline = eqIdx === -1 ? undefined : raw.slice(eqIdx + 1);

    if (flag === "-h" || flag === "--help") {
      help = true;
      continue;
    }
    if (flag === "--status") {
      status = true;
      continue;
    }
    if (flag === "--alerts") {
      alerts = true;
      continue;
    }
    if (flag === "--schedules") {
      schedules = true;
      status = true;
      continue;
    }
    if (flag === "--daemon-only") {
      daemonOnly = true;
      continue;
    }
    if (flag === "--dashboard-only") {
      dashboardOnly = true;
      continue;
    }
    if (flag === "--strict") {
      strict = true;
      continue;
    }
    if (flag === "--no-drift-fail") {
      noDriftFail = true;
      continue;
    }
    if (flag === "-w" || flag === "--watch") {
      watch = true;
      continue;
    }
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--no-color") {
      noColor = true;
      continue;
    }
    if (flag === "-p" || flag === "--port") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const parsed = Number(taken.value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return {
          ok: false,
          error: `health: --port expects an integer 1..65535, got "${taken.value}"`,
        };
      }
      port = parsed;
      hasExplicitDashboardTarget = true;
      continue;
    }
    if (flag === "--url") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const normalized = normalizeHttpOrigin(taken.value, "--url");
      if (!normalized) {
        return {
          ok: false,
          error: `health: --url expects an http(s) origin without credentials, got "${taken.value}"`,
        };
      }
      url = normalized;
      hasExplicitDashboardTarget = true;
      continue;
    }
    if (flag === "--daemon-url") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const normalized = normalizeHttpOrigin(taken.value, "--daemon-url");
      if (!normalized) {
        return {
          ok: false,
          error: `health: --daemon-url expects an http(s) origin without credentials, got "${taken.value}"`,
        };
      }
      daemonUrl = normalized;
      hasExplicitDaemonTarget = true;
      continue;
    }
    if (flag === "--timeout-ms") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const parsed = Number(taken.value);
      if (!Number.isInteger(parsed) || parsed < 100 || parsed > 30_000) {
        return {
          ok: false,
          error: `health: --timeout-ms expects an integer 100..30000, got "${taken.value}"`,
        };
      }
      timeoutMs = parsed;
      continue;
    }
    if (flag === "--interval") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const parsed = Number(taken.value);
      if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 300) {
        return {
          ok: false,
          error: `health: --interval expects a number 0.5..300 seconds, got "${taken.value}"`,
        };
      }
      intervalSec = parsed;
      intervalSpecified = true;
      continue;
    }

    return {
      ok: false,
      error: `health: unknown argument "${raw}". Run with '--help' for supported flags.`,
    };
  }

  if (help) {
    return {
      ok: true,
      flags: {
        port,
        url,
        daemonUrl,
        status,
        alerts,
        schedules,
        daemonOnly,
        dashboardOnly,
        strict,
        noDriftFail,
        timeoutMs,
        watch,
        intervalSec,
        json,
        noColor,
        help: true,
        hasExplicitDashboardTarget,
        hasExplicitDaemonTarget,
      },
    };
  }

  if (daemonOnly && dashboardOnly) {
    return {
      ok: false,
      error:
        "health: --daemon-only and --dashboard-only are mutually exclusive.",
    };
  }

  if (intervalSpecified && !watch) {
    return {
      ok: false,
      error: "health: --interval is only valid together with --watch.",
    };
  }

  return {
    ok: true,
    flags: {
      port,
      url,
      daemonUrl,
      status,
      alerts,
      schedules,
      daemonOnly,
      dashboardOnly,
      strict,
      noDriftFail,
      timeoutMs,
      watch,
      intervalSec,
      json,
      noColor,
      help: false,
      hasExplicitDashboardTarget,
      hasExplicitDaemonTarget,
    },
  };
}

function normalizeHealthStatus(
  rawStatus: string | null,
  rawOperational: string | null,
  rawOk: unknown,
  httpOk: boolean,
): HealthStatus {
  const s = (rawStatus ?? "").toLowerCase();
  const op = (rawOperational ?? "").toLowerCase();
  if (s === "down" || s === "error" || op === "down") return "down";
  if (
    s === "degraded" ||
    s === "warn" ||
    s === "warning" ||
    op === "degraded"
  ) {
    return "degraded";
  }
  if (!httpOk) return "down";
  if (rawOk === false) return "degraded";
  return "ok";
}

function parseAlertsRecord(raw: unknown): NormalizedAlertMetrics | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const rawStatus = (strOrNull(rec.status) ?? "ok").toLowerCase();
  const status: HealthStatus =
    rawStatus === "down" || rawStatus === "error"
      ? "down"
      : rawStatus === "degraded" ||
          rawStatus === "warning" ||
          rawStatus === "warn"
        ? "degraded"
        : "ok";
  return {
    status,
    queued: numOrNull(rec.queued) ?? 0,
    delivered: numOrNull(rec.delivered) ?? 0,
    dead: numOrNull(rec.dead) ?? 0,
    backlog: numOrNull(rec.backlog) ?? 0,
    acknowledged: numOrNull(rec.acknowledged) ?? 0,
    oldestQueuedAgeMs: numOrNull(rec.oldestQueuedAgeMs) ?? 0,
    lastDeliveryAt: strOrNull(rec.lastDeliveryAt),
  };
}

function parseCompanionSnapshot(
  raw: unknown,
): CompanionDaemonHealthSnapshot | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const versionRec = asRecord(rec.version);
  const ingressRec = asRecord(rec.ingress);
  const reasonsRaw = Array.isArray(rec.degradedReasons)
    ? rec.degradedReasons
    : [];
  const degradedReasons: CompanionDaemonDegradedReason[] = [];
  for (const item of reasonsRaw) {
    if (typeof item === "string" && item.trim()) {
      degradedReasons.push({ message: item.trim() });
      continue;
    }
    const r = asRecord(item);
    const msg = r ? strOrNull(r.message) : null;
    if (msg) {
      degradedReasons.push({
        message: msg,
        kind: strOrNull(r?.kind) ?? undefined,
        severity: strOrNull(r?.severity) ?? undefined,
        action: strOrNull(r?.action),
      });
    }
  }
  return {
    online: boolOr(rec.online, false),
    origin: strOrNull(rec.origin) ?? DEFAULT_DAEMON_ORIGIN,
    httpStatus: numOrNull(rec.httpStatus),
    latencyMs: numOrNull(rec.latencyMs),
    status: strOrNull(rec.status) ?? "unknown",
    operationalStatus: strOrNull(rec.operationalStatus),
    dataStatus: strOrNull(rec.dataStatus),
    runtime: strOrNull(rec.runtime) ?? undefined,
    uptimeSeconds: numOrNull(rec.uptimeSeconds) ?? undefined,
    nodeEnv: strOrNull(rec.nodeEnv) ?? undefined,
    version: versionRec
      ? {
          gitSha: strOrNull(versionRec.gitSha) ?? undefined,
          buildTime: strOrNull(versionRec.buildTime) ?? undefined,
          nodeEnv: strOrNull(versionRec.nodeEnv) ?? undefined,
        }
      : undefined,
    ingress: ingressRec
      ? {
          proxied:
            typeof ingressRec.proxied === "boolean"
              ? ingressRec.proxied
              : undefined,
          trustProxy:
            typeof ingressRec.trustProxy === "boolean"
              ? ingressRec.trustProxy
              : undefined,
        }
      : undefined,
    checks: asRecord(rec.checks),
    degradedReasons,
    error: strOrNull(rec.error),
    sampledAt: strOrNull(rec.sampledAt) ?? "",
  };
}

export function parseStructuredHealthPayload(
  rawPayload: Record<string, unknown>,
  httpOk = true,
): ParsedStructuredHealth {
  const schemaVersion = numOrNull(rawPayload.schemaVersion);
  const rawStatus = strOrNull(rawPayload.status);
  const rawOp = strOrNull(rawPayload.operationalStatus);
  const healthStatus = normalizeHealthStatus(
    rawStatus,
    rawOp,
    rawPayload.ok,
    httpOk,
  );

  const buildRec = asRecord(rawPayload.build);
  const runtimeRec = asRecord(rawPayload.runtime);
  const serverRec = asRecord(rawPayload.server);
  const depsRec = asRecord(rawPayload.dependencies);
  const dbRec = depsRec ? asRecord(depsRec.db) : null;
  const r2Rec = depsRec ? asRecord(depsRec.r2) : null;
  const sessionsRec = asRecord(rawPayload.sessions);

  const bunVersion = buildRec
    ? strOrNull(buildRec.bunVersion)
    : strOrNull(rawPayload.bunVersion);
  const expectedBunVersion = buildRec
    ? strOrNull(buildRec.expectedBunVersion)
    : null;
  const bunVersionDrift = buildRec
    ? boolOr(buildRec.bunVersionDrift, false)
    : false;

  const uptimeSeconds = runtimeRec
    ? numOrNull(runtimeRec.uptimeSeconds)
    : numOrNull(rawPayload.uptimeSeconds);
  const rssBytes = runtimeRec ? numOrNull(runtimeRec.rssBytes) : null;
  const heapUsedBytes = runtimeRec ? numOrNull(runtimeRec.heapUsedBytes) : null;

  const port = serverRec
    ? numOrNull(serverRec.port)
    : numOrNull(rawPayload.port);
  const pendingRequests = serverRec
    ? numOrNull(serverRec.pendingRequests)
    : numOrNull(rawPayload.pendingRequests);
  const pendingWebSockets = serverRec
    ? numOrNull(serverRec.pendingWebSockets)
    : numOrNull(rawPayload.pendingWebSockets);
  const wsBackpressureBytes = serverRec
    ? numOrNull(serverRec.wsBackpressureBytes)
    : null;

  const dbStatus = dbRec ? strOrNull(dbRec.status) : strOrNull(rawPayload.db);
  const r2Status = r2Rec ? strOrNull(r2Rec.status) : null;
  const r2LastSnapshotAgeMs = r2Rec ? numOrNull(r2Rec.lastSnapshotAgeMs) : null;

  const activeSessions = sessionsRec ? numOrNull(sessionsRec.active) : null;
  const purgedSessions = sessionsRec
    ? numOrNull(sessionsRec.purged)
    : numOrNull(rawPayload.purgedSessions);

  return {
    schemaVersion,
    status: healthStatus,
    service: strOrNull(rawPayload.service),
    timestamp: strOrNull(rawPayload.timestamp),
    build:
      buildRec || bunVersion !== null
        ? {
            bunVersion,
            expectedBunVersion,
            bunVersionDrift,
          }
        : null,
    runtime:
      runtimeRec || uptimeSeconds !== null
        ? {
            uptimeSeconds,
            rssBytes,
            heapUsedBytes,
          }
        : null,
    server:
      serverRec || port !== null || pendingRequests !== null
        ? {
            port,
            pendingRequests,
            pendingWebSockets,
            wsBackpressureBytes,
          }
        : null,
    dependencies:
      depsRec || dbStatus !== null
        ? {
            dbStatus,
            r2Status,
            r2LastSnapshotAgeMs,
          }
        : null,
    sessions:
      sessionsRec || purgedSessions !== null
        ? {
            active: activeSessions,
            purged: purgedSessions,
          }
        : null,
    alerts: parseAlertsRecord(rawPayload.alerts),
    daemon4020: parseCompanionSnapshot(rawPayload.daemon4020),
  };
}

async function fetchJsonTarget(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{
  readonly reachable: boolean;
  readonly httpOk: boolean;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly payload: Record<string, unknown> | null;
  readonly error: string | null;
}> {
  const startedAt = performance.now();
  try {
    const res = await fetchImpl(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      payload = asRecord(parsed);
    } catch {
      // signal-honesty: intentional-non-json-health-response
      payload = null;
    }
    return {
      reachable: true,
      httpOk: res.ok,
      httpStatus: res.status,
      latencyMs,
      payload,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    return {
      reachable: false,
      httpOk: false,
      httpStatus: null,
      latencyMs,
      payload: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeHealthTarget(
  target: "dashboard" | "daemon",
  name: string,
  origin: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  inProcessPayload?: Record<string, unknown> | null,
): Promise<HealthTargetProbe> {
  const healthUrl = `${origin}/health`;
  const port = portFromUrl(origin);

  if (inProcessPayload !== undefined && inProcessPayload !== null) {
    const structured = parseStructuredHealthPayload(inProcessPayload, true);
    return {
      name,
      target,
      url: healthUrl,
      port: structured.server?.port ?? port,
      ok: structured.status !== "down",
      reachable: true,
      httpStatus: 200,
      statusLabel: "in-process",
      latencyMs: 0,
      healthStatus: structured.status,
      structured,
      rawPayload: inProcessPayload,
      error: null,
    };
  }

  const fetched = await fetchJsonTarget(healthUrl, timeoutMs, fetchImpl);
  if (!fetched.reachable) {
    return {
      name,
      target,
      url: healthUrl,
      port,
      ok: false,
      reachable: false,
      httpStatus: null,
      statusLabel: fetched.error ?? "OFFLINE",
      latencyMs: fetched.latencyMs,
      healthStatus: "down",
      structured: null,
      rawPayload: null,
      error: fetched.error ?? "Connection failed",
    };
  }

  const structured = fetched.payload
    ? parseStructuredHealthPayload(fetched.payload, fetched.httpOk)
    : null;
  const healthStatus = structured?.status ?? (fetched.httpOk ? "ok" : "down");
  return {
    name,
    target,
    url: healthUrl,
    port: structured?.server?.port ?? port,
    ok: fetched.httpOk || healthStatus === "degraded",
    reachable: true,
    httpStatus: fetched.httpStatus,
    statusLabel: `HTTP ${fetched.httpStatus}`,
    latencyMs: fetched.latencyMs,
    healthStatus,
    structured,
    rawPayload: fetched.payload,
    error: fetched.error,
  };
}

function parseStatusPayload(
  payload: Record<string, unknown> | null,
  meta: {
    readonly ok: boolean;
    readonly url: string;
    readonly httpStatus: number | null;
    readonly latencyMs: number | null;
    readonly error: string | null;
  },
): StatusSummaryProbe {
  if (!payload) {
    return {
      ok: false,
      url: meta.url,
      httpStatus: meta.httpStatus,
      latencyMs: meta.latencyMs,
      error: meta.error ?? "Empty status payload",
      status: null,
      live: null,
      telegramMode: null,
      telegramModeReason: null,
      schedules: [],
    };
  }

  const liveRec = asRecord(payload.live);
  const tickerRec = liveRec ? asRecord(liveRec.ticker) : null;
  const pendingRec = liveRec ? asRecord(liveRec.pending) : null;
  const refreshRec = liveRec ? asRecord(liveRec.refresh) : null;
  const telegramRec = asRecord(payload.telegram);
  const telegramStatusRec = telegramRec ? asRecord(telegramRec.status) : null;
  const schedulesRaw =
    telegramRec && Array.isArray(telegramRec.schedules)
      ? telegramRec.schedules
      : Array.isArray(payload.schedules)
        ? payload.schedules
        : [];

  const schedules: ScheduleRowSummary[] = [];
  for (const row of schedulesRaw) {
    const rec = asRecord(row);
    if (!rec) continue;
    const id = strOrNull(rec.id) ?? "(unknown)";
    const name = strOrNull(rec.name) ?? id;
    schedules.push({
      id,
      name,
      scheduleTime: strOrNull(rec.scheduleTime) ?? "—",
      tz: strOrNull(rec.tz),
      reportType: strOrNull(rec.reportType) ?? "—",
      enabled: boolOr(rec.enabled, true),
    });
  }

  const payloadDeclaresDown =
    payload.ok === false || payload.daemon4020Online === false;
  const effectiveOk = meta.ok && !payloadDeclaresDown;
  const effectiveError =
    meta.error ??
    (payloadDeclaresDown
      ? (strOrNull(payload.note) ?? "Daemon /status service unavailable")
      : null);

  return {
    ok: effectiveOk,
    url: meta.url,
    httpStatus: meta.httpStatus,
    latencyMs: meta.latencyMs,
    error: effectiveError,
    status: strOrNull(payload.status),
    live: liveRec
      ? {
          tickerStatus: strOrNull(tickerRec?.status),
          pendingStatus: strOrNull(pendingRec?.status),
          refreshTicks: numOrNull(refreshRec?.ticks),
          lastTickOk:
            typeof refreshRec?.lastTickOk === "boolean"
              ? refreshRec.lastTickOk
              : null,
        }
      : null,
    telegramMode: strOrNull(telegramStatusRec?.mode),
    telegramModeReason: strOrNull(telegramStatusRec?.modeReason),
    schedules,
  };
}

function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

export async function probeSportsDeskHealth(
  flags: HealthCliFlags,
  opts: ProbeSportsDeskHealthOptions = {},
): Promise<SportsDeskHealthReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const dashboardOrigin = flags.url ?? `http://127.0.0.1:${flags.port}`;
  const daemonOrigin = flags.daemonUrl;

  const shouldProbeDashboard = !flags.daemonOnly;
  const shouldProbeDaemon = !flags.dashboardOnly;

  const dashboardPromise = shouldProbeDashboard
    ? probeHealthTarget(
        "dashboard",
        "SportsDesk Dashboard SPA & Dev Server",
        dashboardOrigin,
        flags.timeoutMs,
        fetchImpl,
        opts.localHealthPayload,
      )
    : Promise.resolve(null);

  const daemonPromise = shouldProbeDaemon
    ? probeHealthTarget(
        "daemon",
        "SportsDesk Core API Daemon",
        daemonOrigin,
        flags.timeoutMs,
        fetchImpl,
      )
    : Promise.resolve(null);

  const statusUrl = flags.daemonOnly
    ? `${daemonOrigin}/status.json`
    : `${dashboardOrigin}/api/status`;

  const statusPromise =
    flags.status || flags.schedules
      ? opts.localStatusPayload !== undefined && flags.daemonOnly === false
        ? Promise.resolve(
            parseStatusPayload(opts.localStatusPayload, {
              ok: opts.localStatusPayload !== null,
              url: statusUrl,
              httpStatus: opts.localStatusPayload !== null ? 200 : null,
              latencyMs: 0,
              error:
                opts.localStatusPayload === null
                  ? "Local status snapshot unavailable"
                  : null,
            }),
          )
        : fetchJsonTarget(statusUrl, flags.timeoutMs, fetchImpl).then((res) =>
            parseStatusPayload(res.payload, {
              ok: res.httpOk && res.payload !== null,
              url: statusUrl,
              httpStatus: res.httpStatus,
              latencyMs: res.latencyMs,
              error:
                res.error ??
                (res.payload === null
                  ? "Invalid JSON from status endpoint"
                  : null),
            }),
          )
      : Promise.resolve(null);

  const [dashboard, daemon, statusProbe] = await Promise.all([
    dashboardPromise,
    daemonPromise,
    statusPromise,
  ]);

  const bunVersionDrift = Boolean(
    dashboard?.structured?.build?.bunVersionDrift,
  );

  const observedStatuses: HealthStatus[] = [];
  if (dashboard) {
    observedStatuses.push(dashboard.healthStatus);
  }
  if (daemon) {
    // Companion offline makes overall status degraded (or down when --daemon-only).
    if (!daemon.reachable) {
      observedStatuses.push(flags.daemonOnly ? "down" : "degraded");
    } else {
      observedStatuses.push(daemon.healthStatus);
    }
  }
  const overallStatus = worstStatus(observedStatuses);

  const criticalDashboardOk =
    dashboard === null ||
    (dashboard.reachable && dashboard.healthStatus !== "down");
  const criticalDaemonOk =
    !flags.daemonOnly ||
    (daemon !== null && daemon.reachable && daemon.healthStatus !== "down");
  const allHealthy = criticalDashboardOk && criticalDaemonOk;

  let exitCode: 0 | 1;
  if (flags.strict) {
    const statusClean = overallStatus === "ok" && allHealthy;
    const driftClean = flags.noDriftFail || !bunVersionDrift;
    exitCode = statusClean && driftClean ? 0 : 1;
  } else {
    exitCode = allHealthy ? 0 : 1;
  }

  return {
    timestamp: now().toISOString(),
    dashboardUrl: dashboardOrigin,
    daemonUrl: daemonOrigin,
    overallStatus,
    bunVersionDrift,
    allHealthy,
    strict: flags.strict,
    noDriftFail: flags.noDriftFail,
    exitCode,
    dashboard,
    daemon,
    statusProbe,
  };
}

function formatDurationSeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m ${rem}s`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function formatMiB(bytes: number | null): string {
  if (bytes === null) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatHealthReportAnsi(
  report: SportsDeskHealthReport,
  opts: {
    readonly color: boolean;
    readonly alerts: boolean;
    readonly schedules: boolean;
  },
): string {
  const c = (code: string, text: string) =>
    opts.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const badge = (status: HealthStatus) => {
    if (status === "ok") return c("32", "● OK");
    if (status === "degraded") return c("33", "▲ DEGRADED");
    return c("31", "✖ DOWN");
  };

  const lines: string[] = [];
  const driftTag = report.bunVersionDrift
    ? ` · ${c("33", "BUN VERSION DRIFT")}`
    : "";
  lines.push(
    `${c("1;36", "⚡ SportsDesk Health & Status Diagnostics")} ${badge(report.overallStatus)}${driftTag}`,
  );
  lines.push(
    c("90", `Sampled: ${report.timestamp} · CLI Runtime: Bun v${Bun.version}`),
  );
  lines.push("");

  if (report.dashboard) {
    const d = report.dashboard;
    const s = d.structured;
    const latency = c("90", `(${d.latencyMs}ms)`);
    lines.push(
      `  ${badge(d.healthStatus)} ${c("1", d.name)} on :${d.port} ${latency}`,
    );
    lines.push(`     URL: ${d.url} · HTTP: ${d.statusLabel}`);
    if (!d.reachable) {
      lines.push(`     ${c("31", "Error:")} ${d.error ?? "unreachable"}`);
      lines.push(`     ${c("33", "Remedy:")} bun run dev --port ${d.port}`);
    } else if (s) {
      const schemaTag =
        s.schemaVersion !== null
          ? `schemaVersion=${s.schemaVersion}`
          : "legacy";
      if (s.build) {
        const expected = s.build.expectedBunVersion ?? "n/a";
        const driftNote = s.build.bunVersionDrift
          ? c("33", `DRIFT (expected ${expected})`)
          : c("32", `aligned (${expected})`);
        lines.push(
          `     Build (${schemaTag}): Bun ${s.build.bunVersion ?? "unknown"} · ${driftNote}`,
        );
      }
      if (s.runtime) {
        lines.push(
          `     Runtime: uptime ${formatDurationSeconds(s.runtime.uptimeSeconds)} · rss ${formatMiB(s.runtime.rssBytes)} · heap ${formatMiB(s.runtime.heapUsedBytes)}`,
        );
      }
      if (s.server) {
        lines.push(
          `     Server: req=${s.server.pendingRequests ?? 0} · ws=${s.server.pendingWebSockets ?? 0} · wsBackpressure=${s.server.wsBackpressureBytes ?? 0} B`,
        );
      }
      if (s.dependencies) {
        const r2Age =
          s.dependencies.r2LastSnapshotAgeMs !== null
            ? ` (age ${Math.round(s.dependencies.r2LastSnapshotAgeMs / 1000)}s)`
            : "";
        lines.push(
          `     Dependencies: db=${s.dependencies.dbStatus ?? "—"} · r2=${s.dependencies.r2Status ?? "—"}${r2Age}`,
        );
      }
      if (s.sessions) {
        lines.push(
          `     Sessions: active=${s.sessions.active ?? 0} · purged=${s.sessions.purged ?? 0}`,
        );
      }
      if (s.alerts) {
        const a = s.alerts;
        lines.push(
          `     Alerts: ${badge(a.status)} (queued: ${a.queued}, backlog: ${a.backlog}, delivered: ${a.delivered}, dead: ${a.dead})`,
        );
        if (opts.alerts) {
          lines.push(
            `       acknowledged=${a.acknowledged} · oldestQueuedAgeMs=${a.oldestQueuedAgeMs} · lastDeliveryAt=${a.lastDeliveryAt ?? "none"}`,
          );
        }
      }
      if (s.daemon4020) {
        const c4 = s.daemon4020;
        const sha = c4.version?.gitSha ? ` · sha=${c4.version.gitSha}` : "";
        lines.push(
          `     Embedded daemon4020: online=${String(c4.online)} · status=${c4.status}${c4.operationalStatus ? ` (${c4.operationalStatus})` : ""}${sha}`,
        );
        for (const reason of c4.degradedReasons.slice(0, 4)) {
          lines.push(`       - ${c("33", reason.message)}`);
        }
      }
    }
    lines.push("");
  }

  if (report.daemon) {
    const m = report.daemon;
    const s = m.structured;
    const latency = c("90", `(${m.latencyMs}ms)`);
    lines.push(
      `  ${m.reachable ? badge(m.healthStatus) : c("33", "▲ OFFLINE")} ${c("1", m.name)} on :${m.port} ${latency}`,
    );
    lines.push(`     URL: ${m.url} · HTTP: ${m.statusLabel}`);
    if (!m.reachable) {
      lines.push(`     ${c("33", "Note:")} ${m.error ?? "unreachable"}`);
      lines.push(`     ${c("33", "Remedy:")} bun run serve`);
    } else if (m.rawPayload) {
      const op = strOrNull(m.rawPayload.operationalStatus);
      const data = strOrNull(m.rawPayload.dataStatus);
      const versionRec = asRecord(m.rawPayload.version);
      const sha = versionRec ? strOrNull(versionRec.gitSha) : null;
      lines.push(
        `     State: status=${strOrNull(m.rawPayload.status) ?? s?.status ?? "—"} · op=${op ?? "—"} · data=${data ?? "—"}${sha ? ` · sha=${sha}` : ""}`,
      );
      if (s?.alerts && opts.alerts) {
        lines.push(
          `     Alerts: queued=${s.alerts.queued} · backlog=${s.alerts.backlog} · delivered=${s.alerts.delivered} · dead=${s.alerts.dead}`,
        );
      }
    }
    lines.push("");
  }

  if (report.statusProbe) {
    const sp = report.statusProbe;
    lines.push(
      `  ${sp.ok ? c("32", "● STATUS") : c("33", "▲ STATUS UNAVAILABLE")} ${c("1", sp.url)}${sp.latencyMs !== null ? c("90", ` (${sp.latencyMs}ms)`) : ""}`,
    );
    if (!sp.ok) {
      lines.push(
        `     ${c("33", "Note:")} ${sp.error ?? "status probe failed"}`,
      );
    } else {
      lines.push(
        `     Status: ${sp.status ?? "unknown"} · Telegram: ${sp.telegramMode ?? "—"} (${sp.telegramModeReason ?? "configured"}) · Schedules: ${sp.schedules.length}`,
      );
      if (sp.live) {
        lines.push(
          `     Live Stream: ticker=${sp.live.tickerStatus ?? "—"} · pending=${sp.live.pendingStatus ?? "—"} · ticks=${sp.live.refreshTicks ?? 0} (lastTickOk=${String(sp.live.lastTickOk)})`,
        );
      }
      if (opts.schedules && sp.schedules.length > 0) {
        lines.push("     Schedules:");
        for (const row of sp.schedules) {
          const state = row.enabled ? c("32", "ON ") : c("90", "OFF");
          const tz = row.tz ? ` ${row.tz}` : "";
          lines.push(
            `       ${state} ${row.id} | ${row.scheduleTime}${tz} | ${row.reportType} | ${row.name}`,
          );
        }
      }
    }
    lines.push("");
  }

  if (report.exitCode === 0) {
    lines.push(c("1;32", "✔ Health check passed under current policy."));
  } else {
    lines.push(
      c(
        "1;31",
        `✖ Health check failed (${report.strict ? "strict mode" : "critical target offline/down"}).`,
      ),
    );
  }

  return lines.join("\n");
}

export function buildHealthJsonPayload(
  report: SportsDeskHealthReport,
): Record<string, unknown> {
  const services: Array<{
    readonly name: string;
    readonly port: number;
    readonly ok: boolean;
    readonly status: number | string;
    readonly latencyMs: number;
  }> = [];
  if (report.dashboard) {
    services.push({
      name: report.dashboard.name,
      port: report.dashboard.port,
      ok: report.dashboard.ok,
      status: report.dashboard.httpStatus ?? report.dashboard.statusLabel,
      latencyMs: report.dashboard.latencyMs,
    });
  }
  if (report.daemon) {
    services.push({
      name: report.daemon.name,
      port: report.daemon.port,
      ok: report.daemon.ok,
      status: report.daemon.httpStatus ?? report.daemon.statusLabel,
      latencyMs: report.daemon.latencyMs,
    });
  }

  return {
    schemaVersion: 1,
    timestamp: report.timestamp,
    overallStatus: report.overallStatus,
    allHealthy: report.allHealthy,
    strict: report.strict,
    noDriftFail: report.noDriftFail,
    bunVersionDrift: report.bunVersionDrift,
    exitCode: report.exitCode,
    dashboard: report.dashboard,
    daemon: report.daemon,
    ...(report.statusProbe ? { status: report.statusProbe } : {}),
    services,
  };
}

export async function runHealthCli(
  argv: readonly string[],
  io: HealthCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => console.log(text));
  const stderr = io.stderr ?? ((text: string) => console.error(text));
  const env = io.env ?? Bun.env;

  const parsed = parseHealthCliArgs(argv, env);
  if (!parsed.ok) {
    stderr(parsed.error);
    return 2;
  }

  const { flags } = parsed;
  if (flags.help) {
    stdout(healthHelpText());
    return 0;
  }

  const runOnce = async (): Promise<number> => {
    const localHealthPayload =
      !flags.hasExplicitDashboardTarget &&
      !flags.daemonOnly &&
      io.localHealthPayload
        ? await io.localHealthPayload()
        : undefined;
    const localStatusPayload =
      !flags.hasExplicitDashboardTarget &&
      !flags.daemonOnly &&
      (flags.status || flags.schedules) &&
      io.localStatusPayload
        ? await io.localStatusPayload()
        : undefined;

    const report = await probeSportsDeskHealth(flags, {
      fetchImpl: io.fetchImpl,
      localHealthPayload,
      localStatusPayload,
      now: io.now,
    });

    if (flags.json) {
      stdout(JSON.stringify(buildHealthJsonPayload(report), null, 2));
    } else {
      stdout(
        formatHealthReportAnsi(report, {
          color: !flags.noColor,
          alerts: flags.alerts,
          schedules: flags.schedules,
        }),
      );
    }
    return report.exitCode;
  };

  if (!flags.watch) {
    return runOnce();
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let lastExit = 0;
  try {
    while (!stopped) {
      lastExit = await runOnce();
      if (stopped) break;
      await Bun.sleep(Math.round(flags.intervalSec * 1000));
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return lastExit;
}
