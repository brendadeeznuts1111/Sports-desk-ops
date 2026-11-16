/**
 * @file packages/ui/src/gslive_game_log.ts
 * @description GSLIVE game log (one row per game) and event log (one row per ticket),
 * derived only from the wager rows the dashboard already holds.
 *
 * The feed gives a wall-clock string (`7:45:03 PM ET`) and no epoch, so ordering is parsed
 * from that string; an unparseable stamp is kept but sorts last instead of being guessed.
 */

import { wagerChannelOf } from "@sportsdesk-ops/contracts";
import type { LiveWager } from "./types.ts";

const GSLIVE = "gslive";

export function isGsliveWager(w: LiveWager): boolean {
  return (w.writer ?? wagerChannelOf(w.ticketWriter)) === GSLIVE;
}

/** `"HOCKEY · Philadelphia Flyers vs Edmonton Oilers"` — sport + event, the game identity. */
export function gameKeyOf(w: LiveWager): string {
  return `${w.sport.toUpperCase()} · ${w.event}`;
}

/** `"7:45:03 PM ET"` or `"14:32:01 ET"` → seconds since midnight; null when unparseable. */
export function parseDeskClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(
    value.trim(),
  );
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  const meridiem = match[4]?.toUpperCase();
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  if (minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function clockLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface GsliveGameRow {
  /** `SPORT · event`; also the filter key when a game row is selected. */
  readonly gameKey: string;
  readonly sport: string;
  readonly event: string;
  readonly tickets: number;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly avgRiskUsd: number;
  readonly betTypes: readonly string[];
  readonly liveTickets: number;
  /** Earliest/latest parsed clock label (`HH:MM`), null when no stamp parsed. */
  readonly firstSeenEt: string | null;
  readonly lastSeenEt: string | null;
  /** Mean CLV over tickets that actually carried a closing line; null when none did. */
  readonly avgClvCents: number | null;
  /** Best closing-line edge on any ticket in the game; null when none carried one. */
  readonly maxClvCents: number | null;
  /** Largest single ticket stake in the game. */
  readonly biggestTicketRiskUsd: number;
  /** Distinct customers with a ticket in the game. */
  readonly uniqueCustomers: number;
  /** Share of the game's risk held by its three largest customers (0–100, one decimal). */
  readonly top3CustomerSharePct: number;
  /** Busiest 60-second window: how many tickets landed inside it. */
  readonly maxTicketsIn60s: number;
  /** Alert mix, so a game row says *why* it is risky, not only how much. */
  readonly alertCounts: {
    readonly critical: number;
    readonly steam: number;
    readonly latency: number;
    readonly recreational: number;
  };
  readonly topCustomerId: string | null;
  readonly topCustomerRiskUsd: number;
}

interface GameAccumulator {
  readonly gameKey: string;
  readonly sport: string;
  readonly event: string;
  tickets: number;
  riskUsd: number;
  toWinUsd: number;
  liveTickets: number;
  readonly betTypes: Set<string>;
  firstSeen: number | null;
  lastSeen: number | null;
  clvSum: number;
  clvCount: number;
  maxClv: number | null;
  biggestTicketRisk: number;
  readonly times: number[];
  readonly alertCounts: {
    critical: number;
    steam: number;
    latency: number;
    recreational: number;
  };
  readonly riskByCustomer: Map<string, number>;
}

function addToGame(
  games: Map<string, GameAccumulator>,
  w: LiveWager,
  seconds: number | null,
): void {
  const key = gameKeyOf(w);
  let game = games.get(key);
  if (game === undefined) {
    game = {
      gameKey: key,
      sport: w.sport.toUpperCase(),
      event: w.event,
      tickets: 0,
      riskUsd: 0,
      toWinUsd: 0,
      liveTickets: 0,
      betTypes: new Set<string>(),
      firstSeen: null,
      lastSeen: null,
      clvSum: 0,
      clvCount: 0,
      maxClv: null,
      biggestTicketRisk: 0,
      times: [],
      alertCounts: { critical: 0, steam: 0, latency: 0, recreational: 0 },
      riskByCustomer: new Map<string, number>(),
    };
    games.set(key, game);
  }
  game.tickets += 1;
  game.riskUsd += w.riskUsd;
  game.toWinUsd += w.toWinUsd;
  if (w.alertTier === "LATENCY" || /in-play|live|halftime/i.test(w.selection)) {
    game.liveTickets += 1;
  }
  if (w.betType) game.betTypes.add(w.betType);
  if (seconds !== null) {
    game.firstSeen =
      game.firstSeen === null ? seconds : Math.min(game.firstSeen, seconds);
    game.lastSeen =
      game.lastSeen === null ? seconds : Math.max(game.lastSeen, seconds);
  }
  if (w.clvCents !== null) {
    game.clvSum += w.clvCents;
    game.clvCount += 1;
    game.maxClv =
      game.maxClv === null ? w.clvCents : Math.max(game.maxClv, w.clvCents);
  }
  if (w.riskUsd > game.biggestTicketRisk) game.biggestTicketRisk = w.riskUsd;
  if (seconds !== null) game.times.push(seconds);
  if (w.alertTier === "CRITICAL") game.alertCounts.critical += 1;
  else if (w.alertTier === "STEAM") game.alertCounts.steam += 1;
  else if (w.alertTier === "LATENCY") game.alertCounts.latency += 1;
  else game.alertCounts.recreational += 1;
  game.riskByCustomer.set(
    w.customerId,
    (game.riskByCustomer.get(w.customerId) ?? 0) + w.riskUsd,
  );
}

function top3Share(
  riskByCustomer: ReadonlyMap<string, number>,
  totalRiskUsd: number,
): number {
  if (totalRiskUsd <= 0 || riskByCustomer.size === 0) return 0;
  const top = [...riskByCustomer.values()]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((acc, value) => acc + value, 0);
  return Math.round((top / totalRiskUsd) * 1000) / 10;
}

/** Busiest `windowSeconds` window, counted over parsed clock stamps only. */
export function maxTicketsInWindow(
  times: readonly number[],
  windowSeconds: number,
): number {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while (sorted[end]! - sorted[start]! > windowSeconds) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** One row per GSLIVE game, riskiest first. */
export function buildGsliveGameLog(
  wagers: readonly LiveWager[],
): GsliveGameRow[] {
  const games = new Map<string, GameAccumulator>();
  for (const w of wagers) {
    if (!isGsliveWager(w)) continue;
    addToGame(games, w, parseDeskClock(w.timestamp));
  }
  return [...games.values()]
    .map((game) => {
      let topCustomerId: string | null = null;
      let topCustomerRiskUsd = 0;
      for (const [id, risk] of game.riskByCustomer) {
        if (risk > topCustomerRiskUsd) {
          topCustomerId = id;
          topCustomerRiskUsd = risk;
        }
      }
      return {
        gameKey: game.gameKey,
        sport: game.sport,
        event: game.event,
        tickets: game.tickets,
        riskUsd: Math.round(game.riskUsd),
        toWinUsd: Math.round(game.toWinUsd),
        avgRiskUsd: Math.round(game.riskUsd / game.tickets),
        betTypes: [...game.betTypes].sort(),
        liveTickets: game.liveTickets,
        firstSeenEt: clockLabel(game.firstSeen),
        lastSeenEt: clockLabel(game.lastSeen),
        avgClvCents:
          game.clvCount > 0
            ? Math.round((game.clvSum / game.clvCount) * 100) / 100
            : null,
        maxClvCents:
          game.maxClv === null ? null : Math.round(game.maxClv * 100) / 100,
        biggestTicketRiskUsd: Math.round(game.biggestTicketRisk),
        uniqueCustomers: game.riskByCustomer.size,
        top3CustomerSharePct: top3Share(game.riskByCustomer, game.riskUsd),
        maxTicketsIn60s: maxTicketsInWindow(game.times, 60),
        alertCounts: { ...game.alertCounts },
        topCustomerId,
        topCustomerRiskUsd: Math.round(topCustomerRiskUsd),
      };
    })
    .sort(
      (a, b) =>
        b.riskUsd - a.riskUsd ||
        b.tickets - a.tickets ||
        a.event.localeCompare(b.event),
    );
}

export interface GsliveEventRow {
  readonly ticketId: string;
  readonly timestamp: string;
  readonly clockSeconds: number | null;
  readonly customerId: string;
  readonly gameKey: string;
  readonly sport: string;
  readonly event: string;
  readonly betType: string;
  readonly selection: string;
  readonly lineDisplay: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly clvCents: number | null;
  readonly alertTier: string;
}

/** GSLIVE tickets, newest first; pass a `gameKey` to scope the log to one game. */
export function buildGsliveEventLog(
  wagers: readonly LiveWager[],
  gameKey: string | null = null,
): GsliveEventRow[] {
  const rows: GsliveEventRow[] = [];
  for (const w of wagers) {
    if (!isGsliveWager(w)) continue;
    const key = gameKeyOf(w);
    if (gameKey !== null && key !== gameKey) continue;
    rows.push({
      ticketId: w.ticketId,
      timestamp: w.timestamp,
      clockSeconds: parseDeskClock(w.timestamp),
      customerId: w.customerId,
      gameKey: key,
      sport: w.sport.toUpperCase(),
      event: w.event,
      betType: w.betType,
      selection: w.selection,
      lineDisplay: w.lineDisplay,
      riskUsd: Math.round(w.riskUsd),
      toWinUsd: Math.round(w.toWinUsd),
      clvCents: w.clvCents,
      alertTier: w.alertTier,
    });
  }
  return rows.sort((a, b) => {
    if (a.clockSeconds === null || b.clockSeconds === null) {
      if (a.clockSeconds === b.clockSeconds) {
        return a.ticketId.localeCompare(b.ticketId);
      }
      return a.clockSeconds === null ? 1 : -1;
    }
    return b.clockSeconds - a.clockSeconds;
  });
}

export type GsliveGameSortKey = "risk" | "tickets" | "avg" | "clv" | "window";

/** Sort a copy of the game log; unknown CLV/window values sort last in both directions. */
export function sortGsliveGames(
  games: readonly GsliveGameRow[],
  key: GsliveGameSortKey,
  dir: 1 | -1,
): GsliveGameRow[] {
  const nullLast = (
    a: number | string | null,
    b: number | string | null,
  ): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return 0;
  };
  return [...games].sort((a, b) => {
    switch (key) {
      case "risk":
        return (a.riskUsd - b.riskUsd) * dir;
      case "tickets":
        return (a.tickets - b.tickets) * dir;
      case "avg":
        return (a.avgRiskUsd - b.avgRiskUsd) * dir;
      case "clv": {
        const tie = nullLast(a.avgClvCents, b.avgClvCents);
        if (tie !== 0) return tie;
        return ((a.avgClvCents ?? 0) - (b.avgClvCents ?? 0)) * dir;
      }
      case "window": {
        const tie = nullLast(a.lastSeenEt, b.lastSeenEt);
        if (tie !== 0) return tie;
        return (
          String(a.lastSeenEt ?? "").localeCompare(String(b.lastSeenEt ?? "")) *
          dir
        );
      }
    }
  });
}

export type GsliveEventFilter = "all" | "alerts" | "clv";

/** Event-log filter; `clv` means a real closing line at or above the steam threshold. */
export function filterGsliveEvents(
  events: readonly GsliveEventRow[],
  filter: GsliveEventFilter,
  clvThresholdCents = 5,
): GsliveEventRow[] {
  switch (filter) {
    case "all":
      return [...events];
    case "alerts":
      return events.filter((event) => event.alertTier !== "RECREATIONAL");
    case "clv":
      return events.filter(
        (event) =>
          event.clvCents !== null && event.clvCents >= clvThresholdCents,
      );
  }
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Game log as CSV, using the same rows the table renders. */
export function gsliveGameLogCsv(games: readonly GsliveGameRow[]): string {
  const header = [
    "sport",
    "event",
    "tickets",
    "risk_usd",
    "to_win_usd",
    "avg_risk_usd",
    "avg_clv_cents",
    "max_clv_cents",
    "unique_customers",
    "top3_share_pct",
    "max_tickets_60s",
    "first_seen_et",
    "last_seen_et",
    "critical",
    "steam",
    "latency",
    "recreational",
    "top_customer",
    "top_customer_risk_usd",
  ];
  const rows = games.map((game) => [
    game.sport,
    game.event,
    game.tickets,
    game.riskUsd,
    game.toWinUsd,
    game.avgRiskUsd,
    game.avgClvCents,
    game.maxClvCents,
    game.uniqueCustomers,
    game.top3CustomerSharePct,
    game.maxTicketsIn60s,
    game.firstSeenEt,
    game.lastSeenEt,
    game.alertCounts.critical,
    game.alertCounts.steam,
    game.alertCounts.latency,
    game.alertCounts.recreational,
    game.topCustomerId,
    game.topCustomerRiskUsd,
  ]);
  return (
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n"
  );
}

/** Event log as CSV (newest first, exactly as displayed). */
export function gsliveEventLogCsv(events: readonly GsliveEventRow[]): string {
  const header = [
    "timestamp",
    "ticket_id",
    "customer_id",
    "sport",
    "event",
    "bet_type",
    "selection",
    "line_display",
    "risk_usd",
    "to_win_usd",
    "clv_cents",
    "alert_tier",
  ];
  const rows = events.map((event) => [
    event.timestamp,
    event.ticketId,
    event.customerId,
    event.sport,
    event.event,
    event.betType,
    event.selection,
    event.lineDisplay,
    event.riskUsd,
    event.toWinUsd,
    event.clvCents,
    event.alertTier,
  ]);
  return (
    [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n"
  );
}
