/**
 * Parse and audit Manager `getTransactionList` responses (`{ LIST: [...], SL: "OK" }`)
 * and the companion `manager/module/customer-admin/transaction-player` frontend behaviors:
 *
 * 1. **Cents scaling**: `Amount` and `Balance` on the JSON wire are integer cents (`USD = cents / 100`).
 *    Write endpoints `changeCarry` (`carry: 100 * parseFloat(...)`) and `insertTransaction`
 *    (`amount: 100 * ...`) multiply by `100` on the client.
 * 2. **`EnteredBy` whitespace**: JSON rows carry trailing spaces (e.g. `"Internet - NOLAROSE  "`),
 *    while the UI strips all spaces in `data-param.enterBy` via `n.clearSpaces(l.EnteredBy)`.
 * 3. **UI `TranType` mutation**: `transactions()` mutates `l.TranType = "W"` in-memory when
 *    `EnteredBy.trim() === "system"` and `Description` contains `"Deleted Wager Rollback"`.
 * 4. **Delete & date guards**:
 *    - `deleteTransaction()` blocks `enterBy === "GGL-LIVEDEALER"` and `tranType` in `W | L | X`.
 *    - `listenersAddTransaction()` disables `figure-date` when `tran-type` is `E | I | N | B`.
 * 5. **HTML `<tbody>` `<span class="NaN">NaN</span>` sentinel**:
 *    When `TranCode === "D"`, the Credit variable `c` stays `""`, which `n.formatCurrency` formats
 *    as `"NaN"`, producing `<span class="NaN">NaN</span>` (and vice versa for `"C"` on Debit).
 * 6. **`Jhxlsx.export` single-comma bug**:
 *    `parseFloat(n.toString().replace(",", ""))` removes only the FIRST comma; any formatted
 *    dollar string `>= 1,000,000.00` (two commas, e.g. `"1,234,567.89"`) stops parsing at the
 *    second comma (`1234`), truncating the exported Excel number by ~1000x.
 * 7. **`presetParam` `$.ajaxPrefilter` `agentID` / `agentOwner` swap**:
 *    Initializes `s = sessionStorage.MASTER_ID, r = s`; when `i.data.agentID` is passed without
 *    `agentOwner`, `s` becomes `i.data.agentID` while `r` stays `MASTER_ID`, then assigns
 *    `agentID = r` (`MASTER_ID`) and `agentOwner = s` (caller's `agentID`).
 * 8. **`getDeletedTransactions` `"Cust Serv"` masking**:
 *    Any `LastUpdateLoginID` not equal to `MASTER_ID` and absent from `d.agents` is displayed as
 *    `"Cust Serv"`, masking root/admin logins in the Deleted Transactions table.
 */

export interface TransactionListRowRaw {
  readonly DocumentNumber: number;
  readonly TranCode: "C" | "D" | string;
  readonly TranType: string;
  readonly Amount: number;
  readonly Description: string;
  readonly TranDateTime: string;
  readonly HoldAmount?: number | null;
  readonly GradeNum?: number | null;
  readonly EnteredBy?: string | null;
  readonly Balance: number;
}

export interface TransactionListEnvelope {
  readonly LIST: TransactionListRowRaw[];
  readonly SL?: string;
}

export interface NormalizedTransactionRow {
  readonly documentNumber: number;
  readonly tranCode: "C" | "D" | string;
  readonly rawTranType: string;
  readonly effectiveUiTranType: string;
  readonly uiTranTypeMutated: boolean;
  readonly amountCents: number;
  readonly signedAmountCents: number;
  readonly amountUsd: number;
  readonly balanceCents: number;
  readonly balanceUsd: number;
  readonly holdAmountCents: number;
  readonly gradeNum: number | null;
  readonly enteredBy: string;
  readonly clearSpacesEnterBy: string;
  readonly description: string;
  readonly tranDateTime: string;
  readonly isDeletable: boolean;
  readonly isFigureDateLockedOnInsert: boolean;
}

export interface BalanceDrift {
  readonly index: number;
  readonly documentNumber: number;
  readonly expectedBalanceCents: number;
  readonly actualBalanceCents: number;
  readonly deltaCents: number;
}

export interface SameTimestampCluster {
  readonly tranDateTime: string;
  readonly documentNumbers: number[];
  readonly gradeNums: (number | null)[];
  readonly enteredByList: string[];
  readonly mixedActors: boolean;
  readonly netSignedCents: number;
}

export interface TransactionListSummary {
  readonly rowCount: number;
  readonly sl: string | null;
  readonly firstTranDateTime: string | null;
  readonly lastTranDateTime: string | null;
  readonly openingPriorBalanceCents: number | null;
  readonly closingBalanceCents: number | null;
  readonly conserved: boolean;
  readonly driftCount: number;
  readonly drifts: BalanceDrift[];
  readonly sameTimestampClusters: SameTimestampCluster[];
  readonly byTranType: Record<string, { count: number; totalCents: number }>;
  readonly enteredByCounts: Record<string, number>;
}

const NON_DELETABLE_TRAN_TYPES = new Set(["W", "L", "X"]);
const FIGURE_DATE_LOCKED_TRAN_TYPES = new Set(["E", "I", "N", "B"]);

/** Validate and return the raw `getTransactionList` response envelope. */
export function parseTransactionListEnvelope(
  raw: unknown,
): TransactionListEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("getTransactionList envelope must be an object");
  }
  const obj = raw as { LIST?: unknown; SL?: unknown };
  if (!Array.isArray(obj.LIST)) {
    throw new Error("getTransactionList LIST must be an array");
  }
  return {
    LIST: obj.LIST as TransactionListRowRaw[],
    ...(typeof obj.SL === "string" ? { SL: obj.SL } : {}),
  };
}

/** Replicate `n.clearSpaces(str)` used by `transaction-player` for `data-param.enterBy`. */
export function clearVendorSpaces(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "");
}

/** Normalize one `getTransactionList` row with cent-to-USD scaling and UI-mutation tracking. */
export function normalizeTransactionListRow(
  row: TransactionListRowRaw,
): NormalizedTransactionRow {
  const enteredBy = (row.EnteredBy ?? "").trim();
  const clearSpacesEnterBy = clearVendorSpaces(row.EnteredBy);
  const rawTranType = (row.TranType ?? "").trim();
  const description = row.Description ?? "";
  const uiTranTypeMutated =
    enteredBy === "system" && description.includes("Deleted Wager Rollback");
  const effectiveUiTranType = uiTranTypeMutated ? "W" : rawTranType;
  const amountCents = Math.trunc(row.Amount);
  const balanceCents = Math.trunc(row.Balance);
  const signedAmountCents = row.TranCode === "D" ? -amountCents : amountCents;
  const isDeletable =
    clearSpacesEnterBy !== "GGL-LIVEDEALER" &&
    !NON_DELETABLE_TRAN_TYPES.has(effectiveUiTranType);
  const isFigureDateLockedOnInsert =
    FIGURE_DATE_LOCKED_TRAN_TYPES.has(rawTranType);

  return {
    documentNumber: row.DocumentNumber,
    tranCode: row.TranCode,
    rawTranType,
    effectiveUiTranType,
    uiTranTypeMutated,
    amountCents,
    signedAmountCents,
    amountUsd: amountCents / 100,
    balanceCents,
    balanceUsd: balanceCents / 100,
    holdAmountCents: Math.trunc(row.HoldAmount ?? 0),
    gradeNum: typeof row.GradeNum === "number" ? row.GradeNum : null,
    enteredBy,
    clearSpacesEnterBy,
    description,
    tranDateTime: (row.TranDateTime ?? "").trim(),
    isDeletable,
    isFigureDateLockedOnInsert,
  };
}

/** Check running-balance conservation across chronological `getTransactionList` rows. */
export function verifyTransactionListBalanceConservation(
  rows: readonly NormalizedTransactionRow[],
): { conserved: boolean; driftCount: number; drifts: BalanceDrift[] } {
  const drifts: BalanceDrift[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    const expectedBalanceCents = prev.balanceCents + cur.signedAmountCents;
    if (expectedBalanceCents !== cur.balanceCents) {
      drifts.push({
        index: i,
        documentNumber: cur.documentNumber,
        expectedBalanceCents,
        actualBalanceCents: cur.balanceCents,
        deltaCents: cur.balanceCents - expectedBalanceCents,
      });
    }
  }
  return {
    conserved: drifts.length === 0,
    driftCount: drifts.length,
    drifts,
  };
}

/** Detect multi-row settlements sharing an identical `TranDateTime` timestamp (down to ms). */
export function findSameTimestampClusters(
  rows: readonly NormalizedTransactionRow[],
): SameTimestampCluster[] {
  const groups = new Map<string, NormalizedTransactionRow[]>();
  for (const row of rows) {
    if (!row.tranDateTime) continue;
    let bucket = groups.get(row.tranDateTime);
    if (!bucket) {
      bucket = [];
      groups.set(row.tranDateTime, bucket);
    }
    bucket.push(row);
  }
  const clusters: SameTimestampCluster[] = [];
  for (const [tranDateTime, group] of groups) {
    if (group.length < 2) continue;
    const enteredByList = group.map((r) => r.enteredBy);
    const uniqueActors = new Set(enteredByList);
    clusters.push({
      tranDateTime,
      documentNumbers: group.map((r) => r.documentNumber),
      gradeNums: group.map((r) => r.gradeNum),
      enteredByList,
      mixedActors: uniqueActors.size > 1,
      netSignedCents: group.reduce((acc, r) => acc + r.signedAmountCents, 0),
    });
  }
  return clusters;
}

/** Summarize counts, cent totals, actor distribution, and running-balance conservation. */
export function summarizeTransactionList(
  envelope: TransactionListEnvelope,
): TransactionListSummary {
  const normalized = envelope.LIST.map(normalizeTransactionListRow);
  const conservation = verifyTransactionListBalanceConservation(normalized);
  const sameTimestampClusters = findSameTimestampClusters(normalized);
  const byTranType: Record<string, { count: number; totalCents: number }> = {};
  const enteredByCounts: Record<string, number> = {};

  for (const row of normalized) {
    const bucket = (byTranType[row.rawTranType] ??= {
      count: 0,
      totalCents: 0,
    });
    bucket.count += 1;
    bucket.totalCents += row.amountCents;

    const actor = row.enteredBy || "(empty)";
    enteredByCounts[actor] = (enteredByCounts[actor] ?? 0) + 1;
  }

  const first = normalized[0];
  const last = normalized[normalized.length - 1];

  return {
    rowCount: normalized.length,
    sl: envelope.SL ?? null,
    firstTranDateTime: first?.tranDateTime ?? null,
    lastTranDateTime: last?.tranDateTime ?? null,
    openingPriorBalanceCents: first
      ? first.balanceCents - first.signedAmountCents
      : null,
    closingBalanceCents: last ? last.balanceCents : null,
    conserved: conservation.conserved,
    driftCount: conservation.driftCount,
    drifts: conservation.drifts,
    sameTimestampClusters,
    byTranType,
    enteredByCounts,
  };
}

export interface DesktopHtmlTransactionRow {
  readonly dataGroup: string;
  readonly docNum: number;
  readonly tranType: string;
  readonly enterBy: string;
  readonly dateText: string;
  readonly description: string;
  readonly creditCents: number | null;
  readonly debitCents: number | null;
  readonly signedAmountCents: number;
  readonly balanceCents: number;
}

const TR_REGEX =
  /<tr\b[^>]*\bdata-group="([^"]*)"[^>]*\bdata-param="([^"]*)"[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*><span[^>]*>([\s\S]*?)<\/span><\/td>\s*<td[^>]*><span[^>]*>([\s\S]*?)<\/span><\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

function parseFormattedUsdToCents(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "NaN") return null;
  const cleaned = trimmed.replace(/,/g, "");
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/**
 * Parse desktop HTML `<tbody>` rows rendered by `transaction-player.transactions()`,
 * handling `<span class="NaN">NaN</span>` sentinels and `&quot;` entity decoding in `data-param`.
 */
export function parseTransactionPlayerDesktopHtml(
  html: string,
): DesktopHtmlTransactionRow[] {
  const rows: DesktopHtmlTransactionRow[] = [];
  for (const match of html.matchAll(TR_REGEX)) {
    const dataGroup = match[1] ?? "";
    const rawParam = (match[2] ?? "").replace(/&quot;/g, '"');
    const dateText = (match[3] ?? "").trim();
    const description = (match[4] ?? "").trim();
    const creditText = (match[5] ?? "").trim();
    const debitText = (match[6] ?? "").trim();
    const balanceText = (match[7] ?? "").trim();

    const param = JSON.parse(rawParam) as {
      docNum: number;
      tranType: string;
      enterBy: string;
    };
    const creditCents = parseFormattedUsdToCents(creditText);
    const debitCents = parseFormattedUsdToCents(debitText);
    const balanceCents = parseFormattedUsdToCents(balanceText);
    if (balanceCents === null) {
      throw new Error(
        `Invalid balance "${balanceText}" on doc ${param.docNum}`,
      );
    }
    const signedAmountCents =
      creditCents !== null
        ? creditCents
        : debitCents !== null
          ? -debitCents
          : 0;

    rows.push({
      dataGroup,
      docNum: param.docNum,
      tranType: param.tranType,
      enterBy: param.enterBy,
      dateText,
      description,
      creditCents,
      debitCents,
      signedAmountCents,
      balanceCents,
    });
  }
  return rows;
}

/**
 * Simulate the `Jhxlsx.export` single-comma bug (`parseFloat(str.replace(",", ""))`):
 * for values `>= 1,000,000.00` (which contain 2+ commas when formatted), `.replace(",", "")`
 * removes only the first comma and `parseFloat` stops at the second comma.
 */
export function simulateJhxlsxSingleCommaParse(formattedCell: string): {
  readonly trueValueUsd: number | null;
  readonly exportedValueUsd: number | "";
  readonly truncatedBySecondComma: boolean;
} {
  const trimmed = formattedCell.trim();
  if (!trimmed || trimmed === "NaN") {
    return {
      trueValueUsd: null,
      exportedValueUsd: "",
      truncatedBySecondComma: false,
    };
  }
  const trueValueUsd = Number(trimmed.replace(/,/g, ""));
  // Exact vendor code: `parseFloat(n.toString().replace(",", ""))`
  const exportedValueUsd = Number.parseFloat(trimmed.replace(",", ""));
  return {
    trueValueUsd,
    exportedValueUsd,
    truncatedBySecondComma:
      Number.isFinite(trueValueUsd) &&
      Math.abs(trueValueUsd - exportedValueUsd) > 1e-6,
  };
}

/**
 * Replicate `presetParam()` `$.ajaxPrefilter` agent resolution:
 * when `sessionStorage.MASTER_ID` is non-empty and caller supplies `data.agentID`
 * without `data.agentOwner`, `agentID` on the wire becomes `MASTER_ID` (`r`) and
 * `agentOwner` becomes the caller's `data.agentID` (`s`).
 */
export function resolvePresetParamAgents(params: {
  readonly masterId: string;
  readonly agentType: string;
  readonly dataAgentId?: string;
  readonly dataAgentOwner?: string;
}): {
  readonly injected: boolean;
  readonly wireAgentId: string | undefined;
  readonly wireAgentOwner: string | undefined;
  readonly swappedCallerAgentIntoOwner: boolean;
} {
  const { masterId, agentType, dataAgentId, dataAgentOwner } = params;
  if (!masterId || (agentType !== "M" && agentType !== "A")) {
    return {
      injected: false,
      wireAgentId: dataAgentId,
      wireAgentOwner: dataAgentOwner,
      swappedCallerAgentIntoOwner: false,
    };
  }
  let s = masterId;
  let r = s;
  if (dataAgentId) {
    s = dataAgentId;
    if (dataAgentOwner && s !== dataAgentOwner) {
      s = dataAgentOwner;
    }
  }
  if ((r as unknown) === 0) {
    r = s;
  }
  return {
    injected: true,
    wireAgentId: r,
    wireAgentOwner: s,
    swappedCallerAgentIntoOwner:
      Boolean(dataAgentId) && dataAgentId !== masterId && !dataAgentOwner,
  };
}

/**
 * Replicate `getDeletedTransactions()` actor attribution in `transaction-player`:
 * - `LastUpdateLoginID.trim() === masterId` -> `"Me"`
 * - present in `agents` (`AgentID.trim()`) -> `LastUpdateLoginID.trim()`
 * - absent from `agents` (`0 === m.length`) -> `"Cust Serv"` (masks unlisted root/clerk IDs).
 */
export function resolveDeletedTransactionActorDisplay(params: {
  readonly lastUpdateLoginId: string;
  readonly masterId: string;
  readonly knownAgentIds: readonly string[];
}): { readonly displayLabel: string; readonly maskedAsCustServ: boolean } {
  const login = params.lastUpdateLoginId.trim();
  const matched = params.knownAgentIds.some((id) => id.trim() === login);
  if (!matched) {
    return { displayLabel: "Cust Serv", maskedAsCustServ: true };
  }
  return {
    displayLabel: login === params.masterId ? "Me" : login,
    maskedAsCustServ: false,
  };
}

export interface ReportTransactionRowInput {
  readonly DocumentNumber?: number;
  readonly TranCode: "C" | "D" | string;
  readonly TranType: string;
  readonly Amount: number;
  readonly ShortDesc?: string;
  readonly TranDateTime: string;
  readonly GradeNum?: number | null;
}

export interface ReconstructedReportTransactionRow {
  readonly index: number;
  readonly tranCode: string;
  readonly tranType: string;
  readonly amountCents: number;
  readonly runningBalanceCents: number;
  readonly handledInPass2Switch: boolean;
  readonly hiddenWagerRowAtBottom: boolean;
}

const REPORT_PASS2_CREDIT_TYPES = new Set(["W", "E", "C", "T"]);
const REPORT_PASS2_DEBIT_TYPES = new Set(["L", "A", "I", "Z", "D", "Q"]);

/**
 * Replicate `customer/report/report.js` `getTransactions()`:
 * - Sent as `POST /cloud/api/Report/getTransactions` with `contentType: "application/json"`
 *   (explaining why form-urlencoded probes without JSON body fail with 500 on `/Report/`).
 * - Pass 1 reconstructs Opening Balance `u` from `CurrentBalance` using `TranCode` (`C` vs `D`).
 * - Pass 2 walks forward using `switch (h.TranType)` which OMITS `B` (Promo Credit), `N` (Promo Debit),
 *   `R` (Risk Refund), `U` (Transfer Debit), and `F`/`H` (Fees) — causing `closingBalanceCents` to drift
 *   from `currentBalanceCents` whenever those codes appear.
 * - Buffers `W` and `L` rows into `g` (`class="detailsTransaction hidden"`) and appends them AFTER all
 *   non-wager rows, scrambling chronological order in the DOM when unhidden.
 */
export function reconstructReportGetTransactions(params: {
  readonly currentBalanceCents: number;
  readonly rows: readonly ReportTransactionRowInput[];
}): {
  readonly openingBalanceCents: number;
  readonly closingBalanceCents: number;
  readonly closingBalanceDriftCents: number;
  readonly unhandledTranTypeCount: number;
  readonly domOrderRows: ReconstructedReportTransactionRow[];
} {
  let tCents = 0;
  for (const h of params.rows) {
    const amt = Math.trunc(h.Amount);
    if (h.TranCode === "C") {
      tCents -= amt;
    } else {
      tCents += amt;
    }
  }
  const openingBalanceCents = params.currentBalanceCents + tCents;
  let pCents = openingBalanceCents;
  let unhandledTranTypeCount = 0;

  const nonWagerDomRows: ReconstructedReportTransactionRow[] = [];
  const hiddenWagerDomRows: ReconstructedReportTransactionRow[] = [];

  for (let i = 0; i < params.rows.length; i++) {
    const h = params.rows[i]!;
    const amt = Math.trunc(h.Amount);
    let handledInPass2Switch = true;
    if (REPORT_PASS2_CREDIT_TYPES.has(h.TranType)) {
      pCents += amt;
    } else if (REPORT_PASS2_DEBIT_TYPES.has(h.TranType)) {
      pCents -= amt;
    } else {
      handledInPass2Switch = false;
      unhandledTranTypeCount += 1;
    }
    const hiddenWagerRowAtBottom = h.TranType === "W" || h.TranType === "L";
    const entry: ReconstructedReportTransactionRow = {
      index: i,
      tranCode: h.TranCode,
      tranType: h.TranType,
      amountCents: amt,
      runningBalanceCents: pCents,
      handledInPass2Switch,
      hiddenWagerRowAtBottom,
    };
    if (hiddenWagerRowAtBottom) {
      hiddenWagerDomRows.push(entry);
    } else {
      nonWagerDomRows.push(entry);
    }
  }

  return {
    openingBalanceCents,
    closingBalanceCents: pCents,
    closingBalanceDriftCents: pCents - params.currentBalanceCents,
    unhandledTranTypeCount,
    domOrderRows: [...nonWagerDomRows, ...hiddenWagerDomRows],
  };
}

/**
 * Replicate the 10x `/ 1e3` divisor bug in `getWagersByFigureDate` and `getWagersByFigureDateMobile`
 * when `e.graded === undefined` (`m === 3`, triggered by clicking the `DepWith` column in `getDailyFigures`
 * whose `<th>` has no `data-graded` attribute):
 * computes `T = parseFloat(Amount) / 100` (USD), but renders `drawWinLoss({ val: sign + parseFloat(Amount / 1e3) })`.
 */
export function simulateFigureDateMode3DivisorBug(
  amountCents: number,
  tranCode: "C" | "D" | string,
): {
  readonly trueSignedUsd: number;
  readonly displayedSignedUsd: number;
  readonly understatedRatio: number;
} {
  const sign = tranCode === "D" ? -1 : 1;
  const trueSignedUsd = sign * (amountCents / 100);
  const displayedSignedUsd = sign * (amountCents / 1000);
  return {
    trueSignedUsd,
    displayedSignedUsd,
    understatedRatio:
      amountCents === 0 ? 1 : trueSignedUsd / displayedSignedUsd,
  };
}

/**
 * Replicate `getDailyFigures` `casinoDaily` adjustment bug:
 * `S = casinoDaily / 100; S < 0 ? D += S : D -= S;`
 * Because adding a negative `S` and subtracting a positive `S` both subtract `Math.abs(S)`,
 * a positive `casinoDaily` and a negative `casinoDaily` produce the exact same downward shift.
 */
export function computeDailyFigureActualBalance(
  actualBalanceUsd: number,
  casinoDailyCents: number | null,
): {
  readonly displayedActualBalanceUsd: number;
  readonly effectiveDeltaUsd: number;
} {
  const s = casinoDailyCents !== null ? casinoDailyCents / 100 : 0;
  const displayedActualBalanceUsd =
    s < 0 ? actualBalanceUsd + s : actualBalanceUsd - s;
  return {
    displayedActualBalanceUsd,
    effectiveDeltaUsd: displayedActualBalanceUsd - actualBalanceUsd,
  };
}

/**
 * Extract the linked `PendingDelete` ticket number from a `LIVE_CASINO_POSTED` `Buyout` `ShortDesc`
 * (`0 === ShortDesc.search("Buyout")` -> `ShortDesc.split("ticket")[1].trim()`).
 */
export function extractBuyoutTicketNumber(shortDesc: string): string | null {
  if (shortDesc.search("Buyout") !== 0) return null;
  const parts = shortDesc.split("ticket");
  const tail = parts[1]?.trim();
  return tail ? tail : null;
}

export interface TransactionListDailyPerformanceRollup {
  readonly figureDate: string;
  readonly wonCents: number;
  readonly lostCents: number;
  readonly customerNetCents: number;
  readonly nonWagerSignedCents: number;
  readonly totalBalanceDeltaCents: number;
}

/**
 * Roll up `getTransactionList` rows by `YYYY-MM-DD` date into `getPerformancePlayer`-compatible
 * daily `{ figureDate, wonCents, lostCents, customerNetCents }` (`u = f.Won/100 - f.Lost/100`),
 * separating non-wager cash/adjustment flows (`E`, `I`, `C`, `D`, `Z`, `Q`, `B`, `N`) so
 * `SUM(customerNetCents + nonWagerSignedCents)` reconciles 100% with the ledger balance delta.
 */
export function rollupTransactionListToPerformanceDays(
  envelope: TransactionListEnvelope,
): {
  readonly days: TransactionListDailyPerformanceRollup[];
  readonly totalWonCents: number;
  readonly totalLostCents: number;
  readonly totalCustomerNetCents: number;
  readonly totalNonWagerSignedCents: number;
  readonly totalBalanceDeltaCents: number;
} {
  const normalized = envelope.LIST.map(normalizeTransactionListRow);
  const byDate = new Map<
    string,
    { wonCents: number; lostCents: number; nonWagerSignedCents: number }
  >();

  let totalWonCents = 0;
  let totalLostCents = 0;
  let totalNonWagerSignedCents = 0;

  for (const row of normalized) {
    const figureDate = row.tranDateTime.slice(0, 10);
    let bucket = byDate.get(figureDate);
    if (!bucket) {
      bucket = { wonCents: 0, lostCents: 0, nonWagerSignedCents: 0 };
      byDate.set(figureDate, bucket);
    }
    if (row.rawTranType === "W") {
      bucket.wonCents += row.amountCents;
      totalWonCents += row.amountCents;
    } else if (row.rawTranType === "L") {
      bucket.lostCents += row.amountCents;
      totalLostCents += row.amountCents;
    } else {
      bucket.nonWagerSignedCents += row.signedAmountCents;
      totalNonWagerSignedCents += row.signedAmountCents;
    }
  }

  const days: TransactionListDailyPerformanceRollup[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([figureDate, b]) => {
      const customerNetCents = b.wonCents - b.lostCents;
      return {
        figureDate,
        wonCents: b.wonCents,
        lostCents: b.lostCents,
        customerNetCents,
        nonWagerSignedCents: b.nonWagerSignedCents,
        totalBalanceDeltaCents: customerNetCents + b.nonWagerSignedCents,
      };
    });

  const totalCustomerNetCents = totalWonCents - totalLostCents;
  return {
    days,
    totalWonCents,
    totalLostCents,
    totalCustomerNetCents,
    totalNonWagerSignedCents,
    totalBalanceDeltaCents: totalCustomerNetCents + totalNonWagerSignedCents,
  };
}

export type SuspectedBotLabel =
  | "None"
  | "Steam Player"
  | "Suspected RAS"
  | "Sharp Player"
  | "BOT/Syndicate Acct";

/**
 * Replicate `player-info.data()` `SuspectedBot` / `SuspectedBotType` classification:
 * - `1` -> `"Steam Player"`
 * - `2` -> `"Suspected RAS"` (Right Angle Sports)
 * - `3` -> `"Sharp Player"` (CLV / minor markets / props / non-game periods)
 * - `default` -> `"BOT/Syndicate Acct"`
 */
export function classifySuspectedBot(params: {
  readonly suspectedBot: string | null | undefined;
  readonly suspectedBotType: number | null | undefined;
  readonly botDisplayAuthorized?: string;
}): {
  readonly badgeClassSuffix: string;
  readonly label: SuspectedBotLabel;
  readonly visibleInUi: boolean;
} {
  const botDisplay = (params.botDisplayAuthorized ?? "Y") === "Y";
  const isBot = params.suspectedBot === "Y";
  if (!botDisplay || !isBot) {
    return {
      badgeClassSuffix: "N",
      label: "None",
      visibleInUi: false,
    };
  }
  const t = params.suspectedBotType;
  const badgeClassSuffix = String(t ?? "N");
  switch (t) {
    case 1:
      return {
        badgeClassSuffix,
        label: "Steam Player",
        visibleInUi: true,
      };
    case 2:
      return {
        badgeClassSuffix,
        label: "Suspected RAS",
        visibleInUi: true,
      };
    case 3:
      return {
        badgeClassSuffix,
        label: "Sharp Player",
        visibleInUi: true,
      };
    default:
      return {
        badgeClassSuffix,
        label: "BOT/Syndicate Acct",
        visibleInUi: true,
      };
  }
}

export type PlayerAccountStatus = "active" | "disabled" | "read-only";
export type PlayerSettlementMode = "Z" | "W" | "S";
export type ParlayOddsMode =
  | "Standard"
  | "True Odds"
  | "True Odds Minus"
  | "Always by Profile"
  | "Unmapped";

/**
 * Replicate `player-info.data()` tri-state account status (`Active` x `SuspendAccount`),
 * settlement mode (`ZeroBalanceFlag` x `WeeklyLimitFlag`), and parlay odds mode
 * (`ParlayAlwaysTrueOdds` x `PayTableForAllSports` x `NotrueOdds`).
 */
export function resolvePlayerAccountState(params: {
  readonly active: "Y" | "N" | string;
  readonly suspendAccount: "Y" | "N" | string;
  readonly zeroBalanceFlag: "Y" | "N" | string;
  readonly weeklyLimitFlag: "Y" | "N" | string;
  readonly parlayAlwaysTrueOdds: "Y" | "N" | string;
  readonly payTableForAllSports: "Y" | "N" | string;
  readonly noTrueOdds: "Y" | "N" | string;
}): {
  readonly status: PlayerAccountStatus;
  readonly settlementMode: PlayerSettlementMode;
  readonly parlayOddsMode: ParlayOddsMode;
} {
  const r = params.active.trim();
  const a = params.suspendAccount.trim();
  const status: PlayerAccountStatus =
    r === "Y" && a === "N"
      ? "active"
      : r === "Y" && a === "Y"
        ? "read-only"
        : "disabled";

  const z = params.zeroBalanceFlag.trim();
  const w = params.weeklyLimitFlag.trim();
  const settlementMode: PlayerSettlementMode =
    w === "Y" ? "W" : z === "Y" ? "Z" : "S";

  const ma = params.parlayAlwaysTrueOdds.trim();
  const pa = params.payTableForAllSports.trim();
  const da = params.noTrueOdds.trim();
  let parlayOddsMode: ParlayOddsMode = "Unmapped";
  if (ma === "N" && pa === "N" && da === "N") parlayOddsMode = "Standard";
  else if (ma === "Y" && pa === "N" && da === "N") parlayOddsMode = "True Odds";
  else if (ma === "N" && pa === "N" && da === "Y")
    parlayOddsMode = "True Odds Minus";
  else if (ma === "N" && pa === "Y" && da === "N")
    parlayOddsMode = "Always by Profile";

  return { status, settlementMode, parlayOddsMode };
}

/**
 * Replicate `player-info.preSetTransaction()` bug:
 * `listenersAddTransaction()` offers 6 `tran-type` codes (`E`, `I`, `C`, `D`, `B`, `N`),
 * but `preSetTransaction()`'s `switch` only handles `E`/`C` (`+c`) and `D`/`I` (`-c`),
 * leaving `r` (`$.newBalance`) and `s` (`$.newAvailable`) at `0` for `B` (Promo Credit)
 * and `N` (Promo Debit) — zeroing out the header balance on confirmation!
 */
export function simulatePlayerInfoPreSetTransaction(params: {
  readonly currentBalanceCents: number;
  readonly availableBalanceCents: number;
  readonly tranType: string;
  readonly amountUsd: number;
}): {
  readonly previewNewBalanceUsd: number;
  readonly previewNewAvailableUsd: number;
  readonly expectedNewBalanceUsd: number;
  readonly zeroedByUnhandledPromoBug: boolean;
} {
  const curBalUsd = params.currentBalanceCents / 100;
  const availUsd = params.availableBalanceCents / 100;
  const c = params.amountUsd;

  let r = 0;
  let s = 0;
  switch (params.tranType) {
    case "E":
    case "C":
      r = c + curBalUsd;
      s = c + availUsd;
      break;
    case "D":
    case "I":
      r = curBalUsd - c;
      s = availUsd - c;
      break;
  }

  const isCredit =
    params.tranType === "E" ||
    params.tranType === "C" ||
    params.tranType === "B";
  const expectedNewBalanceUsd = isCredit ? curBalUsd + c : curBalUsd - c;

  return {
    previewNewBalanceUsd: r,
    previewNewAvailableUsd: s,
    expectedNewBalanceUsd,
    zeroedByUnhandledPromoBug:
      (params.tranType === "B" || params.tranType === "N") &&
      Math.abs(r - expectedNewBalanceUsd) > 1e-6,
  };
}

/**
 * Replicate the `graded` coercion and URL rewrite divergence between:
 * 1. `manager/report/help-report.js`: `path: "/qubic/api/Report/"` (rewritten to
 *    `"/cloud/api/Report/"` by `security.presetParam()`) and binary coercion
 *    `var a = 1 == e.graded ? 1 : 0` (collapsing `2` Casino and `3` DepWith to `0`!).
 * 2. `customer/report/report.js`: `path: "/cloud/api/Report/"` and 4-state ternary
 *    `1 == t.graded ? 1 : 0 == t.graded ? 0 : 2 == t.graded ? 2 : 3`.
 */
export function resolveWagersByFigureDateGradedMode(params: {
  readonly gradedInput: number | undefined;
  readonly apiPath?: string;
}): {
  readonly helpReportGraded: 0 | 1;
  readonly customerReportGraded: 0 | 1 | 2 | 3;
  readonly collapsedCasinoOrDepWithInHelpReport: boolean;
  readonly rewrittenUrl: string;
} {
  const g = params.gradedInput;
  const helpReportGraded: 0 | 1 = g === 1 ? 1 : 0;
  const customerReportGraded: 0 | 1 | 2 | 3 =
    g === 1 ? 1 : g === 0 ? 0 : g === 2 ? 2 : 3;
  const apiPath = params.apiPath ?? "/cloud/";
  const rawUrl = "/qubic/api/Report/getWagersByFigureDate";
  const rewrittenUrl = rawUrl.replace("qubic", apiPath.replace(/\//g, ""));

  return {
    helpReportGraded,
    customerReportGraded,
    collapsedCasinoOrDepWithInHelpReport:
      helpReportGraded !== customerReportGraded,
    rewrittenUrl,
  };
}

export type SecurityPostAuthAction =
  | "showReset"
  | "captcha_challenge"
  | "validCaptcha"
  | "authenticate_otp_setup"
  | "authenticate_otp_login"
  | "authenticate_normal_lostSession"
  | "authenticate_normal_agent"
  | "authenticate_normal_player";

/**
 * Replicate `system/security.js` (`authenticate`, `showReset`/`SavePass`, `verifySession`, `refresh`)
 * wire normalization and defects:
 * 1. `customerID` & `password` call `.toString().toLocaleUpperCase().trim()`, whereas
 *    `client_id` calls `.toString().toLocaleUpperCase()` WITHOUT `.trim()`, and `SavePass`
 *    sends `password: String(val).trim()` WITHOUT `.toLocaleUpperCase()`.
 * 2. Captcha gate `var c = o.find("#agToken"); a.accountInfo && "Y" == a.accountInfo.UseCaptcha && !c && (d = !0)`:
 *    because `c` is a jQuery wrapper object (`typeof c === "object"`), `!c` is ALWAYS `false`,
 *    making `captcha_challenge` and `validCaptcha` unreachable dead code!
 * 3. `authenticate_normal` for `AgentType` `"M"`/`"A"` with `AgentSkinOverride === "Classic"`
 *    immediately calls `o.lostSession()`.
 * 4. `verifySession()` returns `!1` (`false`) in both branches of its ternary, and `refresh()`
 *    updates `e.__proto__.token = t.code` in memory without persisting `sessionStorage.token`.
 */
export function simulateSecurityAuthenticate(params: {
  readonly rawUser: string;
  readonly rawPassword: string;
  readonly rawNewPasswordForSavePass?: string;
  readonly agTokenValue?: string;
  readonly responseReset?: number;
  readonly responseTokenAuth?: number;
  readonly responseOtpSetup?: string;
  readonly useCaptchaFlag?: "Y" | "N";
  readonly agentType?: "M" | "A" | "P" | string;
  readonly agentSkinOverride?: string;
  readonly initialSessionToken?: string;
  readonly renewedTokenCode?: string;
}): {
  readonly operation: "authenticateCustomer" | "authenticateCustomerforAgent";
  readonly customerID: string;
  readonly clientId: string;
  readonly clientIdHasUntrimmedWhitespace: boolean;
  readonly loginPasswordSent: string;
  readonly savePassPasswordSent: string | null;
  readonly savePassCaseMismatchOnNextLogin: boolean;
  readonly captchaGateEvaluatedTrue: boolean;
  readonly postAuthAction: SecurityPostAuthAction;
  readonly verifySessionReturnValue: false;
  readonly inMemoryTokenAfterRefresh: string | null;
  readonly sessionStorageTokenAfterRefresh: string | null;
  readonly tokenDesyncAfterRefresh: boolean;
} {
  const agToken = params.agTokenValue ?? "";
  const operation =
    agToken !== "" ? "authenticateCustomerforAgent" : "authenticateCustomer";
  const customerID = params.rawUser.toString().toLocaleUpperCase().trim();
  const clientId = params.rawUser.toString().toLocaleUpperCase();
  const loginPasswordSent = params.rawPassword
    .toString()
    .toLocaleUpperCase()
    .trim();

  const savePassPasswordSent =
    params.rawNewPasswordForSavePass !== undefined
      ? String(params.rawNewPasswordForSavePass).trim()
      : null;
  const savePassCaseMismatchOnNextLogin =
    savePassPasswordSent !== null &&
    savePassPasswordSent !== savePassPasswordSent.toLocaleUpperCase();

  // In security.js: `var c = o.find("#agToken");` (a jQuery object, always truthy)
  // `a.accountInfo && "Y" == a.accountInfo.UseCaptcha && !c && (d = !0)`
  const jqueryWrapperObject = { length: agToken !== "" ? 1 : 0 };
  const captchaGateEvaluatedTrue = Boolean(
    params.useCaptchaFlag === "Y" && !jqueryWrapperObject,
  );

  let postAuthAction: SecurityPostAuthAction;
  if (params.responseReset === 1) {
    postAuthAction = "showReset";
  } else if (captchaGateEvaluatedTrue) {
    postAuthAction = "captcha_challenge";
  } else if (params.responseTokenAuth === 1) {
    postAuthAction =
      (params.responseOtpSetup ?? "") !== ""
        ? "authenticate_otp_setup"
        : "authenticate_otp_login";
  } else if (params.agentType === "M" || params.agentType === "A") {
    postAuthAction =
      params.agentSkinOverride === "Classic"
        ? "authenticate_normal_lostSession"
        : "authenticate_normal_agent";
  } else {
    postAuthAction = "authenticate_normal_player";
  }

  // verifySession() returns `!1` (false) in both branches; refresh() mutates e.__proto__.token
  // without updating sessionStorage.token
  const sessionToken = params.initialSessionToken ?? null;
  const inMemoryTokenAfterRefresh = params.renewedTokenCode ?? sessionToken;
  const sessionStorageTokenAfterRefresh = sessionToken;

  return {
    operation,
    customerID,
    clientId,
    clientIdHasUntrimmedWhitespace: clientId !== customerID,
    loginPasswordSent,
    savePassPasswordSent,
    savePassCaseMismatchOnNextLogin,
    captchaGateEvaluatedTrue,
    postAuthAction,
    verifySessionReturnValue: false,
    inMemoryTokenAfterRefresh,
    sessionStorageTokenAfterRefresh,
    tokenDesyncAfterRefresh:
      inMemoryTokenAfterRefresh !== sessionStorageTokenAfterRefresh,
  };
}

export interface RawReportPlayerAnalysisRow {
  readonly CustomerID: string;
  readonly PlayerLogin: string;
  readonly AgentID: string;
  readonly AgentLogin: string;
  readonly BETPOINTS: string;
  readonly JUICE: string;
  readonly CLOSELINE: string;
  readonly PRICE: number | string | null;
  readonly POINTS: number;
  readonly DESCRIPTION: string;
  readonly DAILYFIGUREDATE: string;
  readonly RISK: string;
  readonly TOWIN: string;
  readonly WINLOSE: string;
  readonly WAGERSTATUS: "W" | "L" | "P" | "X" | string;
  readonly SPORTSUBTYPE: string;
  readonly PERIODNUMBER: string;
  readonly POSTEDDATETIME: string;
  readonly SuspectedBot: "Y" | "N" | string;
  readonly SuspectedBotType: string | number;
  readonly InetTarget: string;
  readonly TOTALBETS: number | string | null;
  readonly BETTERPRICELINES: number | string | null;
  readonly BETTERPOINTSLINES: number | string | null;
}

export type PlayerAnalysisMarketKind = "SPREAD" | "TOTAL_OVER" | "TOTAL_UNDER";

export interface NormalizedReportPlayerAnalysisRow {
  readonly customerId: string;
  readonly rawCustomerIdLength: number;
  readonly playerLogin: string;
  readonly isSubAccountCustomerId: boolean;
  readonly agentId: string;
  readonly rawAgentIdLength: number;
  readonly agentLogin: string;
  readonly agentLoginEqualsPlayerLogin: boolean;
  readonly betPoints: number;
  readonly betJuice: number;
  readonly closePoints: number;
  readonly closeJuice: number;
  readonly rawPointsField: number;
  readonly expectedPointsField: number;
  readonly pointsFormulaExactMatch: boolean;
  /** Positive when player beat the closing line (`-POINTS`). */
  readonly playerClvPoints: number;
  readonly beatClosingPoints: boolean;
  readonly marketKind: PlayerAnalysisMarketKind;
  readonly description: string;
  readonly dailyFigureDateIso: string;
  readonly postedDateIso: string;
  readonly postedDateTime: string;
  readonly postedBeforeFigureDate: boolean;
  readonly riskCents: number;
  readonly toWinCents: number;
  readonly unsignedWinLoseCents: number;
  readonly signedCustomerNetCents: number;
  readonly winLoseMatchesOutcomeInvariant: boolean;
  readonly wagerStatus: string;
  readonly sportSubType: string;
  readonly rawSportSubTypeLength: number;
  readonly periodNumber: number;
  readonly suspectedBot: string;
  readonly suspectedBotTypeString: string;
  readonly inetTarget: string;
}

export interface ReportPlayerAnalysisSummary {
  readonly rowCount: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly totalWonCents: number;
  readonly totalLostCents: number;
  readonly totalSignedCustomerNetCents: number;
  readonly positiveClvCount: number;
  readonly negativeClvCount: number;
  readonly neutralClvCount: number;
  readonly positiveClvRate: number;
  readonly totalRawPointsField: number;
  readonly totalPlayerClvPoints: number;
  readonly avgPlayerClvPoints: number;
  readonly allPointsFormulasMatch: boolean;
  readonly allWinLoseInvariantsHold: boolean;
  readonly advanceWagerCount: number;
  readonly bySportSubType: Readonly<Record<string, number>>;
}

/**
 * Parse and validate `POST /cloud/api/Manager/getReportPlayerAnalysis` envelope `{"LIST": [...]}`.
 */
export function parseReportPlayerAnalysisEnvelope(
  input: unknown,
): readonly RawReportPlayerAnalysisRow[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("getReportPlayerAnalysis envelope must be an object");
  }
  const list = (input as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) {
    throw new TypeError("getReportPlayerAnalysis envelope missing LIST array");
  }
  return list as RawReportPlayerAnalysisRow[];
}

/**
 * Normalize a single `getReportPlayerAnalysis` row, verifying:
 * - Fixed-width SQL `CHAR(10)` padding on `CustomerID` and `AgentID`, and `CHAR(20)` on `SPORTSUBTYPE`
 * - `CLOSELINE` `"<closePoints> <closeJuice>"` parsing
 * - Vendor `POINTS` formula:
 *   - `SPREAD` and `TOTAL_UNDER`: `POINTS = closePoints - betPoints`
 *   - `TOTAL_OVER`: `POINTS = betPoints - closePoints`
 *   - In all cases, `POINTS < 0` means the player beat the closing line (`playerClvPoints = -POINTS > 0`).
 * - Unsigned cent strings `RISK`, `TOWIN`, `WINLOSE` (`W -> WINLOSE === TOWIN`, `L -> WINLOSE === RISK`).
 */
export function normalizeReportPlayerAnalysisRow(
  row: RawReportPlayerAnalysisRow,
): NormalizedReportPlayerAnalysisRow {
  const customerId = row.CustomerID.trim();
  const playerLogin = row.PlayerLogin.trim();
  const agentId = row.AgentID.trim();
  const agentLogin = row.AgentLogin.trim();
  const sportSubType = row.SPORTSUBTYPE.trim();

  const betPoints = Number.parseFloat(row.BETPOINTS);
  const betJuice = Number.parseFloat(row.JUICE);
  const closeTokens = row.CLOSELINE.trim().split(/\s+/);
  const closePoints = Number.parseFloat(closeTokens[0] ?? "0");
  const closeJuice = Number.parseFloat(closeTokens[1] ?? "0");

  // Detect Over / Under / Spread from DESCRIPTION
  const marketKind: PlayerAnalysisMarketKind = /\sO\s+\d/.test(row.DESCRIPTION)
    ? "TOTAL_OVER"
    : /\sU\s+\d/.test(row.DESCRIPTION)
      ? "TOTAL_UNDER"
      : "SPREAD";

  const expectedPointsField =
    marketKind === "TOTAL_OVER"
      ? betPoints - closePoints
      : closePoints - betPoints;
  const pointsFormulaExactMatch =
    Math.abs(row.POINTS - expectedPointsField) < 1e-6;
  const playerClvPoints = Math.abs(row.POINTS) < 1e-9 ? 0 : -Number(row.POINTS);

  const riskCents = Number.parseInt(row.RISK, 10);
  const toWinCents = Number.parseInt(row.TOWIN, 10);
  const unsignedWinLoseCents = Number.parseInt(row.WINLOSE, 10);
  const wagerStatus = row.WAGERSTATUS.trim();
  const signedCustomerNetCents =
    wagerStatus === "W"
      ? unsignedWinLoseCents
      : wagerStatus === "L"
        ? -unsignedWinLoseCents
        : 0;
  const winLoseMatchesOutcomeInvariant =
    (wagerStatus === "W" && unsignedWinLoseCents === toWinCents) ||
    (wagerStatus === "L" && unsignedWinLoseCents === riskCents);

  const dailyFigureDateIso = row.DAILYFIGUREDATE.slice(0, 10);
  const postedDateIso = row.POSTEDDATETIME.slice(0, 10);

  return {
    customerId,
    rawCustomerIdLength: row.CustomerID.length,
    playerLogin,
    isSubAccountCustomerId:
      customerId !== playerLogin && customerId.startsWith(`${playerLogin}_`),
    agentId,
    rawAgentIdLength: row.AgentID.length,
    agentLogin,
    agentLoginEqualsPlayerLogin: agentLogin === playerLogin,
    betPoints,
    betJuice,
    closePoints,
    closeJuice,
    rawPointsField: row.POINTS,
    expectedPointsField,
    pointsFormulaExactMatch,
    playerClvPoints,
    beatClosingPoints: playerClvPoints > 0,
    marketKind,
    description: row.DESCRIPTION,
    dailyFigureDateIso,
    postedDateIso,
    postedDateTime: row.POSTEDDATETIME,
    postedBeforeFigureDate: postedDateIso < dailyFigureDateIso,
    riskCents,
    toWinCents,
    unsignedWinLoseCents,
    signedCustomerNetCents,
    winLoseMatchesOutcomeInvariant,
    wagerStatus,
    sportSubType,
    rawSportSubTypeLength: row.SPORTSUBTYPE.length,
    periodNumber: Number.parseInt(row.PERIODNUMBER, 10),
    suspectedBot: row.SuspectedBot.trim(),
    suspectedBotTypeString: String(row.SuspectedBotType),
    inetTarget: row.InetTarget.trim(),
  };
}

/**
 * Summarize a normalized `getReportPlayerAnalysis` dataset into win/loss, cent-scaled PnL,
 * CLV beat rate, and sport-subtype counts.
 */
export function summarizeReportPlayerAnalysis(
  rows: readonly RawReportPlayerAnalysisRow[],
): ReportPlayerAnalysisSummary {
  let winCount = 0;
  let lossCount = 0;
  let totalRiskCents = 0;
  let totalToWinCents = 0;
  let totalWonCents = 0;
  let totalLostCents = 0;
  let totalSignedCustomerNetCents = 0;
  let positiveClvCount = 0;
  let negativeClvCount = 0;
  let neutralClvCount = 0;
  let totalRawPointsField = 0;
  let totalPlayerClvPoints = 0;
  let allPointsFormulasMatch = true;
  let allWinLoseInvariantsHold = true;
  let advanceWagerCount = 0;
  const bySportSubType: Record<string, number> = {};

  for (const raw of rows) {
    const n = normalizeReportPlayerAnalysisRow(raw);
    if (n.wagerStatus === "W") {
      winCount += 1;
      totalWonCents += n.unsignedWinLoseCents;
    } else if (n.wagerStatus === "L") {
      lossCount += 1;
      totalLostCents += n.unsignedWinLoseCents;
    }
    totalRiskCents += n.riskCents;
    totalToWinCents += n.toWinCents;
    totalSignedCustomerNetCents += n.signedCustomerNetCents;

    if (n.playerClvPoints > 0) positiveClvCount += 1;
    else if (n.playerClvPoints < 0) negativeClvCount += 1;
    else neutralClvCount += 1;

    totalRawPointsField += n.rawPointsField;
    totalPlayerClvPoints += n.playerClvPoints;
    if (!n.pointsFormulaExactMatch) allPointsFormulasMatch = false;
    if (!n.winLoseMatchesOutcomeInvariant) allWinLoseInvariantsHold = false;
    if (n.postedBeforeFigureDate) advanceWagerCount += 1;
    bySportSubType[n.sportSubType] = (bySportSubType[n.sportSubType] ?? 0) + 1;
  }

  const rowCount = rows.length;
  return {
    rowCount,
    winCount,
    lossCount,
    totalRiskCents,
    totalToWinCents,
    totalWonCents,
    totalLostCents,
    totalSignedCustomerNetCents,
    positiveClvCount,
    negativeClvCount,
    neutralClvCount,
    positiveClvRate: rowCount > 0 ? positiveClvCount / rowCount : 0,
    totalRawPointsField,
    totalPlayerClvPoints,
    avgPlayerClvPoints: rowCount > 0 ? totalPlayerClvPoints / rowCount : 0,
    allPointsFormulasMatch,
    allWinLoseInvariantsHold,
    advanceWagerCount,
    bySportSubType,
  };
}

export interface ManagerHeaderHtmlAnalysis {
  readonly rawAgentTexts: readonly string[];
  readonly trimmedAgentId: string;
  readonly rawAgentFieldLength: number;
  readonly jqueryTextConcatenationTrap: string;
  readonly searchAgentsPanelCount: number;
  readonly activeSearchComponentCount: number;
  readonly hiddenPasswordHoneypotCount: number;
  readonly newPasswordSearchInputCount: number;
  readonly duplicateBasicAddon1IdCount: number;
  readonly quickMenuActions: readonly string[];
  readonly glypthIconTypoClasses: readonly string[];
  readonly brandLogoSrc: string | null;
}

/**
 * Forensically parse the Manager portal `<section id="header">` DOM:
 * - Extracts all `<span data-field="agent">` nodes (which carry un-trimmed SQL `CHAR(10)`
 *   strings like `"AGENT_BB  "` and concatenate into `"AGENT_BB  AGENT_BB  AGENT_BB  "` if
 *   queried via `$('[data-field="agent"]').text()` without `.first().text().trim()`).
 * - Counts `[data-panel="search-agents"]` mounts (4 in `#header`), `.search-component[data-type="all"]`
 *   instances (2 in `#header`), hidden `<input type="password" name="password" style="display:none">`
 *   autofill honeypots, and duplicate `id="basic-addon1"` attributes.
 * - Extracts quick-menu `data-action` dispatchers and `glypth-*` icon class typos.
 */
export function parseManagerHeaderHtml(
  html: string,
): ManagerHeaderHtmlAnalysis {
  // Strip HTML comments before counting active DOM elements
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, "");

  const rawAgentTexts: string[] = [];
  const agentRe = /<span[^>]*\bdata-field="agent"[^>]*>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = agentRe.exec(uncommented)) !== null) {
    rawAgentTexts.push(m[1] ?? "");
  }

  const firstRaw = rawAgentTexts[0] ?? "";
  const trimmedAgentId = firstRaw.trim();
  const jqueryTextConcatenationTrap = rawAgentTexts.join("");

  const searchAgentsPanelCount = (
    uncommented.match(/\bdata-panel="search-agents"/g) ?? []
  ).length;
  const activeSearchComponentCount = (
    uncommented.match(/class="search-component"\s+data-type="all"/g) ?? []
  ).length;
  const hiddenPasswordHoneypotCount = (
    uncommented.match(
      /<input\s+type="password"\s+name="password"\s+style="display:none">/g,
    ) ?? []
  ).length;
  const newPasswordSearchInputCount = (
    uncommented.match(
      /<input\s+data-search="true"\s+type="text"\s+autocomplete="new-password"/g,
    ) ?? []
  ).length;
  const duplicateBasicAddon1IdCount = (
    uncommented.match(/\bid="basic-addon1"/g) ?? []
  ).length;

  const quickMenuActions: string[] = [];
  const quickMenuBlockMatch = uncommented.match(
    /<ul\s+class="l-menu-mobile[^"]*"[^>]*>([\s\S]*?)<\/ul>/i,
  );
  if (quickMenuBlockMatch?.[1]) {
    const liActionRe = /<li[^>]*\bdata-action="([^"]+)"/gi;
    let lm: RegExpExecArray | null;
    while ((lm = liActionRe.exec(quickMenuBlockMatch[1])) !== null) {
      if (lm[1]) quickMenuActions.push(lm[1]);
    }
  }

  const glypthIconTypoClasses: string[] = [];
  const glypthRe = /\b(glypth-[a-z0-9-]+)\b/gi;
  let gm: RegExpExecArray | null;
  while ((gm = glypthRe.exec(uncommented)) !== null) {
    if (gm[1] && !glypthIconTypoClasses.includes(gm[1])) {
      glypthIconTypoClasses.push(gm[1]);
    }
  }

  const logoMatch = uncommented.match(
    /<img[^>]*\bsrc="([^"]+)"[^>]*\bclass="brand-logo"/i,
  );

  return {
    rawAgentTexts,
    trimmedAgentId,
    rawAgentFieldLength: firstRaw.length,
    jqueryTextConcatenationTrap,
    searchAgentsPanelCount,
    activeSearchComponentCount,
    hiddenPasswordHoneypotCount,
    newPasswordSearchInputCount,
    duplicateBasicAddon1IdCount,
    quickMenuActions,
    glypthIconTypoClasses,
    brandLogoSrc: logoMatch?.[1] ?? null,
  };
}

/**
 * Replicate `manager/module/customer-admin/wager-player` (`wager-player.js`) lifecycle and defects:
 * 1. `get()` checks `if (t.inModule === this.module) ;` (an empty semicolon statement!), so switching
 *    customers while already in `"wager-player"` is a silent no-op that never refreshes the view.
 * 2. `listeners()` binds `[data-action="delete-transaction"]` to `e.deleteTransaction()`, which does
 *    not exist on `wager-player` (copy-pasted from `transaction-player`).
 * 3. `wagers(e)` completely ignores its `{ day, type }` argument and delegates to `pending-thin.pending()`
 *    with a hardcoded 730-day (`2`-year) lookback (`sort: 5, typeSort: 2, typeReport: "wager-tab"`).
 * 4. The `[data-list="time"]` change handler omits `agentID` (`p.info.data.AgentID`) and `totals: false`
 *    when re-invoking `m.pending(...)`.
 */
export function simulateWagerPlayerModule(params: {
  readonly currentUiModule: string;
  readonly player: string;
  readonly playerAgentId: string;
  readonly managerId: string;
  readonly nowIsoDate: string;
  readonly timeSelectDays?: number;
}): {
  readonly getTriggeredRefresh: boolean;
  readonly displayedPlayerLabel: string;
  readonly auditLogEntries: readonly {
    readonly customerID: string;
    readonly description: string;
  }[];
  readonly initialPendingThinArgs: {
    readonly customerID: string;
    readonly agentID: string;
    readonly totals: false;
    readonly typeReport: "wager-tab";
    readonly date: string;
    readonly sort: 5;
    readonly typeSort: 2;
  } | null;
  readonly timeChangePendingThinArgs: {
    readonly customerID: string;
    readonly agentID: undefined;
    readonly totals: undefined;
    readonly typeReport: "wager-tab";
    readonly date: string;
    readonly sort: 5;
    readonly typeSort: 2;
  } | null;
  readonly hasUndefinedDeleteTransactionMethodBug: true;
  readonly timeChangeOmitsAgentIdAndTotals: boolean;
} {
  // In wager-player.get(): `if (..., t.inModule === this.module) ; else { ... }`
  const alreadyInWagerPlayer = params.currentUiModule === "wager-player";
  const getTriggeredRefresh = !alreadyInWagerPlayer;

  const baseMs = Date.parse(`${params.nowIsoDate}T00:00:00Z`);
  const subtractDays = (days: number): string =>
    new Date(baseMs - days * 86_400_000).toISOString().slice(0, 10);

  const displayedPlayerLabel = params.player.toString().trim().replace(".", "");

  const auditLogEntries = getTriggeredRefresh
    ? [
        {
          customerID: params.managerId,
          description: "View Section Wagers",
        },
        {
          customerID: params.managerId,
          description: "Get Data / Wagers / Pending",
        },
      ]
    : [];

  const initialPendingThinArgs = getTriggeredRefresh
    ? {
        customerID: params.player,
        agentID: params.playerAgentId,
        totals: false as const,
        typeReport: "wager-tab" as const,
        date: subtractDays(730),
        sort: 5 as const,
        typeSort: 2 as const,
      }
    : null;

  const timeChangePendingThinArgs =
    getTriggeredRefresh && params.timeSelectDays !== undefined
      ? {
          customerID: params.player,
          agentID: undefined,
          totals: undefined,
          typeReport: "wager-tab" as const,
          date: subtractDays(params.timeSelectDays),
          sort: 5 as const,
          typeSort: 2 as const,
        }
      : null;

  return {
    getTriggeredRefresh,
    displayedPlayerLabel,
    auditLogEntries,
    initialPendingThinArgs,
    timeChangePendingThinArgs,
    hasUndefinedDeleteTransactionMethodBug: true,
    timeChangeOmitsAgentIdAndTotals:
      initialPendingThinArgs !== null &&
      timeChangePendingThinArgs !== null &&
      initialPendingThinArgs.agentID !== undefined &&
      timeChangePendingThinArgs.agentID === undefined,
  };
}
