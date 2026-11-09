/**
 * Parse Manager deleted-transactions report rows (`INFO.LIST` envelope).
 * One row per parlay leg; dedupe to unique tickets for PendingDelete probes.
 */

export interface DeletedWagerLegRow {
  // Canonical (legacy) field names:
  readonly TicketNumber?: string;
  readonly customerID?: string;
  readonly Login?: string;
  readonly DeleteDateTime?: string;
  readonly AmountWagered?: string;
  readonly WagerType?: string;
  readonly WagerCount?: string | null;
  readonly totalPicks?: string | null;
  readonly LoginID?: string;
  readonly NameFirst?: string;
  readonly Password?: string;
  // Real deleted-transactions report field names (DocumentNumber payload):
  readonly DocumentNumber?: number | string;
  readonly CustomerID?: string;
  readonly AgentID?: string;
  readonly TranCode?: string;
  readonly TranType?: string;
  readonly TranDateTime?: string;
  readonly Amount?: string | number;
  readonly EnteredAmount?: string | number;
  readonly EnteredBy?: string;
  readonly LastUpdateLoginID?: string;
  readonly Description?: string;
  readonly Operation?: string;
  // Extended wire fields on getDeleteWager rows:
  readonly DeletedBy?: string;
  readonly ToWinAmount?: string | number;
  readonly Outcome?: string;
  readonly WagerStatus?: string;
  readonly AcceptedDateTime?: string;
  readonly WagerNumber?: string | number;
  readonly GameDateTime?: string;
  readonly ItemNumber?: string | number;
  readonly FinalMoney?: string | number;
  readonly Odds?: string | number;
}

export type DeletedWagerEnvelope = DeletedWagerListEnvelope;

export interface DeletedWagerTicketTarget {
  readonly ticketNumber: string;
  readonly customerId: string;
  readonly login: string;
  readonly deleteDateTime: string;
  readonly legCount: number;
  readonly amountWagered: string;
  readonly wagerType: string;
  readonly loginId: string;
  readonly nameFirst: string;
}

export interface DeletedWagerListEnvelope {
  INFO: {
    LIST: DeletedWagerLegRow[];
  };
}

const STRIP_FIELDS = new Set([
  "Password",
  "CCNumber",
  "CCExpires",
  "CCApproval",
]);

/** Remove credential and PCI cardholder fields from a single row before persisting or hashing. */
export function redactDeletedWagerRow<T extends Record<string, unknown>>(
  row: T,
): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of STRIP_FIELDS) delete out[key];
  return out as T;
}

/** Remove credential fields before writing fixtures to disk. */
export function redactDeletedWagerEnvelope(
  envelope: DeletedWagerListEnvelope,
): DeletedWagerListEnvelope {
  return {
    INFO: {
      LIST: envelope.INFO.LIST.map((row) =>
        redactDeletedWagerRow(row as unknown as Record<string, unknown>),
      ) as unknown as DeletedWagerLegRow[],
    },
  };
}

/** Remove credential and PCI cardholder fields from `getDeletedTransactionHistory` (`{ LIST }`). */
export function redactDeletedTransactionList(raw: {
  readonly LIST: readonly Record<string, unknown>[];
}): { LIST: Record<string, unknown>[] } {
  return {
    LIST: raw.LIST.map((row) => redactDeletedWagerRow(row)),
  };
}

export function parseDeletedWagerEnvelope(
  raw: unknown,
): DeletedWagerListEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("deleted wager envelope must be an object");
  const info = (raw as { INFO?: unknown }).INFO;
  if (typeof info !== "object" || info === null)
    throw new Error("deleted wager envelope missing INFO");
  const list = (info as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) throw new Error("INFO.LIST must be an array");
  return { INFO: { LIST: list as DeletedWagerLegRow[] } };
}

function trimCustomerId(raw: string): string {
  return raw.trim();
}

function trimLogin(raw: string): string {
  return raw.trim();
}

/** Resolve the ticket id from either canonical or real-payload field names. */
function ticketNumberOf(row: DeletedWagerLegRow): string {
  const raw = row.TicketNumber ?? row.DocumentNumber;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the customer id from either canonical or real-payload field names. */
function customerIdOf(row: DeletedWagerLegRow): string {
  const raw = row.customerID ?? row.CustomerID;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the delete timestamp from either canonical or real-payload field names. */
function deleteDateTimeOf(row: DeletedWagerLegRow): string {
  const raw = row.DeleteDateTime ?? row.TranDateTime;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the amount from either canonical or real-payload field names. */
function amountOf(row: DeletedWagerLegRow): string {
  const raw = row.AmountWagered ?? row.Amount ?? row.EnteredAmount;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the login from either canonical or real-payload field names. */
function loginOf(row: DeletedWagerLegRow): string {
  const raw = row.Login ?? row.EnteredBy;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/** Resolve the login id from either canonical or real-payload field names. */
function loginIdOf(row: DeletedWagerLegRow): string {
  const raw = row.LoginID ?? row.LastUpdateLoginID;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

/**
 * Dedupe legs into one target per (customerId, ticketNumber).
 * Prefers the row with the highest leg count seen for that ticket.
 */
export function dedupeDeletedWagerTargets(
  legs: readonly DeletedWagerLegRow[],
): DeletedWagerTicketTarget[] {
  const byKey = new Map<string, { legs: DeletedWagerLegRow[] }>();
  for (const leg of legs) {
    const customerId = trimCustomerId(customerIdOf(leg));
    const ticketNumber = ticketNumberOf(leg);
    if (!customerId || !ticketNumber) continue;
    const key = `${customerId}\t${ticketNumber}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { legs: [] };
      byKey.set(key, bucket);
    }
    bucket.legs.push(leg);
  }

  const targets: DeletedWagerTicketTarget[] = [];
  for (const [, { legs: group }] of byKey) {
    const first = group[0]!;
    const ticketNumber = ticketNumberOf(first);
    const customerId = trimCustomerId(customerIdOf(first));
    targets.push({
      ticketNumber,
      customerId,
      login: trimLogin(loginOf(first)),
      deleteDateTime: deleteDateTimeOf(first),
      legCount: group.length,
      amountWagered: amountOf(first),
      wagerType: first.WagerType ?? "",
      loginId: loginIdOf(first),
      nameFirst: (first.NameFirst ?? "").trim(),
    });
  }

  targets.sort((a, b) => {
    const amt = Number(b.amountWagered) - Number(a.amountWagered);
    if (amt !== 0) return amt;
    return a.ticketNumber.localeCompare(b.ticketNumber);
  });
  return targets;
}

export function targetsFromEnvelope(
  envelope: DeletedWagerListEnvelope,
): DeletedWagerTicketTarget[] {
  return dedupeDeletedWagerTargets(envelope.INFO.LIST);
}

/* -------------------------------------------------------------------------- */
/* Deleted & Buyout Wager Anomaly Audit + Fair Parlay Valuation               */
/* -------------------------------------------------------------------------- */

export type DeletedWagerAnomalyFlag =
  | "OPEN_PARLAY_BUYOUT"
  | "ZERO_PENDING_OPEN_PARLAY_BUYOUT"
  | "MULTI_PENDING_LEG_BUYOUT"
  | "IN_PLAY_OR_POST_START_BUYOUT"
  | "POST_GAME_START_DELETE"
  | "BUYOUT_OVERPAYMENT";

export interface BuyoutLedgerCreditEntry {
  readonly customerId: string;
  readonly documentNumber: number | string | null;
  readonly tranDateTime: string | null;
  readonly tranCode: string | null;
  readonly tranType: string | null;
  readonly amountCents: number | null;
  readonly amountDollars: number | null;
  readonly shortDesc: string;
}

export interface DeletedWagerTicketAudit {
  readonly ticketNumber: string;
  readonly customerId: string;
  readonly login: string;
  readonly kind: "BUYOUT" | "DELETED";
  readonly deletedBy: string;
  readonly wagerStatus: string;
  readonly wagerType: string;
  readonly acceptedDateTime: string | null;
  readonly deleteDateTime: string | null;
  readonly riskCents: number | null;
  readonly toWinCents: number | null;
  readonly totalPicks: number;
  readonly legCountReturned: number;
  readonly openSpotsUnfilled: number;
  readonly legBreakdown: {
    readonly won: number;
    readonly lost: number;
    readonly push: number;
    readonly pendingAtDelete: number;
  };
  readonly fairWonParlayProfitCents: number | null;
  readonly fairWonParlayReturnCents: number | null;
  readonly buyoutLedgerCredit: BuyoutLedgerCreditEntry | null;
  readonly anomalies: readonly DeletedWagerAnomalyFlag[];
}

export interface DeletedWagerAuditSummary {
  readonly totalLegs: number;
  readonly uniqueTickets: number;
  readonly buyoutTickets: number;
  readonly deletedTickets: number;
  readonly openParlayBuyouts: number;
  readonly zeroPendingOpenParlayBuyouts: number;
  readonly multiPendingLegBuyouts: number;
  readonly inPlayOrPostStartBuyouts: number;
  readonly postGameStartDeletes: number;
  readonly buyoutOverpayments: number;
  readonly buyoutRiskCents: number;
  readonly buyoutNominalToWinCents: number;
  readonly buyoutFairWonReturnCents: number;
  readonly buyoutReconciledCreditCents: number;
  readonly deletedRiskCents: number;
  readonly deletedNominalToWinCents: number;
  readonly tickets: readonly DeletedWagerTicketAudit[];
}

/** Convert American moneyline odds (e.g. -900, +150) to decimal multiplier (e.g. 1.1111, 2.5). */
export function americanOddsToDecimal(odds: number): number | null {
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds > 0) return 1 + odds / 100;
  return 1 + 100 / Math.abs(odds);
}

/**
 * Compute the fair compound parlay profit and total return (stake + profit) in cents
 * for the graded-win (`Outcome === "W"`) legs of a parlay.
 */
export function computeFairParlayPayoutCents(
  riskCents: number,
  wonLegAmericanOdds: readonly number[],
): { profitCents: number; returnCents: number } | null {
  if (!Number.isFinite(riskCents) || riskCents <= 0) return null;
  if (wonLegAmericanOdds.length === 0) {
    return { profitCents: 0, returnCents: Math.round(riskCents) };
  }
  let multiplier = 1;
  for (const american of wonLegAmericanOdds) {
    const dec = americanOddsToDecimal(american);
    if (dec === null) return null;
    multiplier *= dec;
  }
  const profitCents = Math.round(riskCents * (multiplier - 1));
  const returnCents = Math.round(riskCents) + profitCents;
  return { profitCents, returnCents };
}

/** Pure audit over a `getDeleteWager` envelope and optional reconciled ledger credits. */
export function auditDeletedWagerEnvelope(
  envelope: DeletedWagerListEnvelope,
  ledgerByTicket: ReadonlyMap<string, BuyoutLedgerCreditEntry> = new Map(),
): DeletedWagerAuditSummary {
  const byTicket = new Map<string, DeletedWagerLegRow[]>();
  for (const leg of envelope.INFO.LIST) {
    const ticket = ticketNumberOf(leg);
    if (!ticket) continue;
    const list = byTicket.get(ticket) ?? [];
    list.push(leg);
    byTicket.set(ticket, list);
  }

  let buyoutTickets = 0;
  let deletedTickets = 0;
  let openParlayBuyouts = 0;
  let zeroPendingOpenParlayBuyouts = 0;
  let multiPendingLegBuyouts = 0;
  let inPlayOrPostStartBuyouts = 0;
  let postGameStartDeletes = 0;
  let buyoutOverpayments = 0;
  let buyoutRiskCents = 0;
  let buyoutNominalToWinCents = 0;
  let buyoutFairWonReturnCents = 0;
  let buyoutReconciledCreditCents = 0;
  let deletedRiskCents = 0;
  let deletedNominalToWinCents = 0;

  const tickets: DeletedWagerTicketAudit[] = [];

  for (const [ticketNumber, legs] of byTicket) {
    const first = legs[0]!;
    const recFirst = first as unknown as Record<string, unknown>;
    const customerId = trimCustomerId(customerIdOf(first));
    const login = trimLogin(loginOf(first)) || customerId;
    const deletedBy = loginIdOf(first);
    const isBuyout = deletedBy.toUpperCase().includes("BUYOUT");
    const kind = isBuyout ? ("BUYOUT" as const) : ("DELETED" as const);
    const wagerStatus = String(recFirst.WagerStatus ?? "")
      .trim()
      .toUpperCase();
    const wagerType = String(first.WagerType ?? "")
      .trim()
      .toUpperCase();
    const acceptedDateTime =
      String(recFirst.AcceptedDateTime ?? "").trim() || null;
    const deleteDateTime = deleteDateTimeOf(first) || null;
    const rawRisk = Number(first.AmountWagered ?? recFirst.Amount ?? NaN);
    const rawToWin = Number(recFirst.ToWinAmount ?? NaN);
    const riskCents = Number.isFinite(rawRisk) ? Math.round(rawRisk) : null;
    const toWinCents = Number.isFinite(rawToWin) ? Math.round(rawToWin) : null;
    const rawTotalPicks = Number(first.totalPicks ?? legs.length);
    const totalPicks =
      Number.isFinite(rawTotalPicks) && rawTotalPicks > 0
        ? Math.round(rawTotalPicks)
        : legs.length;
    const legCountReturned = legs.length;
    const openSpotsUnfilled = Math.max(0, totalPicks - legCountReturned);

    let won = 0;
    let lost = 0;
    let push = 0;
    let pendingAtDelete = 0;
    let hasPostStartPendingLeg = false;
    let hasPostStartAnyLeg = false;
    const wonOdds: number[] = [];

    for (const leg of legs) {
      const rec = leg as unknown as Record<string, unknown>;
      const out = String(rec.Outcome ?? "")
        .trim()
        .toUpperCase();
      const gameDt = String(rec.GameDateTime ?? "").trim();
      const isPostStart =
        Boolean(deleteDateTime) &&
        Boolean(gameDt) &&
        !gameDt.startsWith("1900-01-01") &&
        deleteDateTime! >= gameDt;
      if (isPostStart) hasPostStartAnyLeg = true;

      if (out === "W") {
        won += 1;
        const money = Number(rec.FinalMoney ?? NaN);
        if (Number.isFinite(money) && money !== 0) wonOdds.push(money);
      } else if (out === "L") {
        lost += 1;
      } else if (out === "X") {
        push += 1;
      } else {
        pendingAtDelete += 1;
        if (isPostStart) hasPostStartPendingLeg = true;
      }
    }

    const fair =
      riskCents !== null && wonOdds.length === won && won > 0
        ? computeFairParlayPayoutCents(riskCents, wonOdds)
        : null;
    const ledger = ledgerByTicket.get(ticketNumber) ?? null;

    const anomalies: DeletedWagerAnomalyFlag[] = [];
    if (isBuyout) {
      buyoutTickets += 1;
      if (riskCents !== null) buyoutRiskCents += riskCents;
      if (toWinCents !== null) buyoutNominalToWinCents += toWinCents;
      if (fair !== null) buyoutFairWonReturnCents += fair.returnCents;
      if (ledger?.amountCents !== null && ledger?.amountCents !== undefined) {
        buyoutReconciledCreditCents += ledger.amountCents;
      }

      if (wagerStatus === "O" || openSpotsUnfilled > 0) {
        anomalies.push("OPEN_PARLAY_BUYOUT");
        openParlayBuyouts += 1;
      }
      if (openSpotsUnfilled > 0 && pendingAtDelete === 0 && won > 0) {
        anomalies.push("ZERO_PENDING_OPEN_PARLAY_BUYOUT");
        zeroPendingOpenParlayBuyouts += 1;
      }
      if (pendingAtDelete >= 2) {
        anomalies.push("MULTI_PENDING_LEG_BUYOUT");
        multiPendingLegBuyouts += 1;
      }
      if (hasPostStartPendingLeg) {
        anomalies.push("IN_PLAY_OR_POST_START_BUYOUT");
        inPlayOrPostStartBuyouts += 1;
      }
      if (
        ledger?.amountCents !== null &&
        ledger?.amountCents !== undefined &&
        fair !== null &&
        pendingAtDelete === 0 &&
        ledger.amountCents > fair.returnCents + 100
      ) {
        anomalies.push("BUYOUT_OVERPAYMENT");
        buyoutOverpayments += 1;
      }
    } else {
      deletedTickets += 1;
      if (riskCents !== null) deletedRiskCents += riskCents;
      if (toWinCents !== null) deletedNominalToWinCents += toWinCents;
      if (hasPostStartAnyLeg) {
        anomalies.push("POST_GAME_START_DELETE");
        postGameStartDeletes += 1;
      }
    }

    tickets.push({
      ticketNumber,
      customerId,
      login,
      kind,
      deletedBy,
      wagerStatus,
      wagerType,
      acceptedDateTime,
      deleteDateTime,
      riskCents,
      toWinCents,
      totalPicks,
      legCountReturned,
      openSpotsUnfilled,
      legBreakdown: {
        won,
        lost,
        push,
        pendingAtDelete,
      },
      fairWonParlayProfitCents: fair?.profitCents ?? null,
      fairWonParlayReturnCents: fair?.returnCents ?? null,
      buyoutLedgerCredit: ledger,
      anomalies,
    });
  }

  tickets.sort((a, b) =>
    String(b.deleteDateTime ?? "").localeCompare(
      String(a.deleteDateTime ?? ""),
    ),
  );

  return {
    totalLegs: envelope.INFO.LIST.length,
    uniqueTickets: tickets.length,
    buyoutTickets,
    deletedTickets,
    openParlayBuyouts,
    zeroPendingOpenParlayBuyouts,
    multiPendingLegBuyouts,
    inPlayOrPostStartBuyouts,
    postGameStartDeletes,
    buyoutOverpayments,
    buyoutRiskCents,
    buyoutNominalToWinCents,
    buyoutFairWonReturnCents,
    buyoutReconciledCreditCents,
    deletedRiskCents,
    deletedNominalToWinCents,
    tickets,
  };
}
