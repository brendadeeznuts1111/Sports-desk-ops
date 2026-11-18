/**
 * Join weblog tickets to wagers, and wagers to ledger rows.
 * TicketNumber is the primary key. WagerNumber is used only when unique.
 */

import {
  groupWagersByTicket,
  type LedgerRow,
  type PullProjection,
  type WagerRow,
  type WagerSource,
  type WeblogRow,
} from "./f402_analyze_ingest.ts";

export type JoinConfidence =
  | "ticket_number"
  | "wager_number"
  | "document_number"
  | "grade_num"
  | "time_amount";

export const JOIN_CONFIDENCE_SCORE: Readonly<Record<JoinConfidence, number>> = {
  ticket_number: 1,
  wager_number: 0.8,
  document_number: 0.95,
  grade_num: 0.7,
  time_amount: 0.45,
};

export const TIME_AMOUNT_WINDOW_MS = 15 * 60_000;

export interface TicketWagerJoin {
  readonly loginId: string;
  readonly ticket: string;
  readonly wagerTicket: string;
  readonly wagerNumber: string;
  readonly accountId: string;
  readonly source: WagerRow["source"];
  readonly confidence: JoinConfidence;
  readonly score: number;
}

export interface WagerLedgerJoin {
  readonly accountId: string;
  readonly ticketNumber: string;
  readonly wagerNumber: string;
  readonly documentNumber: number | null;
  readonly gradeNum: number | null;
  readonly ledgerDocumentNumber: number;
  readonly tranType: string;
  readonly confidence: JoinConfidence;
  readonly score: number;
}

export interface JoinCoverage {
  readonly weblogTicketRows: number;
  readonly weblogTicketsDistinct: number;
  readonly weblogJoined: number;
  readonly weblogCoverage: number;
  readonly wagerRows: number;
  readonly wagerTicketsDistinct: number;
  readonly wagersJoinedToWeblog: number;
  readonly wagerToWeblogCoverage: number;
  readonly ledgerWagerRows: number;
  readonly ledgerJoined: number;
  readonly ledgerCoverage: number;
  readonly wagersJoinedToLedger: number;
  readonly wagerToLedgerCoverage: number;
  readonly byConfidence: Record<JoinConfidence, number>;
  readonly assumptions: readonly string[];
}

export const JOIN_ASSUMPTIONS: readonly string[] = [
  "Weblog tickets are parsed from Operation/Data free text (Ticket: N or Wager ticket N).",
  "TicketNumber is the primary join key; it is unique per wager on getGraded.",
  "WagerNumber is a fallback only when that number is unique in the ingested wager set (graded WagerNumber can be a per-customer sequence).",
  "Ledger DocumentNumber and GradeNum are used when present; otherwise the same account plus a close time and matching amount is a low-confidence fallback.",
  "getBetTicker is a live window, not a historical book; settled coverage comes from getGraded and getWagersByFigureDate.",
  "Ledger amounts are wire cents. Pending, graded and figure-date AmountWagered are wire cents; ticker amounts are unconfirmed and may be cents or whole dollars.",
];

const LEDGER_WAGER_TYPES = new Set(["A", "W", "L", "X"]);

function uniqueWagerNumbers(
  wagers: readonly WagerRow[],
): Map<string, WagerRow> {
  const counts = new Map<string, number>();
  for (const row of wagers) {
    if (row.wagerNumber === "") continue;
    counts.set(row.wagerNumber, (counts.get(row.wagerNumber) ?? 0) + 1);
  }
  const unique = new Map<string, WagerRow>();
  for (const row of wagers) {
    if (row.wagerNumber !== "" && counts.get(row.wagerNumber) === 1) {
      unique.set(row.wagerNumber, row);
    }
  }
  return unique;
}

/**
 * `cents`: integer wire cents. `dollars`: whole or decimal dollars.
 * `unknown`: either of the two, for a feed whose unit is not confirmed.
 */
export type WagerAmountUnit = "cents" | "dollars" | "unknown";

/**
 * Pending: `AmountWagered = 240000` matched the portal's $2,400
 * (docs/analysis/defense-measurement-2026-11-03/08). Graded and figure-date:
 * wire cents (lib/customer_wager_artifacts.ts). Ticker: the local paste was
 * whole dollars (docs/design/bridge3a_f402_betticker.md) while the enricher
 * reads it as cents, so it stays `unknown`.
 */
export const WAGER_AMOUNT_UNIT_BY_SOURCE: Readonly<
  Record<WagerSource, WagerAmountUnit>
> = {
  pending: "cents",
  graded: "cents",
  "figure-date": "cents",
  ticker: "unknown",
};

export function wagerAmountCentsCandidates(
  amount: number,
  unit: WagerAmountUnit,
): number[] {
  if (!Number.isFinite(amount)) return [];
  const asCents = Math.trunc(amount);
  const fromDollars = Math.round(amount * 100);
  if (unit === "cents") return [asCents];
  if (unit === "dollars") return [fromDollars];
  return asCents === fromDollars ? [asCents] : [asCents, fromDollars];
}

/** `ledgerCents` is always wire cents; `unit` says how to read `wagerAmount`. */
export function amountsMatch(
  wagerAmount: number,
  ledgerCents: number,
  unit: WagerAmountUnit = "unknown",
): boolean {
  if (!Number.isFinite(ledgerCents)) return false;
  return wagerAmountCentsCandidates(wagerAmount, unit).includes(ledgerCents);
}

export function joinWeblogToWagers(
  weblog: readonly WeblogRow[],
  wagers: readonly WagerRow[],
): TicketWagerJoin[] {
  const byTicket = groupWagersByTicket(wagers);
  const uniqueWn = uniqueWagerNumbers(wagers);
  const out: TicketWagerJoin[] = [];
  for (const row of weblog) {
    if (row.ticket === null || row.ticket === "") continue;
    const ticketHits = byTicket.get(row.ticket);
    if (ticketHits !== undefined && ticketHits.length > 0) {
      const wager = ticketHits[0]!;
      out.push({
        loginId: row.loginId,
        ticket: row.ticket,
        wagerTicket: wager.ticketNumber,
        wagerNumber: wager.wagerNumber,
        accountId: wager.accountId,
        source: wager.source,
        confidence: "ticket_number",
        score: JOIN_CONFIDENCE_SCORE.ticket_number,
      });
      continue;
    }
    const byNumber = uniqueWn.get(row.ticket);
    if (byNumber !== undefined) {
      out.push({
        loginId: row.loginId,
        ticket: row.ticket,
        wagerTicket: byNumber.ticketNumber,
        wagerNumber: byNumber.wagerNumber,
        accountId: byNumber.accountId,
        source: byNumber.source,
        confidence: "wager_number",
        score: JOIN_CONFIDENCE_SCORE.wager_number,
      });
    }
  }
  return out;
}

export function joinWagersToLedger(
  wagers: readonly WagerRow[],
  ledger: readonly LedgerRow[],
): WagerLedgerJoin[] {
  const byTicket = groupWagersByTicket(wagers);
  const tickets = [...byTicket.entries()].map(([ticket, rows]) => ({
    ticket,
    row: rows[0]!,
    rows,
  }));
  const usedLedger = new Set<string>();
  const out: WagerLedgerJoin[] = [];
  const ledgerKey = (row: LedgerRow): string =>
    `${row.accountId}|${row.documentNumber}|${row.tranMs}|${row.tranType}`;

  const consider = (
    wager: WagerRow,
    row: LedgerRow,
    confidence: JoinConfidence,
  ): boolean => {
    const key = ledgerKey(row);
    if (usedLedger.has(key)) return false;
    usedLedger.add(key);
    out.push({
      accountId: wager.accountId,
      ticketNumber: wager.ticketNumber,
      wagerNumber: wager.wagerNumber,
      documentNumber: wager.documentNumber,
      gradeNum: wager.gradeNum,
      ledgerDocumentNumber: row.documentNumber,
      tranType: row.tranType,
      confidence,
      score: JOIN_CONFIDENCE_SCORE[confidence],
    });
    return true;
  };

  const wagerLedger = ledger.filter((row) =>
    LEDGER_WAGER_TYPES.has(row.tranType),
  );
  for (const { row: wager } of tickets) {
    const sameAccount = wagerLedger.filter(
      (row) => row.accountId.toLowerCase() === wager.accountId.toLowerCase(),
    );
    if (wager.documentNumber !== null) {
      const hit = sameAccount.find(
        (row) => row.documentNumber === wager.documentNumber,
      );
      if (hit !== undefined && consider(wager, hit, "document_number"))
        continue;
    }
    if (wager.gradeNum !== null) {
      const hit = sameAccount.find((row) => row.gradeNum === wager.gradeNum);
      if (hit !== undefined && consider(wager, hit, "grade_num")) continue;
    }
    if (wager.ticketNumber !== "") {
      const hit = sameAccount.find((row) => row.ticket === wager.ticketNumber);
      if (hit !== undefined && consider(wager, hit, "ticket_number")) continue;
    }
    const timed = sameAccount
      .filter(
        (row) =>
          Number.isFinite(wager.acceptedMs) &&
          Number.isFinite(row.tranMs) &&
          Math.abs(row.tranMs - wager.acceptedMs) <= TIME_AMOUNT_WINDOW_MS &&
          amountsMatch(
            wager.amountWagered,
            row.amountCents,
            WAGER_AMOUNT_UNIT_BY_SOURCE[wager.source],
          ),
      )
      .sort(
        (a, b) =>
          Math.abs(a.tranMs - wager.acceptedMs) -
          Math.abs(b.tranMs - wager.acceptedMs),
      );
    if (timed[0] !== undefined) consider(wager, timed[0], "time_amount");
  }
  return out;
}

function ratio(num: number, den: number): number {
  if (den <= 0) return 0;
  return Number((num / den).toFixed(4));
}

export function reportJoinCoverage(projection: PullProjection): {
  readonly coverage: JoinCoverage;
  readonly ticketJoins: readonly TicketWagerJoin[];
  readonly ledgerJoins: readonly WagerLedgerJoin[];
} {
  const ticketJoins = joinWeblogToWagers(projection.weblog, projection.wagers);
  const ledgerJoins = joinWagersToLedger(projection.wagers, projection.ledger);
  const weblogTicketRows = projection.weblog.filter(
    (row) => row.ticket !== null && row.ticket !== "",
  );
  const weblogTickets = new Set(
    weblogTicketRows.map((row) => row.ticket as string),
  );
  const joinedWeblog = new Set(ticketJoins.map((row) => row.ticket));
  const wagerTickets = new Set(
    projection.wagers
      .map((row) => row.ticketNumber)
      .filter((ticket) => ticket !== ""),
  );
  const wagersJoinedToWeblog = [...wagerTickets].filter((ticket) =>
    ticketJoins.some(
      (join) => join.wagerTicket === ticket || join.ticket === ticket,
    ),
  ).length;
  const ledgerWagerRows = projection.ledger.filter((row) =>
    LEDGER_WAGER_TYPES.has(row.tranType),
  );
  const byConfidence: Record<JoinConfidence, number> = {
    ticket_number: 0,
    wager_number: 0,
    document_number: 0,
    grade_num: 0,
    time_amount: 0,
  };
  for (const join of ticketJoins) byConfidence[join.confidence] += 1;
  for (const join of ledgerJoins) byConfidence[join.confidence] += 1;
  const coverage: JoinCoverage = {
    weblogTicketRows: weblogTicketRows.length,
    weblogTicketsDistinct: weblogTickets.size,
    weblogJoined: joinedWeblog.size,
    weblogCoverage: ratio(joinedWeblog.size, weblogTickets.size),
    wagerRows: projection.wagers.length,
    wagerTicketsDistinct: wagerTickets.size,
    wagersJoinedToWeblog,
    wagerToWeblogCoverage: ratio(wagersJoinedToWeblog, wagerTickets.size),
    ledgerWagerRows: ledgerWagerRows.length,
    ledgerJoined: ledgerJoins.length,
    ledgerCoverage: ratio(ledgerJoins.length, ledgerWagerRows.length),
    wagersJoinedToLedger: ledgerJoins.length,
    wagerToLedgerCoverage: ratio(ledgerJoins.length, wagerTickets.size),
    byConfidence,
    assumptions: JOIN_ASSUMPTIONS,
  };
  return { coverage, ticketJoins, ledgerJoins };
}
