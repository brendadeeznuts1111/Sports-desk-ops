import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PARTNER_118_CHANNELS,
  WAGER_CHANNEL_LABELS,
  wagerChannelOf,
  type WagerChannel,
} from "@sportsdesk-ops/contracts";
import { styles } from "../dashboard_styles.ts";
import {
  buildGsliveEventLog,
  buildGsliveGameLog,
  gameKeyOf,
} from "../gslive_game_log.ts";
import { GsliveGameLogSection } from "./GsliveGameLogSection.tsx";
import { findAlertForWager } from "../ticket_inspector.ts";
import { sanitizeCaptureText } from "../capture_text.ts";
import { formatWagerSelection } from "../wager_display.ts";
import { TicketInspectorPanel } from "./TicketInspectorPanel.tsx";
import {
  formatProvenanceBadge,
  PENDING_WAGERS_PROVENANCE,
} from "../hydration.ts";
import {
  DASHBOARD_FRESHNESS,
  DASHBOARD_THRESHOLDS,
} from "../config/dashboard.ts";
import {
  clvEdgeTone,
  WAGER_ALERT_TIERS,
  WAGER_BET_TYPE_FILTERS,
  WAGER_PERIOD_FILTERS,
  WAGER_SPORT_FILTERS,
  WAGER_TIER_RANK,
  WAGERS_META,
  WAGERS_TABLE,
  WAGERS_THRESHOLDS,
} from "../config/wagers.ts";
import { getLocalAgentHref } from "../links.ts";
import { WireContractChip } from "./WireContractChip.tsx";
import type {
  DashboardAlertRecord,
  DashboardSourceProvenance,
  LiveBetsV2SummarySnapshot,
  LiveWager,
  LiveWagersClvSummary,
  TierStyleConfig,
  SlabPolicySummary,
  WagerSortField,
  WagersWireContractSummary,
} from "../types.ts";

export interface LiveWagersTabPanelProps {
  readonly wagers?: readonly LiveWager[] | undefined;
  readonly clvSummary?: LiveWagersClvSummary | null | undefined;
  readonly liveBetsSnapshot?: LiveBetsV2SummarySnapshot | null | undefined;
  readonly provenance?: DashboardSourceProvenance | undefined;
  readonly wagersError?: string | null | undefined;
  /** Epoch ms of the last successful wager fetch, for the stream status line. */
  readonly wagersLastUpdatedAt?: number | null | undefined;
  /** Ticket ids that arrived in the latest refresh (highlighted, then cleared by the caller). */
  readonly newTicketIds?: ReadonlySet<string> | undefined;
  /** WebSocket state; false means the stream is on the polling fallback. */
  readonly streamingConnected?: boolean | undefined;
  readonly onRefreshWagers?: (() => void) | undefined;
  readonly wagerSearch: string;
  readonly onWagerSearchChange: (value: string) => void;
  readonly wagerSportFilter: string;
  readonly onWagerSportFilterChange: (sport: string) => void;
  readonly wagerAlertFilter: string;
  readonly onWagerAlertFilterChange: (tier: string) => void;
  /** Channel split: ALL, GSLIVE, GSBUILDER, INTERNET (case-insensitive). */
  readonly wagerChannelFilter?: string | undefined;
  readonly onWagerChannelFilterChange?: ((channel: string) => void) | undefined;
  readonly wagerTypeFilter: string;
  readonly onWagerTypeFilterChange: (betType: string) => void;
  readonly wagerSortField: WagerSortField;
  readonly wagerSortDir: "asc" | "desc";
  readonly onWagerSort: (field: WagerSortField) => void;
  readonly selectedWager: LiveWager | null;
  readonly onSelectWager: (wager: LiveWager) => void;
  readonly copiedTicketId: string | null;
  readonly onCopyText: (ticketId: string, text: string) => void;
  readonly tiersConfig: TierStyleConfig | null;
  /** Vendor wire-contract check from the feed; absent when the host doesn't check. */
  readonly wireContract?: WagersWireContractSummary | null | undefined;
  /** Validated slab policy from config/slab.toml, when the host exposes it. */
  readonly slabPolicy?: SlabPolicySummary | null | undefined;
  readonly onSelectCustomerById: (customerId: string) => void;
  readonly onInspectPty: (customerId: string) => void;
  readonly onRunPtyCommand?: ((command: string) => void) | undefined;
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
  readonly alertRecords?: readonly DashboardAlertRecord[] | undefined;
}

// Filter vocabulary and severity ranks are inlined from
// `packages/ui/src/config/wagers.toml` by Bun's bundler (no runtime fetch).
const SPORT_PILLS = WAGER_SPORT_FILTERS;
const PERIOD_SLICE_PILLS = WAGER_PERIOD_FILTERS;
const BET_TYPE_PILLS = WAGER_BET_TYPE_FILTERS;
const ALERT_PILLS = [
  { id: "ALL", label: "All Alerts" },
  ...WAGER_ALERT_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
];
const TIER_ORDER = WAGER_TIER_RANK;

const CHANNEL_PILLS: readonly {
  readonly id: string;
  readonly label: string;
}[] = [
  { id: "ALL", label: "All Channels" },
  { id: "GSLIVE", label: "🔴 GSLIVE" },
  { id: "GSBUILDER", label: "🧩 GS Builder" },
  { id: "INTERNET", label: "🌐 Internet" },
];

/** Channel of a row: the hydrated family when present, else the writer string. */
function channelOfWager(w: LiveWager): WagerChannel {
  return w.writer ?? wagerChannelOf(w.ticketWriter);
}

interface ChannelProfile {
  readonly channel: WagerChannel;
  readonly label: string;
  readonly tickets: number;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly avgTicketUsd: number;
  readonly liveTickets: number;
  readonly topCustomerId: string | null;
  readonly topCustomerRiskUsd: number;
}

function profileChannels(
  wagers: readonly LiveWager[],
  channels: readonly WagerChannel[],
): ChannelProfile[] {
  return channels.map((channel) => {
    const rows = wagers.filter((w) => channelOfWager(w) === channel);
    const byCustomer = new Map<string, number>();
    let riskUsd = 0;
    let toWinUsd = 0;
    let liveTickets = 0;
    for (const w of rows) {
      riskUsd += w.riskUsd;
      toWinUsd += w.toWinUsd;
      if (
        w.alertTier === "LATENCY" ||
        /in-play|live|halftime/i.test(w.selection)
      ) {
        liveTickets += 1;
      }
      byCustomer.set(
        w.customerId,
        (byCustomer.get(w.customerId) ?? 0) + w.riskUsd,
      );
    }
    let topCustomerId: string | null = null;
    let topCustomerRiskUsd = 0;
    for (const [id, risk] of byCustomer) {
      if (risk > topCustomerRiskUsd) {
        topCustomerId = id;
        topCustomerRiskUsd = risk;
      }
    }
    return {
      channel,
      label: WAGER_CHANNEL_LABELS[channel],
      tickets: rows.length,
      riskUsd,
      toWinUsd,
      avgTicketUsd: rows.length > 0 ? Math.round(riskUsd / rows.length) : 0,
      liveTickets,
      topCustomerId,
      topCustomerRiskUsd,
    };
  });
}

/** Stake emphasis is owned by `dashboard.toml`, not duplicated in wagers.toml. */
const HIGH_RISK_WAGER_USD = DASHBOARD_THRESHOLDS.high_risk_wager_usd;

function describeEmptyWagers(
  loadedCount: number,
  provenance: DashboardSourceProvenance,
): string {
  const endpoint = provenance.sourcePath ?? "/api/wagers";
  if (loadedCount > 0) return "No wagers match the current filters.";
  switch (provenance.kind) {
    case "pending":
      return `Waiting for GET ${endpoint}…`;
    case "unavailable":
      return `Unavailable — ${endpoint}: ${provenance.label}`;
    default:
      return `${provenance.label} returned no wagers (${endpoint}).`;
  }
}

export function LiveWagersTabPanel({
  wagers = [],
  clvSummary = null,
  liveBetsSnapshot = null,
  provenance = PENDING_WAGERS_PROVENANCE,
  wagersError = null,
  wagersLastUpdatedAt = null,
  newTicketIds,
  streamingConnected,
  onRefreshWagers,
  wagerSearch,
  onWagerSearchChange,
  wagerSportFilter,
  onWagerSportFilterChange,
  wagerAlertFilter,
  onWagerAlertFilterChange,
  wagerChannelFilter = "ALL",
  onWagerChannelFilterChange = () => {},
  wagerTypeFilter,
  onWagerTypeFilterChange,
  wagerSortField,
  wagerSortDir,
  onWagerSort,
  selectedWager,
  onSelectWager,
  copiedTicketId,
  onCopyText,
  tiersConfig,
  wireContract = null,
  slabPolicy = null,
  onSelectCustomerById,
  onInspectPty,
  onRunPtyCommand,
  onSelectAgent,
  alertRecords = [],
}: LiveWagersTabPanelProps): React.ReactElement {
  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [wagerClvFilter, setWagerClvFilter] = useState<
    "ALL" | "POS_BOOK" | "NEG_BOOK" | "HAS_TICKET_CLV"
  >("ALL");
  const [paused, setPaused] = useState(false);
  const [frozenWagers, setFrozenWagers] = useState<readonly LiveWager[] | null>(
    null,
  );
  const [pendingNew, setPendingNew] = useState(0);
  const seenTicketIdsRef = useRef<Set<string>>(new Set());
  const isGsliveScope = wagerChannelFilter.toUpperCase() === "GSLIVE";

  const inspectorRelatedWagers = useMemo(() => {
    if (selectedWager === null) {
      return [];
    }
    return wagers
      .filter(
        (w) =>
          w.customerId === selectedWager.customerId &&
          w.ticketId !== selectedWager.ticketId,
      )
      .slice(0, 8);
  }, [wagers, selectedWager]);

  const inspectorMatchedAlert = useMemo(() => {
    if (selectedWager === null) {
      return null;
    }
    return findAlertForWager(alertRecords, selectedWager);
  }, [alertRecords, selectedWager]);

  // A game selection belongs to the GSLIVE scope; leaving it must not silently keep
  // filtering another channel's table.
  useEffect(() => {
    setSelectedGame(null);
  }, [wagerChannelFilter]);

  const activeWagers = wagers;
  // Pause freezes the table only; channel profiles and the GSLIVE logs stay live.
  const tableWagers =
    paused && frozenWagers !== null ? frozenWagers : activeWagers;

  useEffect(() => {
    const ids = new Set(wagers.map((w) => w.ticketId));
    if (paused) {
      let added = 0;
      for (const id of ids) {
        if (!seenTicketIdsRef.current.has(id)) added += 1;
      }
      if (added > 0) setPendingNew((count) => count + added);
    }
    seenTicketIdsRef.current = ids;
  }, [wagers, paused]);

  const toggleWagersPause = () => {
    if (paused) {
      setPaused(false);
      setFrozenWagers(null);
      setPendingNew(0);
      return;
    }
    setPaused(true);
    setFrozenWagers(activeWagers);
    setPendingNew(0);
  };
  const activeProvenance: DashboardSourceProvenance = wagersError
    ? {
        kind: "unavailable",
        label: wagersError,
        sourcePath: provenance.sourcePath,
        observedAt: provenance.observedAt,
      }
    : provenance;
  const provenanceBadge = formatProvenanceBadge(activeProvenance, {
    staleAfterMinutes: DASHBOARD_FRESHNESS.stale_after_minutes,
  });

  const criticalSteamCount = activeWagers.filter(
    (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
  ).length;
  const totalRiskUsd = activeWagers.reduce((acc, w) => acc + w.riskUsd, 0);
  const totalToWinUsd = activeWagers.reduce((acc, w) => acc + w.toWinUsd, 0);
  // Partner 118 split is computed over the whole capture, not the filtered slice, so the
  // two channel profiles stay comparable while an operator narrows the table.
  const partner118Profiles = profileChannels(
    activeWagers,
    PARTNER_118_CHANNELS,
  );
  const nonPartnerTicketCount =
    activeWagers.length -
    partner118Profiles.reduce((acc, profile) => acc + profile.tickets, 0);
  // Game/event logs only exist for the GSLIVE scope; deriving them elsewhere would show
  // an empty section on every channel.
  const gsliveGames = isGsliveScope ? buildGsliveGameLog(activeWagers) : [];
  const gsliveEvents = isGsliveScope
    ? buildGsliveEventLog(activeWagers, selectedGame)
    : [];

  const baseSportIds = new Set(SPORT_PILLS.map((p) => p.id.toUpperCase()));
  const extraSportPills: Array<{ id: string; label: string }> = [];
  for (const w of activeWagers) {
    for (const value of [w.sport, w.subSport ?? ""]) {
      const up = value.toUpperCase();
      if (up && !baseSportIds.has(up)) {
        baseSportIds.add(up);
        extraSportPills.push({ id: up, label: up });
      }
    }
  }
  const availableSportIds = new Set<string>();
  for (const w of activeWagers) {
    for (const value of [w.sport, w.subSport ?? ""]) {
      const up = value.toUpperCase();
      if (up !== "") availableSportIds.add(up);
    }
  }
  // Keep only sport/league pills that can match a row (plus All); a league pill with no
  // subsport data would filter the table to zero rows.
  const sportPills = [
    ...SPORT_PILLS.filter(
      (pill) =>
        pill.id.toUpperCase() === "ALL" ||
        availableSportIds.has(pill.id.toUpperCase()),
    ),
    ...extraSportPills,
  ];

  const baseTypeIds = new Set(BET_TYPE_PILLS.map((p) => p.id.toUpperCase()));
  const extraTypePills: Array<{ id: string; label: string }> = [];
  for (const w of activeWagers) {
    const up = w.betType.toUpperCase();
    if (up && !baseTypeIds.has(up)) {
      baseTypeIds.add(up);
      extraTypePills.push({ id: w.betType, label: w.betType });
    }
  }
  const betTypePills = [...BET_TYPE_PILLS, ...extraTypePills];

  const filteredWagers = tableWagers
    .filter((w) => {
      const q = wagerSearch.trim().toLowerCase();
      const matchesSearch =
        !q ||
        w.ticketId.toLowerCase().includes(q) ||
        w.customerId.toLowerCase().includes(q) ||
        w.agentId.toLowerCase().includes(q) ||
        w.sport.toLowerCase().includes(q) ||
        w.betType.toLowerCase().includes(q) ||
        w.event.toLowerCase().includes(q) ||
        w.selection.toLowerCase().includes(q) ||
        w.alertBadge.toLowerCase().includes(q) ||
        ((q === "live" || q === "gslive" || q === "in-play") &&
          (/in-play|live|halftime/i.test(w.selection) ||
            /in-play|live|halftime/i.test(w.alertBadge) ||
            w.alertTier === "LATENCY"));
      if (!matchesSearch) return false;
      if (wagerSportFilter !== "ALL") {
        const sportFilter = wagerSportFilter.toUpperCase();
        const subSport = (w.subSport ?? "").toUpperCase();
        if (w.sport.toUpperCase() !== sportFilter && subSport !== sportFilter) {
          return false;
        }
      }
      if (wagerAlertFilter !== "ALL" && w.alertTier !== wagerAlertFilter)
        return false;
      if (
        wagerChannelFilter !== "ALL" &&
        channelOfWager(w).toUpperCase() !== wagerChannelFilter.toUpperCase()
      )
        return false;
      if (
        isGsliveScope &&
        selectedGame !== null &&
        gameKeyOf(w) !== selectedGame
      )
        return false;
      if (
        wagerTypeFilter !== "ALL" &&
        w.betType.toUpperCase() !== wagerTypeFilter.toUpperCase()
      )
        return false;
      if (wagerClvFilter === "POS_BOOK") {
        if (typeof w.customerClvBps !== "number" || w.customerClvBps <= 0)
          return false;
      } else if (wagerClvFilter === "NEG_BOOK") {
        if (typeof w.customerClvBps !== "number" || w.customerClvBps >= 0)
          return false;
      } else if (wagerClvFilter === "HAS_TICKET_CLV") {
        if (w.clvCents === null) return false;
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (wagerSortField === "timestamp") {
        cmp = a.timestamp.localeCompare(b.timestamp);
      } else if (wagerSortField === "riskUsd") {
        cmp = a.riskUsd - b.riskUsd;
      } else if (wagerSortField === "toWinUsd") {
        cmp = a.toWinUsd - b.toWinUsd;
      } else if (wagerSortField === "clvCents") {
        // Unknown CLV sorts last in both directions rather than pretending to be 0.
        if (a.clvCents === null || b.clvCents === null) {
          return a.clvCents === null ? (b.clvCents === null ? 0 : 1) : -1;
        }
        return wagerSortDir === "asc"
          ? a.clvCents - b.clvCents
          : b.clvCents - a.clvCents;
      } else if (wagerSortField === "alertTier") {
        cmp = (TIER_ORDER[a.alertTier] ?? 0) - (TIER_ORDER[b.alertTier] ?? 0);
      }
      return wagerSortDir === "asc" ? cmp : -cmp;
    });

  // Hard render bound from wagers.toml: the feed may carry more rows than the
  // desk wants mounted in one table pass.
  const visibleWagers = filteredWagers.slice(0, WAGERS_TABLE.max_rows);
  const wagersAgeSeconds =
    wagersLastUpdatedAt === null
      ? null
      : Math.max(0, Math.round((Date.now() - wagersLastUpdatedAt) / 1000));
  const wagerStreamState = paused
    ? "paused"
    : streamingConnected === false
      ? "fallback"
      : "live";
  const freshVisibleCount = visibleWagers.filter(
    (w) => newTicketIds?.has(w.ticketId) === true,
  ).length;
  // Stable per capture: a filter must not make the column appear/disappear.
  const showSubSportColumn = activeWagers.some(
    (w) => (w.subSport ?? "") !== "",
  );

  // Aggregate per-customer CLV & dollar edge across the active slice
  const sliceCustomerMap = new Map<
    string,
    {
      customerId: string;
      agentId: string;
      wagers: number;
      riskUsd: number;
      clvSum: number;
      expectedEdgeUsd: number;
    }
  >();
  for (const w of filteredWagers) {
    // The customer aggregate is a CLV aggregate; a row without a closing-line
    // comparison contributes nothing rather than a zero.
    if (w.clvCents === null) continue;
    const existing = sliceCustomerMap.get(w.customerId);
    const edgeUsd = w.riskUsd * (w.clvCents / 100);
    if (existing) {
      existing.wagers += 1;
      existing.riskUsd += w.riskUsd;
      existing.clvSum += w.clvCents;
      existing.expectedEdgeUsd += edgeUsd;
    } else {
      sliceCustomerMap.set(w.customerId, {
        customerId: w.customerId,
        agentId: w.agentId,
        wagers: 1,
        riskUsd: w.riskUsd,
        clvSum: w.clvCents,
        expectedEdgeUsd: edgeUsd,
      });
    }
  }
  // A stale contract must not read as clean when the feed itself failed: the
  // error wins and the chip says unavailable, matching the provenance badge.
  const wireError = wagersError ?? wireContract?.error ?? null;

  const topSliceBeaters = [...sliceCustomerMap.values()]
    .sort((a, b) => b.expectedEdgeUsd - a.expectedEdgeUsd)
    .slice(0, WAGERS_THRESHOLDS.slice_leader_limit);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {wagersError ? (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            color: "#fca5a5",
            fontSize: "12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span>
            <b>Live Wagers Feed Error:</b> {wagersError}
          </span>
          {onRefreshWagers ? (
            <button
              type="button"
              style={styles.actionBtn}
              onClick={onRefreshWagers}
            >
              ↻ Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Live Wagers KPI Grid */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Live Streaming Feed</div>
          <div style={styles.kpiVal}>{activeWagers.length} Wagers</div>
          <div style={styles.kpiSub}>{provenanceBadge.detail}</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Flagged Steam / Originator</div>
          <div style={{ ...styles.kpiVal, color: "#f87171" }}>
            {criticalSteamCount} Alerts
          </div>
          <div style={styles.kpiSub}>Key Numbers 3 & 7 / Syndicate Hooks</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Live Exposure at Risk</div>
          <div style={styles.kpiVal}>${totalRiskUsd.toLocaleString()}</div>
          <div style={styles.kpiSub}>
            To Win: ${totalToWinUsd.toLocaleString()}
          </div>
        </div>
        {(() => {
          const ticketClvVals = activeWagers
            .map((w) => w.clvCents)
            .filter(
              (v): v is number => typeof v === "number" && Number.isFinite(v),
            );
          const bookClvVals = activeWagers
            .map((w) => w.customerClvBps)
            .filter(
              (v): v is number => typeof v === "number" && Number.isFinite(v),
            );
          const ticketCount =
            clvSummary?.ticketClvCount ?? ticketClvVals.length;
          const meanTicket = clvSummary
            ? clvSummary.meanTicketClvCents
            : ticketClvVals.length > 0
              ? Math.round(
                  (ticketClvVals.reduce((a, b) => a + b, 0) /
                    ticketClvVals.length) *
                    10,
                ) / 10
              : null;
          const bookCount = clvSummary?.bookMatchedCount ?? bookClvVals.length;
          const meanBook = clvSummary
            ? clvSummary.meanCustomerClvBps
            : bookClvVals.length > 0
              ? Math.round(
                  (bookClvVals.reduce((a, b) => a + b, 0) /
                    bookClvVals.length) *
                    10,
                ) / 10
              : null;
          const headline =
            meanTicket !== null
              ? `Ticket ${meanTicket > 0 ? "+" : ""}${meanTicket}¢`
              : meanBook !== null
                ? `Book ${meanBook > 0 ? "+" : ""}${meanBook} bps`
                : "— (0 measured)";
          const headlineColor =
            meanTicket !== null
              ? meanTicket > 0
                ? "#4ade80"
                : "#f87171"
              : meanBook !== null
                ? meanBook > 0
                  ? "#4ade80"
                  : meanBook < 0
                    ? "#f87171"
                    : "#e2e8f0"
                : "#94a3b8";
          return (
            <div style={styles.kpiCard} data-wagers-clv-kpi="true">
              <div style={styles.kpiLabel}>CLV Telemetry</div>
              <div style={{ ...styles.kpiVal, color: headlineColor }}>
                {headline}
              </div>
              <div style={styles.kpiSub}>
                Ticket CLV: {ticketCount} · Book matched: {bookCount}
                {clvSummary
                  ? ` (+${clvSummary.positiveCustomerClvCount} / -${clvSummary.negativeCustomerClvCount})`
                  : ""}
              </div>
            </div>
          );
        })()}
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Operator Guardrails</div>
          <div style={{ ...styles.kpiVal, color: "#4ade80" }}>
            autoExecute: false
          </div>
          <div style={styles.kpiSub}>Production Safety Invariant Active</div>
        </div>
      </div>

      {liveBetsSnapshot ? (
        <div
          data-live-bets-v2-strip="true"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            marginBottom: "12px",
            padding: "8px 12px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.72)",
            border: "1px solid rgba(56, 189, 248, 0.25)",
            fontSize: "12px",
            color: "#cbd5e1",
          }}
        >
          <span>
            <b style={{ color: "#38bdf8" }}>
              Live Pending Bets Book (/api/v2/live-bets):
            </b>{" "}
            {liveBetsSnapshot.totalGames} games ·{" "}
            {liveBetsSnapshot.totalPending} pending · Handle{" "}
            <b>
              $
              {Math.round(
                liveBetsSnapshot.totalWageredCents / 100,
              ).toLocaleString()}
            </b>{" "}
            · To Win{" "}
            <b>
              $
              {Math.round(
                liveBetsSnapshot.totalToWinCents / 100,
              ).toLocaleString()}
            </b>
          </span>
          <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>
            source={liveBetsSnapshot.dataSource}
            {liveBetsSnapshot.fallbackUsed ? " (sample fallback)" : ""}
          </span>
        </div>
      ) : null}

      {/* Filter and Search Bar */}
      <div style={styles.filterBar}>
        <div style={styles.searchBox}>
          <span style={styles.searchIcon}>🔍</span>
          <input
            style={styles.searchInput}
            value={wagerSearch}
            onChange={(e) => onWagerSearchChange(e.target.value)}
            placeholder="Filter by Ticket (#W-...), Customer, Agent, Event, Selection..."
          />
        </div>

        <div style={styles.tierFilterGroup}>
          {sportPills.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(
                wagerSportFilter.toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerSportFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {ALERT_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(wagerAlertFilter === pill.id)}
              onClick={() => onWagerAlertFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {CHANNEL_PILLS.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(
                wagerChannelFilter.toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerChannelFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {betTypePills.map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(
                wagerTypeFilter.toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerTypeFilterChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {(
            [
              { id: "ALL", label: "All CLV" },
              { id: "POS_BOOK", label: "+CLV Book" },
              { id: "NEG_BOOK", label: "-CLV Book" },
              { id: "HAS_TICKET_CLV", label: "Has Ticket CLV" },
            ] as const
          ).map((pill) => (
            <button
              key={pill.id}
              type="button"
              style={styles.filterPill(wagerClvFilter === pill.id)}
              onClick={() => setWagerClvFilter(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>

        <div style={styles.tierFilterGroup}>
          {PERIOD_SLICE_PILLS.map((pill) => (
            <button
              key={pill.label}
              type="button"
              style={styles.filterPill(
                wagerSearch.trim().toUpperCase() === pill.id.toUpperCase(),
              )}
              onClick={() => onWagerSearchChange(pill.id)}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      {/* Partner 118 channel profile: GSLIVE vs GSBUILDER, split before filtering */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "stretch",
          gap: "10px",
          padding: "0 14px 10px",
        }}
      >
        {partner118Profiles.map((profile) => {
          const active =
            wagerChannelFilter.toUpperCase() === profile.channel.toUpperCase();
          return (
            <button
              key={profile.channel}
              type="button"
              data-channel-profile={profile.channel}
              onClick={() =>
                onWagerChannelFilterChange(
                  active ? "ALL" : profile.channel.toUpperCase(),
                )
              }
              title={`Filter Live Wagers to ${profile.label} tickets`}
              style={{
                flex: "1 1 320px",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: "8px",
                cursor: "pointer",
                backgroundColor: active
                  ? "rgba(56, 189, 248, 0.14)"
                  : "rgba(15, 23, 42, 0.75)",
                border: `1px solid ${active ? "rgba(56, 189, 248, 0.55)" : "rgba(148, 163, 184, 0.25)"}`,
                color: "#e2e8f0",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: "8px",
                }}
              >
                <span style={{ fontWeight: 700, fontSize: "12px" }}>
                  {profile.channel === "gslive" ? "🔴" : "🧩"} {profile.label}
                </span>
                <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                  {profile.tickets} ticket{profile.tickets === 1 ? "" : "s"}
                </span>
              </div>
              <div
                style={{ fontSize: "11px", color: "#cbd5e1", marginTop: "4px" }}
              >
                ${profile.riskUsd.toLocaleString()} risk · $
                {profile.toWinUsd.toLocaleString()} to-win · avg $
                {profile.avgTicketUsd.toLocaleString()}
              </div>
              <div
                style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}
              >
                {profile.liveTickets} live-marked · top{" "}
                {profile.topCustomerId ?? "—"}
                {profile.topCustomerId !== null
                  ? ` ($${profile.topCustomerRiskUsd.toLocaleString()})`
                  : ""}
              </div>
            </button>
          );
        })}
        <div
          style={{
            flex: "1 1 180px",
            padding: "10px 12px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.55)",
            border: "1px solid rgba(148, 163, 184, 0.18)",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          <div style={{ fontWeight: 700, color: "#cbd5e1" }}>
            Other channels
          </div>
          <div style={{ marginTop: "4px" }}>
            {nonPartnerTicketCount} ticket
            {nonPartnerTicketCount === 1 ? "" : "s"} (Internet, other writers)
          </div>
        </div>
      </div>

      {isGsliveScope && (
        <GsliveGameLogSection
          games={gsliveGames}
          events={gsliveEvents}
          selectedGame={selectedGame}
          onSelectGame={setSelectedGame}
          onSelectEvent={(ticketId) => {
            const wager = activeWagers.find((w) => w.ticketId === ticketId);
            if (wager !== undefined) onSelectWager(wager);
          }}
          lastUpdatedAt={wagersLastUpdatedAt}
          newTicketIds={newTicketIds}
          connected={streamingConnected}
        />
      )}

      {/* Slice Edge Leaderboard: Who is beating the desk in the active filter slice */}
      {topSliceBeaters.length > 0 && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.75)",
            border: "1px solid rgba(56, 189, 248, 0.25)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 700, color: "#e2e8f0" }}>
            🎯 Active Slice Edge Leaderboard (Who&apos;s Beating the Line):
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {topSliceBeaters.map((c, idx) => {
              const avgClv = c.wagers > 0 ? c.clvSum / c.wagers : 0;
              return (
                <button
                  key={c.customerId}
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "4px 10px",
                    fontSize: "11px",
                    cursor: "pointer",
                  }}
                  onClick={() => onSelectCustomerById(c.customerId)}
                  title={`Inspect ${c.customerId} (${c.agentId}) — ${c.wagers} wager(s), $${c.riskUsd.toLocaleString()} risk`}
                >
                  #{idx + 1} <b>{c.customerId}</b> ({c.agentId}) ·{" "}
                  {avgClv > 0
                    ? `+${avgClv.toFixed(1)}¢`
                    : `${avgClv.toFixed(1)}¢`}{" "}
                  CLV · ${c.riskUsd.toLocaleString()}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Live Wagers Table Card */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h3 style={styles.tableTitle}>
              ⚡ Live Incoming Wagers & Real-Time Action Directives
            </h3>
            <span
              title={provenanceBadge.detail}
              style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: "999px",
                color: provenanceBadge.fg,
                backgroundColor: provenanceBadge.bg,
                border: `1px solid ${provenanceBadge.border}`,
              }}
            >
              {provenanceBadge.badgeText}
            </span>
            <span
              title={`Filter vocabulary, CLV ramp and row bounds are inlined from packages/ui/src/config/wagers.toml (schema ${WAGERS_META.schema}, v${WAGERS_META.version}) at bundle time. No runtime fetch, no JSON parse.`}
              style={{
                fontSize: "10px",
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: "999px",
                color: "#a5b4fc",
                backgroundColor: "rgba(99, 102, 241, 0.14)",
                border: "1px solid rgba(129, 140, 248, 0.4)",
              }}
            >
              📄 {WAGERS_TABLE.policy_tag}
            </span>
            <WireContractChip summary={wireContract} error={wireError} />
            {slabPolicy ? (
              <span
                title={`config/slab.toml ${slabPolicy.schema} v${slabPolicy.version}: ${slabPolicy.window_bytes} byte window; sentinels null_clv=${slabPolicy.sentinels.null_clv}, null_customer_handle32=${slabPolicy.sentinels.null_customer_handle32}, null_bridge_channel_word32=${slabPolicy.sentinels.null_bridge_channel_word32}; unsafe_allowed=${String(slabPolicy.unsafe_allowed)}`}
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "999px",
                  color: "#94a3b8",
                  backgroundColor: "rgba(148, 163, 184, 0.12)",
                  border: "1px solid rgba(148, 163, 184, 0.35)",
                  whiteSpace: "nowrap",
                }}
              >
                ⚙ slab {(slabPolicy.window_bytes / 1_000_000).toFixed(1)} MB
              </span>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              data-wagers-stream={wagerStreamState}
              title="WebSocket push on capture changes; the table also refetches every 10s while this tab is open"
              style={{
                fontSize: "10px",
                fontWeight: 700,
                color: paused
                  ? "#f59e0b"
                  : wagerStreamState === "fallback"
                    ? "#94a3b8"
                    : "#4ade80",
                whiteSpace: "nowrap",
              }}
            >
              {paused
                ? "⏸ paused"
                : wagerStreamState === "fallback"
                  ? "◌ polling"
                  : "● live"}
              {!paused && wagersAgeSeconds !== null
                ? ` · ${wagersAgeSeconds}s ago`
                : ""}
              {paused && pendingNew > 0 ? ` · ${pendingNew} new` : ""}
              {!paused ? (
                <span style={{ color: "#64748b", fontWeight: 500 }}>
                  {" "}
                  · auto 10s
                </span>
              ) : null}
              {freshVisibleCount > 0 ? (
                <span style={{ color: "#4ade80", fontWeight: 700 }}>
                  {" "}
                  · +{freshVisibleCount} new
                </span>
              ) : null}
            </span>
            <span style={{ fontSize: "11px", color: "#64748b" }}>
              {provenanceBadge.detail} · showing {visibleWagers.length}/
              {filteredWagers.length} · autoExecute: false invariant active
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              <button
                type="button"
                data-wagers-pause="true"
                onClick={toggleWagersPause}
                title={
                  paused
                    ? "Resume live updates for the table"
                    : "Freeze the table while you read; updates keep arriving"
                }
                style={{
                  ...styles.actionBtn,
                  padding: "4px 8px",
                  fontSize: "11px",
                  ...(paused
                    ? {
                        backgroundColor: "rgba(245, 158, 11, 0.16)",
                        color: "#fbbf24",
                        border: "1px solid rgba(245, 158, 11, 0.5)",
                      }
                    : {}),
                }}
              >
                {paused ? "▶ Resume" : "⏸ Pause"}
              </button>
              {onRefreshWagers ? (
                <button
                  type="button"
                  style={{
                    ...styles.actionBtn,
                    padding: "4px 8px",
                    fontSize: "11px",
                  }}
                  onClick={onRefreshWagers}
                  title="Fetch /api/wagers now (the table also auto-refreshes every 10s)"
                >
                  ↻ Refresh
                </button>
              ) : null}
            </span>
          </div>
        </div>

        <div style={styles.tableScroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("timestamp")}
                  title="Sort by Timestamp"
                >
                  Ticket / Time{" "}
                  {wagerSortField === "timestamp"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th style={styles.th}>Customer</th>
                <th style={styles.th}>Sub-Agent / Master</th>
                <th style={styles.th}>Sport</th>
                {showSubSportColumn ? (
                  <th
                    style={styles.th}
                    title="League / sub-sport from the source (F402 SubSport). Live betTicker captures do not carry it."
                  >
                    Subsport
                  </th>
                ) : null}
                <th
                  style={styles.th}
                  title="Bet type from the ticket (Moneyline, Spread, Total, Parlay, Straight, Live). The channel follows 'via'."
                >
                  Bet Type
                </th>
                <th
                  style={styles.th}
                  title="Game or matchup the ticket was written on"
                >
                  Event
                </th>
                <th
                  style={styles.th}
                  title="Pick, line and price for the selected market"
                >
                  Market Selection
                </th>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("riskUsd")}
                  title="Sort by Risk Amount"
                >
                  Risk / To Win{" "}
                  {wagerSortField === "riskUsd"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("clvCents")}
                  title="Sort by CLV Edge"
                >
                  CLV Edge{" "}
                  {wagerSortField === "clvCents"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th
                  style={{
                    ...styles.th,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => onWagerSort("alertTier")}
                  title="Sort by Alert Severity"
                >
                  Alert Classification{" "}
                  {wagerSortField === "alertTier"
                    ? wagerSortDir === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </th>
                <th style={styles.th}>Action Directive</th>
                <th style={styles.th}>Operator Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleWagers.map((w) => (
                <tr
                  key={w.ticketId}
                  style={{
                    ...styles.wagerRow(selectedWager?.ticketId === w.ticketId),
                    ...(newTicketIds?.has(w.ticketId) === true
                      ? { backgroundColor: "rgba(74, 222, 128, 0.10)" }
                      : {}),
                  }}
                  onClick={() => onSelectWager(w)}
                >
                  <td style={styles.td}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span
                        style={{
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontWeight: 700,
                          color: "#38bdf8",
                        }}
                      >
                        #{w.ticketId}
                      </span>
                      <button
                        type="button"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: "11px",
                          color: "#94a3b8",
                          padding: "0 2px",
                        }}
                        title="Copy Ticket ID"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCopyText(w.ticketId, w.ticketId);
                        }}
                      >
                        {copiedTicketId === w.ticketId ? "✓" : "📋"}
                      </button>
                      {newTicketIds?.has(w.ticketId) === true ? (
                        <span
                          style={{
                            color: "#4ade80",
                            fontWeight: 800,
                            fontSize: "9px",
                            letterSpacing: "0.06em",
                          }}
                        >
                          NEW
                        </span>
                      ) : null}
                    </div>
                    <div style={styles.custSub}>{w.timestamp}</div>
                  </td>
                  <td style={styles.td}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span
                        style={{
                          ...styles.custLink,
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCustomerById(w.customerId);
                        }}
                        title="Inspect full profile in Customer Showcase"
                      >
                        {w.customerId}
                      </span>
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${w.customerId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "#94a3b8",
                          textDecoration: "none",
                          fontSize: "11px",
                        }}
                        onClick={(e) => e.stopPropagation()}
                        title="Open in Fantasy402 Manager Portal"
                      >
                        ↗
                      </a>
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div>
                      <a
                        href={getLocalAgentHref(w.agentId)}
                        style={{
                          color: "#38bdf8",
                          textDecoration: "none",
                          fontWeight: 600,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            onSelectAgent &&
                            !e.metaKey &&
                            !e.ctrlKey &&
                            e.button === 0
                          ) {
                            e.preventDefault();
                            onSelectAgent(w.agentId);
                          }
                        }}
                        title="Open SportsDesk Agent Inspector"
                      >
                        {w.agentId} ↗
                      </a>
                    </div>
                    <div style={styles.custSub}>Master: {w.masterAgent}</div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>{w.sport || "—"}</div>
                  </td>
                  {showSubSportColumn ? (
                    <td style={styles.td}>
                      <div style={{ fontWeight: 600 }}>{w.subSport ?? "—"}</div>
                    </td>
                  ) : null}
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>{w.betType}</div>
                    {w.ticketWriter ? (
                      <div style={styles.custSub}>
                        via {sanitizeCaptureText(w.ticketWriter)}
                      </div>
                    ) : null}
                  </td>
                  <td style={styles.td} data-wager-event={w.ticketId}>
                    <div style={{ fontWeight: 600 }}>{w.event}</div>
                  </td>
                  <td style={styles.td} data-wager-market={w.ticketId}>
                    <div style={{ color: "#f59e0b", fontWeight: 700 }}>
                      {formatWagerSelection(w)}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>
                      ${w.riskUsd.toLocaleString()}
                      {w.riskUsd >= HIGH_RISK_WAGER_USD ? (
                        <span
                          title={`Stake at/above the $${HIGH_RISK_WAGER_USD.toLocaleString()} emphasis floor from dashboard.toml`}
                          style={{
                            marginLeft: "6px",
                            padding: "1px 6px",
                            borderRadius: "999px",
                            fontSize: "9px",
                            fontWeight: 800,
                            letterSpacing: "0.04em",
                            color: "#fca5a5",
                            backgroundColor: "rgba(239, 68, 68, 0.16)",
                            border: "1px solid rgba(248, 113, 113, 0.45)",
                            verticalAlign: "middle",
                            whiteSpace: "nowrap",
                            display: "inline-block",
                          }}
                        >
                          HIGH RISK
                        </span>
                      ) : null}
                    </div>
                    <div style={styles.custSub}>
                      To Win: ${w.toWinUsd.toLocaleString()}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        fontWeight: 700,
                        color: clvEdgeTone(w.clvCents),
                      }}
                    >
                      {w.clvCents === null
                        ? "—"
                        : w.clvCents > 0
                          ? `+${w.clvCents}¢`
                          : `${w.clvCents}¢`}
                    </span>
                    {typeof w.customerClvBps === "number" &&
                    Number.isFinite(w.customerClvBps) ? (
                      <div
                        style={{
                          fontSize: "11px",
                          color:
                            w.customerClvBps > 0
                              ? "#4ade80"
                              : w.customerClvBps < 0
                                ? "#f87171"
                                : "#94a3b8",
                          marginTop: "2px",
                        }}
                        title="Customer book-level CLV (bps), distinct from ticket closing-line delta"
                      >
                        Book:{" "}
                        {w.customerClvBps > 0
                          ? `+${w.customerClvBps}`
                          : w.customerClvBps}{" "}
                        bps
                      </div>
                    ) : null}
                  </td>
                  <td style={styles.td}>
                    <span style={styles.wagerBadge(w.alertTier, tiersConfig)}>
                      {w.alertBadge}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <div
                      style={{
                        fontSize: "11px",
                        color:
                          w.alertTier === "CRITICAL" || w.alertTier === "STEAM"
                            ? "#f87171"
                            : "#4ade80",
                        fontWeight: 600,
                      }}
                    >
                      {w.operatorDirective}
                    </div>
                    <div style={styles.custSub}>
                      Cap: ${w.maxRecommendedStake.toLocaleString()}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          cursor: "pointer",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onInspectPty(w.customerId);
                        }}
                        title="Inspect Customer in PTY Terminal"
                      >
                        💻 PTY
                      </button>
                      <a
                        href={`https://fantasy402.com/manager.html?customer=${w.customerId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          ...styles.actionBtn,
                          padding: "4px 8px",
                          fontSize: "11px",
                          textDecoration: "none",
                          color: "#0f172a",
                        }}
                        onClick={(e) => e.stopPropagation()}
                        title="Open Customer in Portal"
                      >
                        Portal ↗
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
              {visibleWagers.length === 0 ? (
                <tr>
                  <td
                    colSpan={showSubSportColumn ? 13 : 12}
                    data-wagers-empty={activeProvenance.kind}
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#94a3b8",
                    }}
                  >
                    {describeEmptyWagers(activeWagers.length, activeProvenance)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {selectedWager ? (
        <TicketInspectorPanel
          wager={selectedWager}
          relatedWagers={inspectorRelatedWagers}
          matchedAlert={inspectorMatchedAlert}
          copiedTicketId={copiedTicketId}
          onCopyText={onCopyText}
          onSelectCustomerById={onSelectCustomerById}
          onSelectWager={onSelectWager}
          onInspectPty={onInspectPty}
          onRunPtyCommand={onRunPtyCommand}
          tiersConfig={tiersConfig}
        />
      ) : null}
    </div>
  );
}
