/**
 * @file lib/desk_health.ts
 * @description Machine-readable data health for the desk panels.
 *
 * Every number the desk dashboard renders comes from an artifact, and the artifact is one of four
 * things: an API capture, a human paste, a demo fixture, or a value derived at request time. The
 * page is honest about the KPI cards (`/api/kpis` carries `provenance.basis`), and its other panels
 * state a `source` plus one timestamp field whose name changes per route (`observedAt`,
 * `extractedAt`, `capturedAt`, `updatedAt`). That is enough for a human to read and too little for
 * a program to check, which is why the 2026-11-04 audit could only answer "is this number real?"
 * by reading five payloads by hand.
 *
 * This module resolves every panel into one document with one vocabulary, so a command (or an
 * agent) can answer "is the desk telling the truth, and which command fixes it?" without scraping
 * HTML. Measured on 2026-11-04 at 127.0.0.1:4020: `/api/kpis` reported basis capture/fixture and
 * the other routes reported only a source plus a date, which this module classifies and ages.
 *
 * Read-only by construction: no artifact writes, no credential read, no mutation. A panel that
 * cannot be read is reported as unread, never as zero.
 */

/** Version of the {@link DeskHealth} document shape. */
export const DESK_HEALTH_SCHEMA_VERSION = 1;

/** The desk daemon's default loopback origin. */
export const DEFAULT_DESK_BASE_URL = "http://127.0.0.1:4020";

/** Per-request bound. The daemon answers these routes from memory or a small JSON file. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/** A timestamp further ahead than this is treated as unreadable, not as a fresh capture. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * How a panel's number came to exist. `capture`, `paste` and `fixture` match
 * `lib/desk_kpis.ts#KpiBasis`; `derived` is a value recomputed from other panels; `unclassified`
 * means the payload named a source this reader does not recognise, which is itself a finding.
 */
export type DeskPanelBasis =
  "capture" | "paste" | "fixture" | "derived" | "unclassified";

/** Where a panel stands once its provenance has been read. */
export type DeskPanelState =
  | "ok"
  | "warn"
  | "stale"
  | "fixture"
  | "paste"
  | "locked"
  | "unknown"
  | "error";

export type DeskIssueSeverity = "error" | "warn";

export type DeskIssueCode =
  | "service-unreachable"
  | "panel-request-failed"
  | "panel-locked"
  | "missing-source"
  | "missing-timestamp"
  | "invalid-timestamp"
  | "stale"
  | "fixture"
  | "paste"
  | "unclassified-source"
  | "count-mismatch"
  | "bridge-job-failed"
  | "bridge-no-cycle";

/** One finding about one panel, with the command that would clear it when one exists. */
export interface DeskIssue {
  readonly code: DeskIssueCode;
  readonly severity: DeskIssueSeverity;
  /** Panel id, or `"service"` for a daemon-level finding. */
  readonly panel: string;
  readonly message: string;
  readonly nextCommand: string | null;
}

/** What one data panel declares about itself, resolved into the shared vocabulary. */
export interface DeskPanelHealth {
  readonly id: string;
  readonly label: string;
  /** The daemon route the panel reads. */
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly basis: DeskPanelBasis;
  readonly source: string | null;
  /** The payload's own observation time, verbatim. */
  readonly asOf: string | null;
  /** Age in whole seconds; `null` when the timestamp is missing or unreadable. */
  readonly ageSeconds: number | null;
  /** The payload's own verdict when it sends one, or the `--max-age` verdict; else `null`. */
  readonly stale: boolean | null;
  readonly partial: boolean | null;
  readonly state: DeskPanelState;
  readonly issues: readonly DeskIssue[];
}

/** Reachability and identity of the running daemon. */
export interface DeskServiceHealth {
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly status: string | null;
  readonly pid: number | null;
  readonly uptimeSeconds: number | null;
  readonly runtime: string | null;
}

/** The whole document: one JSON payload, one verdict, one ordered list of next commands. */
export interface DeskHealth {
  readonly schemaVersion: typeof DESK_HEALTH_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly baseUrl: string;
  readonly service: DeskServiceHealth;
  readonly panels: readonly DeskPanelHealth[];
  readonly issues: readonly DeskIssue[];
  readonly verdict: "ok" | "warn" | "fail";
  readonly nextCommands: readonly string[];
}

/** The fetch surface this module needs; the global `fetch` satisfies it. */
export type DeskFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DeskHealthOptions {
  /** Daemon origin; defaults to {@link DEFAULT_DESK_BASE_URL}. */
  readonly baseUrl?: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: DeskFetch;
  /** Injected clock. Defaults to now. */
  readonly now?: Date;
  readonly timeoutMs?: number;
  /**
   * When set, a panel whose age exceeds this is stale even if the payload sends no verdict.
   * When unset, this reader does not invent a staleness budget.
   */
  readonly maxAgeSeconds?: number | null;
}

type JsonObject = Readonly<Record<string, unknown>>;

interface ProvenancePick {
  readonly source: string | null;
  readonly asOf: string | null;
  readonly basis: DeskPanelBasis | null;
  readonly stale: boolean | null;
  readonly partial: boolean | null;
}

interface PanelProbe {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly refreshCommand: string | null;
  readonly pick: (body: JsonObject) => ProvenancePick | null;
  /** Panel-specific invariants that no single provenance field can express. */
  readonly inspect?: (body: JsonObject) => readonly DeskIssue[];
}

interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: JsonObject | null;
  readonly error: string | null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function basisOrNull(value: unknown): DeskPanelBasis | null {
  switch (value) {
    case "capture":
    case "paste":
    case "fixture":
    case "derived":
    case "unclassified":
      return value;
    default:
      return null;
  }
}

/**
 * Classify a payload's declared source string when the route sends no `basis`.
 *
 * The prefixes are the ones the artifacts actually use: `capture:<operation>@<iso>`,
 * `paste:<surface>`, `markup:<input>`, `tests/fixtures/...`, and prose sources such as
 * "operator paste of fantasy402 Game Admin (module Admin)". Anything else is `unclassified`
 * rather than guessed.
 */
export function classifySource(source: string): DeskPanelBasis {
  const value = source.trim();
  if (value.startsWith("capture:")) return "capture";
  if (
    value.startsWith("tests/fixtures/") ||
    value.includes("enriched_customers_full")
  ) {
    return "fixture";
  }
  if (
    value.startsWith("paste:") ||
    value.startsWith("markup:") ||
    /paste/i.test(value) ||
    /transcrib/i.test(value)
  ) {
    return "paste";
  }
  return "unclassified";
}

/**
 * Parse an artifact timestamp. Date-only values (the portal pastes carry `"2026-11-01"`) are read
 * as UTC midnight, which is the documented approximation: the paste happened on that day, and a
 * day's precision is the most the artifact records. Unreadable and future-dated values return
 * `null` so the caller reports them instead of ageing them.
 */
export function parseArtifactTime(
  value: string | null,
  nowMs: number,
): number | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00.000Z`
    : trimmed;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  if (ms > nowMs + MAX_FUTURE_SKEW_MS) return null;
  return ms;
}

/** Whole seconds since `asOfMs`; never negative (future values are rejected upstream). */
export function ageSecondsSince(asOfMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
}

/** Compact age for the human report: `42s`, `17m`, `3.2h`, `2.1d`. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function kpiPick(name: string): (body: JsonObject) => ProvenancePick | null {
  return (body) => {
    const kpis = asObject(body["kpis"]);
    const block = kpis === null ? null : asObject(kpis[name]);
    const provenance = block === null ? null : asObject(block["provenance"]);
    if (provenance === null) return null;
    return {
      source: text(provenance["source"]),
      asOf: text(provenance["asOf"]),
      basis: basisOrNull(provenance["basis"]),
      stale: boolOrNull(provenance["stale"]),
      partial: boolOrNull(provenance["partial"]),
    };
  };
}

function fieldPick(
  sourceField: string,
  asOfField: string,
): (body: JsonObject) => ProvenancePick {
  return (body) => ({
    source: text(body[sourceField]),
    asOf: text(body[asOfField]),
    basis: null,
    stale: null,
    partial: null,
  });
}

function liveWagersPick(body: JsonObject): ProvenancePick | null {
  const provenance = asObject(body["provenance"]);
  const freshness = asObject(body["freshness"]);
  if (provenance === null && freshness === null) return null;
  return {
    source: provenance === null ? null : text(provenance["source"]),
    asOf:
      (freshness === null ? null : text(freshness["asOf"])) ??
      (provenance === null ? null : text(provenance["observedAt"])),
    basis: null,
    stale: freshness === null ? null : boolOrNull(freshness["stale"]),
    partial: provenance === null ? null : boolOrNull(provenance["partial"]),
  };
}

function analysisPick(body: JsonObject): ProvenancePick | null {
  const reports = Array.isArray(body["reports"]) ? body["reports"] : [];
  const first = reports.length > 0 ? asObject(reports[0]) : null;
  if (first === null) return null;
  return {
    source: text(first["source"]),
    asOf: text(first["observedAt"]),
    basis: null,
    stale: null,
    partial: null,
  };
}

function analysisInvariant(body: JsonObject): readonly DeskIssue[] {
  const declared = body["count"];
  const reports = Array.isArray(body["reports"]) ? body["reports"] : null;
  if (typeof declared !== "number" || reports === null) return [];
  if (declared === reports.length) return [];
  return [
    {
      code: "count-mismatch",
      severity: "error",
      panel: "analysisReports",
      message: `count says ${declared} but reports[] has ${reports.length}; the route may be sending a literal count`,
      nextCommand: null,
    },
  ];
}

function bridgePick(body: JsonObject): ProvenancePick | null {
  const bridge = asObject(body["bridge"]);
  if (bridge === null) return null;
  return {
    source: "scratch/bridge-rollup-state.json (via /api/kpis)",
    asOf: text(bridge["updatedAt"]),
    basis: "derived",
    stale: null,
    partial: null,
  };
}

function bridgeJobsInspect(body: JsonObject): readonly DeskIssue[] {
  const bridge = asObject(body["bridge"]);
  if (bridge === null) return [];
  const jobs = Array.isArray(bridge["jobs"]) ? bridge["jobs"] : [];
  if (jobs.length === 0) {
    return [
      {
        code: "bridge-no-cycle",
        severity: "warn",
        panel: "bridge",
        message: "no rollup cycle recorded yet",
        nextCommand: null,
      },
    ];
  }
  const issues: DeskIssue[] = [];
  for (const raw of jobs) {
    const job = asObject(raw);
    if (job === null || job["ok"] === true) continue;
    const id = text(job["id"]) ?? "unknown";
    const label = text(job["label"]) ?? id;
    const error = text(job["error"]) ?? "no error text";
    issues.push({
      code: "bridge-job-failed",
      severity: "warn",
      panel: "bridge",
      message: `${label} failed: ${error}`,
      // The error text names its own fix (for example `session:login --from-keychain`); a
      // refresh command here would be a promise this repo cannot keep from this panel.
      nextCommand: null,
    });
  }
  return issues;
}

/**
 * The panel registry. Order is the report order and the JSON array order.
 * `refreshCommand` is the command that would replace a capture or a paste; `null` means no
 * mechanism in this repo can make that panel real today.
 */
const PANELS: readonly PanelProbe[] = [
  {
    id: "kpi.agents",
    label: "Agent tree",
    endpoint: "/api/kpis",
    refreshCommand: "bun run graph:agent",
    pick: kpiPick("agents"),
  },
  {
    id: "kpi.pending",
    label: "Open wagers (Pending)",
    endpoint: "/api/kpis",
    refreshCommand: "bun run capture:pending",
    pick: kpiPick("pending"),
  },
  {
    id: "kpi.ticker",
    label: "Bet ticker",
    endpoint: "/api/kpis",
    refreshCommand: "bun run capture:bet-ticker",
    pick: kpiPick("ticker"),
  },
  {
    id: "kpi.customerBook",
    label: "Customer lifetime net",
    endpoint: "/api/kpis",
    // No CLI makes this real: the book behind it is a gitignored demo fixture.
    refreshCommand: null,
    pick: kpiPick("customerBook"),
  },
  {
    id: "liveWagers",
    label: "Live wagers — bet ticker",
    endpoint: "/api/live-wagers",
    refreshCommand: "bun run capture:bet-ticker",
    pick: liveWagersPick,
  },
  {
    id: "gameAdminBoard",
    label: "Game Admin board",
    endpoint: "/api/game-admin/board",
    refreshCommand:
      "bun run capture:dom --input scratch/pastes --only game-admin-board",
    pick: fieldPick("source", "observedAt"),
  },
  {
    id: "scoreboard",
    label: "Scoreboard",
    endpoint: "/api/scoreboard",
    refreshCommand:
      "bun run capture:dom --input scratch/pastes --only scoreboard",
    pick: fieldPick("source", "observedAt"),
  },
  {
    id: "contests",
    label: "Contests",
    endpoint: "/api/contests",
    refreshCommand:
      "bun run capture:dom --input scratch/pastes --only contests",
    pick: fieldPick("source", "extractedAt"),
  },
  {
    id: "sportsCatalog",
    label: "Sport catalog",
    endpoint: "/api/sports/catalog",
    // Served from tests/fixtures/fantasy402-sport-catalog-2026-10-21.json; no capture CLI exists.
    refreshCommand: null,
    pick: fieldPick("source", "capturedAt"),
  },
  {
    id: "analysisReports",
    label: "Analysis reports",
    endpoint: "/api/analysis/reports",
    // The request is reproduced, the response was never captured; no CLI captures it today.
    refreshCommand: null,
    pick: analysisPick,
    inspect: analysisInvariant,
  },
  {
    id: "bridge",
    label: "Bridge rollup",
    endpoint: "/api/kpis",
    refreshCommand: "bun run weblog:rollup",
    pick: bridgePick,
    inspect: bridgeJobsInspect,
  },
];

/** How a declared source becomes a stated basis: explicit field first, known prefix second. */
function resolveBasis(pick: ProvenancePick): DeskPanelBasis {
  if (pick.basis !== null) return pick.basis;
  if (pick.source !== null) return classifySource(pick.source);
  return "unclassified";
}

function stateFor(
  basis: DeskPanelBasis,
  stale: boolean,
  hasError: boolean,
  hasWarn: boolean,
  locked: boolean,
): DeskPanelState {
  if (hasError) return "error";
  if (locked) return "locked";
  if (stale) return "stale";
  if (basis === "fixture") return "fixture";
  if (basis === "paste") return "paste";
  if (basis === "unclassified") return "unknown";
  if (hasWarn) return "warn";
  return "ok";
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function probe(
  fetchImpl: DeskFetch,
  url: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed: unknown = await response
      .json()
      .catch((): unknown => ({ success: false, error: "body is not JSON" }));
    return {
      ok: response.ok,
      status: response.status,
      body: asObject(parsed),
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function lockedStatus(status: number | null): boolean {
  return status === 401 || status === 403 || status === 503;
}

function unreachableHealth(
  baseUrl: string,
  error: string,
  httpStatus: number | null,
  now: Date,
): DeskHealth {
  const nextCommand = "bun run serve";
  const issue: DeskIssue = {
    code: "service-unreachable",
    severity: "error",
    panel: "service",
    message: `no desk service at ${baseUrl} (${error})`,
    nextCommand,
  };
  return {
    schemaVersion: DESK_HEALTH_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    baseUrl,
    service: {
      reachable: false,
      httpStatus,
      status: null,
      pid: null,
      uptimeSeconds: null,
      runtime: null,
    },
    panels: [],
    issues: [issue],
    verdict: "fail",
    nextCommands: [nextCommand],
  };
}

/**
 * Read the running daemon and return one health document.
 *
 * Nothing is written, no credential is read, and a route that does not answer is reported as
 * unread. `maxAgeSeconds` is the only staleness opinion this reader adds; without it, only the
 * payload's own `stale` flag is trusted.
 */
export async function collectDeskHealth(
  options: DeskHealthOptions = {},
): Promise<DeskHealth> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxAgeSeconds = options.maxAgeSeconds ?? null;
  const rawBaseUrl = options.baseUrl ?? DEFAULT_DESK_BASE_URL;

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBaseUrl);
  } catch {
    return unreachableHealth(rawBaseUrl, "not a URL", null, now);
  }

  const health = await probe(fetchImpl, `${baseUrl}/health`, timeoutMs);
  if (!health.ok) {
    return unreachableHealth(
      baseUrl,
      health.error ?? "health probe failed",
      health.status,
      now,
    );
  }
  const status = await probe(fetchImpl, `${baseUrl}/api/status`, timeoutMs);

  const endpoints = [...new Set(PANELS.map((panel) => panel.endpoint))].sort(
    (left, right) => left.localeCompare(right),
  );
  const results = new Map<string, ProbeResult>();
  await Promise.all(
    endpoints.map(async (endpoint) => {
      results.set(
        endpoint,
        await probe(fetchImpl, `${baseUrl}${endpoint}`, timeoutMs),
      );
    }),
  );

  const panels: DeskPanelHealth[] = [];
  const issues: DeskIssue[] = [];

  for (const definition of PANELS) {
    const result = results.get(definition.endpoint) ?? {
      ok: false,
      status: null,
      body: null,
      error: "not probed",
    };
    const panelIssues: DeskIssue[] = [];
    let basis: DeskPanelBasis = "unclassified";
    let source: string | null = null;
    let asOf: string | null = null;
    let ageSeconds: number | null = null;
    let stale: boolean | null = null;
    let partial: boolean | null = null;

    if (!result.ok) {
      const locked = lockedStatus(result.status);
      panelIssues.push({
        code: locked ? "panel-locked" : "panel-request-failed",
        severity: locked ? "warn" : "error",
        panel: definition.id,
        message: locked
          ? `${definition.endpoint} needs the admin token (HTTP ${result.status})`
          : `${definition.endpoint} did not answer: ${result.error ?? "unknown error"}`,
        nextCommand: null,
      });
    } else {
      const pick = definition.pick(result.body ?? {});
      if (pick === null) {
        panelIssues.push({
          code: "missing-source",
          severity: "error",
          panel: definition.id,
          message: `${definition.endpoint} answered without a provenance block`,
          nextCommand: definition.refreshCommand,
        });
      } else {
        source = pick.source;
        asOf = pick.asOf;
        basis = resolveBasis(pick);
        partial = pick.partial;
        if (source === null) {
          panelIssues.push({
            code: "missing-source",
            severity: "error",
            panel: definition.id,
            message: `${definition.endpoint} answered without a source`,
            nextCommand: definition.refreshCommand,
          });
        } else if (basis === "unclassified") {
          panelIssues.push({
            code: "unclassified-source",
            severity: "warn",
            panel: definition.id,
            message: `source "${source}" is not a known capture, paste or fixture`,
            nextCommand: definition.refreshCommand,
          });
        } else if (basis === "fixture") {
          panelIssues.push({
            code: "fixture",
            severity: "warn",
            panel: definition.id,
            message: `fixture, not a measurement: ${source}`,
            nextCommand: definition.refreshCommand,
          });
        } else if (basis === "paste") {
          panelIssues.push({
            code: "paste",
            severity: "warn",
            panel: definition.id,
            message: `one-off operator paste, not a live feed: ${source}`,
            nextCommand: definition.refreshCommand,
          });
        }

        const parsedAsOf = parseArtifactTime(asOf, nowMs);
        if (asOf === null) {
          panelIssues.push({
            code: "missing-timestamp",
            severity: "error",
            panel: definition.id,
            message: `${definition.endpoint} answered without an observation time`,
            nextCommand: definition.refreshCommand,
          });
        } else if (parsedAsOf === null) {
          panelIssues.push({
            code: "invalid-timestamp",
            severity: "error",
            panel: definition.id,
            message: `observation time "${asOf}" is unreadable or in the future`,
            nextCommand: definition.refreshCommand,
          });
        } else {
          ageSeconds = ageSecondsSince(parsedAsOf, nowMs);
        }

        const overAge =
          maxAgeSeconds !== null &&
          ageSeconds !== null &&
          ageSeconds > maxAgeSeconds;
        stale = pick.stale === true || overAge ? true : pick.stale;
        if (stale === true) {
          const why =
            pick.stale === true
              ? "the payload marks it stale"
              : `age ${formatAge(ageSeconds)} exceeds --max-age ${String(maxAgeSeconds)}s`;
          panelIssues.push({
            code: "stale",
            severity: "error",
            panel: definition.id,
            message: `${why}: ${source ?? "unknown source"}`,
            nextCommand: definition.refreshCommand,
          });
        }
      }

      if (definition.inspect !== undefined) {
        panelIssues.push(...definition.inspect(result.body ?? {}));
      }
    }

    const hasError = panelIssues.some((issue) => issue.severity === "error");
    const hasWarn = panelIssues.some((issue) => issue.severity === "warn");
    panels.push({
      id: definition.id,
      label: definition.label,
      endpoint: definition.endpoint,
      httpStatus: result.status,
      basis,
      source,
      asOf,
      ageSeconds,
      stale,
      partial,
      state: stateFor(
        basis,
        stale === true,
        hasError,
        hasWarn,
        !result.ok && lockedStatus(result.status),
      ),
      issues: panelIssues,
    });
    issues.push(...panelIssues);
  }

  const statusHealth = asObject(status.body?.["health"]);
  const service: DeskServiceHealth = {
    reachable: true,
    httpStatus: health.status,
    status: text(health.body?.["status"]),
    pid: numberOrNull(statusHealth?.["pid"]),
    uptimeSeconds:
      numberOrNull(health.body?.["uptimeSeconds"]) ??
      numberOrNull(statusHealth?.["uptimeSeconds"]),
    runtime: text(health.body?.["runtime"]),
  };

  const verdict = issues.some((issue) => issue.severity === "error")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "ok";
  const nextCommands = [
    ...new Set(
      issues
        .map((issue) => issue.nextCommand)
        .filter((command): command is string => command !== null),
    ),
  ];
  return {
    schemaVersion: DESK_HEALTH_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    baseUrl,
    service,
    panels,
    issues,
    verdict,
    nextCommands,
  };
}

/** Whether `--check` should fail. `strict` promotes warnings to failures. */
export function checkFailed(
  health: DeskHealth,
  options: { readonly strict?: boolean } = {},
): boolean {
  if (options.strict === true) return health.verdict !== "ok";
  return health.verdict === "fail";
}
