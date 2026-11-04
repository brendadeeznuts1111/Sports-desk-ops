import { describe, expect, test } from "bun:test";

import { z } from "zod";

import {
  aggregateByState,
  analyzeLegs,
  buildLiveWagerReport,
  countLiveStates,
  fetchWagersByStateLive,
  formatAggregates,
  formatLiveCounts,
  formatWagerQuality,
  formatWagerSummary,
  formatWagerTable,
  GSLIVE_STATE_ORDER,
  MISSING_STATE,
  parseBetTime,
  parseCsv,
  parseLiveTime,
  parseMoney,
  profileCsvTicket,
  resolveStateLabel,
  sortLiveWagersByState,
  sortWagersByState,
  stateRank,
  summarizeLiveWagers,
  summarizeWagers,
  toCsv,
  toLiveWagers,
  toWagerRows,
  WAGER_COLUMNS,
  reportColumns,
  wrapProseCell,
  wrapReportLine,
  wrapTokenCell,
  type WagerReport,
} from "./gslive_wagers_by_state.ts";
import { env, stringWidth, stripANSI } from "bun";

const HEADER = [
  "State",
  "Bet Time",
  "Player",
  "Agent",
  "Ticket",
  "Id",
  "Bet Group",
  "Sport / League",
  "Event Details",
  "Market",
  "Period",
  "Side",
  "Type",
  "Risk",
  "To Win",
  "Result",
  "Bet price",
  "Grade Time",
];

const FIXTURE_MTIME = "2026-10-25T01:54:46.516Z";

function csvWithHeader(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [header, ...rows]
    .map((cells) =>
      cells
        .map((cell) =>
          /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell,
        )
        .join(","),
    )
    .join("\r\n");
}

function csvOf(rows: readonly (readonly string[])[]): string {
  return csvWithHeader(HEADER, rows);
}

/** One leg row in the fixture HEADER order. */
function leg(opts: {
  state: string;
  time: string;
  ticket: string;
  id?: string;
  risk?: string;
  toWin?: string;
  result?: string;
  grade?: string;
  details?: string;
}): string[] {
  return [
    opts.state,
    opts.time,
    "player",
    "agent",
    opts.ticket,
    opts.id ?? "leg-1",
    "group",
    "MLB",
    opts.details ?? "A vs B - Game / A",
    "ML",
    "Game",
    "1",
    "straight",
    opts.risk ?? "0",
    opts.toWin ?? "0",
    opts.result ?? "0",
    "2.0",
    opts.grade ?? "",
  ];
}

/**
 * Build the v2 report the way `main` does: profile the ticket column, parse and sort the rows,
 * then measure. `observedEndMs`/`nowMs` are fixture-controlled so lags and ages are deterministic.
 */
function reportOf(
  csv: string,
  opts: {
    nowMs?: number;
    mtime?: string;
  } = {},
): WagerReport {
  const csvRows = parseCsv(csv);
  const profile = profileCsvTicket(csvRows);
  const rows = sortWagersByState(toWagerRows(csvRows, profile));
  let observedEndMs = 0;
  for (const row of rows) {
    if (row.betTimeMs !== null && row.betTimeMs > observedEndMs) {
      observedEndMs = row.betTimeMs;
    }
  }
  const nowMs = opts.nowMs ?? observedEndMs + 120 * 60_000;
  return analyzeLegs(rows, {
    source: {
      kind: "offline-csv",
      path: "fixture.csv",
      mtime: opts.mtime ?? FIXTURE_MTIME,
      dateFilterBy: null,
    },
    nowMs,
    ticketField: profile.ticketField,
    ticketCoveragePct: profile.coveragePct,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("parseCsv", () => {
  test("handles quoted commas, doubled quotes, CRLF and a BOM", () => {
    const rows = parseCsv(
      '\uFEFFa,b\r\n"x, y","he said ""hi"""\r\nplain,"multi\nline"\r\n',
    );
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["plain", "multi\nline"],
    ]);
  });

  test("drops blank trailing lines", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("value parsing", () => {
  test("parseMoney strips currency separators and tolerates blanks", () => {
    expect(parseMoney("1,234.50")).toBe(1234.5);
    expect(parseMoney("$20")).toBe(20);
    expect(parseMoney("-12.5")).toBe(-12.5);
    expect(parseMoney("")).toBe(0);
    expect(parseMoney("n/a")).toBe(0);
  });

  test("parseBetTime reads the export's HH:MM:SS MM/DD/YYYY", () => {
    const ms = parseBetTime("20:50:49 10/24/2026");
    expect(ms).not.toBeNull();
    expect(new Date(ms ?? 0).getFullYear()).toBe(2026);
    expect(new Date(ms ?? 0).getMonth()).toBe(9);
    expect(new Date(ms ?? 0).getDate()).toBe(24);
    expect(parseBetTime("")).toBeNull();
    expect(parseBetTime("not a time")).toBeNull();
  });

  test("resolveStateLabel maps observed numeric codes and labels a blank state", () => {
    expect(resolveStateLabel("win")).toEqual({
      state: "win",
      numericCode: null,
    });
    expect(resolveStateLabel("3")).toEqual({
      state: "push",
      numericCode: 3,
    });
    expect(resolveStateLabel("99")).toEqual({
      state: "(code 99)",
      numericCode: 99,
    });
    expect(resolveStateLabel("  ")).toEqual({
      state: MISSING_STATE,
      numericCode: null,
    });
  });

  test("parseLiveTime accepts epoch seconds, epoch ms, the export format and ISO", () => {
    expect(parseLiveTime(1_793_163_600)).toBe(1_793_163_600_000);
    expect(parseLiveTime(1_793_163_600_000)).toBe(1_793_163_600_000);
    expect(parseLiveTime("1793163600")).toBe(1_793_163_600_000);
    expect(parseLiveTime("20:50:49 10/24/2026")).toBe(
      parseBetTime("20:50:49 10/24/2026"),
    );
    expect(parseLiveTime("2026-10-24T20:50:49.000Z")).toBe(
      Date.parse("2026-10-24T20:50:49.000Z"),
    );
    expect(parseLiveTime("nope")).toBeNull();
    expect(parseLiveTime(0)).toBeNull();
    expect(parseLiveTime(null)).toBeNull();
  });
});

describe("legs and wagers (legacy surface kept green)", () => {
  const csv = csvOf([
    leg({
      state: "win",
      time: "09:00:00 10/22/2026",
      ticket: "t1",
      risk: "10",
      toWin: "8",
      grade: "10:00:00 10/22/2026",
    }),
    leg({
      state: "pending",
      time: "10:00:00 10/24/2026",
      ticket: "t2",
      risk: "20",
      toWin: "30",
    }),
    leg({
      state: "lose",
      time: "11:00:00 10/23/2026",
      ticket: "t3",
      risk: "5",
      toWin: "4",
      result: "-5",
      grade: "12:00:00 10/23/2026",
    }),
    leg({
      state: "win",
      time: "12:00:00 10/23/2026",
      ticket: "t4",
      risk: "7",
      toWin: "6",
      result: "7",
      grade: "13:00:00 10/23/2026",
    }),
    leg({
      state: "mystery-state",
      time: "13:00:00 10/23/2026",
      ticket: "t5",
      risk: "3",
    }),
    leg({ state: "", time: "", ticket: "t6", risk: "1" }),
  ]);
  const rows = sortWagersByState(toWagerRows(parseCsv(csv)));

  test("orders by canonical state, unknowns last, missing labelled", () => {
    expect(rows.map((row) => row.state)).toEqual([
      "pending",
      "win",
      "win",
      "lose",
      "mystery-state",
      MISSING_STATE,
    ]);
  });

  test("newest bet first within a state", () => {
    const wins = rows.filter((row) => row.state === "win");
    expect(wins.map((row) => row.cells.Ticket)).toEqual(["t4", "t1"]);
  });

  test("aggregates legs, distinct wagers and leg-scoped money per state", () => {
    const aggregates = aggregateByState(rows);
    expect(aggregates.map((entry) => entry.state)).toEqual([
      "pending",
      "win",
      "lose",
      "mystery-state",
      MISSING_STATE,
    ]);
    expect(aggregates.find((entry) => entry.state === "win")).toEqual({
      state: "win",
      legs: 2,
      wagers: 2,
      legRisk: 17,
      legToWin: 14,
      legResult: 7,
    });
    expect(aggregates.find((entry) => entry.state === "pending")).toEqual({
      state: "pending",
      legs: 1,
      wagers: 1,
      legRisk: 20,
      legToWin: 30,
      legResult: 0,
    });
  });

  test("summary counts legs, wagers and spanning wagers", () => {
    const summary = summarizeWagers(rows);
    expect(summary).toEqual({ legs: 6, wagers: 6, spanning: 0 });
    const text = formatWagerSummary(aggregateByState(rows), summary);
    expect(text).toContain("legs = 6 (one row per leg)");
    expect(text).toContain("distinct wagers (Ticket) = 6");
    expect(text).toContain("spanning >1 state = 0");
    expect(formatAggregates(aggregateByState(rows))).toContain("state");
  });
});

describe("v2 report: parlay spanning, repeated risk, unknown states", () => {
  const csv = csvOf([
    leg({
      state: "pending",
      time: "20:00:00 10/24/2026",
      ticket: "t1",
      risk: "10",
    }),
    leg({
      state: "win",
      time: "20:00:00 10/24/2026",
      ticket: "t1",
      risk: "10",
      result: "8",
      grade: "21:00:00 10/24/2026",
    }),
    leg({
      state: "win",
      time: "21:00:00 10/24/2026",
      ticket: "t2",
      risk: "5",
      result: "4",
      grade: "22:00:00 10/24/2026",
    }),
    leg({
      state: "mystery-state",
      time: "22:00:00 10/24/2026",
      ticket: "t3",
      risk: "3",
    }),
    leg({ state: "", time: "23:00:00 10/24/2026", ticket: "t4", risk: "2" }),
    leg({
      state: "cancel",
      time: "23:30:00 10/24/2026",
      ticket: "t5",
      risk: "7",
    }),
  ]);
  const report = reportOf(csv);

  test("counts legs and distinct wagers separately and detects the spanning parlay", () => {
    expect(report.totals.legs).toBe(6);
    expect(report.totals.wagers).toBe(5);
    expect(report.totals.spanning).toBe(1);
    expect(report.identity).toEqual({
      ticketField: "Ticket",
      coveragePct: 100,
      distinctWagers: 5,
      spanningWagers: 1,
      multiLegWagers: 1,
    });
  });

  test("wagerRisk dedupes the repeated parlay Risk; legRisk keeps every row", () => {
    expect(report.totals.legRisk).toBe(37);
    expect(report.totals.wagerRisk).toBe(27);
    // 10 repeated on both legs of t1: the leg sum overstates by exactly one Risk.
    expect(report.totals.legRisk - (report.totals.wagerRisk ?? 0)).toBe(10);
  });

  test("attributed wager risk allocates ticketRisk/stateSpread and sums to totals", () => {
    const pending = report.states.find((entry) => entry.state === "pending");
    const win = report.states.find((entry) => entry.state === "win");
    const missing = report.states.find(
      (entry) => entry.state === MISSING_STATE,
    );
    expect(pending?.wagers).toBe(1);
    expect(pending?.legs).toBe(1);
    expect(pending?.wagerRiskAttributed).toBe(5);
    expect(win?.wagers).toBe(2);
    expect(win?.legs).toBe(2);
    expect(win?.wagerRiskAttributed).toBe(10);
    expect(missing?.wagerRiskAttributed).toBe(2);
    const attributedSum = report.states.reduce(
      (sum, entry) => sum + (entry.wagerRiskAttributed ?? 0),
      0,
    );
    expect(attributedSum).toBe(27);
    expect(report.states.reduce((sum, entry) => sum + entry.legs, 0)).toBe(6);
  });

  test("unknown states are reported sorted, canonical order is preserved, missing last", () => {
    expect(report.states.map((entry) => entry.state)).toEqual([
      "pending",
      "win",
      "cancel",
      "mystery-state",
      MISSING_STATE,
    ]);
    expect(report.quality.unknownStates).toEqual(["mystery-state"]);
    expect(report.quality.numericStateCodes).toEqual([]);
  });

  test("window, age, snapshot lag and pending buckets come from the data", () => {
    const observedEnd = parseBetTime("23:30:00 10/24/2026");
    const observedStart = parseBetTime("20:00:00 10/24/2026");
    expect(report.window.observedStart).toBe(
      new Date(observedStart ?? 0).toISOString(),
    );
    expect(report.window.observedEnd).toBe(
      new Date(observedEnd ?? 0).toISOString(),
    );
    expect(report.window.ageMinutes).toBe(120);
    expect(report.window.snapshotLagMinutes).toBe(
      Math.round((Date.parse(FIXTURE_MTIME) - (observedEnd ?? 0)) / 60_000),
    );
    expect(report.window.fromEpochSec).toBeNull();
    expect(report.window.toEpochSec).toBeNull();
    // Pending t1 was bet at 20:00, observed end is 23:30 -> 210 min old at the snapshot.
    expect(report.quality.pendingAgeMinutes).toEqual({
      gt1h: 1,
      gt6h: 0,
      gt24h: 0,
      gt72h: 0,
    });
    expect(
      report.states.find((entry) => entry.state === "pending")
        ?.pendingAgeMinutes,
    ).toEqual({
      gt1h: 1,
      gt6h: 0,
      gt24h: 0,
      gt72h: 0,
    });
  });

  test("grade lag percentiles and settled sample exclude non-settled states", () => {
    expect(report.quality.gradeLagMinutes).toEqual({
      p50: 60,
      p90: 60,
      p99: 60,
      settledLegs: 2,
    });
    expect(
      report.states.find((entry) => entry.state === "win")?.gradeLagMinutesP50,
    ).toBe(60);
    expect(
      report.states.find((entry) => entry.state === "pending")
        ?.gradeLagMinutesP50,
    ).toBeNull();
  });

  test("quality reports zero coverage gaps and violations for this fixture", () => {
    expect(report.quality).toMatchObject({
      ticketCoveragePct: 100,
      unparsedBetTimes: 0,
      unknownStates: ["mystery-state"],
      numericStateCodes: [],
      coherenceViolations: {
        winResultNonPositive: 0,
        loseResultNonNegative: 0,
      },
    });
    expect(report.moneyScope).toContain("deduped/allocated by Ticket");
    expect(report.schemaVersion).toBe(2);
  });
});

describe("v2 report: empty window", () => {
  const report = reportOf(csvWithHeader(HEADER, []), { mtime: FIXTURE_MTIME });

  test("an empty window is measured zeros, not missing states", () => {
    expect(report.totals).toEqual({
      legs: 0,
      wagers: 0,
      spanning: 0,
      legRisk: 0,
      legToWin: 0,
      legResult: 0,
      wagerRisk: 0,
    });
    expect(report.states).toEqual([]);
    expect(report.identity.ticketField).toBe("Ticket");
    expect(report.identity.coveragePct).toBe(0);
    expect(report.window.observedStart).toBeNull();
    expect(report.window.observedEnd).toBeNull();
    expect(report.window.ageMinutes).toBeNull();
    expect(report.window.snapshotLagMinutes).toBeNull();
    expect(report.quality.gradeLagMinutes).toEqual({
      p50: null,
      p90: null,
      p99: null,
      settledLegs: 0,
    });
    expect(report.quality.pendingAgeMinutes).toEqual({
      gt1h: 0,
      gt6h: 0,
      gt24h: 0,
      gt72h: 0,
    });
    expect(report.notes.join(" ")).toContain("no legs in this window");
  });

  test("the renderer guards percentages on zero rows", () => {
    const table = formatWagerTable(report);
    expect(table).toContain("TOTAL");
    expect(table).toContain("0.0%");
    expect(table).not.toContain("NaN");
    expect(table).not.toContain("Infinity");
    const footer = formatWagerQuality(report);
    expect(footer).toContain("legs = 0 (one row per leg)");
    expect(footer).toContain("grade lag = n/a");
    expect(footer).not.toContain("NaN");
  });
});

describe("v2 report: no ticket field", () => {
  const headerWithoutTicket = HEADER.filter((column) => column !== "Ticket");
  const csv = csvWithHeader(headerWithoutTicket, [
    [
      "win",
      "20:00:00 10/24/2026",
      "player",
      "agent",
      "leg-1",
      "group",
      "MLB",
      "A vs B",
      "ML",
      "Game",
      "1",
      "straight",
      "10",
      "12",
      "10",
      "2.0",
      "21:00:00 10/24/2026",
    ],
    [
      "pending",
      "21:00:00 10/24/2026",
      "player",
      "agent",
      "leg-2",
      "group",
      "MLB",
      "A vs C",
      "ML",
      "Game",
      "1",
      "straight",
      "5",
      "6",
      "0",
      "2.0",
      "",
    ],
  ]);
  const report = reportOf(csv);

  test("wagers and wager-scoped money are null, never invented, and quality says why", () => {
    expect(report.identity.ticketField).toBeNull();
    expect(report.identity.distinctWagers).toBeNull();
    expect(report.totals.wagers).toBeNull();
    expect(report.totals.spanning).toBeNull();
    expect(report.totals.wagerRisk).toBeNull();
    expect(report.states.every((entry) => entry.wagers === null)).toBe(true);
    expect(
      report.states.every((entry) => entry.wagerRiskAttributed === null),
    ).toBe(true);
    expect(report.totals.legs).toBe(2);
    expect(report.totals.legRisk).toBe(15);
    expect(report.quality.ticketCoveragePct).toBe(0);
    expect(report.notes.join(" ")).toContain("no ticket field");
    expect(formatWagerQuality(report)).toContain("distinct wagers = n/a");
  });
});

describe("v2 report: coherence violations and numeric codes", () => {
  test("flags win with non-positive result and lose with non-negative result", () => {
    const csv = csvOf([
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
        result: "0",
        grade: "21:00:00 10/24/2026",
      }),
      leg({
        state: "lose",
        time: "20:00:00 10/24/2026",
        ticket: "t2",
        risk: "10",
        result: "0",
        grade: "21:00:00 10/24/2026",
      }),
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t3",
        risk: "10",
        result: "8",
        grade: "21:00:00 10/24/2026",
      }),
    ]);
    const report = reportOf(csv);
    expect(report.quality.coherenceViolations).toEqual({
      winResultNonPositive: 1,
      loseResultNonNegative: 1,
    });
  });

  test("maps numeric codes, reports them, and keeps unmapped codes visible", () => {
    const csv = csvOf([
      leg({
        state: "1",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
      }),
      leg({
        state: "99",
        time: "21:00:00 10/24/2026",
        ticket: "t2",
        risk: "5",
      }),
    ]);
    const report = reportOf(csv);
    expect(report.quality.numericStateCodes).toEqual([1, 99]);
    expect(report.states.map((entry) => entry.state)).toEqual([
      "win",
      "(code 99)",
    ]);
    expect(report.quality.unknownStates).toEqual(["(code 99)"]);
  });

  test("an inconsistent Risk across one ticket is deduped to the first leg and noted", () => {
    const csv = csvOf([
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
      }),
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "25",
      }),
    ]);
    const report = reportOf(csv);
    expect(report.totals.wagerRisk).toBe(10);
    expect(report.totals.legRisk).toBe(35);
    expect(report.notes.join(" ")).toContain("different Risk per leg");
  });
});

describe("v2 renderer", () => {
  test("table keeps legs + wagers and adds the attributed wager risk column", () => {
    const csv = csvOf([
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
      }),
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
      }),
      leg({
        state: "pending",
        time: "21:00:00 10/24/2026",
        ticket: "t2",
        risk: "5",
      }),
    ]);
    const table = formatWagerTable(reportOf(csv));
    expect(table).toContain("state");
    expect(table).toContain("legs");
    expect(table).toContain("wagers");
    expect(table).toContain("wager risk");
    expect(table).toContain("leg risk");
    expect(table).toContain("TOTAL");
    expect(table).toContain("15.00");
  });

  test("footer shows computed provenance, coverage and pending-age buckets", () => {
    const csv = csvOf([
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
      }),
      leg({
        state: "pending",
        time: "21:00:00 10/24/2026",
        ticket: "t2",
        risk: "5",
      }),
    ]);
    const footer = formatWagerQuality(reportOf(csv));
    expect(footer).toContain("distinct wagers (Ticket) = 2");
    expect(footer).toContain("ticket coverage = 100%");
    expect(footer).toContain("observed window");
    expect(footer).toContain("artifact age =");
    expect(footer).toContain("snapshot lag =");
    expect(footer).toContain("grade lag = n/a");
    expect(footer).toContain("pending age (anchor = observed end)");
    expect(footer).toContain("money scope:");
  });
});

describe("profileCsvTicket", () => {
  test("resolves the ticket column by coverage, not just by its name", () => {
    const header = HEADER.filter((column) => column !== "Ticket");
    header.push("ticket");
    const csv = csvWithHeader(header, [
      [
        "win",
        "20:00:00 10/24/2026",
        "player",
        "agent",
        "leg-1",
        "group",
        "MLB",
        "A vs B",
        "ML",
        "Game",
        "1",
        "straight",
        "10",
        "12",
        "10",
        "2.0",
        "21:00:00 10/24/2026",
        "2468",
      ],
      [
        "win",
        "20:00:00 10/24/2026",
        "player",
        "agent",
        "leg-2",
        "group",
        "MLB",
        "A vs B",
        "ML",
        "Game",
        "1",
        "straight",
        "10",
        "12",
        "10",
        "2.0",
        "21:00:00 10/24/2026",
        "2468",
      ],
    ]);
    const csvRows = parseCsv(csv);
    expect(profileCsvTicket(csvRows)).toEqual({
      ticketField: "ticket",
      coveragePct: 100,
    });
    const rows = toWagerRows(csvRows);
    expect(rows.map((row) => row.ticket)).toEqual(["2468", "2468"]);
    expect(rows[0]?.cells.Ticket).toBe("2468");
  });

  test("reports 0% coverage when the ticket column exists but is empty", () => {
    const csv = csvOf([
      leg({ state: "win", time: "20:00:00 10/24/2026", ticket: "" }),
    ]);
    const csvRows = parseCsv(csv);
    expect(profileCsvTicket(csvRows)).toEqual({
      ticketField: "Ticket",
      coveragePct: 0,
    });
  });
});

describe("toCsv", () => {
  test("round-trips the sorted legs and keeps only the kept columns", () => {
    const csv = csvOf([
      leg({
        state: "win",
        time: "09:00:00 10/22/2026",
        ticket: "t1",
        risk: "10",
        toWin: "8",
        details: 'A vs B, "prime"',
      }),
      leg({
        state: "pending",
        time: "10:00:00 10/24/2026",
        ticket: "t2",
        risk: "20",
        toWin: "30",
      }),
    ]);
    const out = toCsv(sortWagersByState(toWagerRows(parseCsv(csv))));
    const reparsed = parseCsv(out);
    expect(reparsed[0]).toEqual([...WAGER_COLUMNS]);
    expect(reparsed).toHaveLength(3);
    expect(reparsed[1]?.[0]).toBe("pending");
    expect(reparsed[2]?.[0]).toBe("win");
    expect(reparsed[2]?.[8]).toBe('A vs B, "prime"');
    expect(reparsed[2]?.[5]).toBe("leg-1");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("rejects a CSV without the required state/time/risk columns", () => {
    expect(() => toWagerRows(parseCsv("Player,Agent\np1,a1\n"))).toThrow(
      /missing required column "State"/,
    );
  });
});

describe("live ajax.php mode (legacy surface kept green)", () => {
  const WINDOW = {
    fromEpochSec: 1_793_163_600,
    toEpochSec: 1_793_771_999,
  } as const;
  const cookieHeader = "GSID=fixture-session";

  test("sorts raw ajax.php legs by state and counts legs and wagers", async () => {
    const calls: RequestInit[] = [];
    const response = jsonResponse({
      bets: [
        { state: "win", ticket: "t1", risk: 10 },
        { state: "pending", ticket: "t2", risk: 20 },
        { state: "win", ticket: "t1", risk: 10 },
        { state: "lose", ticket: "t3", risk: 40 },
        { state: "mystery-state", ticket: "t4", risk: 50 },
        { risk: 60 },
      ],
    });
    const result = await fetchWagersByStateLive({
      ...WINDOW,
      cookieHeader,
      sessionGate: "gate-fixture",
      fetchImpl: async (_url, init) => {
        calls.push(init);
        return response;
      },
    });

    expect(calls).toHaveLength(1);
    const sent = z
      .object({
        action: z.string(),
        state: z.string(),
        from: z.number(),
        to: z.number(),
      })
      .parse(JSON.parse(String(calls[0]?.body)));
    expect(sent.action).toBe("getBetReport");
    expect(sent.state).toBe("");
    expect(sent.from).toBe(WINDOW.fromEpochSec);
    expect(sent.to).toBe(WINDOW.toEpochSec);
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("cookie")).toBe(cookieHeader);
    expect(headers.get("x-gs-session")).toBe("gate-fixture");

    expect(result.legs).toBe(6);
    expect(result.legsOrdered.map((wager) => wager.state)).toEqual([
      "pending",
      "win",
      "win",
      "lose",
      "mystery-state",
      MISSING_STATE,
    ]);
    // t1 appears twice under win: two legs of one wager.
    expect(result.legsOrdered.map((wager) => wager.raw.ticket)).toEqual([
      "t2",
      "t1",
      "t1",
      "t3",
      "t4",
      undefined,
    ]);
    expect(result.ticketField).toBe("ticket");
    expect(result.wagers).toBe(4);
    expect(result.spanning).toBe(0);
    expect(result.states).toEqual([
      { state: "pending", legs: 1, wagers: 1 },
      { state: "win", legs: 2, wagers: 1 },
      { state: "lose", legs: 1, wagers: 1 },
      { state: "mystery-state", legs: 1, wagers: 1 },
      { state: MISSING_STATE, legs: 1, wagers: 0 },
    ]);
    expect(Number.isNaN(Date.parse(result.capturedAt))).toBe(false);
    expect(formatLiveCounts(result.states)).toContain("legs = 6");
  });

  test("reports wagers as n/a when the response has no ticket field", () => {
    const legs = toLiveWagers([{ state: "win" }, { state: "pending" }]);
    expect(legs.map((leg) => leg.ticket)).toEqual([null, null]);
    expect(countLiveStates(sortLiveWagersByState(legs))).toEqual([
      { state: "pending", legs: 1, wagers: null },
      { state: "win", legs: 1, wagers: null },
    ]);
    expect(summarizeLiveWagers(legs)).toEqual({ wagers: null, spanning: null });
  });

  test("a failed live read does not emit a tally", async () => {
    await expect(
      fetchWagersByStateLive({
        ...WINDOW,
        cookieHeader,
        fetchImpl: async () => jsonResponse({ error: "expired" }, 401),
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  test("stateRank puts the observed vocabulary first and unknowns after it", () => {
    for (const [position, state] of GSLIVE_STATE_ORDER.entries()) {
      expect(stateRank(state)).toBe(position);
    }
    expect(stateRank("mystery-state")).toBe(GSLIVE_STATE_ORDER.length);
  });
});

describe("live v2 report", () => {
  test("builds the same v2 shape, with the window measured from row bet times", () => {
    const rows = [
      {
        state: "win",
        ticket: "t1",
        risk: 10,
        toWin: 12,
        result: 10,
        betTime: "20:00:00 10/24/2026",
        gradeTime: "21:00:00 10/24/2026",
      },
      {
        state: "win",
        ticket: "t1",
        risk: 10,
        toWin: 12,
        betTime: "20:00:00 10/24/2026",
      },
    ];
    const capturedAt = new Date(
      parseBetTime("22:00:00 10/24/2026") ?? 0,
    ).toISOString();
    const report = buildLiveWagerReport(toLiveWagers(rows), {
      fromEpochSec: 1_793_163_600,
      toEpochSec: 1_793_771_999,
      dateFilterBy: "logTime",
      capturedAt,
    });

    expect(report.schemaVersion).toBe(2);
    if (report.source.kind !== "live-ajax.php") {
      throw new Error("expected a live-ajax.php source");
    }
    expect(report.source.capturedAt).toBe(capturedAt);
    expect(report.source.dateFilterBy).toBe("logTime");
    expect(report.window.observedStart).toBe(
      new Date(parseBetTime("20:00:00 10/24/2026") ?? 0).toISOString(),
    );
    expect(report.window.observedEnd).toBe(
      new Date(parseBetTime("20:00:00 10/24/2026") ?? 0).toISOString(),
    );
    expect(report.window.fromEpochSec).toBe(1_793_163_600);
    expect(report.window.toEpochSec).toBe(1_793_771_999);
    expect(report.window.ageMinutes).toBe(120);
    expect(report.window.snapshotLagMinutes).toBeNull();
    expect(report.identity).toEqual({
      ticketField: "ticket",
      coveragePct: 100,
      distinctWagers: 1,
      spanningWagers: 0,
      multiLegWagers: 1,
    });
    expect(report.totals.legs).toBe(2);
    expect(report.totals.wagers).toBe(1);
    expect(report.totals.wagerRisk).toBe(10);
    expect(report.totals.legRisk).toBe(20);
    expect(report.states[0]).toMatchObject({
      state: "win",
      legs: 2,
      wagers: 1,
      wagerRiskAttributed: 10,
    });
    expect(report.quality.gradeLagMinutes).toEqual({
      p50: 60,
      p90: 60,
      p99: 60,
      settledLegs: 1,
    });
  });

  test("no ticket field in a live read leaves wagers null and says why", () => {
    const report = buildLiveWagerReport(
      toLiveWagers([{ state: "win", risk: 5 }]),
      {
        fromEpochSec: 1,
        toEpochSec: 2,
        dateFilterBy: "calcTime",
        capturedAt: "2026-10-25T01:54:46.516Z",
      },
    );
    expect(report.identity.ticketField).toBeNull();
    expect(report.totals.wagers).toBeNull();
    expect(report.totals.wagerRisk).toBeNull();
    expect(report.quality.ticketCoveragePct).toBe(0);
    expect(report.notes.join(" ")).toContain("no ticket field");
    // No bet-time field either: the request window is reported, not invented observed values.
    expect(report.window.observedStart).toBeNull();
    expect(report.window.fromEpochSec).toBe(1);
    expect(report.notes.join(" ")).toContain("request window");
  });
});

describe("supplied ajax.php payload", () => {
  const cookieHeader = "GSID=fixture-session";
  const payload = {
    action: "getBetReport",
    partnerUserId: "",
    agent: "",
    eventId: "",
    freeBetId: "",
    state: "",
    sId: "",
    minVolume: "0",
    maxTimeUntilScore: "0",
    mId: "",
    from: 1792904400,
    fromTime: 0,
    to: 1793771999,
    toTime: 86399,
    betId: "",
    betGroupId: "",
    group: null,
    dateFilterBy: "logTime",
    partnerIds: "",
    period: null,
  } as const;

  test("POSTs the supplied body verbatim and reports its window", async () => {
    const calls: RequestInit[] = [];
    const result = await fetchWagersByStateLive({
      fromEpochSec: 0,
      toEpochSec: 0,
      cookieHeader,
      payload,
      fetchImpl: async (_url, init) => {
        calls.push(init);
        return jsonResponse({ bets: [{ state: "win", ticket: "t1" }] });
      },
    });
    expect(JSON.parse(String(calls[0]?.body))).toEqual(payload);
    expect(result.fromEpochSec).toBe(1792904400);
    expect(result.toEpochSec).toBe(1793771999);
    expect(result.dateFilterBy).toBe("logTime");
    expect(result.legs).toBe(1);
  });

  test("an invalid body fails before the network", async () => {
    let called = false;
    await expect(
      fetchWagersByStateLive({
        fromEpochSec: 0,
        toEpochSec: 0,
        cookieHeader,
        payload: { action: "getInfoPlayer", from: 1, to: 2 },
        fetchImpl: async () => {
          called = true;
          return jsonResponse({});
        },
      }),
    ).rejects.toThrow(/invalid getBetReport payload/);
    expect(called).toBe(false);
  });
});

describe("wrapAnsi cells: prose vs token, width-aware measure", () => {
  test("prose wraps an alert summary at word boundaries", () => {
    const summary =
      "Late-clock clinched snipe: 30 basketball quarter bets placed 7s to 114s before the horn";
    const lines = wrapProseCell(summary, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.join(" ")).toBe(summary);
  });

  test("prose wrapping preserves ANSI styling across the break", () => {
    const styled = `[1mLate-clock clinched snipe: 30 basketball quarter bets[22m placed before the horn`;
    const lines = wrapProseCell(styled, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(stripANSI(lines.join(" "))).toBe(stripANSI(styled));
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("token wrapping hard-breaks a long source URL without rewording", () => {
    const url =
      "https://plive.sportswidgets.pro/manager-tools/assets/components/circleTemplateApplier/circleTemplateApplier.html";
    const lines = wrapTokenCell(url, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(url);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
    expect(lines.some((line) => line.includes(" "))).toBe(false);
  });

  test("short cells and exact-width cells never wrap", () => {
    expect(wrapProseCell("pending", 24)).toEqual(["pending"]);
    expect(wrapTokenCell("x".repeat(40), 40)).toEqual(["x".repeat(40)]);
  });

  test("emoji and ambiguous widths count as the terminal does", () => {
    expect(stringWidth("🎰")).toBe(2);
    expect(stringWidth("pending 🎰")).toBe(10);
  });

  test("a long state name wraps but the table stays rectangular", () => {
    const csv = csvOf([
      leg({
        state: "win",
        time: "20:00:00 10/24/2026",
        ticket: "t1",
        risk: "10",
      }),
      leg({
        state:
          "cancel after confirmation with an extra long suffix of words words words",
        time: "21:00:00 10/24/2026",
        ticket: "t2",
        risk: "5",
      }),
    ]);
    const table = formatWagerTable(reportOf(csv));
    const lines = table.split("\n");
    expect(lines.length).toBeGreaterThan(4); // header + sep + rows + TOTAL, with a wrap
    const widths = new Set(lines.map((line) => stringWidth(line)));
    expect(widths.size).toBe(1); // separator and every row share one display width
    expect(table).toContain("TOTAL");
  });
});

describe("Bun-native render widths and wrapping", () => {
  const widthOf = (line: string): number =>
    stringWidth(line, { ambiguousIsNarrow: true });

  test("reportColumns reads COLUMNS with sane clamps and restores the env", () => {
    const previous = env.COLUMNS;
    try {
      delete env.COLUMNS;
      expect(reportColumns()).toBe(100);
      env.COLUMNS = "60";
      expect(reportColumns()).toBe(60);
      env.COLUMNS = "10";
      expect(reportColumns()).toBe(40);
      env.COLUMNS = "9999";
      expect(reportColumns()).toBe(200);
      env.COLUMNS = "not-a-number";
      expect(reportColumns()).toBe(100);
    } finally {
      if (previous === undefined) delete env.COLUMNS;
      else env.COLUMNS = previous;
    }
  });

  test("wrapReportLine preserves indent, wraps prose and hard-breaks long tokens", () => {
    const previous = env.COLUMNS;
    try {
      env.COLUMNS = "40";
      const prose = wrapReportLine(
        "  note: this is a deliberately long explanatory sentence that must wrap at the configured width",
      );
      expect(prose.length).toBeGreaterThan(1);
      expect(prose[0]?.startsWith("  note:")).toBe(true);
      for (const line of prose) expect(widthOf(line)).toBeLessThanOrEqual(40);
      expect(prose[1]?.startsWith("  ")).toBe(true);

      const token = wrapReportLine(
        "source = /Users/someone/a/very/long/path/that/cannot/break/on/spaces/report.json",
        "token",
      );
      expect(token.length).toBeGreaterThan(1);
      for (const line of token) expect(widthOf(line)).toBeLessThanOrEqual(40);
    } finally {
      if (previous === undefined) delete env.COLUMNS;
      else env.COLUMNS = previous;
    }
  });

  test("wrap primitives agree with stringWidth for ambiguous-width characters", () => {
    const rows = wrapProseCell("·".repeat(5), 2);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(widthOf(row)).toBeLessThanOrEqual(2);
  });

  test("legacy renderer pads by display width for wide state labels", () => {
    const table = formatLiveCounts([
      { state: "界", legs: 3, wagers: 2 },
      { state: "pending", legs: 1, wagers: 1 },
    ]);
    const lines = table
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== "" &&
          !line.startsWith("legs =") &&
          !line.startsWith("-"),
      );
    const widths = lines.map((line) => widthOf(line));
    expect(new Set(widths).size).toBe(1);
  });
});
