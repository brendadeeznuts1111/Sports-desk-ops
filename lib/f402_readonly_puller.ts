/**
 * Read-only Fantasy402 bulk puller: census, contract check, per-account
 * transactions, and day-unit weblogs.
 *
 * Every Manager operation is gated by `assertPullReadOnly` /
 * `assertAllowedRead` in `scripts/capture/allowlist.ts`. Writes, auth
 * exchanges, and unknown ops are refused before any request is built.
 * No new login path: sessions come from `lib/f402_session.ts`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  parseCustomerAdminListEnvelope,
  redactCustomerAdminListEnvelope,
  summarizeCustomerAdminList,
} from "./f402_customer_admin_list.ts";
import {
  parseDeletedTransactionHistoryEnvelope,
  summarizeDeletedTransactionHistory,
} from "./f402_deleted_transaction_history.ts";
import {
  normalizeAgentTreePlayerRows,
  parseListAgentsByAgentEnvelope,
  redactListAgentsByAgentEnvelope,
  summarizeListAgentsByAgent,
  summarizeListAgentsByAgentPlayers,
} from "./f402_list_agents_by_agent.ts";
import {
  ensureF402Session,
  readF402Session,
  refreshF402Session,
  writeF402Session,
  type F402Session,
  type RefreshF402SessionOptions,
} from "./f402_session.ts";

export type { F402Session } from "./f402_session.ts";
import { parseFigureDateWagersPayload } from "./f402_figure_date_enricher.ts";
import { extractPendingLegs } from "./f402_pending_fetch.ts";
import { buildManagerWagersByFigureDatePayload } from "./f402_probe.ts";
import {
  parseTransactionListEnvelope,
  summarizeTransactionList,
} from "./f402_transaction_list.ts";
import {
  buildWebLogFormFields,
  parseWebLogListPayload,
  type WebLogMode,
} from "./f402_weblog_fetch.ts";
import {
  assertPullReadOnly,
  type PullReadOnlyOp,
} from "../scripts/capture/allowlist.ts";

export const F402_PULL_DEFAULT_OUT_DIR = "/workspace/f402-pull";
export const F402_PULL_DEFAULT_BASE_URL = "https://fantasy402.com";
export const F402_PULL_DEFAULT_INTERVAL_MS = 1000;
export const F402_PULL_DEFAULT_REFRESH_AFTER_MS = 15 * 60_000;
export const F402_PULL_CHECKPOINT_VERSION = 1 as const;
export const F402_PULL_MAX_RETRIES = 5;
export const F402_PULL_BACKOFF_CAP_MS = 30_000;

export type F402PullPhase =
  "census" | "contract" | "transactions" | "weblog" | "wagers";

export type F402PullerErrorCode =
  | "allowlist"
  | "auth"
  | "http"
  | "config"
  | "response"
  | "checkpoint"
  | "rate-limited";

export class F402PullerError extends Error {
  readonly code: F402PullerErrorCode;
  readonly operation: string;
  readonly status: number | null;

  constructor(
    code: F402PullerErrorCode,
    operation: string,
    message: string,
    status: number | null = null,
  ) {
    super(`f402-pull ${operation}: ${message}`);
    this.name = "F402PullerError";
    this.code = code;
    this.operation = operation;
    this.status = status;
  }
}

const SECRET_KEY =
  /^(?:password|pass|passwd|pin|phone|phonenumber|telegramid|token|authToken|authorization|cookie|secret)$/i;
const IP_KEY = /^(?:ip|ipaddress|ip_address)$/i;
const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;

export const REDACTED = "<redacted>";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactWalk(value: unknown, stripIps: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactWalk(item, stripIps));
  }
  if (!isPlainObject(value)) {
    if (stripIps && typeof value === "string" && IPV4.test(value)) {
      return value.replace(IPV4, REDACTED);
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (stripIps && IP_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactWalk(child, stripIps);
  }
  return out;
}

/** Strip passwords, phones, tokens. Keep IP fields for box-local raw files. */
export function redactSecrets(value: unknown): unknown {
  return redactWalk(value, false);
}

/** Strip secrets and IP addresses — use for logs, summaries, and stdout. */
export function redactSecretsAndIps(value: unknown): unknown {
  return redactWalk(value, true);
}

export function containsRawIp(value: unknown): boolean {
  if (typeof value === "string") return IPV4.test(value);
  if (Array.isArray(value)) return value.some(containsRawIp);
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, child]) => {
      if (
        IP_KEY.test(key) &&
        child !== REDACTED &&
        child != null &&
        child !== ""
      )
        return true;
      return containsRawIp(child);
    });
  }
  return false;
}

export interface PaceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function createPaceClock(impl?: Partial<PaceClock>): PaceClock {
  return {
    now: impl?.now ?? (() => Date.now()),
    sleep:
      impl?.sleep ??
      (async (ms: number) => {
        if (ms <= 0) return;
        await Bun.sleep(ms);
      }),
  };
}

export class RequestPacer {
  private nextAt = 0;

  constructor(
    readonly intervalMs: number = F402_PULL_DEFAULT_INTERVAL_MS,
    private readonly clock: PaceClock = createPaceClock(),
  ) {}

  async wait(): Promise<number> {
    const now = this.clock.now();
    const delay = Math.max(0, this.nextAt - now);
    if (delay > 0) await this.clock.sleep(delay);
    this.nextAt = this.clock.now() + this.intervalMs;
    return delay;
  }
}

export function backoffDelayMs(
  attempt: number,
  cap = F402_PULL_BACKOFF_CAP_MS,
): number {
  const exp = Math.min(cap, 1000 * 2 ** Math.max(0, attempt - 1));
  return exp;
}

export interface F402PullCheckpoint {
  readonly version: typeof F402_PULL_CHECKPOINT_VERSION;
  readonly phase: F402PullPhase;
  readonly agentId: string;
  readonly customerIds: readonly string[];
  readonly completedCustomers: readonly string[];
  readonly completedWeblogDates: readonly string[];
  readonly completedGradedDates: readonly string[];
  readonly completedFigureDateKeys: readonly string[];
  readonly wagersPendingDone: boolean;
  readonly wagersTickerDone: boolean;
  readonly census?: {
    readonly agentCount: number;
    readonly playerCount: number;
    readonly maxLevel: number;
  };
  readonly updatedAtIso: string;
}

export const emptyCheckpoint = (
  agentId: string,
  nowIso: string,
): F402PullCheckpoint => ({
  version: F402_PULL_CHECKPOINT_VERSION,
  phase: "census",
  agentId,
  customerIds: [],
  completedCustomers: [],
  completedWeblogDates: [],
  completedGradedDates: [],
  completedFigureDateKeys: [],
  wagersPendingDone: false,
  wagersTickerDone: false,
  updatedAtIso: nowIso,
});

export function parseCheckpoint(raw: unknown): F402PullCheckpoint {
  if (!isPlainObject(raw)) {
    throw new F402PullerError(
      "checkpoint",
      "checkpoint",
      "checkpoint is not an object",
    );
  }
  if (raw.version !== F402_PULL_CHECKPOINT_VERSION) {
    throw new F402PullerError(
      "checkpoint",
      "checkpoint",
      `unsupported checkpoint version ${String(raw.version)}`,
    );
  }
  const phase = raw.phase;
  if (
    phase !== "census" &&
    phase !== "contract" &&
    phase !== "transactions" &&
    phase !== "weblog" &&
    phase !== "wagers"
  ) {
    throw new F402PullerError("checkpoint", "checkpoint", "invalid phase");
  }
  if (typeof raw.agentId !== "string" || raw.agentId.trim() === "") {
    throw new F402PullerError("checkpoint", "checkpoint", "missing agentId");
  }
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    version: F402_PULL_CHECKPOINT_VERSION,
    phase,
    agentId: raw.agentId,
    customerIds: asStringArray(raw.customerIds),
    completedCustomers: asStringArray(raw.completedCustomers),
    completedWeblogDates: asStringArray(raw.completedWeblogDates),
    completedGradedDates: asStringArray(raw.completedGradedDates),
    completedFigureDateKeys: asStringArray(raw.completedFigureDateKeys),
    wagersPendingDone: raw.wagersPendingDone === true,
    wagersTickerDone: raw.wagersTickerDone === true,
    ...(isPlainObject(raw.census) &&
    typeof raw.census.agentCount === "number" &&
    typeof raw.census.playerCount === "number" &&
    typeof raw.census.maxLevel === "number"
      ? {
          census: {
            agentCount: raw.census.agentCount,
            playerCount: raw.census.playerCount,
            maxLevel: raw.census.maxLevel,
          },
        }
      : {}),
    updatedAtIso: typeof raw.updatedAtIso === "string" ? raw.updatedAtIso : "",
  };
}

export function checkpointPath(outDir: string): string {
  return join(outDir, "checkpoint.json");
}

export function loadCheckpoint(outDir: string): F402PullCheckpoint | null {
  const path = checkpointPath(outDir);
  if (!existsSync(path)) return null;
  try {
    return parseCheckpoint(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable";
    throw new F402PullerError("checkpoint", "checkpoint", message);
  }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function saveCheckpoint(
  outDir: string,
  checkpoint: F402PullCheckpoint,
): void {
  writePrivateJson(checkpointPath(outDir), checkpoint);
}

export function writeRawJson(
  outDir: string,
  relative: string,
  value: unknown,
): string {
  const path = join(outDir, "raw", relative);
  writePrivateJson(path, redactSecrets(value));
  return path;
}

export function writeSummaryJson(
  outDir: string,
  name: string,
  value: unknown,
): string {
  const sanitized = redactSecretsAndIps(value);
  if (containsRawIp(sanitized)) {
    throw new F402PullerError(
      "config",
      "summary",
      "refusing to write a summary that still contains a raw IP",
    );
  }
  const path = join(outDir, name);
  writePrivateJson(path, sanitized);
  return path;
}

export interface ManagerPostOptions {
  readonly operation: PullReadOnlyOp;
  readonly fields: Record<string, string>;
  readonly session: F402Session;
  readonly baseUrl?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

/** Controller for a puller op. Report is only used for verified Report reads. */
export function pullOpController(
  operation: PullReadOnlyOp,
): "Manager" | "Report" {
  return operation === "getWagersByFigureDate" ? "Report" : "Manager";
}

export function buildPullUrl(
  baseUrl: string,
  operation: PullReadOnlyOp,
): string {
  const op = assertPullReadOnly(operation);
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/cloud/api/${pullOpController(op)}/${op}`;
}

export function buildManagerUrl(
  baseUrl: string,
  operation: PullReadOnlyOp,
): string {
  return buildPullUrl(baseUrl, operation);
}

/** getGraded requires MM-DD-YYYY; ISO dates return a quiet partial (measured). */
export function formatGradedDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) {
    throw new F402PullerError(
      "config",
      "getGraded",
      `graded date must be YYYY-MM-DD, got ${isoDate}`,
    );
  }
  return `${match[2]}-${match[3]}-${match[1]}`;
}

export function buildFormBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function readResponseText(response: Response): Promise<string> {
  return await response.text();
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface PullClientOptions {
  readonly session: F402Session;
  readonly baseUrl?: string;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly pacer?: RequestPacer;
  readonly clock?: PaceClock;
  readonly maxRetries?: number;
  readonly intervalMs?: number;
}

export class F402PullClient {
  private session: F402Session;
  private readonly baseUrl: string;
  private readonly fetchImpl: (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
  private readonly pacer: RequestPacer;
  private readonly clock: PaceClock;
  private readonly maxRetries: number;

  constructor(options: PullClientOptions) {
    this.session = options.session;
    this.baseUrl = (options.baseUrl ?? F402_PULL_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? createPaceClock();
    this.pacer =
      options.pacer ??
      new RequestPacer(
        options.intervalMs ?? F402_PULL_DEFAULT_INTERVAL_MS,
        this.clock,
      );
    this.maxRetries = options.maxRetries ?? F402_PULL_MAX_RETRIES;
  }

  replaceSession(session: F402Session): void {
    this.session = session;
  }

  currentSession(): F402Session {
    return this.session;
  }

  async post(
    operation: PullReadOnlyOp,
    fields: Record<string, string>,
  ): Promise<unknown> {
    const op = assertPullReadOnly(operation);
    const url = buildPullUrl(this.baseUrl, op);
    const body = buildFormBody({
      ...fields,
      operation: op,
      RRO: fields.RRO ?? "1",
    });
    let lastError: F402PullerError | undefined;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this.pacer.wait();
      const token = this.session.authorizationHeader?.trim();
      if (token === undefined || token === "") {
        throw new F402PullerError(
          "auth",
          op,
          "cached session has no Authorization Bearer header — mint one with session:login (WebView), not --from-profile (cookies only)",
        );
      }
      const headers: Record<string, string> = {
        accept: "application/json, text/plain, */*",
        authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      };
      const cookie = this.session.cookieHeader?.trim();
      if (cookie) headers.cookie = cookie;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
        });
      } catch (error) {
        throw new F402PullerError(
          "http",
          op,
          error instanceof Error ? error.message : "network error",
        );
      }
      if (isRetryableStatus(response.status)) {
        const retryAfter = response.headers.get("retry-after");
        const parsed = retryAfter !== null ? Number(retryAfter) * 1000 : NaN;
        const delay = Number.isFinite(parsed)
          ? Math.min(F402_PULL_BACKOFF_CAP_MS, Math.max(0, parsed))
          : backoffDelayMs(attempt);
        lastError = new F402PullerError(
          "rate-limited",
          op,
          `HTTP ${response.status}`,
          response.status,
        );
        if (attempt === this.maxRetries) throw lastError;
        await this.clock.sleep(delay);
        continue;
      }
      const text = await readResponseText(response);
      if (response.status === 401 || response.status === 403) {
        throw new F402PullerError(
          "auth",
          op,
          `HTTP ${response.status}`,
          response.status,
        );
      }
      if (response.status !== 200) {
        throw new F402PullerError(
          "http",
          op,
          `HTTP ${response.status}`,
          response.status,
        );
      }
      if (/^\s*(<!doctype|<html|<)/i.test(text)) {
        throw new F402PullerError(
          "auth",
          op,
          "HTML login trap instead of JSON",
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new F402PullerError("response", op, "response was not JSON");
      }
    }
    throw (
      lastError ?? new F402PullerError("http", operation, "exhausted retries")
    );
  }
}

export interface HierarchyRow {
  readonly agentId: string;
  readonly masterAgentId: string;
  readonly level: number;
  readonly agentType: string;
  readonly login: string;
}

export function parseHierarchyList(payload: unknown): HierarchyRow[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.LIST)) {
    throw new F402PullerError(
      "response",
      "getHeriarchy",
      "expected { LIST: [...] }",
    );
  }
  const rows: HierarchyRow[] = [];
  for (const raw of payload.LIST) {
    if (!isPlainObject(raw)) continue;
    const agentId = String(raw.AgentId ?? raw.AgentID ?? "").trim();
    if (agentId === "") continue;
    const levelRaw = raw.Level;
    const level =
      typeof levelRaw === "number"
        ? levelRaw
        : Number.parseInt(String(levelRaw ?? "0"), 10);
    rows.push({
      agentId,
      masterAgentId: String(raw.MasterAgentID ?? "").trim(),
      level: Number.isFinite(level) ? level : 0,
      agentType: String(raw.AgentType ?? "").trim(),
      login: String(raw.Login ?? agentId).trim(),
    });
  }
  return rows;
}

export function summarizeHierarchy(rows: readonly HierarchyRow[]): {
  readonly agentCount: number;
  readonly maxLevel: number;
  readonly roots: number;
  readonly orphans: number;
  readonly countsByLevel: Record<string, number>;
  readonly countsByType: Record<string, number>;
} {
  const ids = new Set(rows.map((row) => row.agentId));
  const countsByLevel: Record<string, number> = {};
  const countsByType: Record<string, number> = {};
  let maxLevel = 0;
  let roots = 0;
  let orphans = 0;
  for (const row of rows) {
    maxLevel = Math.max(maxLevel, row.level);
    countsByLevel[String(row.level)] =
      (countsByLevel[String(row.level)] ?? 0) + 1;
    const type = row.agentType || "?";
    countsByType[type] = (countsByType[type] ?? 0) + 1;
    if (row.masterAgentId === "") roots += 1;
    else if (!ids.has(row.masterAgentId)) orphans += 1;
  }
  return {
    agentCount: rows.length,
    maxLevel,
    roots,
    orphans,
    countsByLevel,
    countsByType,
  };
}

export function defaultTransactionStartDate(now = new Date()): string {
  const day = new Date(now);
  day.setUTCDate(day.getUTCDate() - 30);
  return day.toISOString().slice(0, 10);
}

export function eachUtcDateInclusive(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new F402PullerError(
      "config",
      "weblog",
      `invalid date range ${from}..${to} (YYYY-MM-DD)`,
    );
  }
  const days: string[] = [];
  for (let ts = start; ts <= end; ts += 86_400_000) {
    days.push(new Date(ts).toISOString().slice(0, 10));
  }
  return days;
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new F402PullerError(
      "config",
      "options",
      "--concurrency must be an integer >= 1",
    );
  }
  const out: R[] = Array.from({ length: items.length });
  if (concurrency === 1 || items.length <= 1) {
    for (let i = 0; i < items.length; i += 1) {
      out[i] = await fn(items[i]!, i);
    }
    return out;
  }
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export function filterCustomerIds(
  customerIds: readonly string[],
  accounts: readonly string[],
): string[] {
  if (accounts.length === 0) return [...customerIds];
  const allow = new Set(accounts.map((id) => id.toLowerCase()));
  return customerIds.filter((id) => allow.has(id.toLowerCase()));
}

export function downlineAgentIds(
  general: readonly { readonly agentId: string }[],
  rootAgentId: string,
): string[] {
  const root = rootAgentId.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of general) {
    const id = row.agentId.trim();
    if (id === "" || id.toLowerCase() === root) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

export interface SessionProvider {
  read(): F402Session | null;
  ensure(
    options?: RefreshF402SessionOptions & { allowLiveLogin?: boolean },
  ): Promise<F402Session>;
  refresh(options?: RefreshF402SessionOptions): Promise<F402Session>;
}

export function defaultSessionProvider(): SessionProvider {
  return {
    read: () => readF402Session(),
    async ensure(options) {
      await ensureF402Session(options);
      const session = readF402Session();
      if (session === null) {
        throw new F402PullerError(
          "auth",
          "session",
          "ensureF402Session returned without a readable session",
        );
      }
      return session;
    },
    async refresh(options) {
      const session = await refreshF402Session(options);
      writeF402Session(session);
      return session;
    },
  };
}

export async function resolvePullSession(options: {
  readonly provider?: SessionProvider;
  readonly refreshAfterMs?: number;
  readonly now?: number;
  readonly allowLiveLogin?: boolean;
  readonly forceRefresh?: boolean;
}): Promise<F402Session> {
  const provider = options.provider ?? defaultSessionProvider();
  const now = options.now ?? Date.now();
  const refreshAfter =
    options.refreshAfterMs ?? F402_PULL_DEFAULT_REFRESH_AFTER_MS;
  const existing = provider.read();
  if (existing !== null && options.forceRefresh !== true) {
    const obtained = Date.parse(existing.obtainedAtIso);
    const expires = Date.parse(existing.expiresAtIso);
    const freshEnough =
      Number.isFinite(obtained) && now - obtained < refreshAfter;
    const unexpired = Number.isFinite(expires) && expires > now;
    if (freshEnough && unexpired) return existing;
    try {
      return await provider.refresh();
    } catch (error) {
      if (unexpired && existing.authorizationHeader) return existing;
      const message = error instanceof Error ? error.message : "refresh failed";
      throw new F402PullerError("auth", "session", message);
    }
  }
  try {
    return await provider.ensure(
      options.allowLiveLogin === undefined
        ? {}
        : { allowLiveLogin: options.allowLiveLogin },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "no session";
    throw new F402PullerError("auth", "session", message);
  }
}

export interface RunContext {
  readonly client: F402PullClient;
  readonly outDir: string;
  readonly agentId: string;
  readonly agentOwner: string;
  readonly agentType: string;
  readonly clock?: PaceClock;
}

function nowIso(clock?: PaceClock): string {
  return new Date((clock ?? createPaceClock()).now()).toISOString();
}

export interface CensusResult {
  readonly agentCount: number;
  readonly playerCount: number;
  readonly maxLevel: number;
  readonly roots: number;
  readonly orphans: number;
  readonly countsByLevel: Record<string, number>;
  readonly countsByType: Record<string, number>;
  readonly customerIds: readonly string[];
}

export async function runCensus(
  ctx: RunContext,
  options: {
    readonly recurseDownline?: boolean;
    readonly agents?: readonly string[];
    readonly accounts?: readonly string[];
  } = {},
): Promise<CensusResult> {
  const hierarchyRaw = await ctx.client.post("getHeriarchy", {
    agentID: ctx.agentId,
  });
  const hierarchy = parseHierarchyList(hierarchyRaw);
  const hierarchySummary = summarizeHierarchy(hierarchy);
  writeRawJson(ctx.outDir, "census/getHeriarchy.json", hierarchyRaw);

  const root =
    hierarchy.find((row) => row.agentId === ctx.agentId) ?? hierarchy[0];
  const agentType = ctx.agentType || root?.agentType || "M";
  const listRaw = await ctx.client.post("getListAgenstByAgent", {
    agentID: ctx.agentId,
    agentType,
    ...(ctx.agentOwner ? { agentOwner: ctx.agentOwner } : {}),
  });
  const list = parseListAgentsByAgentEnvelope(listRaw);
  const redactedList = redactListAgentsByAgentEnvelope(list);
  writeRawJson(ctx.outDir, "census/getListAgenstByAgent.json", redactedList);
  const players = normalizeAgentTreePlayerRows(list.PLAYERS);
  const playerSummary = summarizeListAgentsByAgentPlayers(list.PLAYERS);
  const treeSummary = summarizeListAgentsByAgent(list);
  const playerRows = [...players];
  if (options.recurseDownline === true) {
    const general = list.GENERAL.map((row) => ({
      agentId: String(row.AgentID ?? row.Login ?? "").trim(),
      agentType: String(row.AgentType ?? "A").trim() || "A",
    }));
    let targets = downlineAgentIds(general, ctx.agentId);
    if (options.agents !== undefined && options.agents.length > 0) {
      const allow = new Set(options.agents.map((id) => id.toLowerCase()));
      targets = targets.filter((id) => allow.has(id.toLowerCase()));
    }
    for (const agentId of targets) {
      const row = general.find((item) => item.agentId === agentId);
      const childRaw = await ctx.client.post("getListAgenstByAgent", {
        agentID: agentId,
        agentType: row?.agentType || "A",
        ...(ctx.agentOwner ? { agentOwner: ctx.agentOwner } : {}),
      });
      const child = parseListAgentsByAgentEnvelope(childRaw);
      const redactedChild = redactListAgentsByAgentEnvelope(child);
      writeRawJson(
        ctx.outDir,
        `census/list-agents/${agentId}.json`,
        redactedChild,
      );
      playerRows.push(...normalizeAgentTreePlayerRows(child.PLAYERS));
    }
  }
  const seenCustomers = new Set<string>();
  const customerIds: string[] = [];
  for (const row of playerRows) {
    if (row.customerId === "" || seenCustomers.has(row.customerId)) continue;
    seenCustomers.add(row.customerId);
    customerIds.push(row.customerId);
  }
  const filteredIds = filterCustomerIds(customerIds, options.accounts ?? []);
  const playerCount =
    options.accounts !== undefined && options.accounts.length > 0
      ? filteredIds.length
      : playerSummary.playerCount + (playerRows.length - players.length);

  const result: CensusResult = {
    agentCount: hierarchySummary.agentCount,
    playerCount,
    maxLevel: hierarchySummary.maxLevel,
    roots: hierarchySummary.roots,
    orphans: hierarchySummary.orphans,
    countsByLevel: hierarchySummary.countsByLevel,
    countsByType: hierarchySummary.countsByType,
    customerIds: filteredIds,
  };
  writeSummaryJson(ctx.outDir, "census-summary.json", {
    agentCount: result.agentCount,
    playerCount: result.playerCount,
    maxLevel: result.maxLevel,
    roots: result.roots,
    orphans: result.orphans,
    countsByLevel: result.countsByLevel,
    countsByType: result.countsByType,
    generalAgents: treeSummary.generalCount,
  });
  const previous = loadCheckpoint(ctx.outDir);
  saveCheckpoint(ctx.outDir, {
    ...(previous ?? emptyCheckpoint(ctx.agentId, nowIso(ctx.clock))),
    phase: "census",
    agentId: ctx.agentId,
    customerIds: filteredIds,
    census: {
      agentCount: result.agentCount,
      playerCount: result.playerCount,
      maxLevel: result.maxLevel,
    },
    updatedAtIso: nowIso(ctx.clock),
  });
  return result;
}

export interface ContractResult {
  readonly customerId: string;
  readonly datedStart: string;
  readonly datedCount: number;
  readonly emptyStartCount: number;
  readonly deletedCount: number;
  readonly datedKeys: readonly string[];
  readonly emptyStartAccepted: boolean;
}

export async function runContract(
  ctx: RunContext,
  options: { readonly customerId: string; readonly start?: string },
): Promise<ContractResult> {
  const customerId = options.customerId.trim();
  if (customerId === "") {
    throw new F402PullerError(
      "config",
      "contract",
      "a test customer id is required",
    );
  }
  const datedStart = options.start ?? defaultTransactionStartDate();
  const common = {
    ...(ctx.agentId ? { agentID: ctx.agentId } : {}),
    ...(ctx.agentOwner ? { agentOwner: ctx.agentOwner } : {}),
  };
  const datedRaw = await ctx.client.post("getTransactionList", {
    ...common,
    acc: customerId,
    start: datedStart,
  });
  const emptyRaw = await ctx.client.post("getTransactionList", {
    ...common,
    acc: customerId,
    start: "",
  });
  const deletedRaw = await ctx.client.post("getDeletedTransactionHistory", {
    customerID: customerId,
  });
  writeRawJson(ctx.outDir, `contract/${customerId}.dated.json`, datedRaw);
  writeRawJson(ctx.outDir, `contract/${customerId}.empty-start.json`, emptyRaw);
  writeRawJson(ctx.outDir, `contract/${customerId}.deleted.json`, deletedRaw);

  const dated = parseTransactionListEnvelope(datedRaw);
  const empty = parseTransactionListEnvelope(emptyRaw);
  const deleted = parseDeletedTransactionHistoryEnvelope(deletedRaw);
  const datedKeys =
    dated.LIST.length > 0 ? Object.keys(dated.LIST[0] ?? {}) : [];
  const result: ContractResult = {
    customerId,
    datedStart,
    datedCount: dated.LIST.length,
    emptyStartCount: empty.LIST.length,
    deletedCount: deleted.LIST.length,
    datedKeys,
    emptyStartAccepted: Array.isArray((emptyRaw as { LIST?: unknown }).LIST),
  };
  writeSummaryJson(ctx.outDir, "contract-summary.json", {
    customerId,
    datedStart,
    datedCount: result.datedCount,
    emptyStartCount: result.emptyStartCount,
    deletedCount: result.deletedCount,
    datedKeys: result.datedKeys,
    emptyStartAccepted: result.emptyStartAccepted,
    dated: summarizeTransactionList(dated),
    emptyStart: summarizeTransactionList(empty),
    deleted: summarizeDeletedTransactionHistory(deleted),
  });
  const previous =
    loadCheckpoint(ctx.outDir) ??
    emptyCheckpoint(ctx.agentId, nowIso(ctx.clock));
  saveCheckpoint(ctx.outDir, {
    ...previous,
    phase: "contract",
    updatedAtIso: nowIso(ctx.clock),
  });
  return result;
}

export interface TransactionsResult {
  readonly attempted: number;
  readonly completed: number;
  readonly skipped: number;
}

export async function runTransactions(
  ctx: RunContext,
  options: {
    readonly start?: string;
    readonly resume?: boolean;
    readonly accounts?: readonly string[];
    readonly concurrency?: number;
  } = {},
): Promise<TransactionsResult> {
  const previous =
    loadCheckpoint(ctx.outDir) ??
    emptyCheckpoint(ctx.agentId, nowIso(ctx.clock));
  const customerIds = filterCustomerIds(
    previous.customerIds,
    options.accounts ?? [],
  );
  if (customerIds.length === 0) {
    throw new F402PullerError(
      "config",
      "transactions",
      "no customer ids in the checkpoint — run census first",
    );
  }
  const done = new Set(
    options.resume === false ? [] : previous.completedCustomers,
  );
  let completed = 0;
  let skipped = 0;
  const start = options.start ?? "";
  const common = {
    ...(ctx.agentId ? { agentID: ctx.agentId } : {}),
    ...(ctx.agentOwner ? { agentOwner: ctx.agentOwner } : {}),
  };
  const pending = customerIds.filter((customerId) => {
    if (done.has(customerId)) {
      skipped += 1;
      return false;
    }
    return true;
  });
  const concurrency = options.concurrency ?? 1;
  await mapPool(pending, concurrency, async (customerId) => {
    const listRaw = await ctx.client.post("getTransactionList", {
      ...common,
      acc: customerId,
      start,
    });
    const deletedRaw = await ctx.client.post("getDeletedTransactionHistory", {
      customerID: customerId,
    });
    writeRawJson(ctx.outDir, `transactions/${customerId}.json`, listRaw);
    writeRawJson(
      ctx.outDir,
      `transactions/${customerId}.deleted.json`,
      deletedRaw,
    );
    done.add(customerId);
    completed += 1;
    saveCheckpoint(ctx.outDir, {
      ...previous,
      phase: "transactions",
      customerIds,
      completedCustomers: [...done],
      updatedAtIso: nowIso(ctx.clock),
    });
    return customerId;
  });
  writeSummaryJson(ctx.outDir, "transactions-summary.json", {
    attempted: customerIds.length,
    completed,
    skipped,
  });
  return { attempted: customerIds.length, completed, skipped };
}

export interface WeblogResult {
  readonly dates: readonly string[];
  readonly completed: number;
  readonly skipped: number;
  readonly rowCounts: Record<string, number>;
}

export async function runWeblog(
  ctx: RunContext,
  options: {
    readonly from: string;
    readonly to: string;
    readonly mode?: WebLogMode;
    readonly resume?: boolean;
  },
): Promise<WeblogResult> {
  const dates = eachUtcDateInclusive(options.from, options.to);
  const previous =
    loadCheckpoint(ctx.outDir) ??
    emptyCheckpoint(ctx.agentId, nowIso(ctx.clock));
  const done = new Set(
    options.resume === false ? [] : previous.completedWeblogDates,
  );
  const mode: WebLogMode = options.mode ?? "I";
  const rowCounts: Record<string, number> = {};
  let completed = 0;
  let skipped = 0;
  for (const date of dates) {
    if (done.has(date)) {
      skipped += 1;
      continue;
    }
    const fields = buildWebLogFormFields({
      mode,
      date,
      customerId: "",
      ip: "",
      agentId: ctx.agentId,
      agentOwner: ctx.agentOwner || ctx.agentId,
    });
    const raw = await ctx.client.post("getWebLog", fields);
    const rows = parseWebLogListPayload(raw) ?? [];
    writeRawJson(ctx.outDir, `weblog/${date}.json`, raw);
    done.add(date);
    completed += 1;
    rowCounts[date] = rows.length;
    saveCheckpoint(ctx.outDir, {
      ...previous,
      phase: "weblog",
      completedWeblogDates: [...done],
      updatedAtIso: nowIso(ctx.clock),
    });
  }
  writeSummaryJson(ctx.outDir, "weblog-summary.json", {
    from: options.from,
    to: options.to,
    mode,
    completed,
    skipped,
    rowCounts,
  });
  return { dates, completed, skipped, rowCounts };
}

export function extractTickerRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object" && !Array.isArray(row),
    );
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["LIST", "data", "rows"]) {
      const value = record[key];
      if (Array.isArray(value)) return extractTickerRows(value);
    }
  }
  return [];
}

export function extractGradedRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object" && !Array.isArray(row),
    );
  }
  if (payload !== null && typeof payload === "object") {
    const list = (payload as { LIST?: unknown }).LIST;
    if (Array.isArray(list)) return extractGradedRows(list);
  }
  return [];
}

function stringFields(
  fields: Record<string, string | number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = String(value);
  return out;
}

export interface WagersResult {
  readonly pendingRows: number;
  readonly tickerRows: number;
  readonly gradedDates: readonly string[];
  readonly gradedCompleted: number;
  readonly gradedSkipped: number;
  readonly gradedRowCounts: Record<string, number>;
  readonly figureDateAttempted: number;
  readonly figureDateCompleted: number;
  readonly figureDateSkipped: number;
}

export async function runWagers(
  ctx: RunContext,
  options: {
    readonly from: string;
    readonly to: string;
    readonly resume?: boolean;
    readonly includeFigureDate?: boolean;
    readonly accounts?: readonly string[];
    readonly concurrency?: number;
  },
): Promise<WagersResult> {
  const dates = eachUtcDateInclusive(options.from, options.to);
  const previous =
    loadCheckpoint(ctx.outDir) ??
    emptyCheckpoint(ctx.agentId, nowIso(ctx.clock));
  const resume = options.resume !== false;
  const common = {
    ...(ctx.agentId ? { agentID: ctx.agentId } : {}),
    ...(ctx.agentOwner ? { agentOwner: ctx.agentOwner } : {}),
  };

  let pendingRows = 0;
  let pendingDone = resume && previous.wagersPendingDone;
  if (!pendingDone) {
    const raw = await ctx.client.post(
      "getPending",
      stringFields({
        ...common,
        path: "/qubic/api/Manager/getPending",
        date: options.to,
        wagerType: "",
        sort: "1",
        typeSort: "2",
        week: 0,
        customerID: "0",
      }),
    );
    pendingRows = extractPendingLegs(raw).length;
    writeRawJson(ctx.outDir, "wagers/pending.json", raw);
    pendingDone = true;
    saveCheckpoint(ctx.outDir, {
      ...previous,
      phase: "wagers",
      wagersPendingDone: true,
      updatedAtIso: nowIso(ctx.clock),
    });
  }

  let tickerRows = 0;
  let tickerDone = resume && previous.wagersTickerDone;
  if (!tickerDone) {
    const raw = await ctx.client.post(
      "getBetTicker",
      stringFields({ ...common, wagerNumber: "0" }),
    );
    tickerRows = extractTickerRows(raw).length;
    writeRawJson(ctx.outDir, "wagers/ticker.json", raw);
    tickerDone = true;
    saveCheckpoint(ctx.outDir, {
      ...previous,
      phase: "wagers",
      wagersPendingDone: true,
      wagersTickerDone: true,
      updatedAtIso: nowIso(ctx.clock),
    });
  }

  const gradedDone = new Set(resume ? previous.completedGradedDates : []);
  const gradedRowCounts: Record<string, number> = {};
  let gradedCompleted = 0;
  let gradedSkipped = 0;
  for (const date of dates) {
    if (gradedDone.has(date)) {
      gradedSkipped += 1;
      continue;
    }
    const day = formatGradedDate(date);
    const raw = await ctx.client.post(
      "getGraded",
      stringFields({ ...common, startDate: day, endDate: day }),
    );
    gradedRowCounts[date] = extractGradedRows(raw).length;
    writeRawJson(ctx.outDir, `wagers/graded/${date}.json`, raw);
    gradedDone.add(date);
    gradedCompleted += 1;
    saveCheckpoint(ctx.outDir, {
      ...previous,
      phase: "wagers",
      wagersPendingDone: true,
      wagersTickerDone: true,
      completedGradedDates: [...gradedDone],
      updatedAtIso: nowIso(ctx.clock),
    });
  }

  const includeFigureDate = options.includeFigureDate !== false;
  const figureDone = new Set(resume ? previous.completedFigureDateKeys : []);
  let figureDateAttempted = 0;
  let figureDateCompleted = 0;
  let figureDateSkipped = 0;
  if (includeFigureDate) {
    const customerIds = filterCustomerIds(
      previous.customerIds,
      options.accounts ?? [],
    );
    const jobs: { customerId: string; date: string; key: string }[] = [];
    for (const customerId of customerIds) {
      for (const date of dates) {
        const key = `${customerId}|${date}`;
        figureDateAttempted += 1;
        if (figureDone.has(key)) {
          figureDateSkipped += 1;
          continue;
        }
        jobs.push({ customerId, date, key });
      }
    }
    const concurrency = options.concurrency ?? 1;
    await mapPool(jobs, concurrency, async (job) => {
      const payload = buildManagerWagersByFigureDatePayload({
        agentID: ctx.agentId,
        agentOwner: ctx.agentOwner || ctx.agentId,
        customerID: job.customerId,
        date: job.date,
        figureDate: job.date,
      });
      const raw = await ctx.client.post(
        "getWagersByFigureDate",
        stringFields(payload as unknown as Record<string, string | number>),
      );
      try {
        parseFigureDateWagersPayload(raw);
      } catch {
        // Persist the raw body even if the envelope is unexpected.
      }
      writeRawJson(
        ctx.outDir,
        `wagers/figure-date/${job.customerId}/${job.date}.json`,
        raw,
      );
      figureDone.add(job.key);
      figureDateCompleted += 1;
      saveCheckpoint(ctx.outDir, {
        ...previous,
        phase: "wagers",
        wagersPendingDone: true,
        wagersTickerDone: true,
        completedGradedDates: [...gradedDone],
        completedFigureDateKeys: [...figureDone],
        updatedAtIso: nowIso(ctx.clock),
      });
      return job.key;
    });
  }

  writeSummaryJson(ctx.outDir, "wagers-summary.json", {
    from: options.from,
    to: options.to,
    pendingRows,
    tickerRows,
    gradedDates: dates,
    gradedCompleted,
    gradedSkipped,
    gradedRowCounts,
    figureDateAttempted,
    figureDateCompleted,
    figureDateSkipped,
    gradedDateFormat: "MM-DD-YYYY",
  });
  return {
    pendingRows,
    tickerRows,
    gradedDates: dates,
    gradedCompleted,
    gradedSkipped,
    gradedRowCounts,
    figureDateAttempted,
    figureDateCompleted,
    figureDateSkipped,
  };
}

/** Test helper: getCustomerAdmin / getPlayers remain callable and gated. */
export async function postAllowlisted(
  client: F402PullClient,
  operation: PullReadOnlyOp,
  fields: Record<string, string>,
): Promise<unknown> {
  return await client.post(operation, fields);
}

export function parseCustomerAdmin(payload: unknown) {
  const parsed = parseCustomerAdminListEnvelope(payload);
  return {
    envelope: redactCustomerAdminListEnvelope(parsed),
    summary: summarizeCustomerAdminList(parsed),
  };
}
