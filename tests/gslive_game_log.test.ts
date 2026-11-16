import { describe, expect, test } from "bun:test";
import {
  buildGsliveEventLog,
  buildGsliveGameLog,
  filterGsliveEvents,
  gameKeyOf,
  gsliveEventLogCsv,
  gsliveGameLogCsv,
  isGsliveWager,
  maxTicketsInWindow,
  parseDeskClock,
  sortGsliveGames,
} from "../packages/ui/src/gslive_game_log.ts";
import type { LiveWager } from "../packages/ui/src/types.ts";

function wager(
  overrides: Partial<LiveWager> & { ticketId: string },
): LiveWager {
  return {
    timestamp: "7:45:03 PM ET",
    customerId: "CUST_A",
    agentId: "AG1",
    masterAgent: "MASTER",
    sport: "HOCKEY",
    betType: "Moneyline",
    event: "Flyers vs Oilers",
    selection: "Oilers",
    lineDisplay: "-110",
    oddsAmerican: "-110",
    riskUsd: 1000,
    toWinUsd: 900,
    clvCents: 8.2,
    alertTier: "STEAM",
    alertBadge: "STEAM",
    operatorDirective: "Clamp",
    maxRecommendedStake: 500,
    autoExecute: false,
    ticketWriter: "GSLIVE",
    writer: "gslive",
    ...overrides,
  };
}

describe("parseDeskClock", () => {
  test("parses 12-hour stamps with AM/PM and 24-hour stamps", () => {
    expect(parseDeskClock("7:45:03 PM ET")).toBe(19 * 3600 + 45 * 60 + 3);
    expect(parseDeskClock("12:05:00 AM ET")).toBe(5 * 60);
    expect(parseDeskClock("12:05:00 PM ET")).toBe(12 * 3600 + 5 * 60);
    expect(parseDeskClock("14:32:01 ET")).toBe(14 * 3600 + 32 * 60 + 1);
  });

  test("returns null instead of guessing an unparseable stamp", () => {
    expect(parseDeskClock("just now")).toBeNull();
    expect(parseDeskClock("13:00:00 PM ET")).toBeNull();
    expect(parseDeskClock("7:75 PM")).toBeNull();
  });
});

describe("buildGsliveGameLog", () => {
  const rows: LiveWager[] = [
    wager({
      ticketId: "W-1",
      customerId: "CUST_A",
      riskUsd: 1000,
      timestamp: "7:45:03 PM ET",
    }),
    wager({
      ticketId: "W-2",
      customerId: "CUST_B",
      riskUsd: 3000,
      timestamp: "7:50:00 PM ET",
      betType: "Parlay",
      clvCents: null,
    }),
    wager({
      ticketId: "W-3",
      event: "Rangers vs Bruins",
      customerId: "CUST_C",
      riskUsd: 500,
      timestamp: "6:00:00 PM ET",
    }),
    wager({
      ticketId: "W-4",
      event: "Flyers vs Oilers",
      ticketWriter: "GSBUILDER",
      writer: "gsbuilder",
      riskUsd: 9999,
    }),
  ];

  test("groups GSLIVE tickets per game and excludes other channels", () => {
    const games = buildGsliveGameLog(rows);
    expect(games.map((game) => game.event)).toEqual([
      "Flyers vs Oilers",
      "Rangers vs Bruins",
    ]);
    const flyers = games[0]!;
    expect(flyers.tickets).toBe(2);
    expect(flyers.riskUsd).toBe(4000);
    expect(flyers.toWinUsd).toBe(1800);
    expect(flyers.avgRiskUsd).toBe(2000);
    expect(flyers.betTypes).toEqual(["Moneyline", "Parlay"]);
    expect(flyers.topCustomerId).toBe("CUST_B");
    expect(flyers.topCustomerRiskUsd).toBe(3000);
    expect(flyers.firstSeenEt).toBe("19:45");
    expect(flyers.lastSeenEt).toBe("19:50");
  });

  test("averages CLV only over tickets that carried a closing line", () => {
    const flyers = buildGsliveGameLog(rows)[0]!;
    expect(flyers.avgClvCents).toBe(8.2);
    const noClv = buildGsliveGameLog([
      wager({ ticketId: "W-9", clvCents: null }),
    ])[0]!;
    expect(noClv.avgClvCents).toBeNull();
  });

  test("reports no window when stamps do not parse", () => {
    const [game] = buildGsliveGameLog([
      wager({ ticketId: "W-9", timestamp: "unknown" }),
    ]);
    expect(game?.firstSeenEt).toBeNull();
    expect(game?.lastSeenEt).toBeNull();
  });
});

describe("buildGsliveEventLog", () => {
  const rows: LiveWager[] = [
    wager({ ticketId: "W-1", timestamp: "7:45:03 PM ET" }),
    wager({
      ticketId: "W-2",
      timestamp: "7:50:00 PM ET",
      customerId: "CUST_B",
    }),
    wager({
      ticketId: "W-3",
      event: "Rangers vs Bruins",
      timestamp: "6:00:00 PM ET",
    }),
    wager({ ticketId: "W-4", ticketWriter: "GSBUILDER", writer: "gsbuilder" }),
  ];

  test("returns GSLIVE tickets newest first and ignores other channels", () => {
    const events = buildGsliveEventLog(rows);
    expect(events.map((event) => event.ticketId)).toEqual([
      "W-2",
      "W-1",
      "W-3",
    ]);
  });

  test("scopes to one game by its key", () => {
    const key = gameKeyOf(rows[0]!);
    const events = buildGsliveEventLog(rows, key);
    expect(events.map((event) => event.ticketId)).toEqual(["W-2", "W-1"]);
    expect(events[0]?.gameKey).toBe(key);
  });

  test("classifies an unknown writer as neither GSLIVE nor a Partner 118 row", () => {
    const unknown = wager({
      ticketId: "W-5",
      ticketWriter: "WHATEVER",
      writer: "other",
    });
    expect(isGsliveWager(unknown)).toBe(false);
  });
});

describe("game-log alert mix and edge detail", () => {
  const games = buildGsliveGameLog([
    wager({ ticketId: "W-1", riskUsd: 1000, clvCents: 2, alertTier: "STEAM" }),
    wager({
      ticketId: "W-2",
      riskUsd: 4000,
      clvCents: 12,
      alertTier: "CRITICAL",
    }),
    wager({
      ticketId: "W-3",
      riskUsd: 500,
      clvCents: null,
      alertTier: "LATENCY",
    }),
    wager({
      ticketId: "W-4",
      riskUsd: 250,
      clvCents: 1,
      alertTier: "RECREATIONAL",
    }),
  ]);
  const flyers = games[0]!;

  test("counts alerts by tier and keeps the biggest ticket", () => {
    expect(flyers.alertCounts).toEqual({
      critical: 1,
      steam: 1,
      latency: 1,
      recreational: 1,
    });
    expect(flyers.biggestTicketRiskUsd).toBe(4000);
    expect(flyers.maxClvCents).toBe(12);
  });

  test("keeps max CLV null when no ticket carried a closing line", () => {
    const [bare] = buildGsliveGameLog([
      wager({ ticketId: "W-9", clvCents: null }),
    ]);
    expect(bare?.maxClvCents).toBeNull();
    expect(bare?.avgClvCents).toBeNull();
  });
});

describe("sortGsliveGames / filterGsliveEvents", () => {
  const rows: LiveWager[] = [
    wager({
      ticketId: "W-1",
      event: "A vs B",
      riskUsd: 1000,
      clvCents: 1,
      alertTier: "RECREATIONAL",
    }),
    wager({
      ticketId: "W-2",
      event: "A vs B",
      riskUsd: 4000,
      clvCents: 9,
      alertTier: "RECREATIONAL",
    }),
    wager({
      ticketId: "W-3",
      event: "C vs D",
      riskUsd: 500,
      clvCents: null,
      alertTier: "LATENCY",
    }),
  ];
  const games = buildGsliveGameLog(rows);

  test("sorts by risk, tickets and CLV with unknown CLV last", () => {
    expect(sortGsliveGames(games, "risk", -1).map((g) => g.event)).toEqual([
      "A vs B",
      "C vs D",
    ]);
    expect(sortGsliveGames(games, "tickets", -1)[0]?.event).toBe("A vs B");
    const byClv = sortGsliveGames(games, "clv", -1);
    expect(byClv.map((g) => g.event)).toEqual(["A vs B", "C vs D"]);
    expect(byClv[1]?.avgClvCents).toBeNull();
  });

  test("filters events by alerts and by closing-line edge", () => {
    const events = buildGsliveEventLog(rows);
    expect(filterGsliveEvents(events, "all")).toHaveLength(3);
    // 5¢ steam threshold: W-1 (1¢) is excluded, W-3 has no closing line.
    expect(filterGsliveEvents(events, "clv").map((e) => e.ticketId)).toEqual([
      "W-2",
    ]);
    expect(filterGsliveEvents(events, "alerts").map((e) => e.ticketId)).toEqual(
      ["W-3"],
    );
  });
});

describe("burst window, concentration and CSV export", () => {
  const rows: LiveWager[] = [
    wager({
      ticketId: "W-1",
      customerId: "A",
      riskUsd: 1000,
      timestamp: "7:00:00 PM ET",
    }),
    wager({
      ticketId: "W-2",
      customerId: "B",
      riskUsd: 2000,
      timestamp: "7:00:30 PM ET",
    }),
    wager({
      ticketId: "W-3",
      customerId: "A",
      riskUsd: 3000,
      timestamp: "7:01:00 PM ET",
    }),
    wager({
      ticketId: "W-4",
      customerId: "C",
      riskUsd: 4000,
      timestamp: "7:05:00 PM ET",
    }),
    wager({
      ticketId: "W-5",
      customerId: "D",
      riskUsd: 5000,
      timestamp: "7:20:00 PM ET",
    }),
  ];
  const [game] = buildGsliveGameLog(rows);

  test("counts the busiest 60-second window including the boundary", () => {
    expect(maxTicketsInWindow([0, 30, 60, 300, 1200], 60)).toBe(3);
    expect(maxTicketsInWindow([], 60)).toBe(0);
    expect(game?.maxTicketsIn60s).toBe(3);
  });

  test("reports distinct customers and top-3 concentration", () => {
    expect(game?.uniqueCustomers).toBe(4);
    // customer A holds two tickets (4000); top three = D 5000 + C 4000 + A 4000 of 15000.
    expect(game?.top3CustomerSharePct).toBe(86.7);
  });

  test("exports the game log as CSV with a stable header", () => {
    const csv = gsliveGameLogCsv(game === undefined ? [] : [game]);
    const [header, row] = csv.trim().split("\n");
    expect(header).toContain("max_tickets_60s");
    expect(header).toContain("top3_share_pct");
    expect(row).toContain("Flyers vs Oilers");
    expect(row).toContain("86.7");
  });

  test("quotes commas in CSV and exports the event log", () => {
    const [odd] = buildGsliveGameLog([
      wager({ ticketId: "W-9", event: "Flyers, Oilers" }),
    ]);
    expect(gsliveGameLogCsv(odd === undefined ? [] : [odd])).toContain(
      '"Flyers, Oilers"',
    );
    const events = buildGsliveEventLog(rows);
    const csv = gsliveEventLogCsv(events);
    expect(csv.split("\n")[0]).toContain("ticket_id");
    expect(csv.trim().split("\n")).toHaveLength(events.length + 1);
    expect(csv).toContain("W-5");
  });
});
