/**
 * GSLive Manager Tools session health.
 *
 * Session health uses the same wire path as {@link ensureGsid}: bootstrap via `signin`, then a
 * lightweight `ajax.php` POST (`getBetLog`). `partnerConfig/` can return HTTP 200 HTML for a live
 * cookie — that false negative is intentionally not used for health.
 *
 * This module answers one question for the dashboard: can the daemon still call manager ajax with
 * the configured cookie? It never returns, logs, hashes into the response, or journals the cookie
 * value. Only cookie *names*, the resolution source, and the probe classification leave.
 */
import { CookieMap } from "bun";

import { resolveManagerSessionGate } from "./manager_session.ts";
import { bootstrapGanchrowSession } from "../scripts/fetch-bet-tally.ts";
import { MANAGER_REFERER, MANAGER_USER_AGENT } from "./manager_fetch.ts";

/** Cookie-only v4 endpoint (documented in the surface map; not used for health probes). */
export const GSLIVE_PARTNER_CONFIG_URL =
  "https://plive.sportswidgets.pro/manager-tools/partnerConfig/" as const;

/** Same endpoint {@link probeGsliveSession} and `lib/gslive_auto_session.ts` verify against. */
export const GSLIVE_AJAX_PROBE_URL =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php" as const;

/** Reuse the cookie health for two minutes; the widget refreshes every 30s. */
export const GSLIVE_SESSION_PROBE_TTL_MS = 120_000;

export type GsliveProbeStatus =
  | "ok"
  | "expired"
  | "challenge"
  | "forbidden"
  | "throttled"
  | "unreachable"
  | "unconfigured";

/** How well a capability's v4 replacement is established. */
export type GsliveSurfaceStatus = "v4" | "listed" | "legacy" | "unverified";

export interface GsliveSurfaceRow {
  readonly capability: string;
  readonly legacy: string;
  readonly modern: string;
  readonly status: GsliveSurfaceStatus;
  readonly note: string;
}

/**
 * The legacy-vs-v4 map the widget shows. `v4` means a cookie-only GET was observed live on
 * 2026-11-04; `listed` means the repo already records the v4 URL but it was not re-measured in
 * this checkout; `legacy` means only the ajax.php action is known; `unverified` means the action
 * names have not been mapped one-for-one.
 */
export const GSLIVE_SURFACE_MAP: readonly GsliveSurfaceRow[] = [
  {
    capability: "Summary report",
    legacy: "POST ajax.php · action=getBetReport",
    modern: "GET /manager-tools/reports/?kind=summary-report",
    status: "v4",
    note: "Observed cookie-only on 2026-11-04; no x-gs-session header.",
  },
  {
    capability: "Users / all-state report",
    legacy: "POST ajax.php · action=getBetReport",
    modern: "GET /manager-tools/reports/?kind=users-report",
    status: "listed",
    note: "URL template is recorded in gslive_all_states_suspect_cron.ts:106; re-measure with a fresh cookie.",
  },
  {
    capability: "Partner config",
    legacy: "—",
    modern: "GET /manager-tools/partnerConfig/",
    status: "v4",
    note: "The cookie-only probe endpoint this card uses.",
  },
  {
    capability: "Report periods",
    legacy: "—",
    modern: "GET /manager-tools/reports/periods/index.php",
    status: "v4",
    note: "Observed cookie-only on 2026-11-04.",
  },
  {
    capability: "Per-bet log",
    legacy: "POST ajax.php · action=getBetLog",
    modern: "none known",
    status: "legacy",
    note: "The WebLog audit still needs it for every sampled bet.",
  },
  {
    capability: "Event timeline",
    legacy: "POST ajax.php · action=getEventLog",
    modern: "none known",
    status: "legacy",
    note: "Only needed when a report row carries an eventId.",
  },
  {
    capability: "Grading / market actions",
    legacy: "ajax.php action dispatcher",
    modern: "none verified",
    status: "unverified",
    note: "Legacy action names do not all map to the v4 build; verify per action.",
  },
  {
    capability: "Signin / session mint",
    legacy: "POST /api/v3/manager-tools/signin/ · {checkSession:true}",
    modern: "n/a — the GSID cookie authenticates v4 GETs",
    status: "legacy",
    note: "Mint x-gs-session per run for ajax.php only; never persist it.",
  },
];

export interface GsliveSessionProbe {
  readonly status: GsliveProbeStatus;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  readonly cfMitigated: string | null;
  readonly detail: string;
}

/** What the daemon resolved; `source` is provenance, never a credential. */
export interface GsliveSessionResolution {
  readonly source: string;
  readonly cookieHeader: string;
}

export interface GsliveSessionHealth {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly authModel: {
    readonly durable: "GSID cookie (browser-managed, HttpOnly)";
    readonly modern: "cookie-only GET /manager-tools/*";
    readonly legacy: "ajax.php POST needs x-gs-session from signin";
  };
  readonly session: {
    readonly configured: boolean;
    readonly source: string;
    readonly cookieName: "GSID";
    /** Cookie names only, so a full `GSID_COOKIE` header can be explained without values. */
    readonly cookieNames: readonly string[];
  };
  readonly probe: GsliveSessionProbe & { readonly cached: boolean };
  readonly surfaceMap: readonly GsliveSurfaceRow[];
  readonly advisory: string;
}

export interface GsliveProbeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Test seam: keychain `GSLIVE_GANCHROW_SESSION` / `GS_SESSION` resolution. */
  readonly readSessionGate?: () => Promise<string>;
}

const AUTH_MODEL = {
  durable: "GSID cookie (browser-managed, HttpOnly)",
  modern: "cookie-only GET /manager-tools/*",
  legacy: "ajax.php POST needs x-gs-session from signin",
} as const;

/** Cookie names from a header, never values. A malformed header yields an empty list. */
export function gsliveCookieNames(cookieHeader: string): readonly string[] {
  if (cookieHeader.trim() === "") return [];
  try {
    return [...new CookieMap(cookieHeader).keys()];
  } catch {
    return [];
  }
}

/** Pure classification for an `ajax.php` session probe (parity with `ensureGsid`). */
export function classifyAjaxSessionProbe(input: {
  readonly httpStatus: number;
  readonly body: string;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  readonly cfMitigated: string | null;
}): GsliveSessionProbe {
  const base = {
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    checkedAt: input.checkedAt,
    cfMitigated: input.cfMitigated,
  };
  const trimmed = input.body.trim();
  const loginSniff = trimmed.slice(0, 400);

  if (input.httpStatus >= 300 && input.httpStatus < 400) {
    return {
      ...base,
      status: "expired",
      detail: "ajax.php redirected — the GSID cookie is expired.",
    };
  }
  if (input.httpStatus === 401) {
    return {
      ...base,
      status: "expired",
      detail: "ajax.php rejected the session (HTTP 401).",
    };
  }
  if (input.httpStatus === 403) {
    return input.cfMitigated !== null
      ? {
          ...base,
          status: "challenge",
          detail: `Cloudflare challenge (cf-mitigated: ${input.cfMitigated}) — human login required.`,
        }
      : {
          ...base,
          status: "forbidden",
          detail: "Forbidden (HTTP 403) — the cookie is valid but lacks access.",
        };
  }
  if (input.httpStatus === 429) {
    return {
      ...base,
      status: "throttled",
      detail: "ajax.php is rate-limiting this host (HTTP 429).",
    };
  }
  if (input.httpStatus >= 500) {
    return {
      ...base,
      status: "unreachable",
      detail: `ajax.php returned HTTP ${input.httpStatus}.`,
    };
  }
  if (input.httpStatus >= 200 && input.httpStatus < 300) {
    if (
      trimmed === "" ||
      trimmed.startsWith("<") ||
      !trimmed.startsWith("{") ||
      /login|unauthor|forbidden/i.test(loginSniff)
    ) {
      return {
        ...base,
        status: "expired",
        detail: "ajax.php returned a login HTML page instead of JSON.",
      };
    }
    try {
      JSON.parse(trimmed);
      return {
        ...base,
        status: "ok",
        detail: "Cookie accepted by ajax.php getBetLog probe.",
      };
    } catch {
      return {
        ...base,
        status: "expired",
        detail: "ajax.php returned non-JSON — likely the login HTML page.",
      };
    }
  }
  return {
    ...base,
    status: "forbidden",
    detail: `Unexpected HTTP ${input.httpStatus} from ajax.php.`,
  };
}

/**
 * One probe: bootstrap `x-gs-session`, then POST `getBetLog` — same contract as `ensureGsid`.
 */
export async function probeGsliveSession(
  cookieHeader: string,
  options: GsliveProbeOptions = {},
): Promise<GsliveSessionProbe> {
  const now = options.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  if (cookieHeader.trim() === "") {
    return {
      status: "unconfigured",
      httpStatus: null,
      latencyMs: null,
      checkedAt,
      cfMitigated: null,
      detail: "No GSID configured — set GSLIVE_SESSION_ID or GSID_COOKIE.",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const started = now();
  const readGate = options.readSessionGate ?? resolveManagerSessionGate;
  let sessionGate = await readGate();
  if (sessionGate === "") {
    try {
      sessionGate = await bootstrapGanchrowSession({
        cookieHeader,
        fetchImpl,
        timeoutMs,
      });
    } catch {
      return {
        status: "expired",
        httpStatus: 401,
        latencyMs: Math.max(0, now() - started),
        checkedAt,
        cfMitigated: null,
        detail:
          "signin bootstrap failed — provision GSID and GSLIVE_GANCHROW_SESSION (x-gs-session).",
      };
    }
  }

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader,
      referer: MANAGER_REFERER,
      "user-agent": MANAGER_USER_AGENT,
    };
    if (sessionGate !== "") headers["x-gs-session"] = sessionGate;

    const response = await fetchImpl(GSLIVE_AJAX_PROBE_URL, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        action: "getBetLog",
        betId: "0",
        partnerId: "118",
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.max(0, now() - started);
    const cfMitigated = response.headers.get("cf-mitigated");
    const body = await response.text().catch(() => "");

    return classifyAjaxSessionProbe({
      httpStatus: response.status,
      body,
      latencyMs,
      checkedAt,
      cfMitigated,
    });
  } catch (error) {
    return {
      status: "unreachable",
      httpStatus: null,
      latencyMs: Math.max(0, now() - started),
      checkedAt,
      cfMitigated: null,
      detail:
        error instanceof Error && error.name === "TimeoutError"
          ? "Timed out waiting for ajax.php."
          : "No response from ajax.php (network, DNS or TLS).",
    };
  }
}

/** Pure classification over the probe response; exported for the unit tests. */
export function classifyProbe(input: {
  readonly httpStatus: number;
  readonly contentType: string;
  readonly cfMitigated: string | null;
  readonly body: string;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
}): GsliveSessionProbe {
  const base = {
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    checkedAt: input.checkedAt,
    cfMitigated: input.cfMitigated,
  };

  if (input.httpStatus >= 300 && input.httpStatus < 400) {
    return {
      ...base,
      status: "expired",
      detail: "Manager Tools redirected — the GSID cookie is expired.",
    };
  }
  if (input.httpStatus === 401) {
    return {
      ...base,
      status: "expired",
      detail: "Manager Tools rejected the session (HTTP 401).",
    };
  }
  if (input.httpStatus === 403) {
    return input.cfMitigated !== null
      ? {
          ...base,
          status: "challenge",
          detail: `Cloudflare challenge (cf-mitigated: ${input.cfMitigated}) — human login required.`,
        }
      : {
          ...base,
          status: "forbidden",
          detail:
            "Forbidden (HTTP 403) — the cookie is valid but lacks access.",
        };
  }
  if (input.httpStatus === 429) {
    return {
      ...base,
      status: "throttled",
      detail: "Manager Tools is rate-limiting this host (HTTP 429).",
    };
  }
  if (input.httpStatus >= 500) {
    return {
      ...base,
      status: "unreachable",
      detail: `Manager Tools returned HTTP ${input.httpStatus}.`,
    };
  }
  if (input.httpStatus >= 200 && input.httpStatus < 300) {
    if (!input.contentType.toLowerCase().includes("json")) {
      return {
        ...base,
        status: "expired",
        detail: "HTTP 200 with a non-JSON body — the login HTML page.",
      };
    }
    try {
      JSON.parse(input.body);
      return {
        ...base,
        status: "ok",
        detail: "Cookie accepted by the cookie-only partnerConfig endpoint.",
      };
    } catch {
      return {
        ...base,
        status: "expired",
        detail: "HTTP 200 with invalid JSON — the login HTML page.",
      };
    }
  }
  return {
    ...base,
    status: "forbidden",
    detail: `Unexpected HTTP ${input.httpStatus} from Manager Tools.`,
  };
}

export function gsliveSessionAdvisory(status: GsliveProbeStatus): string {
  switch (status) {
    case "ok":
      return "v4 GETs need only the cookie; no signin handshake is held.";
    case "expired":
      return "Re-export the GSID cookie from a signed-in browser, then re-probe.";
    case "challenge":
      return "Clear the Cloudflare challenge in a browser, then re-export the cookie.";
    case "forbidden":
      return "Check Manager Tools access for the account; re-export if the cookie is stale.";
    case "throttled":
      return "Wait for the rate limit to clear; the probe is cached for two minutes.";
    case "unreachable":
      return "Check daemon egress; the next cached probe retries automatically.";
    case "unconfigured":
      return "Provision GSLIVE_SESSION_ID through the SSOT, or set GSID_COOKIE.";
  }
}

function healthFor(
  resolution: GsliveSessionResolution,
  probe: GsliveSessionProbe,
  cached: boolean,
  generatedAt: string,
): GsliveSessionHealth {
  return {
    schemaVersion: 1,
    generatedAt,
    authModel: AUTH_MODEL,
    session: {
      configured: resolution.cookieHeader.trim() !== "",
      source: resolution.source,
      cookieName: "GSID",
      cookieNames: gsliveCookieNames(resolution.cookieHeader),
    },
    probe: { ...probe, cached },
    surfaceMap: GSLIVE_SURFACE_MAP,
    advisory: gsliveSessionAdvisory(probe.status),
  };
}

export interface GsliveSessionMonitorOptions {
  readonly resolveSession: () => Promise<GsliveSessionResolution>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly readSessionGate?: () => Promise<string>;
}

export interface GsliveSessionMonitor {
  /** `force` skips the cache; the widget's normal refresh stays on the cached probe. */
  read(force?: boolean): Promise<GsliveSessionHealth>;
  /** Drop the cached partnerConfig probe (after a GSID rotation). */
  clearProbeCache(): void;
}

/**
 * One cached probe per cookie. The cache key is a hash of the header and never leaves this
 * closure; a rotated cookie misses immediately, so a healthy old result cannot mask a dead one.
 */
export function createGsliveSessionMonitor(
  options: GsliveSessionMonitorOptions,
): GsliveSessionMonitor {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GSLIVE_SESSION_PROBE_TTL_MS;
  let cached: {
    readonly key: string;
    readonly at: number;
    readonly probe: GsliveSessionProbe;
  } | null = null;

  return {
    async read(force = false): Promise<GsliveSessionHealth> {
      const nowMs = now();
      const generatedAt = new Date(nowMs).toISOString();
      const resolution = await options.resolveSession();
      if (resolution.cookieHeader.trim() === "") {
        const probe = await probeGsliveSession(
          "",
          options.now === undefined ? {} : { now: options.now },
        );
        return healthFor(resolution, probe, false, generatedAt);
      }

      const key = Bun.hash(resolution.cookieHeader).toString(16);
      if (
        !force &&
        cached !== null &&
        cached.key === key &&
        nowMs - cached.at < ttlMs
      ) {
        return healthFor(resolution, cached.probe, true, generatedAt);
      }

      const probe = await probeGsliveSession(resolution.cookieHeader, {
        ...(options.fetchImpl !== undefined
          ? { fetchImpl: options.fetchImpl }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        ...(options.readSessionGate !== undefined
          ? { readSessionGate: options.readSessionGate }
          : {}),
      });
      cached = { key, at: nowMs, probe };
      return healthFor(resolution, probe, false, generatedAt);
    },
    clearProbeCache() {
      cached = null;
    },
  };
}
