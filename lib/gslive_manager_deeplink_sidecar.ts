/**
 * @file lib/gslive_manager_deeplink_sidecar.ts
 * @description Canonical GSLive Manager (`https://plive.sportswidgets.pro/manager-tools/`)
 *              7-Parameter `#/reports/users` Deep-Link Builder & `#/events/bet-history` Live Event Sidecar.
 *
 * Solves two distinct operator visibility gaps in GSLive Manager (Partner 118):
 *
 * 1. Why naive `#/reports/users` links fail to show rows (and how the 7-parameter deep link fixes it):
 *    - Naive link: `#/reports/users?partnerId=118&searchBy=player&text=player_CHURN_003`
 *    - Problem A (`bot` filter): The SPA defaults to `bot=false` ("Bot report: No"), which hides
 *      syndicate/automated/bot-flagged accounts (`player_CHURN_003`, `player_MJ102`, `player_NOISE_BOT_77`).
 *      Passing `bot=true` forces the Bot switch ON.
 *    - Problem B (`from` / `to` UTC CDT day-boundary ISO strings & `eventId=`): Without explicit
 *      `05:00:00.000Z` (00:00:00 CDT, UTC-5) to `04:59:59.000Z` (23:59:59 CDT) ISO bounds and `eventId=`,
 *      the SPA initializes an empty or stale single-day window (`Total records: 0`).
 *    - Canonical 7-Parameter Deep Link:
 *      `https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59%3A59.000Z`
 *
 * 2. Why you ALSO need the `#/events/bet-history` Live Sidecar (`calcTime` / `betTime`):
 *    - `#/reports/users` is an account-level aggregate report with batch lag (`Last data update`).
 *    - `#/events/bet-history` (which backs `action: "getBetReport"`) is the real-time event/ticket stream.
 *    - Canonical Live Sidecar URL:
 *      `https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1793469958152`
 *      where:
 *        • `from=1793422800` & `to=1793422800` = `2026-10-31T05:00:00.000Z` (`00:00:00 CDT` start of day in epoch seconds)
 *        • `toTime=86399` = `+23h 59m 59s` (`23:59:59 CDT` end of day). This is the *offset within
 *          the desk day*, so it is `89999` on the 25-hour fall-back day and `82799` on the
 *          23-hour spring-forward day — always derive it, never hardcode it.
 *        • `minVolume=0` & `maxTimeUntilScore=0` = zero volume/score-time filtering so all live wagers appear immediately
 *        • `dateFilterBy=calcTime` (live settling/populating events) or `betTime` (live placement stream)
 *        • `t=<epochMs>` = monotonic cache-buster timestamp; defaults to `Date.now()` (never a constant).
 *
 * 3. Canceled-ticket view (observed 2026-11-03 in the operator console):
 *    `#/events/bet-history?partnerUserId=ccc107&state=canceled&minVolume=0&maxTimeUntilScore=0&from=1793163600&to=1793685600&toTime=86399&dateFilterBy=calcTime&t=…`
 *    `from`/`to` are the starts of two desk days 6 days apart (Oct 28 05:00Z → Nov 3 06:00Z, i.e.
 *    the window spans the CDT→CST change), `toTime` is the last second of the end day, and
 *    `state` is the hash route's filter. Only `""` and `canceled` have been observed; the
 *    `getBetReport` payload's `state` field is left `""` because that payload was not observed
 *    carrying a state filter.
 */

export const GSLIVE_MANAGER_BASE_URL =
  "https://plive.sportswidgets.pro/manager-tools/";

/** Chicago (Partner 118 desk) timezone — day windows are operator-local, not UTC. */
export const GSLIVE_DESK_TIME_ZONE = "America/Chicago";

/**
 * Desk-zone formatters, built once. `new Intl.DateTimeFormat` costs ~20 us (measured
 * 2026-11-04) while a shared instance costs ~1 us per `formatToParts`, and these helpers
 * run per day boundary and per resolved "today".
 */
const DESK_OFFSET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: GSLIVE_DESK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const DESK_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: GSLIVE_DESK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Inclusive historical churn-study window used by the CHURN_* cohort analysis. */
const GSLIVE_CHURN_WINDOW = {
  fromYmd: "2026-10-18",
  toYmd: "2026-10-25",
} as const;

export interface GsLiveUsersReportDeepLinkOptions {
  readonly customerLogin: string; // e.g., "CHURN_003", "MJ102", "player_CHURN_003"
  readonly bot?: boolean; // default: true (critical so bot/syndicate accounts are not hidden!)
  readonly eventId?: string; // default: ""
  readonly fromIsoUtc?: string; // default: start of a rolling 14-day desk window ending today
  readonly toIsoUtc?: string; // default: end of today (desk timezone)
  readonly partnerId?: string | number; // default: 118
  readonly searchBy?: "player" | "agent"; // default: "player"
}

/**
 * `state` filter on the GSLive Manager `#/events/bet-history` SPA route. The values are the
 * shipped bundle's `state-select` options (`assets/index-DB17VVxN.js`, read 2026-11-03) — the
 * set is the SPA's own vocabulary rather than a guess, and `""` is "All".
 */
export const GSLIVE_BET_HISTORY_STATES = [
  "",
  "pending",
  "win",
  "lose",
  "action",
  "canceled",
  "rejected",
  "bad-credit",
  "payment-failed",
  "eco",
  "unknown",
] as const;
export type GsLiveBetHistoryState = (typeof GSLIVE_BET_HISTORY_STATES)[number];

/** "Group Kind" options from the same bundle's `group-kind-select`. */
export const GSLIVE_GROUP_KINDS = [
  "player",
  "agent",
  "custom",
  "line-type",
] as const;
export type GsLiveGroupKind = (typeof GSLIVE_GROUP_KINDS)[number];

/**
 * URL-expressible `#/events/bet-history` filters beyond date/state/player. Read from the same
 * shipped bundle: the route parses only the whitelisted query names, and the grid's "Filters"
 * tool panel is client-side AG Grid state with no URL representation — "Bet price" is a hidden
 * AG Grid column (`agNumberColumnFilter` over `fVal_new`), so it cannot be a deep-link filter.
 */
export interface GsLiveBetHistoryUrlFilters {
  readonly agent?: string;
  /** Bet ids; the SPA strips a leading `b` from each id and space-joins them. */
  readonly betId?: string;
  /** Bet-group ids; the SPA strips a leading `g` from each id and space-joins them. */
  readonly betGroupId?: string;
  readonly freeBetId?: string;
  /** "Group Kind", serialised as the SPA's `kind` query name. */
  readonly kind?: GsLiveGroupKind;
  readonly groupName?: string;
  /** Period id; the SPA keeps the first `-`-separated segment (e.g. `s3`). */
  readonly period?: string;
  /** Sport id (`sId`); `"-1"` is "all sports" and serialises to no filter. */
  readonly sportId?: string | number;
  /** Market ids (`mId`); the SPA comma-joins them. */
  readonly marketIds?: string | readonly string[];
}

export interface GsLiveBetHistorySidecarOptions {
  readonly minVolume?: number; // default: 0
  readonly maxTimeUntilScore?: number; // default: 0
  readonly dateYmd?: string; // desk day; derives from/to and the DST-aware toTime
  readonly fromEpochSec?: number; // default: desk day start (05:00Z CDT / 06:00Z CST)
  readonly toEpochSec?: number; // default: same as fromEpochSec
  readonly toTimeSec?: number; // default: last second of the desk day (86399, or 89999/82799 on DST days)
  readonly dateFilterBy?: "calcTime" | "betTime"; // default: "calcTime"
  readonly tickEpochMs?: number; // default: Date.now() — always pass a fresh tick in loops
  readonly customerLogin?: string; // optional per-player filter
  readonly state?: GsLiveBetHistoryState; // optional SPA state filter; default "" (all)
  readonly eventId?: string; // optional eventId filter
  readonly filters?: GsLiveBetHistoryUrlFilters; // the remaining URL-expressible Filters-panel values
}

/**
 * Normalizes any Fantasy402 login or `player_` string to the canonical `player_<UPPERCASE_ID>` format.
 */
export function formatGsLivePlayerToken(rawLogin: string): string {
  const clean = rawLogin
    .trim()
    .replace(/^player_/i, "")
    .replace(/\s+/g, "")
    .replace(/^\.|\.$/g, "")
    .toUpperCase();
  return `player_${clean}`;
}

/**
 * Raw partner account id used by the `#/events/bet-history` filter.
 * The live console emits `partnerUserId=AF12`, not `partnerUserId=player_AF12`; the `player_`
 * prefix belongs to the `#/reports/users` `text=` filter.
 */
export function formatGsLivePartnerUserId(rawLogin: string): string {
  return formatGsLivePlayerToken(rawLogin).replace(/^player_/, "");
}

/**
 * Offset (ms) of desk-local wall time from UTC at a given instant, e.g. `-5h` during CDT
 * and `-6h` during CST. Derived from Intl so US DST transitions are handled automatically.
 */
function deskOffsetMsAt(instantMs: number): number {
  const parts = DESK_OFFSET_FORMAT.formatToParts(new Date(instantMs));
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = part("hour") % 24; // some engines render midnight as 24
  const asIfUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    hour,
    part("minute"),
    part("second"),
  );
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Portal wall-clock (`getBetTicker` `InsertDateTime`, `Report/Pending` `acceptedAt`) → ISO UTC.
 *
 * The wire carries no zone; the desk writes America/Chicago time. An explicit zone is already
 * an instant. Returns `null` for empty or unparseable values rather than guessing.
 */
export function portalWallClockIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = Date.parse(text);
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const wall =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      text,
    );
  if (wall === null) {
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const [, year, month, day, hour, minute, second = "00", fraction = "0"] =
    wall;
  const wallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0")),
  );
  // Two passes, same as computeDeskDayStartEpochSeconds: DST can change between guesses.
  const firstGuess = wallMs - deskOffsetMsAt(wallMs);
  const resolved = wallMs - deskOffsetMsAt(firstGuess);
  return new Date(resolved).toISOString();
}

/**
 * UTC epoch seconds for `00:00:00` on a desk calendar day. DST-aware: returns `05:00Z` under
 * CDT and `06:00Z` under CST. Never hardcode the offset — it changes on the DST transitions.
 */
export function computeDeskDayStartEpochSeconds(dateYmd: string): number {
  const [y, m, d] = dateYmd.split("-").map(Number);
  if (!y || !m || !d) {
    return Math.floor(Date.now() / 1000);
  }
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Two passes: sample the offset near the target, then re-sample at the resolved instant.
  const firstGuess = naiveUtc - deskOffsetMsAt(naiveUtc);
  const resolved = naiveUtc - deskOffsetMsAt(firstGuess);
  return Math.floor(resolved / 1000);
}

/** Number of seconds in a desk calendar day (86399 normally, 89999/82799 on DST transition days). */
export function computeDeskDayLengthSeconds(dateYmd: string): number {
  return (
    computeDeskDayStartEpochSeconds(addDaysYmd(dateYmd, 1)) -
    computeDeskDayStartEpochSeconds(dateYmd)
  );
}

/** End-of-day offset (`toTime`) for a desk calendar day: `86399` on normal days. */
export function computeDeskDayToTimeSeconds(dateYmd: string): number {
  return computeDeskDayLengthSeconds(dateYmd) - 1;
}

/**
 * @deprecated Use {@link computeDeskDayStartEpochSeconds}. Kept as an alias for existing callers;
 * this helper is DST-aware, so the `Cdt` name no longer describes its behaviour.
 */
export function computeCdtDayStartEpochSeconds(dateYmd = "2026-10-31"): number {
  return computeDeskDayStartEpochSeconds(dateYmd);
}

/**
 * Resolves the operator's current calendar date (`YYYY-MM-DD`) in the desk timezone.
 * Never derive "today" from `Date#toISOString()` — that is UTC and rolls at 19:00/20:00 desk time.
 */
export function resolveDeskDateYmd(now: Date = new Date()): string {
  const parts = DESK_YMD_FORMAT.formatToParts(now);
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Adds (or subtracts) whole calendar days to a `YYYY-MM-DD` string. */
export function addDaysYmd(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split("-").map(Number);
  if (!y || !m || !d) return dateYmd;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * ISO UTC instant for the first (`00:00:00`) or last (`23:59:59`, DST-aware) second of a desk day.
 */
export function deskDayBoundaryIso(
  dateYmd: string,
  boundary: "start" | "end",
): string {
  const startEpoch = computeDeskDayStartEpochSeconds(dateYmd);
  const endEpoch =
    boundary === "end"
      ? computeDeskDayStartEpochSeconds(addDaysYmd(dateYmd, 1)) - 1
      : startEpoch;
  return new Date(endEpoch * 1000).toISOString();
}

/** Inclusive day window ending on `dateYmd` (e.g. `windowDays=14` covers date-13 .. date). */
export function deskWindowIso(
  dateYmd: string,
  windowDays: number,
): { fromIso: string; toIso: string } {
  const span = Math.max(1, Math.trunc(windowDays));
  return {
    fromIso: deskDayBoundaryIso(addDaysYmd(dateYmd, -(span - 1)), "start"),
    toIso: deskDayBoundaryIso(dateYmd, "end"),
  };
}

/**
 * Builds the exact 7-parameter `#/reports/users` deep link matching GSLive Manager's router state:
 * `https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59%3A59.000Z`
 */
export function buildGsLiveUsersReportDeepLink(
  options: GsLiveUsersReportDeepLinkOptions,
): string {
  const bot = options.bot ?? true;
  const eventId = options.eventId ?? "";
  const todayYmd = resolveDeskDateYmd();
  const rolling = deskWindowIso(todayYmd, 14);
  const fromIso = options.fromIsoUtc ?? rolling.fromIso;
  const toIso = options.toIsoUtc ?? rolling.toIso;
  const partnerId = String(options.partnerId ?? 118);
  const searchBy = options.searchBy ?? "player";
  const playerText =
    searchBy === "player"
      ? formatGsLivePlayerToken(options.customerLogin)
      : options.customerLogin.trim().toUpperCase();

  // Preserve exact key order and %3A encoding expected by GSLive Manager SPA router
  const query = [
    `bot=${bot ? "true" : "false"}`,
    `eventId=${encodeURIComponent(eventId)}`,
    `from=${encodeURIComponent(fromIso)}`,
    `partnerId=${encodeURIComponent(partnerId)}`,
    `searchBy=${encodeURIComponent(searchBy)}`,
    `text=${encodeURIComponent(playerText)}`,
    `to=${encodeURIComponent(toIso)}`,
  ].join("&");

  return `${GSLIVE_MANAGER_BASE_URL}#/reports/users?${query}`;
}

/**
 * Bet-id list the way the SPA serialises it: whitespace/comma separated tokens, a leading `b`
 * (betId) or `g` (betGroupId) stripped when the rest is numeric, de-duplicated, space-joined.
 */
function normalizeGsLiveBetIdList(raw: string, prefix: "b" | "g"): string {
  const strip = new RegExp(`^${prefix}(?=[0-9]*$)`, "i");
  return Array.from(
    new Set(
      String(raw)
        .split(/[\s,]+/)
        .map((token) => token.trim())
        .filter((token) => token !== "")
        .map((token) => token.replace(strip, "")),
    ),
  ).join(" ");
}

/** Market-id list the way the SPA serialises it: de-duplicated, comma-joined. */
function normalizeGsLiveMarketIds(raw: string | readonly string[]): string {
  const parts = typeof raw === "string" ? raw.split(/[\s,]+/) : raw.map(String);
  return Array.from(
    new Set(parts.map((part) => part.trim()).filter((part) => part !== "")),
  ).join(",");
}

/**
 * Builds the `#/events/bet-history` Live Populating Stream Sidecar URL:
 * `https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1793469958152`
 */
export function buildGsLiveBetHistorySidecarUrl(
  options?: GsLiveBetHistorySidecarOptions,
): string {
  const minVolume = options?.minVolume ?? 0;
  const maxTimeUntilScore = options?.maxTimeUntilScore ?? 0;
  const dateYmd = options?.dateYmd ?? resolveDeskDateYmd();
  const fromEpoch =
    options?.fromEpochSec ?? computeDeskDayStartEpochSeconds(dateYmd);
  const toEpoch = options?.toEpochSec ?? fromEpoch;
  const toTime = options?.toTimeSec ?? computeDeskDayToTimeSeconds(dateYmd);
  const dateFilterBy = options?.dateFilterBy ?? "calcTime";
  const tickMs = options?.tickEpochMs ?? Date.now();

  const params: string[] = [
    `minVolume=${minVolume}`,
    `maxTimeUntilScore=${maxTimeUntilScore}`,
    `from=${fromEpoch}`,
    `to=${toEpoch}`,
    `toTime=${toTime}`,
    `dateFilterBy=${encodeURIComponent(dateFilterBy)}`,
    `t=${tickMs}`,
  ];

  if (options?.customerLogin) {
    params.push(
      `partnerUserId=${encodeURIComponent(formatGsLivePartnerUserId(options.customerLogin))}`,
    );
  }
  if (options?.state) {
    params.push(`state=${encodeURIComponent(options.state)}`);
  }
  if (options?.eventId) {
    params.push(`eventId=${encodeURIComponent(options.eventId)}`);
  }

  const filters = options?.filters;
  if (filters) {
    if (filters.agent?.trim()) {
      params.push(`agent=${encodeURIComponent(filters.agent.trim())}`);
    }
    if (filters.betId !== undefined) {
      const betId = normalizeGsLiveBetIdList(filters.betId, "b");
      if (betId !== "") params.push(`betId=${encodeURIComponent(betId)}`);
    }
    if (filters.betGroupId !== undefined) {
      const betGroupId = normalizeGsLiveBetIdList(filters.betGroupId, "g");
      if (betGroupId !== "") {
        params.push(`betGroupId=${encodeURIComponent(betGroupId)}`);
      }
    }
    if (filters.freeBetId?.trim()) {
      params.push(`freeBetId=${encodeURIComponent(filters.freeBetId.trim())}`);
    }
    if (filters.kind !== undefined) {
      if (!GSLIVE_GROUP_KINDS.includes(filters.kind)) {
        throw new Error(
          `filters.kind must be one of ${GSLIVE_GROUP_KINDS.join(", ")}, got ${JSON.stringify(filters.kind)}`,
        );
      }
      params.push(`kind=${encodeURIComponent(filters.kind)}`);
    }
    if (filters.groupName?.trim()) {
      params.push(`groupName=${encodeURIComponent(filters.groupName.trim())}`);
    }
    if (filters.period?.trim()) {
      const period = filters.period.trim().split("-")[0] ?? "";
      if (period !== "") params.push(`period=${encodeURIComponent(period)}`);
    }
    if (filters.sportId !== undefined) {
      const sportId = String(filters.sportId).trim();
      // "-1" is the SPA's "all sports" sentinel; omit the filter rather than encode it.
      if (sportId !== "" && sportId !== "-1") {
        params.push(`sId=${encodeURIComponent(sportId)}`);
      }
    }
    if (filters.marketIds !== undefined) {
      const marketIds = normalizeGsLiveMarketIds(filters.marketIds);
      if (marketIds !== "") {
        params.push(`mId=${encodeURIComponent(marketIds)}`);
      }
    }
  }

  return `${GSLIVE_MANAGER_BASE_URL}#/events/bet-history?${params.join("&")}`;
}

/**
 * All GSLive Manager surfaces for one account, generated from the canonical builders above.
 * This is the only supported way to produce per-account links — do not hand-build URLs elsewhere.
 */
export interface GsLiveManagerSurfaceUrls {
  readonly gsLivePlayerId: string;
  readonly playerReportUrl: string;
  readonly bettorReportUrl: string;
  readonly openBetReportUrl: string;
  readonly betHistoryUrl: string;
  readonly summaryByPlayerUrl: string;
}

export function buildGsLiveManagerSurfaceUrls(options: {
  readonly customerLogin: string;
  readonly dateYmd?: string;
  readonly tickEpochMs?: number;
  readonly reportWindowDays?: number;
  readonly dateFilterBy?: "calcTime" | "betTime";
}): GsLiveManagerSurfaceUrls {
  const dateYmd = options.dateYmd ?? resolveDeskDateYmd();
  const tickEpochMs = options.tickEpochMs ?? Date.now();
  const window = deskWindowIso(dateYmd, options.reportWindowDays ?? 14);
  const playerReportUrl = buildGsLiveUsersReportDeepLink({
    customerLogin: options.customerLogin,
    bot: true,
    eventId: "",
    fromIsoUtc: window.fromIso,
    toIsoUtc: window.toIso,
    partnerId: 118,
    searchBy: "player",
  });
  const dayStart = computeDeskDayStartEpochSeconds(dateYmd);

  return {
    gsLivePlayerId: formatGsLivePlayerToken(options.customerLogin),
    playerReportUrl,
    // Same router query as the verified user report; only the report route differs.
    bettorReportUrl: playerReportUrl.replace(
      "#/reports/users?",
      "#/reports/bettor?",
    ),
    openBetReportUrl: playerReportUrl.replace(
      "#/reports/users?",
      "#/reports/open-bets?",
    ),
    betHistoryUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      dateYmd,
      fromEpochSec: dayStart,
      toEpochSec: dayStart,
      dateFilterBy: options.dateFilterBy ?? "calcTime",
      tickEpochMs,
      customerLogin: options.customerLogin,
    }),
    summaryByPlayerUrl: playerReportUrl.replace(
      "#/reports/users?",
      "#/reports/summary?",
    ),
  };
}

export interface GsLiveDualSurfaceDescriptor {
  readonly customerLogin: string;
  readonly gsLivePlayerId: string;
  readonly usersReportDeepLink7Day: string;
  readonly usersReportDeepLink14Day: string;
  readonly usersReportChurnWindowDeepLink: string;
  readonly liveBetHistorySidecarCalcTimeUrl: string;
  readonly liveBetHistorySidecarBetTimeUrl: string;
  readonly playerBetHistoryDeepLinkUrl: string;
  /** Desk days in the per-player bet-history window that `playerBetHistoryDeepLinkUrl` covers. */
  readonly playerBetHistoryWindowDays: number;
  /** Same window with `state=canceled`: the observed canceled-ticket view (2026-11-03). */
  readonly playerCanceledBetHistoryDeepLinkUrl: string;
  readonly getBetReportObservedPayload: {
    readonly action: "getBetReport";
    readonly partnerUserId: string;
    readonly agent: string;
    readonly eventId: string;
    readonly freeBetId: string;
    readonly state: string;
    readonly sId: "2";
    readonly minVolume: "0";
    readonly maxTimeUntilScore: "0";
    readonly mId: string;
    readonly from: number;
    readonly fromTime: 0;
    readonly to: number;
    readonly toTime: number;
    readonly betId: string;
    readonly betGroupId: string;
    readonly group: null;
    readonly dateFilterBy: "calcTime" | "betTime";
    readonly partnerIds: string;
    readonly period: "s3";
  };
}

/**
 * Builds the complete Dual-Surface GSLive descriptor for any account (e.g., `CHURN_003`, `MJ102`, `BGD101`),
 * combining the 7-parameter `#/reports/users` deep links with the `#/events/bet-history` live sidecar URLs.
 * The 7-day / 14-day windows are rolling and end on `dateYmd` (desk timezone, today by default).
 * `windowDays` widens the per-player bet-history window (e.g. 7 for `from`=date-6 … `to`=date) and
 * `state` filters it; `playerCanceledBetHistoryDeepLinkUrl` always carries `state=canceled`.
 */
export function buildGsLiveDualSurfaceDescriptor(
  customerLogin: string,
  options?: {
    dateYmd?: string;
    tickEpochMs?: number;
    /** Desk days in the per-player bet-history window, ending on `dateYmd` (1-31, default 1). */
    windowDays?: number;
    /** SPA state filter for the per-player bet-history links (default "" = all tickets). */
    state?: GsLiveBetHistoryState;
    /** Remaining URL-expressible Filters-panel values for the per-player links. */
    filters?: GsLiveBetHistoryUrlFilters;
  },
): GsLiveDualSurfaceDescriptor {
  const gsLivePlayerId = formatGsLivePlayerToken(customerLogin);
  const cleanLogin = gsLivePlayerId.replace(/^player_/, "");
  const dateYmd = options?.dateYmd ?? resolveDeskDateYmd();
  const windowDays = Math.min(
    31,
    Math.max(1, Math.trunc(options?.windowDays ?? 1)),
  );
  const betHistoryState = options?.state ?? "";
  const dayStartEpoch = computeDeskDayStartEpochSeconds(dateYmd);
  const windowFromEpoch = computeDeskDayStartEpochSeconds(
    addDaysYmd(dateYmd, -(windowDays - 1)),
  );
  const dayEndEpoch =
    computeDeskDayStartEpochSeconds(addDaysYmd(dateYmd, 1)) - 1;
  const dayToTimeSeconds = computeDeskDayToTimeSeconds(dateYmd);
  const tickMs = options?.tickEpochMs ?? Date.now();
  const window7 = deskWindowIso(dateYmd, 7);
  const window14 = deskWindowIso(dateYmd, 14);

  return {
    customerLogin: cleanLogin,
    gsLivePlayerId,
    usersReportDeepLink7Day: buildGsLiveUsersReportDeepLink({
      customerLogin: cleanLogin,
      bot: true,
      eventId: "",
      fromIsoUtc: window7.fromIso,
      toIsoUtc: window7.toIso,
      partnerId: 118,
      searchBy: "player",
    }),
    usersReportDeepLink14Day: buildGsLiveUsersReportDeepLink({
      customerLogin: cleanLogin,
      bot: true,
      eventId: "",
      fromIsoUtc: window14.fromIso,
      toIsoUtc: window14.toIso,
      partnerId: 118,
      searchBy: "player",
    }),
    usersReportChurnWindowDeepLink: buildGsLiveUsersReportDeepLink({
      customerLogin: cleanLogin,
      bot: true,
      eventId: "",
      fromIsoUtc: deskDayBoundaryIso(GSLIVE_CHURN_WINDOW.fromYmd, "start"),
      toIsoUtc: deskDayBoundaryIso(GSLIVE_CHURN_WINDOW.toYmd, "end"),
      partnerId: 118,
      searchBy: "player",
    }),
    liveBetHistorySidecarCalcTimeUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      dateYmd,
      fromEpochSec: dayStartEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: dayToTimeSeconds,
      dateFilterBy: "calcTime",
      tickEpochMs: tickMs,
    }),
    liveBetHistorySidecarBetTimeUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      dateYmd,
      fromEpochSec: dayStartEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: dayToTimeSeconds,
      dateFilterBy: "betTime",
      tickEpochMs: tickMs,
    }),
    playerBetHistoryDeepLinkUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      dateYmd,
      fromEpochSec: windowFromEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: dayToTimeSeconds,
      dateFilterBy: "calcTime",
      tickEpochMs: tickMs,
      customerLogin: cleanLogin,
      state: betHistoryState,
      ...(options?.filters ? { filters: options.filters } : {}),
    }),
    playerBetHistoryWindowDays: windowDays,
    playerCanceledBetHistoryDeepLinkUrl: buildGsLiveBetHistorySidecarUrl({
      minVolume: 0,
      maxTimeUntilScore: 0,
      dateYmd,
      fromEpochSec: windowFromEpoch,
      toEpochSec: dayStartEpoch,
      toTimeSec: dayToTimeSeconds,
      dateFilterBy: "calcTime",
      tickEpochMs: tickMs,
      customerLogin: cleanLogin,
      state: "canceled",
      ...(options?.filters ? { filters: options.filters } : {}),
    }),
    getBetReportObservedPayload: {
      action: "getBetReport",
      partnerUserId: cleanLogin,
      agent: "",
      eventId: "",
      freeBetId: "",
      state: "",
      sId: "2",
      minVolume: "0",
      maxTimeUntilScore: "0",
      mId: "",
      from: dayStartEpoch,
      fromTime: 0,
      // Wire observation: `to` is the inclusive end epoch. The hash URL instead passes
      // to=<dayStart>&toTime=<desk day length - 1>; both encode the same desk-day end.
      to: dayEndEpoch,
      toTime: dayToTimeSeconds,
      betId: "",
      betGroupId: "",
      group: null,
      dateFilterBy: "calcTime",
      partnerIds: "",
      period: "s3",
    },
  };
}
