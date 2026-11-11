import process from "process";
import {
  batch,
  cleanup,
  Clipboard,
  computed,
  context,
  signal,
  Storage,
} from "nsh";
import {
  buildDiagnosticsSnapshotJson,
  buildExposurePlotData,
  buildScoreboardRows,
  buildSignalArenaIndex,
  computeMarketComposite,
  DESK_ENDPOINT_CATALOG,
  DESK_PREFS_STORAGE_KEY,
  extractApiFailureCause,
  filterMarketInstruments,
  PARSER_WORKBENCH_PRESETS,
  parseAgentsSearchPayload,
  parseAgentTreePayload,
  parseAnalysisFiltersPayload,
  parseAnalysisPayload,
  parseAnalysisReportsPayload,
  parseBridge3cStatusPayload,
  parseContestsPayload,
  parseCustomerProfilePayload,
  parseCustomerRatingPayload,
  parseDnsTelemetryPayload,
  parseExecutionActionPayload,
  parseExecutionPlanPayload,
  parseGameAdminBoardPayload,
  parseGameAdminPayload,
  parseGovernancePayload,
  parseGraphFeedPayload,
  parseGraphStreamSample,
  parseGraphSummaryPayload,
  parseGsLiveSessionHealthPayload,
  parseGsLiveWeblogsPayload,
  parseHealthPayload,
  parseKalshiPayload,
  parseKpisPayload,
  parseLiveBetsListPayload,
  parseLiveBetsSummaryPayload,
  parseLiveWagersPayload,
  parseLogoMetaPayload,
  parseScoreboardPayload,
  parseSportsCatalogPayload,
  parseSportsPayload,
  parseStatusPayload,
  parseTelegramActivityPayload,
  parseTelegramStatusPayload,
  parseWatchlistPayload,
  parseWorkspacePrefsJson,
  resolveDeskOrigin,
  serializeWorkspacePrefs,
  sortSignalArenaIndex,
  summarizeParsedDebugPayload,
  synthesizeMarketInstruments,
  type DeskLeagueFilter,
  type DeskPlaneId,
  type EndpointSnapshot,
  type LiveBetsSourceMode,
  type MarketChartPeriod,
  type MarketWatchFilter,
  type ParsedAgentsSearchPayload,
  type ParsedAgentTreePayload,
  type ParsedAnalysisFiltersPayload,
  type ParsedAnalysisPayload,
  type ParsedAnalysisReportsPayload,
  type ParsedBridge3cStatusPayload,
  type ParsedContestsPayload,
  type ParsedCustomerProfilePayload,
  type ParsedCustomerRatingPayload,
  type ParsedDnsTelemetryPayload,
  type ParsedExecutionPlanPayload,
  type ParsedGameAdminBoardPayload,
  type ParsedGameAdminPayload,
  type ParsedGovernancePayload,
  type ParsedGraphFeedPayload,
  type ParsedGraphStreamSample,
  type ParsedGraphSummaryPayload,
  type ParsedGsLiveSessionHealthPayload,
  type ParsedGsLiveWeblogsPayload,
  type ParsedHealthPayload,
  type ParsedKalshiPayload,
  type ParsedKpisPayload,
  type ParsedLiveBetsListPayload,
  type ParsedLiveBetsSummary,
  type ParsedLiveWagersPayload,
  type ParsedLogoMetaPayload,
  type ParsedScoreboardPayload,
  type ParsedSportsCatalogPayload,
  type ParsedSportsPayload,
  type ParsedStatusPayload,
  type ParsedTelegramActivityPayload,
  type ParsedTelegramStatusPayload,
  type ParsedWatchlistPayload,
  type ResolvedDeskOrigin,
} from "./desk_model";
import type { DataTableSort, DockAreaLayout } from "./ui";

export type LeagueFilter = DeskLeagueFilter;

export const LEAGUE_FILTER_OPTIONS = [
  { id: "ALL", label: "All" },
  { id: "NFL", label: "NFL" },
  { id: "NBA", label: "NBA" },
  { id: "NHL", label: "NHL" },
  { id: "NCAA", label: "NCAA" },
] as const;

export function defaultWorkspaceLayout(): DockAreaLayout {
  return {
    center: {
      type: "tabs",
      panels: ["markets", "signals", "scoreboard", "exposure"],
    },
    left: { layout: { type: "tabs", panels: ["kpis"] }, size: 288 },
    bottom: { layout: { type: "tabs", panels: ["diagnostics"] }, size: 204 },
  };
}

const ENDPOINT_FETCH_TIMEOUT_MS = 5_000;

interface RequestInitOptions {
  readonly method?: "GET" | "HEAD" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

async function requestJsonEndpoint<T>(
  origin: string,
  endpoint: string,
  parser: (raw: unknown) => T,
  init?: RequestInitOptions,
): Promise<EndpointSnapshot<T>> {
  const fetchedAtIso = new Date().toISOString();
  const url = `${origin}${endpoint}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: AbortSignal.timeout(ENDPOINT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: null,
      code: "network_unreachable",
      cause: `${url} unreachable: ${msg}`,
      fetchedAtIso,
    };
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code: "body_read_failed",
      cause: `${url} body read failed: ${msg}`,
      fetchedAtIso,
    };
  }

  if (!response.ok) {
    const { code, cause } = extractApiFailureCause(
      endpoint,
      response.status,
      bodyText,
    );
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code,
      cause,
      fetchedAtIso,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code: "invalid_json",
      cause: `${endpoint} returned invalid JSON: ${msg}`,
      fetchedAtIso,
    };
  }

  try {
    return {
      status: "ready",
      endpoint,
      httpStatus: response.status,
      fetchedAtIso,
      data: parser(raw),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code: "schema_mismatch",
      cause: `${endpoint} parse error: ${msg}`,
      fetchedAtIso,
    };
  }
}

async function sampleSseEndpoint(
  origin: string,
  endpoint: string,
): Promise<EndpointSnapshot<ParsedGraphStreamSample>> {
  const fetchedAtIso = new Date().toISOString();
  const url = `${origin}${endpoint}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_600);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const { code, cause } = extractApiFailureCause(
        endpoint,
        response.status,
        text,
      );
      return {
        status: "unavailable",
        endpoint,
        httpStatus: response.status,
        code,
        cause,
        fetchedAtIso,
      };
    }

    let collected = "";
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        const chunk = await reader.read();
        if (chunk.value) {
          collected += decoder.decode(chunk.value, { stream: false });
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } else {
      collected = await response.text();
    }
    return {
      status: "ready",
      endpoint,
      httpStatus: response.status,
      fetchedAtIso,
      data: parseGraphStreamSample(collected),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: null,
      code: "stream_unreachable",
      cause: `${endpoint} SSE probe failed: ${msg}`,
      fetchedAtIso,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface EndpointLedgerRow {
  readonly status: "unprobed" | "ready" | "unavailable";
  readonly httpStatus: number | null;
  readonly detail: string;
}

export type OriginResolution =
  | { readonly ok: true; readonly resolved: ResolvedDeskOrigin }
  | { readonly ok: false; readonly error: string };

/**
 * Encapsulated desk state owner per `nsh` Coding Guides ("State ownership"):
 * signals stay private inside `createDeskStore()` and views consume typed
 * accessors and command functions across all 5 planes and 38 `:4020` routes.
 */
export function createDeskStore() {
  const originInfo: OriginResolution = (() => {
    try {
      return {
        ok: true,
        resolved: resolveDeskOrigin(process.env["SPORTSDESK_ORIGIN"]),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  })();

  const initialAdminToken = (
    process.env["SPORTSDESK_ADMIN_TOKEN"] ?? ""
  ).trim();
  const adminToken = signal(initialAdminToken);

  // Core boot snapshots (kept to the 4 primary endpoints for instant boot & stub compatibility)
  const kpisSnap = signal<EndpointSnapshot<ParsedKpisPayload>>({
    status: "loading",
    endpoint: "/api/kpis",
  });
  const kalshiSnap = signal<EndpointSnapshot<ParsedKalshiPayload>>({
    status: "loading",
    endpoint: "/api/signals/kalshi",
  });
  const scoreboardSnap = signal<EndpointSnapshot<ParsedScoreboardPayload>>({
    status: "loading",
    endpoint: "/api/scoreboard",
  });
  const liveBetsSnap = signal<EndpointSnapshot<ParsedLiveBetsSummary>>({
    status: "loading",
    endpoint: "/api/live-bets/summary",
  });

  // Plane switcher & loaded flags
  const activePlane = signal<DeskPlaneId>("markets");
  const planeLoaded = signal<Record<DeskPlaneId, boolean>>({
    markets: true,
    board: false,
    surveillance: false,
    forensics: false,
    ops: false,
  });

  // Ledger of probed status per DESK_ENDPOINT_CATALOG id
  const parityLedger = signal<Record<string, EndpointLedgerRow>>({});

  const recordLedger = (id: string, snap: EndpointSnapshot<unknown>) => {
    if (snap.status === "loading") return;
    parityLedger.update((prev) => ({
      ...prev,
      [id]:
        snap.status === "ready"
          ? {
              status: "ready",
              httpStatus: snap.httpStatus,
              detail: `HTTP ${snap.httpStatus}`,
            }
          : {
              status: "unavailable",
              httpStatus: snap.httpStatus,
              detail: snap.cause,
            },
    }));
  };

  // Markets (`Stocks` Terminal) UI & Execution state
  const marketFilter = signal<MarketWatchFilter>("all");
  const compositeExpanded = signal(false);
  const chartPeriod = signal<MarketChartPeriod>("intraday");
  const bookDepth10 = signal(false);
  const mobileDetailOpen = signal(false);
  const ticketOpen = signal(false);
  const ticketSide = signal<"yes" | "no">("yes");
  const ticketStyle = signal<"auto" | "maker" | "taker">("auto");
  const ticketStakeUsd = signal(500);
  const ticketLimitCents = signal(50);
  const ticketReviewOpen = signal(false);
  const ticketBusy = signal(false);
  const toastBanner = signal<{
    readonly message: string;
    readonly tone: "positive" | "warning" | "danger";
  } | null>(null);

  const executionPlanSnap = signal<
    EndpointSnapshot<ParsedExecutionPlanPayload>
  >({
    status: "loading",
    endpoint: "/api/execution/plan",
  });

  // Board & Sports Plane state
  const boardWindow = signal<24 | 48 | -1>(24);
  const liveSourceMode = signal<LiveBetsSourceMode>("file");
  const contestQuery = signal("");
  const contestGroup = signal("ALL");
  const logoTeam = signal("lakers");
  const liveWagersWriter = signal("");

  const gameAdminBoardSnap = signal<
    EndpointSnapshot<ParsedGameAdminBoardPayload>
  >({ status: "loading", endpoint: "/api/game-admin/board" });
  const gameAdminSnap = signal<EndpointSnapshot<ParsedGameAdminPayload>>({
    status: "loading",
    endpoint: "/api/game-admin",
  });
  const logoMetaSnap = signal<EndpointSnapshot<ParsedLogoMetaPayload>>({
    status: "loading",
    endpoint: "/api/logo/lakers?meta=1&lqip=1",
  });
  const sportsSnap = signal<EndpointSnapshot<ParsedSportsPayload>>({
    status: "loading",
    endpoint: "/api/sports",
  });
  const sportsCatalogSnap = signal<
    EndpointSnapshot<ParsedSportsCatalogPayload>
  >({
    status: "loading",
    endpoint: "/api/sports/catalog",
  });
  const contestsSnap = signal<EndpointSnapshot<ParsedContestsPayload>>({
    status: "loading",
    endpoint: "/api/contests",
  });
  const v1LiveBetsSnap = signal<EndpointSnapshot<ParsedLiveBetsListPayload>>({
    status: "loading",
    endpoint: "/api/v1/live-bets",
  });
  const v2LiveBetsSnap = signal<EndpointSnapshot<ParsedLiveBetsListPayload>>({
    status: "loading",
    endpoint: "/api/v2/live-bets",
  });
  const liveWagersSnap = signal<EndpointSnapshot<ParsedLiveWagersPayload>>({
    status: "loading",
    endpoint: "/api/live-wagers",
  });
  const retiredPendingSnap = signal<EndpointSnapshot<unknown>>({
    status: "loading",
    endpoint: "/api/f402/get-pending",
  });

  // Surveillance Plane state
  const graphSummarySnap = signal<EndpointSnapshot<ParsedGraphSummaryPayload>>({
    status: "loading",
    endpoint: "/api/graph/summary",
  });
  const graphFeedSnap = signal<EndpointSnapshot<ParsedGraphFeedPayload>>({
    status: "loading",
    endpoint: "/api/graph-feed",
  });
  const graphStreamSnap = signal<EndpointSnapshot<ParsedGraphStreamSample>>({
    status: "loading",
    endpoint: "/api/graph/stream",
  });
  const gsliveWeblogsSnap = signal<
    EndpointSnapshot<ParsedGsLiveWeblogsPayload>
  >({
    status: "loading",
    endpoint: "/api/gslive/weblogs",
  });
  const gsliveSessionSnap = signal<
    EndpointSnapshot<ParsedGsLiveSessionHealthPayload>
  >({ status: "loading", endpoint: "/api/gslive/session-health" });
  const bridge3cSnap = signal<EndpointSnapshot<ParsedBridge3cStatusPayload>>({
    status: "loading",
    endpoint: "/api/bridge3c/status",
  });

  // Forensics Plane state
  const agentQuery = signal("BI");
  const analysisReport = signal("CP");
  const analysisAgent = signal("BILLY666");
  const analysisSport = signal("Baseball");
  const analysisWeek = signal("-1");
  const customerLookupId = signal("DK121");

  const agentsSearchSnap = signal<EndpointSnapshot<ParsedAgentsSearchPayload>>({
    status: "loading",
    endpoint: "/api/agents/search",
  });
  const agentTreeFlatSnap = signal<EndpointSnapshot<ParsedAgentTreePayload>>({
    status: "loading",
    endpoint: "/api/agent-tree",
  });
  const agentTreeHierarchySnap = signal<
    EndpointSnapshot<ParsedAgentTreePayload>
  >({ status: "loading", endpoint: "/api/agent-tree?view=hierarchy" });
  const analysisFiltersSnap = signal<
    EndpointSnapshot<ParsedAnalysisFiltersPayload>
  >({ status: "loading", endpoint: "/api/analysis/filters" });
  const analysisReportsSnap = signal<
    EndpointSnapshot<ParsedAnalysisReportsPayload>
  >({ status: "loading", endpoint: "/api/analysis/reports" });
  const analysisSnap = signal<EndpointSnapshot<ParsedAnalysisPayload>>({
    status: "loading",
    endpoint: "/api/analysis",
  });
  const customerProfileSnap = signal<
    EndpointSnapshot<ParsedCustomerProfilePayload>
  >({ status: "loading", endpoint: "/api/customer/profile" });
  const customerRatingSnap = signal<
    EndpointSnapshot<ParsedCustomerRatingPayload>
  >({ status: "loading", endpoint: "/api/customer/rating" });
  const watchlistSnap = signal<EndpointSnapshot<ParsedWatchlistPayload>>({
    status: "loading",
    endpoint: "/api/watchlist",
  });

  // System & Ops Plane state
  const healthSnap = signal<EndpointSnapshot<ParsedHealthPayload>>({
    status: "loading",
    endpoint: "/health",
  });
  const statusSnap = signal<EndpointSnapshot<ParsedStatusPayload>>({
    status: "loading",
    endpoint: "/api/status",
  });
  const dnsTelemetrySnap = signal<EndpointSnapshot<ParsedDnsTelemetryPayload>>({
    status: "loading",
    endpoint: "/api/dns/telemetry",
  });
  const governanceSnap = signal<EndpointSnapshot<ParsedGovernancePayload>>({
    status: "loading",
    endpoint: "/governance.json",
  });
  const telegramStatusSnap = signal<
    EndpointSnapshot<ParsedTelegramStatusPayload>
  >({ status: "loading", endpoint: "/api/telegram/status" });
  const telegramActivitySnap = signal<
    EndpointSnapshot<ParsedTelegramActivityPayload>
  >({ status: "loading", endpoint: "/api/telegram/activity" });

  const telegramReportType = signal("EVENING_SETTLEMENT");
  const telegramAlertCustomer = signal("RF2003");
  const parserPresetId = signal(PARSER_WORKBENCH_PRESETS[0]!.id);
  const parserBody = signal(PARSER_WORKBENCH_PRESETS[0]!.sampleBody);
  const parserOutputSnap = signal<EndpointSnapshot<string>>({
    status: "loading",
    endpoint: PARSER_WORKBENCH_PRESETS[0]!.endpoint,
  });
  const errorGuardSnap = signal<EndpointSnapshot<unknown>>({
    status: "loading",
    endpoint: "/api/test/error",
  });
  const sweepingAll = signal(false);

  // Core Workspace Signals
  const pollCount = signal(0);
  const lastPollMs = signal<number | null>(null);
  const polling = signal(false);
  const autoPoll = signal(false);

  const signalSort = signal<DataTableSort | null>({
    key: "risk",
    direction: "descending",
  });
  const selectedSignalId = signal<string | null>(null);
  const hoveredPlotIndex = signal<number | null>(null);
  const leagueFilter = signal<LeagueFilter>("ALL");

  const layout = signal<DockAreaLayout>(defaultWorkspaceLayout());
  const locked = signal(false);
  const dockOpen = signal({ left: true, bottom: true });
  const uiKitOpen = signal(false);
  const copiedDiagnosticsBytes = signal<number | null>(null);

  let userMutatedPrefs = false;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const showToast = (
    message: string,
    tone: "positive" | "warning" | "danger" = "positive",
  ) => {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastBanner.set({ message, tone });
    toastTimer = setTimeout(() => {
      toastBanner.set(null);
    }, 4_500);
  };

  cleanup(() => {
    if (toastTimer !== null) clearTimeout(toastTimer);
  });

  const authHeaders = (): Record<string, string> | undefined => {
    const tok = adminToken().trim();
    return tok.length > 0 ? { Authorization: `Bearer ${tok}` } : undefined;
  };

  const persistPrefs = () => {
    userMutatedPrefs = true;
    const payload = serializeWorkspacePrefs({
      schemaVersion: 1,
      leagueFilter: leagueFilter(),
      autoPoll: autoPoll(),
      locked: locked(),
      dockOpen: dockOpen(),
    });
    void Storage.setItem(DESK_PREFS_STORAGE_KEY, payload).catch(() => {
      // Non-fatal if host Storage quota or capability is unavailable.
    });
  };

  void Storage.getItem(DESK_PREFS_STORAGE_KEY)
    .then((raw) => {
      if (userMutatedPrefs || raw === null) return;
      const hydrated = parseWorkspacePrefsJson(raw);
      batch(() => {
        leagueFilter.set(hydrated.leagueFilter);
        autoPoll.set(hydrated.autoPoll);
        locked.set(hydrated.locked);
        dockOpen.set(hydrated.dockOpen);
      });
    })
    .catch(() => {
      // Keep defaults when Storage is unavailable.
    });

  // --- Plane Loaders ---

  const loadExecutionPlan = async () => {
    if (!originInfo.ok) return;
    const base = originInfo.resolved.origin;
    const style = ticketStyle();
    const res = await requestJsonEndpoint(
      base,
      `/api/execution/plan?limit=25&style=${style}`,
      parseExecutionPlanPayload,
    );
    executionPlanSnap.set(res);
    recordLedger("execution-plan", res);
  };

  const loadBoardPlane = async () => {
    if (!originInfo.ok) return;
    const base = originInfo.resolved.origin;
    const win = boardWindow();
    const src = liveSourceMode();
    const q = contestQuery().trim();
    const grp = contestGroup();
    const contestParams = new URLSearchParams();
    if (grp !== "ALL") contestParams.set("group", grp);
    if (q.length > 0) contestParams.set("q", q);
    const contestSuffix =
      contestParams.toString().length > 0 ? `?${contestParams.toString()}` : "";
    const teamSlug = encodeURIComponent(
      logoTeam().trim().toLowerCase() || "lakers",
    );
    const writer = liveWagersWriter().trim();
    const wagerQs = `source=${src}${writer ? `&writer=${encodeURIComponent(writer)}` : ""}`;

    const [
      bBoard,
      bAdmin,
      bLogo,
      bSports,
      bCatalog,
      bContests,
      bV1,
      bV2,
      bWagers,
      bRetired,
    ] = await Promise.all([
      requestJsonEndpoint(
        base,
        `/api/game-admin/board?window=${win}`,
        parseGameAdminBoardPayload,
      ),
      requestJsonEndpoint(base, "/api/game-admin", parseGameAdminPayload),
      requestJsonEndpoint(
        base,
        `/api/logo/${teamSlug}?meta=1&lqip=1`,
        parseLogoMetaPayload,
      ),
      requestJsonEndpoint(base, "/api/sports", parseSportsPayload),
      requestJsonEndpoint(
        base,
        "/api/sports/catalog",
        parseSportsCatalogPayload,
      ),
      requestJsonEndpoint(
        base,
        `/api/contests${contestSuffix}`,
        parseContestsPayload,
      ),
      requestJsonEndpoint(
        base,
        `/api/v1/live-bets?source=${src}`,
        parseLiveBetsListPayload,
      ),
      requestJsonEndpoint(
        base,
        `/api/v2/live-bets?source=${src}&fallback=file`,
        parseLiveBetsListPayload,
      ),
      requestJsonEndpoint(
        base,
        `/api/live-wagers?${wagerQs}`,
        parseLiveWagersPayload,
      ),
      requestJsonEndpoint(base, "/api/f402/get-pending", (x) => x),
    ]);

    batch(() => {
      gameAdminBoardSnap.set(bBoard);
      gameAdminSnap.set(bAdmin);
      logoMetaSnap.set(bLogo);
      sportsSnap.set(bSports);
      sportsCatalogSnap.set(bCatalog);
      contestsSnap.set(bContests);
      v1LiveBetsSnap.set(bV1);
      v2LiveBetsSnap.set(bV2);
      liveWagersSnap.set(bWagers);
      retiredPendingSnap.set(bRetired);
    });
    recordLedger("game-admin-board", bBoard);
    recordLedger("game-admin", bAdmin);
    recordLedger("logo-meta", bLogo);
    recordLedger("sports", bSports);
    recordLedger("sports-catalog", bCatalog);
    recordLedger("contests", bContests);
    recordLedger("v1-live-bets", bV1);
    recordLedger("v2-live-bets", bV2);
    recordLedger("live-wagers", bWagers);
    recordLedger("f402-retired-guard", bRetired);
  };

  const loadSurveillancePlane = async () => {
    if (!originInfo.ok) return;
    const base = originInfo.resolved.origin;
    const [gSum, gFeed, gLogs, gSess, b3c] = await Promise.all([
      requestJsonEndpoint(base, "/api/graph/summary", parseGraphSummaryPayload),
      requestJsonEndpoint(base, "/api/graph-feed", parseGraphFeedPayload),
      requestJsonEndpoint(
        base,
        "/api/gslive/weblogs",
        parseGsLiveWeblogsPayload,
      ),
      requestJsonEndpoint(
        base,
        "/api/gslive/session-health?probe=0",
        parseGsLiveSessionHealthPayload,
      ),
      requestJsonEndpoint(
        base,
        "/api/bridge3c/status",
        parseBridge3cStatusPayload,
      ),
    ]);
    batch(() => {
      graphSummarySnap.set(gSum);
      graphFeedSnap.set(gFeed);
      gsliveWeblogsSnap.set(gLogs);
      gsliveSessionSnap.set(gSess);
      bridge3cSnap.set(b3c);
    });
    recordLedger("graph-summary", gSum);
    recordLedger("graph-feed", gFeed);
    recordLedger("gslive-weblogs", gLogs);
    recordLedger("gslive-session-health", gSess);
    recordLedger("bridge3c-status", b3c);
  };

  const sampleGraphStream = async () => {
    if (!originInfo.ok) return;
    const snap = await sampleSseEndpoint(
      originInfo.resolved.origin,
      "/api/graph/stream",
    );
    graphStreamSnap.set(snap);
    recordLedger("graph-stream", snap);
  };

  const probeGsLiveSession = async (probe: boolean) => {
    if (!originInfo.ok) return;
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      `/api/gslive/session-health?probe=${probe ? "1" : "0"}`,
      parseGsLiveSessionHealthPayload,
    );
    gsliveSessionSnap.set(snap);
    recordLedger("gslive-session-health", snap);
  };

  const loadAgentSearch = async () => {
    if (!originInfo.ok) return;
    const q = agentQuery().trim();
    if (q.length < 2) return;
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      `/api/agents/search?q=${encodeURIComponent(q)}&limit=20`,
      parseAgentsSearchPayload,
    );
    agentsSearchSnap.set(snap);
    recordLedger("agents-search", snap);
  };

  const loadAnalysisSlice = async () => {
    if (!originInfo.ok) return;
    const qs = new URLSearchParams({
      report: analysisReport(),
      agent: analysisAgent(),
      sport: analysisSport(),
      week: analysisWeek(),
      activity: "0",
    });
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      `/api/analysis?${qs.toString()}`,
      parseAnalysisPayload,
    );
    analysisSnap.set(snap);
    recordLedger("analysis", snap);
  };

  const lookupCustomerForensics = async () => {
    if (!originInfo.ok) return;
    const base = originInfo.resolved.origin;
    const id = encodeURIComponent(customerLookupId().trim() || "DK121");
    const [prof, rate] = await Promise.all([
      requestJsonEndpoint(
        base,
        `/api/customer/profile?id=${id}`,
        parseCustomerProfilePayload,
      ),
      requestJsonEndpoint(
        base,
        `/api/customer/rating?id=${id}`,
        parseCustomerRatingPayload,
      ),
    ]);
    batch(() => {
      customerProfileSnap.set(prof);
      customerRatingSnap.set(rate);
    });
    recordLedger("customer-profile", prof);
    recordLedger("customer-rating", rate);
  };

  const loadWatchlist = async () => {
    if (!originInfo.ok) return;
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      "/api/watchlist",
      parseWatchlistPayload,
      { headers: authHeaders() },
    );
    watchlistSnap.set(snap);
    recordLedger("watchlist", snap);
  };

  const loadForensicsPlane = async () => {
    if (!originInfo.ok) return;
    const base = originInfo.resolved.origin;
    const [flatTree, hierTree, aFilters, aReports] = await Promise.all([
      requestJsonEndpoint(base, "/api/agent-tree", parseAgentTreePayload),
      requestJsonEndpoint(
        base,
        "/api/agent-tree?view=hierarchy",
        parseAgentTreePayload,
      ),
      requestJsonEndpoint(
        base,
        "/api/analysis/filters",
        parseAnalysisFiltersPayload,
      ),
      requestJsonEndpoint(
        base,
        "/api/analysis/reports",
        parseAnalysisReportsPayload,
      ),
      loadAgentSearch(),
      loadAnalysisSlice(),
      lookupCustomerForensics(),
      loadWatchlist(),
    ]);
    batch(() => {
      agentTreeFlatSnap.set(flatTree);
      agentTreeHierarchySnap.set(hierTree);
      analysisFiltersSnap.set(aFilters);
      analysisReportsSnap.set(aReports);
    });
    recordLedger("agent-tree", hierTree);
    recordLedger("analysis-filters", aFilters);
    recordLedger("analysis-reports", aReports);
  };

  const loadOpsPlane = async () => {
    if (!originInfo.ok) return;
    const base = originInfo.resolved.origin;
    const headers = authHeaders();
    const [hSnap, sSnap, dSnap, gSnap, tgStatus, tgAct] = await Promise.all([
      requestJsonEndpoint(base, "/health", parseHealthPayload),
      requestJsonEndpoint(base, "/api/status", parseStatusPayload),
      requestJsonEndpoint(base, "/api/dns/telemetry", parseDnsTelemetryPayload),
      requestJsonEndpoint(base, "/governance.json", parseGovernancePayload),
      requestJsonEndpoint(
        base,
        "/api/telegram/status",
        parseTelegramStatusPayload,
        { headers },
      ),
      requestJsonEndpoint(
        base,
        "/api/telegram/activity?limit=25",
        parseTelegramActivityPayload,
        { headers },
      ),
    ]);
    batch(() => {
      healthSnap.set(hSnap);
      statusSnap.set(sSnap);
      dnsTelemetrySnap.set(dSnap);
      governanceSnap.set(gSnap);
      telegramStatusSnap.set(tgStatus);
      telegramActivitySnap.set(tgAct);
    });
    recordLedger("health", hSnap);
    recordLedger("status", sSnap);
    recordLedger("dns-telemetry", dSnap);
    recordLedger("governance", gSnap);
    recordLedger("telegram-status", tgStatus);
    recordLedger("telegram-activity", tgAct);
  };

  // --- Interactive Actions (Execution, Telegram, Parser Workbench, Full Sweep) ---

  const setExecutionModeAction = async (mode: "paper" | "paused") => {
    if (!originInfo.ok || ticketBusy()) return;
    ticketBusy.set(true);
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      "/api/execution/mode",
      parseExecutionActionPayload,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    ticketBusy.set(false);
    recordLedger("execution-mode", snap);
    if (snap.status === "ready") {
      showToast(
        `Execution engine mode → ${snap.data.mode.toUpperCase()}`,
        "positive",
      );
      await loadExecutionPlan();
    } else if (snap.status === "unavailable") {
      showToast(snap.cause, "danger");
    }
  };

  const submitPaperExecution = async () => {
    if (!originInfo.ok || ticketBusy()) return;
    ticketBusy.set(true);
    const inst = selectedInstrument();
    const style = ticketStyle();
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      "/api/execution/run",
      parseExecutionActionPayload,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          live: false,
          style,
          limit: 25,
          signalId: inst?.id ?? null,
          side: ticketSide(),
          stakeUsd: ticketStakeUsd(),
          limitCents: ticketLimitCents(),
        }),
      },
    );
    ticketBusy.set(false);
    recordLedger("execution-run", snap);
    if (snap.status === "ready") {
      ticketOpen.set(false);
      ticketReviewOpen.set(false);
      showToast(
        `Paper execution (${style.toUpperCase()}) · ${inst?.code ?? "DESK"} · ${ticketSide().toUpperCase()} $${ticketStakeUsd()} @ ${ticketLimitCents()}¢ — ${snap.data.summary}`,
        "positive",
      );
      await loadExecutionPlan();
    } else if (snap.status === "unavailable") {
      showToast(snap.cause, "danger");
    }
  };

  const runTelegramWebhookAction = async (action: "set" | "delete") => {
    if (!originInfo.ok) return;
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      "/api/telegram/webhook",
      (x) => x,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ action }),
      },
    );
    recordLedger("telegram-webhook", snap);
    if (snap.status === "ready") {
      showToast(
        `Telegram webhook '${action}' succeeded (HTTP ${snap.httpStatus})`,
        "positive",
      );
      void loadOpsPlane();
    } else if (snap.status === "unavailable") {
      showToast(snap.cause, "warning");
    }
  };

  const runTelegramTestAlert = async () => {
    if (!originInfo.ok) return;
    const customerId = telegramAlertCustomer().trim() || "RF2003";
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      "/api/telegram/alert",
      (x) => x,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ customerId }),
      },
    );
    recordLedger("telegram-alert", snap);
    if (snap.status === "ready") {
      showToast(`Telegram alert dispatched for ${customerId}`, "positive");
      void loadOpsPlane();
    } else if (snap.status === "unavailable") {
      showToast(snap.cause, "warning");
    }
  };

  const runTelegramExecutiveReport = async () => {
    if (!originInfo.ok) return;
    const rpt = encodeURIComponent(telegramReportType());
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      `/api/telegram/report?type=${rpt}`,
      (x) => x,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );
    recordLedger("telegram-report", snap);
    if (snap.status === "ready") {
      showToast(
        `Telegram report '${telegramReportType()}' dispatched`,
        "positive",
      );
      void loadOpsPlane();
    } else if (snap.status === "unavailable") {
      showToast(snap.cause, "warning");
    }
  };

  const runParserWorkbench = async () => {
    if (!originInfo.ok) return;
    const preset =
      PARSER_WORKBENCH_PRESETS.find((p) => p.id === parserPresetId()) ??
      PARSER_WORKBENCH_PRESETS[0]!;
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      preset.endpoint,
      summarizeParsedDebugPayload,
      {
        method: "POST",
        headers: { "Content-Type": preset.contentType },
        body: parserBody(),
      },
    );
    parserOutputSnap.set(snap);
    recordLedger(preset.id, snap);
  };

  const probeErrorBoundaryGuard = async () => {
    if (!originInfo.ok) return;
    const snap = await requestJsonEndpoint(
      originInfo.resolved.origin,
      "/api/test/error",
      (x) => x,
    );
    errorGuardSnap.set(snap);
    recordLedger("test-error-guard", snap);
  };

  const refreshAll = async () => {
    if (!originInfo.ok || polling()) return;
    polling.set(true);
    const t0 = Date.now();
    const base = originInfo.resolved.origin;
    const [nextKpis, nextKalshi, nextBoard, nextLiveBets] = await Promise.all([
      requestJsonEndpoint(base, "/api/kpis", parseKpisPayload),
      requestJsonEndpoint(base, "/api/signals/kalshi", parseKalshiPayload),
      requestJsonEndpoint(base, "/api/scoreboard", parseScoreboardPayload),
      requestJsonEndpoint(
        base,
        "/api/live-bets/summary",
        parseLiveBetsSummaryPayload,
      ),
    ]);
    const elapsed = Math.max(0, Date.now() - t0);
    batch(() => {
      kpisSnap.set(nextKpis);
      kalshiSnap.set(nextKalshi);
      scoreboardSnap.set(nextBoard);
      liveBetsSnap.set(nextLiveBets);
      lastPollMs.set(elapsed);
      pollCount.update((n) => n + 1);
      polling.set(false);
    });
    recordLedger("kpis", nextKpis);
    recordLedger("signals-kalshi", nextKalshi);
    recordLedger("scoreboard", nextBoard);
    recordLedger("live-bets-summary", nextLiveBets);

    const plane = activePlane();
    if (plane === "board") void loadBoardPlane();
    else if (plane === "surveillance") void loadSurveillancePlane();
    else if (plane === "forensics") void loadForensicsPlane();
    else if (plane === "ops") void loadOpsPlane();
  };

  const sweepAllEndpoints = async () => {
    if (!originInfo.ok || sweepingAll()) return;
    sweepingAll.set(true);
    try {
      await Promise.all([
        refreshAll(),
        loadExecutionPlan(),
        loadBoardPlane(),
        loadSurveillancePlane(),
        loadForensicsPlane(),
        loadOpsPlane(),
      ]);
      showToast(
        "Completed live parity sweep across all GET :4020 planes",
        "positive",
      );
    } finally {
      sweepingAll.set(false);
    }
  };

  void refreshAll();

  const timer = setInterval(() => {
    if (autoPoll()) {
      void refreshAll();
    }
  }, 10_000);
  cleanup(() => clearInterval(timer));

  // --- Computed Derived Views ---

  const signalArenaIndex = computed(() => {
    const snap = kalshiSnap();
    return buildSignalArenaIndex(
      snap.status === "ready" ? snap.data.signals : [],
    );
  });

  const signalArena = computed(() => {
    const s = signalSort();
    return sortSignalArenaIndex(
      signalArenaIndex(),
      s?.key ?? null,
      s?.direction ?? null,
    );
  });

  const selectedSignal = computed(() => {
    const idxData = signalArenaIndex();
    const arena = signalArena();
    if (arena.items.length === 0) return null;
    const targetId = selectedSignalId();
    if (targetId !== null) {
      const matchedIdx = idxData.indexById.get(targetId);
      if (matchedIdx !== undefined) {
        return arena.items[matchedIdx] ?? null;
      }
    }
    const firstIdx = arena.order[0];
    return firstIdx !== undefined ? (arena.items[firstIdx] ?? null) : null;
  });

  const marketInstruments = computed(() => {
    const kSnap = kalshiSnap();
    const gfSnap = graphFeedSnap();
    if (kSnap.status !== "ready") return [];
    return synthesizeMarketInstruments(
      kSnap.data.signals,
      gfSnap.status === "ready" ? gfSnap.data : null,
    );
  });

  const filteredMarketInstruments = computed(() =>
    filterMarketInstruments(marketInstruments(), marketFilter()),
  );

  const marketComposite = computed(() =>
    computeMarketComposite(marketInstruments()),
  );

  const selectedInstrument = computed(() => {
    const all = marketInstruments();
    if (all.length === 0) return null;
    const targetId = selectedSignalId();
    if (targetId !== null) {
      const found = all.find((it) => it.id === targetId);
      if (found) return found;
    }
    const filtered = filteredMarketInstruments();
    return filtered[0] ?? all[0] ?? null;
  });

  const plotPoints = computed(() => {
    const snap = kalshiSnap();
    return snap.status === "ready"
      ? buildExposurePlotData(snap.data.signals, 10)
      : [];
  });

  const activePlotPoint = computed(() => {
    const pts = plotPoints();
    if (pts.length === 0) return null;
    const idx = hoveredPlotIndex();
    return idx !== null ? (pts[idx] ?? pts[0] ?? null) : (pts[0] ?? null);
  });

  const scoreboardRows = computed(() => {
    const snap = scoreboardSnap();
    return snap.status === "ready"
      ? buildScoreboardRows(snap.data.games, leagueFilter())
      : [];
  });

  const allEndpoints = computed(() => [
    kpisSnap(),
    kalshiSnap(),
    scoreboardSnap(),
    liveBetsSnap(),
  ]);

  const parityProgress = computed(() => {
    const ledger = parityLedger();
    let probed = 0;
    let ready = 0;
    for (const entry of DESK_ENDPOINT_CATALOG) {
      const row = ledger[entry.id];
      if (row && row.status !== "unprobed") {
        probed += 1;
        if (row.status === "ready") ready += 1;
      }
    }
    return {
      probed,
      ready,
      total: DESK_ENDPOINT_CATALOG.length,
    };
  });

  const r2Sinks = computed(() => {
    const k = kpisSnap();
    return k.status === "ready" ? k.data.r2Sinks : [];
  });

  const copyDiagnosticsToClipboard = async (): Promise<boolean> => {
    if (!originInfo.ok) return false;
    const snapshot = buildDiagnosticsSnapshotJson({
      origin: originInfo.resolved,
      pollCount: pollCount(),
      lastPollMs: lastPollMs(),
      endpoints: allEndpoints(),
      liveBets: liveBetsSnap(),
      r2Sinks: r2Sinks(),
    });
    try {
      await Clipboard.writeText(snapshot);
      copiedDiagnosticsBytes.set(snapshot.length);
      return true;
    } catch {
      return false;
    }
  };

  return {
    originInfo,
    adminToken: () => adminToken(),
    setAdminToken: (next: string) => adminToken.set(next),

    // Plane navigation & parity ledger
    activePlane: () => activePlane(),
    setActivePlane: (plane: DeskPlaneId) => {
      activePlane.set(plane);
      const loaded = planeLoaded();
      if (!loaded[plane]) {
        planeLoaded.set({ ...loaded, [plane]: true });
        if (plane === "board") void loadBoardPlane();
        else if (plane === "surveillance") void loadSurveillancePlane();
        else if (plane === "forensics") void loadForensicsPlane();
        else if (plane === "ops") void loadOpsPlane();
      }
    },
    parityLedger: () => parityLedger(),
    parityProgress,
    sweepingAll: () => sweepingAll(),
    sweepAllEndpoints,

    // Core boot endpoints
    kpisSnap: () => kpisSnap(),
    kalshiSnap: () => kalshiSnap(),
    scoreboardSnap: () => scoreboardSnap(),
    liveBetsSnap: () => liveBetsSnap(),
    pollCount: () => pollCount(),
    lastPollMs: () => lastPollMs(),
    polling: () => polling(),
    autoPoll: () => autoPoll(),

    // Markets (`Stocks` Terminal)
    marketFilter: () => marketFilter(),
    setMarketFilter: (next: MarketWatchFilter) => marketFilter.set(next),
    compositeExpanded: () => compositeExpanded(),
    toggleCompositeExpanded: () => compositeExpanded.update((v) => !v),
    chartPeriod: () => chartPeriod(),
    setChartPeriod: (next: MarketChartPeriod) => chartPeriod.set(next),
    bookDepth10: () => bookDepth10(),
    toggleBookDepth10: () => bookDepth10.update((v) => !v),
    mobileDetailOpen: () => mobileDetailOpen(),
    setMobileDetailOpen: (open: boolean) => mobileDetailOpen.set(open),
    marketInstruments,
    filteredMarketInstruments,
    marketComposite,
    selectedInstrument,
    selectInstrumentById: (id: string) => {
      selectedSignalId.set(id);
      const found = marketInstruments().find((m) => m.id === id);
      if (found) {
        ticketLimitCents.set(Math.round(found.quote.last));
      }
    },

    // Execution Ticket
    ticketOpen: () => ticketOpen(),
    openTicketForSelected: () => {
      const inst = selectedInstrument();
      if (inst) {
        ticketLimitCents.set(Math.round(inst.quote.last));
      }
      ticketReviewOpen.set(false);
      ticketOpen.set(true);
      void loadExecutionPlan();
    },
    setTicketOpen: (open: boolean) => ticketOpen.set(open),
    ticketSide: () => ticketSide(),
    setTicketSide: (side: "yes" | "no") => ticketSide.set(side),
    ticketStyle: () => ticketStyle(),
    setTicketStyle: (style: "auto" | "maker" | "taker") => {
      ticketStyle.set(style);
      void loadExecutionPlan();
    },
    ticketStakeUsd: () => ticketStakeUsd(),
    setTicketStakeUsd: (usd: number) =>
      ticketStakeUsd.set(Math.max(25, Math.min(50_000, Math.round(usd)))),
    ticketLimitCents: () => ticketLimitCents(),
    stepTicketLimitCents: (delta: number) =>
      ticketLimitCents.update((c) => Math.max(1, Math.min(99, c + delta))),
    ticketReviewOpen: () => ticketReviewOpen(),
    setTicketReviewOpen: (open: boolean) => ticketReviewOpen.set(open),
    ticketBusy: () => ticketBusy(),
    executionPlanSnap: () => executionPlanSnap(),
    loadExecutionPlan,
    setExecutionModeAction,
    submitPaperExecution,
    toastBanner: () => toastBanner(),
    dismissToastBanner: () => toastBanner.set(null),

    // Classic Signals / Exposure / Scoreboard
    signalSort: () => signalSort(),
    signalArena,
    selectedSignal,
    plotPoints,
    activePlotPoint,
    leagueFilter: () => leagueFilter(),
    scoreboardRows,
    allEndpoints,
    r2Sinks,

    // Board & Sports Plane
    boardWindow: () => boardWindow(),
    setBoardWindow: (win: 24 | 48 | -1) => {
      boardWindow.set(win);
      void loadBoardPlane();
    },
    liveSourceMode: () => liveSourceMode(),
    setLiveSourceMode: (src: LiveBetsSourceMode) => {
      liveSourceMode.set(src);
      void loadBoardPlane();
    },
    contestQuery: () => contestQuery(),
    setContestQuery: (q: string) => contestQuery.set(q),
    contestGroup: () => contestGroup(),
    setContestGroup: (g: string) => {
      contestGroup.set(g);
      void loadBoardPlane();
    },
    logoTeam: () => logoTeam(),
    setLogoTeam: (t: string) => logoTeam.set(t),
    liveWagersWriter: () => liveWagersWriter(),
    setLiveWagersWriter: (w: string) => liveWagersWriter.set(w),
    gameAdminBoardSnap: () => gameAdminBoardSnap(),
    gameAdminSnap: () => gameAdminSnap(),
    logoMetaSnap: () => logoMetaSnap(),
    sportsSnap: () => sportsSnap(),
    sportsCatalogSnap: () => sportsCatalogSnap(),
    contestsSnap: () => contestsSnap(),
    v1LiveBetsSnap: () => v1LiveBetsSnap(),
    v2LiveBetsSnap: () => v2LiveBetsSnap(),
    liveWagersSnap: () => liveWagersSnap(),
    retiredPendingSnap: () => retiredPendingSnap(),
    loadBoardPlane,

    // Surveillance Plane
    graphSummarySnap: () => graphSummarySnap(),
    graphFeedSnap: () => graphFeedSnap(),
    graphStreamSnap: () => graphStreamSnap(),
    gsliveWeblogsSnap: () => gsliveWeblogsSnap(),
    gsliveSessionSnap: () => gsliveSessionSnap(),
    bridge3cSnap: () => bridge3cSnap(),
    loadSurveillancePlane,
    sampleGraphStream,
    probeGsLiveSession,

    // Forensics Plane
    agentQuery: () => agentQuery(),
    setAgentQuery: (q: string) => {
      agentQuery.set(q);
      if (q.trim().length >= 2) void loadAgentSearch();
    },
    analysisReport: () => analysisReport(),
    setAnalysisReport: (r: string) => analysisReport.set(r),
    analysisAgent: () => analysisAgent(),
    setAnalysisAgent: (a: string) => analysisAgent.set(a),
    analysisSport: () => analysisSport(),
    setAnalysisSport: (s: string) => analysisSport.set(s),
    analysisWeek: () => analysisWeek(),
    setAnalysisWeek: (w: string) => analysisWeek.set(w),
    customerLookupId: () => customerLookupId(),
    setCustomerLookupId: (id: string) => customerLookupId.set(id),
    agentsSearchSnap: () => agentsSearchSnap(),
    agentTreeFlatSnap: () => agentTreeFlatSnap(),
    agentTreeHierarchySnap: () => agentTreeHierarchySnap(),
    analysisFiltersSnap: () => analysisFiltersSnap(),
    analysisReportsSnap: () => analysisReportsSnap(),
    analysisSnap: () => analysisSnap(),
    customerProfileSnap: () => customerProfileSnap(),
    customerRatingSnap: () => customerRatingSnap(),
    watchlistSnap: () => watchlistSnap(),
    loadForensicsPlane,
    loadAgentSearch,
    loadAnalysisSlice,
    lookupCustomerForensics,
    loadWatchlist,

    // System & Ops Plane
    healthSnap: () => healthSnap(),
    statusSnap: () => statusSnap(),
    dnsTelemetrySnap: () => dnsTelemetrySnap(),
    governanceSnap: () => governanceSnap(),
    telegramStatusSnap: () => telegramStatusSnap(),
    telegramActivitySnap: () => telegramActivitySnap(),
    telegramReportType: () => telegramReportType(),
    setTelegramReportType: (t: string) => telegramReportType.set(t),
    telegramAlertCustomer: () => telegramAlertCustomer(),
    setTelegramAlertCustomer: (c: string) => telegramAlertCustomer.set(c),
    parserPresetId: () => parserPresetId(),
    selectParserPreset: (id: string) => {
      parserPresetId.set(id);
      const found = PARSER_WORKBENCH_PRESETS.find((p) => p.id === id);
      if (found) {
        parserBody.set(found.sampleBody);
      }
    },
    parserBody: () => parserBody(),
    setParserBody: (b: string) => parserBody.set(b),
    parserOutputSnap: () => parserOutputSnap(),
    errorGuardSnap: () => errorGuardSnap(),
    loadOpsPlane,
    runTelegramWebhookAction,
    runTelegramTestAlert,
    runTelegramExecutiveReport,
    runParserWorkbench,
    probeErrorBoundaryGuard,

    // Workspace Layout & Clipboard
    layout: () => layout(),
    locked: () => locked(),
    dockOpen: () => dockOpen(),
    uiKitOpen: () => uiKitOpen(),
    copiedDiagnosticsBytes: () => copiedDiagnosticsBytes(),
    refreshAll,
    copyDiagnosticsToClipboard,
    setAutoPoll: (next: boolean) => {
      autoPoll.set(next);
      persistPrefs();
    },
    toggleAutoPoll: () => {
      autoPoll.update((v) => !v);
      persistPrefs();
    },
    setSignalSort: (next: DataTableSort | null) => signalSort.set(next),
    selectSignalByDisplayRow: (displayRow: number) => {
      const arena = signalArena();
      const origIdx = arena.order[displayRow];
      const chosen = origIdx !== undefined ? arena.items[origIdx] : undefined;
      if (chosen) {
        selectedSignalId.set(chosen.id);
      }
    },
    setHoveredPlotIndex: (idx: number | null) => hoveredPlotIndex.set(idx),
    setLeagueFilter: (next: LeagueFilter) => {
      leagueFilter.set(next);
      persistPrefs();
    },
    setLayout: (next: DockAreaLayout) => layout.set(next),
    resetLayout: () => {
      batch(() => {
        layout.set(defaultWorkspaceLayout());
        dockOpen.set({ left: true, bottom: true });
      });
      persistPrefs();
    },
    setLocked: (next: boolean) => {
      locked.set(next);
      persistPrefs();
    },
    toggleLocked: () => {
      locked.update((v) => !v);
      persistPrefs();
    },
    setDockOpenPlacement: (placement: "left" | "bottom", open: boolean) => {
      dockOpen.set({ ...dockOpen(), [placement]: open });
      persistPrefs();
    },
    setUiKitOpen: (next: boolean) => uiKitOpen.set(next),
  };
}

export type DeskStore = ReturnType<typeof createDeskStore>;

export const DeskStoreContext = context<DeskStore | null>(null);

export function useDeskStore(explicitStore?: DeskStore): DeskStore {
  if (explicitStore !== undefined) {
    return explicitStore;
  }
  const provided = DeskStoreContext();
  if (provided === null) {
    throw new Error(
      "[nsh-desk] useDeskStore() requires an enclosing <DeskStoreContext.Provider> or explicit store prop",
    );
  }
  return provided;
}
