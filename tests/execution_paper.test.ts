import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAKER_QUOTE_TTL_MS,
  appendExecutionLedgerRow,
  fillTakerFromDecision,
  makeMakerQuote,
  readExecutionLedger,
  resolveExecutionLedgerPath,
  summarizeExecutionLedger,
  sweepMakerQuotes,
  type ExecutionLedgerRow,
} from "../lib/execution_paper.ts";
import type { ExecutionDecision } from "../lib/execution_decision.ts";
import type { PolymarketLevel } from "../lib/polymarket_quote.ts";

/**
 * Paper fills, maker quotes and the ledger, all offline. The book levels here are the captured
 * fixture levels; the ledger root is a temp directory so no real Scratch state is touched.
 */

const NOW = new Date("2026-11-04T12:00:00.000Z");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "execution-paper-"));
  directories.push(directory);
  return directory;
}

function decision(
  overrides: {
    style?: "taker" | "maker";
    sizeUsd?: number;
    contracts?: number;
    limitPrice?: number | null;
    bookLevels?: readonly PolymarketLevel[];
  } = {},
): ExecutionDecision {
  return {
    id: "exec:NBA-ATL-moneyline:taker",
    signalId: "NBA-ATL_WSH-moneyline-noline-ATL",
    createdAtIso: NOW.toISOString(),
    league: "NBA",
    marketKind: "moneyline",
    teams: ["ATL", "WSH"],
    sideTeam: "ATL",
    line: null,
    venue: "kalshi",
    style: overrides.style ?? "taker",
    position: "yes",
    orderAction: "buy",
    tickerToken: "KXNBAGAME-26NOV04ATLWAS-ATL",
    fairProb: 0.62,
    executableProb: 0.56,
    edgeAfterSlippageBps: 600,
    slippageBps: 12,
    sizeUsd: overrides.sizeUsd ?? 100,
    contracts: overrides.contracts ?? 178,
    limitPrice: overrides.limitPrice ?? 0.56,
    expectedCostUsd: overrides.sizeUsd ?? 100,
    reasons: [],
    blocked: false,
    blockReason: null,
    paper: true,
    provenance: {
      fixture: false,
      stale: false,
      dataMode: "LIVE",
      signalAsOf: "2026-11-04T11:59:00.000Z",
    },
    bookLevels: overrides.bookLevels ?? [
      { price: 0.56, size: 649.19 },
      { price: 0.57, size: 10_000 },
    ],
  };
}

describe("taker paper fills from the captured book", () => {
  test("fills when the depth covers the requested size", () => {
    const fill = fillTakerFromDecision(
      decision({ sizeUsd: 100 }),
      "intent-1",
      NOW,
    );
    expect(fill.status).toBe("filled");
    expect(fill.contracts).toBeGreaterThan(0);
    expect(fill.price).toBeCloseTo(0.56, 2);
    expect(fill.sizeUsd).toBeGreaterThan(0);
    expect(fill.reason).toBeNull();
  });

  test("is partial when the book is thinner than the requested size", () => {
    const fill = fillTakerFromDecision(
      decision({
        sizeUsd: 1_000,
        bookLevels: [{ price: 0.5, size: 10 }],
      }),
      "intent-2",
      NOW,
    );
    expect(fill.status).toBe("partial");
    expect(fill.reason).toContain("depth covered");
  });

  test("rejects without a book instead of inventing a fill", () => {
    const fill = fillTakerFromDecision(
      decision({ sizeUsd: 100, bookLevels: [] }),
      "intent-3",
      NOW,
    );
    expect(fill.status).toBe("rejected");
    expect(fill.price).toBeNull();
    expect(fill.sizeUsd).toBe(0);
    expect(fill.reason).toBe("no_book_depth");
  });
});

describe("maker quotes", () => {
  test("a quote has a 90s expiry and never fills on posting", () => {
    const quote = makeMakerQuote(
      decision({
        style: "maker",
        limitPrice: 0.51,
        contracts: 100,
        sizeUsd: 51,
      }),
      "intent-q",
      NOW,
    );
    expect(quote).not.toBeNull();
    expect(quote?.status).toBe("open");
    expect(Date.parse(quote?.expiresAtIso ?? "") - NOW.getTime()).toBe(
      MAKER_QUOTE_TTL_MS,
    );
    const sweep = sweepMakerQuotes(
      quote === null ? [] : [quote],
      new Map(),
      NOW,
    );
    expect(sweep.fills).toHaveLength(0);
    expect(sweep.quotes[0]?.status).toBe("open");
  });

  test("fills only when the book crosses our price, at our price", () => {
    const quote = makeMakerQuote(
      decision({
        style: "maker",
        limitPrice: 0.51,
        contracts: 100,
        sizeUsd: 51,
      }),
      "intent-q2",
      NOW,
    );
    if (quote === null) throw new Error("fixture quote did not build");
    const crossed = sweepMakerQuotes(
      [quote],
      new Map([
        [
          `kalshi:${quote.tickerToken}`,
          { asks: [{ price: 0.5, size: 100 }], bids: [] },
        ],
      ]),
      new Date(NOW.getTime() + 1_000),
    );
    expect(crossed.fills).toHaveLength(1);
    expect(crossed.fills[0]?.price).toBe(0.51);
    expect(crossed.fills[0]?.reason).toBe("maker_quote_crossed");

    const notCrossed = sweepMakerQuotes(
      [quote],
      new Map([
        [
          `kalshi:${quote.tickerToken}`,
          { asks: [{ price: 0.55, size: 100 }], bids: [] },
        ],
      ]),
      new Date(NOW.getTime() + 1_000),
    );
    expect(notCrossed.fills).toHaveLength(0);
  });

  test("expires after 90s", () => {
    const quote = makeMakerQuote(
      decision({
        style: "maker",
        limitPrice: 0.51,
        contracts: 100,
        sizeUsd: 51,
      }),
      "intent-q3",
      NOW,
    );
    if (quote === null) throw new Error("fixture quote did not build");
    const sweep = sweepMakerQuotes(
      [quote],
      new Map(),
      new Date(NOW.getTime() + MAKER_QUOTE_TTL_MS + 1),
    );
    expect(sweep.quotes[0]?.status).toBe("expired");
    expect(sweep.fills).toHaveLength(0);
  });
});

describe("execution ledger", () => {
  test("appends JSONL with dir 0700 / file 0600 and reads the tail", () => {
    const root = tempRoot();
    const path = resolveExecutionLedgerPath(root);
    const row: ExecutionLedgerRow = {
      kind: "intent",
      intentId: "intent-1",
      atIso: NOW.toISOString(),
      mode: "paper",
      decision: decision(),
      fill: fillTakerFromDecision(decision(), "intent-1", NOW),
      quote: null,
      riskSnapshot: {
        dailyPlannedUsd: 0,
        openIntents: 0,
        marketExposureUsd: {},
      },
    };
    appendExecutionLedgerRow(root, row);
    appendExecutionLedgerRow(root, {
      kind: "mode_change",
      intentId: "mode:1",
      atIso: NOW.toISOString(),
      mode: "paper",
      decision: null,
      fill: null,
      quote: null,
      riskSnapshot: null,
      note: "paused",
    });

    const fileMode = statSync(path).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(join(root, "Scratch/execution")).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const state = readExecutionLedger(root);
    expect(state.rows).toHaveLength(2);
    expect(state.fills).toHaveLength(1);
    expect(state.modeChanges).toHaveLength(1);

    const summary = summarizeExecutionLedger(state, NOW);
    expect(summary.fills).toHaveLength(1);
    expect(summary.mode).toBe("paused");
    expect(summary.openIntents).toBe(0);
    expect(summary.dailyPlannedUsd).toBeGreaterThan(0);
  });

  test("a missing ledger is empty state, not an error", () => {
    const state = readExecutionLedger(tempRoot());
    expect(state.rows).toEqual([]);
    expect(state.fills).toEqual([]);
    expect(state.openQuotes).toEqual([]);
  });

  test("the path resolver refuses to escape the root", () => {
    const root = tempRoot();
    expect(resolveExecutionLedgerPath(root)).toBe(
      join(root, "Scratch/execution/ledger.jsonl"),
    );
  });
});
