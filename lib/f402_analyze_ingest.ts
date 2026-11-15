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
import {
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

export interface PullProjection {
  readonly inDir: string;
  readonly accounts: readonly AnalyzedAccount[];
  readonly ledger: readonly LedgerRow[];
  readonly weblog: readonly WeblogRow[];
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
    snapshotIds: snapshots.map((s) => s.snapshotId),
    censusSnapshotCount: snapshots.length,
  };
}
