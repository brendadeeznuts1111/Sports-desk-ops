/**
 * Paper execution + the append-only execution ledger.
 *
 * Paper is the demonstrated path: a taker decision fills against the captured book walk, a maker
 * decision becomes a resting quote with a 90s expiry that only fills when a later book actually
 * crosses it. Nothing here sends an order; live placement belongs to `lib/kalshi_live_execution.ts`
 * and is called only by the run route behind its gate.
 *
 * The ledger is one JSONL file under `Scratch/execution/` (dir 0700, file 0600) and the only place
 * this feature writes. `root` is a seam so tests use a temp directory; the path resolver refuses to
 * escape it.
 */
// Atomic append with an explicit 0600 mode: openSync/writeSync are the primitives Bun.write lacks.
// ast-grep-ignore: node-fs-read-write-file
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  // ast-grep-ignore: node-fs-read-write-file -- sync ledger reader; Bun.file is async.
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  EXECUTION_TICK,
  roundTick,
  roundUsd,
  walkBook,
  type ExecutionDecision,
  type ExecutionPosition,
  type ExecutionVenue,
} from "./execution_decision.ts";
import type { PolymarketLevel } from "./polymarket_quote.ts";

export const EXECUTION_LEDGER_RELATIVE = "Scratch/execution/ledger.jsonl";
export const EXECUTION_LEDGER_DIR_RELATIVE = "Scratch/execution";
export const MAKER_QUOTE_TTL_MS = 90_000;
export const LEDGER_TAIL_LIMIT = 200;

export interface PaperFill {
  readonly fillId: string;
  readonly intentId: string;
  readonly decisionId: string;
  readonly venue: ExecutionVenue;
  readonly tickerToken: string;
  readonly position: ExecutionPosition;
  readonly style: "taker";
  readonly status: "filled" | "partial" | "rejected";
  readonly price: number | null;
  readonly contracts: number;
  readonly sizeUsd: number;
  readonly slippageBps: number | null;
  readonly createdAtIso: string;
  readonly reason: string | null;
}

export interface PaperQuote {
  readonly quoteId: string;
  readonly intentId: string;
  readonly decisionId: string;
  readonly venue: ExecutionVenue;
  readonly tickerToken: string;
  readonly position: ExecutionPosition;
  readonly price: number;
  readonly contracts: number;
  readonly sizeUsd: number;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
  readonly status: "open" | "filled" | "expired";
}

export interface ExecutionRiskSnapshot {
  readonly dailyPlannedUsd: number;
  readonly openIntents: number;
  readonly marketExposureUsd: Readonly<Record<string, number>>;
}

export interface ExecutionLedgerRow {
  readonly kind: "intent" | "mode_change";
  readonly intentId: string;
  readonly atIso: string;
  readonly mode: "paper";
  readonly decision: ExecutionDecision | null;
  readonly fill: PaperFill | null;
  readonly quote: PaperQuote | null;
  readonly riskSnapshot: ExecutionRiskSnapshot | null;
  readonly note?: string;
}

export interface ExecutionLedgerState {
  readonly rows: readonly ExecutionLedgerRow[];
  readonly fills: readonly PaperFill[];
  readonly openQuotes: readonly PaperQuote[];
  readonly modeChanges: readonly ExecutionLedgerRow[];
}

/** The ledger file path for a root; refuses a root-relative path that would escape it. */
export function resolveExecutionLedgerPath(root: string): string {
  const base = resolve(root);
  const path = resolve(base, EXECUTION_LEDGER_RELATIVE);
  if (!path.startsWith(`${base}/`) && path !== base) {
    throw new Error("execution ledger path escapes the checkout root");
  }
  return path;
}

function ensureLedger(path: string): void {
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const descriptor = openSync(path, "a", 0o600);
    closeSync(descriptor);
  }
  try {
    chmodSync(dir, 0o700);
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) chmodSync(path, 0o600);
  } catch {
    // Permissions are best-effort on filesystems that do not model them; the write still happens.
  }
}

/** Append one ledger row; creates the dir 0700 / file 0600 on first use. */
export function appendExecutionLedgerRow(
  root: string,
  row: ExecutionLedgerRow,
): void {
  const path = resolveExecutionLedgerPath(root);
  ensureLedger(path);
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(row)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function parseLedgerRow(value: unknown): ExecutionLedgerRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "intent" && record["kind"] !== "mode_change")
    return null;
  if (typeof record["intentId"] !== "string") return null;
  if (typeof record["atIso"] !== "string") return null;
  return record as unknown as ExecutionLedgerRow;
}

/** Read the ledger tail (last 200 valid rows); a missing file is an empty state, not an error. */
export function readExecutionLedger(root: string): ExecutionLedgerState {
  const path = resolveExecutionLedgerPath(root);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { rows: [], fills: [], openQuotes: [], modeChanges: [] };
  }
  const rows: ExecutionLedgerRow[] = [];
  // Intentional hand-rolled JSONL loop; `Bun.JSONL.parse()` would drop every valid row after
  // the first malformed line. See `docs/bun-upstream-reference.md` "When NOT to migrate to Bun.JSONL".
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = parseLedgerRow(JSON.parse(line) as unknown);
      if (row !== null) rows.push(row);
    } catch {
      // A malformed line is skipped rather than failing the whole ledger.
    }
  }
  const tail = rows.slice(-LEDGER_TAIL_LIMIT);
  return {
    rows: tail,
    fills: tail.flatMap((row) =>
      row.fill !== null && row.fill.status !== "rejected" ? [row.fill] : [],
    ),
    openQuotes: tail.flatMap((row) =>
      row.quote !== null && row.quote.status === "open" ? [row.quote] : [],
    ),
    modeChanges: tail.filter((row) => row.kind === "mode_change"),
  };
}

export interface LedgerSummary {
  readonly dailyPlannedUsd: number;
  readonly openIntents: number;
  readonly marketExposureUsd: Readonly<Record<string, number>>;
  readonly recentIntents: readonly {
    readonly marketKey: string;
    readonly side: string;
    readonly atIso: string;
  }[];
  readonly fills: readonly PaperFill[];
  readonly openQuotes: readonly PaperQuote[];
  readonly ledgerTail: readonly ExecutionLedgerRow[];
  readonly mode: string | null;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Aggregate the ledger into the API/risk view; expired quotes are reported, not written. */
export function summarizeExecutionLedger(
  state: ExecutionLedgerState,
  now: Date,
): LedgerSummary {
  const today = now.toISOString().slice(0, 10);
  const plannedToday = state.fills.filter(
    (fill) => dayKey(fill.createdAtIso) === today,
  );
  const dailyPlannedUsd = roundUsd(
    plannedToday.reduce((sum, fill) => sum + fill.sizeUsd, 0),
  );
  const exposure: Record<string, number> = {};
  const recentIntents: Array<{
    marketKey: string;
    side: string;
    atIso: string;
  }> = [];
  for (const row of state.rows) {
    if (row.kind !== "intent" || row.decision === null) continue;
    const decision = row.decision;
    if (dayKey(row.atIso) !== today) continue;
    const key = [
      decision.league,
      [...decision.teams].sort().join("_"),
      decision.marketKind,
      decision.line === null ? "noline" : String(decision.line),
    ].join("|");
    const existing = exposure[key] ?? 0;
    exposure[key] = roundUsd(
      existing + (row.fill?.sizeUsd ?? row.quote?.sizeUsd ?? 0),
    );
    recentIntents.push({
      marketKey: key,
      side: decision.position ?? "none",
      atIso: row.atIso,
    });
  }
  const openQuotes = state.openQuotes.map((quote) =>
    quote.status === "open" && Date.parse(quote.expiresAtIso) <= now.getTime()
      ? { ...quote, status: "expired" as const }
      : quote,
  );
  const lastMode = state.modeChanges.at(-1);
  return {
    dailyPlannedUsd,
    openIntents: state.openQuotes.length,
    marketExposureUsd: exposure,
    recentIntents,
    fills: state.fills,
    openQuotes,
    ledgerTail: state.rows,
    mode:
      typeof lastMode?.note === "string" && lastMode.note !== ""
        ? lastMode.note
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Paper fills                                                                */
/* -------------------------------------------------------------------------- */

export function paperIntentId(decision: ExecutionDecision, now: Date): string {
  return `paper:${now.getTime()}:${decision.signalId}`;
}

/**
 * Fill a taker decision from the ask levels the decision was built on.
 *
 * `requestedContracts` is what the size budget implied at the limit price; walking the same
 * captured levels again gives filled / partial / rejected honestly (a plan whose size no longer
 * finds depth is partial, not a fabricated full fill).
 */
export function fillTakerFromDecision(
  decision: ExecutionDecision,
  intentId: string,
  now: Date,
): PaperFill {
  const asks = decision.bookLevels;
  const walk = walkBook(asks, decision.sizeUsd);
  const bestPrice = asks[0]?.price ?? null;
  const requestedContracts =
    bestPrice === null || bestPrice <= 0
      ? decision.contracts
      : Math.max(1, Math.floor(decision.sizeUsd / bestPrice));
  const filledContracts = Math.floor(walk.contracts);
  const price = walk.avgPrice === null ? null : roundTick(walk.avgPrice);
  const base = {
    fillId: `fill:${now.getTime()}:${decision.signalId}`,
    intentId,
    decisionId: decision.id,
    venue: decision.venue ?? "kalshi",
    tickerToken: decision.tickerToken ?? "",
    position: decision.position ?? "yes",
    style: "taker" as const,
    createdAtIso: now.toISOString(),
  };
  if (price === null || filledContracts <= 0) {
    return {
      ...base,
      status: "rejected",
      price: null,
      contracts: 0,
      sizeUsd: 0,
      slippageBps: null,
      reason: "no_book_depth",
    };
  }
  const sizeUsd = roundUsd(filledContracts * price);
  return {
    ...base,
    status: filledContracts >= requestedContracts ? "filled" : "partial",
    price,
    contracts: filledContracts,
    sizeUsd,
    slippageBps: decision.slippageBps,
    reason:
      filledContracts >= requestedContracts
        ? null
        : `depth covered ${filledContracts}/${requestedContracts} contracts`,
  };
}

/** A resting maker quote; it never fills just because it was posted. */
export function makeMakerQuote(
  decision: ExecutionDecision,
  intentId: string,
  now: Date,
): PaperQuote | null {
  if (
    decision.style !== "maker" ||
    decision.limitPrice === null ||
    decision.contracts <= 0 ||
    decision.tickerToken === null
  ) {
    return null;
  }
  return {
    quoteId: `quote:${now.getTime()}:${decision.signalId}`,
    intentId,
    decisionId: decision.id,
    venue: decision.venue ?? "kalshi",
    tickerToken: decision.tickerToken,
    position: decision.position ?? "yes",
    price: roundTick(decision.limitPrice),
    contracts: decision.contracts,
    sizeUsd: decision.sizeUsd,
    createdAtIso: now.toISOString(),
    expiresAtIso: new Date(now.getTime() + MAKER_QUOTE_TTL_MS).toISOString(),
    status: "open",
  };
}

export interface QuoteBook {
  readonly asks: readonly PolymarketLevel[];
  readonly bids: readonly PolymarketLevel[];
}

export interface SweepResult {
  readonly fills: readonly PaperFill[];
  readonly quotes: readonly PaperQuote[];
}

/**
 * Sweep resting maker quotes against current books.
 *
 * A buy quote fills only when a book actually crosses it (best ask ≤ our price); otherwise it stays
 * open until its 90s expiry, then expires. This is the conservative rule the contract asks for.
 */
export function sweepMakerQuotes(
  quotes: readonly PaperQuote[],
  books: ReadonlyMap<string, QuoteBook>,
  now: Date,
): SweepResult {
  const fills: PaperFill[] = [];
  const updated: PaperQuote[] = [];
  for (const quote of quotes) {
    if (quote.status !== "open") {
      updated.push(quote);
      continue;
    }
    if (Date.parse(quote.expiresAtIso) <= now.getTime()) {
      updated.push({ ...quote, status: "expired" });
      continue;
    }
    const book = books.get(`${quote.venue}:${quote.tickerToken}`);
    if (book === undefined) {
      updated.push(quote);
      continue;
    }
    const bestAsk = [...book.asks].sort((a, b) => a.price - b.price)[0]?.price;
    const crossed =
      bestAsk !== undefined && bestAsk <= quote.price + EXECUTION_TICK / 2;
    if (!crossed) {
      updated.push(quote);
      continue;
    }
    updated.push({ ...quote, status: "filled" });
    fills.push({
      fillId: `fill:maker:${now.getTime()}:${quote.quoteId}`,
      intentId: quote.intentId,
      decisionId: quote.decisionId,
      venue: quote.venue,
      tickerToken: quote.tickerToken,
      position: quote.position,
      style: "taker",
      status: "filled",
      price: quote.price,
      contracts: quote.contracts,
      sizeUsd: quote.sizeUsd,
      slippageBps: 0,
      createdAtIso: now.toISOString(),
      reason: "maker_quote_crossed",
    });
  }
  return { fills, quotes: updated };
}
