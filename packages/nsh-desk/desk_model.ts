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

export interface ProvenanceTag {
  readonly basis: string;
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
}

export interface KalshiSignalItem {
  readonly id: string;
  readonly league: string;
  readonly marketLabel: string;
  readonly riskUsd: number;
  readonly distinctAccounts: number;
  readonly fairProb: number | null;
  readonly edgeBps: number | null;
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

function parseProvenance(raw: unknown, fallbackBasis: string): ProvenanceTag {
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
  const basis =
    readStr(raw, "basis") ??
    (raw["fixture"] === true ? "fixture" : null) ??
    readStr(raw, "dataMode")?.toLowerCase() ??
    fallbackBasis;
  const sourcesArr = Array.isArray(raw["sources"]) ? raw["sources"] : null;
  const firstSource =
    sourcesArr && typeof sourcesArr[0] === "string" ? sourcesArr[0] : null;
  const source = readStr(raw, "source") ?? firstSource ?? "unreported";
  return {
    basis,
    source,
    asOf: readStr(raw, "asOf"),
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
      accounts.push({
        login: readStr(acc, "login") ?? "unknown",
        agentId: readStr(acc, "agentId") ?? "unknown",
        archetype: readStr(acc, "archetype") ?? "unclassified",
        riskUsd: readNum(acc, "riskUsd") ?? 0,
      });
    }

    signals.push({
      id,
      league,
      marketLabel,
      riskUsd: readNum(item, "riskUsd") ?? 0,
      distinctAccounts: readNum(item, "distinctAccounts") ?? accounts.length,
      fairProb: readNum(item, "fairProb"),
      edgeBps: readNum(kalshiObj, "edgeBps"),
      confidence: readNum(item, "confidence") ?? 0,
      verdict: readStr(kalshiObj, "verdict") ?? "unmatched",
      reason: readStr(kalshiObj, "reason") ?? "no verdict detail",
      provenance: parseProvenance(item["provenance"], provenance.basis),
      accounts,
    });
  }

  return {
    generatedAt: readStr(raw, "generatedAt"),
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
  return {
    totalWagers: readNum(summary, "totalWagers") ?? readNum(summary, "count"),
    totalRiskUsd:
      readNum(summary, "totalRiskUsd") ?? readNum(summary, "riskUsd"),
    mode: readStr(raw, "mode") ?? "live",
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

export interface SignalArenaView {
  readonly rows: string[][];
  readonly order: Uint32Array;
  readonly items: readonly KalshiSignalItem[];
}

export function buildSignalArenaView(
  items: readonly KalshiSignalItem[],
  sortKey: string | null,
  sortDirection: "ascending" | "descending" | null,
): SignalArenaView {
  const count = items.length;
  const metrics = new Float64Array(count * SIGNAL_METRIC_STRIDE);
  const order = new Uint32Array(count);

  for (let i = 0; i < count; i++) {
    const item = items[i]!;
    const base = i * SIGNAL_METRIC_STRIDE;
    metrics[base + COL_RISK] = item.riskUsd;
    metrics[base + COL_ACCOUNTS] = item.distinctAccounts;
    metrics[base + COL_FAIR_PROB] = item.fairProb ?? -1;
    metrics[base + COL_EDGE_BPS] = item.edgeBps ?? Number.NEGATIVE_INFINITY;
    metrics[base + COL_CONFIDENCE] = item.confidence;
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

  const rows: string[][] = new Array(count);
  for (let pos = 0; pos < count; pos++) {
    const idx = order[pos]!;
    const s = items[idx]!;
    const edgeText =
      s.edgeBps === null
        ? "—"
        : `${s.edgeBps >= 0 ? "+" : ""}${s.edgeBps.toFixed(0)} bps`;
    const fairText =
      s.fairProb === null ? "—" : `${(s.fairProb * 100).toFixed(1)}%`;
    rows[pos] = [
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

  return { rows, order, items };
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
