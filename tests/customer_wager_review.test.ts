/**
 * @file tests/customer_wager_review.test.ts
 * @description Contracts for the per-customer wager review.
 *
 * The numbers here are small on purpose: every assertion is arithmetic an operator can check by
 * hand, so a regression in the join cannot hide behind a large fixture. The loader tests write a
 * throwaway checkout root — they never read the real Scratch artifacts.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ArtifactFile,
  GradedWagerRow,
  LoadedCustomerWagerArtifacts,
  PendingCaptureTotals,
  PendingWagerRow,
  UsersReportRow,
} from "../lib/customer_wager_artifacts.ts";
import {
  americanOddsFromAmounts,
  bookPresence,
  platformDayContext,
  dedupeGradedRows,
  gradedWagerRows,
  ledgerTenure,
  loadCustomerWagerArtifacts,
  normalizeCustomerId,
  pendingWagerRows,
  resolveReviewArtifactPaths,
  usersReportRows,
} from "../lib/customer_wager_artifacts.ts";
import {
  buildCustomerWagerReview,
  decimalOdds,
  FREE_PLAY_LONGSHOT_MIN_DECIMAL,
  parseDeskTimestamp,
  REPRICE_MIN_DELTA_POINTS,
  ROUND_ROBIN_MAX_SPAN_MS,
  ROUND_ROBIN_MIN_WAGERS,
  selectionName,
} from "../lib/customer_wager_review.ts";
import {
  parseWagerLegs,
  reconstructWagerCard,
  summarizeCardCorpus,
} from "../lib/wager_card.ts";

const REPO = resolve(import.meta.dir, "..");

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function artifact(
  id: ArtifactFile["id"],
  over: Partial<ArtifactFile> = {},
): ArtifactFile {
  return {
    id,
    label: id,
    path: `fixtures/${id}.json`,
    exists: true,
    bytes: 100,
    mtimeIso: "2026-11-16T17:00:00.000Z",
    ageMinutes: 60,
    records: 1,
    note: null,
    ...over,
  };
}

function pending(over: Partial<PendingWagerRow> = {}): PendingWagerRow {
  return {
    customerId: "TTN97",
    ticket: "T1",
    wagerNumber: "1",
    placedAt: "2026-11-16 11:35:43.357",
    sport: "Golf",
    subSport: "Outright Winner",
    period: "Tournament",
    selection: "Ben Kohles +1600",
    description: "Golf - / Tournament / Outright Winner / Ben Kohles +1600",
    priceAmerican: 1600,
    riskUsd: 2000,
    toWinUsd: 32000,
    agent: "1RODDY.",
    status: "P",
    picks: 1,
    ...over,
  };
}

function graded(over: Partial<GradedWagerRow> = {}): GradedWagerRow {
  return {
    customerId: "TTN97",
    ticket: "T1",
    wagerNumber: "1",
    placedAt: "2026-11-11 09:01:52.780",
    picks: 2,
    wagerType: "P",
    status: "L",
    riskUsd: 100,
    toWinUsd: 200,
    profitUsd: 0,
    lostUsd: 100,
    refundedUsd: 0,
    freePlay: false,
    credit: true,
    writer: "Internet",
    parlayName: "",
    description: "",
    source: "graded-today.json",
    ...over,
  };
}

function users(over: Partial<UsersReportRow> = {}): UsersReportRow {
  return {
    customerId: "TTN97",
    userId: "2292465",
    groupName: "PLAYER_TTN97",
    agent: "1RODDY.",
    suspectedBot: false,
    riskUsd: 20,
    toWinUsd: 167.03,
    profitUsd: 0,
    betUsd: 20,
    wagerCount: 1,
    legCount: 2,
    ...over,
  };
}

const EMPTY_CAPTURE: PendingCaptureTotals = {
  rows: 0,
  customers: 0,
  riskUsd: 0,
  toWinUsd: 0,
  capturedAt: null,
  acceptEqualsGame: 0,
};

const MATCHED: LoadedCustomerWagerArtifacts["matched"] = {
  pending: 0,
  ticker: 0,
  graded_today: 0,
  graded_oct: 0,
  users_report: 0,
  roster: 0,
  ledger: 0,
  book: 0,
};

function loaded(
  over: Partial<LoadedCustomerWagerArtifacts> = {},
): LoadedCustomerWagerArtifacts {
  return {
    customerId: "TTN97",
    generatedAt: "2026-11-16T18:51:27.000Z",
    sources: [
      artifact("pending"),
      artifact("ticker"),
      artifact("graded_today"),
      artifact("graded_oct"),
      artifact("users_report"),
      artifact("roster"),
      artifact("ledger"),
      artifact("book"),
    ],
    matched: MATCHED,
    pending: [],
    pendingCapture: EMPTY_CAPTURE,
    ticker: [],
    graded: [],
    users: [],
    roster: [],
    ledger: null,
    ledgerPopulation: null,
    platform: null,
    cardCorpus: {
      candidateTickets: 0,
      solved: 0,
      refused: 0,
      unparseable: 0,
      truncated: false,
      bookingRatesPct: [],
      medianBookingPct: null,
      minBookingPct: null,
      maxBookingPct: null,
      comparable: {
        minWagers: 10,
        n: 0,
        bookingRatesPct: [],
        medianPct: null,
        minPct: null,
        maxPct: null,
      },
      refusalReasons: {},
      note: "",
    },
    book: null,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

describe("normalization", () => {
  test("customer ids are compared in one spelling", () => {
    expect(normalizeCustomerId(" player_TTN97 ")).toBe("TTN97");
    expect(normalizeCustomerId("player-ttn97")).toBe("TTN97");
    expect(normalizeCustomerId("TTN97     ")).toBe("TTN97");
  });

  test("AmountWon is profit, so risk + profit is the return", () => {
    const [row] = gradedWagerRows(
      [
        {
          CustomerID: "TTN97     ",
          TicketNumber: "1078606016",
          WagerNumber: "1",
          TotalPicks: "2",
          WagerType: "P",
          AmountWagered: "5000.0",
          ToWinAmount: "6179.0",
          AmountWon: "6179.0",
          AmountLost: "0.0",
          WagerStatus: "W",
          AcceptedDateTime: "2026-11-12 08:55:22.883",
          FreePlayFlag: "N",
          CreditAcctFlag: "Y",
          TicketWriter: "Internet",
          Description: "Soccer #234009 Spain -165",
        },
      ],
      "export.json",
    );
    expect(row).toBeDefined();
    if (row === undefined) return;
    // Wire strings are CENTS: "5000.0" is $50.00, not $5,000.
    expect(row.riskUsd).toBe(50);
    expect(row.toWinUsd).toBe(61.79);
    expect(row.profitUsd).toBe(61.79);
    expect(row.riskUsd + row.profitUsd).toBeCloseTo(111.79, 2);
  });

  test("odds recover from the amounts when the selection text has no price", () => {
    expect(americanOddsFromAmounts(2000, 32000)).toBe(1600);
    expect(americanOddsFromAmounts(1000, 33000)).toBe(3300);
    expect(americanOddsFromAmounts(180, 100)).toBe(-180);
    expect(decimalOdds(500, 175395)).toBe(351.79);
  });

  test("desk timestamps parse to comparable instants", () => {
    expect(parseDeskTimestamp("2026-11-11 09:01:52.780")).toBe(
      Date.UTC(2026, 10, 11, 9, 1, 52, 780),
    );
    expect(parseDeskTimestamp("not a timestamp")).toBeNull();
  });

  test("the trailing price is not part of the selection name", () => {
    expect(selectionName("Ben Kohles +3300")).toBe("Ben Kohles");
    expect(selectionName("Ben Kohles -110")).toBe("Ben Kohles");
    expect(selectionName("Ben Kohles")).toBe("Ben Kohles");
  });

  test("pending capture totals count every row, not just the customer", () => {
    const rows = pendingWagerRows({
      capturedAt: "2026-11-16T17:20:00.006Z",
      games: [
        {
          customerID: "TTN97",
          chosenTeam: "A +100",
          wagered: 100,
          toWin: 100,
          acceptedAt: "2026-11-16 11:00:00.000",
          gameDateTime: "2026-11-16 11:00:00.000",
          ticketNumber: "1",
          agent: { key: "AG" },
        },
        {
          customerID: "OTHER",
          chosenTeam: "B +200",
          wagered: 50,
          toWin: 100,
          acceptedAt: "2026-11-16 11:01:00.000",
          gameDateTime: "2026-11-16 11:01:00.000",
          ticketNumber: "2",
        },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.priceAmerican).toBe(100);
    expect(rows[0]?.riskUsd).toBe(1); // wagered 100 is cents
  });
});

/* -------------------------------------------------------------------------- */
/* Settled arithmetic                                                         */
/* -------------------------------------------------------------------------- */

describe("settled summary", () => {
  test("net is profit minus lost, and free play is separated from cash", () => {
    const review = buildCustomerWagerReview(
      loaded({
        graded: [
          graded({
            ticket: "T1",
            wagerNumber: "1",
            riskUsd: 5000,
            toWinUsd: 6179,
            profitUsd: 6179,
            lostUsd: 0,
            status: "W",
          }),
          graded({
            ticket: "T2",
            wagerNumber: "1",
            riskUsd: 5000,
            toWinUsd: 10000,
            profitUsd: 0,
            lostUsd: 5000,
            status: "L",
          }),
          graded({
            ticket: "T3",
            wagerNumber: "1",
            riskUsd: 500,
            toWinUsd: 175395,
            profitUsd: 0,
            lostUsd: 500,
            status: "L",
            freePlay: true,
            picks: 9,
          }),
          graded({
            ticket: "T4",
            wagerNumber: "1",
            riskUsd: 2500,
            toWinUsd: 45000,
            profitUsd: 0,
            lostUsd: 2500,
            status: "L",
            freePlay: true,
            picks: 1,
          }),
        ],
      }),
    );
    const settled = review.settled;
    expect(settled.rows).toBe(4);
    expect(settled.tickets).toBe(4);
    expect(settled.riskUsd).toBe(13000);
    expect(settled.profitUsd).toBe(6179);
    expect(settled.lostUsd).toBe(8000);
    expect(settled.netUsd).toBe(-1821);
    expect(settled.freePlayRiskUsd).toBe(3000);
    expect(settled.cashRiskUsd).toBe(10000);
    // cash net = profit - (lost - free-play lost) = 6179 - 5000
    expect(settled.cashNetUsd).toBe(1179);
    expect(settled.wins).toBe(1);
    expect(settled.losses).toBe(3);
    expect(settled.byStructure.map((bucket) => bucket.label)).toEqual([
      "single",
      "2-leg",
      "9-leg",
    ]);
    // Every row in this fixture is placed on 2026-11-11; the largest ticket is 5000.
    expect(settled.concentration.activeDays).toBe(1);
    expect(settled.concentration.denominatorUsd).toBe(13000);
    expect(settled.concentration.denominatorBasis).toBe("settled_handle");
    expect(settled.concentration.topDay?.sharePct).toBe(100);
    expect(settled.concentration.topDay?.shareOf).toBe("settled_handle");
    expect(settled.concentration.topTicket?.ticket).toBe("T1");
    expect(settled.concentration.topTicket?.sharePct).toBeCloseTo(38.46, 1);
  });

  test("a two-day slate cannot be read from the per-day concentration", () => {
    const review = buildCustomerWagerReview(
      loaded({
        graded: [
          graded({
            ticket: "CARD",
            wagerNumber: "1",
            placedAt: "2026-11-11 09:01:52.780",
            riskUsd: 283.75,
          }),
          graded({
            ticket: "PAIRS",
            wagerNumber: "1",
            placedAt: "2026-11-12 08:55:22.883",
            riskUsd: 200,
          }),
        ],
      }),
    );
    const concentration = review.settled.concentration;
    expect(concentration.activeDays).toBe(2);
    // The same position spread over two days: top day and top ticket both show 58.66%, while the
    // two-day slate is 100% of the handle. The block documents that it has no slate dimension.
    expect(concentration.denominatorUsd).toBeCloseTo(483.75, 2);
    expect(concentration.topDay?.sharePct).toBeCloseTo(58.66, 1);
    expect(concentration.topTicket?.sharePct).toBeCloseTo(58.66, 1);
    expect(concentration.note).toContain("not lifetime volume");
    expect(concentration.note).toContain("multi-day slate");
  });

  test("push/other statuses are not counted as losses", () => {
    const review = buildCustomerWagerReview(
      loaded({
        graded: [
          graded({ status: "W", riskUsd: 100, profitUsd: 100, lostUsd: 0 }),
          graded({ status: "L", wagerNumber: "2" }),
          graded({
            status: "X",
            wagerNumber: "3",
            riskUsd: 100,
            profitUsd: 0,
            lostUsd: 0,
            refundedUsd: 100,
          }),
        ],
      }),
    );
    expect(review.settled.other).toBe(1);
    expect(review.settled.winRatePct).toBe(50);
    expect(review.settled.refundedUsd).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* Pending exposure                                                           */
/* -------------------------------------------------------------------------- */

describe("pending exposure", () => {
  test("one market with mutually exclusive outcomes reports best and worst case", () => {
    const review = buildCustomerWagerReview(
      loaded({
        pending: [
          pending({
            ticket: "1",
            selection: "Ben Kohles +1600",
            riskUsd: 2000,
            toWinUsd: 32000,
          }),
          pending({
            ticket: "2",
            selection: "Hayden Springer +10000",
            riskUsd: 1000,
            toWinUsd: 100000,
          }),
          pending({
            ticket: "3",
            selection: "Ben Kohles +3300",
            riskUsd: 1000,
            toWinUsd: 33000,
          }),
        ],
        pendingCapture: {
          rows: 3,
          customers: 1,
          riskUsd: 4000,
          toWinUsd: 165000,
          capturedAt: null,
          acceptEqualsGame: 3,
        },
      }),
    );
    const scenario = review.pending.singleMarket;
    expect(scenario).not.toBeNull();
    if (scenario === null) return;
    expect(scenario.rows).toBe(3);
    expect(scenario.riskUsd).toBe(4000);
    // Kohles pays both tickets together: 2000+32000 + 1000+33000 = 68000
    const kohles = scenario.outcomes.find(
      (outcome) => outcome.selection === "Ben Kohles",
    );
    expect(kohles?.tickets).toBe(2);
    expect(kohles?.returnUsd).toBe(68000);
    expect(kohles?.netUsd).toBe(64000);
    expect(scenario.bestNetUsd).toBe(97000); // Springer 101000 - 4000 risk
    expect(scenario.worstNetUsd).toBe(-4000);
    expect(
      review.findings.some((finding) => finding.id === "pending_single_market"),
    ).toBe(true);
  });

  test("different markets do not get a mutually-exclusive scenario", () => {
    const review = buildCustomerWagerReview(
      loaded({
        pending: [
          pending({ ticket: "1", sport: "Golf" }),
          pending({
            ticket: "2",
            sport: "NBA",
            subSport: "Point spread",
            period: "Game",
          }),
        ],
      }),
    );
    expect(review.pending.singleMarket).toBeNull();
  });

  test("combined implied probability is the sum of the quoted prices", () => {
    const review = buildCustomerWagerReview(
      loaded({
        pending: [
          pending({ selection: "Ben Kohles +1600", priceAmerican: 1600 }),
          pending({
            ticket: "2",
            selection: "Hayden Springer +10000",
            priceAmerican: 10000,
          }),
          pending({
            ticket: "3",
            selection: "Kristoffer Ventura +2500",
            priceAmerican: 2500,
          }),
          pending({
            ticket: "4",
            selection: "Ben Kohles +3300",
            priceAmerican: 3300,
          }),
        ],
      }),
    );
    expect(review.pending.impliedProbabilitySum).toBeCloseTo(0.1366, 3);
  });
});

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

describe("findings", () => {
  test("a 10-wager burst inside the span is a round-robin card, not a session", () => {
    const rows = Array.from({ length: ROUND_ROBIN_MIN_WAGERS }, (_, index) =>
      graded({
        ticket: "1078258344",
        wagerNumber: String(index + 2),
        placedAt: `2026-11-11 09:01:52.${String(780 + index).padStart(3, "0")}`,
        picks: 3,
        riskUsd: 875,
        lostUsd: 875,
        status: "L",
      }),
    );
    rows[0] = graded({
      ticket: "1078258344",
      wagerNumber: "2",
      placedAt: "2026-11-11 09:01:52.780",
      picks: 5,
      riskUsd: 500,
      toWinUsd: 3562,
      profitUsd: 3562,
      lostUsd: 0,
      status: "W",
    });
    const review = buildCustomerWagerReview(loaded({ graded: rows }));
    const burst = review.findings.find(
      (finding) => finding.id === "round_robin_burst",
    );
    expect(burst).toBeDefined();
    expect(burst?.severity).toBe("medium");
    expect(burst?.evidence.wagers).toBe(ROUND_ROBIN_MIN_WAGERS);
    expect(burst?.evidence.minWinningLegs).toBe(5);
    expect(burst?.detail).toContain("At least 5 selections won");
    expect(
      review.limitations.some((line) =>
        line.includes("wager number(s) on ticket 1078258344"),
      ),
    ).toBe(true);
  });

  test("wagers spread beyond the span are not called a burst", () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      graded({
        ticket: "T1",
        wagerNumber: String(index + 1),
        placedAt: `2026-11-11 09:0${index}:00.000`,
      }),
    );
    const review = buildCustomerWagerReview(loaded({ graded: rows }));
    expect(
      review.findings.some((finding) => finding.id === "round_robin_burst"),
    ).toBe(false);
    expect(ROUND_ROBIN_MAX_SPAN_MS).toBe(5_000);
  });

  test("stake escalation needs both a baseline and a peak", () => {
    const withBaseline = buildCustomerWagerReview(
      loaded({
        users: [users()],
        graded: [graded({ riskUsd: 5000, lostUsd: 5000 })],
      }),
    );
    const escalation = withBaseline.findings.find(
      (finding) => finding.id === "stake_escalation",
    );
    expect(escalation?.severity).toBe("high");
    expect(escalation?.evidence.factor).toBe(250);

    // A round-robin ticket is one purchase: the ticket total is reported next to the wager peak.
    const ticketLevel = buildCustomerWagerReview(
      loaded({
        users: [users()],
        graded: [
          graded({
            ticket: "T9",
            wagerNumber: "1",
            riskUsd: 5000,
            lostUsd: 5000,
          }),
          graded({
            ticket: "T9",
            wagerNumber: "2",
            riskUsd: 5000,
            lostUsd: 5000,
          }),
        ],
      }),
    );
    const ticketEscalation = ticketLevel.findings.find(
      (finding) => finding.id === "stake_escalation",
    );
    expect(ticketEscalation?.evidence.peakWagerUsd).toBe(5000);
    expect(ticketEscalation?.evidence.peakTicketUsd).toBe(10000);
    expect(ticketEscalation?.evidence.factor).toBe(500);

    const withoutBaseline = buildCustomerWagerReview(
      loaded({ graded: [graded({ riskUsd: 5000 })] }),
    );
    expect(
      withoutBaseline.findings.some(
        (finding) => finding.id === "stake_escalation",
      ),
    ).toBe(false);
  });

  test("the same selection at two prices is a reprice, and its distance is reported", () => {
    const review = buildCustomerWagerReview(
      loaded({
        pending: [
          pending({
            ticket: "1",
            selection: "Ben Kohles +1600",
            priceAmerican: 1600,
            placedAt: "2026-11-16 11:35:43.357",
          }),
          pending({
            ticket: "2",
            selection: "Ben Kohles +3300",
            priceAmerican: 3300,
            placedAt: "2026-11-16 12:17:15.390",
          }),
        ],
      }),
    );
    const reprice = review.findings.find(
      (finding) => finding.id === "same_selection_reprice",
    );
    expect(reprice?.evidence.deltaPoints).toBeGreaterThanOrEqual(
      REPRICE_MIN_DELTA_POINTS,
    );
    expect(reprice?.evidence.deltaPoints).toBe(1700);
  });

  test("free plays at long odds are named, not treated as cash risk", () => {
    const review = buildCustomerWagerReview(
      loaded({
        graded: [
          graded({
            riskUsd: 500,
            toWinUsd: 175395,
            freePlay: true,
            picks: 9,
            lostUsd: 500,
          }),
        ],
      }),
    );
    const free = review.findings.find(
      (finding) => finding.id === "free_play_longshot",
    );
    expect(free?.evidence.largestDecimalOdds).toBeGreaterThanOrEqual(
      FREE_PLAY_LONGSHOT_MIN_DECIMAL,
    );
    expect(review.settled.cashRiskUsd).toBe(0);
  });

  test("findings are ordered by severity, then id, and never scored", () => {
    const review = buildCustomerWagerReview(
      loaded({
        users: [users()],
        graded: [
          graded({
            riskUsd: 5000,
            freePlay: true,
            toWinUsd: 100000,
            picks: 9,
            lostUsd: 5000,
          }),
        ],
      }),
    );
    const severities = review.findings.map((finding) => finding.severity);
    const rank = { info: 0, low: 1, medium: 2, high: 3 } as const;
    const ranks = severities.map((severity) => rank[severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect("score" in review).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Limitations and presence                                                   */
/* -------------------------------------------------------------------------- */

describe("limitations", () => {
  test("a missing book is reported as a limitation, not as a zero-score customer", () => {
    const review = buildCustomerWagerReview(
      loaded({ book: { totalCustomers: 4, found: false }, graded: [graded()] }),
    );
    expect(
      review.limitations.some((line) =>
        line.includes("does not carry this customer"),
      ),
    ).toBe(true);
  });

  test("an old capture is named with its age", () => {
    const review = buildCustomerWagerReview(
      loaded({
        pending: [pending()],
        pendingCapture: {
          rows: 250,
          customers: 127,
          riskUsd: 3_347_557,
          toWinUsd: 8_371_185,
          capturedAt: "2026-11-16T15:00:00.000Z",
          acceptEqualsGame: 250,
        },
      }),
    );
    expect(
      review.limitations.some((line) =>
        line.includes("minute(s) old at review time"),
      ),
    ).toBe(true);
    expect(review.pending.share.riskPct).toBeCloseTo(0.06, 2);
  });

  test("a not-found login is found:false with every source still reported", () => {
    const review = buildCustomerWagerReview(loaded());
    expect(review.found).toBe(false);
    expect(review.sources).toHaveLength(8);
    expect(review.sources.every((source) => source.matchedRows === 0)).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

async function writeFixture(
  root: string,
  relative: string,
  value: unknown,
): Promise<void> {
  const path = join(root, relative);
  const directory = path.slice(0, path.lastIndexOf("/"));
  if (directory !== "") mkdirSync(directory, { recursive: true });
  await Bun.write(path, JSON.stringify(value));
}

describe("loader", () => {
  test("de-duplicates rows that two overlapping graded exports both carry", () => {
    const deduped = dedupeGradedRows([
      graded({ ticket: "T1", wagerNumber: "1", source: "a.json" }),
      graded({ ticket: "T1", wagerNumber: "1", source: "b.json" }),
      graded({ ticket: "T1", wagerNumber: "2", source: "b.json" }),
    ]);
    expect(deduped.rows).toHaveLength(2);
    expect(deduped.duplicates).toEqual([
      { key: "T1-1", keptFrom: "a.json", droppedFrom: "b.json" },
    ]);
  });

  test("reports missing files as missing, never as zero rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "wager-review-empty-"));
    try {
      const loadedArtifacts = await loadCustomerWagerArtifacts({
        customerId: "TTN97",
        root,
      });
      expect(loadedArtifacts.sources.every((source) => !source.exists)).toBe(
        true,
      );
      expect(loadedArtifacts.pending).toHaveLength(0);
      expect(loadedArtifacts.graded).toHaveLength(0);
      expect(loadedArtifacts.book).toBeNull();
      const review = buildCustomerWagerReview(loadedArtifacts);
      expect(review.found).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("joins the real artifact shapes and keeps the free-play and ledger totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "wager-review-fixture-"));
    try {
      await writeFixture(root, "data/live-bets.json", {
        capturedAt: "2026-11-16T17:20:00.006Z",
        pendingCount: 1,
        games: [
          {
            customerID: "TTN97",
            ticketNumber: "769168945",
            wagerNumber: "1",
            chosenTeam: "Ben Kohles +1600",
            description:
              "Golf - / Tournament / Outright Winner / Ben Kohles +1600",
            sport: "Golf",
            subSport: "Outright Winner",
            period: "Tournament",
            wagered: 2000,
            toWin: 32000,
            status: "P",
            acceptedAt: "2026-11-16 11:35:43.357",
            gameDateTime: "2026-11-16 11:35:43.357",
            picks: 1,
            agent: { key: "1RODDY." },
          },
        ],
      });
      await writeFixture(root, "data/live-wagers.json", {
        LIST: [
          {
            CustomerID: "TTN97     ",
            Login: "TTN97",
            AgentID: "1RODDY.",
            WagerNumber: 769168945,
            AmountWagered: 2000,
            ToWinAmount: 32000,
            InsertDateTime: "2026-11-16 11:35:43.357",
            ShortDesc: "Golf / Ben Kohles +1600",
            TicketWriter: "GSLIVE",
            WagerType: "M",
          },
        ],
      });
      await writeFixture(root, "Scratch/graded/graded-today.json", [
        {
          CustomerID: "TTN97     ",
          TicketNumber: "1078606016",
          WagerNumber: "1",
          TotalPicks: "2",
          WagerType: "P",
          AmountWagered: "5000.0",
          ToWinAmount: "6179.0",
          AmountWon: "6179.0",
          AmountLost: "0.0",
          AmountRefunded: "0.0",
          WagerStatus: "W",
          AcceptedDateTime: "2026-11-12 08:55:22.883",
          FreePlayFlag: "N",
          CreditAcctFlag: "Y",
          TicketWriter: "Internet",
          Description: "Soccer #234009 Spain -165",
        },
      ]);
      await writeFixture(
        root,
        "Scratch/gslive-reports-2026-11-08/users-report-1793509200-1794203999.json",
        [
          {
            userId: "2292465",
            partnerUserId: "TTN97",
            partnerId: 118,
            groupName: "PLAYER_TTN97",
            agent: "1RODDY.",
            isSuspectedBot: false,
            risk: 20,
            toWin: 167.03,
            profit: 0,
            bet: 20,
            wagerCount: 1,
            legCount: "2",
          },
        ],
      );
      await writeFixture(root, "Scratch/raw-f402-list-agents.json", {
        PLAYERS: [
          { customerID: "TTN97     ", Login: "TTN97", Agent: "1RODDY." },
        ],
      });
      await writeFixture(
        root,
        "Scratch/f402-suspected-bots-raw-ledger-bundle.json",
        {
          customerLedgerTenure: {
            TTN97: {
              totalTickets: 1,
              preWindowTickets: 0,
              inWindowTickets: 1,
              totalWageredCents: 5000,
              totalNetCents: 6179,
              firstAcceptedDateTime: "2026-11-12 08:55:22.883",
              lastAcceptedDateTime: "2026-11-12 08:55:22.883",
              writers: ["Internet"],
            },
          },
        },
      );
      await writeFixture(root, "enriched_customers_full.json", [
        { customer_id: "OTHER", agent_id: "X" },
      ]);

      const paths = await resolveReviewArtifactPaths(root);
      expect(paths.pending).toBe(join(root, "data/live-bets.json"));
      expect(paths.usersReports[0]).toContain("users-report-1793509200");

      const loadedArtifacts = await loadCustomerWagerArtifacts({
        customerId: "player_TTN97",
        root,
        nowMs: Date.parse("2026-11-16T18:51:27.000Z"),
      });
      expect(loadedArtifacts.customerId).toBe("TTN97");
      expect(loadedArtifacts.pending).toHaveLength(1);
      expect(loadedArtifacts.pending[0]?.riskUsd).toBe(20); // 2000 cents
      expect(loadedArtifacts.ticker).toHaveLength(1);
      expect(loadedArtifacts.graded).toHaveLength(1);
      expect(loadedArtifacts.users).toHaveLength(1);
      expect(loadedArtifacts.roster).toHaveLength(1);
      expect(loadedArtifacts.book).toEqual({ totalCustomers: 1, found: false });
      expect(loadedArtifacts.pendingCapture.rows).toBe(1);
      expect(loadedArtifacts.pendingCapture.acceptEqualsGame).toBe(1);

      const review = buildCustomerWagerReview(loadedArtifacts);
      expect(review.found).toBe(true);
      expect(review.identity.agent).toBe("1RODDY.");
      expect(review.identity.userIds).toEqual(["2292465"]);
      expect(review.identity.suspectedBot).toBe(false);
      expect(review.pending.riskUsd).toBe(20);
      expect(review.pending.toWinUsd).toBe(320);
      expect(review.settled.netUsd).toBe(61.79);
      expect(review.ledger?.matchesSettled).toBe(true);
      expect(review.ledger?.netUsd).toBe(61.79);
      expect(review.platform?.days).toEqual(["2026-11-12"]);
      expect(review.platform?.rows).toBe(1);
      expect(review.expectation.expectedWins).toBe(0.45);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("picks the newest users export that carries the customer, not the newest overall", async () => {
    const root = mkdtempSync(join(tmpdir(), "wager-review-users-"));
    try {
      const directory = join(root, "Scratch/gslive-reports-2026-11-08");
      mkdirSync(directory, { recursive: true });
      const older = join(directory, "users-report-1-2.json");
      const newer = join(directory, "users-report-3-4.json");
      await Bun.write(
        older,
        JSON.stringify([{ partnerUserId: "TTN97", userId: "1", agent: "A" }]),
      );
      await Bun.write(
        newer,
        JSON.stringify([{ partnerUserId: "OTHER", userId: "2", agent: "B" }]),
      );
      // Make the OTHER export newer: a newest-only loader would lose TTN97's identity row.
      utimesSync(
        older,
        new Date(2026, 10, 8, 16, 0),
        new Date(2026, 10, 8, 16, 0),
      );
      utimesSync(
        newer,
        new Date(2026, 10, 8, 17, 0),
        new Date(2026, 10, 8, 17, 0),
      );

      const loadedArtifacts = await loadCustomerWagerArtifacts({
        customerId: "TTN97",
        root,
      });
      expect(loadedArtifacts.users).toHaveLength(1);
      expect(loadedArtifacts.users[0]?.agent).toBe("A");
      expect(loadedArtifacts.matched.users_report).toBe(1);
      const source = loadedArtifacts.sources.find(
        (entry) => entry.id === "users_report",
      );
      expect(source?.path).toBe(older);
      expect(source?.note).toContain("scanned 2 export(s)");
      expect(source?.note).toContain("customer present in 1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes the raw wire shapes it is given", () => {
    expect(
      pendingWagerRows({
        games: [
          { customerID: "a", chosenTeam: "X +100", wagered: 1, toWin: 1 },
        ],
      })[0]?.customerId,
    ).toBe("A");
    expect(
      usersReportRows([{ partnerUserId: "b", isSuspectedBot: true }])[0]
        ?.suspectedBot,
    ).toBe(true);
    expect(bookPresence([{ customer_id: "c" }], "C")).toEqual({
      totalCustomers: 1,
      found: true,
    });
    expect(
      ledgerTenure(
        {
          customerLedgerTenure: {
            D: { totalTickets: 2, totalWageredCents: 1000 },
          },
        },
        "D",
      )?.wageredUsd,
    ).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

describe("CLI", () => {
  function makeCliFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "wager-review-cli-"));
    const directory = join(root, "Scratch/graded");
    Bun.spawnSync(["mkdir", "-p", directory]);
    Bun.write(
      join(root, "data/live-bets.json"),
      JSON.stringify({
        capturedAt: "2026-11-16T17:20:00.006Z",
        games: [
          {
            customerID: "TTN97",
            ticketNumber: "T1",
            wagerNumber: "1",
            chosenTeam: "Ben Kohles +1600",
            sport: "Golf",
            subSport: "Outright Winner",
            period: "Tournament",
            wagered: 2000,
            toWin: 32000,
            acceptedAt: "2026-11-16 11:35:43.357",
            gameDateTime: "2026-11-16 11:35:43.357",
            picks: 1,
            agent: { key: "1RODDY." },
          },
        ],
      }),
    );
    Bun.write(
      join(directory, "graded-today.json"),
      JSON.stringify([
        {
          CustomerID: "TTN97",
          TicketNumber: "G1",
          WagerNumber: "1",
          TotalPicks: "2",
          AmountWagered: "100.0",
          ToWinAmount: "200.0",
          AmountWon: "0.0",
          AmountLost: "100.0",
          WagerStatus: "L",
          AcceptedDateTime: "2026-11-11 09:01:52.780",
          FreePlayFlag: "N",
          CreditAcctFlag: "Y",
          TicketWriter: "Internet",
          Description: "Soccer #1 Spain -165",
        },
      ]),
    );
    return root;
  }

  test("--json emits a lossless review and a not-found login exits 3", () => {
    const root = makeCliFixture();
    try {
      const ok = Bun.spawnSync(
        [
          process.execPath,
          "scripts/customer_wager_review.ts",
          "TTN97",
          "--json",
          "--root",
          root,
        ],
        { cwd: REPO, stdout: "pipe", stderr: "pipe" },
      );
      expect(ok.exitCode).toBe(0);
      const parsed = JSON.parse(ok.stdout.toString()) as {
        success: boolean;
        found: boolean;
        customerId: string;
        pending: { riskUsd: number };
        settled: { netUsd: number; rows: number };
        findings: unknown[];
      };
      expect(parsed.success).toBe(true);
      expect(parsed.found).toBe(true);
      expect(parsed.customerId).toBe("TTN97");
      expect(parsed.pending.riskUsd).toBe(20);
      expect(parsed.settled.rows).toBe(1);
      expect(parsed.settled.netUsd).toBe(-1);
      expect(Array.isArray(parsed.findings)).toBe(true);

      const missing = Bun.spawnSync(
        [
          process.execPath,
          "scripts/customer_wager_review.ts",
          "NOPE",
          "--json",
          "--root",
          root,
        ],
        { cwd: REPO, stdout: "pipe", stderr: "pipe" },
      );
      expect(missing.exitCode).toBe(3);
      const missingParsed = JSON.parse(missing.stdout.toString()) as {
        found: boolean;
        error: { code: string };
        sources: unknown[];
      };
      expect(missingParsed.found).toBe(false);
      expect(missingParsed.error.code).toBe("unknown_customer");
      expect(missingParsed.sources).toHaveLength(8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--deep adds peers and platform context", () => {
    const root = makeCliFixture();
    try {
      const out = Bun.spawnSync(
        [
          process.execPath,
          "scripts/customer_wager_review.ts",
          "TTN97",
          "--deep",
          "--root",
          root,
        ],
        { cwd: REPO, stdout: "pipe", stderr: "pipe" },
      );
      expect(out.exitCode).toBe(0);
      const text = out.stdout.toString();
      expect(text).toContain("peers");
      expect(text).toContain("platform");
      expect(text).toContain("settled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("usage exits 2 and --help exits 0", () => {
    const noArgs = Bun.spawnSync(
      [process.execPath, "scripts/customer_wager_review.ts"],
      { cwd: REPO, stdout: "pipe", stderr: "pipe" },
    );
    expect(noArgs.exitCode).toBe(2);
    const help = Bun.spawnSync(
      [process.execPath, "scripts/customer_wager_review.ts", "--help"],
      { cwd: REPO, stdout: "pipe", stderr: "pipe" },
    );
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("wagers:review");
  });
});

/* -------------------------------------------------------------------------- */
/* Card reconstruction                                                        */
/* -------------------------------------------------------------------------- */

describe("wager card", () => {
  const legText = (rot: number, sel: string, price: number): string =>
    `Soccer #23400${rot} ${sel} ${price} - For Game `;

  function row(
    wagerNumber: number,
    picks: number,
    legs: Array<[number, string, number]>,
    status: "W" | "L",
    riskUsd: number,
    toWinUsd: number,
  ): GradedWagerRow {
    return graded({
      ticket: "CARD1",
      wagerNumber: String(wagerNumber),
      picks,
      status,
      riskUsd,
      toWinUsd,
      profitUsd: status === "W" ? toWinUsd : 0,
      lostUsd: status === "W" ? 0 : riskUsd,
      description: legs
        .map(([rot, sel, price]) => legText(rot, sel, price))
        .join(""),
    });
  }

  // A and B and C win; D loses. Numbering is identity order over A,B,C,D:
  // 2-leg slots 1..6, 3-leg slots 7..10, 4-leg slot 11.
  const A: [number, string, number] = [1, "A", -110];
  const B: [number, string, number] = [2, "B", -110];
  const C: [number, string, number] = [3, "C", -110];
  const D: [number, string, number] = [4, "D", -110];
  const twoLegWin = 10 * (1.909 ** 2 - 1);
  const threeLegWin = 10 * (1.909 ** 3 - 1);
  const rows = [
    row(1, 2, [A, B], "W", 10, twoLegWin),
    row(2, 2, [A, C], "W", 10, twoLegWin),
    row(3, 2, [A, D], "L", 10, 0),
    row(4, 2, [B, C], "W", 10, twoLegWin),
    row(5, 2, [B, D], "L", 10, 0),
    row(7, 3, [A, B, C], "W", 10, threeLegWin),
    row(11, 4, [A, B, C, D], "L", 10, 0),
  ];

  test("parses the concatenated leg text of a wager", () => {
    const legs = parseWagerLegs(
      "Soccer #234009 Spain -180 - For 1st Half Soccer #234013 Belarus -225 - For 1st Half ",
    );
    expect(legs).toHaveLength(2);
    expect(legs[0]?.selection).toBe("Spain");
    expect(legs[0]?.priceAmerican).toBe(-180);
    expect(legs[1]?.period).toBe("For 1st Half");
    expect(
      parseWagerLegs("BASEBALL - #MLB Futures - Chicago Cubs +1800 for Game"),
    ).toHaveLength(0);
  });

  test("reconstructs slots, outcomes and the omitted complement", () => {
    const card = reconstructWagerCard(rows);
    expect(card).not.toBeNull();
    if (card === null) return;
    expect(card.reason).toBeNull();
    expect(card.slots).toBe(11);
    expect(card.bookedSlots).toBe(7);
    expect(card.omittedSlots).toBe(4);
    expect(card.winners).toEqual(["A", "B", "C"]);
    expect(card.losers).toEqual(["D"]);
    expect(
      card.layers.map((layer) => [layer.picks, layer.slots, layer.booked]),
    ).toEqual([
      [2, 6, 5],
      [3, 4, 1],
      [4, 1, 1],
    ]);
    expect(card.coverage?.allWinnerBooked).toBe(4);
    expect(card.coverage?.allWinnerSlots).toBe(4);
    expect(card.coverage?.hasLoserBookingRatePct).toBeCloseTo(42.86, 2);
    const bookedNet = card.layers.reduce(
      (total, layer) => total + layer.netUsd,
      0,
    );
    expect(bookedNet).toBeCloseTo(108.9, 1);
    // The four omitted slots are all losers at the median stake, so they subtract from the card.
    expect(card.counterfactualNetUsd).toBeCloseTo(68.9, 1);
    expect(card.probability?.allLegsPct).toBeCloseTo(7.54, 1);
    expect(card.probability?.realizedWinners).toBe(3);
  });

  test("refuses a ticket whose wager numbers do not fit one ordering", () => {
    const broken = [...rows];
    broken[5] = { ...broken[5]!, wagerNumber: "6" }; // duplicate slot, no lexicographic fit
    const card = reconstructWagerCard(broken);
    expect(card).not.toBeNull();
    expect(card?.reason).toContain("No unique leg order");
    expect(card?.counterfactualNetUsd).toBeNull();
  });

  test("corpus norms carry n and count refusals by reason", () => {
    const corpus = [
      ...rows,
      // Unparseable leg text: the solver refuses and the refusal is counted, not silently dropped.
      { ...rows[0]!, ticket: "BAD1", customerId: "X", description: "" },
      { ...rows[1]!, ticket: "BAD1", customerId: "X", description: "" },
      // Parsable but no numbering fits: a distinct refusal reason.
      {
        ...row(1, 2, [A, B], "W", 10, twoLegWin),
        ticket: "BAD2",
        customerId: "Y",
      },
      {
        ...row(99, 2, [A, C], "W", 10, twoLegWin),
        ticket: "BAD2",
        customerId: "Y",
      },
    ];
    const norms = summarizeCardCorpus(corpus);
    expect(norms.candidateTickets).toBe(3);
    expect(norms.solved).toBe(1);
    expect(norms.refused).toBe(1);
    expect(norms.unparseable).toBe(1);
    expect(norms.bookingRatesPct).toEqual([63.64]);
    expect(norms.medianBookingPct).toBe(63.64);
    expect(norms.refusalReasons.no_unique_order).toBe(1);
    expect(norms.refusalReasons.unparseable_or_oversized).toBe(1);
    expect(norms.comparable.n).toBe(0); // the 7-row card is below the >=10 band
    expect(norms.note).toContain("reconstructable subsample");
    expect(norms.note).toContain("no unique numbering fit");
    expect(norms.note).not.toContain("unparseable leg text");
  });

  test("the >=10-wager band is reported next to the pooled list", () => {
    const five: Array<[number, string, number]> = [
      [11, "V", -110],
      [12, "W", -110],
      [13, "X", -110],
      [14, "Y", -110],
      [15, "Z", -110],
    ];
    const combos: Array<[number, number]> = [];
    for (let i = 0; i < five.length; i += 1) {
      for (let j = i + 1; j < five.length; j += 1) combos.push([i, j]);
    }
    const bigCard = combos.map(([i, j], index) => ({
      ...row(
        index + 1,
        2,
        [five[i]!, five[j]!],
        index === 0 ? "W" : "L",
        10,
        index === 0 ? twoLegWin : 0,
      ),
      ticket: "BIG",
      customerId: "Z",
    }));
    const norms = summarizeCardCorpus(bigCard);
    expect(norms.candidateTickets).toBe(1);
    expect(norms.solved).toBe(1);
    expect(norms.bookingRatesPct).toEqual([100]);
    expect(norms.medianBookingPct).toBe(100);
    expect(norms.comparable.n).toBe(1);
    expect(norms.comparable.minWagers).toBe(10);
    expect(norms.comparable.medianPct).toBe(100);
    expect(norms.note).toContain(">=10-wager band");
  });

  test("a burst ticket with unparseable descriptions stays unreconstructed", () => {
    const card = reconstructWagerCard(
      Array.from({ length: 3 }, (_, index) =>
        graded({
          ticket: "X",
          wagerNumber: String(index + 1),
          picks: 2,
          description: "",
        }),
      ),
    );
    expect(card).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Expectation, peers, platform                                               */
/* -------------------------------------------------------------------------- */

describe("deep context", () => {
  test("expected wins are the sum of the book's implied probabilities", () => {
    const review = buildCustomerWagerReview(
      loaded({
        graded: [
          graded({
            riskUsd: 100,
            toWinUsd: 100,
            status: "W",
            profitUsd: 100,
            lostUsd: 0,
          }),
          graded({
            wagerNumber: "2",
            riskUsd: 100,
            toWinUsd: 300,
            status: "L",
          }),
        ],
      }),
    );
    expect(review.expectation.expectedWins).toBeCloseTo(0.75, 4);
    expect(review.expectation.actualWins).toBe(1);
    expect(review.expectation.delta).toBeCloseTo(0.25, 4);
  });

  test("peer percentiles are computed over the tenure population", () => {
    const review = buildCustomerWagerReview(
      loaded({
        graded: [
          graded({ riskUsd: 10, status: "W", profitUsd: 10, lostUsd: 0 }),
          graded({ wagerNumber: "2", riskUsd: 10 }),
          graded({ wagerNumber: "3", riskUsd: 10 }),
        ],
        ledgerPopulation: [
          { tickets: 1, wageredUsd: 10, netUsd: -5 },
          { tickets: 2, wageredUsd: 20, netUsd: -10 },
          { tickets: 3, wageredUsd: 30, netUsd: 5 },
          { tickets: 4, wageredUsd: 40, netUsd: 10 },
        ],
      }),
    );
    expect(review.peers?.population).toBe(4);
    expect(review.peers?.tickets.value).toBe(3);
    expect(review.peers?.tickets.percentile).toBe(50);
    expect(review.peers?.tickets.p90).toBe(4);
    expect(review.peers?.handleUsd.value).toBe(30);
  });

  test("platform context is computed on the customer's own activity days", () => {
    const rows = [
      graded({
        customerId: "TTN97",
        placedAt: "2026-11-12 08:55:22.883",
        ticket: "T1",
        riskUsd: 50,
        picks: 2,
      }),
      graded({
        customerId: "TTN97",
        wagerNumber: "2",
        placedAt: "2026-11-12 08:56:00.000",
        ticket: "T1",
        riskUsd: 50,
        picks: 2,
      }),
      graded({
        customerId: "OTHER",
        placedAt: "2026-11-12 09:00:00.000",
        ticket: "T2",
        riskUsd: 100,
        picks: 1,
      }),
      graded({
        customerId: "OTHER",
        wagerNumber: "2",
        placedAt: "2026-11-13 09:00:00.000",
        ticket: "T3",
        riskUsd: 200,
        picks: 1,
      }),
    ];
    const context = platformDayContext(rows, ["2026-11-12"]);
    expect(context).not.toBeNull();
    expect(context?.rows).toBe(3);
    expect(context?.customers).toBe(2);
    expect(context?.multiLegSharePct).toBeCloseTo(66.67, 2);
    expect(context?.medianStakeUsd).toBe(50);
    expect(context?.largestMultiLegTicket?.customerId).toBe("TTN97");
    expect(context?.largestMultiLegTicket?.wagers).toBe(2);
    expect(context?.days).toEqual(["2026-11-12"]);
  });
});
