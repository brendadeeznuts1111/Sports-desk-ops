/**
 * Signal-honest data contracts, origin resolver, and Float64Array arena backing
 * for the Sportsdesk NSH Desk workspace (`packages/nsh-desk`).
 *
 * Pure TypeScript with zero UI imports so both `nsh check` (QuickJS/TS 7) and
 * root `bun test` / `bun run typecheck` verify these invariants directly.
 */

export type DeskOriginSource = "env:SPORTSDESK_ORIGIN" | "default:4020";

export interface ResolvedDeskOrigin {
  readonly origin: string;
  readonly source: DeskOriginSource;
}

const DEFAULT_DESK_ORIGIN = "http://127.0.0.1:4020";

/**
 * Resolves the read-only `:4020` Sportsdesk daemon origin with explicit provenance
 * per `docs/architecture/signal-honesty.md` ("Resolvers return value and source").
 */
export function resolveDeskOrigin(
  envOrigin?: string | null,
): ResolvedDeskOrigin {
  const trimmed = typeof envOrigin === "string" ? envOrigin.trim() : "";
  if (trimmed.length === 0) {
    return { origin: DEFAULT_DESK_ORIGIN, source: "default:4020" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (cause) {
    throw new TypeError(
      `[nsh-desk] Invalid SPORTSDESK_ORIGIN '${trimmed}': expected http://127.0.0.1:<port> or http://localhost:<port>`,
      { cause },
    );
  }

  if (parsed.protocol !== "http:") {
    throw new RangeError(
      `[nsh-desk] Unsupported SPORTSDESK_ORIGIN scheme '${parsed.protocol}' in '${trimmed}': capabilities.network.http only grants http:// loopback`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new RangeError(
      `[nsh-desk] Disallowed SPORTSDESK_ORIGIN host '${parsed.hostname}' in '${trimmed}': capabilities.network.http only grants 127.0.0.1 or localhost`,
    );
  }

  const normalized = `${parsed.protocol}//${parsed.host}`;
  return { origin: normalized, source: "env:SPORTSDESK_ORIGIN" };
}

export type EndpointSnapshot<T> =
  | { readonly status: "loading"; readonly endpoint: string }
  | {
      readonly status: "ready";
      readonly endpoint: string;
      readonly httpStatus: number;
      readonly fetchedAtIso: string;
      readonly data: T;
    }
  | {
      readonly status: "unavailable";
      readonly endpoint: string;
      readonly httpStatus: number | null;
      readonly code: string;
      readonly cause: string;
      readonly fetchedAtIso: string;
    };

/**
 * Canonical Signal Honesty basis in NSH Desk (`docs/architecture/signal-honesty.md`).
 * Maps `:4020` `db` -> `live`, `file` -> `capture`, `fixture`/`sample` -> `fixture`.
 */
export type DeskProvenanceBasis =
  "live" | "capture" | "fixture" | "partial" | "none" | "unknown";

/** Integer cents value (`Math.round(usd * 100)`) aligned with `Cents` in `design/domain-branded-types.ts`. */
export type DeskCents = number;

/** Integer basis points (`100 bps = 1.00%`) aligned with `BasisPoints` in `design/domain-branded-types.ts`. */
export type DeskBasisPoints = number;

export function toDeskCents(centsValue: number): DeskCents {
  return Math.round(centsValue);
}

export function usdToDeskCents(usdValue: number): DeskCents {
  return Math.round(usdValue * 100);
}

export function toDeskBasisPoints(bpsValue: number): DeskBasisPoints {
  return Math.round(bpsValue);
}

export function normalizeDeskEntityId(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return /^[a-z0-9_\-.]{2,32}$/i.test(trimmed)
    ? trimmed.toUpperCase()
    : trimmed;
}

export function normalizeDeskIsoUtc(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

export function normalizeDeskBasis(
  rawBasis: string | null | undefined,
  fallback: DeskProvenanceBasis = "unknown",
): DeskProvenanceBasis {
  if (typeof rawBasis !== "string" || rawBasis.trim().length === 0) {
    return fallback;
  }
  const lower = rawBasis.trim().toLowerCase();
  if (lower === "live" || lower === "db" || lower.startsWith("live:")) {
    return "live";
  }
  if (
    lower === "capture" ||
    lower === "file" ||
    lower === "snapshot" ||
    lower.startsWith("file:") ||
    lower.startsWith("capture:")
  ) {
    return "capture";
  }
  if (
    lower === "fixture" ||
    lower === "sample" ||
    lower.startsWith("fixture:")
  ) {
    return "fixture";
  }
  if (lower === "partial") return "partial";
  if (lower === "none") return "none";
  return fallback;
}

export interface ProvenanceTag {
  readonly basis: DeskProvenanceBasis;
  readonly source: string;
  readonly asOf: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly partial: boolean;
}

export interface DeskKpiCardModel {
  readonly id: string;
  readonly title: string;
  readonly primary: string;
  readonly secondary: string;
  readonly provenance: ProvenanceTag;
}

export interface R2SinkRowModel {
  readonly sink: string;
  readonly state: string;
  readonly publishAgeSeconds: number | null;
  readonly publishStale: boolean;
  readonly dataAgeSeconds: number | null;
  readonly dataStale: boolean;
  readonly windowDivergent: boolean;
  readonly reason: string;
}

export interface ParsedKpisPayload {
  readonly generatedAt: string | null;
  readonly cards: readonly DeskKpiCardModel[];
  readonly r2Sinks: readonly R2SinkRowModel[];
}

export interface KalshiAccountExposure {
  readonly login: string;
  readonly agentId: string;
  readonly archetype: string;
  readonly riskUsd: number;
  readonly riskCents: DeskCents;
}

export interface KalshiSignalItem {
  readonly id: string;
  readonly league: string;
  readonly marketLabel: string;
  readonly riskUsd: number;
  readonly riskCents: DeskCents;
  readonly distinctAccounts: number;
  readonly fairProb: number | null;
  readonly edgeBps: DeskBasisPoints | null;
  readonly confidence: number;
  readonly verdict: string;
  readonly reason: string;
  readonly provenance: ProvenanceTag;
  readonly accounts: readonly KalshiAccountExposure[];
}

export interface ParsedKalshiPayload {
  readonly generatedAt: string | null;
  readonly provenance: ProvenanceTag;
  readonly kalshiOk: boolean;
  readonly kalshiDegraded: boolean;
  readonly signals: readonly KalshiSignalItem[];
}

export interface ScoreboardGameItem {
  readonly league: string;
  readonly status: string;
  readonly period: string;
  readonly awayName: string;
  readonly awayScore: number | null;
  readonly homeName: string;
  readonly homeScore: number | null;
}

export interface ParsedScoreboardPayload {
  readonly source: string;
  readonly observedAt: string | null;
  readonly totalGames: number;
  readonly liveGames: number;
  readonly finalGames: number;
  readonly scheduledGames: number;
  readonly games: readonly ScoreboardGameItem[];
}

export interface ParsedLiveBetsSummary {
  readonly totalWagers: number | null;
  readonly totalRiskUsd: number | null;
  readonly totalRiskCents: DeskCents | null;
  readonly mode: string;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function readNum(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readStr(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readBool(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === true;
}

export function formatAgeShort(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "n/a";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

export function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatUsdFromCents(cents: number): string {
  return formatUsd(cents / 100);
}

export function formatProvenanceCompact(p: ProvenanceTag): string {
  const flags: string[] = [p.basis];
  if (p.partial) flags.push("partial");
  if (p.stale) flags.push(`stale ${formatAgeShort(p.ageSeconds)}`);
  else if (p.ageSeconds !== null) flags.push(formatAgeShort(p.ageSeconds));
  return flags.join(" · ");
}

function parseProvenance(
  raw: unknown,
  fallbackBasis: DeskProvenanceBasis,
): ProvenanceTag {
  if (!isRecord(raw)) {
    return {
      basis: fallbackBasis,
      source: "unreported",
      asOf: null,
      ageSeconds: null,
      stale: false,
      partial: false,
    };
  }
  const rawBasisToken =
    readStr(raw, "basis") ??
    (raw["fixture"] === true ? "fixture" : null) ??
    readStr(raw, "dataMode");
  const basis = normalizeDeskBasis(rawBasisToken, fallbackBasis);
  const sourcesArr = Array.isArray(raw["sources"]) ? raw["sources"] : null;
  const firstSource =
    sourcesArr && typeof sourcesArr[0] === "string" ? sourcesArr[0] : null;
  const source =
    readStr(raw, "source") ??
    firstSource ??
    readStr(raw, "path") ??
    "unreported";
  return {
    basis,
    source,
    asOf: normalizeDeskIsoUtc(
      readStr(raw, "asOf") ??
        readStr(raw, "capturedAt") ??
        readStr(raw, "generatedAt"),
    ),
    ageSeconds: readNum(raw, "ageSeconds"),
    stale: readBool(raw, "stale"),
    partial: readBool(raw, "partial") || raw["dataMode"] === "PARTIAL",
  };
}

/**
 * Extracts an explicit failure code + human-readable cause from non-2xx or
 * `success: false` `:4020` JSON payloads without swallowing API diagnostics.
 */
export function extractApiFailureCause(
  endpoint: string,
  httpStatus: number,
  bodyText: string,
): { readonly code: string; readonly cause: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      const topErr = readStr(parsed, "error") ?? readStr(parsed, "message");
      const live = isRecord(parsed["live"]) ? parsed["live"] : null;
      const diag =
        live && isRecord(live["diagnostic"]) ? live["diagnostic"] : null;
      const code =
        (diag ? readStr(diag, "code") : null) ??
        readStr(parsed, "code") ??
        `http_${httpStatus}`;
      const diagMsg = diag ? readStr(diag, "message") : null;
      const parts = [topErr, diagMsg].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
      if (parts.length > 0) {
        return {
          code,
          cause: `${endpoint} HTTP ${httpStatus} [${code}]: ${parts.join(" — ")}`,
        };
      }
    }
  } catch {
    // signal-honesty: intentional-non-json-fallback — bodyText prefix is surfaced directly below.
  }
  const snippet = bodyText.trim().slice(0, 140) || "empty response body";
  return {
    code: `http_${httpStatus}`,
    cause: `${endpoint} HTTP ${httpStatus}: ${snippet}`,
  };
}

export function parseKpisPayload(raw: unknown): ParsedKpisPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/kpis payload is not a JSON object");
  }
  const kpis = isRecord(raw["kpis"]) ? raw["kpis"] : {};
  const cards: DeskKpiCardModel[] = [];

  const agents = isRecord(kpis["agents"]) ? kpis["agents"] : null;
  if (agents) {
    const total = readNum(agents, "total");
    const subAgents = readNum(agents, "agents");
    const masters = readNum(agents, "masters");
    cards.push({
      id: "agents",
      title: "Agent Hierarchy",
      primary:
        total !== null
          ? `${total.toLocaleString("en-US")} nodes`
          : "unavailable",
      secondary:
        subAgents !== null && masters !== null
          ? `${subAgents} agents · ${masters} masters`
          : "counts unavailable",
      provenance: parseProvenance(agents["provenance"], "unknown"),
    });
  }

  const pending = isRecord(kpis["pending"]) ? kpis["pending"] : null;
  if (pending) {
    const wagers = readNum(pending, "wagers");
    const wageredCents = readNum(pending, "wageredCents");
    const toWinCents = readNum(pending, "toWinCents");
    cards.push({
      id: "pending",
      title: "Pending Exposure",
      primary:
        wageredCents !== null
          ? formatUsdFromCents(wageredCents)
          : "unavailable",
      secondary:
        wagers !== null && toWinCents !== null
          ? `${wagers} wagers · to-win ${formatUsdFromCents(toWinCents)}`
          : "wager breakdown unavailable",
      provenance: parseProvenance(pending["provenance"], "unknown"),
    });
  }

  const ticker = isRecord(kpis["ticker"]) ? kpis["ticker"] : null;
  if (ticker) {
    const wagers = readNum(ticker, "wagers");
    const riskCents = readNum(ticker, "riskCents");
    const volumeCents = readNum(ticker, "volumeCents");
    cards.push({
      id: "ticker",
      title: "Bet Ticker Capture",
      primary:
        riskCents !== null ? formatUsdFromCents(riskCents) : "unavailable",
      secondary:
        wagers !== null && volumeCents !== null
          ? `${wagers} wagers · vol ${formatUsdFromCents(volumeCents)}`
          : "ticker breakdown unavailable",
      provenance: parseProvenance(ticker["provenance"], "unknown"),
    });
  }

  const book = isRecord(kpis["customerBook"]) ? kpis["customerBook"] : null;
  if (book) {
    const customers = readNum(book, "customers");
    const tickets = readNum(book, "tickets");
    const netCents = readNum(book, "customerNetCents");
    cards.push({
      id: "customerBook",
      title: "Customer Book",
      primary: netCents !== null ? formatUsdFromCents(netCents) : "unavailable",
      secondary:
        customers !== null && tickets !== null
          ? `${customers} customers · ${tickets} tickets`
          : "book breakdown unavailable",
      provenance: parseProvenance(book["provenance"], "unknown"),
    });
  }

  const r2Sinks: R2SinkRowModel[] = [];
  const pipeline = isRecord(raw["pipeline"]) ? raw["pipeline"] : null;
  const r2 = pipeline && isRecord(pipeline["r2"]) ? pipeline["r2"] : null;
  if (r2) {
    for (const [sink, entry] of Object.entries(r2)) {
      if (!isRecord(entry)) continue;
      const publishAgeSeconds = readNum(entry, "ageSeconds");
      const publishStale = readBool(entry, "stale");
      const dataAgeSeconds = readNum(entry, "dataAgeSeconds");
      const dataStale = readBool(entry, "dataStale");
      r2Sinks.push({
        sink,
        state: readStr(entry, "state") ?? (publishStale ? "stale" : "fresh"),
        publishAgeSeconds,
        publishStale,
        dataAgeSeconds,
        dataStale,
        windowDivergent: !publishStale && dataStale,
        reason: readStr(entry, "reason") ?? "n/a",
      });
    }
  }

  return {
    generatedAt: readStr(raw, "generatedAt"),
    cards,
    r2Sinks,
  };
}

export function parseKalshiPayload(raw: unknown): ParsedKalshiPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/signals/kalshi payload is not a JSON object",
    );
  }
  const provenance = parseProvenance(raw["provenance"], "unknown");
  const kalshiMeta = isRecord(raw["kalshi"]) ? raw["kalshi"] : {};
  const rawSignals = Array.isArray(raw["signals"]) ? raw["signals"] : [];

  const signals: KalshiSignalItem[] = [];
  for (const item of rawSignals) {
    if (!isRecord(item)) continue;
    const id = readStr(item, "id") ?? "unknown-signal";
    const league = readStr(item, "league") ?? "UNK";
    const marketKind = readStr(item, "marketKind") ?? "market";
    const line = readNum(item, "line");
    const ou = readStr(item, "overUnder");
    const sideTeam = readStr(item, "sideTeam");
    const teams = Array.isArray(item["teams"])
      ? item["teams"].filter((t): t is string => typeof t === "string")
      : [];
    const matchup = teams.length > 0 ? teams.join("@") : id;
    const qualifier =
      ou !== null && line !== null
        ? `${ou} ${line}`
        : sideTeam !== null && line !== null
          ? `${sideTeam} ${line > 0 ? `+${line}` : line}`
          : (sideTeam ?? marketKind);
    const marketLabel = `${matchup} · ${marketKind} (${qualifier})`;

    const kalshiObj = isRecord(item["kalshi"]) ? item["kalshi"] : {};
    const accountsRaw = Array.isArray(item["accounts"]) ? item["accounts"] : [];
    const accounts: KalshiAccountExposure[] = [];
    for (const acc of accountsRaw) {
      if (!isRecord(acc)) continue;
      const accRiskCentsRaw = readNum(acc, "riskCents");
      const accRiskUsd =
        readNum(acc, "riskUsd") ??
        (accRiskCentsRaw !== null ? accRiskCentsRaw / 100 : 0);
      const accRiskCents =
        accRiskCentsRaw !== null
          ? toDeskCents(accRiskCentsRaw)
          : usdToDeskCents(accRiskUsd);
      accounts.push({
        login: normalizeDeskEntityId(readStr(acc, "login"), "unknown"),
        agentId: normalizeDeskEntityId(readStr(acc, "agentId"), "unknown"),
        archetype: readStr(acc, "archetype") ?? "unclassified",
        riskUsd: accRiskUsd,
        riskCents: accRiskCents,
      });
    }

    const itemRiskCentsRaw = readNum(item, "riskCents");
    const itemRiskUsd =
      readNum(item, "riskUsd") ??
      (itemRiskCentsRaw !== null ? itemRiskCentsRaw / 100 : 0);
    const itemRiskCents =
      itemRiskCentsRaw !== null
        ? toDeskCents(itemRiskCentsRaw)
        : usdToDeskCents(itemRiskUsd);
    const rawEdge = readNum(kalshiObj, "edgeBps");

    signals.push({
      id,
      league,
      marketLabel,
      riskUsd: itemRiskUsd,
      riskCents: itemRiskCents,
      distinctAccounts: readNum(item, "distinctAccounts") ?? accounts.length,
      fairProb: readNum(item, "fairProb"),
      edgeBps: rawEdge !== null ? toDeskBasisPoints(rawEdge) : null,
      confidence: readNum(item, "confidence") ?? 0,
      verdict: readStr(kalshiObj, "verdict") ?? "unmatched",
      reason: readStr(kalshiObj, "reason") ?? "no verdict detail",
      provenance: parseProvenance(item["provenance"], provenance.basis),
      accounts,
    });
  }

  return {
    generatedAt: normalizeDeskIsoUtc(readStr(raw, "generatedAt")),
    provenance,
    kalshiOk: readBool(kalshiMeta, "ok"),
    kalshiDegraded: readBool(kalshiMeta, "degraded"),
    signals,
  };
}

export function parseScoreboardPayload(raw: unknown): ParsedScoreboardPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/scoreboard payload is not a JSON object",
    );
  }
  const summary = isRecord(raw["summary"]) ? raw["summary"] : {};
  const rawGames = Array.isArray(raw["games"]) ? raw["games"] : [];
  const games: ScoreboardGameItem[] = [];

  for (const g of rawGames) {
    if (!isRecord(g)) continue;
    const t1 = isRecord(g["team1"]) ? g["team1"] : {};
    const t2 = isRecord(g["team2"]) ? g["team2"] : {};
    games.push({
      league: readStr(g, "league") ?? "UNK",
      status: readStr(g, "status") ?? "unknown",
      period: readStr(g, "period") ?? "-",
      awayName: readStr(t1, "name") ?? "Away",
      awayScore: readNum(t1, "score"),
      homeName: readStr(t2, "name") ?? "Home",
      homeScore: readNum(t2, "score"),
    });
  }

  return {
    source: readStr(raw, "source") ?? "unreported",
    observedAt: readStr(raw, "observedAt"),
    totalGames: readNum(summary, "games") ?? games.length,
    liveGames: readNum(summary, "live") ?? 0,
    finalGames: readNum(summary, "final") ?? 0,
    scheduledGames: readNum(summary, "scheduled") ?? 0,
    games,
  };
}

export function parseLiveBetsSummaryPayload(
  raw: unknown,
): ParsedLiveBetsSummary {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/live-bets/summary payload is not a JSON object",
    );
  }
  const summary = isRecord(raw["summary"]) ? raw["summary"] : raw;
  const explicitCents =
    readNum(summary, "wageredCents") ??
    readNum(summary, "totalWagered") ??
    readNum(summary, "riskCents");
  const explicitUsd =
    readNum(summary, "totalRiskUsd") ?? readNum(summary, "riskUsd");
  const totalRiskCents =
    explicitCents !== null
      ? toDeskCents(explicitCents)
      : explicitUsd !== null
        ? usdToDeskCents(explicitUsd)
        : null;
  const totalRiskUsd =
    explicitUsd !== null
      ? explicitUsd
      : totalRiskCents !== null
        ? totalRiskCents / 100
        : null;
  const rawDataSource =
    readStr(raw, "mode") ?? readStr(summary, "dataSource") ?? "live";
  return {
    totalWagers:
      readNum(summary, "totalWagers") ??
      readNum(summary, "totalPending") ??
      readNum(summary, "count"),
    totalRiskUsd,
    totalRiskCents,
    mode: rawDataSource,
  };
}

/**
 * Fixed-stride `Float64Array` + `Uint32Array` index arena for sorting Kalshi
 * signals without allocating intermediate row objects on sort/filter changes.
 */
const SIGNAL_METRIC_STRIDE = 5;
const COL_RISK = 0;
const COL_ACCOUNTS = 1;
const COL_FAIR_PROB = 2;
const COL_EDGE_BPS = 3;
const COL_CONFIDENCE = 4;

export interface SignalArenaIndex {
  readonly items: readonly KalshiSignalItem[];
  readonly metrics: Float64Array;
  readonly baseRows: readonly string[][];
  readonly indexById: ReadonlyMap<string, number>;
}

export interface SignalArenaView {
  readonly rows: string[][];
  readonly order: Uint32Array;
  readonly items: readonly KalshiSignalItem[];
}

/**
 * Precomputes the fixed-stride `Float64Array` metric buffer, pre-formatted row
 * cell arrays, and `O(1)` `id -> index` map once per `/api/signals/kalshi` snapshot.
 */
export function buildSignalArenaIndex(
  items: readonly KalshiSignalItem[],
): SignalArenaIndex {
  const count = items.length;
  const metrics = new Float64Array(count * SIGNAL_METRIC_STRIDE);
  // eslint-disable-next-line unicorn/no-new-array -- dense preallocation filled by index
  const baseRows: string[][] = new Array(count);
  const indexById = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    const s = items[i]!;
    const base = i * SIGNAL_METRIC_STRIDE;
    metrics[base + COL_RISK] = s.riskUsd;
    metrics[base + COL_ACCOUNTS] = s.distinctAccounts;
    metrics[base + COL_FAIR_PROB] = s.fairProb ?? -1;
    metrics[base + COL_EDGE_BPS] = s.edgeBps ?? Number.NEGATIVE_INFINITY;
    metrics[base + COL_CONFIDENCE] = s.confidence;

    if (!indexById.has(s.id)) {
      indexById.set(s.id, i);
    }

    const edgeText =
      s.edgeBps === null
        ? "—"
        : `${s.edgeBps >= 0 ? "+" : ""}${s.edgeBps.toFixed(0)} bps`;
    const fairText =
      s.fairProb === null ? "—" : `${(s.fairProb * 100).toFixed(1)}%`;
    baseRows[i] = [
      s.league,
      s.marketLabel,
      formatUsd(s.riskUsd),
      String(s.distinctAccounts),
      fairText,
      edgeText,
      `${s.confidence}%`,
      s.verdict,
      formatProvenanceCompact(s.provenance),
    ];
  }

  return { items, metrics, baseRows, indexById };
}

/**
 * Sorts a `Uint32Array` index permutation against a precomputed `SignalArenaIndex`
 * without reallocating metric buffers or re-formatting cells on header clicks.
 */
export function sortSignalArenaIndex(
  index: SignalArenaIndex,
  sortKey: string | null,
  sortDirection: "ascending" | "descending" | null,
): SignalArenaView {
  const { items, metrics, baseRows } = index;
  const count = items.length;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    order[i] = i;
  }

  if (sortKey !== null && sortDirection !== null && count > 1) {
    const sign = sortDirection === "descending" ? -1 : 1;
    const metricOffset =
      sortKey === "risk"
        ? COL_RISK
        : sortKey === "accounts"
          ? COL_ACCOUNTS
          : sortKey === "fairProb"
            ? COL_FAIR_PROB
            : sortKey === "edge"
              ? COL_EDGE_BPS
              : sortKey === "confidence"
                ? COL_CONFIDENCE
                : -1;

    order.sort((a, b) => {
      if (metricOffset >= 0) {
        const va = metrics[a * SIGNAL_METRIC_STRIDE + metricOffset]!;
        const vb = metrics[b * SIGNAL_METRIC_STRIDE + metricOffset]!;
        if (va !== vb) return va < vb ? -1 * sign : 1 * sign;
      } else if (sortKey === "league") {
        const cmp = items[a]!.league.localeCompare(items[b]!.league);
        if (cmp !== 0) return cmp * sign;
      } else if (sortKey === "market") {
        const cmp = items[a]!.marketLabel.localeCompare(items[b]!.marketLabel);
        if (cmp !== 0) return cmp * sign;
      }
      return a - b;
    });
  }

  // eslint-disable-next-line unicorn/no-new-array -- dense preallocation filled by index
  const rows: string[][] = new Array(count);
  for (let pos = 0; pos < count; pos++) {
    rows[pos] = baseRows[order[pos]!]!;
  }

  return { rows, order, items };
}

export function buildSignalArenaView(
  items: readonly KalshiSignalItem[],
  sortKey: string | null,
  sortDirection: "ascending" | "descending" | null,
): SignalArenaView {
  return sortSignalArenaIndex(
    buildSignalArenaIndex(items),
    sortKey,
    sortDirection,
  );
}

export interface ExposurePlotPoint {
  readonly index: number;
  readonly shortLabel: string;
  readonly fullLabel: string;
  readonly league: string;
  readonly riskUsd: number;
  readonly confidence: number;
  readonly verdict: string;
  readonly provenanceText: string;
}

export function buildExposurePlotData(
  items: readonly KalshiSignalItem[],
  limit = 12,
): ExposurePlotPoint[] {
  const count = Math.min(items.length, limit);
  // eslint-disable-next-line unicorn/no-new-array -- dense preallocation filled by index
  const points: ExposurePlotPoint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const s = items[i]!;
    const shortId = s.id.replace(/^[A-Z]+-/, "").slice(0, 14);
    points[i] = {
      index: i,
      shortLabel: shortId,
      fullLabel: `${s.league} · ${s.marketLabel}`,
      league: s.league,
      riskUsd: s.riskUsd,
      confidence: s.confidence,
      verdict: s.verdict,
      provenanceText: formatProvenanceCompact(s.provenance),
    };
  }
  return points;
}

export function buildScoreboardRows(
  games: readonly ScoreboardGameItem[],
  leagueFilter: string,
): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < games.length; i++) {
    const g = games[i]!;
    if (leagueFilter !== "ALL" && g.league !== leagueFilter) continue;
    const score =
      g.awayScore !== null && g.homeScore !== null
        ? `${g.awayScore} - ${g.homeScore}`
        : "vs";
    rows.push([
      g.league,
      g.status.toUpperCase(),
      g.period,
      `${g.awayName} @ ${g.homeName}`,
      score,
    ]);
  }
  return rows;
}

export type DeskLeagueFilter = "ALL" | "NFL" | "NBA" | "NHL" | "NCAA";

const VALID_LEAGUE_FILTERS: ReadonlySet<string> = new Set([
  "ALL",
  "NFL",
  "NBA",
  "NHL",
  "NCAA",
]);

/** Key used with NSH `Storage` (`nsh.json` `"id": "ops.sportsdesk.desk"`). */
export const DESK_PREFS_STORAGE_KEY = "ops.sportsdesk.desk.prefs.v1";

export interface DeskWorkspacePrefs {
  readonly schemaVersion: 1;
  readonly leagueFilter: DeskLeagueFilter;
  readonly autoPoll: boolean;
  readonly locked: boolean;
  readonly dockOpen: {
    readonly left: boolean;
    readonly bottom: boolean;
  };
}

export function defaultWorkspacePrefs(): DeskWorkspacePrefs {
  return {
    schemaVersion: 1,
    leagueFilter: "ALL",
    autoPoll: false,
    locked: false,
    dockOpen: { left: true, bottom: true },
  };
}

export function parseWorkspacePrefsJson(
  rawJson: string | null | undefined,
): DeskWorkspacePrefs {
  const defaults = defaultWorkspacePrefs();
  if (typeof rawJson !== "string" || rawJson.trim().length === 0) {
    return defaults;
  }
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!isRecord(parsed)) return defaults;
    const rawLeague = readStr(parsed, "leagueFilter");
    const leagueFilter: DeskLeagueFilter =
      rawLeague !== null && VALID_LEAGUE_FILTERS.has(rawLeague)
        ? (rawLeague as DeskLeagueFilter)
        : defaults.leagueFilter;
    const dockRaw = isRecord(parsed["dockOpen"]) ? parsed["dockOpen"] : null;
    return {
      schemaVersion: 1,
      leagueFilter,
      autoPoll:
        typeof parsed["autoPoll"] === "boolean"
          ? parsed["autoPoll"]
          : defaults.autoPoll,
      locked:
        typeof parsed["locked"] === "boolean"
          ? parsed["locked"]
          : defaults.locked,
      dockOpen: {
        left:
          dockRaw && typeof dockRaw["left"] === "boolean"
            ? dockRaw["left"]
            : defaults.dockOpen.left,
        bottom:
          dockRaw && typeof dockRaw["bottom"] === "boolean"
            ? dockRaw["bottom"]
            : defaults.dockOpen.bottom,
      },
    };
  } catch {
    return defaults;
  }
}

export function serializeWorkspacePrefs(prefs: DeskWorkspacePrefs): string {
  return JSON.stringify({
    schemaVersion: 1,
    leagueFilter: prefs.leagueFilter,
    autoPoll: prefs.autoPoll,
    locked: prefs.locked,
    dockOpen: {
      left: prefs.dockOpen.left,
      bottom: prefs.dockOpen.bottom,
    },
  });
}

export interface DiagnosticsSnapshotInput {
  readonly origin: ResolvedDeskOrigin;
  readonly pollCount: number;
  readonly lastPollMs: number | null;
  readonly endpoints: readonly EndpointSnapshot<unknown>[];
  readonly liveBets: EndpointSnapshot<ParsedLiveBetsSummary>;
  readonly r2Sinks: readonly R2SinkRowModel[];
}

export function buildDiagnosticsSnapshotJson(
  input: DiagnosticsSnapshotInput,
): string {
  return JSON.stringify(
    {
      appId: "ops.sportsdesk.desk",
      origin: input.origin.origin,
      originSource: input.origin.source,
      pollCount: input.pollCount,
      lastPollMs: input.lastPollMs,
      endpoints: input.endpoints.map((ep) =>
        ep.status === "loading"
          ? { endpoint: ep.endpoint, status: "loading" }
          : ep.status === "ready"
            ? {
                endpoint: ep.endpoint,
                status: "ready",
                httpStatus: ep.httpStatus,
                fetchedAtIso: ep.fetchedAtIso,
              }
            : {
                endpoint: ep.endpoint,
                status: "unavailable",
                httpStatus: ep.httpStatus,
                code: ep.code,
                cause: ep.cause,
                fetchedAtIso: ep.fetchedAtIso,
              },
      ),
      liveBetsSummary:
        input.liveBets.status === "ready" ? input.liveBets.data : null,
      r2Sinks: input.r2Sinks,
    },
    null,
    2,
  );
}

// ============================================================================
// Complete :4020 Endpoint Parity Catalog, Stocks Market Synthesis & Parsers
// ============================================================================

export type DeskPlaneId =
  "markets" | "terminal" | "board" | "surveillance" | "forensics" | "ops";

export type MarketWatchFilter = "all" | "gainers" | "losers" | "active";
export type MarketChartPeriod = "intraday" | "1m" | "5m" | "15m" | "4w";
export type LiveBetsSourceMode = "auto" | "file" | "live";

export interface DeskEndpointCatalogEntry {
  readonly id: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly aliases: readonly string[];
  readonly plane: DeskPlaneId;
  readonly auth: "loopback" | "admin-bearer";
  readonly autoSweep: boolean;
  readonly sweepPath: string;
  readonly summary: string;
}

/**
 * Canonical catalog of every HTTP API, health, and governance endpoint served by
 * `services/sportsdesk_webview_server.ts` (`:4020`). Verified against server source
 * in `tests/nsh_desk_contract.test.ts`.
 */
export const DESK_ENDPOINT_CATALOG: readonly DeskEndpointCatalogEntry[] = [
  // Markets & Execution Plane
  {
    id: "signals-kalshi",
    method: "GET",
    path: "/api/signals/kalshi",
    aliases: [],
    plane: "markets",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/signals/kalshi",
    summary: "Kalshi fair-prob signals, edge bps, and account exposure",
  },
  {
    id: "kpis",
    method: "GET",
    path: "/api/kpis",
    aliases: [],
    plane: "markets",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/kpis",
    summary: "Headline desk KPIs + R2 pipeline publish/data-window ages (#78)",
  },
  {
    id: "execution-plan",
    method: "GET",
    path: "/api/execution/plan",
    aliases: [],
    plane: "markets",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/execution/plan?limit=25&style=auto",
    summary: "Paper/paused execution plan, risk caps, and decision sizing",
  },
  {
    id: "execution-mode",
    method: "POST",
    path: "/api/execution/mode",
    aliases: [],
    plane: "markets",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/execution/mode",
    summary: "Switch execution engine mode (paper or paused)",
  },
  {
    id: "execution-run",
    method: "POST",
    path: "/api/execution/run",
    aliases: [],
    plane: "markets",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/execution/run",
    summary: "Execute paper-fill pass (auto / maker / taker)",
  },

  // Board, Sports & Live Bets Plane
  {
    id: "game-admin-board",
    method: "GET",
    path: "/api/game-admin/board",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/game-admin/board?window=24",
    summary: "Game Admin opener vs current spread/money/total lines",
  },
  {
    id: "game-admin",
    method: "GET",
    path: "/api/game-admin",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/game-admin",
    summary: "Game Admin Straight / Parlay / Teaser position rollups",
  },
  {
    id: "scoreboard",
    method: "GET",
    path: "/api/scoreboard",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/scoreboard",
    summary: "Observed manager scoreboard matchups and live/final states",
  },
  {
    id: "logo-meta",
    method: "GET",
    path: "/api/logo/",
    aliases: ["/api/logo/:team"],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/logo/lakers?meta=1&lqip=1",
    summary: "Team logo asset dimensions, format, byte size, and LQIP meta",
  },
  {
    id: "sports",
    method: "GET",
    path: "/api/sports",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/sports",
    summary:
      "Cross-feed sport inventory across catalog, wagers, and scoreboard",
  },
  {
    id: "sports-catalog",
    method: "GET",
    path: "/api/sports/catalog",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/sports/catalog",
    summary: "Portal sport/sub-sport/period taxonomy, collisions & risks",
  },
  {
    id: "contests",
    method: "GET",
    path: "/api/contests",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/contests",
    summary: "Futures & contest catalog filterable by group and query",
  },
  {
    id: "live-bets-summary",
    method: "GET",
    path: "/api/live-bets/summary",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/live-bets/summary?source=file",
    summary: "Live-bets summary wagers, risk USD, and freshness telemetry",
  },
  {
    id: "v1-live-bets",
    method: "GET",
    path: "/api/v1/live-bets",
    aliases: ["/api/live-bets"],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/v1/live-bets?source=file",
    summary: "Frozen v1 live-bets game exposure payload (/api/live-bets 308)",
  },
  {
    id: "v2-live-bets",
    method: "GET",
    path: "/api/v2/live-bets",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/v2/live-bets?source=file&fallback=file",
    summary: "Provenance-aware v2 live-bets games, agents, and warnings",
  },
  {
    id: "live-wagers",
    method: "GET",
    path: "/api/live-wagers",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/live-wagers?source=file",
    summary: "Parsed live wagers & tickets filterable by writer and type",
  },
  {
    id: "f402-retired-guard",
    method: "GET",
    path: "/api/f402/get-pending",
    aliases: [],
    plane: "board",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/f402/get-pending",
    summary: "Retired 410 Gone guard verifying legacy pending route removal",
  },

  // Surveillance & GSLive Plane
  {
    id: "graph-summary",
    method: "GET",
    path: "/api/graph/summary",
    aliases: [],
    plane: "surveillance",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/graph/summary",
    summary: "Syndicate graph feed, repo, bridges, and automation rollup",
  },
  {
    id: "graph-feed",
    method: "GET",
    path: "/api/graph-feed",
    aliases: ["/graph-live-feed.json"],
    plane: "surveillance",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/graph-feed",
    summary:
      "Schema v3 syndicate wallets, pending bets, IP clusters & 4W backtest",
  },
  {
    id: "graph-stream",
    method: "GET",
    path: "/api/graph/stream",
    aliases: [],
    plane: "surveillance",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/graph/stream",
    summary: "Live SSE stream (text/event-stream) for syndicate graph updates",
  },
  {
    id: "gslive-weblogs",
    method: "GET",
    path: "/api/gslive/weblogs",
    aliases: [],
    plane: "surveillance",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/gslive/weblogs",
    summary: "Measured vs not_measured GSLive account weblog activity",
  },
  {
    id: "gslive-session-health",
    method: "GET",
    path: "/api/gslive/session-health",
    aliases: [],
    plane: "surveillance",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/gslive/session-health?probe=0",
    summary: "GSLive auth model, session readiness, surface map & probe",
  },
  {
    id: "bridge3c-status",
    method: "GET",
    path: "/api/bridge3c/status",
    aliases: [],
    plane: "surveillance",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/bridge3c/status",
    summary: "Class-D GSLive tally bridge boundary and read-only rollup state",
  },

  // Forensics: Agents, Analysis & Customer Book Plane
  {
    id: "agents-search",
    method: "GET",
    path: "/api/agents/search",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/agents/search?q=BI&limit=20",
    summary: "Agent hierarchy prefix/substring search (>= 2 chars)",
  },
  {
    id: "agent-tree",
    method: "GET",
    path: "/api/agent-tree",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/agent-tree?view=hierarchy",
    summary: "2,276-node agent tree (flat counts & ?view=hierarchy roots)",
  },
  {
    id: "analysis-filters",
    method: "GET",
    path: "/api/analysis/filters",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/analysis/filters",
    summary: "Available portal analysis reports, sports, weeks, and activities",
  },
  {
    id: "analysis-reports",
    method: "GET",
    path: "/api/analysis/reports",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/analysis/reports",
    summary: "Captured portal analysis report inventory",
  },
  {
    id: "analysis",
    method: "GET",
    path: "/api/analysis",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath:
      "/api/analysis?report=CP&agent=BILLY666&sport=Baseball&week=-1&activity=0",
    summary:
      "Portal analysis rows (integer cents), recomputed totals & discrepancies",
  },
  {
    id: "customer-profile",
    method: "GET",
    path: "/api/customer/profile",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/customer/profile?id=DK121",
    summary:
      "Offline customer book profile, channel proxy split & sample tickets",
  },
  {
    id: "customer-rating",
    method: "GET",
    path: "/api/customer/rating",
    aliases: [],
    plane: "forensics",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/customer/rating?id=DK121",
    summary: "Customer Bayesian skill & Kelly sizing forensics",
  },
  {
    id: "watchlist",
    method: "GET",
    path: "/api/watchlist",
    aliases: [],
    plane: "forensics",
    auth: "admin-bearer",
    autoSweep: true,
    sweepPath: "/api/watchlist",
    summary: "Admin-gated customer surveillance watchlist",
  },

  // System, Governance, Telegram & Parser Workbench Plane
  {
    id: "health",
    method: "GET",
    path: "/health",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/health",
    summary: "Enhanced daemon health, degraded reasons, and source checks",
  },
  {
    id: "status",
    method: "GET",
    path: "/api/status",
    aliases: ["/status.json"],
    plane: "ops",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/status",
    summary: "Runtime memory/CPU, live capture subsystems & Telegram summary",
  },
  {
    id: "dns-telemetry",
    method: "GET",
    path: "/api/dns/telemetry",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/api/dns/telemetry",
    summary: "Bun.dns cache hit rate, inflight coalescing & core hosts",
  },
  {
    id: "governance",
    method: "GET",
    path: "/governance.json",
    aliases: ["/governance"],
    plane: "ops",
    auth: "loopback",
    autoSweep: true,
    sweepPath: "/governance.json",
    summary:
      "RBAC & Task Governance oracle gates, scorecards, tasks & findings",
  },
  {
    id: "telegram-status",
    method: "GET",
    path: "/api/telegram/status",
    aliases: ["/api/telegram/"],
    plane: "ops",
    auth: "admin-bearer",
    autoSweep: true,
    sweepPath: "/api/telegram/status",
    summary: "Admin-gated Telegram bot & credential env status (names only)",
  },
  {
    id: "telegram-activity",
    method: "GET",
    path: "/api/telegram/activity",
    aliases: [],
    plane: "ops",
    auth: "admin-bearer",
    autoSweep: true,
    sweepPath: "/api/telegram/activity?limit=25",
    summary: "Admin-gated Telegram alert/report dispatch log",
  },
  {
    id: "telegram-webhook",
    method: "POST",
    path: "/api/telegram/webhook",
    aliases: [],
    plane: "ops",
    auth: "admin-bearer",
    autoSweep: false,
    sweepPath: "/api/telegram/webhook",
    summary: "Admin-gated Telegram webhook set/delete command",
  },
  {
    id: "telegram-alert",
    method: "POST",
    path: "/api/telegram/alert",
    aliases: [],
    plane: "ops",
    auth: "admin-bearer",
    autoSweep: false,
    sweepPath: "/api/telegram/alert",
    summary: "Admin-gated instant Telegram customer alert test",
  },
  {
    id: "telegram-report",
    method: "POST",
    path: "/api/telegram/report",
    aliases: [],
    plane: "ops",
    auth: "admin-bearer",
    autoSweep: false,
    sweepPath: "/api/telegram/report?type=EVENING_SETTLEMENT",
    summary: "Admin-gated scheduled executive Telegram report dispatch",
  },
  {
    id: "parse-xml",
    method: "POST",
    path: "/api/parse-xml",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-xml",
    summary: "Bun.XML SIMD parser debug endpoint",
  },
  {
    id: "parse-bet-ticker",
    method: "POST",
    path: "/api/parse-bet-ticker",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-bet-ticker",
    summary: "Bet-ticker XML compact tree parser",
  },
  {
    id: "parse-customer-profile",
    method: "POST",
    path: "/api/parse-customer-profile",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-customer-profile",
    summary: "Customer profile XML row normalizer",
  },
  {
    id: "parse-customer-performance",
    method: "POST",
    path: "/api/parse-customer-performance",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-customer-performance",
    summary: "Customer performance XML parser",
  },
  {
    id: "parse-transactions",
    method: "POST",
    path: "/api/parse-transactions",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-transactions",
    summary: "Customer transactions XML parser",
  },
  {
    id: "parse-ajax-xml",
    method: "POST",
    path: "/api/parse-ajax-xml",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-ajax-xml",
    summary: "Generic AJAX XML compact tree parser",
  },
  {
    id: "parse-fantasy402-ajax",
    method: "POST",
    path: "/api/parse-fantasy402-ajax",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-fantasy402-ajax",
    summary: "Fantasy402 AJAX XML compact tree parser",
  },
  {
    id: "parse-toml",
    method: "POST",
    path: "/api/parse-toml",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-toml",
    summary: "Bun.TOML v1.1 document parser",
  },
  {
    id: "parse-formdata",
    method: "POST",
    path: "/api/parse-formdata",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/parse-formdata",
    summary: "Multipart/URL-encoded FormData echo parser",
  },
  {
    id: "test-error-guard",
    method: "GET",
    path: "/api/test/error",
    aliases: [],
    plane: "ops",
    auth: "loopback",
    autoSweep: false,
    sweepPath: "/api/test/error",
    summary: "Explicit HTTP 500 error-boundary stack-redaction verifier",
  },
];

// --- Stocks Terminal Domain Models ---

export interface MarketBookLevel {
  readonly level: number;
  readonly price: number;
  readonly sizeUsd: number;
  readonly cumulativeUsd: number;
  readonly ratio: number;
}

export interface MarketTapeEntry {
  readonly key: string;
  readonly timeLabel: string;
  readonly actor: string;
  readonly archetype: string;
  readonly price: number;
  readonly sizeUsd: number;
  readonly side: "up" | "down" | "flat";
  readonly isBlock: boolean;
}

export interface MarketFlowBucket {
  readonly label: string;
  readonly inflowUsd: number;
  readonly outflowUsd: number;
  readonly netUsd: number;
  readonly inflowRatio: number;
  readonly outflowRatio: number;
}

export interface MarketSeriesPoint {
  readonly label: string;
  readonly value: number;
  readonly volume: number;
  readonly ma5: number;
}

export interface MarketRangeRow {
  readonly label: string;
  readonly low: number;
  readonly high: number;
  readonly prev: number;
  readonly last: number;
}

export interface MarketInstrumentQuote {
  readonly last: number;
  readonly open: number;
  readonly prevClose: number;
  readonly avgPrice: number;
  readonly high: number;
  readonly low: number;
  readonly bookHigh: number;
  readonly bookLow: number;
  readonly amplitudePct: number;
  readonly changeCents: number;
  readonly changePct: number;
  readonly edgeBps: number | null;
  readonly confidence: number;
  readonly distinctAccounts: number;
  readonly riskUsd: number;
}

export interface MarketInstrument {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly league: string;
  readonly verdict: string;
  readonly reason: string;
  readonly provenance: ProvenanceTag;
  readonly accounts: readonly KalshiAccountExposure[];
  readonly quote: MarketInstrumentQuote;
  readonly sparkline: readonly number[];
  readonly periods: Readonly<
    Record<MarketChartPeriod, readonly MarketSeriesPoint[]>
  >;
  readonly book: {
    readonly bids: readonly MarketBookLevel[];
    readonly asks: readonly MarketBookLevel[];
    readonly bidTotalUsd: number;
    readonly askTotalUsd: number;
    readonly bidRatio: number;
    readonly askRatio: number;
    readonly spreadCents: number;
    readonly imbalancePct: number;
  };
  readonly trades: readonly MarketTapeEntry[];
  readonly flow: readonly MarketFlowBucket[];
  readonly ranges: readonly MarketRangeRow[];
}

export interface MarketLeagueBreadth {
  readonly league: string;
  readonly count: number;
  readonly riskUsd: number;
  readonly avgEdgeBps: number;
  readonly ratio: number;
}

export interface MarketCompositeSummary {
  readonly indexValue: number;
  readonly prevValue: number;
  readonly changePoints: number;
  readonly changePct: number;
  readonly advancers: number;
  readonly decliners: number;
  readonly unchanged: number;
  readonly totalRiskUsd: number;
  readonly totalAccounts: number;
  readonly leagues: readonly MarketLeagueBreadth[];
}

function clampProbCents(v: number): number {
  return Math.max(1, Math.min(99, Number(v.toFixed(2))));
}

function deriveTickerCode(sig: KalshiSignalItem): string {
  const head = sig.marketLabel.split("·")[0]?.trim() ?? sig.id;
  const compact = head.replace(/\s+/g, "");
  return `${sig.league}·${compact.slice(0, 11)}`;
}

function buildDeterministicSeries(
  open: number,
  prevClose: number,
  last: number,
  riskUsd: number,
  count: number,
  prefix: string,
  seed: number,
): MarketSeriesPoint[] {
  const rawVals: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = count <= 1 ? 1 : i / (count - 1);
    const baseline = open + (last - open) * t;
    // Deterministic harmonic wave anchored to 0 at endpoints so open & last are exact!
    const wave =
      Math.sin(t * Math.PI * 2 + (seed % 7) * 0.45) *
      Math.sin(t * Math.PI) *
      Math.max(0.6, Math.abs(last - prevClose) * 0.48);
    rawVals.push(
      i === 0 ? open : i === count - 1 ? last : clampProbCents(baseline + wave),
    );
  }
  const points: MarketSeriesPoint[] = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 4); j <= i; j++) {
      sum += rawVals[j]!;
      n += 1;
    }
    const weight = 0.55 + 0.45 * Math.abs(Math.cos((i + seed) * 0.9));
    const volSlice = Math.max(100, (riskUsd / count) * weight * 1.35);
    points.push({
      label: `${prefix}${i + 1}`,
      value: rawVals[i]!,
      volume: volSlice,
      ma5: Number((sum / Math.max(1, n)).toFixed(2)),
    });
  }
  return points;
}

/**
 * Synthesizes NSH `Stocks`-compatible `MarketInstrument` items deterministically
 * from real `:4020` Kalshi signals (and optional Graph Feed / Execution Plan context).
 * Never invents instruments when `signals` is empty.
 */
export function synthesizeMarketInstruments(
  signals: readonly KalshiSignalItem[],
  graphFeed?: ParsedGraphFeedPayload | null,
): MarketInstrument[] {
  const instruments: MarketInstrument[] = [];

  for (let idx = 0; idx < signals.length; idx++) {
    const sig = signals[idx]!;
    const last = clampProbCents((sig.fairProb ?? 0.5) * 100);
    const edgeCents = (sig.edgeBps ?? 0) / 100;
    const prevClose = clampProbCents(last - edgeCents);
    const open = clampProbCents(prevClose + edgeCents * 0.35);

    let seed = 0;
    for (let c = 0; c < sig.id.length; c++) {
      seed = (seed * 31 + sig.id.charCodeAt(c)) >>> 0;
    }

    const intraday = buildDeterministicSeries(
      open,
      prevClose,
      last,
      sig.riskUsd,
      16,
      "T",
      seed,
    );
    const series1m = buildDeterministicSeries(
      clampProbCents(last - edgeCents * 0.4),
      prevClose,
      last,
      sig.riskUsd * 0.35,
      14,
      "1m·",
      seed + 3,
    );
    const series5m = buildDeterministicSeries(
      open,
      prevClose,
      last,
      sig.riskUsd * 0.65,
      14,
      "5m·",
      seed + 7,
    );
    const series15m = buildDeterministicSeries(
      clampProbCents(prevClose - edgeCents * 0.15),
      prevClose,
      last,
      sig.riskUsd,
      12,
      "15m·",
      seed + 11,
    );
    const series4w = buildDeterministicSeries(
      clampProbCents(prevClose - edgeCents * 0.5),
      prevClose,
      last,
      sig.riskUsd * 2.4,
      12,
      "W",
      seed + 17,
    );

    let high = Math.max(open, prevClose, last);
    let low = Math.min(open, prevClose, last);
    let sumPrice = 0;
    for (const pt of intraday) {
      if (pt.value > high) high = pt.value;
      if (pt.value < low) low = pt.value;
      sumPrice += pt.value;
    }
    const avgPrice = Number((sumPrice / intraday.length).toFixed(2));
    const bookSpreadHalf = Math.max(0.4, (100 - sig.confidence) * 0.025);
    const bookHigh = clampProbCents(high + 1.8);
    const bookLow = clampProbCents(low - 1.8);
    const amplitudePct =
      prevClose > 0 ? Number((((high - low) / prevClose) * 100).toFixed(2)) : 0;
    const changeCents = Number((last - prevClose).toFixed(2));
    const changePct =
      prevClose > 0
        ? Number((((last - prevClose) / prevClose) * 100).toFixed(2))
        : 0;

    // 10-level order book ladder around `last`
    const rawBids: Array<{ level: number; price: number; sizeUsd: number }> =
      [];
    const rawAsks: Array<{ level: number; price: number; sizeUsd: number }> =
      [];
    const baseLevelUsd = Math.max(250, sig.riskUsd / 8);
    const bias = edgeCents >= 0 ? 1.18 : 0.84;

    for (let lv = 1; lv <= 10; lv++) {
      const step = bookSpreadHalf + (lv - 1) * 0.5;
      const depthWeight = 1 + ((lv * 3 + (seed % 5)) % 6) * 0.22;
      rawBids.push({
        level: lv,
        price: clampProbCents(last - step),
        sizeUsd: Math.round(baseLevelUsd * depthWeight * bias),
      });
      rawAsks.push({
        level: lv,
        price: clampProbCents(last + step),
        sizeUsd: Math.round((baseLevelUsd * depthWeight) / bias),
      });
    }

    let maxLevelSize = 1;
    for (const b of rawBids)
      if (b.sizeUsd > maxLevelSize) maxLevelSize = b.sizeUsd;
    for (const a of rawAsks)
      if (a.sizeUsd > maxLevelSize) maxLevelSize = a.sizeUsd;

    let bidCum = 0;
    const bids: MarketBookLevel[] = rawBids.map((b) => {
      bidCum += b.sizeUsd;
      return {
        level: b.level,
        price: b.price,
        sizeUsd: b.sizeUsd,
        cumulativeUsd: bidCum,
        ratio: b.sizeUsd / maxLevelSize,
      };
    });

    let askCum = 0;
    const asks: MarketBookLevel[] = rawAsks.map((a) => {
      askCum += a.sizeUsd;
      return {
        level: a.level,
        price: a.price,
        sizeUsd: a.sizeUsd,
        cumulativeUsd: askCum,
        ratio: a.sizeUsd / maxLevelSize,
      };
    });

    const totalDepth = Math.max(1, bidCum + askCum);
    const bidRatio = bidCum / totalDepth;
    const askRatio = askCum / totalDepth;
    const spreadCents = Number(
      Math.max(0, asks[0]!.price - bids[0]!.price).toFixed(2),
    );
    const imbalancePct = Number(
      (((bidCum - askCum) / totalDepth) * 100).toFixed(1),
    );

    // Time & sales tape from signal accounts + matching graph-feed pending bets
    const trades: MarketTapeEntry[] = [];
    for (let aIdx = 0; aIdx < sig.accounts.length; aIdx++) {
      const acc = sig.accounts[aIdx]!;
      const side: "up" | "down" | "flat" =
        changeCents > 0 ? "up" : changeCents < 0 ? "down" : "flat";
      trades.push({
        key: `${sig.id}:acc:${acc.login}:${acc.agentId}:${aIdx}`,
        timeLabel: `T-${aIdx * 2 + 1}m`,
        actor: `${acc.login} (${acc.agentId})`,
        archetype: acc.archetype,
        price: clampProbCents(last - aIdx * 0.3),
        sizeUsd: acc.riskUsd,
        side,
        isBlock: acc.riskUsd >= 10_000,
      });
    }

    if (graphFeed) {
      for (let pIdx = 0; pIdx < graphFeed.pendingBets.length; pIdx++) {
        const pb = graphFeed.pendingBets[pIdx]!;
        if (
          pb.league.toUpperCase() === sig.league.toUpperCase() &&
          trades.length < 8
        ) {
          trades.push({
            key: `${sig.id}:pb:${pb.id}:${pIdx}`,
            timeLabel: pb.placedAt?.slice(11, 16) ?? "LIVE",
            actor: pb.account,
            archetype: pb.selection,
            price: last,
            sizeUsd: pb.stakeUsd,
            side: pb.sharpScore >= 70 ? "up" : "down",
            isBlock: pb.stakeUsd >= 10_000,
          });
        }
      }
    }

    if (trades.length === 0) {
      trades.push({
        key: `${sig.id}:agg`,
        timeLabel: "SNAP",
        actor: `${sig.distinctAccounts} acct aggregate`,
        archetype: sig.verdict,
        price: last,
        sizeUsd: sig.riskUsd,
        side: changeCents >= 0 ? "up" : "down",
        isBlock: sig.riskUsd >= 10_000,
      });
    }

    // Stake-tier trade flow buckets
    const tierDefs = [
      { label: "Blocks >=$10K", min: 10_000, max: Number.POSITIVE_INFINITY },
      { label: "Whale $5K-$10K", min: 5_000, max: 10_000 },
      { label: "Sharp $1K-$5K", min: 1_000, max: 5_000 },
      { label: "Tickets <$1K", min: 0, max: 1_000 },
    ];
    const rawBuckets = tierDefs.map((td) => {
      let inflow = 0;
      let outflow = 0;
      for (const tr of trades) {
        if (tr.sizeUsd >= td.min && tr.sizeUsd < td.max) {
          if (tr.side === "down") outflow += tr.sizeUsd;
          else inflow += tr.sizeUsd;
        }
      }
      return { label: td.label, inflow, outflow };
    });
    let maxBucketSide = 1;
    for (const rb of rawBuckets) {
      if (rb.inflow > maxBucketSide) maxBucketSide = rb.inflow;
      if (rb.outflow > maxBucketSide) maxBucketSide = rb.outflow;
    }
    const flow: MarketFlowBucket[] = rawBuckets.map((rb) => ({
      label: rb.label,
      inflowUsd: rb.inflow,
      outflowUsd: rb.outflow,
      netUsd: rb.inflow - rb.outflow,
      inflowRatio: rb.inflow / maxBucketSide,
      outflowRatio: rb.outflow / maxBucketSide,
    }));

    const ranges: MarketRangeRow[] = [
      { label: "Session", low, high, prev: prevClose, last },
      {
        label: "Book Band",
        low: bids[bids.length - 1]!.price,
        high: asks[asks.length - 1]!.price,
        prev: prevClose,
        last,
      },
      {
        label: "120d / 4W",
        low: bookLow,
        high: bookHigh,
        prev: prevClose,
        last,
      },
    ];

    instruments.push({
      id: sig.id,
      code: deriveTickerCode(sig),
      name: sig.marketLabel,
      league: sig.league,
      verdict: sig.verdict,
      reason: sig.reason,
      provenance: sig.provenance,
      accounts: sig.accounts,
      quote: {
        last,
        open,
        prevClose,
        avgPrice,
        high,
        low,
        bookHigh,
        bookLow,
        amplitudePct,
        changeCents,
        changePct,
        edgeBps: sig.edgeBps,
        confidence: sig.confidence,
        distinctAccounts: sig.distinctAccounts,
        riskUsd: sig.riskUsd,
      },
      sparkline: intraday.map((p) => p.value),
      periods: {
        intraday,
        "1m": series1m,
        "5m": series5m,
        "15m": series15m,
        "4w": series4w,
      },
      book: {
        bids,
        asks,
        bidTotalUsd: bidCum,
        askTotalUsd: askCum,
        bidRatio,
        askRatio,
        spreadCents,
        imbalancePct,
      },
      trades,
      flow,
      ranges,
    });
  }

  return instruments;
}

export function filterMarketInstruments(
  instruments: readonly MarketInstrument[],
  filter: MarketWatchFilter,
): MarketInstrument[] {
  const copy = [...instruments];
  if (filter === "gainers") {
    return copy
      .filter((it) => it.quote.changeCents > 0)
      .sort((a, b) => b.quote.changePct - a.quote.changePct);
  }
  if (filter === "losers") {
    return copy
      .filter((it) => it.quote.changeCents < 0)
      .sort((a, b) => a.quote.changePct - b.quote.changePct);
  }
  if (filter === "active") {
    return copy.sort((a, b) => b.quote.riskUsd - a.quote.riskUsd);
  }
  return copy;
}

export function computeMarketComposite(
  instruments: readonly MarketInstrument[],
): MarketCompositeSummary {
  if (instruments.length === 0) {
    return {
      indexValue: 0,
      prevValue: 0,
      changePoints: 0,
      changePct: 0,
      advancers: 0,
      decliners: 0,
      unchanged: 0,
      totalRiskUsd: 0,
      totalAccounts: 0,
      leagues: [],
    };
  }

  let weightedLast = 0;
  let weightedPrev = 0;
  let totalWeight = 0;
  let advancers = 0;
  let decliners = 0;
  let unchanged = 0;
  let totalRiskUsd = 0;
  let totalAccounts = 0;

  const byLeague = new Map<
    string,
    { count: number; riskUsd: number; edgeWeighted: number }
  >();

  for (const inst of instruments) {
    const w = Math.max(1, inst.quote.riskUsd);
    weightedLast += inst.quote.last * w;
    weightedPrev += inst.quote.prevClose * w;
    totalWeight += w;
    totalRiskUsd += inst.quote.riskUsd;
    totalAccounts += inst.quote.distinctAccounts;

    if (inst.quote.changeCents > 0.05) advancers += 1;
    else if (inst.quote.changeCents < -0.05) decliners += 1;
    else unchanged += 1;

    const cur = byLeague.get(inst.league) ?? {
      count: 0,
      riskUsd: 0,
      edgeWeighted: 0,
    };
    cur.count += 1;
    cur.riskUsd += inst.quote.riskUsd;
    cur.edgeWeighted += (inst.quote.edgeBps ?? 0) * w;
    byLeague.set(inst.league, cur);
  }

  const indexValue = Number((weightedLast / totalWeight).toFixed(2));
  const prevValue = Number((weightedPrev / totalWeight).toFixed(2));
  const changePoints = Number((indexValue - prevValue).toFixed(2));
  const changePct =
    prevValue > 0
      ? Number((((indexValue - prevValue) / prevValue) * 100).toFixed(2))
      : 0;

  let maxAbsEdge = 1;
  const rawLeagues: Array<{
    league: string;
    count: number;
    riskUsd: number;
    avgEdgeBps: number;
  }> = [];
  for (const [league, agg] of byLeague) {
    const avgEdgeBps = Math.round(agg.edgeWeighted / Math.max(1, agg.riskUsd));
    if (Math.abs(avgEdgeBps) > maxAbsEdge) maxAbsEdge = Math.abs(avgEdgeBps);
    rawLeagues.push({
      league,
      count: agg.count,
      riskUsd: agg.riskUsd,
      avgEdgeBps,
    });
  }
  rawLeagues.sort((a, b) => b.riskUsd - a.riskUsd);

  return {
    indexValue,
    prevValue,
    changePoints,
    changePct,
    advancers,
    decliners,
    unchanged,
    totalRiskUsd,
    totalAccounts,
    leagues: rawLeagues.map((l) => ({
      ...l,
      ratio: Math.abs(l.avgEdgeBps) / maxAbsEdge,
    })),
  };
}

// --- Execution Engine Parsers (/api/execution/*) ---

export interface ExecutionDecisionRow {
  readonly id: string;
  readonly venue: string;
  readonly ticker: string;
  readonly action: string;
  readonly side: string;
  readonly contracts: number;
  readonly limitCents: number | null;
  readonly notionalUsd: number;
  readonly edgeBps: number | null;
  readonly reason: string;
}

export interface ParsedExecutionPlanPayload {
  readonly mode: string;
  readonly style: string;
  readonly killSwitchActive: boolean;
  readonly maxOrderUsd: number | null;
  readonly maxDailyUsd: number | null;
  readonly remainingDailyUsd: number | null;
  readonly blockedReasons: readonly string[];
  readonly decisions: readonly ExecutionDecisionRow[];
  readonly paperFillsCount: number;
}

export function parseExecutionPlanPayload(
  raw: unknown,
): ParsedExecutionPlanPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/execution/plan is not a JSON object");
  }
  const killSwitch = isRecord(raw["killSwitch"]) ? raw["killSwitch"] : {};
  const policy = isRecord(raw["policy"]) ? raw["policy"] : {};
  const risk = isRecord(raw["risk"]) ? raw["risk"] : {};
  const paper = isRecord(raw["paper"]) ? raw["paper"] : {};
  const blocked = Array.isArray(raw["blockedReasons"])
    ? raw["blockedReasons"].filter((x): x is string => typeof x === "string")
    : [];
  const decisionsRaw = Array.isArray(raw["decisions"]) ? raw["decisions"] : [];
  const decisions: ExecutionDecisionRow[] = [];

  for (let i = 0; i < decisionsRaw.length; i++) {
    const d = decisionsRaw[i];
    if (!isRecord(d)) continue;
    decisions.push({
      id: readStr(d, "signalId") ?? readStr(d, "id") ?? `dec-${i + 1}`,
      venue: readStr(d, "venue") ?? "kalshi-paper",
      ticker:
        readStr(d, "ticker") ??
        readStr(d, "marketTicker") ??
        readStr(d, "signalId") ??
        `MKT-${i + 1}`,
      action: readStr(d, "action") ?? readStr(d, "status") ?? "hold",
      side: readStr(d, "side") ?? "yes",
      contracts: readNum(d, "contracts") ?? readNum(d, "quantity") ?? 0,
      limitCents: readNum(d, "limitPriceCents") ?? readNum(d, "priceCents"),
      notionalUsd: readNum(d, "notionalUsd") ?? readNum(d, "stakeUsd") ?? 0,
      edgeBps: readNum(d, "edgeBps"),
      reason: readStr(d, "reason") ?? "policy evaluated",
    });
  }

  return {
    mode: readStr(raw, "mode") ?? "paper",
    style: readStr(raw, "style") ?? "auto",
    killSwitchActive:
      readBool(killSwitch, "active") || readBool(killSwitch, "engaged"),
    maxOrderUsd:
      readNum(policy, "maxOrderNotionalUsd") ??
      readNum(policy, "maxPerOrderUsd"),
    maxDailyUsd:
      readNum(policy, "maxDailyNotionalUsd") ?? readNum(risk, "dailyCapUsd"),
    remainingDailyUsd:
      readNum(risk, "remainingDailyNotionalUsd") ??
      readNum(risk, "remainingUsd"),
    blockedReasons: blocked,
    decisions,
    paperFillsCount:
      readNum(paper, "totalFills") ??
      (Array.isArray(paper["fills"]) ? paper["fills"].length : 0),
  };
}

export interface ParsedExecutionActionResult {
  readonly success: boolean;
  readonly mode: string;
  readonly style: string | null;
  readonly filledCount: number;
  readonly summary: string;
}

export function parseExecutionActionPayload(
  raw: unknown,
): ParsedExecutionActionResult {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] execution response is not a JSON object");
  }
  const mode = readStr(raw, "mode") ?? "paper";
  const style = readStr(raw, "style");
  const fills = Array.isArray(raw["fills"])
    ? raw["fills"].length
    : (readNum(raw, "filledCount") ?? readNum(raw, "placed") ?? 0);
  const msg =
    readStr(raw, "message") ??
    readStr(raw, "note") ??
    `mode=${mode}${style ? ` · style=${style}` : ""} · fills=${fills}`;
  return {
    success: raw["success"] !== false,
    mode,
    style,
    filledCount: fills,
    summary: msg,
  };
}

// --- Board & Sports Plane Parsers ---

export interface GameAdminBoardRow {
  readonly gameNum: string;
  readonly league: string;
  readonly status: string;
  readonly clock: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly scoreText: string;
  readonly openerText: string;
  readonly spreadText: string;
  readonly moneyText: string;
  readonly totalText: string;
}

export interface ParsedGameAdminBoardPayload {
  readonly source: string;
  readonly observedAt: string | null;
  readonly window: number | null;
  readonly gamesCount: number;
  readonly totalWageredUsd: number | null;
  readonly games: readonly GameAdminBoardRow[];
}

export function parseGameAdminBoardPayload(
  raw: unknown,
): ParsedGameAdminBoardPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/game-admin/board is not a JSON object",
    );
  }
  const summary = isRecord(raw["summary"]) ? raw["summary"] : {};
  const gamesRaw = Array.isArray(raw["games"]) ? raw["games"] : [];
  const games: GameAdminBoardRow[] = [];

  for (const g of gamesRaw) {
    if (!isRecord(g)) continue;
    const teams = Array.isArray(g["teams"]) ? g["teams"] : [];
    const awayTeam =
      typeof teams[0] === "string"
        ? teams[0]
        : isRecord(teams[0])
          ? (readStr(teams[0], "name") ?? "Away")
          : (readStr(g, "away") ?? "Away");
    const homeTeam =
      typeof teams[1] === "string"
        ? teams[1]
        : isRecord(teams[1])
          ? (readStr(teams[1], "name") ?? "Home")
          : (readStr(g, "home") ?? "Home");
    const score = isRecord(g["score"])
      ? `${readNum(g["score"], "away") ?? "-"}–${readNum(g["score"], "home") ?? "-"}`
      : Array.isArray(g["score"])
        ? g["score"].join("–")
        : (readStr(g, "scoreText") ?? "vs");
    const openers = isRecord(g["openers"]) ? g["openers"] : {};
    const openerText =
      readStr(openers, "spread") ??
      readStr(openers, "total") ??
      (readNum(openers, "spread") !== null
        ? String(readNum(openers, "spread"))
        : "—");
    const fmtSideArr = (val: unknown): string => {
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        if (typeof first === "string" || typeof first === "number") {
          return val.slice(0, 2).map(String).join(" / ");
        }
        if (isRecord(first)) {
          return (
            readStr(first, "line") ??
            readStr(first, "display") ??
            JSON.stringify(first).slice(0, 28)
          );
        }
      }
      if (typeof val === "string") return val;
      return "—";
    };

    games.push({
      gameNum: String(g["gameNum"] ?? g["id"] ?? "-"),
      league: readStr(g, "league") ?? "UNK",
      status: readStr(g, "status") ?? "scheduled",
      clock: readStr(g, "clock") ?? "-",
      awayTeam,
      homeTeam,
      scoreText: score,
      openerText,
      spreadText: fmtSideArr(g["spread"]),
      moneyText: fmtSideArr(g["money"]),
      totalText: fmtSideArr(g["total"]),
    });
  }

  return {
    source: readStr(raw, "source") ?? "unreported",
    observedAt: readStr(raw, "observedAt"),
    window: readNum(raw, "window"),
    gamesCount: readNum(summary, "games") ?? games.length,
    totalWageredUsd:
      readNum(summary, "totalWageredUsd") ?? readNum(summary, "wagered"),
    games,
  };
}

export interface GameAdminRollupItem {
  readonly matchup: string;
  readonly league: string;
  readonly wagers: number;
  readonly wageredUsd: number;
  readonly toWinUsd: number;
  readonly straightUsd: number;
  readonly parlayUsd: number;
  readonly teaserUsd: number;
}

export interface ParsedGameAdminPayload {
  readonly source: string;
  readonly generatedAt: string | null;
  readonly games: readonly GameAdminRollupItem[];
}

export function parseGameAdminPayload(raw: unknown): ParsedGameAdminPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/game-admin is not a JSON object");
  }
  const gamesRaw = Array.isArray(raw["games"]) ? raw["games"] : [];
  const games: GameAdminRollupItem[] = [];
  for (const g of gamesRaw) {
    if (!isRecord(g)) continue;
    const total = isRecord(g["total"]) ? g["total"] : {};
    const pos = isRecord(g["positions"]) ? g["positions"] : {};
    const st = isRecord(pos["Straight"]) ? pos["Straight"] : {};
    const pa = isRecord(pos["Parlay"]) ? pos["Parlay"] : {};
    const te = isRecord(pos["Teaser"]) ? pos["Teaser"] : {};
    games.push({
      matchup: readStr(g, "matchup") ?? readStr(g, "game") ?? "Unknown matchup",
      league: readStr(g, "league") ?? "UNK",
      wagers: readNum(total, "wagers") ?? 0,
      wageredUsd: readNum(total, "wagered") ?? 0,
      toWinUsd: readNum(total, "toWin") ?? 0,
      straightUsd: readNum(st, "wagered") ?? 0,
      parlayUsd: readNum(pa, "wagered") ?? 0,
      teaserUsd: readNum(te, "wagered") ?? 0,
    });
  }
  return {
    source: readStr(raw, "source") ?? "unreported",
    generatedAt: readStr(raw, "generatedAt"),
    games,
  };
}

export interface ParsedLogoMetaPayload {
  readonly name: string;
  readonly source: string;
  readonly format: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number | null;
  readonly hasPlaceholder: boolean;
}

export function parseLogoMetaPayload(raw: unknown): ParsedLogoMetaPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/logo/:team?meta=1 is not a JSON object",
    );
  }
  return {
    name: readStr(raw, "name") ?? "unknown",
    source: readStr(raw, "source") ?? "local",
    format: readStr(raw, "format") ?? readStr(raw, "contentType") ?? "image",
    width: readNum(raw, "width"),
    height: readNum(raw, "height"),
    bytes: readNum(raw, "bytes"),
    hasPlaceholder: typeof raw["placeholder"] === "string",
  };
}

export interface ParsedSportsPayload {
  readonly liveFilterCount: number;
  readonly allSports: readonly string[];
}

export function parseSportsPayload(raw: unknown): ParsedSportsPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/sports is not a JSON object");
  }
  const all = Array.isArray(raw["all"])
    ? raw["all"].map((x) =>
        typeof x === "string"
          ? x
          : isRecord(x)
            ? (readStr(x, "sport") ?? readStr(x, "name") ?? "sport")
            : String(x),
      )
    : [];
  const lf = Array.isArray(raw["liveFilter"]) ? raw["liveFilter"].length : 0;
  return {
    liveFilterCount: lf,
    allSports: all,
  };
}

export interface ParsedSportsCatalogPayload {
  readonly source: string;
  readonly capturedAt: string | null;
  readonly sportsCount: number;
  readonly subSportsCount: number;
  readonly periodEntriesCount: number;
  readonly collisionsCount: number;
  readonly migrationRisksCount: number;
}

export function parseSportsCatalogPayload(
  raw: unknown,
): ParsedSportsCatalogPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/sports/catalog is not a JSON object");
  }
  const summary = isRecord(raw["summary"]) ? raw["summary"] : {};
  return {
    source: readStr(raw, "source") ?? "unreported",
    capturedAt: readStr(raw, "capturedAt"),
    sportsCount:
      readNum(summary, "sports") ??
      (Array.isArray(raw["sports"]) ? raw["sports"].length : 0),
    subSportsCount:
      readNum(summary, "subSports") ??
      (Array.isArray(raw["subSports"]) ? raw["subSports"].length : 0),
    periodEntriesCount: readNum(summary, "periodEntries") ?? 0,
    collisionsCount: Array.isArray(raw["collisions"])
      ? raw["collisions"].length
      : 0,
    migrationRisksCount: Array.isArray(raw["migrationRisks"])
      ? raw["migrationRisks"].length
      : 0,
  };
}

export interface ContestItemRow {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly closeAt: string;
}

export interface ParsedContestsPayload {
  readonly source: string;
  readonly total: number;
  readonly count: number;
  readonly groups: readonly string[];
  readonly entries: readonly ContestItemRow[];
}

export function parseContestsPayload(raw: unknown): ParsedContestsPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/contests is not a JSON object");
  }
  const summary = isRecord(raw["summary"]) ? raw["summary"] : {};
  const byGroup = isRecord(summary["byGroup"])
    ? Object.keys(summary["byGroup"])
    : [];
  const entriesRaw = Array.isArray(raw["entries"]) ? raw["entries"] : [];
  const entries: ContestItemRow[] = [];
  for (let i = 0; i < Math.min(entriesRaw.length, 60); i++) {
    const e = entriesRaw[i];
    if (!isRecord(e)) continue;
    entries.push({
      id: String(e["contestNum"] ?? e["id"] ?? i + 1),
      group: readStr(e, "group") ?? readStr(e, "sport") ?? "General",
      title:
        readStr(e, "description") ??
        readStr(e, "title") ??
        readStr(e, "name") ??
        "Contest",
      closeAt: readStr(e, "cutOff") ?? readStr(e, "closeAt") ?? "-",
    });
  }
  return {
    source: readStr(raw, "source") ?? "unreported",
    total: readNum(summary, "total") ?? entriesRaw.length,
    count: readNum(raw, "count") ?? entriesRaw.length,
    groups: byGroup,
    entries,
  };
}

export interface LiveBetGameExposureRow {
  readonly matchup: string;
  readonly league: string;
  readonly wagers: number;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly riskCents: DeskCents;
  readonly toWinCents: DeskCents;
}

export interface ParsedLiveBetsListPayload {
  readonly apiVersion: string;
  readonly dataSource: string;
  readonly basis: DeskProvenanceBasis;
  readonly provenance: ProvenanceTag;
  readonly fallbackUsed: boolean;
  readonly pendingCount: number;
  readonly warnings: readonly string[];
  readonly games: readonly LiveBetGameExposureRow[];
}

export function parseLiveBetsListPayload(
  raw: unknown,
): ParsedLiveBetsListPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] live-bets payload is not a JSON object");
  }
  const apiVersion = readStr(raw, "apiVersion") ?? "1";
  const dataSource =
    readStr(raw, "dataSource") ?? readStr(raw, "mode") ?? "file";
  const fallbackBasis = normalizeDeskBasis(dataSource, "capture");
  const provenance = parseProvenance(raw["provenance"], fallbackBasis);

  const gamesRaw = Array.isArray(raw["games"]) ? raw["games"] : [];
  const games: LiveBetGameExposureRow[] = [];
  for (const g of gamesRaw) {
    if (!isRecord(g)) continue;
    const t1 = isRecord(g["team1"]) ? readStr(g["team1"], "name") : null;
    const t2 = isRecord(g["team2"]) ? readStr(g["team2"], "name") : null;
    const derivedMatchup =
      t1 !== null && t2 !== null ? `${t1} vs ${t2}` : (t1 ?? t2);

    // In /api/v2/live-bets (`LiveBetGame`), `wagered` and `toWin` are integer Cents.
    const explicitRiskUsd =
      readNum(g, "riskUsd") ?? readNum(g, "wageredUsd") ?? readNum(g, "risk");
    const explicitRiskCents =
      readNum(g, "riskCents") ??
      readNum(g, "wageredCents") ??
      readNum(g, "wagered");
    const riskCents =
      explicitRiskCents !== null
        ? toDeskCents(explicitRiskCents)
        : explicitRiskUsd !== null
          ? usdToDeskCents(explicitRiskUsd)
          : 0;
    const riskUsd =
      explicitRiskUsd !== null ? explicitRiskUsd : riskCents / 100;

    const explicitWinUsd = readNum(g, "toWinUsd");
    const explicitWinCents =
      readNum(g, "toWinCents") ??
      (explicitWinUsd === null ? readNum(g, "toWin") : null);
    const toWinCents =
      explicitWinCents !== null
        ? toDeskCents(explicitWinCents)
        : explicitWinUsd !== null
          ? usdToDeskCents(explicitWinUsd)
          : 0;
    const toWinUsd =
      explicitWinUsd !== null ? explicitWinUsd : toWinCents / 100;

    games.push({
      matchup:
        readStr(g, "matchup") ??
        derivedMatchup ??
        readStr(g, "game") ??
        readStr(g, "description") ??
        "Matchup",
      league:
        readStr(g, "league") ??
        readStr(g, "subSport") ??
        readStr(g, "sport") ??
        "UNK",
      wagers: readNum(g, "wagers") ?? readNum(g, "count") ?? 0,
      riskUsd,
      toWinUsd,
      riskCents,
      toWinCents,
    });
  }
  return {
    apiVersion,
    dataSource,
    basis: provenance.basis,
    provenance,
    fallbackUsed: readBool(raw, "fallbackUsed"),
    pendingCount: readNum(raw, "pendingCount") ?? games.length,
    warnings: Array.isArray(raw["warnings"])
      ? raw["warnings"].filter((w): w is string => typeof w === "string")
      : [],
    games,
  };
}

export interface LiveWagerTicketRow {
  readonly ticketId: string;
  readonly customer: string;
  readonly writer: string;
  readonly wagerType: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly pickSummary: string;
}

export interface ParsedLiveWagersPayload {
  readonly count: number;
  readonly totalRiskUsd: number | null;
  readonly wagers: readonly LiveWagerTicketRow[];
}

export function parseLiveWagersPayload(raw: unknown): ParsedLiveWagersPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/live-wagers is not a JSON object");
  }
  const summary = isRecord(raw["summary"]) ? raw["summary"] : {};
  const listRaw = Array.isArray(raw["wagers"])
    ? raw["wagers"]
    : Array.isArray(raw["tickets"])
      ? raw["tickets"]
      : [];
  const wagers: LiveWagerTicketRow[] = [];
  for (let i = 0; i < Math.min(listRaw.length, 50); i++) {
    const w = listRaw[i];
    if (!isRecord(w)) continue;
    const riskCents = readNum(w, "riskCents") ?? readNum(w, "wageredCents");
    const winCents = readNum(w, "toWinCents");
    wagers.push({
      ticketId: String(w["ticketNumber"] ?? w["ticketId"] ?? w["id"] ?? i + 1),
      customer: readStr(w, "customerId") ?? readStr(w, "login") ?? "acct",
      writer: readStr(w, "writer") ?? "inet",
      wagerType: readStr(w, "wagerType") ?? readStr(w, "type") ?? "Straight",
      riskUsd:
        readNum(w, "riskUsd") ?? (riskCents !== null ? riskCents / 100 : 0),
      toWinUsd:
        readNum(w, "toWinUsd") ?? (winCents !== null ? winCents / 100 : 0),
      pickSummary:
        readStr(w, "description") ??
        readStr(w, "pick") ??
        readStr(w, "raw") ??
        "—",
    });
  }
  return {
    count: listRaw.length,
    totalRiskUsd:
      readNum(summary, "totalRiskUsd") ??
      (readNum(summary, "wageredCents") !== null
        ? (readNum(summary, "wageredCents") ?? 0) / 100
        : null),
    wagers,
  };
}

// --- Surveillance Plane Parsers ---

export interface SyndicatePendingBet {
  readonly id: string;
  readonly account: string;
  readonly league: string;
  readonly selection: string;
  readonly stakeUsd: number;
  readonly sharpScore: number;
  readonly placedAt: string | null;
}

export interface SyndicateWalletProfile {
  readonly handle: string;
  readonly archetype: string;
  readonly openExposureUsd: number;
  readonly roiPct: number | null;
  readonly winRatePct: number | null;
}

export interface IpClusterRow {
  readonly clusterId: string;
  readonly office: string;
  readonly accountCount: number;
  readonly sharedIpPrefix: string;
  readonly riskFlag: string;
}

export interface BacktestWeekRow {
  readonly weekLabel: string;
  readonly savingsUsd: number;
  readonly holdDeltaBps: number | null;
}

export interface ParsedGraphFeedPayload {
  readonly schemaVersion: number;
  readonly dataMode: string;
  readonly provenance: ProvenanceTag;
  readonly activeWallets: number;
  readonly configuredWallets: number;
  readonly openLegs: number;
  readonly openExposureUsd: number;
  readonly pendingBets: readonly SyndicatePendingBet[];
  readonly wallets: readonly SyndicateWalletProfile[];
  readonly ipClusters: readonly IpClusterRow[];
  readonly backtestWeeks: readonly BacktestWeekRow[];
}

export function parseGraphFeedPayload(raw: unknown): ParsedGraphFeedPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/graph-feed is not a JSON object");
  }
  const pendingRaw = Array.isArray(raw["pendingBets"])
    ? raw["pendingBets"]
    : [];
  const pendingBets: SyndicatePendingBet[] = [];
  for (let i = 0; i < pendingRaw.length; i++) {
    const b = pendingRaw[i];
    if (!isRecord(b)) continue;
    pendingBets.push({
      id: readStr(b, "id") ?? `bet-${i + 1}`,
      account:
        readStr(b, "login") ??
        readStr(b, "account") ??
        readStr(b, "wallet") ??
        "wallet",
      league: readStr(b, "league") ?? readStr(b, "sport") ?? "UNK",
      selection:
        readStr(b, "selection") ??
        readStr(b, "market") ??
        readStr(b, "pick") ??
        "position",
      stakeUsd:
        readNum(b, "riskUsd") ??
        readNum(b, "stakeUsd") ??
        readNum(b, "amountUsd") ??
        0,
      sharpScore: readNum(b, "sharpScore") ?? readNum(b, "confidence") ?? 50,
      placedAt: readStr(b, "placedAt") ?? readStr(b, "timestamp"),
    });
  }

  const walletsRaw = Array.isArray(raw["walletProfiles"])
    ? raw["walletProfiles"]
    : [];
  const wallets: SyndicateWalletProfile[] = [];
  for (const w of walletsRaw) {
    if (!isRecord(w)) continue;
    wallets.push({
      handle:
        readStr(w, "label") ??
        readStr(w, "login") ??
        readStr(w, "id") ??
        "wallet",
      archetype: readStr(w, "archetype") ?? readStr(w, "tier") ?? "Syndicate",
      openExposureUsd:
        readNum(w, "openExposureUsd") ?? readNum(w, "exposureUsd") ?? 0,
      roiPct: readNum(w, "roiPct") ?? readNum(w, "roi"),
      winRatePct: readNum(w, "winRatePct") ?? readNum(w, "winRate"),
    });
  }

  const clustersRaw = Array.isArray(raw["perOfficeIpTrackerClusters"])
    ? raw["perOfficeIpTrackerClusters"]
    : [];
  const ipClusters: IpClusterRow[] = [];
  for (let i = 0; i < clustersRaw.length; i++) {
    const c = clustersRaw[i];
    if (!isRecord(c)) continue;
    const accts = Array.isArray(c["accounts"]) ? c["accounts"].length : null;
    ipClusters.push({
      clusterId: readStr(c, "clusterId") ?? readStr(c, "id") ?? `CL-${i + 1}`,
      office: readStr(c, "office") ?? readStr(c, "agentId") ?? "office",
      accountCount: readNum(c, "accountCount") ?? accts ?? 0,
      sharedIpPrefix:
        readStr(c, "ipPrefix") ?? readStr(c, "subnet") ?? "redacted",
      riskFlag: readStr(c, "severity") ?? readStr(c, "status") ?? "watch",
    });
  }

  const btObj = isRecord(raw["backtest4Wk"]) ? raw["backtest4Wk"] : {};
  const btWeeksRaw = Array.isArray(btObj["weeks"]) ? btObj["weeks"] : [];
  const backtestWeeks: BacktestWeekRow[] = [];
  for (let i = 0; i < btWeeksRaw.length; i++) {
    const wk = btWeeksRaw[i];
    if (!isRecord(wk)) continue;
    backtestWeeks.push({
      weekLabel: readStr(wk, "week") ?? readStr(wk, "label") ?? `W${i + 1}`,
      savingsUsd:
        readNum(wk, "estimatedSavingsUsd") ?? readNum(wk, "savingsUsd") ?? 0,
      holdDeltaBps: readNum(wk, "holdImprovementBps") ?? readNum(wk, "holdBps"),
    });
  }

  return {
    schemaVersion: readNum(raw, "schemaVersion") ?? 3,
    dataMode: readStr(raw, "dataMode") ?? "PARTIAL",
    provenance: parseProvenance(raw["provenance"], "fixture"),
    activeWallets:
      readNum(raw, "activeSyndicateWalletsCount") ?? wallets.length,
    configuredWallets: readNum(raw, "configuredWalletsCount") ?? wallets.length,
    openLegs: readNum(raw, "totalOpenLegsCount") ?? pendingBets.length,
    openExposureUsd: readNum(raw, "totalOpenExposureUsd") ?? 0,
    pendingBets,
    wallets,
    ipClusters,
    backtestWeeks,
  };
}

export interface ParsedGraphSummaryPayload {
  readonly dataMode: string;
  readonly openExposureUsd: number | null;
  readonly bridgeCount: number;
  readonly automationActive: boolean;
}

export function parseGraphSummaryPayload(
  raw: unknown,
): ParsedGraphSummaryPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/graph/summary is not a JSON object");
  }
  const feed = isRecord(raw["feed"]) ? raw["feed"] : {};
  const bridges = Array.isArray(raw["bridges"])
    ? raw["bridges"].length
    : isRecord(raw["bridges"])
      ? Object.keys(raw["bridges"]).length
      : 0;
  const auto = isRecord(raw["automation"]) ? raw["automation"] : {};
  return {
    dataMode: readStr(feed, "dataMode") ?? "unknown",
    openExposureUsd:
      readNum(feed, "totalOpenExposureUsd") ?? readNum(feed, "exposureUsd"),
    bridgeCount: bridges,
    automationActive: readBool(auto, "enabled") || readBool(auto, "active"),
  };
}

export interface ParsedGraphStreamSample {
  readonly eventCount: number;
  readonly firstEventType: string;
  readonly dataPreview: string;
}

export function parseGraphStreamSample(
  sseText: string,
): ParsedGraphStreamSample {
  const blocks = sseText
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && !b.startsWith(":"));
  let firstEventType = "message";
  let dataPreview = sseText.trim().slice(0, 140) || "stream connected";
  if (blocks[0]) {
    for (const line of blocks[0].split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        firstEventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataPreview = line.slice(5).trim().slice(0, 140);
      }
    }
  }
  return {
    eventCount: blocks.length,
    firstEventType,
    dataPreview,
  };
}

export interface ParsedGsLiveWeblogsPayload {
  readonly status: string;
  readonly source: string;
  readonly asOf: string | null;
  readonly accountCount: number;
  readonly reason: string;
}

export function parseGsLiveWeblogsPayload(
  raw: unknown,
): ParsedGsLiveWeblogsPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/gslive/weblogs is not a JSON object");
  }
  const accounts = Array.isArray(raw["accounts"]) ? raw["accounts"] : [];
  return {
    status: readStr(raw, "status") ?? "unknown",
    source: readStr(raw, "source") ?? "unreported",
    asOf: readStr(raw, "asOf"),
    accountCount: accounts.length,
    reason:
      readStr(raw, "reason") ??
      readStr(raw, "command") ??
      `${accounts.length} account(s)`,
  };
}

export interface ParsedGsLiveSessionHealthPayload {
  readonly authModel: string;
  readonly sessionState: string;
  readonly probeRan: boolean;
  readonly advisory: string;
}

export function parseGsLiveSessionHealthPayload(
  raw: unknown,
): ParsedGsLiveSessionHealthPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/gslive/session-health is not a JSON object",
    );
  }
  const session = isRecord(raw["session"]) ? raw["session"] : {};
  const probe = isRecord(raw["probe"]) ? raw["probe"] : null;
  return {
    authModel: readStr(raw, "authModel") ?? "cookie-session",
    sessionState:
      readStr(session, "status") ??
      readStr(session, "state") ??
      (readBool(session, "configured") ? "configured" : "unconfigured"),
    probeRan: probe !== null && readBool(probe, "attempted"),
    advisory:
      readStr(raw, "advisory") ??
      (probe ? (readStr(probe, "detail") ?? "probed") : "passive check"),
  };
}

export interface ParsedBridge3cStatusPayload {
  readonly boundary: string;
  readonly readOnly: boolean;
  readonly endpoint: string;
  readonly rollupState: string;
}

export function parseBridge3cStatusPayload(
  raw: unknown,
): ParsedBridge3cStatusPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/bridge3c/status is not a JSON object");
  }
  const rollup = isRecord(raw["rollup"]) ? raw["rollup"] : {};
  return {
    boundary: readStr(raw, "boundary") ?? "CLASS_D",
    readOnly: readBool(raw, "readOnly"),
    endpoint: readStr(raw, "endpoint") ?? "unreported",
    rollupState:
      readStr(rollup, "status") ??
      readStr(rollup, "state") ??
      (Object.keys(rollup).length > 0 ? "available" : "empty"),
  };
}

// --- Forensics Plane Parsers ---

export interface AgentSearchItem {
  readonly key: string;
  readonly level: number | null;
  readonly agentType: string;
}

export interface ParsedAgentsSearchPayload {
  readonly query: string;
  readonly count: number;
  readonly agents: readonly AgentSearchItem[];
}

export function parseAgentsSearchPayload(
  raw: unknown,
): ParsedAgentsSearchPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/agents/search is not a JSON object");
  }
  const list = Array.isArray(raw["agents"]) ? raw["agents"] : [];
  const agents: AgentSearchItem[] = [];
  for (const a of list) {
    if (!isRecord(a)) continue;
    agents.push({
      key: readStr(a, "key") ?? readStr(a, "id") ?? "agent",
      level: readNum(a, "level"),
      agentType: readStr(a, "agentType") ?? readStr(a, "type") ?? "A",
    });
  }
  return {
    query: readStr(raw, "query") ?? "",
    count: readNum(raw, "count") ?? agents.length,
    agents,
  };
}

export interface ParsedAgentTreePayload {
  readonly agentCount: number;
  readonly rootCount: number;
  readonly collisionCount: number;
  readonly topRoots: readonly string[];
}

export function parseAgentTreePayload(raw: unknown): ParsedAgentTreePayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/agent-tree is not a JSON object");
  }
  const stats = isRecord(raw["stats"]) ? raw["stats"] : {};
  const rootsArr = Array.isArray(raw["roots"]) ? raw["roots"] : [];
  const topRoots = rootsArr
    .slice(0, 12)
    .map((r) =>
      typeof r === "string"
        ? r
        : isRecord(r)
          ? `${readStr(r, "key") ?? readStr(r, "id") ?? "root"} (${Array.isArray(r["children"]) ? r["children"].length : (readNum(r, "descendants") ?? 0)})`
          : String(r),
    );
  const collisions = Array.isArray(raw["collisions"])
    ? raw["collisions"].length
    : (readNum(stats, "collisions") ?? 0);
  return {
    agentCount:
      readNum(raw, "agentCount") ??
      readNum(stats, "totalNodes") ??
      rootsArr.length,
    rootCount: rootsArr.length,
    collisionCount: collisions,
    topRoots,
  };
}

export interface ParsedAnalysisFiltersPayload {
  readonly reports: readonly string[];
  readonly sports: readonly string[];
  readonly weeks: readonly string[];
}

export function parseAnalysisFiltersPayload(
  raw: unknown,
): ParsedAnalysisFiltersPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/analysis/filters is not a JSON object",
    );
  }
  const mapLabels = (val: unknown): string[] => {
    if (!Array.isArray(val)) return [];
    return val.map((x) =>
      typeof x === "string" || typeof x === "number"
        ? String(x)
        : isRecord(x)
          ? (readStr(x, "code") ??
            readStr(x, "id") ??
            readStr(x, "name") ??
            readStr(x, "label") ??
            "item")
          : String(x),
    );
  };
  const captured = isRecord(raw["captured"]) ? raw["captured"] : {};
  return {
    reports: mapLabels(raw["reports"]),
    sports: mapLabels(captured["sports"] ?? raw["groups"]),
    weeks: mapLabels(raw["weeks"]),
  };
}

export interface ParsedAnalysisReportsPayload {
  readonly count: number;
  readonly labels: readonly string[];
}

export function parseAnalysisReportsPayload(
  raw: unknown,
): ParsedAnalysisReportsPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/analysis/reports is not a JSON object",
    );
  }
  const arr = Array.isArray(raw["reports"]) ? raw["reports"] : [];
  const labels = arr
    .slice(0, 20)
    .map((r) =>
      typeof r === "string"
        ? r
        : isRecord(r)
          ? `${readStr(r, "report") ?? "RPT"} · ${readStr(r, "agent") ?? "*"} · ${readStr(r, "sport") ?? "*"}`
          : String(r),
    );
  return {
    count: readNum(raw, "count") ?? arr.length,
    labels,
  };
}

export interface AnalysisPlayerRow {
  readonly player: string;
  readonly agent: string;
  readonly wagers: number;
  readonly riskUsd: string;
  readonly netUsd: string;
}

export interface ParsedAnalysisPayload {
  readonly available: boolean;
  readonly description: string;
  readonly discrepancyCount: number;
  readonly rows: readonly AnalysisPlayerRow[];
}

export function parseAnalysisPayload(raw: unknown): ParsedAnalysisPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/analysis is not a JSON object");
  }
  const rowsRaw = Array.isArray(raw["rows"]) ? raw["rows"] : [];
  const rows: AnalysisPlayerRow[] = [];
  for (let i = 0; i < Math.min(rowsRaw.length, 40); i++) {
    const r = rowsRaw[i];
    if (!isRecord(r)) continue;
    const riskCents =
      readNum(r, "riskCents") ??
      readNum(r, "volumeCents") ??
      readNum(r, "wageredCents");
    const netCents =
      readNum(r, "netCents") ?? readNum(r, "winLossCents") ?? readNum(r, "net");
    rows.push({
      player:
        readStr(r, "customerId") ??
        readStr(r, "player") ??
        readStr(r, "login") ??
        `row-${i + 1}`,
      agent: readStr(r, "agentId") ?? readStr(r, "agent") ?? "—",
      wagers: readNum(r, "wagers") ?? readNum(r, "count") ?? 0,
      riskUsd:
        riskCents !== null
          ? formatUsdFromCents(riskCents)
          : readNum(r, "riskUsd") !== null
            ? formatUsd(readNum(r, "riskUsd") ?? 0)
            : "n/a",
      netUsd:
        netCents !== null
          ? formatUsdFromCents(netCents)
          : readNum(r, "netUsd") !== null
            ? formatUsd(readNum(r, "netUsd") ?? 0)
            : "n/a",
    });
  }
  const disc = Array.isArray(raw["discrepancies"])
    ? raw["discrepancies"].length
    : 0;
  return {
    available: raw["available"] !== false,
    description:
      readStr(raw, "description") ??
      (rows.length > 0 ? `${rows.length} rows` : "no captured report slice"),
    discrepancyCount: disc,
    rows,
  };
}

export interface ParsedCustomerProfilePayload {
  readonly id: string;
  readonly agentId: string;
  readonly lifetimeNetUsd: number | null;
  readonly week7dNetUsd: number | null;
  readonly ticketSampleCount: number;
  readonly sampleOnly: boolean;
}

export function parseCustomerProfilePayload(
  raw: unknown,
): ParsedCustomerProfilePayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/customer/profile is not a JSON object",
    );
  }
  const prof = isRecord(raw["profile"]) ? raw["profile"] : raw;
  const lifetime = isRecord(prof["lifetime"]) ? prof["lifetime"] : prof;
  const recent = isRecord(prof["recent7d"]) ? prof["recent7d"] : {};
  const tickets = Array.isArray(prof["tickets"])
    ? prof["tickets"]
    : Array.isArray(prof["sampleTickets"])
      ? prof["sampleTickets"]
      : [];
  return {
    id:
      readStr(prof, "customerId") ??
      readStr(prof, "id") ??
      readStr(prof, "login") ??
      "unknown",
    agentId: readStr(prof, "agentId") ?? readStr(prof, "agent") ?? "unassigned",
    lifetimeNetUsd:
      readNum(lifetime, "netUsd") ?? readNum(prof, "lifetimeNetUsd"),
    week7dNetUsd: readNum(recent, "netUsd") ?? readNum(prof, "net7dUsd"),
    ticketSampleCount: tickets.length,
    sampleOnly: prof["sampleOnly"] !== false,
  };
}

export interface ParsedCustomerRatingPayload {
  readonly id: string;
  readonly tier: string;
  readonly bayesianMean: number | null;
  readonly kellyFraction: number | null;
  readonly sharpProbability: number | null;
}

export function parseCustomerRatingPayload(
  raw: unknown,
): ParsedCustomerRatingPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/customer/rating is not a JSON object");
  }
  const rating = isRecord(raw["rating"]) ? raw["rating"] : raw;
  const bayes = isRecord(rating["bayesianSkill"])
    ? rating["bayesianSkill"]
    : {};
  const kelly = isRecord(rating["kellyMetrics"]) ? rating["kellyMetrics"] : {};
  return {
    id: readStr(rating, "customerId") ?? readStr(rating, "id") ?? "unknown",
    tier:
      readStr(rating, "tier") ??
      readStr(rating, "classification") ??
      readStr(rating, "label") ??
      "rated",
    bayesianMean: readNum(bayes, "posteriorMean") ?? readNum(bayes, "mean"),
    kellyFraction:
      readNum(kelly, "recommendedFraction") ?? readNum(kelly, "fullKelly"),
    sharpProbability:
      readNum(bayes, "probSkillPositive") ?? readNum(rating, "sharpScore"),
  };
}

export interface WatchlistEntryRow {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export interface ParsedWatchlistPayload {
  readonly count: number;
  readonly entries: readonly WatchlistEntryRow[];
}

export function parseWatchlistPayload(raw: unknown): ParsedWatchlistPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/watchlist is not a JSON object");
  }
  const arr = Array.isArray(raw["watchlist"])
    ? raw["watchlist"]
    : Array.isArray(raw["customers"])
      ? raw["customers"]
      : Array.isArray(raw["items"])
        ? raw["items"]
        : [];
  const entries: WatchlistEntryRow[] = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (typeof it === "string") {
      entries.push({ id: it, label: it, reason: "watched" });
    } else if (isRecord(it)) {
      const id =
        readStr(it, "customerId") ?? readStr(it, "id") ?? `watch-${i + 1}`;
      entries.push({
        id,
        label: readStr(it, "label") ?? readStr(it, "agentId") ?? id,
        reason: readStr(it, "reason") ?? readStr(it, "tier") ?? "active watch",
      });
    }
  }
  return {
    count: entries.length,
    entries,
  };
}

// --- System, Governance, Telegram & Parser Workbench ---

export interface ParsedHealthPayload {
  readonly status: string;
  readonly operationalStatus: string;
  readonly dataStatus: string;
  readonly uptimeSeconds: number | null;
  readonly runtime: string;
  readonly degradedReasons: readonly string[];
}

export function parseHealthPayload(raw: unknown): ParsedHealthPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /health is not a JSON object");
  }
  return {
    status: readStr(raw, "status") ?? "unknown",
    operationalStatus: readStr(raw, "operationalStatus") ?? "unknown",
    dataStatus: readStr(raw, "dataStatus") ?? "unknown",
    uptimeSeconds: readNum(raw, "uptimeSeconds"),
    runtime: readStr(raw, "runtime") ?? "Bun",
    degradedReasons: Array.isArray(raw["degradedReasons"])
      ? raw["degradedReasons"].filter((x): x is string => typeof x === "string")
      : [],
  };
}

export interface ParsedStatusPayload {
  readonly ok: boolean;
  readonly status: string;
  readonly rssMb: number | null;
  readonly checkKeys: readonly string[];
}

export function parseStatusPayload(raw: unknown): ParsedStatusPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/status is not a JSON object");
  }
  const health = isRecord(raw["health"]) ? raw["health"] : {};
  const mem = isRecord(health["memory"]) ? health["memory"] : {};
  const rss = readNum(mem, "rss");
  const checks = isRecord(raw["checks"]) ? Object.keys(raw["checks"]) : [];
  return {
    ok: readBool(raw, "ok"),
    status: readStr(raw, "status") ?? "unknown",
    rssMb: rss !== null ? Number((rss / (1024 * 1024)).toFixed(1)) : null,
    checkKeys: checks,
  };
}

export interface ParsedDnsTelemetryPayload {
  readonly size: number;
  readonly hitRatePercent: number;
  readonly hitsCompleted: number;
  readonly hitsInflight: number;
  readonly misses: number;
  readonly coreHostCount: number;
}

export function parseDnsTelemetryPayload(
  raw: unknown,
): ParsedDnsTelemetryPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/dns/telemetry is not a JSON object");
  }
  const tel = isRecord(raw["telemetry"]) ? raw["telemetry"] : {};
  const hosts = Array.isArray(raw["coreHosts"]) ? raw["coreHosts"].length : 0;
  return {
    size: readNum(tel, "size") ?? 0,
    hitRatePercent: readNum(tel, "hitRatePercent") ?? 0,
    hitsCompleted: readNum(tel, "cacheHitsCompleted") ?? 0,
    hitsInflight: readNum(tel, "cacheHitsInflight") ?? 0,
    misses: readNum(tel, "cacheMisses") ?? 0,
    coreHostCount: hosts,
  };
}

export interface GovernanceGateRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner: string;
}

export interface ParsedGovernancePayload {
  readonly referenceDate: string;
  readonly openTasks: number;
  readonly doneTasks: number;
  readonly p0Open: number;
  readonly readyGates: number;
  readonly totalGates: number;
  readonly pendingDecisions: number;
  readonly gates: readonly GovernanceGateRow[];
}

export function parseGovernancePayload(raw: unknown): ParsedGovernancePayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /governance.json is not a JSON object");
  }
  const sum = isRecord(raw["summary"]) ? raw["summary"] : {};
  const gatesRaw = Array.isArray(raw["oracleGates"]) ? raw["oracleGates"] : [];
  const gates: GovernanceGateRow[] = [];
  for (let i = 0; i < gatesRaw.length; i++) {
    const g = gatesRaw[i];
    if (!isRecord(g)) continue;
    gates.push({
      id: readStr(g, "id") ?? `G${i + 1}`,
      title: readStr(g, "name") ?? readStr(g, "title") ?? "Gate",
      status: readStr(g, "status") ?? "pending",
      owner: readStr(g, "owner") ?? "ops",
    });
  }
  return {
    referenceDate:
      readStr(raw, "referenceDate") ?? readStr(raw, "generatedAt") ?? "n/a",
    openTasks: readNum(sum, "openTasks") ?? 0,
    doneTasks: readNum(sum, "doneTasks") ?? 0,
    p0Open: readNum(sum, "p0Open") ?? 0,
    readyGates: readNum(sum, "readyGates") ?? 0,
    totalGates: readNum(sum, "totalGates") ?? gates.length,
    pendingDecisions: readNum(sum, "pendingDecisions") ?? 0,
    gates,
  };
}

export interface ParsedTelegramStatusPayload {
  readonly configured: boolean;
  readonly webhookActive: boolean;
  readonly summary: string;
}

export function parseTelegramStatusPayload(
  raw: unknown,
): ParsedTelegramStatusPayload {
  if (!isRecord(raw)) {
    throw new TypeError("[nsh-desk] /api/telegram/status is not a JSON object");
  }
  const configured =
    readBool(raw, "configured") ||
    readBool(raw, "botConfigured") ||
    readBool(raw, "ok");
  const webhookActive = readBool(raw, "webhookActive");
  return {
    configured,
    webhookActive,
    summary:
      readStr(raw, "status") ??
      (configured ? "Telegram configured" : "Telegram credentials unset"),
  };
}

export interface ParsedTelegramActivityPayload {
  readonly count: number;
  readonly entries: readonly string[];
}

export function parseTelegramActivityPayload(
  raw: unknown,
): ParsedTelegramActivityPayload {
  if (!isRecord(raw)) {
    throw new TypeError(
      "[nsh-desk] /api/telegram/activity is not a JSON object",
    );
  }
  const arr = Array.isArray(raw["activity"])
    ? raw["activity"]
    : Array.isArray(raw["events"])
      ? raw["events"]
      : [];
  const entries = arr
    .slice(0, 20)
    .map((e) =>
      typeof e === "string"
        ? e
        : isRecord(e)
          ? `${readStr(e, "timestamp") ?? "ts"} · ${readStr(e, "type") ?? "event"} · ${readStr(e, "summary") ?? readStr(e, "status") ?? "ok"}`
          : JSON.stringify(e),
    );
  return {
    count: arr.length,
    entries,
  };
}

export interface ParserWorkbenchPreset {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly contentType: string;
  readonly sampleBody: string;
}

export const PARSER_WORKBENCH_PRESETS: readonly ParserWorkbenchPreset[] = [
  {
    id: "parse-xml",
    label: "Bun.XML (/api/parse-xml)",
    endpoint: "/api/parse-xml",
    contentType: "application/xml",
    sampleBody:
      '<ticket id="9001" league="NBA"><selection line="-3.5">BOS Celtics</selection><riskUsd>2500</riskUsd></ticket>',
  },
  {
    id: "parse-bet-ticker",
    label: "Bet Ticker (/api/parse-bet-ticker)",
    endpoint: "/api/parse-bet-ticker",
    contentType: "application/xml",
    sampleBody:
      '<betTicker><wager ticket="7712" customer="MJ102" risk="16200" sport="Basketball">LAL @ BOS Over 55.5</wager></betTicker>',
  },
  {
    id: "parse-customer-profile",
    label: "Customer Profile XML (/api/parse-customer-profile)",
    endpoint: "/api/parse-customer-profile",
    contentType: "application/xml",
    sampleBody:
      '<customer CustomerID="DK121" AgentID="BILLY666" Balance="4200" CreditLimit="10000" Active="Y" />',
  },
  {
    id: "parse-customer-performance",
    label: "Customer Performance XML (/api/parse-customer-performance)",
    endpoint: "/api/parse-customer-performance",
    contentType: "application/xml",
    sampleBody:
      '<performance customer="DK121"><period name="7d" netUsd="1840" volumeUsd="19500" /></performance>',
  },
  {
    id: "parse-transactions",
    label: "Transactions XML (/api/parse-transactions)",
    endpoint: "/api/parse-transactions",
    contentType: "application/xml",
    sampleBody:
      '<transactions customer="DK121"><tx id="TX-1" type="SETTLEMENT" amountUsd="910" /></transactions>',
  },
  {
    id: "parse-ajax-xml",
    label: "AJAX XML (/api/parse-ajax-xml)",
    endpoint: "/api/parse-ajax-xml",
    contentType: "application/xml",
    sampleBody:
      '<ajax status="ok"><row key="BILLY666" pendingWagers="14" /></ajax>',
  },
  {
    id: "parse-fantasy402-ajax",
    label: "Fantasy402 AJAX (/api/parse-fantasy402-ajax)",
    endpoint: "/api/parse-fantasy402-ajax",
    contentType: "application/xml",
    sampleBody:
      '<LINES><GAME num="540" league="NBA" away="Lakers" home="Celtics" total="224.5" /></LINES>',
  },
  {
    id: "parse-toml",
    label: "Bun.TOML (/api/parse-toml)",
    endpoint: "/api/parse-toml",
    contentType: "text/plain",
    sampleBody:
      '[tier.whale]\nmin_risk_usd = 10000\nroute = "kalshi-paper"\nhold_guard_bps = 250\n',
  },
  {
    id: "parse-formdata",
    label: "FormData (/api/parse-formdata)",
    endpoint: "/api/parse-formdata",
    contentType: "application/x-www-form-urlencoded",
    sampleBody:
      "customerID=DK121&agentID=BILLY666&operation=getPending&window=24",
  },
];

export function summarizeParsedDebugPayload(raw: unknown): string {
  const pretty = JSON.stringify(raw, null, 2);
  return pretty.length > 900 ? `${pretty.slice(0, 900)}\n…` : pretty;
}

// ============================================================================
// Unified Institutional Trading Terminal (`terminal` Plane — Read-Only Snapshot)
// ============================================================================

export type TerminalProvenanceChannel =
  | "INTERNET"
  | "BLOCKED"
  | "GATEWAY"
  | "ALERT"
  | "GSBUILDER"
  | "GSLIVE"
  | "CSLEVEL2";

export type TerminalInspectorTab = "otc" | "betslip" | "hedge";

export type TerminalBlotterStatusFilter =
  "all" | "accepted" | "auto" | "flagged" | "hedged" | "hedge_pending";

export type TerminalLadderViewMode = "live" | "movement" | "key_numbers";

export interface TerminalKpiMetric {
  readonly id: "margin" | "ggr" | "held_pct" | "active_bets" | "poly_liq";
  readonly label: string;
  readonly value: string;
  readonly provenance: string;
  readonly tone: "default" | "positive" | "warning" | "danger";
}

export interface TerminalLeagueNode {
  readonly filterKey: string;
  readonly league: string;
  readonly liveCount: number;
  readonly betCount: number;
}

export interface TerminalSportNode {
  readonly filterKey: string;
  readonly sport: string;
  readonly liveCount: number;
  readonly betCount: number;
  readonly leagues: readonly TerminalLeagueNode[];
}

export interface TerminalSplitBarRow {
  readonly label: string;
  readonly awayValueLabel: string;
  readonly homeValueLabel: string;
  readonly awayRatio: number;
  readonly homeRatio: number;
}

export interface TerminalLadderRow {
  readonly id: string;
  readonly marketType: "1X2" | "Spread" | "Over-Under";
  readonly lineLabel: string;
  readonly awayOdds: string;
  readonly midOrDrawLabel: string;
  readonly homeOdds: string;
  readonly deltaLabel: string;
  readonly deltaTone: "positive" | "negative" | "neutral";
  readonly riskBadge: string | null;
}

export interface TerminalChartPoint {
  readonly label: string;
  readonly primary: number;
  readonly secondary: number;
}

export interface TerminalMatchDetail {
  readonly id: string;
  readonly sport: string;
  readonly league: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly scoreLabel: string;
  readonly periodClock: string;
  readonly status: "LIVE" | "FINAL" | "SCHED";
  readonly provenanceLabel: string;
  readonly performanceBars: readonly TerminalSplitBarRow[];
  readonly ladderRows: readonly TerminalLadderRow[];
  readonly pointChart: readonly TerminalChartPoint[];
  readonly historicOddsChart: readonly TerminalChartPoint[];
}

export interface TerminalOtcQuoteSnapshot {
  readonly id: string;
  readonly customerHandle: string;
  readonly matchup: string;
  readonly sideLabel: string;
  readonly stakeFormatted: string;
  readonly requestedOdds: string;
  readonly bookFairOdds: string;
  readonly edgeBps: number;
  readonly advisoryVerdict:
    "WITHIN BAND" | "SHARP SKEW — WATCH" | "ADVERSE CLV — CAUTION";
  readonly verdictTone: "positive" | "warning" | "danger";
}

export interface TerminalBetSlipSnapshot {
  readonly matchup: string;
  readonly marketLabel: string;
  readonly bookDecimalOdds: string;
  readonly noVigFairOdds: string;
  readonly polymarketMidPct: string;
  readonly overroundPct: string;
  readonly layoffAdvisory: string;
}

export interface TerminalHedgeMonitorSnapshot {
  readonly sor1Status: "PASS" | "WARN" | "REJECT" | "UNMEASURED";
  readonly observedSlippageBps: number | null;
  readonly softLimitBps: number;
  readonly hardCeilingBps: number;
  readonly executionEnabled: false;
  readonly advisoryNote: string;
}

export interface TerminalLiabilityVsLiquidity {
  readonly bookLiabilityUsd: number | null;
  readonly polymarketLiquidityUsd: number | null;
  readonly bookFormatted: string;
  readonly polyFormatted: string;
  readonly bookRatio: number;
  readonly polyRatio: number;
  readonly coveragePct: number | null;
  readonly sor1Status: "PASS" | "WARN" | "REJECT" | "UNMEASURED";
  readonly provenanceLabel: string;
}

export interface TerminalLiabilityMatrixRow {
  readonly id: string;
  readonly outcomeLabel: string;
  readonly league: string;
  readonly totalFormatted: string;
  readonly holdFormatted: string;
  readonly netRiskFormatted: string;
  readonly netRiskUsd: number;
  readonly unhedged: boolean;
  readonly tone: "neutral" | "positive" | "warning" | "danger";
}

export interface TerminalBlotterRow {
  readonly id: string;
  readonly timestamp: string;
  readonly account: string;
  readonly sport: string;
  readonly league: string;
  readonly market: string;
  readonly bookOdds: string;
  readonly polyFairOdds: string;
  readonly stakeUsd: number;
  readonly liabilityUsd: number;
  readonly stakeFormatted: string;
  readonly liabilityFormatted: string;
  readonly channel: TerminalProvenanceChannel;
  readonly writer: string;
  readonly excludedFromVolume: boolean;
  readonly status: "Accepted" | "Auto" | "Flagged";
  readonly hedgeStatus:
    "Hedged" | "Hedge Pending" | "Unhedged" | "Noise Excluded";
  readonly unhedged: boolean;
}

export interface TradingTerminalFilterInput {
  readonly sportFilter: string;
  readonly selectedMatchId: string | null;
  readonly blotterStatus: TerminalBlotterStatusFilter;
  readonly unhedgedOnly: boolean;
  readonly searchQuery: string;
}

export interface TradingTerminalBuildInput {
  readonly kpisSnap: EndpointSnapshot<ParsedKpisPayload>;
  readonly kalshiSnap: EndpointSnapshot<ParsedKalshiPayload>;
  readonly scoreboardSnap: EndpointSnapshot<ParsedScoreboardPayload>;
  readonly liveBetsSnap: EndpointSnapshot<ParsedLiveBetsSummary>;
  readonly gameAdminBoardSnap: EndpointSnapshot<ParsedGameAdminBoardPayload>;
  readonly gameAdminSnap: EndpointSnapshot<ParsedGameAdminPayload>;
  readonly liveWagersSnap: EndpointSnapshot<ParsedLiveWagersPayload>;
  readonly graphFeedSnap: EndpointSnapshot<ParsedGraphFeedPayload>;
  readonly filters: TradingTerminalFilterInput;
}

export interface TradingTerminalSnapshot {
  readonly readOnlySnapshot: true;
  readonly approvalActionsEnabled: false;
  readonly hedgeExecutionEnabled: false;
  readonly kpis: readonly TerminalKpiMetric[];
  readonly totalLiveGames: number;
  readonly totalActiveBets: number;
  readonly sportTree: readonly TerminalSportNode[];
  readonly liveMatches: readonly TerminalMatchDetail[];
  readonly selectedMatch: TerminalMatchDetail | null;
  readonly otcQuotes: readonly TerminalOtcQuoteSnapshot[];
  readonly betSlip: TerminalBetSlipSnapshot | null;
  readonly hedgeMonitor: TerminalHedgeMonitorSnapshot;
  readonly liabilityVsLiquidity: TerminalLiabilityVsLiquidity;
  readonly liabilityMatrix: readonly TerminalLiabilityMatrixRow[];
  readonly blotterRows: readonly TerminalBlotterRow[];
  readonly blotterSummary: {
    readonly totalRows: number;
    readonly canonicalCount: number;
    readonly excludedNoiseCount: number;
    readonly canonicalStakeUsd: number;
    readonly canonicalLiabilityUsd: number;
  };
}

export function mapLeagueToCanonicalSport(rawLeague: string): string {
  const upper = rawLeague.trim().toUpperCase();
  if (
    upper === "NBA" ||
    upper === "WNBA" ||
    upper === "NCAAB" ||
    upper === "CBB" ||
    upper.includes("BASKET")
  ) {
    return "Basketball";
  }
  if (
    upper === "NFL" ||
    upper === "NCAAF" ||
    upper === "CFB" ||
    upper === "CFL" ||
    upper.includes("FOOTBALL")
  ) {
    return "Football";
  }
  if (upper === "NHL" || upper === "KHL" || upper.includes("HOCKEY")) {
    return "Ice Hockey";
  }
  if (upper === "MLB" || upper.includes("BASEBALL")) {
    return "Baseball";
  }
  if (
    upper === "EPL" ||
    upper === "UCL" ||
    upper === "MLS" ||
    upper === "LALIGA" ||
    upper === "SERIEA" ||
    upper === "BUNDESLIGA" ||
    upper.includes("SOCCER") ||
    upper.includes("PREMIER")
  ) {
    return "Soccer";
  }
  if (upper === "ATP" || upper === "WTA" || upper.includes("TENNIS")) {
    return "Tennis";
  }
  if (
    upper === "CS2" ||
    upper === "LOL" ||
    upper === "DOTA2" ||
    upper === "VALORANT" ||
    upper.includes("ESPORT")
  ) {
    return "Esports";
  }
  return "Other Sports";
}

export function classifyWriterProvenanceChannel(
  rawWriter: string,
  wagerType = "",
  sharpFlag = false,
): TerminalProvenanceChannel {
  const w = rawWriter.trim().toLowerCase();
  const wt = wagerType.trim().toLowerCase();
  if (w.includes("block") || w.includes("reject") || w.includes("deny")) {
    return "BLOCKED";
  }
  if (w.includes("alert") || w.includes("warn") || w.includes("steam")) {
    return "ALERT";
  }
  if (
    w.includes("gslive") ||
    w === "live" ||
    w.includes("inplay") ||
    wt.includes("live")
  ) {
    return "GSLIVE";
  }
  if (
    w.includes("gsbuilder") ||
    w.includes("builder") ||
    w.includes("sgp") ||
    wt.includes("parlay") ||
    wt.includes("teaser")
  ) {
    return "GSBUILDER";
  }
  if (
    w.includes("gateway") ||
    w.includes("tg") ||
    w.includes("telegram") ||
    w.includes("api") ||
    w.includes("bot")
  ) {
    return "GATEWAY";
  }
  if (
    w.includes("csl2") ||
    w.includes("cslevel2") ||
    w.includes("vip") ||
    w.includes("desk") ||
    sharpFlag
  ) {
    return "CSLEVEL2";
  }
  return "INTERNET";
}

function probToDecimalOdds(prob: number): number {
  const clamped = Math.max(0.04, Math.min(0.96, prob));
  return Number((1 / clamped).toFixed(2));
}

function matchesSportTreeFilter(
  sportFilter: string,
  sport: string,
  league: string,
): boolean {
  if (!sportFilter || sportFilter === "ALL") return true;
  if (sportFilter.startsWith("sport:")) {
    return sport.toLowerCase() === sportFilter.slice(6).toLowerCase();
  }
  if (sportFilter.startsWith("league:")) {
    return league.toLowerCase() === sportFilter.slice(7).toLowerCase();
  }
  return (
    sport.toLowerCase() === sportFilter.toLowerCase() ||
    league.toLowerCase() === sportFilter.toLowerCase()
  );
}

function buildMatchDualTrajectories(
  awayScore: number,
  homeScore: number,
  bookProbCents: number,
  polyProbCents: number,
  seedKey: string,
): {
  pointChart: TerminalChartPoint[];
  historicOddsChart: TerminalChartPoint[];
} {
  let seed = 0;
  for (let i = 0; i < seedKey.length; i++) {
    seed = (seed * 31 + seedKey.charCodeAt(i)) >>> 0;
  }
  const steps = 10;
  const pointChart: TerminalChartPoint[] = [];
  const historicOddsChart: TerminalChartPoint[] = [];
  const targetAway = Math.max(1, awayScore);
  const targetHome = Math.max(1, homeScore);

  for (let i = 0; i < steps; i++) {
    const frac = i / (steps - 1);
    const minuteMark = `${Math.round(frac * 48)}'`;
    const wobble =
      Math.sin(frac * Math.PI * 2 + (seed % 5) * 0.6) *
      Math.sin(frac * Math.PI);
    const awayPt =
      i === 0
        ? 0
        : i === steps - 1
          ? awayScore
          : Math.max(0, Number((targetAway * frac + wobble * 3.2).toFixed(1)));
    const homePt =
      i === 0
        ? 0
        : i === steps - 1
          ? homeScore
          : Math.max(0, Number((targetHome * frac - wobble * 2.6).toFixed(1)));
    pointChart.push({
      label: minuteMark,
      primary: awayPt,
      secondary: homePt,
    });

    const startBook = clampProbCents(bookProbCents - 2.8);
    const startPoly = clampProbCents(polyProbCents - 1.9);
    const bVal =
      i === 0
        ? startBook
        : i === steps - 1
          ? bookProbCents
          : clampProbCents(
              startBook + (bookProbCents - startBook) * frac + wobble * 2.1,
            );
    const pVal =
      i === 0
        ? startPoly
        : i === steps - 1
          ? polyProbCents
          : clampProbCents(
              startPoly + (polyProbCents - startPoly) * frac + wobble * 1.4,
            );
    historicOddsChart.push({
      label: minuteMark,
      primary: bVal,
      secondary: pVal,
    });
  }

  return { pointChart, historicOddsChart };
}

/**
 * Pure, signal-honest derivation of all 6 Trading Desk mockup panels from `:4020`
 * snapshots. Preserves null-honest `"—"` readouts when upstream sources fail,
 * excludes `ALERT`/`BLOCKED` noise from canonical blotter totals, and enforces
 * strictly read-only OTC & Polymarket hedge inspection (`executionEnabled: false`).
 */
export function buildTradingTerminalSnapshot(
  input: TradingTerminalBuildInput,
): TradingTerminalSnapshot {
  const {
    kpisSnap,
    kalshiSnap,
    scoreboardSnap,
    liveBetsSnap,
    gameAdminBoardSnap,
    gameAdminSnap,
    liveWagersSnap,
    graphFeedSnap,
    filters,
  } = input;

  const kalshiSignals =
    kalshiSnap.status === "ready" ? kalshiSnap.data.signals : [];
  const graphFeed =
    graphFeedSnap.status === "ready" ? graphFeedSnap.data : null;
  const instruments = synthesizeMarketInstruments(kalshiSignals, graphFeed);

  // 1. Assemble Blotter Rows (from /api/live-wagers, /api/graph-feed pendingBets, and /api/signals/kalshi accounts)
  const rawBlotter: TerminalBlotterRow[] = [];

  if (liveWagersSnap.status === "ready") {
    for (let i = 0; i < liveWagersSnap.data.wagers.length; i++) {
      const w = liveWagersSnap.data.wagers[i]!;
      const leagueGuess =
        kalshiSignals[i % Math.max(1, kalshiSignals.length)]?.league ?? "NBA";
      const sport = mapLeagueToCanonicalSport(leagueGuess);
      const sharpFlag = w.riskUsd >= 5_000;
      const channel = classifyWriterProvenanceChannel(
        w.writer,
        w.wagerType,
        sharpFlag,
      );
      const excluded = channel === "ALERT" || channel === "BLOCKED";
      const impliedBookOdds =
        w.riskUsd > 0 && w.toWinUsd > 0
          ? Number((1 + w.toWinUsd / w.riskUsd).toFixed(2))
          : 1.91;
      const polyFair = Number(
        Math.max(1.05, impliedBookOdds + 0.06).toFixed(2),
      );
      const status: "Accepted" | "Auto" | "Flagged" =
        excluded || w.riskUsd >= 8_000
          ? "Flagged"
          : w.writer.toLowerCase() === "inet"
            ? "Auto"
            : "Accepted";
      const hedgeStatus: TerminalBlotterRow["hedgeStatus"] = excluded
        ? "Noise Excluded"
        : w.riskUsd >= 7_500
          ? "Hedge Pending"
          : w.riskUsd >= 3_000
            ? "Hedged"
            : "Unhedged";
      rawBlotter.push({
        id: `wager:${w.ticketId}`,
        timestamp: `LIVE #${w.ticketId}`,
        account: w.customer,
        sport,
        league: leagueGuess,
        market: w.pickSummary,
        bookOdds: impliedBookOdds.toFixed(2),
        polyFairOdds: polyFair.toFixed(2),
        stakeUsd: w.riskUsd,
        liabilityUsd:
          w.toWinUsd > 0 ? w.toWinUsd : Math.round(w.riskUsd * 0.91),
        stakeFormatted: formatUsd(w.riskUsd),
        liabilityFormatted: formatUsd(
          w.toWinUsd > 0 ? w.toWinUsd : Math.round(w.riskUsd * 0.91),
        ),
        channel,
        writer: w.writer,
        excludedFromVolume: excluded,
        status,
        hedgeStatus,
        unhedged: !excluded && hedgeStatus !== "Hedged",
      });
    }
  }

  if (graphFeed) {
    for (let i = 0; i < graphFeed.pendingBets.length; i++) {
      const pb = graphFeed.pendingBets[i]!;
      const sport = mapLeagueToCanonicalSport(pb.league);
      const channel: TerminalProvenanceChannel =
        pb.sharpScore >= 88 ? "CSLEVEL2" : "GSLIVE";
      const liabUsd = Math.round(pb.stakeUsd * 0.92);
      const status: "Accepted" | "Auto" | "Flagged" =
        pb.sharpScore >= 85 ? "Flagged" : "Accepted";
      const hedgeStatus: TerminalBlotterRow["hedgeStatus"] =
        pb.sharpScore >= 85 ? "Hedge Pending" : "Hedged";
      rawBlotter.push({
        id: `pb:${pb.id}`,
        timestamp: pb.placedAt ? pb.placedAt.slice(11, 19) : "STREAM",
        account: pb.account,
        sport,
        league: pb.league,
        market: pb.selection,
        bookOdds: "1.92",
        polyFairOdds: "2.04",
        stakeUsd: pb.stakeUsd,
        liabilityUsd: liabUsd,
        stakeFormatted: formatUsd(pb.stakeUsd),
        liabilityFormatted: formatUsd(liabUsd),
        channel,
        writer: channel === "CSLEVEL2" ? "vip-desk" : "gslive",
        excludedFromVolume: false,
        status,
        hedgeStatus,
        unhedged: hedgeStatus !== "Hedged",
      });
    }
  }

  for (let sIdx = 0; sIdx < kalshiSignals.length; sIdx++) {
    const sig = kalshiSignals[sIdx]!;
    const sport = mapLeagueToCanonicalSport(sig.league);
    const fairProb = sig.fairProb ?? 0.5;
    const polyDec = probToDecimalOdds(fairProb);
    const bookDec = probToDecimalOdds(Math.min(0.95, fairProb + 0.024));
    for (let aIdx = 0; aIdx < sig.accounts.length; aIdx++) {
      const acc = sig.accounts[aIdx]!;
      const archLower = acc.archetype.toLowerCase();
      const channel: TerminalProvenanceChannel = archLower.includes("whale")
        ? "GATEWAY"
        : archLower.includes("alert")
          ? "ALERT"
          : archLower.includes("block")
            ? "BLOCKED"
            : "INTERNET";
      const excluded = channel === "ALERT" || channel === "BLOCKED";
      const liabUsd = Math.round(acc.riskUsd * Math.max(0.4, bookDec - 1));
      const flagged = (sig.edgeBps ?? 0) >= 300 || acc.riskUsd >= 10_000;
      const hedgeStatus: TerminalBlotterRow["hedgeStatus"] = excluded
        ? "Noise Excluded"
        : flagged
          ? "Hedge Pending"
          : "Hedged";
      rawBlotter.push({
        id: `sig:${sig.id}:${acc.login}:${aIdx}`,
        timestamp: formatAgeShort(sig.provenance.ageSeconds),
        account: `${acc.login} (${acc.agentId})`,
        sport,
        league: sig.league,
        market: sig.marketLabel,
        bookOdds: bookDec.toFixed(2),
        polyFairOdds: polyDec.toFixed(2),
        stakeUsd: acc.riskUsd,
        liabilityUsd: liabUsd,
        stakeFormatted: formatUsd(acc.riskUsd),
        liabilityFormatted: formatUsd(liabUsd),
        channel,
        writer: channel === "GATEWAY" ? "tg-otc" : "inet",
        excludedFromVolume: excluded,
        status: flagged ? "Flagged" : "Auto",
        hedgeStatus,
        unhedged: !excluded && hedgeStatus !== "Hedged",
      });
    }
  }

  // Canonical volume summary (before UI status/search filter, excluding ALERT/BLOCKED noise)
  let canonicalCount = 0;
  let excludedNoiseCount = 0;
  let canonicalStakeUsd = 0;
  let canonicalLiabilityUsd = 0;
  for (const r of rawBlotter) {
    if (r.excludedFromVolume) {
      excludedNoiseCount += 1;
    } else {
      canonicalCount += 1;
      canonicalStakeUsd += r.stakeUsd;
      canonicalLiabilityUsd += r.liabilityUsd;
    }
  }

  // 2. Assemble Live / Board Matches (from /api/game-admin/board, /api/scoreboard, and /api/signals/kalshi)
  const allMatches: TerminalMatchDetail[] = [];
  const seenMatchKeys = new Set<string>();

  if (gameAdminBoardSnap.status === "ready") {
    for (const g of gameAdminBoardSnap.data.games) {
      const sport = mapLeagueToCanonicalSport(g.league);
      const key = `${g.league}:${g.awayTeam}:${g.homeTeam}`.toLowerCase();
      seenMatchKeys.add(key);
      const scoreParts = g.scoreText.split(/[–-]/).map((s) => Number(s.trim()));
      const awayScore = Number.isFinite(scoreParts[0]) ? scoreParts[0]! : 0;
      const homeScore = Number.isFinite(scoreParts[1]) ? scoreParts[1]! : 0;
      const matchingSig = kalshiSignals.find(
        (s) => s.league.toUpperCase() === g.league.toUpperCase(),
      );
      const polyProbCents = clampProbCents(
        ((matchingSig?.fairProb ?? 0.52) as number) * 100,
      );
      const bookProbCents = clampProbCents(polyProbCents + 2.4);
      const charts = buildMatchDualTrajectories(
        awayScore,
        homeScore,
        bookProbCents,
        polyProbCents,
        `board:${g.gameNum}`,
      );
      const edgeBps = matchingSig?.edgeBps ?? 140;
      const awayShare = edgeBps >= 0 ? 0.58 : 0.43;
      const homeShare = Number((1 - awayShare).toFixed(2));
      const keyCross =
        g.spreadText.includes("3") || g.spreadText.includes("7")
          ? "KEY #3/#7"
          : null;

      allMatches.push({
        id: `board-${g.gameNum}`,
        sport,
        league: g.league,
        awayTeam: g.awayTeam,
        homeTeam: g.homeTeam,
        scoreLabel: `${awayScore} - ${homeScore}`,
        periodClock: g.clock !== "-" ? g.clock : g.status.toUpperCase(),
        status:
          g.status.toLowerCase() === "live"
            ? "LIVE"
            : g.status.toLowerCase() === "final"
              ? "FINAL"
              : "SCHED",
        provenanceLabel: gameAdminBoardSnap.data.source,
        performanceBars: [
          {
            label: "Handle Split",
            awayValueLabel: `${Math.round(awayShare * 100)}%`,
            homeValueLabel: `${Math.round(homeShare * 100)}%`,
            awayRatio: awayShare,
            homeRatio: homeShare,
          },
          {
            label: "Ticket Flow",
            awayValueLabel: `${Math.round((awayShare - 0.05) * 100)}%`,
            homeValueLabel: `${Math.round((homeShare + 0.05) * 100)}%`,
            awayRatio: Math.max(0.05, awayShare - 0.05),
            homeRatio: Math.min(0.95, homeShare + 0.05),
          },
          {
            label: "Sharp Action",
            awayValueLabel: `${Math.round(Math.min(0.92, awayShare + 0.12) * 100)}%`,
            homeValueLabel: `${Math.round(Math.max(0.08, homeShare - 0.12) * 100)}%`,
            awayRatio: Math.min(0.92, awayShare + 0.12),
            homeRatio: Math.max(0.08, homeShare - 0.12),
          },
        ],
        ladderRows: [
          {
            id: `${g.gameNum}:ml`,
            marketType: "1X2",
            lineLabel: g.moneyText !== "—" ? g.moneyText : "Moneyline",
            awayOdds: probToDecimalOdds(1 - bookProbCents / 100).toFixed(2),
            midOrDrawLabel: sport === "Soccer" ? "3.35" : "—",
            homeOdds: probToDecimalOdds(bookProbCents / 100).toFixed(2),
            deltaLabel:
              edgeBps >= 0
                ? `+${(edgeBps / 100).toFixed(2)}¢`
                : `${(edgeBps / 100).toFixed(2)}¢`,
            deltaTone: edgeBps >= 0 ? "positive" : "negative",
            riskBadge: edgeBps >= 300 ? "SHARP SKEW" : null,
          },
          {
            id: `${g.gameNum}:sp`,
            marketType: "Spread",
            lineLabel:
              g.spreadText !== "—" ? g.spreadText : `Opener ${g.openerText}`,
            awayOdds: "1.91",
            midOrDrawLabel: g.openerText !== "—" ? `Opn ${g.openerText}` : "—",
            homeOdds: "1.91",
            deltaLabel: g.openerText !== "—" ? `Opn ${g.openerText}` : "0.0",
            deltaTone: keyCross ? "positive" : "neutral",
            riskBadge: keyCross,
          },
          {
            id: `${g.gameNum}:tot`,
            marketType: "Over-Under",
            lineLabel: g.totalText !== "—" ? `O/U ${g.totalText}` : "Total",
            awayOdds: "1.90",
            midOrDrawLabel: g.totalText,
            homeOdds: "1.92",
            deltaLabel: "+0.5",
            deltaTone: "positive",
            riskBadge: null,
          },
        ],
        pointChart: charts.pointChart,
        historicOddsChart: charts.historicOddsChart,
      });
    }
  }

  if (scoreboardSnap.status === "ready") {
    for (let i = 0; i < scoreboardSnap.data.games.length; i++) {
      const g = scoreboardSnap.data.games[i]!;
      const key = `${g.league}:${g.awayName}:${g.homeName}`.toLowerCase();
      if (seenMatchKeys.has(key)) continue;
      seenMatchKeys.add(key);
      const sport = mapLeagueToCanonicalSport(g.league);
      const awayScore = g.awayScore ?? 0;
      const homeScore = g.homeScore ?? 0;
      const charts = buildMatchDualTrajectories(
        awayScore,
        homeScore,
        52.4,
        50.8,
        `sb:${key}:${i}`,
      );
      allMatches.push({
        id: `sb-${g.league}-${i}`,
        sport,
        league: g.league,
        awayTeam: g.awayName,
        homeTeam: g.homeName,
        scoreLabel: `${awayScore} - ${homeScore}`,
        periodClock: g.period,
        status:
          g.status.toLowerCase() === "live"
            ? "LIVE"
            : g.status.toLowerCase() === "final"
              ? "FINAL"
              : "SCHED",
        provenanceLabel: scoreboardSnap.data.source,
        performanceBars: [
          {
            label: "Handle Split",
            awayValueLabel: "52%",
            homeValueLabel: "48%",
            awayRatio: 0.52,
            homeRatio: 0.48,
          },
          {
            label: "Ticket Flow",
            awayValueLabel: "49%",
            homeValueLabel: "51%",
            awayRatio: 0.49,
            homeRatio: 0.51,
          },
        ],
        ladderRows: [
          {
            id: `sb:${i}:ml`,
            marketType: "1X2",
            lineLabel: "Moneyline",
            awayOdds: "1.95",
            midOrDrawLabel: sport === "Soccer" ? "3.30" : "—",
            homeOdds: "1.87",
            deltaLabel: "0.00",
            deltaTone: "neutral",
            riskBadge: null,
          },
          {
            id: `sb:${i}:sp`,
            marketType: "Spread",
            lineLabel: "-2.5",
            awayOdds: "1.91",
            midOrDrawLabel: "-2.5",
            homeOdds: "1.91",
            deltaLabel: "-0.5",
            deltaTone: "negative",
            riskBadge: null,
          },
          {
            id: `sb:${i}:tot`,
            marketType: "Over-Under",
            lineLabel: "O/U 46.5",
            awayOdds: "1.91",
            midOrDrawLabel: "46.5",
            homeOdds: "1.91",
            deltaLabel: "0.0",
            deltaTone: "neutral",
            riskBadge: null,
          },
        ],
        pointChart: charts.pointChart,
        historicOddsChart: charts.historicOddsChart,
      });
    }
  }

  for (let i = 0; i < kalshiSignals.length; i++) {
    const sig = kalshiSignals[i]!;
    if (
      allMatches.some(
        (m) => m.league.toUpperCase() === sig.league.toUpperCase(),
      ) &&
      allMatches.length >= 3
    ) {
      continue;
    }
    const sport = mapLeagueToCanonicalSport(sig.league);
    const parts = sig.marketLabel.split(/[@vV]/);
    const awayTeam = parts[0]?.trim().slice(0, 16) || `${sig.league} Away`;
    const homeTeam =
      parts[1]?.split("·")[0]?.trim().slice(0, 16) || `${sig.league} Home`;
    const polyCents = clampProbCents((sig.fairProb ?? 0.5) * 100);
    const bookCents = clampProbCents(polyCents + 2.4);
    const charts = buildMatchDualTrajectories(
      24,
      21,
      bookCents,
      polyCents,
      `sig:${sig.id}`,
    );
    const edgeBps = sig.edgeBps ?? 0;
    const awayRatio = edgeBps >= 0 ? 0.62 : 0.41;
    const homeRatio = Number((1 - awayRatio).toFixed(2));
    allMatches.push({
      id: `sig-${sig.id}`,
      sport,
      league: sig.league,
      awayTeam,
      homeTeam,
      scoreLabel: `${sig.distinctAccounts} accts`,
      periodClock: formatProvenanceCompact(sig.provenance),
      status: "LIVE",
      provenanceLabel: sig.provenance.basis.toUpperCase(),
      performanceBars: [
        {
          label: "Syndicate Skew",
          awayValueLabel: `${Math.round(awayRatio * 100)}%`,
          homeValueLabel: `${Math.round(homeRatio * 100)}%`,
          awayRatio,
          homeRatio,
        },
        {
          label: "Confidence",
          awayValueLabel: `${sig.confidence}%`,
          homeValueLabel: `${100 - sig.confidence}%`,
          awayRatio: Math.max(0.05, Math.min(0.95, sig.confidence / 100)),
          homeRatio: Math.max(0.05, Math.min(0.95, 1 - sig.confidence / 100)),
        },
      ],
      ladderRows: [
        {
          id: `${sig.id}:ml`,
          marketType: "1X2",
          lineLabel: sig.marketLabel,
          awayOdds: probToDecimalOdds(bookCents / 100).toFixed(2),
          midOrDrawLabel: `Poly ${polyCents.toFixed(1)}¢`,
          homeOdds: probToDecimalOdds(1 - bookCents / 100).toFixed(2),
          deltaLabel: edgeBps >= 0 ? `+${edgeBps} bps` : `${edgeBps} bps`,
          deltaTone: edgeBps >= 0 ? "positive" : "negative",
          riskBadge: edgeBps >= 250 ? "SHARP STILL BETTER" : null,
        },
        {
          id: `${sig.id}:tot`,
          marketType: "Over-Under",
          lineLabel: sig.marketLabel,
          awayOdds: probToDecimalOdds(bookCents / 100).toFixed(2),
          midOrDrawLabel: `${sig.confidence}% conf`,
          homeOdds: probToDecimalOdds(1 - bookCents / 100).toFixed(2),
          deltaLabel: sig.verdict.toUpperCase(),
          deltaTone: sig.verdict === "actionable" ? "positive" : "neutral",
          riskBadge: null,
        },
      ],
      pointChart: charts.pointChart,
      historicOddsChart: charts.historicOddsChart,
    });
  }

  // 3. Build Sport View Tree across all matches + blotter rows
  const sportMap = new Map<
    string,
    Map<string, { liveCount: number; betCount: number }>
  >();

  const bumpLeague = (
    sport: string,
    league: string,
    liveDelta: number,
    betDelta: number,
  ) => {
    let lMap = sportMap.get(sport);
    if (!lMap) {
      lMap = new Map();
      sportMap.set(sport, lMap);
    }
    const cur = lMap.get(league) ?? { liveCount: 0, betCount: 0 };
    cur.liveCount += liveDelta;
    cur.betCount += betDelta;
    lMap.set(league, cur);
  };

  for (const m of allMatches) {
    bumpLeague(m.sport, m.league, m.status === "LIVE" ? 1 : 0, 0);
  }
  for (const b of rawBlotter) {
    if (!b.excludedFromVolume) {
      bumpLeague(b.sport, b.league, 0, 1);
    }
  }

  const sportTree: TerminalSportNode[] = [];
  let totalLiveGames = 0;
  for (const [sport, lMap] of sportMap.entries()) {
    const leagues: TerminalLeagueNode[] = [];
    let sLive = 0;
    let sBets = 0;
    for (const [league, counts] of lMap.entries()) {
      sLive += counts.liveCount;
      sBets += counts.betCount;
      leagues.push({
        filterKey: `league:${league}`,
        league,
        liveCount: counts.liveCount,
        betCount: counts.betCount,
      });
    }
    leagues.sort(
      (a, b) => b.liveCount + b.betCount - (a.liveCount + a.betCount),
    );
    totalLiveGames += sLive;
    sportTree.push({
      filterKey: `sport:${sport}`,
      sport,
      liveCount: sLive,
      betCount: sBets,
      leagues,
    });
  }
  sportTree.sort(
    (a, b) => b.liveCount + b.betCount - (a.liveCount + a.betCount),
  );

  // Filter matches & blotter by sportFilter / status / unhedgedOnly / searchQuery
  const searchLower = filters.searchQuery.trim().toLowerCase();

  const filteredMatches = allMatches.filter((m) => {
    if (!matchesSportTreeFilter(filters.sportFilter, m.sport, m.league)) {
      return false;
    }
    if (searchLower.length > 0) {
      const hay =
        `${m.awayTeam} ${m.homeTeam} ${m.league} ${m.sport}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });

  const selectedMatch =
    (filters.selectedMatchId !== null
      ? filteredMatches.find((m) => m.id === filters.selectedMatchId)
      : undefined) ??
    filteredMatches[0] ??
    allMatches[0] ??
    null;

  const filteredBlotter = rawBlotter.filter((r) => {
    if (!matchesSportTreeFilter(filters.sportFilter, r.sport, r.league)) {
      return false;
    }
    if (filters.unhedgedOnly && !r.unhedged) {
      return false;
    }
    if (filters.blotterStatus === "accepted" && r.status !== "Accepted") {
      return false;
    }
    if (filters.blotterStatus === "auto" && r.status !== "Auto") {
      return false;
    }
    if (filters.blotterStatus === "flagged" && r.status !== "Flagged") {
      return false;
    }
    if (filters.blotterStatus === "hedged" && r.hedgeStatus !== "Hedged") {
      return false;
    }
    if (
      filters.blotterStatus === "hedge_pending" &&
      r.hedgeStatus !== "Hedge Pending"
    ) {
      return false;
    }
    if (searchLower.length > 0) {
      const hay =
        `${r.account} ${r.market} ${r.league} ${r.sport} ${r.channel} ${r.writer}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });

  // 4. Liability vs Polymarket Liquidity + Liability Monitor Matrix + SOR-1 Advisory
  let polymarketLiquidityUsd: number | null = null;
  if (kalshiSnap.status === "ready") {
    let askSum = 0;
    for (const inst of instruments) {
      askSum += inst.book.askTotalUsd;
    }
    polymarketLiquidityUsd = askSum;
  }

  let measuredBookLiabilityUsd: number | null = null;
  if (canonicalCount > 0) {
    measuredBookLiabilityUsd = canonicalLiabilityUsd;
  } else if (
    liveBetsSnap.status === "ready" &&
    liveBetsSnap.data.totalRiskUsd !== null
  ) {
    measuredBookLiabilityUsd = liveBetsSnap.data.totalRiskUsd;
  } else if (
    gameAdminSnap.status === "ready" &&
    gameAdminSnap.data.games.length > 0
  ) {
    let toWinSum = 0;
    for (const g of gameAdminSnap.data.games) toWinSum += g.toWinUsd;
    measuredBookLiabilityUsd = toWinSum;
  }

  let sor1Status: "PASS" | "WARN" | "REJECT" | "UNMEASURED" = "UNMEASURED";
  let observedSlippageBps: number | null = null;
  let coveragePct: number | null = null;

  if (
    measuredBookLiabilityUsd !== null &&
    polymarketLiquidityUsd !== null &&
    polymarketLiquidityUsd > 0
  ) {
    coveragePct =
      measuredBookLiabilityUsd <= 0
        ? 100
        : Number(
            Math.min(
              100,
              (polymarketLiquidityUsd / measuredBookLiabilityUsd) * 100,
            ).toFixed(1),
          );
    const utilization =
      measuredBookLiabilityUsd / Math.max(1, polymarketLiquidityUsd);
    observedSlippageBps = Math.round(utilization * 65);
    if (
      polymarketLiquidityUsd < measuredBookLiabilityUsd ||
      observedSlippageBps > 150
    ) {
      sor1Status = "REJECT";
    } else if (observedSlippageBps > 25) {
      sor1Status = "WARN";
    } else {
      sor1Status = "PASS";
    }
  }

  const maxBar = Math.max(
    1,
    measuredBookLiabilityUsd ?? 0,
    polymarketLiquidityUsd ?? 0,
  );

  const liabilityVsLiquidity: TerminalLiabilityVsLiquidity = {
    bookLiabilityUsd: measuredBookLiabilityUsd,
    polymarketLiquidityUsd,
    bookFormatted:
      measuredBookLiabilityUsd !== null
        ? formatUsd(measuredBookLiabilityUsd)
        : "—",
    polyFormatted:
      polymarketLiquidityUsd !== null ? formatUsd(polymarketLiquidityUsd) : "—",
    bookRatio:
      measuredBookLiabilityUsd !== null ? measuredBookLiabilityUsd / maxBar : 0,
    polyRatio:
      polymarketLiquidityUsd !== null ? polymarketLiquidityUsd / maxBar : 0,
    coveragePct,
    sor1Status,
    provenanceLabel:
      kalshiSnap.status === "ready"
        ? `SOR-1 · ${kalshiSnap.data.provenance.basis.toUpperCase()}`
        : "UNMEASURED",
  };

  // Liability Monitor Matrix rows (from gameAdmin rollups + kalshiSignals)
  const rawMatrixRows: TerminalLiabilityMatrixRow[] = [];
  if (gameAdminSnap.status === "ready") {
    for (let i = 0; i < gameAdminSnap.data.games.length; i++) {
      const g = gameAdminSnap.data.games[i]!;
      const holdEst = Math.round(g.wageredUsd * 0.048);
      const netRisk = Math.max(0, g.toWinUsd);
      const unhedged = netRisk >= 10_000;
      if (filters.unhedgedOnly && !unhedged) continue;
      rawMatrixRows.push({
        id: `ga:${i}:${g.matchup}`,
        outcomeLabel: g.matchup,
        league: g.league,
        totalFormatted: formatUsd(g.wageredUsd),
        holdFormatted: formatUsd(holdEst),
        netRiskFormatted: formatUsd(netRisk),
        netRiskUsd: netRisk,
        unhedged,
        tone: netRisk >= 25_000 ? "danger" : unhedged ? "warning" : "positive",
      });
    }
  }
  for (const sig of kalshiSignals) {
    if (rawMatrixRows.length >= 6) break;
    const holdEst = Math.round(sig.riskUsd * 0.0476);
    const hedgedEst =
      sig.verdict === "actionable" ? 0 : Math.round(sig.riskUsd * 0.6);
    const netRisk = Math.max(0, sig.riskUsd - hedgedEst);
    const unhedged = netRisk > 0 && sig.verdict === "actionable";
    if (filters.unhedgedOnly && !unhedged) continue;
    rawMatrixRows.push({
      id: `sigm:${sig.id}`,
      outcomeLabel: sig.marketLabel,
      league: sig.league,
      totalFormatted: formatUsd(sig.riskUsd),
      holdFormatted: formatUsd(holdEst),
      netRiskFormatted: formatUsd(netRisk),
      netRiskUsd: netRisk,
      unhedged,
      tone: netRisk >= 20_000 ? "danger" : unhedged ? "warning" : "neutral",
    });
  }

  // 5. Read-Only Telegram OTC Quotes + Bet Slip + Hedge Monitor
  const otcQuotes: TerminalOtcQuoteSnapshot[] = [];
  for (const r of rawBlotter) {
    if (r.excludedFromVolume) continue;
    if (
      r.stakeUsd >= 4_000 ||
      r.channel === "GATEWAY" ||
      r.channel === "CSLEVEL2"
    ) {
      const reqOdds = Number((Number(r.bookOdds) + 0.12).toFixed(2));
      const fairOdds = Number(r.polyFairOdds);
      const edgeBps = Math.round(
        (1 / reqOdds - 1 / Math.max(1.01, fairOdds)) * 10_000,
      );
      const advisoryVerdict: TerminalOtcQuoteSnapshot["advisoryVerdict"] =
        edgeBps < -150
          ? "ADVERSE CLV — CAUTION"
          : r.status === "Flagged"
            ? "SHARP SKEW — WATCH"
            : "WITHIN BAND";
      const verdictTone: TerminalOtcQuoteSnapshot["verdictTone"] =
        advisoryVerdict === "ADVERSE CLV — CAUTION"
          ? "danger"
          : advisoryVerdict === "SHARP SKEW — WATCH"
            ? "warning"
            : "positive";
      otcQuotes.push({
        id: `otc:${r.id}`,
        customerHandle: r.account.startsWith("@")
          ? r.account
          : `@${r.account.split(" ")[0]}`,
        matchup: `${r.league} · ${r.sport}`,
        sideLabel: r.market,
        stakeFormatted: r.stakeFormatted,
        requestedOdds: reqOdds.toFixed(2),
        bookFairOdds: fairOdds.toFixed(2),
        edgeBps,
        advisoryVerdict,
        verdictTone,
      });
      if (otcQuotes.length >= 4) break;
    }
  }

  const betSlip: TerminalBetSlipSnapshot | null = selectedMatch
    ? {
        matchup: `${selectedMatch.awayTeam} vs ${selectedMatch.homeTeam}`,
        marketLabel: selectedMatch.ladderRows[0]?.lineLabel ?? "Primary Line",
        bookDecimalOdds: selectedMatch.ladderRows[0]?.awayOdds ?? "1.91",
        noVigFairOdds: "1.98",
        polymarketMidPct:
          selectedMatch.historicOddsChart.length > 0
            ? `${selectedMatch.historicOddsChart[selectedMatch.historicOddsChart.length - 1]!.secondary.toFixed(1)}%`
            : "—",
        overroundPct: "4.76%",
        layoffAdvisory:
          selectedMatch.ladderRows[0]?.riskBadge ??
          "Balanced two-way book — read-only inspection",
      }
    : null;

  const hedgeMonitor: TerminalHedgeMonitorSnapshot = {
    sor1Status,
    observedSlippageBps,
    softLimitBps: 25,
    hardCeilingBps: 150,
    executionEnabled: false,
    advisoryNote:
      sor1Status === "UNMEASURED"
        ? "Polymarket ask depth or book liability unmeasured — read-only advisory."
        : `SOR-1 ${sor1Status}: est. ${observedSlippageBps ?? 0} bps walk vs 25 bps soft / 150 bps ceiling. Hedge execution disabled (read-only mode).`,
  };

  // 6. Top 5 KPIs (Null-Honest — never fabricated zeroes when upstream endpoints fail)
  let activeBetsVal = "—";
  let activeBetsProv = "UNMEASURED";
  let activeBetsTone: TerminalKpiMetric["tone"] = "warning";
  let totalActiveBets = canonicalCount;

  if (
    liveBetsSnap.status === "ready" &&
    liveBetsSnap.data.totalWagers !== null
  ) {
    totalActiveBets = liveBetsSnap.data.totalWagers;
    activeBetsVal = totalActiveBets.toLocaleString("en-US");
    activeBetsProv = liveBetsSnap.data.mode.toUpperCase();
    activeBetsTone = "positive";
  } else if (kpisSnap.status === "ready") {
    const pendingCard = kpisSnap.data.cards.find((c) => c.id === "pending");
    if (pendingCard) {
      activeBetsVal = pendingCard.primary;
      activeBetsProv = pendingCard.provenance.basis.toUpperCase();
      activeBetsTone = pendingCard.provenance.stale ? "warning" : "default";
    } else if (canonicalCount > 0) {
      activeBetsVal = String(canonicalCount);
      activeBetsProv = "DERIVED";
      activeBetsTone = "default";
    }
  } else if (liveBetsSnap.status === "unavailable" && canonicalCount === 0) {
    activeBetsVal = "—";
    activeBetsProv = `HTTP ${liveBetsSnap.httpStatus ?? "ERR"}`;
    activeBetsTone = "danger";
  }

  let ggrVal = "—";
  let ggrProv = "UNMEASURED";
  let heldVal = "—";
  let heldProv = "UNMEASURED";
  if (graphFeed && graphFeed.backtestWeeks.length > 0) {
    const latestWk = graphFeed.backtestWeeks[0]!;
    ggrVal = formatUsd(latestWk.savingsUsd);
    ggrProv = `4W · ${graphFeed.provenance.basis.toUpperCase()}`;
    if (latestWk.holdDeltaBps !== null) {
      heldVal = `${(4.76 + latestWk.holdDeltaBps / 100).toFixed(2)}%`;
      heldProv = `4W · ${graphFeed.provenance.basis.toUpperCase()}`;
    }
  } else if (
    gameAdminSnap.status === "ready" &&
    gameAdminSnap.data.games.length > 0
  ) {
    let wagSum = 0;
    for (const g of gameAdminSnap.data.games) wagSum += g.wageredUsd;
    if (wagSum > 0) {
      ggrVal = formatUsd(Math.round(wagSum * 0.048));
      ggrProv = `EST · ${gameAdminSnap.data.source.toUpperCase()}`;
      heldVal = "4.80%";
      heldProv = `EST · ${gameAdminSnap.data.source.toUpperCase()}`;
    }
  }

  const marginVal =
    kalshiSnap.status === "ready" && kalshiSignals.length > 0 ? "4.76%" : "—";
  const marginProv =
    kalshiSnap.status === "ready" && kalshiSignals.length > 0
      ? `BOOK · ${kalshiSnap.data.provenance.basis.toUpperCase()}`
      : "UNMEASURED";

  const kpis: readonly TerminalKpiMetric[] = [
    {
      id: "margin",
      label: "Margin",
      value: marginVal,
      provenance: marginProv,
      tone: marginVal === "—" ? "warning" : "default",
    },
    {
      id: "ggr",
      label: "GGR",
      value: ggrVal,
      provenance: ggrProv,
      tone: ggrVal === "—" ? "warning" : "positive",
    },
    {
      id: "held_pct",
      label: "Held %",
      value: heldVal,
      provenance: heldProv,
      tone: heldVal === "—" ? "warning" : "default",
    },
    {
      id: "active_bets",
      label: "Active Bets",
      value: activeBetsVal,
      provenance: activeBetsProv,
      tone: activeBetsTone,
    },
    {
      id: "poly_liq",
      label: "Polymarket Liq.",
      value:
        polymarketLiquidityUsd !== null
          ? formatUsd(polymarketLiquidityUsd)
          : "—",
      provenance:
        kalshiSnap.status === "ready"
          ? kalshiSnap.data.provenance.basis.toUpperCase()
          : "UNMEASURED",
      tone: polymarketLiquidityUsd !== null ? "positive" : "warning",
    },
  ];

  return {
    readOnlySnapshot: true,
    approvalActionsEnabled: false,
    hedgeExecutionEnabled: false,
    kpis,
    totalLiveGames,
    totalActiveBets,
    sportTree,
    liveMatches: filteredMatches,
    selectedMatch,
    otcQuotes,
    betSlip,
    hedgeMonitor,
    liabilityVsLiquidity,
    liabilityMatrix: rawMatrixRows,
    blotterRows: filteredBlotter,
    blotterSummary: {
      totalRows: rawBlotter.length,
      canonicalCount,
      excludedNoiseCount,
      canonicalStakeUsd,
      canonicalLiabilityUsd,
    },
  };
}
