/**
 * @file live-ops.js
 * @description Pure helpers for the /graph "Live Wagers & Our Positions" panel.
 *
 * The page has three data planes, in freshness order:
 *   1. the same-origin bridge WebSocket on `/api/live-bets` (daemon-served pages only),
 *   2. `./graph-live-feed.json`, polled every 15s (daemon file or the last deployment),
 *   3. the last rendered values (the page never blanks a table on a failed poll).
 *
 * Everything here is a pure function of its arguments: no DOM, no network, no timers,
 * no `innerHTML`. docs/graph.js owns the wiring; tests/graph_live_ops.test.ts proves the
 * aggregation and frame handling without a browser.
 */

/** Topics the daemon hub republishes; mirrors BRIDGE_WS_TOPICS in the webview server. */
export const LIVE_WS_TOPICS = [
  "wagers-by-state",
  "f402-bet-ticker",
  "f402-pending",
  "gslive-tally",
  "f402-weblog",
];

/** Human labels for the five bridge topics. */
export const BRIDGE_LABELS = {
  "wagers-by-state": "Bridge 1 · wagers-by-state",
  "f402-bet-ticker": "Bridge 3a · f402-bet-ticker",
  "f402-pending": "Bridge 3b · f402-pending",
  "gslive-tally": "Bridge 3c · gslive-tally",
  "f402-weblog": "Bridge WebLog · Mode 6",
};

const KNOWN_TOTALS = [
  "ticketCount",
  "legCount",
  "riskCents",
  "settledNetCents",
  "openExposureCents",
  "wagerCount",
  "matched",
  "unmatched",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

const roundUsd = (value) => Math.round(value * 100) / 100;

/**
 * Aggregate the Polymarket shadow-position rows the poller publishes.
 * Provenance is per wallet: a failure must never look live.
 */
export function summarizePositions(walletProfiles) {
  const rows = Array.isArray(walletProfiles) ? walletProfiles : [];
  const aggregate = {
    walletCount: rows.length,
    trackedCount: 0,
    liveCount: 0,
    staleCount: 0,
    fixtureCount: 0,
    invalidCount: 0,
    openLegs: 0,
    openCostUsd: 0,
    openValueUsd: 0,
    openPnlUsd: 0,
    latestSyncIso: null,
    rows: [],
  };

  const out = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const source = asString(raw.dataSource) || "FIXTURE";
    const legs = Math.max(0, Math.trunc(asNumber(raw.openLegsCount)));
    const cost = asNumber(raw.openVolumeUsd);
    const value = asNumber(raw.positionsValueUsd);
    const pnl = asNumber(raw.openPnlUsd);
    const walletValid = raw.walletAddressValid !== false;
    const synced = asString(raw.lastSyncedIso) || asString(raw.fetchedAtIso);
    const error = asString(raw.lastError);

    aggregate.trackedCount += 1;
    if (!walletValid) aggregate.invalidCount += 1;
    if (source === "LIVE") aggregate.liveCount += 1;
    else if (source === "STALE") aggregate.staleCount += 1;
    else aggregate.fixtureCount += 1;
    aggregate.openLegs += legs;
    aggregate.openCostUsd += cost;
    aggregate.openValueUsd += value;
    aggregate.openPnlUsd += pnl;
    if (
      synced !== "" &&
      (aggregate.latestSyncIso === null || synced > aggregate.latestSyncIso)
    ) {
      aggregate.latestSyncIso = synced;
    }

    out.push({
      rank: Math.trunc(asNumber(raw.rank)),
      proxyWallet: asString(raw.proxyWallet),
      shortWallet:
        asString(raw.shortWallet) || asString(raw.proxyWallet).slice(0, 10),
      customerId: asString(raw.f402CustomerId) || "—",
      agentOwner: asString(raw.agentOwner) || "—",
      legs,
      costUsd: roundUsd(cost),
      valueUsd: roundUsd(value),
      pnlUsd: roundUsd(pnl),
      source,
      syncedIso: synced,
      summary: asString(raw.openBetsSummary),
      error,
    });
  }

  out.sort((a, b) => b.valueUsd - a.valueUsd || b.legs - a.legs);
  aggregate.rows = out;
  aggregate.openCostUsd = roundUsd(aggregate.openCostUsd);
  aggregate.openValueUsd = roundUsd(aggregate.openValueUsd);
  aggregate.openPnlUsd = roundUsd(aggregate.openPnlUsd);
  return aggregate;
}

/**
 * Aggregate the desk's open shadow clusters (feed.pendingBets) into totals plus a venue
 * breakdown. `riskUsd`/`toWinUsd` are the row's own values; nothing is recomputed.
 */
export function summarizePendingBets(pendingBets) {
  const rows = Array.isArray(pendingBets) ? pendingBets : [];
  const venues = new Map();
  const out = [];
  let riskUsd = 0;
  let toWinUsd = 0;

  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const venue = asString(raw.sourceVenue) || "UNKNOWN";
    const risk = asNumber(raw.riskUsd);
    const toWin = asNumber(raw.toWinUsd);
    riskUsd += risk;
    toWinUsd += toWin;
    const bucket = venues.get(venue) ?? { venue, count: 0, riskUsd: 0 };
    bucket.count += 1;
    bucket.riskUsd += risk;
    venues.set(venue, bucket);

    out.push({
      ticketId: asString(raw.ticketId) || `${venue}-${out.length + 1}`,
      venue,
      customerId: asString(raw.f402CustomerId) || "—",
      agentOwner: asString(raw.agentOwner) || "—",
      market:
        asString(raw.canonicalMarket) || asString(raw.sportAndPeriod) || "—",
      sportAndPeriod: asString(raw.sportAndPeriod),
      riskUsd: roundUsd(risk),
      toWinUsd: roundUsd(toWin),
      verdict: asString(raw.deskVerdict),
      placedAtUtc: asString(raw.placedAtUtc),
      syncedIso: asString(raw.lastSyncedUtc),
    });
  }

  out.sort((a, b) => b.riskUsd - a.riskUsd);
  return {
    clusterCount: out.length,
    riskUsd: roundUsd(riskUsd),
    toWinUsd: roundUsd(toWinUsd),
    exposureUsd: roundUsd(riskUsd),
    venues: [...venues.values()]
      .map((v) => ({ ...v, riskUsd: roundUsd(v.riskUsd) }))
      .sort((a, b) => b.riskUsd - a.riskUsd),
    rows: out,
  };
}

/** One feed tick row (F402 ticker) as a tape entry; identity + timing only. */
export function normalizeTickerRow(tick, fallbackSeq = 0) {
  if (!isRecord(tick)) return null;
  const insertedAt = asString(tick.insertedAt);
  const login = asString(tick.login);
  const agent = asString(tick.agentLogin) || asString(tick.agentId);
  const ticket = asString(tick.ticketWriter);
  const wager = asString(tick.wagerNumber);
  const desc = asString(tick.shortDesc);
  const id = ["tick", insertedAt, login, ticket, wager, fallbackSeq].join("|");
  return {
    id,
    atIso: insertedAt,
    source: "f402-ticker",
    label: "F402 ticker",
    login: login || "—",
    agent: agent || "—",
    ticket: [ticket, wager].filter(Boolean).join("/") || "—",
    summary: desc || "live tick",
    kind: "tick",
  };
}

function pickFrameStamp(frame) {
  for (const key of [
    "generatedAtIso",
    "lastUpdatedIso",
    "capturedAtIso",
    "asOfIso",
    "generatedAt",
  ]) {
    const value = asString(frame[key]);
    if (value !== "") return value;
  }
  return "";
}

function describeFrameTotals(frame) {
  const parts = [];
  const totals = isRecord(frame.totals) ? frame.totals : frame;
  for (const key of KNOWN_TOTALS) {
    if (totals[key] === undefined || totals[key] === null) continue;
    if (typeof totals[key] === "number" || typeof totals[key] === "string") {
      parts.push(`${key}=${totals[key]}`);
    }
  }
  if (parts.length > 0) return parts.slice(0, 4).join(" · ");
  if (typeof frame.rows === "number") return `rows=${frame.rows}`;
  if (typeof frame.rowCount === "number") return `rows=${frame.rowCount}`;
  if (isRecord(frame.join)) {
    const matched = frame.join.matched;
    const total = frame.join.totalWindowWagers;
    if (matched !== undefined && total !== undefined) {
      return `matched=${matched}/${total}`;
    }
  }
  return "rollup event";
}

/**
 * Turn a bridge frame published on the WS hub into one tape entry.
 * The gateway publishes the raw rollup with the topic in its own `kind` field.
 * Returns null for unknown kinds so a foreign frame never renders.
 */
export function summarizeBridgeFrame(frame, receivedAtIso) {
  if (!isRecord(frame)) return null;
  const kind = asString(frame.kind);
  if (!LIVE_WS_TOPICS.includes(kind)) return null;

  const stamp = pickFrameStamp(frame) || asString(receivedAtIso);
  const deskDate =
    asString(frame.deskDate) ||
    asString(frame.date) ||
    asString(frame.window) ||
    "—";
  const detail = describeFrameTotals(frame);
  return {
    id: ["frame", kind, stamp, detail].join("|"),
    atIso: stamp,
    source: kind,
    label: BRIDGE_LABELS[kind],
    login: "—",
    agent: "—",
    ticket: "—",
    summary: `${deskDate} · ${detail}`,
    kind: "frame",
  };
}

/** Dedupe by id, newest first, bounded. `rows` and `incoming` are not mutated. */
export function mergeTape(rows, incoming, limit = 80) {
  const cap = Math.max(1, Math.trunc(limit));
  const seen = new Set();
  const merged = [];
  for (const row of [
    ...(Array.isArray(incoming) ? incoming : []),
    ...(Array.isArray(rows) ? rows : []),
  ]) {
    if (!row || typeof row !== "object" || typeof row.id !== "string") continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
    if (merged.length >= cap) break;
  }
  merged.sort((a, b) => String(b.atIso).localeCompare(String(a.atIso)));
  return merged.slice(0, cap);
}

/** Compact age label: 0–59s, 1–59m, 1–23h, then days. */
export function formatAgeMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Decide the panel's live mode from the WS state and the feed's age.
 * Never reports a live mode when the transport is only polling.
 */
export function resolveLiveMode({ wsState, feedAgeMs, feedDataMode } = {}) {
  const mode =
    feedDataMode && feedDataMode !== "—"
      ? `feed ${feedDataMode}`
      : "feed unknown";
  if (wsState === "connected") {
    return {
      label: "WS LIVE",
      tone: "emerald",
      detail: `bridge frames streaming · ${mode}`,
    };
  }
  if (wsState === "connecting") {
    return { label: "WS CONNECTING", tone: "cyan", detail: mode };
  }
  if (typeof feedAgeMs === "number" && Number.isFinite(feedAgeMs)) {
    const age = formatAgeMs(Math.max(0, feedAgeMs));
    if (feedAgeMs <= 45_000) {
      return {
        label: "POLL 15s",
        tone: "emerald",
        detail: `${mode} · ${age} old`,
      };
    }
    if (feedAgeMs <= 300_000) {
      return {
        label: "POLL STALE",
        tone: "amber",
        detail: `${mode} · ${age} old`,
      };
    }
    return { label: "SNAPSHOT", tone: "amber", detail: `${mode} · ${age} old` };
  }
  return {
    label: "SNAPSHOT",
    tone: "rose",
    detail: "feed not reachable; showing the last published values",
  };
}

/** True when a wallet row's provenance should be shown as observed rather than fixture. */
export function isObservedSource(source) {
  return source === "LIVE" || source === "STALE";
}
