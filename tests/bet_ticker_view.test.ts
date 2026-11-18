import { describe, expect, test } from "bun:test";
import {
  BET_TICKER_TSV_HEADER,
  betTickerRowsToTsv,
  nextBetTickerSort,
  sortBetTickerRows,
} from "../packages/ui/src/bet_ticker_view.ts";
import type { BetTickerTicketRow } from "../packages/ui/src/types.ts";

function ticket(over: Partial<BetTickerTicketRow>): BetTickerTicketRow {
  return {
    wagerNumber: 9001,
    ticketId: "9001",
    customerId: "GP301",
    agentId: "FAKEMONEY",
    masterAgent: "TRACKTHIS",
    ticketWriter: "Internet",
    writer: "internet",
    wagerType: "S",
    wagerTypeLabel: "Spread",
    amountWageredCents: 50000,
    volumeAmountCents: 50000,
    toWinAmountCents: 45000,
    volumeDiffers: false,
    isSentinelNoise: false,
    vip: false,
    live: false,
    insertedAt: "2026-11-12T18:00:00Z",
    legCount: 1,
    shortDesc: "[NFL] Chiefs -3",
    sport: "NFL",
    selection: "Chiefs -3",
    alertFlags: ["HIGH_STAKE"],
    ...over,
  };
}

describe("bet_ticker_view · sorting", () => {
  const rows = [
    ticket({
      wagerNumber: 9001,
      ticketId: "9001",
      amountWageredCents: 1000,
      insertedAt: "2026-11-12T18:00:00Z",
    }),
    ticket({
      wagerNumber: 10000,
      ticketId: "10000",
      amountWageredCents: 3000,
      insertedAt: "2026-11-12T19:00:00Z",
    }),
    ticket({
      wagerNumber: 9002,
      ticketId: "9002",
      amountWageredCents: 3000,
      insertedAt: null,
    }),
  ];

  test("ticket sort is numeric, not lexicographic", () => {
    const sorted = sortBetTickerRows(rows, {
      field: "ticket",
      direction: "asc",
    });
    expect(sorted.map((row) => row.ticketId)).toEqual([
      "9001",
      "9002",
      "10000",
    ]);
  });

  test("time sort keeps null timestamps last in both directions", () => {
    const desc = sortBetTickerRows(rows, { field: "time", direction: "desc" });
    expect(desc.map((row) => row.ticketId)).toEqual(["10000", "9001", "9002"]);
    const asc = sortBetTickerRows(rows, { field: "time", direction: "asc" });
    expect(asc.map((row) => row.ticketId)).toEqual(["9001", "10000", "9002"]);
  });

  test("amount sorts break ties on wager number and preserve the input", () => {
    const sorted = sortBetTickerRows(rows, {
      field: "wagered",
      direction: "desc",
    });
    expect(sorted.map((row) => row.ticketId)).toEqual([
      "10000",
      "9002",
      "9001",
    ]);
    expect(rows.map((row) => row.ticketId)).toEqual(["9001", "10000", "9002"]);
  });

  test("a null sort returns the original stream untouched", () => {
    expect(sortBetTickerRows(rows, null)).toBe(rows);
  });

  test("header toggles direction on the same field and resets on a new one", () => {
    expect(nextBetTickerSort(null, "ticket")).toEqual({
      field: "ticket",
      direction: "desc",
    });
    expect(
      nextBetTickerSort({ field: "ticket", direction: "desc" }, "ticket"),
    ).toEqual({ field: "ticket", direction: "asc" });
    expect(
      nextBetTickerSort({ field: "ticket", direction: "asc" }, "wagered"),
    ).toEqual({ field: "wagered", direction: "desc" });
  });
});

describe("bet_ticker_view · TSV export", () => {
  test("exports every filtered row with a stable header", () => {
    const tsv = betTickerRowsToTsv([
      ticket({ alertFlags: ["HIGH_STAKE", "VIP"] }),
      ticket({ ticketId: "9002", wagerNumber: 9002, live: true }),
    ]);
    const lines = tsv.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(BET_TICKER_TSV_HEADER.join("\t"));
    expect(lines[1]).toContain(
      "9001\tGP301\tFAKEMONEY\tTRACKTHIS\tInternet\tS\tNFL\tChiefs -3\t500.00\t500.00\t450.00\t1\tpregame\tHIGH_STAKE,VIP",
    );
    expect(lines[2]).toContain("\tlive\t");
    expect(tsv.endsWith("\n")).toBe(true);
  });

  test("sanitizes tabs/newlines and formats cents as USD", () => {
    const tsv = betTickerRowsToTsv([
      ticket({ selection: "Chiefs\t-3\nALT", amountWageredCents: 1234 }),
    ]);
    expect(tsv).toContain("Chiefs -3 ALT");
    expect(tsv).toContain("\t12.34\t");
    expect(tsv.split("\n")[1]?.includes("\t")).toBe(true);
  });

  test("an empty export is the header plus a newline", () => {
    expect(betTickerRowsToTsv([])).toBe(
      `${BET_TICKER_TSV_HEADER.join("\t")}\n`,
    );
  });
});
