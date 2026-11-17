/**
 * @file packages/ui/src/panels/GsliveGameLogSection.tsx
 * @description GSLIVE drill-down: a sortable game log (one row per game) beside an event
 * log (the latest GSLIVE tickets). Selecting a game scopes the event log and the wager
 * table; selecting an event opens that ticket in the wager inspector.
 */

import type React from "react";
import { sanitizeCaptureText } from "../capture_text.ts";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import {
  filterGsliveEvents,
  gsliveEventLogCsv,
  gsliveGameLogCsv,
  sortGsliveGames,
  type GsliveEventFilter,
  type GsliveEventRow,
  type GsliveGameRow,
  type GsliveGameSortKey,
} from "../gslive_game_log.ts";

export interface GsliveGameLogSectionProps {
  readonly games: readonly GsliveGameRow[];
  readonly events: readonly GsliveEventRow[];
  readonly selectedGame: string | null;
  readonly onSelectGame: (gameKey: string | null) => void;
  /** Opens the matching wager in the ticket inspector. */
  readonly onSelectEvent?: ((ticketId: string) => void) | undefined;
  /** Latest events to list before the "show all" toggle; a drill-down, not a table. */
  readonly maxEvents?: number;
  /** Epoch ms of the last successful wager fetch, for the stream status line. */
  readonly lastUpdatedAt?: number | null | undefined;
  /** Ticket ids that arrived in the latest refresh; highlighted until they age out. */
  readonly newTicketIds?: ReadonlySet<string> | undefined;
  /** WebSocket state; false means the feed is on the polling fallback. */
  readonly connected?: boolean | undefined;
}

const CELL: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid rgba(148, 163, 184, 0.12)",
  whiteSpace: "nowrap",
  fontSize: "11px",
};

const NUM: React.CSSProperties = { ...CELL, textAlign: "right" };

const SORT_HEADERS: readonly {
  readonly key: GsliveGameSortKey;
  readonly label: string;
}[] = [
  { key: "tickets", label: "Tix" },
  { key: "risk", label: "Risk" },
  { key: "avg", label: "Avg" },
  { key: "clv", label: "CLV" },
  { key: "window", label: "Window" },
];

const EVENT_FILTERS: readonly {
  readonly id: GsliveEventFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "alerts", label: "Alerts" },
  { id: "clv", label: "CLV ≥5¢" },
];

function formatMoney(value: number): string {
  return `$${value.toLocaleString()}`;
}

function alertSummary(counts: GsliveGameRow["alertCounts"]): string {
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(`🚨${counts.critical}`);
  if (counts.steam > 0) parts.push(`⚡${counts.steam}`);
  if (counts.latency > 0) parts.push(`⚠️${counts.latency}`);
  return parts.length > 0 ? parts.join(" ") : "✅ no alerts";
}

function tierDot(tier: string): string {
  if (tier === "CRITICAL") return "🚨";
  if (tier === "STEAM") return "⚡";
  if (tier === "LATENCY") return "⚠️";
  return "·";
}

export function GsliveGameLogSection({
  games,
  events,
  selectedGame,
  onSelectGame,
  onSelectEvent,
  maxEvents = 10,
  lastUpdatedAt = null,
  newTicketIds,
  connected,
}: GsliveGameLogSectionProps): React.ReactElement {
  const [sortKey, setSortKey] = useState<GsliveGameSortKey>("risk");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [eventFilter, setEventFilter] = useState<GsliveEventFilter>("all");
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [copyState, setCopyState] = useState<"game" | "events" | null>(null);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<{
    readonly games: readonly GsliveGameRow[];
    readonly events: readonly GsliveEventRow[];
  } | null>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const seenTicketIdsRef = useRef<Set<string>>(new Set());

  // Count tickets that arrived while the log was paused; the pause snapshot is what the
  // operator keeps reading, so arrivals are reported, not interleaved.
  useEffect(() => {
    const nextIds = new Set(events.map((event) => event.ticketId));
    if (paused) {
      let added = 0;
      for (const id of nextIds) {
        if (!seenTicketIdsRef.current.has(id)) added += 1;
      }
      if (added > 0) setPendingNew((count) => count + added);
    }
    seenTicketIdsRef.current = nextIds;
  }, [events, paused]);

  const displayGames = paused && frozen !== null ? frozen.games : games;
  const displayEvents = paused && frozen !== null ? frozen.events : events;

  const selected =
    displayGames.find((game) => game.gameKey === selectedGame) ?? null;
  const sortedGames = sortGsliveGames(displayGames, sortKey, sortDir);
  const filteredEvents = filterGsliveEvents(displayEvents, eventFilter);
  const cap = selectedGame === null ? maxEvents : maxEvents * 2;
  const visibleEvents = showAllEvents
    ? filteredEvents
    : filteredEvents.slice(0, cap);

  const scopeTickets = displayGames.reduce(
    (acc, game) => acc + game.tickets,
    0,
  );
  const scopeRisk = displayGames.reduce((acc, game) => acc + game.riskUsd, 0);
  const scopeAlerts = displayGames.reduce(
    (acc, game) =>
      acc +
      game.alertCounts.critical +
      game.alertCounts.steam +
      game.alertCounts.latency,
    0,
  );

  const ageSeconds =
    lastUpdatedAt === null
      ? null
      : Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000));

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
      setPendingNew(0);
      return;
    }
    setPaused(true);
    setFrozen({ games, events });
    setPendingNew(0);
  };

  const flashCopy = (kind: "game" | "events") => {
    setCopyState(kind);
    setTimeout(() => {
      setCopyState((prev) => (prev === kind ? null : prev));
    }, 1500);
  };

  const copyGames = () => {
    void copyText(gsliveGameLogCsv(sortedGames)).then((result) => {
      if (result.ok) flashCopy("game");
    });
  };

  const copyEvents = () => {
    void copyText(gsliveEventLogCsv(filteredEvents)).then((result) => {
      if (result.ok) flashCopy("events");
    });
  };

  const toggleSort = (key: GsliveGameSortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
      return;
    }
    setSortKey(key);
    setSortDir(key === "window" ? 1 : -1);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)",
        gap: "10px",
        padding: "0 14px 10px",
      }}
    >
      <div
        data-gslive-game-log="true"
        style={{
          border: "1px solid rgba(56, 189, 248, 0.25)",
          borderRadius: "8px",
          backgroundColor: "rgba(15, 23, 42, 0.75)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "8px",
            padding: "8px 10px 6px",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: "12px", color: "#e2e8f0" }}>
            🎮 GSLIVE Game Log
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "10px",
              color: "#94a3b8",
            }}
          >
            <span
              data-gslive-stream={
                paused ? "paused" : connected === false ? "fallback" : "live"
              }
              style={{
                color: paused
                  ? "#f59e0b"
                  : connected === false
                    ? "#94a3b8"
                    : "#4ade80",
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {paused
                ? "⏸ paused"
                : connected === false
                  ? "◌ polling"
                  : "● live"}
              {ageSeconds !== null ? ` · ${ageSeconds}s ago` : ""}
              {paused && pendingNew > 0 ? ` · ${pendingNew} new` : ""}
            </span>
            <button
              type="button"
              data-gslive-pause="true"
              onClick={togglePause}
              title={
                paused
                  ? "Resume streaming into the GSLIVE logs"
                  : "Pause the GSLIVE logs and keep reading the current snapshot"
              }
              style={{
                background: "none",
                border: "1px solid rgba(148, 163, 184, 0.35)",
                borderRadius: "4px",
                color: paused ? "#f59e0b" : "#94a3b8",
                fontSize: "9px",
                fontWeight: 700,
                padding: "1px 6px",
                cursor: "pointer",
              }}
            >
              {paused ? "▶ Resume" : "⏸ Pause"}
            </button>
            <span>
              {displayGames.length} game
              {displayGames.length === 1 ? "" : "s"} · {scopeTickets} tickets ·{" "}
              {formatMoney(scopeRisk)} risk · {scopeAlerts} alerts
              {selected !== null ? ` · scoped: ${selected.event}` : ""}
            </span>
            <button
              type="button"
              data-gslive-copy="games"
              onClick={copyGames}
              title="Copy the game log as CSV"
              style={{
                background: "none",
                border: "1px solid rgba(56, 189, 248, 0.35)",
                borderRadius: "4px",
                color: copyState === "game" ? "#4ade80" : "#7dd3fc",
                fontSize: "9px",
                fontWeight: 700,
                padding: "1px 6px",
                cursor: "pointer",
              }}
            >
              {copyState === "game" ? "✓ CSV" : "⧉ CSV"}
            </button>
          </span>
        </div>
        {displayGames.length === 0 ? (
          <div style={{ padding: "10px", fontSize: "11px", color: "#94a3b8" }}>
            No GSLIVE tickets in this capture.
          </div>
        ) : (
          <div style={{ maxHeight: "240px", overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th
                    style={{
                      ...CELL,
                      position: "sticky",
                      top: 0,
                      backgroundColor: "#0b1222",
                      color: "#94a3b8",
                      textAlign: "left",
                      fontSize: "10px",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Game
                  </th>
                  {SORT_HEADERS.map((header) => {
                    const active = sortKey === header.key;
                    return (
                      <th
                        key={header.key}
                        onClick={() => toggleSort(header.key)}
                        title={`Sort by ${header.label}`}
                        style={{
                          ...NUM,
                          position: "sticky",
                          top: 0,
                          backgroundColor: "#0b1222",
                          color: active ? "#7dd3fc" : "#94a3b8",
                          cursor: "pointer",
                          textAlign: "right",
                          fontSize: "10px",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          userSelect: "none",
                        }}
                      >
                        {header.label}
                        {active ? (sortDir === 1 ? " ▲" : " ▼") : ""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedGames.map((game) => {
                  const isSelected = game.gameKey === selectedGame;
                  return (
                    <tr
                      key={game.gameKey}
                      data-gslive-game={game.gameKey}
                      onClick={() =>
                        onSelectGame(isSelected ? null : game.gameKey)
                      }
                      style={{
                        cursor: "pointer",
                        backgroundColor: isSelected
                          ? "rgba(56, 189, 248, 0.14)"
                          : undefined,
                      }}
                      title={`${game.gameKey} · ${game.tickets} ticket(s) · ${alertSummary(game.alertCounts)}`}
                    >
                      <td
                        style={{
                          ...CELL,
                          whiteSpace: "normal",
                          minWidth: "180px",
                        }}
                      >
                        <div style={{ color: "#e2e8f0", fontWeight: 600 }}>
                          {game.event}
                        </div>
                        <div style={{ color: "#64748b", fontSize: "10px" }}>
                          {game.sport} · {game.betTypes.join(" / ") || "—"} ·{" "}
                          {alertSummary(game.alertCounts)} ·{" "}
                          {game.uniqueCustomers} cust · top3{" "}
                          {game.top3CustomerSharePct}% · 🌀
                          {game.maxTicketsIn60s}/60s
                          {game.topCustomerId !== null
                            ? ` · top ${game.topCustomerId} ${formatMoney(game.topCustomerRiskUsd)}`
                            : ""}
                        </div>
                      </td>
                      <td style={NUM}>{game.tickets}</td>
                      <td style={NUM}>{formatMoney(game.riskUsd)}</td>
                      <td style={NUM}>{formatMoney(game.avgRiskUsd)}</td>
                      <td style={NUM}>
                        {game.avgClvCents === null ? (
                          "—"
                        ) : (
                          <>
                            <div>
                              {game.avgClvCents > 0 ? "+" : ""}
                              {game.avgClvCents.toFixed(1)}¢
                            </div>
                            <div
                              style={{ color: "#64748b", fontSize: "10px" }}
                              title="Best closing-line edge on a single ticket"
                            >
                              max{" "}
                              {game.maxClvCents === null
                                ? "—"
                                : `${game.maxClvCents > 0 ? "+" : ""}${game.maxClvCents.toFixed(1)}¢`}
                            </div>
                          </>
                        )}
                      </td>
                      <td style={NUM}>
                        {game.firstSeenEt === null
                          ? "—"
                          : `${game.firstSeenEt}–${game.lastSeenEt ?? game.firstSeenEt}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div
        data-gslive-event-log="true"
        style={{
          border: "1px solid rgba(148, 163, 184, 0.25)",
          borderRadius: "8px",
          backgroundColor: "rgba(15, 23, 42, 0.75)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: "6px",
            padding: "8px 10px 6px",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: "12px", color: "#e2e8f0" }}>
            🗒️ GSLIVE Event Log
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            {EVENT_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                data-gslive-event-filter={filter.id}
                onClick={() => setEventFilter(filter.id)}
                style={{
                  padding: "1px 7px",
                  borderRadius: "999px",
                  fontSize: "10px",
                  fontWeight: 600,
                  cursor: "pointer",
                  border:
                    eventFilter === filter.id
                      ? "1px solid rgba(56, 189, 248, 0.55)"
                      : "1px solid rgba(148, 163, 184, 0.25)",
                  backgroundColor:
                    eventFilter === filter.id
                      ? "rgba(56, 189, 248, 0.16)"
                      : "transparent",
                  color: eventFilter === filter.id ? "#7dd3fc" : "#94a3b8",
                }}
              >
                {filter.label}
              </button>
            ))}
            <button
              type="button"
              data-gslive-copy="events"
              onClick={copyEvents}
              title="Copy the filtered event log as CSV"
              style={{
                background: "none",
                border: "1px solid rgba(56, 189, 248, 0.35)",
                borderRadius: "4px",
                color: copyState === "events" ? "#4ade80" : "#7dd3fc",
                fontSize: "9px",
                fontWeight: 700,
                padding: "1px 6px",
                cursor: "pointer",
              }}
            >
              {copyState === "events" ? "✓ CSV" : "⧉ CSV"}
            </button>
            {selected !== null ? (
              <button
                type="button"
                onClick={() => onSelectGame(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#38bdf8",
                  fontSize: "10px",
                  cursor: "pointer",
                  padding: 0,
                  marginLeft: "4px",
                }}
                title="Clear the game scope"
              >
                {selected.event} ✕
              </button>
            ) : null}
          </span>
        </div>
        {visibleEvents.length === 0 ? (
          <div style={{ padding: "10px", fontSize: "11px", color: "#94a3b8" }}>
            {events.length === 0
              ? "No GSLIVE events for this scope."
              : `No events match the ${eventFilter} filter.`}
          </div>
        ) : (
          <div style={{ maxHeight: "240px", overflowY: "auto" }}>
            {visibleEvents.map((event) =>
              onSelectEvent === undefined ? (
                <div
                  key={event.ticketId}
                  data-gslive-event={event.ticketId}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "70px minmax(0, 1fr) auto",
                    gap: "8px",
                    alignItems: "baseline",
                    padding: "4px 10px",
                    borderBottom: "1px solid rgba(148, 163, 184, 0.12)",
                    fontSize: "11px",
                    backgroundColor: newTicketIds?.has(event.ticketId)
                      ? "rgba(74, 222, 128, 0.10)"
                      : "transparent",
                  }}
                >
                  <EventTime timestamp={event.timestamp} />
                  <EventSummary
                    event={event}
                    fresh={newTicketIds?.has(event.ticketId) === true}
                  />
                  <EventAmount event={event} />
                </div>
              ) : (
                <button
                  key={event.ticketId}
                  type="button"
                  data-gslive-event={event.ticketId}
                  onClick={() => onSelectEvent(event.ticketId)}
                  title={`Open ${event.ticketId} in the ticket inspector`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "70px minmax(0, 1fr) auto",
                    gap: "8px",
                    alignItems: "baseline",
                    width: "100%",
                    textAlign: "left",
                    font: "inherit",
                    padding: "4px 10px",
                    border: "none",
                    borderBottom: "1px solid rgba(148, 163, 184, 0.12)",
                    backgroundColor: newTicketIds?.has(event.ticketId)
                      ? "rgba(74, 222, 128, 0.10)"
                      : "transparent",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <EventTime timestamp={event.timestamp} />
                  <EventSummary
                    event={event}
                    fresh={newTicketIds?.has(event.ticketId) === true}
                  />
                  <EventAmount event={event} />
                </button>
              ),
            )}
            {!showAllEvents && filteredEvents.length > cap ? (
              <button
                type="button"
                onClick={() => setShowAllEvents(true)}
                style={{
                  width: "100%",
                  padding: "5px",
                  background: "none",
                  border: "none",
                  color: "#38bdf8",
                  fontSize: "10px",
                  cursor: "pointer",
                }}
              >
                Show all {filteredEvents.length} events
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function EventTime({
  timestamp,
}: {
  readonly timestamp: string;
}): React.ReactElement {
  return (
    <span
      style={{
        color: "#94a3b8",
        fontFamily: "ui-monospace",
        whiteSpace: "nowrap",
      }}
    >
      {timestamp.replace(/\s*ET$/, "")}
    </span>
  );
}

function EventSummary({
  event,
  fresh = false,
}: {
  readonly event: GsliveEventRow;
  readonly fresh?: boolean;
}): React.ReactElement {
  return (
    <span
      style={{
        minWidth: 0,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      title={`${event.ticketId} · ${sanitizeCaptureText(event.event)} · ${sanitizeCaptureText(event.selection)} ${sanitizeCaptureText(event.lineDisplay)}`}
    >
      <span style={{ color: "#e2e8f0", fontWeight: 600 }}>
        {tierDot(event.alertTier)} {event.customerId}
      </span>{" "}
      {fresh ? (
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
      ) : null}{" "}
      <span style={{ color: "#cbd5e1" }}>
        {sanitizeCaptureText(event.event)} ·{" "}
        {sanitizeCaptureText(event.selection)}{" "}
        {event.lineDisplay !== event.selection
          ? sanitizeCaptureText(event.lineDisplay)
          : ""}
      </span>
    </span>
  );
}

function EventAmount({
  event,
}: {
  readonly event: GsliveEventRow;
}): React.ReactElement {
  return (
    <span
      style={{
        color: "#94a3b8",
        textAlign: "right",
        whiteSpace: "nowrap",
      }}
    >
      {formatMoney(event.riskUsd)}
      {event.clvCents !== null ? (
        <span
          style={{
            marginLeft: "6px",
            color: event.clvCents > 0 ? "#f87171" : "#4ade80",
          }}
        >
          {event.clvCents > 0 ? "+" : ""}
          {event.clvCents.toFixed(1)}¢
        </span>
      ) : null}
    </span>
  );
}
