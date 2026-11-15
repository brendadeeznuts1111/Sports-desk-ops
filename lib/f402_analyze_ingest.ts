/**
 * Ingest projections over a Fantasy402 read-only puller output directory.
 * Passwords and similar secret fields are dropped. Raw IPs stay on the
 * in-memory weblog projection for linking and are hashed before any summary.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  parseCustomerAdminListEnvelope,
  trimPaddedField as trimCustomerAdminField,
} from "./f402_customer_admin_list.ts";
import { parseDeletedTransactionHistoryEnvelope } from "./f402_deleted_transaction_history.ts";
import {
  normalizeAgentTreePlayerRows,
  parseListAgentsByAgentEnvelope,
} from "./f402_list_agents_by_agent.ts";
import { parseFigureDateWagersPayload } from "./f402_figure_date_enricher.ts";
import { extractPendingLegs } from "./f402_pending_fetch.ts";
import {
  extractGradedRows,
  extractTickerRows,
  loadCheckpoint,
  parseHierarchyList,
  redactSecrets,
} from "./f402_readonly_puller.ts";
import {
  normalizeTransactionListRow,
  parseTransactionListEnvelope,
  type TransactionListRowRaw,
} from "./f402_transaction_list.ts";
import { parseOperation, parseAccessMs } from "./f402_weblog.ts";
import { parseWebLogListPayload } from "./f402_weblog_fetch.ts";

export type F402AnalyzeErrorCode = "config" | "ingest" | "io" | "empty";

export class F402AnalyzeError extends Error {
  readonly code: F402AnalyzeErrorCode;
  readonly operation: string;

  constructor(code: F402AnalyzeErrorCode, operation: string, message: string) {
    super(`f402-analyze ${operation}: ${message}`);
    this.name = "F402AnalyzeError";
    this.code = code;
    this.operation = operation;
  }
}

export type LedgerFamily =
  | "wager"
  | "transfer"
  | "deposit"
  | "withdrawal"
  | "adjustment"
  | "promo"
  | "fee"
  | "other";

export type LedgerDirection = "credit" | "debit" | "either";

export interface TranTypeSpec {
  readonly code: string;
  readonly label: string;
  readonly direction: LedgerDirection;
  readonly family: LedgerFamily;
}

/** #55-compatible TranType catalog (vendor util.trans / status / UI filter). */
export const TRAN_TYPE_SPECS: Readonly<Record<string, TranTypeSpec>> = {
  A: { code: "A", label: "Placed", direction: "debit", family: "wager" },
  W: { code: "W", label: "Win", direction: "credit", family: "wager" },
  L: { code: "L", label: "Loss", direction: "debit", family: "wager" },
  X: { code: "X", label: "Cancel", direction: "either", family: "wager" },
  E: { code: "E", label: "Deposit", direction: "credit", family: "deposit" },
  I: {
    code: "I",
    label: "Withdrawal",
    direction: "debit",
    family: "withdrawal",
  },
  C: {
    code: "C",
    label: "Credit Adjustment",
    direction: "credit",
    family: "adjustment",
  },
  D: {
    code: "D",
    label: "Debit Adjustment",
    direction: "debit",
    family: "adjustment",
  },
  F: { code: "F", label: "Fees Credit", direction: "credit", family: "fee" },
  H: { code: "H", label: "Fees Debit", direction: "debit", family: "fee" },
  B: { code: "B", label: "Promo Credit", direction: "credit", family: "promo" },
  N: { code: "N", label: "Promo Debit", direction: "debit", family: "promo" },
  T: {
    code: "T",
    label: "Transfer Credit",
    direction: "credit",
    family: "transfer",
  },
  U: {
    code: "U",
    label: "Transfer Debit",
    direction: "debit",
    family: "transfer",
  },
  Z: {
    code: "Z",
    label: "Zero Balance Debit",
    direction: "debit",
    family: "other",
  },
  Q: {
    code: "Q",
    label: "Agent Distribution",
    direction: "debit",
    family: "fee",
  },
  R: { code: "R", label: "Risk Refund", direction: "credit", family: "other" },
};

export function signedAmountCents(
  tranType: string,
  tranCode: string,
  amountCents: number,
): number {
  const abs = Math.abs(Math.trunc(amountCents));
  const spec = TRAN_TYPE_SPECS[tranType.trim()];
  if (spec?.direction === "debit") return -abs;
  if (spec?.direction === "credit") return abs;
  if (tranCode === "D") return -abs;
  if (tranCode === "C") return abs;
  return Math.trunc(amountCents);
}

const TICKET_IN_TEXT = /(?:ticket|tkt)\s*#?\s*(\d+)/i;
const TICKET_COLON = /Ticket:\s*(\d+)/i;

export function parseTicketFromText(value: string): string | null {
  const colon = TICKET_COLON.exec(value);
  if (colon?.[1]) return colon[1];
  const named = TICKET_IN_TEXT.exec(value);
  if (named?.[1]) return named[1];
  return null;
}

/**
 * Port of the measured 4C `parseAction` (Operation or Data). The ticket id,
 * risk, and win live in free text; getWebLog has no wager column.
 */
export interface ParsedWeblogAction {
  readonly kind:
    | "wager"
    | "bet"
    | "ticket"
    | "token"
    | "login"
    | "line-change"
    | "view"
    | "lines"
    | "other";
  readonly mobile: boolean;
  readonly ticket: string | null;
  readonly risk: number | null;
  readonly win: number | null;
  readonly eventId: string | null;
  readonly sport: string | null;
  readonly period: string | null;
  readonly client: string | null;
}

export function parseWeblogAction(action: string): ParsedWeblogAction {
  const s = String(action ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const kind: ParsedWeblogAction["kind"] = /Wager Accepted/i.test(s)
    ? "wager"
    : /API LOG \| Bet :/i.test(s)
      ? "bet"
      : /API LOG \| Ticket:/i.test(s)
        ? "ticket"
        : /Login successful Token/i.test(s)
          ? "token"
          : /Login successful/i.test(s)
            ? "login"
            : /CHANGE LINE/i.test(s)
              ? "line-change"
              : /View (Pending|Daily Figures)/i.test(s)
                ? "view"
                : /Straight Lines Displayed/i.test(s)
                  ? "lines"
                  : "other";
  const ticket = s.match(/Ticket:\s*(\d+)/i)?.[1] ?? null;
  const riskRaw = s.match(/Risk:\s*([\d.]+)/i)?.[1];
  const winRaw = s.match(/Win:\s*([\d.]+)/i)?.[1];
  const eventId = s.match(/#(\d+)/)?.[1] ?? null;
  const sport = s.match(/Bet :\s*([A-Za-z]+)/)?.[1] ?? null;
  const period = s.match(/-\s*For ([^-]+)$/i)?.[1]?.trim() ?? null;
  const clientMatch = s.match(/v(\d+\.\d+\.\d+)/);
  return {
    kind,
    mobile: /\(M\)/.test(s),
    ticket,
    risk: riskRaw === undefined ? null : Number(riskRaw),
    win: winRaw === undefined ? null : Number(winRaw),
    eventId,
    sport,
    period,
    client: clientMatch ? `v${clientMatch[1]}` : null,
  };
}

export function parseWeblogTicket(
  operation: string,
  data: string,
): string | null {
  return (
    parseWeblogAction(operation).ticket ??
    (data ? parseWeblogAction(data).ticket : null)
  );
}

export function parseTimestampMs(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return Number.NaN;
  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) return direct;
  return parseAccessMs(trimmed);
}

export interface CensusAccountSnapshot {
  readonly snapshotId: string;
  readonly takenAtIso: string;
  readonly accountId: string;
  readonly login: string;
  readonly agent: string;
  readonly nameFirst: string;
  readonly creditLimitCents: number | null;
}

export interface AnalyzedAccount {
  readonly accountId: string;
  readonly login: string;
  readonly nameFirst: string;
  readonly agentBySnapshot: Readonly<Record<string, string>>;
  readonly snapshots: readonly string[];
  readonly creditLimitCents: number | null;
  readonly agentChanged: boolean | null;
}

export interface LedgerRow {
  readonly accountId: string;
  readonly documentNumber: number;
  readonly tranCode: string;
  readonly tranType: string;
  readonly kindLabel: string;
  readonly family: LedgerFamily;
  readonly amountCents: number;
  readonly signedAmountCents: number;
  readonly balanceCents: number | null;
  readonly enteredBy: string;
  readonly description: string;
  readonly tranDateTime: string;
  readonly tranMs: number;
  readonly ticket: string | null;
  readonly gradeNum: number | null;
  readonly deleted: boolean;
}

export interface WeblogRow {
  readonly accessDateTime: string;
  readonly accessMs: number;
  readonly ipAddress: string;
  readonly loginId: string;
  readonly operation: string;
  readonly data: string;
  readonly ticket: string | null;
  readonly actionKind: string;
  readonly deviceClass: "M" | "D" | "UNKNOWN";
  readonly clientVersion: string | null;
  readonly skinDomain: string | null;
  readonly risk: number | null;
  readonly win: number | null;
}

export type WagerSource = "pending" | "ticker" | "graded" | "figure-date";

export interface WagerLeg {
  readonly eventKey: string;
  readonly lineKey: string;
  readonly sport: string;
  readonly period: string;
  readonly team1: string;
  readonly team2: string;
  readonly chosen: string;
  readonly lineType: "spread" | "total" | "money" | "other";
  readonly line: string;
}

export interface WagerRow {
  readonly source: WagerSource;
  readonly accountId: string;
  readonly ticketNumber: string;
  readonly wagerNumber: string;
  readonly playNumber: string;
  readonly amountWagered: number;
  readonly toWinAmount: number;
  readonly acceptedDateTime: string;
  readonly acceptedMs: number;
  readonly wagerType: string;
  readonly sport: string;
  readonly market: string;
  readonly period: string;
  readonly description: string;
  readonly legs: readonly WagerLeg[];
  readonly origLine: string | null;
  readonly adjLine: string | null;
  readonly documentNumber: number | null;
  readonly gradeNum: number | null;
}

export interface PullProjection {
  readonly inDir: string;
  readonly accounts: readonly AnalyzedAccount[];
  readonly ledger: readonly LedgerRow[];
  readonly weblog: readonly WeblogRow[];
  readonly wagers: readonly WagerRow[];
  readonly snapshotIds: readonly string[];
  readonly censusSnapshotCount: number;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new F402AnalyzeError(
      "io",
      "ingest",
      `cannot read ${path}: ${message}`,
    );
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir);
}

function isoFromSnapshotId(id: string, fallbackMs: number): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return `${id}T00:00:00.000Z`;
  const parsed = Date.parse(id);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(fallbackMs).toISOString();
}

function parseCreditLimitCents(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.abs(raw) >= 1000 ? Math.trunc(raw) : Math.round(raw * 100);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number.parseFloat(raw.trim());
    if (!Number.isFinite(n)) return null;
    return Math.abs(n) >= 1000 ? Math.trunc(n) : Math.round(n * 100);
  }
  return null;
}

function loadListAgents(path: string): {
  readonly players: ReturnType<typeof normalizeAgentTreePlayerRows>;
  readonly creditById: Map<string, number>;
} {
  const envelope = parseListAgentsByAgentEnvelope(
    redactSecrets(readJson(path)),
  );
  const players = normalizeAgentTreePlayerRows(envelope.PLAYERS);
  const creditById = new Map<string, number>();
  for (const raw of envelope.PLAYERS) {
    const id = String(raw.customerID ?? raw.Login ?? "").trim();
    const limit = parseCreditLimitCents(
      (raw as { CreditLimit?: unknown }).CreditLimit,
    );
    if (id !== "" && limit !== null) creditById.set(id, limit);
  }
  return { players, creditById };
}

function discoverSnapshots(inDir: string): {
  readonly snapshotId: string;
  readonly takenAtIso: string;
  readonly listPath: string;
  readonly hierarchyPath: string | null;
}[] {
  const found: {
    snapshotId: string;
    takenAtIso: string;
    listPath: string;
    hierarchyPath: string | null;
  }[] = [];
  const primary = join(inDir, "census", "getListAgenstByAgent.json");
  if (existsSync(primary)) {
    const checkpoint = loadCheckpoint(inDir);
    const takenAtIso =
      checkpoint?.updatedAtIso ??
      new Date(statSync(primary).mtimeMs).toISOString();
    found.push({
      snapshotId: "current",
      takenAtIso,
      listPath: primary,
      hierarchyPath: existsSync(join(inDir, "census", "getHeriarchy.json"))
        ? join(inDir, "census", "getHeriarchy.json")
        : null,
    });
  }
  const snapRoot = join(inDir, "snapshots");
  for (const name of listFiles(snapRoot).sort()) {
    const dir = join(snapRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const nested = join(dir, "census", "getListAgenstByAgent.json");
    const flat = join(dir, "getListAgenstByAgent.json");
    const listPath = existsSync(nested) ? nested : existsSync(flat) ? flat : "";
    if (listPath === "") continue;
    const hierNested = join(dir, "census", "getHeriarchy.json");
    const hierFlat = join(dir, "getHeriarchy.json");
    found.push({
      snapshotId: name,
      takenAtIso: isoFromSnapshotId(name, statSync(listPath).mtimeMs),
      listPath,
      hierarchyPath: existsSync(hierNested)
        ? hierNested
        : existsSync(hierFlat)
          ? hierFlat
          : null,
    });
  }
  return found;
}

function loadCreditLimits(inDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const candidates = [
    join(inDir, "census", "getCustomerAdmin.json"),
    join(inDir, "customers", "getCustomerAdmin.json"),
    join(inDir, "getCustomerAdmin.json"),
  ];
  for (const name of listFiles(join(inDir, "customers"))) {
    if (name.endsWith(".json")) candidates.push(join(inDir, "customers", name));
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const envelope = parseCustomerAdminListEnvelope(
        redactSecrets(readJson(path)),
      );
      for (const row of envelope.LIST) {
        const id =
          trimCustomerAdminField(row.CustomerID) ||
          trimCustomerAdminField(row.Login);
        const limit = parseCreditLimitCents(row.CreditLimit);
        if (id !== "" && limit !== null) out.set(id, limit);
      }
    } catch {
      // Optional enrichment; a malformed extra file must not fail ingest.
    }
  }
  return out;
}

function toLedgerRow(
  accountId: string,
  raw: TransactionListRowRaw,
  deleted: boolean,
): LedgerRow | null {
  const normalized = normalizeTransactionListRow(raw);
  if (
    normalized.rawTranType === "" &&
    normalized.tranCode === "" &&
    normalized.amountCents === 0 &&
    normalized.tranDateTime === ""
  ) {
    return null;
  }
  const spec = TRAN_TYPE_SPECS[normalized.rawTranType];
  const signed = signedAmountCents(
    normalized.rawTranType,
    normalized.tranCode,
    normalized.amountCents,
  );
  return {
    accountId,
    documentNumber: normalized.documentNumber,
    tranCode: normalized.tranCode,
    tranType: normalized.rawTranType,
    kindLabel: spec?.label ?? normalized.rawTranType,
    family: spec?.family ?? "other",
    amountCents: normalized.amountCents,
    signedAmountCents: signed,
    balanceCents: Number.isFinite(normalized.balanceCents)
      ? normalized.balanceCents
      : null,
    enteredBy: normalized.enteredBy,
    description: normalized.description,
    tranDateTime: normalized.tranDateTime,
    tranMs: parseTimestampMs(normalized.tranDateTime),
    ticket: parseTicketFromText(normalized.description),
    gradeNum: normalized.gradeNum,
    deleted,
  };
}

function loadLedger(inDir: string): LedgerRow[] {
  const dir = join(inDir, "transactions");
  const rows: LedgerRow[] = [];
  for (const name of listFiles(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const deleted = name.endsWith(".deleted.json");
    const accountId = deleted
      ? name.slice(0, -".deleted.json".length)
      : name.slice(0, -".json".length);
    if (accountId === "") continue;
    const payload = redactSecrets(readJson(join(dir, name)));
    if (deleted) {
      const envelope = parseDeletedTransactionHistoryEnvelope(payload);
      for (const raw of envelope.LIST) {
        const row = toLedgerRow(
          (raw.CustomerID ?? accountId).trim() || accountId,
          {
            DocumentNumber: raw.DocumentNumber ?? 0,
            TranCode: raw.TranCode ?? "",
            TranType: raw.TranType ?? "",
            Amount: raw.Amount ?? 0,
            Description: raw.Description ?? "",
            TranDateTime: raw.TranDateTime ?? "",
            Balance: 0,
            ...(raw.HoldAmount === undefined
              ? {}
              : { HoldAmount: raw.HoldAmount }),
            ...(typeof raw.GradeNum === "number"
              ? { GradeNum: raw.GradeNum }
              : {}),
            ...(raw.EnteredBy === undefined
              ? {}
              : { EnteredBy: raw.EnteredBy }),
          },
          true,
        );
        if (row !== null) rows.push(row);
      }
      continue;
    }
    const envelope = parseTransactionListEnvelope(payload);
    for (const raw of envelope.LIST) {
      const row = toLedgerRow(accountId, raw, false);
      if (row !== null) rows.push(row);
    }
  }
  return rows;
}

function loadWeblog(inDir: string): WeblogRow[] {
  const dir = join(inDir, "weblog");
  const rows: WeblogRow[] = [];
  for (const name of listFiles(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const payload = redactSecrets(readJson(join(dir, name)));
    const list = parseWebLogListPayload(payload) ?? [];
    for (const raw of list) {
      const operation = String(raw.Operation ?? "");
      const data = String(raw.Data ?? "");
      const fromAction = parseWeblogAction(operation);
      const fromData = data ? parseWeblogAction(data) : fromAction;
      const parsedOp = parseOperation(operation);
      const accessDateTime = String(raw.AccessDateTime ?? "").trim();
      rows.push({
        accessDateTime,
        accessMs: parseTimestampMs(accessDateTime),
        ipAddress: String(raw.IPAddress ?? "").trim(),
        loginId: String(raw.LoginID ?? "").trim(),
        operation,
        data,
        ticket: fromAction.ticket ?? fromData.ticket,
        actionKind: fromAction.kind,
        deviceClass: parsedOp.deviceClass,
        clientVersion: parsedOp.clientVersion ?? fromAction.client,
        skinDomain: parsedOp.skinDomain,
        risk: fromAction.risk ?? fromData.risk,
        win: fromAction.win ?? fromData.win,
      });
    }
  }
  return rows;
}

function numField(
  raw: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number.parseFloat(value.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function strField(
  raw: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text !== "") return text;
  }
  return "";
}

function optionalInt(
  raw: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  const n = numField(raw, keys);
  return n === 0 &&
    keys.every((k) => raw[k] === undefined || raw[k] === null || raw[k] === "")
    ? null
    : Number.isFinite(n)
      ? Math.trunc(n)
      : null;
}

export function inferLineType(
  raw: Record<string, unknown>,
  description: string,
): WagerLeg["lineType"] {
  const ou = strField(raw, ["TotalPointsOU", "OU"]).toUpperCase();
  if (ou === "O" || ou === "U" || /\bover\b|\bunder\b/i.test(description)) {
    return "total";
  }
  if (
    raw.AdjSpread != null ||
    raw.OrigSpread != null ||
    /spread|-?\d+\.?\d*/i.test(description)
  ) {
    if (
      raw.FinalMoney != null &&
      raw.AdjSpread == null &&
      raw.OrigSpread == null
    ) {
      return "money";
    }
    if (raw.AdjSpread != null || raw.OrigSpread != null) return "spread";
  }
  if (raw.FinalMoney != null || /\bml\b|money/i.test(description))
    return "money";
  return "other";
}

export function buildWagerLeg(raw: Record<string, unknown>): WagerLeg {
  const sport = strField(raw, ["SportType", "Sport", "sport"]);
  const period = strField(raw, ["PeriodDescription", "Period", "period"]);
  const team1 = strField(raw, ["Team1ID", "Team1", "HomeTeam"]);
  const team2 = strField(raw, ["Team2ID", "Team2", "AwayTeam"]);
  const chosen = strField(raw, ["ChosenTeamID", "ChosenTeam", "Team"]);
  const description = strField(raw, ["Description", "ShortDesc", "Data"]);
  const lineType = inferLineType(raw, description);
  const line =
    lineType === "total"
      ? `${strField(raw, ["TotalPointsOU", "OU"])}:${strField(raw, ["AdjTotalPoints", "OrigTotalPoints", "TotalPoints"])}`
      : lineType === "spread"
        ? String(raw.AdjSpread ?? raw.OrigSpread ?? "")
        : lineType === "money"
          ? String(raw.FinalMoney ?? raw.GradeMoney ?? "")
          : description;
  const eventKey = [sport, team1, team2, period]
    .map((s) => s.toLowerCase())
    .join("|");
  const lineKey = `${eventKey}|${lineType}|${line}`;
  return {
    eventKey,
    lineKey,
    sport,
    period,
    team1,
    team2,
    chosen,
    lineType,
    line,
  };
}

export function normalizeWagerRow(
  raw: Record<string, unknown>,
  source: WagerSource,
  fallbackAccount = "",
): WagerRow {
  const accountId =
    strField(raw, ["CustomerID", "customerID", "Login", "LoginID"]) ||
    fallbackAccount;
  const acceptedDateTime = strField(raw, [
    "AcceptedDateTime",
    "InsertDateTime",
    "PlacedOn",
    "TranDateTime",
  ]);
  const description = strField(raw, ["Description", "ShortDesc"]);
  const sport = strField(raw, ["SportType", "Sport"]);
  const wagerType = strField(raw, ["WagerType", "Type"]);
  const period = strField(raw, ["PeriodDescription", "Period"]);
  const ticketNumber = strField(raw, ["TicketNumber", "ticketNumber"]);
  const wagerNumber = strField(raw, ["WagerNumber", "wagerNumber"]);
  const amountWagered = numField(raw, ["AmountWagered", "Risk", "Amount"]);
  const toWinAmount = numField(raw, ["ToWinAmount", "ToWin", "Win"]);
  const orig = raw.OrigSpread ?? raw.OrigTotalPoints ?? null;
  const adj = raw.AdjSpread ?? raw.AdjTotalPoints ?? null;
  const doc = optionalInt(raw, ["DocumentNumber"]);
  const grade = optionalInt(raw, ["GradeNum"]);
  return {
    source,
    accountId,
    ticketNumber,
    wagerNumber,
    playNumber: strField(raw, ["PlayNumber"]),
    amountWagered,
    toWinAmount,
    acceptedDateTime,
    acceptedMs: parseTimestampMs(acceptedDateTime),
    wagerType,
    sport,
    market: inferLineType(raw, description),
    period,
    description,
    legs: [buildWagerLeg(raw)],
    origLine: orig === null || orig === undefined ? null : String(orig),
    adjLine: adj === null || adj === undefined ? null : String(adj),
    documentNumber: doc,
    gradeNum: grade,
  };
}

function walkJsonFiles(dir: string, suffix = ".json"): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of listFiles(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(suffix)) out.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function loadWagers(inDir: string): WagerRow[] {
  const rows: WagerRow[] = [];
  const pushAll = (
    payload: unknown,
    source: WagerSource,
    extract: (raw: unknown) => Record<string, unknown>[],
    fallbackAccount = "",
  ): void => {
    let list: Record<string, unknown>[] = [];
    try {
      list = extract(payload);
    } catch {
      return;
    }
    for (const raw of list) {
      const row = normalizeWagerRow(raw, source, fallbackAccount);
      if (
        row.accountId === "" &&
        row.ticketNumber === "" &&
        row.wagerNumber === ""
      ) {
        continue;
      }
      rows.push(row);
    }
  };
  const pendingPath = join(inDir, "wagers", "pending.json");
  if (existsSync(pendingPath)) {
    pushAll(
      redactSecrets(readJson(pendingPath)),
      "pending",
      extractPendingLegs,
    );
  }
  const tickerPath = join(inDir, "wagers", "ticker.json");
  if (existsSync(tickerPath)) {
    pushAll(redactSecrets(readJson(tickerPath)), "ticker", extractTickerRows);
  }
  for (const path of walkJsonFiles(join(inDir, "wagers", "graded"))) {
    pushAll(redactSecrets(readJson(path)), "graded", extractGradedRows);
  }
  for (const path of walkJsonFiles(join(inDir, "wagers", "figure-date"))) {
    const parts = path.split("/");
    const customerId = parts.at(-2) ?? "";
    pushAll(
      redactSecrets(readJson(path)),
      "figure-date",
      (payload) => {
        try {
          return parseFigureDateWagersPayload(payload) as Record<
            string,
            unknown
          >[];
        } catch {
          return extractGradedRows(payload);
        }
      },
      customerId,
    );
  }
  return rows;
}

export function groupWagersByTicket(
  wagers: readonly WagerRow[],
): Map<string, WagerRow[]> {
  const map = new Map<string, WagerRow[]>();
  for (const row of wagers) {
    const key = row.ticketNumber || `${row.accountId}:${row.wagerNumber}`;
    if (key === "" || key.endsWith(":")) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export function ingestPullDirectory(inDir: string): PullProjection {
  if (inDir.trim() === "") {
    throw new F402AnalyzeError("config", "ingest", "missing input directory");
  }
  if (!existsSync(inDir) || !statSync(inDir).isDirectory()) {
    throw new F402AnalyzeError(
      "io",
      "ingest",
      `input directory does not exist: ${inDir}`,
    );
  }
  const snapshots = discoverSnapshots(inDir);
  const credit = loadCreditLimits(inDir);
  const byId = new Map<
    string,
    {
      accountId: string;
      login: string;
      nameFirst: string;
      agentBySnapshot: Record<string, string>;
      snapshots: string[];
      creditLimitCents: number | null;
    }
  >();

  for (const snap of snapshots) {
    const { players, creditById } = loadListAgents(snap.listPath);
    for (const [id, limit] of creditById) {
      if (!credit.has(id)) credit.set(id, limit);
    }
    if (snap.hierarchyPath !== null) {
      parseHierarchyList(readJson(snap.hierarchyPath));
    }
    for (const player of players) {
      const existing = byId.get(player.customerId);
      if (existing === undefined) {
        byId.set(player.customerId, {
          accountId: player.customerId,
          login: player.login,
          nameFirst: player.nameFirst,
          agentBySnapshot: { [snap.snapshotId]: player.agent },
          snapshots: [snap.snapshotId],
          creditLimitCents: credit.get(player.customerId) ?? null,
        });
        continue;
      }
      existing.agentBySnapshot[snap.snapshotId] = player.agent;
      existing.snapshots.push(snap.snapshotId);
      if (existing.login === "") existing.login = player.login;
      if (existing.creditLimitCents === null) {
        existing.creditLimitCents = credit.get(player.customerId) ?? null;
      }
    }
  }

  const ledger = loadLedger(inDir);
  const weblog = loadWeblog(inDir);
  const wagers = loadWagers(inDir);

  const ensureAccount = (accountId: string, login = accountId): void => {
    if (accountId === "" || byId.has(accountId)) return;
    const byLogin = [...byId.values()].find(
      (row) => row.login.toLowerCase() === accountId.toLowerCase(),
    );
    if (byLogin !== undefined) return;
    byId.set(accountId, {
      accountId,
      login,
      nameFirst: "",
      agentBySnapshot: {},
      snapshots: [],
      creditLimitCents: credit.get(accountId) ?? null,
    });
  };
  for (const row of ledger) ensureAccount(row.accountId);
  for (const row of weblog) ensureAccount(row.loginId, row.loginId);
  for (const row of wagers) ensureAccount(row.accountId, row.accountId);

  const accounts: AnalyzedAccount[] = [...byId.values()]
    .map((row) => {
      const agents = Object.values(row.agentBySnapshot).filter((v) => v !== "");
      const unique = new Set(agents);
      return {
        accountId: row.accountId,
        login: row.login,
        nameFirst: row.nameFirst,
        agentBySnapshot: row.agentBySnapshot,
        snapshots: row.snapshots,
        creditLimitCents: row.creditLimitCents,
        agentChanged: agents.length === 0 ? null : unique.size > 1,
      };
    })
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  return {
    inDir,
    accounts,
    ledger,
    weblog,
    wagers,
    snapshotIds: snapshots.map((s) => s.snapshotId),
    censusSnapshotCount: snapshots.length,
  };
}
