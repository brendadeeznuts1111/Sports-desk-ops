import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BET_TICKER_RENDER_LIMIT,
  betTickerRowsToTsv,
  nextBetTickerSort,
  sortBetTickerRows,
  type BetTickerSortField,
  type BetTickerSortSpec,
} from "../bet_ticker_view.ts";
import { sanitizeCaptureText } from "../capture_text.ts";
import { copyText } from "../clipboard.ts";
import { styles } from "../dashboard_styles.ts";
import { DASHBOARD_FRESHNESS } from "../config/dashboard.ts";
import { formatProvenanceBadge } from "../hydration.ts";
import { getLocalAgentHref, getLocalCustomerHref } from "../links.ts";
import type { BetTickerApiResponse } from "../types.ts";

export interface BetTickerTabPanelProps {
  readonly data: BetTickerApiResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onSelectCustomerById: (customerId: string) => void;
  readonly onInspectPty: (customerId: string) => void;
}

const SORT_BUTTON: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  margin: 0,
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

function formatUsd(cents: number): string {
  const usd = cents / 100;
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatRelativeAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return "unknown";
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${(ageSeconds / 3600).toFixed(1)}h ago`;
  return `${(ageSeconds / 86400).toFixed(1)}d ago`;
}

export function BetTickerTabPanel({
  data,
  loading,
  error,
  onRefresh,
  onSelectAgent,
  onSelectCustomerById,
  onInspectPty,
}: BetTickerTabPanelProps): React.ReactElement {
  const [writerFilter, setWriterFilter] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [search, setSearch] = useState<string>("");
  const [showSentinelTwins, setShowSentinelTwins] = useState<boolean>(false);
  const [sort, setSort] = useState<BetTickerSortSpec | null>({
    field: "ticket",
    direction: "desc",
  });
  const [showAll, setShowAll] = useState<boolean>(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setShowAll(false);
  }, [writerFilter, typeFilter, search, showSentinelTwins]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const tickets = useMemo(() => {
    const raw = data?.localFeed.tickets ?? [];
    const q = search.trim().toLowerCase();
    return raw.filter((t) => {
      if (!showSentinelTwins && t.isSentinelNoise) return false;
      if (
        writerFilter !== "ALL" &&
        t.ticketWriter.toLowerCase() !== writerFilter.toLowerCase()
      ) {
        return false;
      }
      if (
        typeFilter !== "ALL" &&
        t.wagerType.toUpperCase() !== typeFilter.toUpperCase()
      ) {
        return false;
      }
      if (q) {
        const hay =
          `${t.ticketId} ${t.customerId} ${t.agentId} ${t.sport} ${t.selection} ${t.shortDesc} ${t.ticketWriter}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, writerFilter, typeFilter, search, showSentinelTwins]);

  const sortedTickets = useMemo(
    () => sortBetTickerRows(tickets, sort),
    [tickets, sort],
  );
  const visibleTickets = showAll
    ? sortedTickets
    : sortedTickets.slice(0, BET_TICKER_RENDER_LIMIT);

  const handleSort = (field: BetTickerSortField) => {
    setSort((prev) => nextBetTickerSort(prev, field));
  };
  const sortIndicator = (field: BetTickerSortField): string => {
    if (sort === null || sort.field !== field) return "";
    return sort.direction === "asc" ? " ▲" : " ▼";
  };
  const ariaSort = (
    field: BetTickerSortField,
  ): "ascending" | "descending" | "none" => {
    if (sort === null || sort.field !== field) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  };

  const copyRows = () => {
    if (sortedTickets.length === 0) return;
    void copyText(betTickerRowsToTsv(sortedTickets)).then((result) => {
      setCopyState(result.ok ? "copied" : "failed");
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState("idle"), 1_800);
    });
  };

  const provenanceBadge = data
    ? formatProvenanceBadge(data.provenance, {
        staleAfterMinutes: DASHBOARD_FRESHNESS.stale_after_minutes,
      })
    : null;
  const bridge = data?.bridge3aR2;
  const pending = data?.pendingGames;
  const health = data?.captureHealth;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Signal Honesty Provenance Banner */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
          padding: "10px 14px",
          borderRadius: "8px",
          backgroundColor: "rgba(30, 41, 59, 0.85)",
          border: `1px solid ${provenanceBadge?.border ?? "#334155"}`,
          fontSize: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 700, color: "#f8fafc" }}>
            📡 Bet-Ticker (`getBetTicker`) + Bridge 3a Telemetry
          </span>
          {provenanceBadge && (
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                fontWeight: 700,
                fontSize: "11px",
                color: provenanceBadge.fg,
                backgroundColor: provenanceBadge.bg,
                border: `1px solid ${provenanceBadge.border}`,
              }}
            >
              {provenanceBadge.badgeText}
            </span>
          )}
          {data?.provenance.sourcePath && (
            <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>
              {data.provenance.sourcePath}
            </span>
          )}
          {health?.available && (
            <span style={{ color: "#94a3b8" }}>
              Capture:{" "}
              <strong style={{ color: "#e2e8f0" }}>{health.status}</strong> (
              {formatRelativeAge(health.ageSeconds)})
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <a
            href="/live-bets"
            target="_blank"
            rel="noreferrer"
            style={{
              ...styles.actionBtn,
              backgroundColor: "#1e293b",
              border: "1px solid rgba(56, 189, 248, 0.45)",
              padding: "5px 10px",
              fontSize: "12px",
              textDecoration: "none",
              color: "#38bdf8",
              display: "inline-flex",
              alignItems: "center",
              whiteSpace: "nowrap",
            }}
            title="Open Standalone Pending Scoreboard (/live-bets)"
          >
            📈 Open /live-bets ↗
          </a>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "🔄 Refresh Ticker"}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid #ef4444",
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            color: "#fca5a5",
            fontSize: "12px",
          }}
        >
          ⚠️ Bet-Ticker fetch failed: {error}
        </div>
      )}

      {/* 4 KPI Summary Cards */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>
            Actionable Tickets / Canonical Volume
          </div>
          <div style={styles.kpiVal}>
            {data ? data.localFeed.actionableTicketCount : "—"} tix ·{" "}
            {data ? formatUsd(data.localFeed.totalVolumeCents) : "—"}
          </div>
          <div style={styles.kpiSub}>
            Raw Wagered:{" "}
            {data ? formatUsd(data.localFeed.totalWageredCents) : "—"} ·
            Volume≠Stake: {data?.localFeed.volumeDiffersCount ?? 0} · VIP:{" "}
            {data?.localFeed.vipCount ?? 0}
          </div>
        </div>

        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Sentinel ALERT Mirror Twins</div>
          <div style={{ ...styles.kpiVal, color: "#fbbf24" }}>
            {data?.localFeed.sentinelNoiseCount ?? 0} excluded
          </div>
          <div style={styles.kpiSub}>
            $0 canonical volume (prevented{" "}
            {data ? data.localFeed.rawRowCount : 0}-row double-counting)
          </div>
        </div>

        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Pending Slate (Report/Pending)</div>
          <div style={{ ...styles.kpiVal, color: "#38bdf8" }}>
            {pending?.available
              ? `${pending.pendingCount} wagers (${pending.gameCount} rows)`
              : "Unavailable"}
          </div>
          <div style={styles.kpiSub}>
            {pending?.available
              ? `Risk ${formatUsd(pending.totalWageredCents)} · ToWin ${formatUsd(pending.totalToWinCents)}`
              : "No data/live-bets.json capture present"}
          </div>
        </div>

        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>R2 Bridge 3a (f402-bet-ticker)</div>
          <div
            style={{
              ...styles.kpiVal,
              color:
                bridge?.state === "fresh"
                  ? "#4ade80"
                  : bridge?.state === "stale"
                    ? "#f59e0b"
                    : "#f87171",
            }}
          >
            {bridge?.available
              ? `${bridge.state.toUpperCase()} · ${bridge.ticketCount} tix`
              : "UNAVAILABLE"}
          </div>
          <div style={styles.kpiSub}>
            {bridge?.available ? (
              <span>
                Watermark #{bridge.watermark ?? "—"} · {bridge.legCount} legs ·{" "}
                {bridge.alertTwinCount} twins ·{" "}
                <a
                  href={bridge.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#38bdf8" }}
                >
                  latest.json ↗
                </a>
              </span>
            ) : (
              (bridge?.error ?? "R2 Bridge 3a snapshot not reachable")
            )}
          </div>
        </div>
      </div>

      {/* Channel (TicketWriter) & Wager Type Demux Panels */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: "16px",
        }}
      >
        <div style={styles.tableCard}>
          <div style={styles.tableHeader}>
            <h3 style={styles.tableTitle}>
              🛰️ Channel Demux (`TicketWriter`) — Local vs R2 Bridge 3a
            </h3>
            <span style={styles.kpiSub}>Click a channel row to filter</span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th scope="col" style={styles.th}>
                  Channel
                </th>
                <th scope="col" style={styles.th}>
                  Local Tix
                </th>
                <th scope="col" style={styles.th}>
                  Canonical Vol
                </th>
                <th scope="col" style={styles.th}>
                  R2 Bridge 3a
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.localFeed.byWriter ?? []).map((bucket) => {
                const r2Match = bridge?.byChannel?.[bucket.writer];
                const active =
                  writerFilter.toLowerCase() === bucket.writer.toLowerCase();
                return (
                  <tr
                    key={bucket.writer}
                    onClick={() => {
                      if (bucket.isSentinelNoise) {
                        setShowSentinelTwins(true);
                      }
                      setWriterFilter(active ? "ALL" : bucket.writer);
                    }}
                    style={{
                      cursor: "pointer",
                      backgroundColor: active
                        ? "rgba(56, 189, 248, 0.14)"
                        : undefined,
                    }}
                  >
                    <td style={styles.td}>
                      <span
                        style={{
                          fontWeight: 700,
                          color: bucket.isSentinelNoise ? "#fbbf24" : "#f1f5f9",
                        }}
                      >
                        {sanitizeCaptureText(bucket.writer)}
                      </span>
                      {bucket.isSentinelNoise && (
                        <span
                          style={{
                            marginLeft: "6px",
                            fontSize: "10px",
                            color: "#fbbf24",
                          }}
                        >
                          (Sentinel Noise)
                        </span>
                      )}
                    </td>
                    <td style={styles.td}>{bucket.count}</td>
                    <td style={styles.td}>
                      {bucket.isSentinelNoise
                        ? "$0 (excluded)"
                        : formatUsd(bucket.volumeCents)}
                    </td>
                    <td style={styles.td}>
                      {r2Match
                        ? `${r2Match.tickets} tix (${formatUsd(r2Match.volumeCents)})`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={styles.tableCard}>
          <div style={styles.tableHeader}>
            <h3 style={styles.tableTitle}>🎯 Wager Type Demux (`WagerType`)</h3>
            <span style={styles.kpiSub}>Raw codes preserved per contract</span>
          </div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th scope="col" style={styles.th}>
                  Code
                </th>
                <th scope="col" style={styles.th}>
                  Local Tix
                </th>
                <th scope="col" style={styles.th}>
                  Canonical Vol
                </th>
                <th scope="col" style={styles.th}>
                  R2 Bridge 3a
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.localFeed.byWagerType ?? []).map((wt) => {
                const r2Match = bridge?.byWagerType?.[wt.wagerType];
                const active = typeFilter === wt.wagerType;
                return (
                  <tr
                    key={wt.wagerType}
                    onClick={() => setTypeFilter(active ? "ALL" : wt.wagerType)}
                    style={{
                      cursor: "pointer",
                      backgroundColor: active
                        ? "rgba(56, 189, 248, 0.14)"
                        : undefined,
                    }}
                  >
                    <td style={styles.td}>
                      <code style={{ color: "#38bdf8", fontWeight: 700 }}>
                        {wt.wagerType}
                      </code>{" "}
                      <span style={{ color: "#94a3b8", fontSize: "11px" }}>
                        {wt.label}
                      </span>
                    </td>
                    <td style={styles.td}>{wt.count}</td>
                    <td style={styles.td}>{formatUsd(wt.volumeCents)}</td>
                    <td style={styles.td}>
                      {r2Match
                        ? `${r2Match.tickets} tix (${r2Match.legs} legs)`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Filters & Rule Badges */}
      <div style={styles.filterBar}>
        <div style={styles.searchBox}>
          <span style={styles.searchIcon}>🔍</span>
          <input
            style={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ticket #, customer, sub-agent, channel, or team/pick..."
            aria-label="Filter Bet-Ticker rows"
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            style={styles.filterPill(
              writerFilter === "ALL" && typeFilter === "ALL",
            )}
            onClick={() => {
              setWriterFilter("ALL");
              setTypeFilter("ALL");
            }}
          >
            All Channels & Types
          </button>
          <button
            type="button"
            style={styles.filterPill(showSentinelTwins)}
            onClick={() => setShowSentinelTwins((v) => !v)}
          >
            {showSentinelTwins
              ? "Hide ALERT Sentinel Twins"
              : `Show ALERT Twins (${data?.localFeed.sentinelNoiseCount ?? 0})`}
          </button>
          {Object.entries(data?.localFeed.byRule ?? {}).map(([rule, count]) => (
            <span
              key={rule}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                borderRadius: "999px",
                backgroundColor: "rgba(30, 41, 59, 0.9)",
                border: "1px solid #334155",
                color: "#cbd5e1",
              }}
            >
              {rule}: <b>{count}</b>
            </span>
          ))}
        </div>
      </div>

      {/* Live Bet-Ticker Ticket Table */}
      <div style={styles.tableCard}>
        <div style={styles.tableHeader}>
          <h3 style={styles.tableTitle}>
            🎟️ Bet-Ticker Stream
            <span
              data-bet-ticker-count="true"
              style={{
                marginLeft: "8px",
                fontSize: "11px",
                fontWeight: 400,
                color: "#64748b",
              }}
            >
              Showing {visibleTickets.length} of {sortedTickets.length} filtered
              · {data?.localFeed.rawRowCount ?? 0} captured
            </span>
          </h3>
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span style={styles.kpiSub}>
              autoExecute: false · Sentinel `ALERT`/`BLOCKED` stakes excluded
              from book volume
            </span>
            <button
              type="button"
              data-bet-ticker-copy-rows="true"
              onClick={copyRows}
              disabled={sortedTickets.length === 0}
              title={`Copy all ${sortedTickets.length} filtered rows as TSV (the export is not capped by the ${visibleTickets.length}-row page)`}
              style={{
                padding: "4px 9px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                backgroundColor: "rgba(34, 197, 94, 0.12)",
                border: "1px solid rgba(34, 197, 94, 0.38)",
                color: sortedTickets.length === 0 ? "#475569" : "#4ade80",
                cursor: sortedTickets.length === 0 ? "default" : "pointer",
              }}
            >
              {copyState === "copied"
                ? "✓ Copied"
                : copyState === "failed"
                  ? "⚠ Copy blocked"
                  : `⧉ Copy rows (${sortedTickets.length})`}
            </button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th
                  scope="col"
                  style={styles.th}
                  aria-sort={ariaSort("ticket")}
                >
                  <button
                    type="button"
                    data-bet-ticker-sort="ticket"
                    onClick={() => handleSort("ticket")}
                    style={SORT_BUTTON}
                    title="Sort by ticket number"
                  >
                    Ticket{sortIndicator("ticket")}
                  </button>
                </th>
                <th
                  scope="col"
                  style={styles.th}
                  title="Channel family from the captured TicketWriter"
                >
                  Channel
                </th>
                <th
                  scope="col"
                  style={styles.th}
                  title="Wager type code and label from the ticket"
                >
                  Type
                </th>
                <th scope="col" style={styles.th}>
                  Customer
                </th>
                <th scope="col" style={styles.th}>
                  Sub-Agent
                </th>
                <th
                  scope="col"
                  style={styles.th}
                  title="Sport and leg count from the captured ticket"
                >
                  Sport
                </th>
                <th
                  scope="col"
                  style={styles.th}
                  title="Pick, line and price for the ticket"
                >
                  Selection
                </th>
                <th
                  scope="col"
                  style={styles.th}
                  aria-sort={ariaSort("wagered")}
                >
                  <button
                    type="button"
                    data-bet-ticker-sort="wagered"
                    onClick={() => handleSort("wagered")}
                    style={SORT_BUTTON}
                    title="Sort by amount wagered"
                  >
                    Wagered → Vol{sortIndicator("wagered")}
                  </button>
                </th>
                <th scope="col" style={styles.th} aria-sort={ariaSort("toWin")}>
                  <button
                    type="button"
                    data-bet-ticker-sort="toWin"
                    onClick={() => handleSort("toWin")}
                    style={SORT_BUTTON}
                    title="Sort by amount to win"
                  >
                    To Win{sortIndicator("toWin")}
                  </button>
                </th>
                <th scope="col" style={styles.th}>
                  Flags / Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#94a3b8",
                      padding: "24px",
                    }}
                  >
                    No Bet-Ticker rows match the active filter.
                  </td>
                </tr>
              ) : (
                visibleTickets.map((t) => (
                  <tr key={`${t.ticketId}-${t.ticketWriter}`}>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 700, fontFamily: "monospace" }}>
                        #{t.ticketId}
                      </div>
                      <div style={styles.custSub}>{t.insertedAt ?? "—"}</div>
                    </td>
                    <td style={styles.td} data-bet-ticker-channel={t.ticketId}>
                      <span
                        style={{
                          padding: "2px 6px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          fontWeight: 700,
                          backgroundColor: t.isSentinelNoise
                            ? "rgba(245, 158, 11, 0.16)"
                            : "rgba(56, 189, 248, 0.15)",
                          color: t.isSentinelNoise ? "#fbbf24" : "#38bdf8",
                        }}
                      >
                        {sanitizeCaptureText(t.ticketWriter)}
                      </span>
                      {t.live && (
                        <span
                          style={{
                            marginLeft: "4px",
                            fontSize: "10px",
                            color: "#f87171",
                            fontWeight: 700,
                          }}
                        >
                          LIVE
                        </span>
                      )}
                    </td>
                    <td style={styles.td} data-bet-ticker-type={t.ticketId}>
                      <code style={{ fontSize: "11px", color: "#cbd5e1" }}>
                        {t.wagerType}
                      </code>
                      <div style={styles.custSub}>{t.wagerTypeLabel}</div>
                    </td>
                    <td style={styles.td}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <a
                          href={getLocalCustomerHref(t.customerId)}
                          onClick={(e) => {
                            if (!e.metaKey && !e.ctrlKey && e.button === 0) {
                              e.preventDefault();
                              onSelectCustomerById(t.customerId);
                            }
                          }}
                          style={{ ...styles.custLink, textDecoration: "none" }}
                          title="Inspect Customer Profile"
                        >
                          {t.customerId}
                        </a>
                        <a
                          href={`https://fantasy402.com/manager.html?customer=${encodeURIComponent(t.customerId)}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            color: "#64748b",
                            textDecoration: "none",
                            fontSize: "11px",
                          }}
                          title="External Fantasy402 Portal (requires portal login)"
                        >
                          ↗
                        </a>
                      </div>
                    </td>
                    <td style={styles.td}>
                      <a
                        href={getLocalAgentHref(t.agentId)}
                        onClick={(e) => {
                          if (!e.metaKey && !e.ctrlKey && e.button === 0) {
                            e.preventDefault();
                            onSelectAgent(t.agentId);
                          }
                        }}
                        style={{
                          color: "#38bdf8",
                          fontWeight: 600,
                          textDecoration: "none",
                        }}
                        title="Open SportsDesk Agent Inspector"
                      >
                        {t.agentId}
                      </a>
                      <div style={styles.custSub}>M: {t.masterAgent}</div>
                    </td>
                    <td style={styles.td} data-bet-ticker-sport={t.ticketId}>
                      <div style={{ fontWeight: 600 }}>{t.sport || "—"}</div>
                      <div style={styles.custSub}>{t.legCount}L</div>
                    </td>
                    <td
                      style={styles.td}
                      data-bet-ticker-selection={t.ticketId}
                    >
                      <div style={styles.custSub}>
                        {sanitizeCaptureText(t.selection)}
                      </div>
                    </td>
                    <td style={styles.td}>
                      <div>{formatUsd(t.amountWageredCents)}</div>
                      {t.volumeDiffers && (
                        <div style={{ fontSize: "11px", color: "#fbbf24" }}>
                          Vol: {formatUsd(t.volumeAmountCents)}
                        </div>
                      )}
                    </td>
                    <td style={styles.td}>{formatUsd(t.toWinAmountCents)}</td>
                    <td style={styles.td}>
                      <div
                        style={{
                          display: "flex",
                          gap: "4px",
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        {t.alertFlags.map((flag) => (
                          <span
                            key={flag}
                            style={{
                              fontSize: "10px",
                              padding: "1px 5px",
                              borderRadius: "4px",
                              backgroundColor:
                                flag === "ALERT_SENTINEL_TWIN"
                                  ? "rgba(245, 158, 11, 0.2)"
                                  : "rgba(239, 68, 68, 0.16)",
                              color:
                                flag === "ALERT_SENTINEL_TWIN"
                                  ? "#fbbf24"
                                  : "#fca5a5",
                            }}
                          >
                            {flag}
                          </span>
                        ))}
                        <button
                          type="button"
                          style={{
                            ...styles.actionBtn,
                            padding: "2px 6px",
                            fontSize: "11px",
                          }}
                          onClick={() => onInspectPty(t.customerId)}
                        >
                          💻 PTY
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {sortedTickets.length > BET_TICKER_RENDER_LIMIT || showAll ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
              padding: "8px 14px",
              borderTop: "1px solid #1e293b",
              fontSize: "11px",
              color: "#94a3b8",
            }}
          >
            <span>
              Rendered {visibleTickets.length} of {sortedTickets.length}{" "}
              filtered rows
              {showAll ? " (all)" : ` (page limit ${BET_TICKER_RENDER_LIMIT})`}
            </span>
            <button
              type="button"
              data-bet-ticker-show-all={showAll ? "collapse" : "expand"}
              onClick={() => setShowAll((prev) => !prev)}
              style={{
                ...styles.actionBtn,
                padding: "3px 9px",
                fontSize: "11px",
              }}
            >
              {showAll
                ? `Collapse to first ${BET_TICKER_RENDER_LIMIT} rows`
                : `Show all ${sortedTickets.length} rows`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
