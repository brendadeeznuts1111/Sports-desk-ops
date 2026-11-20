import type React from "react";
import { copyText } from "./clipboard.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseDashboardWsSignal,
  resolveDaemon4020State,
  wagerChannelOf,
} from "@sportsdesk-ops/contracts";
import "./desk.css";
// Bun's file loader: absolute path under `bun run`, copied-relative path under `bun build`.
import logo from "./assets/logo.svg";
import { ShadowPricingPanel } from "./ShadowPricingPanel.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { styles } from "./dashboard_styles.ts";
import { newTicketIds as diffNewTicketIds } from "./live_stream.ts";
import {
  backtestRowsToProfiles,
  isSyntheticShowcaseCustomer,
  liveOpenWagersToProfiles,
  mergeMatrixProfileOverlay,
  mergeOpenRiskOverlay,
  mergeProfileRows,
  profileApiPayloadToShowcase,
  rankingsPlayersToProfiles,
  selectProfileRows,
} from "./profile_rows.ts";
import {
  deriveLiveFormulaCohortKpiCards,
  fetchRankingsSlice,
  type NormalizedRankingsResult,
  normalizeCustomerRatingResponse,
  normalizeCustomersCohortResponse,
  normalizeLiveBetsV2Summary,
  normalizeLiveWagersResponse,
  PENDING_WAGERS_PROVENANCE,
  unavailableProvenance,
} from "./hydration.ts";
import {
  AgentInspectorModal,
  AlertsTabPanel,
  BetTickerTabPanel,
  BuildMatrixDrawer,
  BunAssetsTabPanel,
  CustomersTabPanel,
  LiveWagersTabPanel,
  R2PipelineTabPanel,
  RankingsTabPanel,
  ShiftHandoffModal,
  SurveillanceTabPanel,
  TerminalTabPanel,
} from "./panels/index.tsx";
import {
  debugDashboardTrace,
  getDashboardRuntimeFlags,
} from "./runtime_flags.ts";
import {
  CLIENT_AUTOCOMPLETE_COMMANDS,
  TERMINAL_INITIAL_COMMANDS,
  TERMINAL_WELCOME_HELP_STDOUT,
} from "./terminal_catalog.ts";
import {
  DASHBOARD_API,
  DASHBOARD_META,
  dashboardApiUrl,
} from "./config/dashboard.ts";
import { TOKENS_TOML_VERSION } from "./tokens.registry.generated.ts";
import {
  applyShadowSliceToLocation,
  buildBookdeskopsDirectoryRouteHref,
  buildBookdeskopsTokensDeskHref,
  buildDashboardShadowSliceUrl,
  formatShadowSliceRibbonLabel,
  NFL_1H_PREGAME_SLICE,
  shadowSliceHasTapeFocus,
  sportFilterForSlice,
  summarizeSliceWagers,
  wagerSearchHintForSlice,
} from "./desk_quick_jump.ts";
import type { ReverseDnsClassification } from "../../../lib/bun_dns.ts";
import {
  buildReverseDnsForensicsView,
  type ReverseDnsForensicsView,
} from "../../../lib/reverse_dns_forensics.ts";
import { useActiveShadowSlice } from "./use_active_shadow_slice.ts";
import { getDashboardBuildInfo } from "./build_info.ts";
import { feedFreshnessTitle, quickJumpFeedState } from "./quick_jump_feed.ts";
import {
  DEFAULT_DASHBOARD_URL_STATE,
  readDashboardUrlState,
  writeDashboardUrl,
  type DashboardUrlState,
} from "./url_state.ts";
import {
  findWagerByTicketParam,
  syncTicketInspectorToLocation,
} from "./ticket_inspector.ts";
import { DEMO_CUSTOMER_COUNT } from "./data/demo_customers.ts";
import { trackedFetch } from "./api_usage.ts";
import {
  type AlertFilter,
  type AlertToastState,
  type BetTickerApiResponse,
  type Billy666BranchCounts,
  type Billy666BranchFilter,
  type BuildMatrixRow,
  type CustomerAccountScope,
  type CustomerRatingApiPayload,
  type CustomersApiResponse,
  type CustomerScopeCounts,
  type CustomerSortKey,
  type Daemon4020Status,
  DASHBOARD_TAB_SPECS,
  type DashboardAlertRecord,
  type DashboardData,
  type DashboardSourceProvenance,
  type DashboardTabId,
  type DnsData,
  type HealthData,
  type LiveBetsV2SummarySnapshot,
  type LiveWager,
  type LiveWagersClvSummary,
  type R2PipelineApiResponse,
  type R2PipelineHistoryApiResponse,
  type RankingsFilter,
  type ShiftSummaryData,
  type ShowcaseCustomer,
  type StaticDirectoryProbeSummary,
  type TerminalCategory,
  type TerminalHistoryEntry,
  type TierStyleConfig,
  type SlabPolicySummary,
  type WagerSortField,
  type WagersWireContractSummary,
} from "./types.ts";

export * from "./types.ts";
export { ErrorBoundary } from "./ErrorBoundary.tsx";

/**
 * Why the profile cards are empty: no endpoint serves the per-customer card list, and two of the
 * three fields the UI used to promise have no source at all — the cohort file carries a scalar
 * `sharp_score` (no components) and no VaR. The copy names only what the data supports, so filling
 * the cards later cannot quietly omit them.
 * `GET /api/customer/profile?id=` returns one book profile by ID in a different shape.
 */
export const PROFILES_UNAVAILABLE_REASON =
  "Profile cards are limited to what the curated cohort file records: wager limit, delay, CLV and " +
  "sharpness score. VaR and sharpness components have no source yet, so they stay blank rather than " +
  `computed from nothing. The cohort is ${DEMO_CUSTOMER_COUNT} synthetic fixtures — a demo surface, not the book. ` +
  "Real-account profiles are a separate surface, blocked on the same exposure constraint as #242.";

function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function apiPostHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const csrf = getCsrfToken();
  if (csrf) {
    headers["x-csrf-token"] = csrf;
  }
  return headers;
}

/** Primary header navigation: each item is a real view and an in-page anchor. */
interface PrimaryNavItem {
  readonly hash: string;
  readonly label: string;
  readonly tab: DashboardTabId;
  readonly title: string;
}

const PRIMARY_NAV_ITEMS: readonly PrimaryNavItem[] = [
  {
    hash: "risk-overview",
    label: DASHBOARD_TAB_SPECS.surveillance.label,
    tab: "surveillance",
    title: DASHBOARD_TAB_SPECS.surveillance.description,
  },
  {
    hash: "bettor-churn-simulation",
    label: "Bettor Churn Simulation",
    tab: "customers",
    title: "Bettor profiles, churn hazard and sizing discipline",
  },
  {
    hash: "system-logs",
    label: "System Logs",
    tab: "terminal",
    title: "Operator PTY console and system output",
  },
];

export const PRIMARY_SECTION_HASHES: readonly string[] = PRIMARY_NAV_ITEMS.map(
  (item) => item.hash,
);

function initialDashboardUrlState(): DashboardUrlState {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_URL_STATE;
  return readDashboardUrlState(
    window.location.search,
    window.location.pathname,
    window.location.hash,
  );
}

function resolveInitialUrlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? "";
}

export function resolveLocalSpaPort(): string {
  if (typeof window === "undefined") return "4022";
  const port = window.location.port?.trim();
  return port && port.length > 0 ? port : "4022";
}

export function summarizeDaemonDegradedCause(
  daemon: Daemon4020Status | null | undefined,
): string | null {
  if (!daemon) return null;
  const state = resolveDaemon4020State(daemon);
  if (state === "online") return null;
  const authParts: string[] = [];
  if (daemon.auth?.f402 && daemon.auth.f402.status !== "ok") {
    authParts.push(`F402 ${daemon.auth.f402.status}`);
  }
  if (daemon.auth?.gslive && daemon.auth.gslive.status !== "ok") {
    authParts.push(`GSLive ${daemon.auth.gslive.status}`);
  }
  if (authParts.length > 0) {
    return authParts.join(" · ");
  }
  const rawReason = daemon.reason?.trim() ?? "";
  if (!rawReason) return null;
  const firstClause = (rawReason.split(";")[0] ?? rawReason).trim();
  return firstClause.length > 42
    ? `${firstClause.slice(0, 39).trimEnd()}...`
    : firstClause;
}

export function formatFooterTimestamp(iso: string | undefined): {
  readonly display: string;
  readonly title: string;
} {
  const trimmed = iso?.trim() ?? "";
  if (!trimmed) {
    return {
      display: "—",
      title: "No snapshot timestamp yet",
    };
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return {
      display: trimmed,
      title: trimmed,
    };
  }
  const display = `${parsed.toISOString().slice(0, 19).replace("T", " ")} UTC`;
  return {
    display,
    title: trimmed,
  };
}

export function App(): React.ReactElement {
  const runtimeFlags = getDashboardRuntimeFlags();
  const buildInfo = getDashboardBuildInfo();
  const initialUrl = initialDashboardUrlState();
  const [activeTab, setActiveTab] = useState<DashboardTabId>(
    () => initialUrl.tab,
  );
  // The header nav reflects the view actually on screen, never a remembered click.
  const activePrimaryNav =
    PRIMARY_NAV_ITEMS.find((item) => item.tab === activeTab) ?? null;
  const [showBuildMatrix, setShowBuildMatrix] = useState<boolean>(
    () => initialUrl.matrix,
  );
  const [buildMatrixRows, setBuildMatrixRows] = useState<
    readonly BuildMatrixRow[] | null
  >(null);
  const [buildMatrixLoading, setBuildMatrixLoading] = useState<boolean>(false);
  const [buildMatrixError, setBuildMatrixError] = useState<string | null>(null);
  const [buildMatrixGeneratedAt, setBuildMatrixGeneratedAt] = useState<
    string | null
  >(null);
  const [buildMatrixCompiledMs, setBuildMatrixCompiledMs] = useState<
    number | null
  >(null);
  const [buildMatrixStaticDir, setBuildMatrixStaticDir] =
    useState<StaticDirectoryProbeSummary | null>(null);
  const [rankingsFilter, setRankingsFilter] = useState<RankingsFilter>("ALL");
  const [rankingsSearch, setRankingsSearch] = useState<string>(
    () => initialUrl.agent,
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() =>
    initialUrl.agent ? initialUrl.agent.toUpperCase() : null,
  );
  const [wagerSearch, setWagerSearch] = useState("");
  const [wagerSportFilter, setWagerSportFilter] = useState<string>(
    () => initialUrl.wSport,
  );
  const [wagerAlertFilter, setWagerAlertFilter] = useState<string>(
    () => initialUrl.wAlert,
  );
  const [wagerTypeFilter, setWagerTypeFilter] = useState<string>(
    () => initialUrl.wType,
  );
  const [wagerChannelFilter, setWagerChannelFilter] = useState<string>(
    () => initialUrl.wChannel,
  );
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null);
  const [selectedWager, setSelectedWager] = useState<LiveWager | null>(null);
  // Default sort comes from packages/ui/src/config/wagers.toml ([table] table).
  const [wagerSortField, setWagerSortField] = useState<WagerSortField>(
    () => initialUrl.wSort,
  );
  const [wagerSortDir, setWagerSortDir] = useState<"asc" | "desc">(
    () => initialUrl.wDir,
  );
  const [clockTime, setClockTime] = useState<string>("");
  const [terminalCategory, setTerminalCategory] =
    useState<TerminalCategory>("ALL");
  const [copiedCommandIdx, setCopiedCommandIdx] = useState<number | null>(null);
  const [copiedTerminalIdx, setCopiedTerminalIdx] = useState<number | null>(
    null,
  );
  const [data, setData] = useState<DashboardData | null>(null);
  const [dnsData, setDnsData] = useState<DnsData | null>(null);
  const [dnsRefreshing, setDnsRefreshing] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"interactive" | "raw">(
    "interactive",
  );
  const [connected, setConnected] = useState(false);
  /** Wager-stream bookkeeping: when the feed last landed and which tickets are new. */
  const seenWagerIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedWagersRef = useRef(false);
  const freshTicketsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [newTicketIds, setNewTicketIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [wagersUpdatedAt, setWagersUpdatedAt] = useState<number | null>(null);
  const [benchResult, setBenchResult] = useState<string | null>(null);
  const [benchLoading, setBenchLoading] = useState(false);
  const [reverseIp, setReverseIp] = useState("1.1.1.1");
  const [reverseForensics, setReverseForensics] =
    useState<ReverseDnsForensicsView | null>(null);

  // Customer Showcase state
  const [searchQuery, setSearchQuery] = useState(() =>
    resolveInitialUrlParam("search"),
  );
  const [filterTier, setFilterTier] = useState<string>("ALL");
  const [customerScope, setCustomerScope] =
    useState<CustomerAccountScope>("ALL_REAL");
  const [masterBranchFilter, setMasterBranchFilter] =
    useState<Billy666BranchFilter>("ALL");
  const [copiedCliId, setCopiedCliId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] =
    useState<ShowcaseCustomer | null>(null);
  const [selectedCustomerHydrated, setSelectedCustomerHydrated] =
    useState<ShowcaseCustomer | null>(null);
  const [selectedCustomerRating, setSelectedCustomerRating] =
    useState<CustomerRatingApiPayload | null>(null);
  const [selectedCustomerRatingLoading, setSelectedCustomerRatingLoading] =
    useState<boolean>(false);
  const [onDemandCustomer, setOnDemandCustomer] =
    useState<ShowcaseCustomer | null>(null);
  const [customerLookupNotice, setCustomerLookupNotice] = useState<
    string | null
  >(null);
  const [customerReverseForensics, setCustomerReverseForensics] =
    useState<ReverseDnsForensicsView | null>(null);
  /** HMR/back-compat: older dashboard bundles referenced this name. */
  const customerForensicResult = customerReverseForensics;

  // Runtime Declarative Wager Tiers + Live API Hydration state
  const [tiersConfig, setTiersConfig] = useState<TierStyleConfig | null>(null);
  const [liveWagers, setLiveWagers] = useState<readonly LiveWager[]>([]);
  const [wagersClvSummary, setWagersClvSummary] =
    useState<LiveWagersClvSummary | null>(null);
  const [liveBetsSnapshot, setLiveBetsSnapshot] =
    useState<LiveBetsV2SummarySnapshot | null>(null);
  const [wagersProvenance, setWagersProvenance] =
    useState<DashboardSourceProvenance>(PENDING_WAGERS_PROVENANCE);
  const [wagersError, setWagersError] = useState<string | null>(null);
  const [wireContract, setWireContract] =
    useState<WagersWireContractSummary | null>(null);
  const [slabPolicy, setSlabPolicy] = useState<SlabPolicySummary | null>(null);
  const [betTickerData, setBetTickerData] =
    useState<BetTickerApiResponse | null>(null);
  const [betTickerLoading, setBetTickerLoading] = useState<boolean>(false);
  const [betTickerError, setBetTickerError] = useState<string | null>(null);
  const [r2PipelineData, setR2PipelineData] =
    useState<R2PipelineApiResponse | null>(null);
  const [r2PipelineLoading, setR2PipelineLoading] = useState<boolean>(false);
  const [r2PipelineError, setR2PipelineError] = useState<string | null>(null);
  const [r2PipelineHistory, setR2PipelineHistory] =
    useState<R2PipelineHistoryApiResponse | null>(null);
  const [r2PipelineHistoryError, setR2PipelineHistoryError] = useState<
    string | null
  >(null);
  const [verifyingTickets, setVerifyingTickets] = useState<boolean>(false);
  const [verifyTicketsError, setVerifyTicketsError] = useState<string | null>(
    null,
  );
  const [cohortsReport, setCohortsReport] =
    useState<CustomersApiResponse | null>(null);
  const [cohortsStatus, setCohortsStatus] = useState<
    "pending" | "ready" | "unavailable"
  >("pending");
  const [cohortsError, setCohortsError] = useState<string | null>(null);
  // Every customer row the desk actually has: fixture-book rows first (richer), then the
  // full backtest cohort. A missing/unavailable payload leaves this empty, which is what
  // keeps the Profiles tab in its explicit "no source" state.
  const activeShadowSlice = useActiveShadowSlice();
  const shadowSliceTape = useMemo(
    () => summarizeSliceWagers(liveWagers, activeShadowSlice),
    [liveWagers, activeShadowSlice],
  );
  const tapeRiskUsd = shadowSliceHasTapeFocus(activeShadowSlice)
    ? shadowSliceTape.riskUsd
    : liveWagers.reduce((s, w) => s + w.riskUsd, 0);
  const tapeTicketCount = shadowSliceHasTapeFocus(activeShadowSlice)
    ? shadowSliceTape.count
    : liveWagers.length;

  // Quick-Jump ribbon freshness. The App re-renders on the per-second clock, so
  // the age is recomputed without a second timer; `wagersUpdatedAt` is the last
  // successful snapshot, never the render time.
  const quickJumpFeed = quickJumpFeedState(wagersUpdatedAt, Date.now());
  const quickJumpNcaabActive =
    activeTab === "wagers" && wagerSportFilter.toUpperCase() === "NCAAB";
  const quickJumpChannelFilter = wagerChannelFilter.toUpperCase();
  const quickJumpAuditActive =
    activeTab === "customers" &&
    (selectedCustomer?.id ?? "").toUpperCase() === "BRT106";

  const [quickLinkCopyState, setQuickLinkCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const quickLinkCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (quickLinkCopyTimer.current !== null) {
        clearTimeout(quickLinkCopyTimer.current);
      }
    },
    [],
  );
  const handleCopyQuickLink = () => {
    if (typeof window === "undefined") return;
    void copyText(window.location.href).then((result) => {
      setQuickLinkCopyState(result.ok ? "copied" : "failed");
      if (quickLinkCopyTimer.current !== null) {
        clearTimeout(quickLinkCopyTimer.current);
      }
      quickLinkCopyTimer.current = setTimeout(
        () => setQuickLinkCopyState("idle"),
        1_800,
      );
    });
  };

  const viewIsDefault =
    activeTab === DEFAULT_DASHBOARD_URL_STATE.tab &&
    !showBuildMatrix &&
    (selectedAgentId ?? "") === "" &&
    wagerSportFilter === DEFAULT_DASHBOARD_URL_STATE.wSport &&
    wagerAlertFilter === DEFAULT_DASHBOARD_URL_STATE.wAlert &&
    wagerTypeFilter === DEFAULT_DASHBOARD_URL_STATE.wType &&
    wagerChannelFilter === DEFAULT_DASHBOARD_URL_STATE.wChannel &&
    wagerSortField === DEFAULT_DASHBOARD_URL_STATE.wSort &&
    wagerSortDir === DEFAULT_DASHBOARD_URL_STATE.wDir;

  const handleResetView = () => {
    setActiveTab(DEFAULT_DASHBOARD_URL_STATE.tab);
    setShowBuildMatrix(false);
    setWagerSportFilter(DEFAULT_DASHBOARD_URL_STATE.wSport);
    setWagerAlertFilter(DEFAULT_DASHBOARD_URL_STATE.wAlert);
    setWagerTypeFilter(DEFAULT_DASHBOARD_URL_STATE.wType);
    setWagerChannelFilter(DEFAULT_DASHBOARD_URL_STATE.wChannel);
    setWagerSortField(DEFAULT_DASHBOARD_URL_STATE.wSort);
    setWagerSortDir(DEFAULT_DASHBOARD_URL_STATE.wDir);
    setSelectedAgentId(null);
    setRankingsSearch("");
  };

  const openWagersForShadowSlice = () => {
    setWagerChannelFilter("ALL");
    setWagerAlertFilter("ALL");
    setWagerTypeFilter("ALL");
    setWagerSportFilter(sportFilterForSlice(activeShadowSlice));
    const searchHint = wagerSearchHintForSlice(activeShadowSlice);
    setWagerSearch(searchHint);
    setActiveTab("wagers");
  };

  const [rankings, setRankings] = useState<NormalizedRankingsResult | null>(
    null,
  );
  const [rankingsStatus, setRankingsStatus] = useState<
    "pending" | "ready" | "unavailable"
  >("pending");
  const [rankingsError, setRankingsError] = useState<string | null>(null);

  const cohortProfileRows = useMemo<readonly ShowcaseCustomer[]>(() => {
    if (cohortsReport === null) {
      return onDemandCustomer ? [onDemandCustomer] : [];
    }
    const base = mergeProfileRows(
      selectProfileRows(cohortsReport),
      backtestRowsToProfiles(cohortsReport.backtestAll),
    );
    return onDemandCustomer ? mergeProfileRows(base, [onDemandCustomer]) : base;
  }, [cohortsReport, onDemandCustomer]);

  const rankedProfileRows = useMemo<readonly ShowcaseCustomer[]>(
    () =>
      rankings?.players ? rankingsPlayersToProfiles(rankings.players) : [],
    [rankings?.players],
  );

  const liveOpenProfileRows = useMemo<readonly ShowcaseCustomer[]>(
    () => (liveWagers.length ? liveOpenWagersToProfiles(liveWagers) : []),
    [liveWagers],
  );

  const cutoff7dYmd = useMemo(() => {
    const endRaw = rankings?.summary.windowEnd;
    const endYmd =
      endRaw && /^\d{4}-\d{2}-\d{2}/.test(endRaw)
        ? endRaw.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    const ms = Date.parse(`${endYmd}T12:00:00Z`);
    if (!Number.isFinite(ms)) return "";
    return new Date(ms - 6 * 86_400_000).toISOString().slice(0, 10);
  }, [rankings?.summary.windowEnd]);

  const {
    realUniverse,
    withSyntheticUniverse,
    syntheticCohortCount,
    scopeCounts,
    masterBranchCounts,
    formulaKpiCards,
  } = useMemo(() => {
    const realCohort = cohortProfileRows.filter(
      (c) => !isSyntheticShowcaseCustomer(c),
    );
    const synthCohort = cohortProfileRows.filter((c) =>
      isSyntheticShowcaseCustomer(c),
    );
    const mergedReal = mergeOpenRiskOverlay(
      mergeProfileRows(
        realCohort,
        rankedProfileRows,
        liveOpenProfileRows,
        onDemandCustomer && !isSyntheticShowcaseCustomer(onDemandCustomer)
          ? [onDemandCustomer]
          : [],
      ),
      liveWagers,
    );
    const mergedWithSynth = mergeOpenRiskOverlay(
      mergeProfileRows(
        mergedReal,
        synthCohort,
        onDemandCustomer ? [onDemandCustomer] : [],
      ),
      liveWagers,
    );

    const isActive7d = (c: ShowcaseCustomer): boolean =>
      (c.openRiskUsd ?? 0) > 0 ||
      c.source === "live-open" ||
      (c.lastWagerAt !== undefined &&
        cutoff7dYmd !== "" &&
        c.lastWagerAt.slice(0, 10) >= cutoff7dYmd);

    let active7d = 0;
    let liveOpen = 0;
    let withClv = 0;
    let curated = 0;
    let countNolawolf = 0;
    let countBilly667 = 0;
    let countRtest5 = 0;
    let countSaints2009 = 0;
    let countOtherBranch = 0;

    for (const c of mergedReal) {
      if (isActive7d(c)) active7d += 1;
      if ((c.openRiskUsd ?? 0) > 0 || c.source === "live-open") liveOpen += 1;
      if (typeof c.clvBps === "number" && Number.isFinite(c.clvBps)) {
        withClv += 1;
      }
      if (
        c.source === "book" ||
        c.source === "backtest" ||
        c.source === "fixture"
      ) {
        curated += 1;
      }
      const m = c.masterAgent.trim().toUpperCase();
      const a = c.agentId.trim().toUpperCase();
      if (m === "NOLAWOLF" || a === "NOLAWOLF") countNolawolf += 1;
      else if (m === "BILLY667" || a === "BILLY667") countBilly667 += 1;
      else if (m === "RTEST5" || a === "RTEST5") countRtest5 += 1;
      else if (m === "SAINTS2009" || a === "SAINTS2009") countSaints2009 += 1;
      else countOtherBranch += 1;
    }

    const counts: CustomerScopeCounts = {
      allReal: mergedReal.length,
      active7d,
      liveOpen,
      withClv,
      curated,
      synthetic: synthCohort.length,
    };

    const branches: Billy666BranchCounts = {
      all: mergedReal.length,
      NOLAWOLF: countNolawolf,
      BILLY667: countBilly667,
      RTEST5: countRtest5,
      SAINTS2009: countSaints2009,
      OTHER: countOtherBranch,
    };

    return {
      realUniverse: mergedReal,
      withSyntheticUniverse: mergedWithSynth,
      syntheticCohortCount: synthCohort.length,
      scopeCounts: counts,
      masterBranchCounts: branches,
      formulaKpiCards:
        mergedReal.length > 0
          ? deriveLiveFormulaCohortKpiCards(mergedReal)
          : null,
    };
  }, [
    cohortProfileRows,
    rankedProfileRows,
    liveOpenProfileRows,
    liveWagers,
    onDemandCustomer,
    cutoff7dYmd,
  ]);

  const includeSyntheticForQuery =
    customerScope === "ALL_WITH_SYNTHETIC" ||
    searchQuery.trim().toUpperCase().includes("SYNTH") ||
    selectedCustomer?.id.toUpperCase().startsWith("SYNTH_") === true ||
    realUniverse.length === 0;

  const profileCustomers = useMemo<readonly ShowcaseCustomer[]>(() => {
    if (showBuildMatrix && realUniverse.length === 0) {
      return mergeMatrixProfileOverlay(
        cohortProfileRows,
        rankings?.players ?? null,
        liveWagers,
      );
    }
    return includeSyntheticForQuery ? withSyntheticUniverse : realUniverse;
  }, [
    showBuildMatrix,
    includeSyntheticForQuery,
    withSyntheticUniverse,
    realUniverse,
    cohortProfileRows,
    rankings?.players,
    liveWagers,
  ]);

  const matrixProfileOverlay = useMemo(() => {
    if (!showBuildMatrix) return null;
    const ids = new Set(profileCustomers.map((c) => c.id.toUpperCase()));
    let liveOnly = 0;
    let rankedOnly = 0;
    for (const c of profileCustomers) {
      if (c.source === "live-open") liveOnly += 1;
      if (c.source === "rankings") rankedOnly += 1;
    }
    return {
      total: ids.size,
      liveOpen: liveOnly,
      ranked: rankedOnly,
      cohort: cohortProfileRows.length,
      liveWagersDistinct: new Set(
        liveWagers.map((w) => w.customerId.toUpperCase()),
      ).size,
    };
  }, [showBuildMatrix, profileCustomers, cohortProfileRows.length, liveWagers]);

  const profilesProvenance =
    profileCustomers.length === 0 && cohortsReport === null
      ? null
      : `${profileCustomers.length.toLocaleString()} accounts loaded (${scopeCounts.curated.toLocaleString()} curated · ${rankedProfileRows.length.toLocaleString()} 30d active · ${scopeCounts.liveOpen.toLocaleString()} live-open · ${scopeCounts.withClv.toLocaleString()} w/ CLV${syntheticCohortCount > 0 ? ` · ${syntheticCohortCount} synthetic ${includeSyntheticForQuery ? "shown" : "hidden"}` : ""})${rankingsStatus === "pending" ? " · hydrating 30d corpus…" : ""} · GET /api/customers + /api/rankings/all + /api/wagers`;

  const fetchTiersConfig = async () => {
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.tiers));
      if (!res.ok) return;
      const cfg = (await res.json()) as { tiers?: TierStyleConfig } | null;
      if (cfg?.tiers) {
        setTiersConfig(cfg.tiers);
      }
    } catch (err) {
      console.warn(
        "[dashboard] failed to load /api/config/tiers, keeping defaults:",
        err,
      );
    }
  };

  const failLiveWagers = (message: string) => {
    setWagersError(message);
    setWagersProvenance(unavailableProvenance("/api/wagers", message));
  };

  const fetchLiveWagers = async () => {
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.wagers));
      if (!res.ok) {
        failLiveWagers(
          `GET /api/wagers returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const normalized = normalizeLiveWagersResponse(await res.json());
      if (!normalized) {
        failLiveWagers(
          "GET /api/wagers returned unexpected LiveWagersApiResponse payload",
        );
        return;
      }
      setLiveWagers(normalized.wagers);
      setWagersClvSummary(normalized.clvSummary ?? null);
      setWagersProvenance(normalized.provenance);
      setWireContract(normalized.wireContract);
      setSlabPolicy(normalized.slabPolicy);
      setWagersError(null);

      // Streaming: mark tickets that were not in the previous snapshot. The first load
      // is not "new" — every row would otherwise flash.
      const nextIds = new Set(normalized.wagers.map((w) => w.ticketId));
      if (hasLoadedWagersRef.current) {
        const fresh = diffNewTicketIds(seenWagerIdsRef.current, nextIds);
        if (fresh.length > 0) {
          setNewTicketIds(new Set(fresh));
          if (freshTicketsTimerRef.current !== null) {
            clearTimeout(freshTicketsTimerRef.current);
          }
          freshTicketsTimerRef.current = setTimeout(() => {
            setNewTicketIds(new Set());
            freshTicketsTimerRef.current = null;
          }, 15_000);
        }
      }
      hasLoadedWagersRef.current = true;
      seenWagerIdsRef.current = nextIds;
      setWagersUpdatedAt(Date.now());
      if (normalized.wagers.length > 0) {
        const ticketFromUrl =
          typeof window !== "undefined"
            ? (new URLSearchParams(window.location.search)
                .get("ticket")
                ?.trim() ?? "")
            : "";
        const urlPick =
          ticketFromUrl !== ""
            ? findWagerByTicketParam(normalized.wagers, ticketFromUrl)
            : null;
        setSelectedWager((prev) => {
          if (urlPick !== null) {
            return urlPick;
          }
          if (
            prev &&
            normalized.wagers.some((w) => w.ticketId === prev.ticketId)
          ) {
            return prev;
          }
          return normalized.wagers[0] ?? null;
        });
      }
    } catch (err) {
      failLiveWagers(
        `GET /api/wagers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const fetchCustomersCohorts = async () => {
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.customers));
      if (!res.ok) {
        setCohortsStatus("unavailable");
        setCohortsError(
          `GET /api/customers returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const normalized = normalizeCustomersCohortResponse(await res.json());
      if (!normalized) {
        setCohortsStatus("unavailable");
        setCohortsError(
          "GET /api/customers returned unexpected CustomersApiResponse payload",
        );
        return;
      }
      setCohortsReport(normalized);
      setCohortsStatus("ready");
      setCohortsError(null);
    } catch (err) {
      setCohortsStatus("unavailable");
      setCohortsError(
        `GET /api/customers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const fetchLiveBetsSnapshot = async () => {
    try {
      const res = await trackedFetch(
        dashboardApiUrl("/api/v2/live-bets?source=file&fallback=sample"),
      );
      if (!res.ok) return;
      const parsed = normalizeLiveBetsV2Summary(await res.json());
      if (parsed) {
        setLiveBetsSnapshot(parsed);
      }
    } catch {
      // Optional enrichment strip: ignore when endpoint unavailable
    }
  };

  const fetchRankings = async () => {
    const slice = await fetchRankingsSlice(fetch, 10_000);
    if (slice.ok) {
      setRankings(slice.data);
      setRankingsStatus("ready");
      setRankingsError(null);
    } else {
      setRankingsStatus("unavailable");
      setRankingsError(slice.error);
    }
  };

  const fetchBetTicker = async () => {
    setBetTickerLoading(true);
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.bet_ticker));
      if (!res.ok) {
        setBetTickerError(
          `GET /api/bet-ticker returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const payload = (await res.json()) as BetTickerApiResponse;
      setBetTickerData(payload);
      setBetTickerError(null);
    } catch (err) {
      setBetTickerError(
        `GET /api/bet-ticker failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBetTickerLoading(false);
    }
  };

  const fetchR2Pipeline = async (force = false) => {
    setR2PipelineLoading(true);
    try {
      const res = await trackedFetch(
        force ? "/api/r2/pipeline?refresh=1" : "/api/r2/pipeline",
      );
      if (!res.ok) {
        setR2PipelineError(
          `GET /api/r2/pipeline returned HTTP ${res.status} (${res.statusText || "error"})`,
        );
        return;
      }
      const payload = (await res.json()) as R2PipelineApiResponse;
      setR2PipelineData(payload);
      setR2PipelineError(null);
    } catch (err) {
      setR2PipelineError(
        `GET /api/r2/pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setR2PipelineLoading(false);
    }
  };

  const fetchR2PipelineHistory = async (refresh = false) => {
    try {
      const res = await trackedFetch(
        `/api/r2/pipeline/history?limit=60${refresh ? "&refresh=1" : ""}`,
      );
      if (!res.ok) {
        setR2PipelineHistoryError(
          `GET /api/r2/pipeline/history returned HTTP ${res.status}`,
        );
        return;
      }
      setR2PipelineHistory((await res.json()) as R2PipelineHistoryApiResponse);
      setR2PipelineHistoryError(null);
    } catch (err) {
      setR2PipelineHistoryError(
        `GET /api/r2/pipeline/history failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const runTicketVerification = async (dryRun = true) => {
    setVerifyingTickets(true);
    try {
      const res = await trackedFetch("/api/gslive/verify-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      if (!res.ok) {
        setVerifyTicketsError(
          `POST /api/gslive/verify-tickets returned HTTP ${res.status}`,
        );
        return;
      }
      setVerifyTicketsError(null);
      await fetchR2Pipeline(true);
    } catch (err) {
      setVerifyTicketsError(
        `POST /api/gslive/verify-tickets failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setVerifyingTickets(false);
    }
  };

  const fetchBuildMatrix = (force = false) => {
    setBuildMatrixLoading(true);
    setBuildMatrixError(null);
    const startedAt = performance.now();
    trackedFetch(force ? "/api/build-matrix?refresh=1" : "/api/build-matrix")
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(
            `GET /api/build-matrix${force ? "?refresh=1" : ""} returned HTTP ${r.status}`,
          );
        }
        return (await r.json()) as {
          targets?: readonly BuildMatrixRow[];
          generatedAt?: string;
          staticDir?: StaticDirectoryProbeSummary;
        };
      })
      .then((json) => {
        if (json?.targets) {
          debugDashboardTrace("loaded DCE build matrix", json);
          setBuildMatrixRows(json.targets);
          setBuildMatrixGeneratedAt(
            typeof json.generatedAt === "string" ? json.generatedAt : null,
          );
          setBuildMatrixCompiledMs(Math.round(performance.now() - startedAt));
          setBuildMatrixStaticDir(json.staticDir ?? null);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("Build matrix probe unavailable:", err);
        setBuildMatrixError(msg);
      })
      .finally(() => setBuildMatrixLoading(false));
  };

  useEffect(() => {
    const deepLinkCustomer = resolveInitialUrlParam("customer");
    if (deepLinkCustomer) {
      const upper = deepLinkCustomer.toUpperCase();
      if (!attemptedOnDemandRef.current.has(upper)) {
        setSearchQuery(deepLinkCustomer);
        setCustomerLookupNotice(upper);
        fetchCustomerOnDemand(upper);
      }
    }
    void fetchTiersConfig();
    void fetchLiveWagers();
    void fetchCustomersCohorts();
    void fetchLiveBetsSnapshot();
    void fetchRankings();
    void fetchBetTicker();
    // The pipeline probe records the first history sample, so read history after it.
    void fetchR2Pipeline().then(() => fetchR2PipelineHistory());
  }, []);

  useEffect(() => {
    if (showBuildMatrix && !buildMatrixRows && !buildMatrixLoading) {
      fetchBuildMatrix();
    }
  }, [showBuildMatrix]);

  // UI enhancement states: banner dismissal & collapsible KPI cards
  const [bannerDismissed, setBannerDismissed] = useState(
    () =>
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem("portalBannerDismissed") === "1",
  );
  const [kpisCollapsed, setKpisCollapsed] = useState(() => {
    try {
      return localStorage.getItem("kpisCollapsed") === "1";
    } catch {
      return false;
    }
  });

  // Alerts, DLQ, and Operator Shift state
  const [alertRecords, setAlertRecords] = useState<DashboardAlertRecord[]>([]);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("ALL");
  const [alertLoading, setAlertLoading] = useState(false);
  const [alertToast, setAlertToast] = useState<AlertToastState | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [shiftSummary, setShiftSummary] = useState<ShiftSummaryData | null>(
    null,
  );
  const [shiftOperator, setShiftOperator] = useState<string>("operator");
  const [shiftLoading, setShiftLoading] = useState(false);

  const fetchHealth = () => {
    trackedFetch("/health")
      .then(async (res) => {
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType !== "" && !contentType.toLowerCase().includes("json")) {
          return null;
        }
        return (await res.json().catch(() => null)) as HealthData | null;
      })
      .then((health) => {
        if (health) {
          setHealthData(health);
        }
      })
      .catch(() => {});
  };

  const fetchAlerts = (filter = alertFilter) => {
    setAlertLoading(true);
    const param = filter.toLowerCase();
    trackedFetch(`/api/alerts?status=${param}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((res) => {
        if (res?.alerts) {
          setAlertRecords(res.alerts);
        }
      })
      .catch((err) => {
        console.warn("[alerts] fetch failed:", err);
      })
      .finally(() => setAlertLoading(false));
  };

  const fetchShiftSummary = async (operatorId = shiftOperator) => {
    setShiftLoading(true);
    try {
      const res = await trackedFetch(
        `/api/shift/summary?operatorId=${encodeURIComponent(operatorId)}`,
      );
      if (res.ok) {
        const summary = await res.json();
        setShiftSummary(summary);
      }
    } catch (e) {
      console.warn("[shift] summary fetch failed:", e);
    } finally {
      setShiftLoading(false);
    }
  };

  const handleAckAlert = async (deliveryId: string, notes?: string) => {
    try {
      const res = await trackedFetch(`/api/alerts/${deliveryId}/ack`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator, notes }),
      });
      if (res.ok) {
        setAlertToast({
          message: `Alert ${deliveryId.slice(0, 8)} acknowledged`,
          type: "success",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setAlertToast({
          message: `Ack failed: ${err.error ?? res.statusText}`,
          type: "error",
        });
      }
    } catch (e) {
      setAlertToast({ message: `Ack failed: ${String(e)}`, type: "error" });
    }
  };

  const handleRetryAlert = async (deliveryId: string) => {
    try {
      const res = await trackedFetch(`/api/alerts/${deliveryId}/retry`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator }),
      });
      if (res.ok) {
        const payload = await res.json();
        setAlertToast({
          message: `DLQ Replayed! New UUID: ${payload.newDeliveryId?.slice(0, 8)}`,
          type: "success",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setAlertToast({
          message: `Retry failed: ${err.error ?? res.statusText}`,
          type: "error",
        });
      }
    } catch (e) {
      setAlertToast({ message: `Retry failed: ${String(e)}`, type: "error" });
    }
  };

  const handleSweepAlerts = async () => {
    try {
      const res = await trackedFetch(`/api/alerts/sweep`, {
        method: "POST",
        headers: apiPostHeaders(),
      });
      if (res.ok) {
        const payload = await res.json();
        setAlertToast({
          message: `Queue Swept: ${payload.sweep?.sent ?? 0} sent, ${payload.sweep?.failed ?? 0} failed, ${payload.sweep?.dead ?? 0} dead`,
          type: "info",
        });
        fetchAlerts(alertFilter);
        fetchHealth();
      }
    } catch (e) {
      setAlertToast({ message: `Sweep failed: ${String(e)}`, type: "error" });
    }
  };

  // Poll /health every 15s (0 disk I/O, in-memory probe)
  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  // When switching to alerts tab, fetch alerts
  useEffect(() => {
    if (activeTab === "alerts") {
      fetchAlerts(alertFilter);
    }
  }, [activeTab, alertFilter]);

  // While the R2 pipeline tab is open, sample freshness each minute so the
  // process-local history has a series to plot (the server throttles samples).
  useEffect(() => {
    if (activeTab !== "r2") return;
    void fetchR2PipelineHistory();
    const interval = setInterval(() => {
      void fetchR2PipelineHistory(true);
    }, 60_000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // Auto-dismiss toast after 4s
  useEffect(() => {
    if (!alertToast) return;
    const t = setTimeout(() => setAlertToast(null), 4000);
    return () => clearTimeout(t);
  }, [alertToast]);

  // Terminal Emulator state
  const [terminalHistory, setTerminalHistory] = useState<
    TerminalHistoryEntry[]
  >([
    {
      command: "help",
      stdout: TERMINAL_WELCOME_HELP_STDOUT,
      exitCode: 0,
      durationMs: 0,
      timestamp: Date.now(),
      synthetic: true,
    },
  ]);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>(
    TERMINAL_INITIAL_COMMANDS,
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const terminalBottomRef = useRef<HTMLDivElement>(null);
  const initialTerminalQueryRan = useRef(false);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && e.key === "`") ||
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault();
        setActiveTab("terminal");
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>(
            "input[data-terminal-input]",
          );
          inputEl?.focus();
        }, 50);
      } else if (e.ctrlKey && e.key === "1") {
        e.preventDefault();
        setActiveTab("customers");
      } else if (e.ctrlKey && e.key === "2") {
        e.preventDefault();
        setActiveTab("surveillance");
      } else if (e.ctrlKey && e.key === "3") {
        e.preventDefault();
        setActiveTab("terminal");
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>(
            "input[data-terminal-input]",
          );
          inputEl?.focus();
        }, 50);
      } else if (e.ctrlKey && e.key === "4") {
        e.preventDefault();
        setActiveTab("rankings");
      } else if (e.ctrlKey && e.key === "5") {
        e.preventDefault();
        setActiveTab("wagers");
      } else if (e.ctrlKey && e.key === "6") {
        e.preventDefault();
        setActiveTab("alerts");
      } else if (e.ctrlKey && e.key === "7") {
        e.preventDefault();
        setActiveTab("shadow");
      } else if (e.ctrlKey && e.key === "8") {
        e.preventDefault();
        setActiveTab("bet-ticker");
      } else if (e.ctrlKey && e.key === "9") {
        e.preventDefault();
        setActiveTab("r2");
      } else if (e.ctrlKey && e.key === "0") {
        e.preventDefault();
        setActiveTab("assets");
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const et = now.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const ct = now.toLocaleTimeString("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      setClockTime(`${et} ET · ${ct} CT`);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleWagerSort = (field: WagerSortField) => {
    if (wagerSortField === field) {
      setWagerSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setWagerSortField(field);
      setWagerSortDir("desc");
    }
  };

  const knownCustomerIds = (): readonly string[] => [
    ...new Set([
      ...liveWagers.map((w) => w.customerId),
      ...(rankings?.players ?? []).map((p) => p.id),
    ]),
  ];

  const handleAutocomplete = () => {
    const trimmed = terminalCommand.trimStart();
    if (!trimmed) {
      setTerminalCommand("help");
      return;
    }

    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 1) {
      const prefix = tokens[0]!.toLowerCase();
      const cmdMatch = CLIENT_AUTOCOMPLETE_COMMANDS.find((c) =>
        c.toLowerCase().startsWith(prefix),
      );
      if (cmdMatch) {
        setTerminalCommand(cmdMatch + " ");
        return;
      }
      const idMatch = knownCustomerIds().find((id) =>
        id.toLowerCase().startsWith(prefix),
      );
      if (idMatch) {
        setTerminalCommand("p " + idMatch);
        return;
      }
    } else if (tokens.length === 2) {
      const cmd = tokens[0]!.toLowerCase();
      const argPrefix = tokens[1]!.toUpperCase();
      if (cmd === "profile" || cmd === "p" || cmd === "c") {
        const idMatch = knownCustomerIds().find((id) =>
          id.toUpperCase().startsWith(argPrefix),
        );
        if (idMatch) {
          setTerminalCommand(`${tokens[0]} ${idMatch}`);
          return;
        }
      } else if (cmd === "find" || cmd === "f") {
        const candidates = [
          "-t",
          "-s",
          "-a",
          "sharp",
          "syndicate",
          "CFB",
          "NFL",
        ];
        const match = candidates.find((c) =>
          c.toLowerCase().startsWith(tokens[1]!.toLowerCase()),
        );
        if (match) {
          setTerminalCommand(`${tokens[0]} ${match} `);
          return;
        }
      }
    }
  };

  const runTerminalCommand = async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (trimmed.toLowerCase() === "clear") {
      setTerminalHistory([]);
      setTerminalCommand("");
      return;
    }

    setCommandHistory((prev) => [
      ...prev.filter((c) => c !== trimmed),
      trimmed,
    ]);
    setHistoryIndex(-1);
    setTerminalLoading(true);

    try {
      const cols =
        typeof window !== "undefined"
          ? Math.max(
              96,
              Math.min(130, Math.floor((window.innerWidth - 110) / 7.5)),
            )
          : 120;
      const res = await trackedFetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, cols, rows: 30 }),
      });

      if (res.ok) {
        const json = (await res.json()) as Partial<TerminalHistoryEntry> & {
          error?: string;
        };
        const stdout = json.stdout;
        if (typeof stdout !== "string") {
          setTerminalHistory((prev) => [
            ...prev,
            {
              command: trimmed,
              stdout: `\x1b[31m[TERMINAL_BAD_PAYLOAD] POST /api/terminal/exec returned no stdout string\x1b[0m\n\x1b[90mThe command did not produce a renderable result; nothing was added verbatim.\x1b[0m`,
              exitCode: 1,
              durationMs: 0,
              timestamp: Date.now(),
            },
          ]);
        } else {
          setTerminalHistory((prev) => [
            ...prev,
            {
              command:
                typeof json.command === "string" && json.command.length > 0
                  ? json.command
                  : trimmed,
              stdout,
              exitCode: typeof json.exitCode === "number" ? json.exitCode : 0,
              durationMs:
                typeof json.durationMs === "number" ? json.durationMs : 0,
              timestamp:
                typeof json.timestamp === "number"
                  ? json.timestamp
                  : Date.now(),
            },
          ]);
        }
      } else {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setTerminalHistory((prev) => [
          ...prev,
          {
            command: trimmed,
            stdout: `\x1b[31m[TERMINAL_ERROR] ${err.error || "Failed execution"}\x1b[0m`,
            exitCode: 1,
            durationMs: 0,
            timestamp: Date.now(),
          },
        ]);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setTerminalHistory((prev) => [
        ...prev,
        {
          command: trimmed,
          stdout: `\x1b[31m[TERMINAL_UNAVAILABLE] POST /api/terminal/exec failed: ${reason}\x1b[0m\n\x1b[90mNothing was executed. Start the dashboard server ('bun run dev') for the live Bun.Terminal PTY.\x1b[0m`,
          exitCode: 1,
          durationMs: 0,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setTerminalLoading(false);
      setTerminalCommand("");
    }
  };

  useEffect(() => {
    const cmd = resolveInitialUrlParam("terminal");
    if (cmd === "" || initialTerminalQueryRan.current) {
      return;
    }
    initialTerminalQueryRan.current = true;
    setActiveTab("terminal");
    void runTerminalCommand(cmd);
  }, []);

  const runBenchmark = async () => {
    setBenchLoading(true);
    try {
      const res = await trackedFetch("/api/dns/benchmark?host=fantasy402.com");
      if (res.ok) {
        const json = await res.json();
        const metricsStr = (
          json.metrics as Array<{ backend: string; meanMs: number }>
        )
          .map((m) => `${m.backend}: ${m.meanMs}ms`)
          .join(" vs ");
        setBenchResult(
          `⚡ Fastest: ${json.fastestBackend} (${json.speedupFactor}x speedup) | ${metricsStr}`,
        );
      }
    } catch {
      setBenchResult("Benchmark failed");
    } finally {
      setBenchLoading(false);
    }
  };

  const runReverseLookup = async (ipToLookup?: string) => {
    const ip = ipToLookup || reverseIp;
    try {
      const res = await trackedFetch(
        `/api/dns/reverse?ip=${encodeURIComponent(ip)}`,
      );
      if (res.ok) {
        const json = (await res.json()) as ReverseDnsClassification;
        const view = buildReverseDnsForensicsView(json);
        if (ipToLookup) {
          setCustomerReverseForensics(view);
        } else {
          setReverseForensics(view);
        }
      }
    } catch {
      if (ipToLookup) {
        setCustomerReverseForensics(null);
      } else {
        setReverseForensics(null);
      }
    }
  };

  const fetchDnsTelemetry = async () => {
    setDnsRefreshing(true);
    setDnsError(null);
    try {
      const dnsRes = await trackedFetch("/api/dns/telemetry").then(
        async (res) => {
          if (!res.ok) return trackedFetch("/api/dns");
          return res;
        },
      );
      if (dnsRes.ok) {
        const json = (await dnsRes.json()) as DnsData;
        setDnsData(json);
      } else {
        setDnsError(`HTTP ${dnsRes.status}`);
      }
    } catch (err) {
      setDnsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDnsRefreshing(false);
    }
  };

  const fetchDashboard = async () => {
    try {
      const [dashRes] = await Promise.all([
        trackedFetch("/api/dashboard"),
        fetchDnsTelemetry(),
      ]);
      if (dashRes.ok) {
        const json = (await dashRes.json()) as DashboardData;
        setData(json);
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
    }
  };

  useEffect(() => {
    return () => {
      if (freshTicketsTimerRef.current !== null) {
        clearTimeout(freshTicketsTimerRef.current);
        freshTicketsTimerRef.current = null;
      }
    };
  }, []);

  // Streaming: the socket is primary, but a timed refresh is the backstop — a watcher that
  // misses a write (or a host with no watcher at all) must not leave the logs stale. The
  // endpoint is stat-cached server-side, so an unchanged capture costs a stat.
  useEffect(() => {
    if (activeTab !== "wagers") return;
    // The socket pushes on capture changes; this timed refetch keeps the visible table
    // fresh even when a watcher miss or a dropped socket frame would otherwise freeze it.
    const interval = setInterval(() => {
      void fetchLiveWagers();
    }, 10_000);
    return () => clearInterval(interval);
  }, [activeTab, connected]);

  useEffect(() => {
    void fetchDashboard();

    // Hot-reload WebSocket connection with React StrictMode-safe lifecycle
    let isMounted = true;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      if (isMounted) {
        setConnected(true);
        try {
          ws.send(
            JSON.stringify({
              action: "subscribe",
              topics: [
                "dashboard",
                "live-bets",
                "syndicate-alerts",
                "tiers-updated",
              ],
            }),
          );
        } catch {
          // signal-honesty: intentional-ignore-ws-subscribe-on-closing
        }
      } else {
        ws.close();
      }
    };
    ws.onclose = () => {
      if (isMounted) setConnected(false);
    };
    ws.onmessage = (event) => {
      if (!isMounted || typeof event.data !== "string") return;
      const action = parseDashboardWsSignal(event.data);
      switch (action.kind) {
        case "reload":
          void fetchDashboard();
          void fetchLiveWagers();
          void fetchBetTicker();
          void fetchCustomersCohorts();
          void fetchRankings();
          void fetchTiersConfig();
          break;
        case "dashboard-updated":
          void fetchDashboard();
          break;
        case "wagers-updated":
          void fetchLiveWagers();
          void fetchBetTicker();
          break;
        case "tiers-updated":
          if (action.tiers) {
            setTiersConfig(action.tiers as unknown as TierStyleConfig);
          } else {
            void fetchTiersConfig();
          }
          break;
        case "alerts-updated":
          fetchAlerts();
          fetchHealth();
          break;
        case "automations-updated":
          void fetchR2Pipeline(true);
          break;
        case "ack":
        case "ignore":
          break;
      }
    };

    return () => {
      isMounted = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // Wait for handshake to finish before closing to avoid browser
        // "WebSocket is closed before the connection is established" warning in React StrictMode
        ws.onopen = () => ws.close();
      }
    };
  }, []);

  const scopedCustomers = useMemo(() => {
    const scopeMatched = (() => {
      if (
        customerScope === "ALL_REAL" ||
        customerScope === "ALL_WITH_SYNTHETIC"
      ) {
        return profileCustomers;
      }
      if (customerScope === "ACTIVE_7D") {
        return profileCustomers.filter(
          (c) =>
            (c.openRiskUsd ?? 0) > 0 ||
            c.source === "live-open" ||
            (c.lastWagerAt !== undefined &&
              cutoff7dYmd !== "" &&
              c.lastWagerAt.slice(0, 10) >= cutoff7dYmd),
        );
      }
      if (customerScope === "LIVE_OPEN") {
        return profileCustomers.filter(
          (c) => (c.openRiskUsd ?? 0) > 0 || c.source === "live-open",
        );
      }
      if (customerScope === "WITH_CLV") {
        return profileCustomers.filter(
          (c) => typeof c.clvBps === "number" && Number.isFinite(c.clvBps),
        );
      }
      if (customerScope === "CURATED") {
        return profileCustomers.filter(
          (c) =>
            c.source === "book" ||
            c.source === "backtest" ||
            c.source === "fixture",
        );
      }
      return profileCustomers;
    })();

    if (masterBranchFilter === "ALL") return scopeMatched;
    return scopeMatched.filter((c) => {
      const m = c.masterAgent.trim().toUpperCase();
      const a = c.agentId.trim().toUpperCase();
      const branch =
        m === "NOLAWOLF" || a === "NOLAWOLF"
          ? "NOLAWOLF"
          : m === "BILLY667" || a === "BILLY667"
            ? "BILLY667"
            : m === "RTEST5" || a === "RTEST5"
              ? "RTEST5"
              : m === "SAINTS2009" || a === "SAINTS2009"
                ? "SAINTS2009"
                : "OTHER";
      return branch === masterBranchFilter;
    });
  }, [profileCustomers, customerScope, cutoff7dYmd, masterBranchFilter]);

  const filteredCustomers = scopedCustomers.filter((cust) => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !q ||
      cust.id.toLowerCase().includes(q) ||
      cust.name.toLowerCase().includes(q) ||
      cust.specialization.toLowerCase().includes(q) ||
      cust.agentId.toLowerCase().includes(q) ||
      cust.masterAgent.toLowerCase().includes(q);

    if (!matchesSearch) return false;
    if (filterTier === "ALL") return true;
    if (filterTier === "POSITIVE_CLV")
      return typeof cust.clvBps === "number" && cust.clvBps > 0;
    if (filterTier === "POWERED_POS_CLV")
      return (
        typeof cust.clvBps === "number" &&
        Number.isFinite(cust.clvBps) &&
        cust.clvBps > 0 &&
        (cust.sharpCandidateGatePassed === true || (cust.clvLegs ?? 0) >= 5)
      );
    if (filterTier === "PROFITABLE_CLV")
      return (
        typeof cust.clvBps === "number" &&
        Number.isFinite(cust.clvBps) &&
        cust.clvBps > 0 &&
        !(cust.unknown?.includes("ltv") ?? false) &&
        cust.ltvUsd > 0
      );
    if (filterTier === "KEY_NUMBER_BUYER")
      return cust.isKeyNumberBuyer === true;
    if (filterTier === "HOOK_OR_SYNDICATE")
      return (
        cust.isHalfPointHookBuyer === true ||
        cust.isProxyConduit === true ||
        cust.isMultiSeatCluster === true ||
        cust.syndicateRisk === "HIGH"
      );
    if (filterTier === "ELITE")
      return (
        cust.tier === "TIER_1_ELITE_ORIGINATOR" ||
        cust.tier === "TIER_2_STEAM_SYNDICATE"
      );
    if (filterTier === "SYNDICATE") return cust.syndicateRisk === "HIGH";
    if (filterTier === "STEAM") return cust.timingArchetype === "STEAM_CHASER";
    if (filterTier === "RECREATIONAL")
      return (
        cust.tier === "TIER_5_RECREATIONAL" || cust.tier.includes("TIER_5")
      );
    if (filterTier.startsWith("TIER_")) {
      return (
        cust.tier.includes(filterTier) ||
        cust.tierLabel?.includes(filterTier) === true
      );
    }
    return true;
  });

  const [customerSort, setCustomerSort] = useState<{
    key: CustomerSortKey;
    dir: 1 | -1;
  }>({ key: "score", dir: -1 });

  const onCustomerSort = (key: CustomerSortKey) =>
    setCustomerSort((s) =>
      s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 },
    );

  const sortedCustomers = useMemo(() => {
    return [...filteredCustomers].sort((a, b) => {
      if (customerSort.key === "clvBps") {
        const av = a.clvBps;
        const bv = b.clvBps;
        const aHas = typeof av === "number" && Number.isFinite(av);
        const bHas = typeof bv === "number" && Number.isFinite(bv);
        if (!aHas || !bHas) return !aHas ? (!bHas ? 0 : 1) : -1;
        return (av - bv) * customerSort.dir;
      }
      const v =
        customerSort.key === "id"
          ? a.id.localeCompare(b.id)
          : (a[customerSort.key] as number) - (b[customerSort.key] as number);
      return v * customerSort.dir;
    });
  }, [filteredCustomers, customerSort]);

  useEffect(() => {
    const current = selectedCustomer;
    const cid = current?.id?.trim();
    setSelectedCustomerHydrated(null);
    if (!cid || !current) {
      setSelectedCustomerRating(null);
      setSelectedCustomerRatingLoading(false);
      return;
    }
    let cancelled = false;
    const q = encodeURIComponent(cid);
    setSelectedCustomerRatingLoading(true);
    void Promise.all([
      trackedFetch(dashboardApiUrl(`/api/customer/profile?id=${q}`))
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
      trackedFetch(dashboardApiUrl(`/api/customer/rating?id=${q}`))
        .then(async (res) => {
          if (!res.ok) return null;
          return normalizeCustomerRatingResponse(await res.json());
        })
        .catch(() => null),
    ])
      .then(([profRaw, ratingParsed]) => {
        if (cancelled) return;
        setSelectedCustomerRating(ratingParsed);
        if (profRaw || ratingParsed) {
          const hydrated = profileApiPayloadToShowcase(
            profRaw ?? { profile: { customerId: cid } },
            ratingParsed,
          );
          if (hydrated) {
            const hydratedNoTickets =
              hydrated.unknown?.includes("gini") === true &&
              hydrated.meanStake === 0;
            const tableHasSizing =
              current.gini > 0 || current.meanStake > 0 || current.var95Usd > 0;
            const mergeSizingFromTable = hydratedNoTickets && tableHasSizing;
            const nextUnknown = new Set(hydrated.unknown ?? []);
            if (mergeSizingFromTable) {
              nextUnknown.delete("meanStake");
              nextUnknown.delete("sizing");
              nextUnknown.delete("gini");
              nextUnknown.delete("var95");
            }
            if (
              current.recommendedLimitUsd > 0 &&
              hydrated.recommendedLimitUsd === 0
            ) {
              nextUnknown.delete("limit");
            }
            setSelectedCustomerHydrated({
              ...hydrated,
              agentId:
                hydrated.agentId !== "—" && hydrated.agentId !== ""
                  ? hydrated.agentId
                  : current.agentId,
              masterAgent:
                hydrated.masterAgent !== "—" &&
                hydrated.masterAgent !== "" &&
                hydrated.masterAgent !== "UNKNOWN"
                  ? hydrated.masterAgent
                  : current.masterAgent,
              tierLabel: current.tierLabel ?? hydrated.tierLabel,
              source: current.source ?? hydrated.source,
              clvBps: hydrated.clvBps ?? current.clvBps,
              clvLegs: current.clvLegs ?? hydrated.clvLegs,
              openRiskUsd: current.openRiskUsd ?? hydrated.openRiskUsd,
              lastWagerAt: current.lastWagerAt ?? hydrated.lastWagerAt,
              handle30dUsd: current.handle30dUsd ?? hydrated.handle30dUsd,
              totalWagers: current.totalWagers ?? hydrated.totalWagers,
              ...(current.keyNumberBuys30d !== undefined
                ? { keyNumberBuys30d: current.keyNumberBuys30d }
                : {}),
              ...(current.halfPointBuys30d !== undefined
                ? { halfPointBuys30d: current.halfPointBuys30d }
                : {}),
              ...(current.halfPointBuyRatePct !== undefined
                ? { halfPointBuyRatePct: current.halfPointBuyRatePct }
                : {}),
              ...(current.seatCount !== undefined
                ? { seatCount: current.seatCount }
                : {}),
              ...(current.isKeyNumberBuyer ? { isKeyNumberBuyer: true } : {}),
              ...(current.isHalfPointHookBuyer
                ? { isHalfPointHookBuyer: true }
                : {}),
              ...(current.isMultiSeatCluster
                ? { isMultiSeatCluster: true }
                : {}),
              ...(current.isProxyConduit ? { isProxyConduit: true } : {}),
              ...(current.sharpCandidateGatePassed !== undefined
                ? {
                    sharpCandidateGatePassed: current.sharpCandidateGatePassed,
                  }
                : {}),
              recommendedLimitUsd:
                hydrated.recommendedLimitUsd > 0
                  ? hydrated.recommendedLimitUsd
                  : current.recommendedLimitUsd,
              ...(mergeSizingFromTable
                ? {
                    gini: current.gini,
                    meanStake: current.meanStake,
                    sizingStrategy: current.sizingStrategy,
                    var95Usd: current.var95Usd,
                    cvar95Usd: current.cvar95Usd,
                  }
                : {}),
              unknown: [...nextUnknown],
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedCustomerRating(null);
      })
      .finally(() => {
        if (!cancelled) setSelectedCustomerRatingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCustomer?.id]);

  const attemptedOnDemandRef = useRef<Set<string>>(new Set());

  const fetchCustomerOnDemand = (upper: string) => {
    attemptedOnDemandRef.current.add(upper);
    const q = encodeURIComponent(upper);
    setSelectedCustomerRatingLoading(true);
    void Promise.all([
      trackedFetch(dashboardApiUrl(`/api/customer/profile?id=${q}`))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      trackedFetch(dashboardApiUrl(`/api/customer/rating?id=${q}`))
        .then(async (r) =>
          r.ok ? normalizeCustomerRatingResponse(await r.json()) : null,
        )
        .catch(() => null),
    ])
      .then(([profRaw, ratingParsed]) => {
        if (!profRaw && !ratingParsed) return;
        const hydrated = profileApiPayloadToShowcase(
          profRaw ?? { profile: { customerId: upper } },
          ratingParsed,
        );
        if (hydrated) {
          setOnDemandCustomer(hydrated);
          setSelectedCustomer(hydrated);
          setSelectedCustomerHydrated(hydrated);
          setSelectedCustomerRating(ratingParsed);
          setCustomerLookupNotice(null);
        }
      })
      .catch(() => {})
      .finally(() => {
        setSelectedCustomerRatingLoading(false);
      });
  };

  const handleSelectCustomerById = (customerId: string) => {
    const raw = customerId.trim();
    if (raw === "") return;
    const upper = raw.toUpperCase();
    const foundInView = profileCustomers.find(
      (c) => c.id.toUpperCase() === upper,
    );
    const foundWithSynth =
      foundInView ??
      withSyntheticUniverse.find((c) => c.id.toUpperCase() === upper);
    if (!foundInView && foundWithSynth) {
      setCustomerScope("ALL_WITH_SYNTHETIC");
    } else if (foundInView && customerScope !== "ALL_REAL") {
      setCustomerScope("ALL_REAL");
    }
    setSelectedCustomer(foundWithSynth ?? null);
    setSearchQuery(raw);
    setFilterTier("ALL");
    setCustomerLookupNotice(foundWithSynth ? null : upper);
    setActiveTab("customers");

    if (!foundWithSynth) {
      fetchCustomerOnDemand(upper);
    }
  };

  useEffect(() => {
    const fromUrl = resolveInitialUrlParam("customer");
    if (!fromUrl) return;
    const upper = fromUrl.toUpperCase();
    const found =
      profileCustomers.find((c) => c.id.toUpperCase() === upper) ??
      withSyntheticUniverse.find((c) => c.id.toUpperCase() === upper);
    if (found) {
      if (isSyntheticShowcaseCustomer(found)) {
        setCustomerScope("ALL_WITH_SYNTHETIC");
      }
      setSelectedCustomer(found);
      setCustomerLookupNotice(null);
    } else if (
      selectedCustomer?.id.toUpperCase() !== upper &&
      onDemandCustomer?.id.toUpperCase() !== upper
    ) {
      setCustomerLookupNotice(upper);
      if (!attemptedOnDemandRef.current.has(upper)) {
        fetchCustomerOnDemand(upper);
      }
    }
    setSearchQuery(fromUrl);
  }, [profileCustomers, withSyntheticUniverse]);

  const previousTabRef = useRef(activeTab);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tabChanged = previousTabRef.current !== activeTab;
    previousTabRef.current = activeTab;
    writeDashboardUrl(
      {
        tab: activeTab,
        matrix: showBuildMatrix,
        agent: selectedAgentId ?? "",
        wSport: wagerSportFilter,
        wAlert: wagerAlertFilter,
        wType: wagerTypeFilter,
        wChannel: wagerChannelFilter,
        wSort: wagerSortField,
        wDir: wagerSortDir,
      },
      window,
      { push: tabChanged },
    );
  }, [
    activeTab,
    showBuildMatrix,
    selectedAgentId,
    wagerSportFilter,
    wagerAlertFilter,
    wagerTypeFilter,
    wagerChannelFilter,
    wagerSortField,
    wagerSortDir,
  ]);

  // Section hashes are routes: `#system-logs` opens the terminal view, and a tab change keeps
  // the hash honest (a non-primary view clears our section hash instead of carrying a stale one).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const hash = window.location.hash.replace(/^#/, "");
      const item = PRIMARY_NAV_ITEMS.find((entry) => entry.hash === hash);
      if (item) setActiveTab(item.tab);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const current = window.location.hash.replace(/^#/, "");
    const target = activePrimaryNav?.hash ?? "";
    const isPrimaryHash = PRIMARY_NAV_ITEMS.some(
      (item) => item.hash === current,
    );
    if (current === target) return;
    // Never strip a foreign fragment (text fragments, row anchors) for a non-primary tab.
    if (target === "" && !isPrimaryHash) return;
    const url = new URL(window.location.href);
    url.hash = target;
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [activePrimaryNav?.hash]);

  // Scroll the newly shown primary section under the sticky header.
  useEffect(() => {
    if (typeof window === "undefined" || activePrimaryNav === null) return;
    document
      .getElementById(activePrimaryNav.hash)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activePrimaryNav?.hash]);

  // Customer deep links are usable outside the build matrix too: keep the
  // selected profile, or the failed lookup id, in the URL without dropping the
  // hash (text fragments / row anchors).
  useEffect(() => {
    if (typeof window === "undefined" || activeTab !== "customers") return;
    const requested = selectedCustomer?.id ?? customerLookupNotice;
    if (!requested) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("customer") === requested) return;
    url.searchParams.set("customer", requested);
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [activeTab, selectedCustomer, customerLookupNotice]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const apply = () => {
      const next = readDashboardUrlState(
        window.location.search,
        window.location.pathname,
        window.location.hash,
      );
      setActiveTab(next.tab);
      setShowBuildMatrix(next.matrix);
      setWagerSportFilter(next.wSport);
      setWagerAlertFilter(next.wAlert);
      setWagerTypeFilter(next.wType);
      setWagerChannelFilter(next.wChannel);
      setWagerSortField(next.wSort);
      setWagerSortDir(next.wDir);
      setSelectedAgentId(next.agent ? next.agent.toUpperCase() : null);
      setRankingsSearch(next.agent);

      // Deep links are not part of the rebuildable state; resolve them against
      // the data already loaded when a navigation lands on one.
      const params = new URLSearchParams(window.location.search);
      const customerId = params.get("customer")?.trim() ?? "";
      if (customerId !== "") {
        const found = profileCustomers.find(
          (customer) => customer.id.toUpperCase() === customerId.toUpperCase(),
        );
        setSelectedCustomer(found ?? null);
        setSearchQuery(customerId);
        setCustomerLookupNotice(found ? null : customerId.toUpperCase());
      }
      const ticketId = params.get("ticket")?.trim() ?? "";
      if (ticketId !== "") {
        const pick = findWagerByTicketParam(liveWagers, ticketId);
        if (pick !== null) setSelectedWager(pick);
      }
    };
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, [profileCustomers, liveWagers]);

  const localPort = resolveLocalSpaPort();
  const daemon4020 = r2PipelineData?.daemon4020;
  const daemonState = resolveDaemon4020State(daemon4020);
  const daemonLatency = daemon4020?.latencyMs ?? 1;
  const daemonCause = summarizeDaemonDegradedCause(daemon4020);
  const daemonPill =
    daemonState === "online"
      ? {
          color: "#4ade80",
          border: "rgba(74, 222, 128, 0.35)",
          bg: "rgba(34, 197, 94, 0.1)",
          label: `● API :4020 (${daemonLatency}ms)`,
          title: `SportsDesk Daemon :4020 online (${daemonLatency}ms) · Click to inspect Daemon & R2 diagnostics`,
        }
      : daemonState === "degraded"
        ? {
            color: "#fbbf24",
            border: "rgba(245, 158, 11, 0.45)",
            bg: "rgba(245, 158, 11, 0.12)",
            label: `◐ API :4020 ${daemon4020?.operationalStatus === "down" ? "Auth Down" : "Degraded"}${daemonCause ? ` · ${daemonCause}` : ""} (${daemonLatency}ms)`,
            title: `SportsDesk Daemon :4020 reachable (HTTP ${daemon4020?.status ?? 503}, ${daemonLatency}ms)${daemon4020?.reason ? ` — ${daemon4020.reason}` : ""} · Click to inspect Daemon & R2 diagnostics`,
          }
        : daemonState === "offline"
          ? {
              color: "#fbbf24",
              border: "rgba(245, 158, 11, 0.35)",
              bg: "rgba(245, 158, 11, 0.08)",
              label: `○ API :4020 Offline${daemonCause ? ` · ${daemonCause}` : ""}`,
              title: `SportsDesk Daemon :4020 offline (${daemon4020?.reason ?? "unreachable"}) · Click to inspect Daemon & R2 diagnostics`,
            }
          : {
              color: "#94a3b8",
              border: "rgba(148, 163, 184, 0.3)",
              bg: "rgba(15, 23, 42, 0.85)",
              label: "◌ API :4020 Probing...",
              title:
                "SportsDesk Daemon :4020 probing... · Click to inspect Daemon & R2 diagnostics",
            };
  const r2StatusUi =
    r2PipelineData?.overallStatus === "fresh"
      ? {
          color: "#4ade80",
          border: "rgba(74, 222, 128, 0.35)",
          bg: "rgba(34, 197, 94, 0.1)",
        }
      : r2PipelineData?.overallStatus === "stale"
        ? {
            color: "#fbbf24",
            border: "rgba(245, 158, 11, 0.4)",
            bg: "rgba(245, 158, 11, 0.1)",
          }
        : r2PipelineData
          ? {
              color: "#f87171",
              border: "rgba(248, 113, 113, 0.4)",
              bg: "rgba(239, 68, 68, 0.1)",
            }
          : {
              color: "#94a3b8",
              border: "rgba(148, 163, 184, 0.3)",
              bg: "rgba(15, 23, 42, 0.85)",
            };
  const footerTs = formatFooterTimestamp(data?.updatedAt);

  const alertsStatus = healthData?.alerts?.status;
  const opStatus = healthData?.operationalStatus;
  const isHealthError =
    alertsStatus === "degraded" ||
    opStatus === "down" ||
    healthData?.status === "down";
  const isHealthWarn =
    !isHealthError &&
    (alertsStatus === "warning" ||
      opStatus === "degraded" ||
      healthData?.status === "degraded");
  const degradedReasonSummary = healthData?.degradedReasons
    ?.map((r) => r.message)
    .slice(0, 3)
    .join("; ");
  const systemHealthUi = isHealthError
    ? {
        border: "#ef4444",
        bg: "rgba(239, 68, 68, 0.15)",
        color: "#f87171",
        label: alertsStatus === "degraded" ? "🚨 DEGRADED" : "🚨 AUTH DOWN",
      }
    : isHealthWarn
      ? {
          border: "#f59e0b",
          bg: "rgba(245, 158, 11, 0.15)",
          color: "#fbbf24",
          label: alertsStatus === "warning" ? "⚠️ WARNING" : "⚠️ DEGRADED",
        }
      : {
          border: "#22c55e",
          bg: "rgba(34, 197, 94, 0.15)",
          color: "#4ade80",
          label: "● System OK",
        };

  return (
    <div style={styles.container}>
      {/* Global Sticky Header */}
      <header style={styles.header} className="sd-top-header">
        <div style={styles.headerTopRow}>
          <a
            href="#risk-overview"
            style={styles.brandLockup}
            data-brand-lockup="true"
            aria-label="SportsDesk Ops Surveillance — Risk Overview"
            onClick={() => setActiveTab("surveillance")}
          >
            <img
              src={logo}
              alt=""
              aria-hidden="true"
              width={36}
              height={36}
              style={styles.brandLogo}
              data-brand-logo="true"
            />
            <span style={styles.brandText}>
              <h1 style={styles.title}>
                ⚡ SportsDesk & Fantasy402 Operations
              </h1>
              <span style={styles.brandSubtitle}>
                Surveillance · telemetry · bettor risk
              </span>
            </span>
          </a>
          <nav
            aria-label="Primary Surveillance Navigation"
            className="sd-primary-nav"
            style={styles.primaryNav}
          >
            {PRIMARY_NAV_ITEMS.map((item) => (
              <a
                key={item.hash}
                href={`#${item.hash}`}
                aria-current={
                  activePrimaryNav?.hash === item.hash ? "page" : undefined
                }
                data-primary-nav={item.hash}
                title={item.title}
                onClick={() => setActiveTab(item.tab)}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="sd-header-status">
            <span
              style={styles.badge(connected)}
              title={connected ? "Live Hot-Reload Connected" : "Disconnected"}
            >
              {connected ? "● Live" : "○ Offline"}
            </span>
          </div>
        </div>
      </header>

      {/* Secondary Workspace Telemetry Toolbar & Tab Bar */}
      <section
        aria-label="Workspace Telemetry and Tabs"
        className="sd-ops-toolbar"
      >
        <div className="sd-ops-telemetry-row">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
              fontSize: "11px",
              color: "#94a3b8",
            }}
          >
            <span
              data-local-spa-pill="true"
              style={styles.telemetryPill(
                "#38bdf8",
                "rgba(56, 189, 248, 0.35)",
                "rgba(56, 189, 248, 0.1)",
              )}
            >
              ● Local :{localPort} SPA
            </span>
            <button
              type="button"
              data-daemon-status-btn="true"
              className="sd-telemetry-btn"
              onClick={() => setActiveTab("r2")}
              style={{
                ...styles.telemetryPill(
                  daemonPill.color,
                  daemonPill.border,
                  daemonPill.bg,
                ),
                cursor: "pointer",
              }}
              title={daemonPill.title}
            >
              {daemonPill.label}
            </button>
            <button
              type="button"
              className="sd-telemetry-btn"
              onClick={() => setActiveTab("r2")}
              style={{
                ...styles.telemetryPill(
                  r2StatusUi.color,
                  r2StatusUi.border,
                  r2StatusUi.bg,
                ),
                cursor: "pointer",
              }}
              title="Open R2 Pipeline Monitor"
            >
              {r2PipelineData
                ? `☁️ R2 ${r2PipelineData.freshCount}/${r2PipelineData.totalCount} Fresh`
                : "☁️ R2 Probing..."}
            </button>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                flexWrap: "wrap",
              }}
            >
              <a
                href="/live-bets"
                target="_blank"
                rel="noreferrer"
                className="sd-telemetry-link"
                style={styles.telemetryLink}
              >
                📈 Live Bets ↗
              </a>
              <a
                href="/graph"
                target="_blank"
                rel="noreferrer"
                className="sd-telemetry-link"
                style={styles.telemetryLink}
              >
                🕸️ Graph ↗
              </a>
              <a
                href="/tracker"
                target="_blank"
                rel="noreferrer"
                className="sd-telemetry-link"
                style={styles.telemetryLink}
              >
                📋 Tracker ↗
              </a>
              <a
                href="/governance"
                target="_blank"
                rel="noreferrer"
                className="sd-telemetry-link"
                style={styles.telemetryLink}
              >
                🛡️ Gov ↗
              </a>
              <a
                href="/status"
                target="_blank"
                rel="noreferrer"
                className="sd-telemetry-link"
                style={styles.telemetryLink}
              >
                🩺 Status ↗
              </a>
            </div>
            <span
              style={styles.telemetryPill(
                "#fbbf24",
                "rgba(245, 158, 11, 0.35)",
                "rgba(245, 158, 11, 0.1)",
              )}
              title="autoExecute: false invariant active — human operator confirmation required"
            >
              🛡️ autoExecute: false
            </span>
            {clockTime && (
              <span
                style={{
                  ...styles.telemetryPill(
                    "#f1f5f9",
                    "rgba(51, 65, 85, 0.85)",
                    "#0f172a",
                  ),
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              >
                🕒 {clockTime}
              </span>
            )}
          </div>
          <div style={styles.headerLeft}>
            {/* Live Alert Health Pill */}
            <button
              type="button"
              onClick={() => {
                void fetchShiftSummary();
                setIsShiftModalOpen(true);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                border: `1px solid ${systemHealthUi.border}`,
                background: systemHealthUi.bg,
                color: systemHealthUi.color,
              }}
              title={
                degradedReasonSummary
                  ? `Health probe: ${degradedReasonSummary} · Click to view Shift Handoff Summary`
                  : "Surveillance Alert Health (O(1) in-memory probe) · Click to view Shift Handoff Summary"
              }
            >
              <span>{systemHealthUi.label}</span>
              {healthData?.alerts && (
                <span style={{ color: "#94a3b8", fontSize: "10px" }}>
                  (DLQ: {healthData.alerts.dead} · Backlog:{" "}
                  {healthData.alerts.backlog})
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                void fetchShiftSummary();
                setIsShiftModalOpen(true);
              }}
              style={{
                padding: "4px 9px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                background: "#1e293b",
                color: "#94a3b8",
                border: "1px solid #334155",
                cursor: "pointer",
              }}
              title="Operator Shift Summary Handoff"
            >
              📋 Shift Handoff
            </button>
            <button
              type="button"
              data-copy-view-link="true"
              onClick={handleCopyQuickLink}
              style={{
                padding: "4px 9px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                background: "#1e293b",
                color: quickLinkCopyState === "failed" ? "#fca5a5" : "#4ade80",
                border: "1px solid #334155",
                cursor: "pointer",
              }}
              title="Copy this exact view — tab, filters, sort and overlay — as a shareable link"
            >
              {quickLinkCopyState === "copied"
                ? "✓ View link copied"
                : quickLinkCopyState === "failed"
                  ? "⚠ Copy failed"
                  : "⧉ Copy view"}
            </button>
            {!viewIsDefault && (
              <button
                type="button"
                data-reset-view="true"
                onClick={handleResetView}
                style={{
                  padding: "4px 9px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  fontWeight: 600,
                  background: "#1e293b",
                  color: "#94a3b8",
                  border: "1px solid #334155",
                  cursor: "pointer",
                }}
                title="Reset tab, filters, sort and overlays to defaults"
              >
                ↺ Reset view
              </button>
            )}
            <button
              type="button"
              className="sd-pill sd-mono"
              style={{ cursor: "pointer" }}
              onClick={() => {
                const next = !showBuildMatrix;
                setShowBuildMatrix(next);
                if (next && !buildMatrixRows && !buildMatrixLoading) {
                  fetchBuildMatrix();
                }
              }}
              title="Inspect compile-time bun:bundle dead-code elimination & tokens.toml CSS Houdini registry"
            >
              🧬 Target: {runtimeFlags.target.toUpperCase()} (
              {runtimeFlags.enabledFeatures.length > 0
                ? runtimeFlags.enabledFeatures.join("+")
                : "HMR"}
              )
            </button>
          </div>
        </div>
        <div className="sd-tab-nav" style={styles.tabNav}>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "customers"}
            style={styles.tabBtn(activeTab === "customers")}
            onClick={() => setActiveTab("customers")}
            title="Inspect individual sharp originators, sizing models, and risk (Ctrl+1)"
          >
            👥 Profiles (
            {profileCustomers.length > 0
              ? profileCustomers.length.toLocaleString()
              : "—"}
            )<span style={styles.keyShortcutBadge}>Ctrl+1</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "shadow"}
            style={styles.tabBtn(activeTab === "shadow")}
            onClick={() => setActiveTab("shadow")}
            title="Counterfactual Shadow Pricing & Slice Hold-Floor Cube (Ctrl+7)"
          >
            ⚖️ Shadow Pricing (#135)
            <span style={styles.keyShortcutBadge}>Ctrl+7</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            data-tab-id="surveillance"
            aria-pressed={activeTab === "surveillance"}
            style={styles.tabBtn(activeTab === "surveillance")}
            onClick={() => setActiveTab("surveillance")}
            title={`${DASHBOARD_TAB_SPECS.surveillance.description} (${DASHBOARD_TAB_SPECS.surveillance.shortcut})`}
          >
            {DASHBOARD_TAB_SPECS.surveillance.icon}{" "}
            {DASHBOARD_TAB_SPECS.surveillance.label}
            <span style={styles.keyShortcutBadge}>
              {DASHBOARD_TAB_SPECS.surveillance.shortcut}
            </span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "terminal"}
            style={styles.tabBtn(activeTab === "terminal")}
            onClick={() => setActiveTab("terminal")}
            title="Native Bun.Terminal PTY query engine (Ctrl+3 or Cmd+K)"
          >
            💻 Terminal (PTY)
            <span style={styles.keyShortcutBadge}>Ctrl+3</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "rankings"}
            style={styles.tabBtn(activeTab === "rankings")}
            onClick={() => setActiveTab("rankings")}
            title="Rolling 30-day handle rankings & proxy conduits (Ctrl+4)"
          >
            🏆 Downlines ({rankings ? rankings.conduits.length : "—"})
            <span style={styles.keyShortcutBadge}>Ctrl+4</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "wagers"}
            style={{
              ...styles.tabBtn(activeTab === "wagers"),
              position: "relative",
            }}
            onClick={() => setActiveTab("wagers")}
            title="Real-time incoming wager tape with CLV alerts (Ctrl+5)"
          >
            ⚡ Live Wagers ({liveWagers.length})
            <span
              className="live-alert-pulse"
              style={{
                fontSize: "10px",
                padding: "1px 5px",
                borderRadius: "8px",
                backgroundColor: "#ef4444",
                color: "#ffffff",
                fontWeight: 700,
                marginLeft: "4px",
              }}
            >
              🚨{" "}
              {
                liveWagers.filter(
                  (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
                ).length
              }
            </span>
            <span style={styles.keyShortcutBadge}>Ctrl+5</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "alerts"}
            style={{
              ...styles.tabBtn(activeTab === "alerts"),
              position: "relative",
            }}
            onClick={() => {
              setActiveTab("alerts");
              fetchAlerts();
            }}
            title="Surveillance Alert Queue, Dead-Letter Queue (DLQ), and Replay Controls (Ctrl+6)"
          >
            🚨 DLQ & Alerts ({alertRecords.length})
            {healthData?.alerts?.dead && healthData.alerts.dead > 0 ? (
              <span
                style={{
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "8px",
                  backgroundColor: "#ef4444",
                  color: "#ffffff",
                  fontWeight: 700,
                  marginLeft: "4px",
                }}
              >
                {healthData.alerts.dead} DEAD
              </span>
            ) : null}
            <span style={styles.keyShortcutBadge}>Ctrl+6</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "bet-ticker"}
            style={styles.tabBtn(activeTab === "bet-ticker")}
            onClick={() => setActiveTab("bet-ticker")}
          >
            📡 Bet Ticker (
            {betTickerData?.localFeed.actionableTicketCount ?? "…"})
            <span style={styles.keyShortcutBadge}>Ctrl+8</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "r2"}
            style={styles.tabBtn(activeTab === "r2")}
            onClick={() => setActiveTab("r2")}
          >
            ☁️ R2 Pipeline
            {r2PipelineData?.staleKeys &&
            r2PipelineData.staleKeys.length > 0 ? (
              <span
                style={{
                  fontSize: "10px",
                  padding: "1px 5px",
                  borderRadius: "8px",
                  backgroundColor: "#f59e0b",
                  color: "#090d16",
                  fontWeight: 700,
                  marginLeft: "4px",
                }}
              >
                {r2PipelineData.staleKeys.length} STALE
              </span>
            ) : null}
            <span style={styles.keyShortcutBadge}>Ctrl+9</span>
          </button>
          <button
            type="button"
            className="sd-tab-btn"
            aria-pressed={activeTab === "assets"}
            style={styles.tabBtn(activeTab === "assets")}
            onClick={() => setActiveTab("assets")}
            title="Bun.Image width, height, format and backend for the served dashboard assets (Ctrl+0)"
          >
            🖼️ Assets
            <span style={styles.keyShortcutBadge}>Ctrl+0</span>
          </button>
        </div>
      </section>

      {showBuildMatrix ? (
        <BuildMatrixDrawer
          dceMarker={runtimeFlags.dceMarker}
          activeSentinels={runtimeFlags.sentinels}
          loading={buildMatrixLoading}
          rows={buildMatrixRows}
          staticDir={buildMatrixStaticDir}
          target={runtimeFlags.target}
          enabledFeatures={runtimeFlags.enabledFeatures}
          error={buildMatrixError}
          generatedAt={buildMatrixGeneratedAt}
          compiledMs={buildMatrixCompiledMs}
          onRefresh={() => fetchBuildMatrix(true)}
        />
      ) : null}

      {/* Cross-Desk Operations Command Ribbon */}
      <section
        aria-label="Operations Command Ribbon"
        className="sd-quick-jump-ribbon"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px 10px",
          padding: "6px 24px",
          backgroundColor: "#0b1120",
          borderBottom: "1px solid #1e293b",
          fontSize: "11px",
          color: "#cbd5e1",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 12px",
          }}
        >
          <span
            style={{
              fontWeight: 700,
              color: "#38bdf8",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            🧭 Desk Quick-Jump:
          </span>
          <button
            type="button"
            data-desk-quickjump="active-risk"
            onClick={openWagersForShadowSlice}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: shadowSliceHasTapeFocus(activeShadowSlice)
                ? "1px solid rgba(251, 191, 36, 0.45)"
                : "1px solid rgba(56, 189, 248, 0.35)",
              backgroundColor: shadowSliceHasTapeFocus(activeShadowSlice)
                ? "rgba(251, 191, 36, 0.14)"
                : "rgba(56, 189, 248, 0.1)",
              color: shadowSliceHasTapeFocus(activeShadowSlice)
                ? "#fde68a"
                : "#7dd3fc",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title={
              shadowSliceHasTapeFocus(activeShadowSlice)
                ? `Filter Live Wagers to URL shadow slice: ${buildDashboardShadowSliceUrl(activeShadowSlice, { matrix: showBuildMatrix })}`
                : "Open full Live Wagers tape"
            }
          >
            ⚡{" "}
            {shadowSliceHasTapeFocus(activeShadowSlice)
              ? `Slice Risk (${formatShadowSliceRibbonLabel(activeShadowSlice)}):`
              : "Active Risk:"}{" "}
            ${tapeRiskUsd.toLocaleString()} ({tapeTicketCount} tickets
            {shadowSliceTape.criticalOrSteam > 0
              ? ` · ${shadowSliceTape.criticalOrSteam} crit/steam`
              : ""}
            )
            <span
              data-quickjump-feed-age="true"
              style={{
                marginLeft: "4px",
                color: quickJumpFeed.stale ? "#fbbf24" : "#64748b",
                fontWeight: 400,
              }}
              title={feedFreshnessTitle(quickJumpFeed, wagersProvenance.label)}
            >
              {" "}
              · {quickJumpFeed.label}
              {quickJumpFeed.stale ? " ⚠" : ""}
            </span>
          </button>
          <button
            type="button"
            data-desk-quickjump="nfl-1h-pregame"
            onClick={() => {
              applyShadowSliceToLocation(NFL_1H_PREGAME_SLICE, {
                matrix: showBuildMatrix,
              });
              setActiveTab("shadow");
            }}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(234, 179, 8, 0.4)",
              backgroundColor: "rgba(234, 179, 8, 0.12)",
              color: "#facc15",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Shadow matrix: NFL · 1H · Pregame (matches ?matrix=1&sport=Football&subSport=NFL&period=1h&regime=pregame)"
          >
            🏈 NFL 1H Pregame
          </button>
          <a
            href={buildBookdeskopsTokensDeskHref(
              shadowSliceHasTapeFocus(activeShadowSlice)
                ? activeShadowSlice
                : undefined,
            )}
            target="_blank"
            rel="noreferrer"
            data-desk-quickjump="bookdeskops-tokens"
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              backgroundColor: "rgba(148, 163, 184, 0.1)",
              color: "#e2e8f0",
              fontSize: "11px",
              fontWeight: 600,
              textDecoration: "none",
            }}
            title="BookDeskOps serve-local tokens desk (DCE compile-time anchor)"
          >
            📎 BookDeskOps tokens
          </a>
          <a
            href={buildBookdeskopsDirectoryRouteHref()}
            target="_blank"
            rel="noreferrer"
            data-desk-quickjump="bookdeskops-directory"
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(56, 189, 248, 0.35)",
              backgroundColor: "rgba(56, 189, 248, 0.1)",
              color: "#38bdf8",
              fontSize: "11px",
              fontWeight: 600,
              textDecoration: "none",
            }}
            title="BookDeskOps serve-local /static/* directory route inspector & HTTP probes"
          >
            📁 /static/* Dir
          </a>
          <button
            type="button"
            data-desk-quickjump="ncaab"
            data-quickjump-active={quickJumpNcaabActive ? "true" : undefined}
            aria-current={quickJumpNcaabActive ? "page" : undefined}
            onClick={() => {
              setWagerSportFilter("NCAAB");
              setWagerSearch("");
              setWagerChannelFilter("ALL");
              setActiveTab("wagers");
            }}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: quickJumpNcaabActive
                ? "1px solid #fbbf24"
                : "1px solid rgba(245, 158, 11, 0.35)",
              backgroundColor: quickJumpNcaabActive
                ? "rgba(245, 158, 11, 0.26)"
                : "rgba(245, 158, 11, 0.12)",
              color: "#fbbf24",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: quickJumpNcaabActive
                ? "0 0 0 1px rgba(251, 191, 36, 0.35)"
                : undefined,
            }}
            title="Filter Live Wagers to College Basketball (NCAAB 1H & Game)"
          >
            🏀 NCAAB Slice (
            {liveWagers.filter((w) => w.sport.toUpperCase() === "NCAAB").length}
            )
          </button>
          {(
            [
              {
                id: "GSLIVE",
                label: "🔴 GSLIVE",
                title: "Filter Live Wagers to GSLIVE (Partner 118 in-play)",
              },
              {
                id: "GSBUILDER",
                label: "🧩 GS Builder",
                title:
                  "Filter Live Wagers to GS Builder (Partner 118 SGP builder)",
              },
            ] as const
          ).map((channel) => {
            const count = liveWagers.filter(
              (w) =>
                (w.writer ?? wagerChannelOf(w.ticketWriter)) ===
                channel.id.toLowerCase(),
            ).length;
            const channelActive =
              activeTab === "wagers" && quickJumpChannelFilter === channel.id;
            return (
              <button
                key={channel.id}
                type="button"
                data-desk-quickjump={channel.id.toLowerCase()}
                data-quickjump-active={channelActive ? "true" : undefined}
                aria-current={channelActive ? "page" : undefined}
                onClick={() => {
                  setWagerSportFilter("ALL");
                  setWagerSearch("");
                  setWagerChannelFilter(channel.id);
                  setActiveTab("wagers");
                }}
                style={{
                  padding: "3px 9px",
                  borderRadius: "999px",
                  border: channelActive
                    ? "1px solid #d8b4fe"
                    : "1px solid rgba(192, 132, 252, 0.35)",
                  backgroundColor: channelActive
                    ? "rgba(192, 132, 252, 0.26)"
                    : "rgba(192, 132, 252, 0.12)",
                  color: "#d8b4fe",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  boxShadow: channelActive
                    ? "0 0 0 1px rgba(216, 180, 254, 0.35)"
                    : undefined,
                }}
                title={channel.title}
              >
                {channel.label} ({count})
              </button>
            );
          })}
          <button
            type="button"
            data-desk-quickjump="audit"
            data-quickjump-active={quickJumpAuditActive ? "true" : undefined}
            aria-current={quickJumpAuditActive ? "page" : undefined}
            onClick={() => {
              handleSelectCustomerById("BRT106");
            }}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: quickJumpAuditActive
                ? "1px solid #4ade80"
                : "1px solid rgba(34, 197, 94, 0.38)",
              backgroundColor: quickJumpAuditActive
                ? "rgba(34, 197, 94, 0.26)"
                : "rgba(34, 197, 94, 0.12)",
              color: "#4ade80",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: quickJumpAuditActive
                ? "0 0 0 1px rgba(74, 222, 128, 0.35)"
                : undefined,
            }}
            title="Inspect BRT106 (BGMASTER / BILLY666) 3-endpoint portal & figureDate reconciliation"
          >
            🧾 Figure-Date Audit: BRT106
          </button>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 12px",
            color: "#94a3b8",
          }}
        >
          <span>
            Bridge 3a Watermark:{" "}
            <code style={{ color: "#e2e8f0" }}>
              {betTickerData?.bridge3aR2.watermark ?? "pending"}
            </code>
          </span>
          <span>·</span>
          <span>
            Top Conduit:{" "}
            {rankings?.conduits[0] ? (
              <button
                type="button"
                onClick={() =>
                  setSelectedAgentId(rankings.conduits[0]?.agentId ?? null)
                }
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "#38bdf8",
                  fontWeight: 600,
                  fontSize: "11px",
                  cursor: "pointer",
                }}
              >
                {rankings.conduits[0].agentId} (
                {rankings.conduits[0].concPct.toFixed(1)}%) ↗
              </button>
            ) : (
              <code style={{ color: "#94a3b8" }} title={rankingsError ?? ""}>
                {rankingsStatus === "pending"
                  ? "pending"
                  : rankingsStatus === "ready"
                    ? "none flagged"
                    : "unavailable"}
              </code>
            )}
          </span>
          <span>·</span>
          <span
            data-quickjump-feed="true"
            style={
              quickJumpFeed.stale
                ? { color: "#fbbf24", fontWeight: 600 }
                : undefined
            }
            title={feedFreshnessTitle(quickJumpFeed, wagersProvenance.label)}
          >
            feed: {wagersProvenance.label} · {quickJumpFeed.label}
            {quickJumpFeed.stale ? " ⚠" : ""}
          </span>
          <button
            type="button"
            data-desk-quickjump="copy-link"
            onClick={handleCopyQuickLink}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              backgroundColor: "rgba(148, 163, 184, 0.12)",
              color: "#cbd5e1",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Copy this exact view — tab, filters and shadow slice — as a deep link"
          >
            {quickLinkCopyState === "copied"
              ? "✓ Copied"
              : quickLinkCopyState === "failed"
                ? "⚠ Copy blocked"
                : "⧉ Copy link"}
          </button>
        </div>
      </section>

      {/* Main View Area */}
      <main
        id={activePrimaryNav?.hash}
        data-dashboard-section={activePrimaryNav?.hash ?? undefined}
        style={{ ...styles.main, scrollMarginTop: "96px" }}
      >
        <ErrorBoundary
          resetKey={activeTab}
          panelName={activeTab}
          onNavigateSafe={
            activeTab !== "surveillance"
              ? () => setActiveTab("surveillance")
              : undefined
          }
        >
          {activeTab === "customers" ? (
            <CustomersTabPanel
              bannerDismissed={bannerDismissed}
              onDismissBanner={() => {
                setBannerDismissed(true);
                try {
                  sessionStorage.setItem("portalBannerDismissed", "1");
                } catch {}
              }}
              kpisCollapsed={kpisCollapsed}
              onToggleKpis={() => {
                const next = !kpisCollapsed;
                setKpisCollapsed(next);
                try {
                  localStorage.setItem("kpisCollapsed", next ? "1" : "0");
                } catch {}
              }}
              cohortsReport={cohortsReport}
              cohortsStatus={cohortsStatus}
              cohortsError={cohortsError}
              searchQuery={searchQuery}
              onSearchQueryChange={(value) => {
                setSearchQuery(value);
                setCustomerLookupNotice(null);
              }}
              customerLookupNotice={customerLookupNotice}
              onClearCustomerLookupNotice={() => {
                setCustomerLookupNotice(null);
              }}
              filterTier={filterTier}
              onFilterTierChange={setFilterTier}
              sortedCustomers={sortedCustomers}
              customerSort={customerSort}
              onCustomerSort={onCustomerSort}
              selectedCustomer={selectedCustomer}
              inspectedCustomer={selectedCustomerHydrated ?? selectedCustomer}
              selectedCustomerRating={selectedCustomerRating}
              selectedCustomerRatingLoading={selectedCustomerRatingLoading}
              customerScope={customerScope}
              onCustomerScopeChange={setCustomerScope}
              scopeCounts={scopeCounts}
              formulaKpiCards={formulaKpiCards}
              masterBranchFilter={masterBranchFilter}
              onMasterBranchFilterChange={setMasterBranchFilter}
              masterBranchCounts={masterBranchCounts}
              rankingsLoading={rankingsStatus === "pending"}
              onSelectCustomer={(customer) => {
                setSelectedCustomer(customer);
                setCustomerLookupNotice(null);
              }}
              copiedCliId={copiedCliId}
              onCopyCli={(customerId) => {
                const cmd = `bun run cli -C ${customerId}`;
                void copyText(cmd);
                setCopiedCliId(customerId);
                setTimeout(() => setCopiedCliId(null), 2000);
              }}
              customerReverseForensics={customerForensicResult}
              onClearForensicResult={() => setCustomerReverseForensics(null)}
              onRunReverseLookup={(ipAddress) => {
                void runReverseLookup(ipAddress);
              }}
              onOpenTerminalProfile={(customerId) => {
                setActiveTab("terminal");
                void runTerminalCommand(`profile ${customerId}`);
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              profilesUnavailableReason={
                profileCustomers.length === 0
                  ? PROFILES_UNAVAILABLE_REASON
                  : null
              }
              profilesProvenance={profilesProvenance}
              matrixMode={showBuildMatrix}
              matrixProfileOverlay={matrixProfileOverlay}
              onOpenTerminalRadar={(customerId) => {
                setActiveTab("terminal");
                void runTerminalCommand(`profile ${customerId} --radar`);
              }}
              onViewCustomerWagers={(customerId) => {
                setWagerSportFilter("ALL");
                setWagerAlertFilter("ALL");
                setWagerTypeFilter("ALL");
                setWagerSearch(customerId);
                const match = liveWagers.find(
                  (w) =>
                    w.customerId.toUpperCase() === customerId.toUpperCase(),
                );
                if (match) {
                  setSelectedWager(match);
                }
                setActiveTab("wagers");
              }}
            />
          ) : activeTab === "surveillance" ? (
            <SurveillanceTabPanel
              dnsData={dnsData}
              dnsRefreshing={dnsRefreshing}
              dnsError={dnsError}
              onRefreshDns={() => {
                void fetchDnsTelemetry();
              }}
              benchLoading={benchLoading}
              benchResult={benchResult}
              onRunBenchmark={() => {
                void runBenchmark();
              }}
              reverseIp={reverseIp}
              onReverseIpChange={setReverseIp}
              reverseForensics={reverseForensics}
              onRunReverseLookup={() => {
                void runReverseLookup();
              }}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              data={data}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            />
          ) : activeTab === "terminal" ? (
            <TerminalTabPanel
              terminalCategory={terminalCategory}
              onTerminalCategoryChange={setTerminalCategory}
              terminalHistory={terminalHistory}
              onClearHistory={() => setTerminalHistory([])}
              copiedTerminalIdx={copiedTerminalIdx}
              onCopyOutput={(idx, stdout) => {
                void copyText(stdout);
                setCopiedTerminalIdx(idx);
                setTimeout(() => setCopiedTerminalIdx(null), 1500);
              }}
              copiedCommandIdx={copiedCommandIdx}
              onCopyCommand={(idx, command) => {
                void copyText(command);
                setCopiedCommandIdx(idx);
                setTimeout(() => setCopiedCommandIdx(null), 1500);
              }}
              terminalLoading={terminalLoading}
              terminalBottomRef={terminalBottomRef}
              terminalCommand={terminalCommand}
              onTerminalCommandChange={setTerminalCommand}
              commandHistory={commandHistory}
              historyIndex={historyIndex}
              onHistoryIndexChange={setHistoryIndex}
              onAutocomplete={handleAutocomplete}
              onRunCommand={(cmd) => {
                void runTerminalCommand(cmd);
              }}
            />
          ) : activeTab === "rankings" ? (
            <RankingsTabPanel
              rankingsSearch={rankingsSearch}
              onRankingsSearchChange={setRankingsSearch}
              rankingsFilter={rankingsFilter}
              onRankingsFilterChange={setRankingsFilter}
              onInspectPty={(customerId) => {
                setActiveTab("terminal");
                void runTerminalCommand(`p ${customerId} --radar`);
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onSelectCustomerById={handleSelectCustomerById}
              rankings={rankings}
              rankingsStatus={rankingsStatus}
              rankingsError={rankingsError}
            />
          ) : activeTab === "alerts" ? (
            <AlertsTabPanel
              alertToast={alertToast}
              onDismissToast={() => setAlertToast(null)}
              onCopyDeliveryId={(deliveryId) => {
                void copyText(deliveryId);
                setAlertToast({
                  message: `Copied delivery UUID: ${deliveryId}`,
                  type: "info",
                });
              }}
              healthData={healthData}
              alertFilter={alertFilter}
              onFilterChange={(filter) => {
                setAlertFilter(filter);
                fetchAlerts(filter);
              }}
              alertLoading={alertLoading}
              onSweepAlerts={() => {
                void handleSweepAlerts();
              }}
              onRefreshAlerts={() => fetchAlerts(alertFilter)}
              onOpenShiftModal={() => {
                void fetchShiftSummary();
                setIsShiftModalOpen(true);
              }}
              alertRecords={alertRecords}
              tiersConfig={tiersConfig}
              onAckAlert={(deliveryId, notes) => {
                void handleAckAlert(deliveryId, notes);
              }}
              onRetryAlert={(deliveryId) => {
                void handleRetryAlert(deliveryId);
              }}
            />
          ) : activeTab === "shadow" ? (
            <ShadowPricingPanel
              onInspectAccount={handleSelectCustomerById}
              onRunPtyCommand={(cmd) => {
                setActiveTab("terminal");
                void runTerminalCommand(cmd);
              }}
            />
          ) : activeTab === "bet-ticker" ? (
            <BetTickerTabPanel
              data={betTickerData}
              loading={betTickerLoading}
              error={betTickerError}
              onRefresh={() => {
                void fetchBetTicker();
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onSelectCustomerById={handleSelectCustomerById}
              onInspectPty={(customerId) => {
                setActiveTab("terminal");
                void runTerminalCommand(`profile ${customerId} --radar`);
              }}
            />
          ) : activeTab === "r2" ? (
            <R2PipelineTabPanel
              data={r2PipelineData}
              history={r2PipelineHistory}
              historyError={r2PipelineHistoryError}
              loading={r2PipelineLoading}
              error={r2PipelineError}
              onRefresh={(force) => {
                void (async () => {
                  await fetchR2Pipeline(Boolean(force));
                  await fetchR2PipelineHistory(false);
                })();
              }}
              onVerifyTickets={(dryRun) => {
                void runTicketVerification(dryRun ?? true);
              }}
              verifyingTickets={verifyingTickets}
              verifyTicketsError={verifyTicketsError}
            />
          ) : activeTab === "assets" ? (
            <BunAssetsTabPanel />
          ) : (
            <LiveWagersTabPanel
              wagers={liveWagers}
              clvSummary={wagersClvSummary}
              liveBetsSnapshot={liveBetsSnapshot}
              provenance={wagersProvenance}
              wagersError={wagersError}
              wagersLastUpdatedAt={wagersUpdatedAt}
              newTicketIds={newTicketIds}
              streamingConnected={connected}
              wireContract={wireContract}
              slabPolicy={slabPolicy}
              onRefreshWagers={() => {
                void fetchLiveWagers();
              }}
              wagerSearch={wagerSearch}
              onWagerSearchChange={setWagerSearch}
              wagerSportFilter={wagerSportFilter}
              onWagerSportFilterChange={setWagerSportFilter}
              wagerAlertFilter={wagerAlertFilter}
              onWagerAlertFilterChange={setWagerAlertFilter}
              wagerChannelFilter={wagerChannelFilter}
              onWagerChannelFilterChange={setWagerChannelFilter}
              wagerTypeFilter={wagerTypeFilter}
              onWagerTypeFilterChange={setWagerTypeFilter}
              wagerSortField={wagerSortField}
              wagerSortDir={wagerSortDir}
              onWagerSort={handleWagerSort}
              selectedWager={selectedWager}
              onSelectWager={(wager) => {
                setSelectedWager(wager);
                syncTicketInspectorToLocation(wager.ticketId);
              }}
              alertRecords={alertRecords}
              copiedTicketId={copiedTicketId}
              onCopyText={(ticketId, text) => {
                void copyText(text);
                setCopiedTicketId(ticketId);
                setTimeout(() => setCopiedTicketId(null), 1500);
              }}
              tiersConfig={tiersConfig}
              onSelectCustomerById={handleSelectCustomerById}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onInspectPty={(customerId) => {
                setActiveTab("terminal");
                void runTerminalCommand(`profile ${customerId} --radar`);
              }}
              onRunPtyCommand={(cmd) => {
                setActiveTab("terminal");
                void runTerminalCommand(cmd);
              }}
            />
          )}
        </ErrorBoundary>
      </main>

      {/* Global Footer */}
      <footer data-dashboard-footer="true" style={styles.footer}>
        <div style={styles.footerGroup}>
          <span style={styles.footerMetaPill} title={footerTs.title}>
            Updated: {footerTs.display}
          </span>
          <span
            style={styles.footerSafetyPill}
            title="autoExecute: false invariant active — human operator confirmation required"
          >
            🛡️ autoExecute: false
          </span>
        </div>
        <div style={styles.footerGroup}>
          <span style={styles.footerMetaPill}>
            bun:bundle ({runtimeFlags.target})
          </span>
          <span style={styles.footerMetaPill}>
            tokens.toml v{TOKENS_TOML_VERSION}
          </span>
          <span style={styles.footerMetaPill}>
            dashboard.toml v{DASHBOARD_META.version}
          </span>
          {buildInfo && (
            <span
              style={styles.footerMetaPill}
              title={`Built ${buildInfo.builtAt} · bun ${buildInfo.bunVersion}+${buildInfo.bunRevision.slice(0, 9)} on ${buildInfo.builtOn}`}
            >
              build {buildInfo.target}@{buildInfo.commit} · bun{" "}
              {buildInfo.bunVersion}
            </span>
          )}
        </div>
        <nav aria-label="Footer Quick Links" style={styles.footerGroup}>
          <a
            href="/health"
            target="_blank"
            rel="noreferrer"
            className="sd-footer-link"
            style={styles.footerLink}
          >
            Health
          </a>
          <a
            href="/status"
            target="_blank"
            rel="noreferrer"
            className="sd-footer-link"
            style={styles.footerLink}
          >
            Status
          </a>
          <a
            href="/tracker"
            target="_blank"
            rel="noreferrer"
            className="sd-footer-link"
            style={styles.footerLink}
          >
            Tracker
          </a>
          <a
            href="/governance"
            target="_blank"
            rel="noreferrer"
            className="sd-footer-link"
            style={styles.footerLink}
          >
            Governance
          </a>
          <a
            href="/graph"
            target="_blank"
            rel="noreferrer"
            className="sd-footer-link"
            style={styles.footerLink}
          >
            Graph
          </a>
          <a
            href="/live-bets"
            target="_blank"
            rel="noreferrer"
            className="sd-footer-link"
            style={styles.footerLink}
          >
            Live Bets
          </a>
        </nav>
      </footer>

      {selectedAgentId !== null && (
        <AgentInspectorModal
          agentId={selectedAgentId}
          onClose={() => setSelectedAgentId(null)}
          onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
          onSelectCustomerById={(customerId) => {
            setSelectedAgentId(null);
            handleSelectCustomerById(customerId);
          }}
          onInspectPty={(customerId) => {
            setSelectedAgentId(null);
            setActiveTab("terminal");
            void runTerminalCommand(`profile ${customerId} --radar`);
          }}
        />
      )}

      {/* Operator Shift Summary & Handoff Modal */}
      {isShiftModalOpen && (
        <ShiftHandoffModal
          shiftOperator={shiftOperator}
          onShiftOperatorChange={setShiftOperator}
          shiftLoading={shiftLoading}
          onRefresh={(operatorId) => {
            void fetchShiftSummary(operatorId);
          }}
          shiftSummary={shiftSummary}
          onClose={() => setIsShiftModalOpen(false)}
        />
      )}
    </div>
  );
}
