/**
 * @file docs/assets/gslive-links.js
 * @description Pure GSLive Manager link assembly for the live portal (browser + Bun-testable).
 *
 * The portal no longer stores per-wallet URLs in HTML: each `[data-gslive]` anchor is hydrated
 * from `graph-live-feed.json` on every poll, so the desk-day window and the `t` cache-buster roll
 * forward without a redeploy. No DOM access lives here, which keeps the logic unit-testable.
 */

export const GSLIVE_CHURN_WINDOW = {
  fromIso: "2026-10-18T05:00:00.000Z",
  toIso: "2026-10-26T04:59:59.000Z",
};

/** Splits `#/route?key=value` URLs, where the query lives inside the hash fragment. */
export function parseHashQuery(url) {
  const at = typeof url === "string" ? url.indexOf("?") : -1;
  return new URLSearchParams(at === -1 ? "" : url.slice(at + 1));
}

function encodeValue(value) {
  return encodeURIComponent(String(value));
}

export function setUrlParam(url, key, value) {
  const token = `${key}=${encodeValue(value)}`;
  const pattern = new RegExp(`([?&])${key}=[^&]*`);
  if (pattern.test(url)) return url.replace(pattern, `$1${token}`);
  return `${url}${url.indexOf("?") === -1 ? "?" : "&"}${token}`;
}

export function dropUrlParam(url, key) {
  return url.replace(new RegExp(`[?&]${key}=[^&]*`), "");
}

export function withWindow(url, fromIso, toIso) {
  return setUrlParam(setUrlParam(url, "to", toIso), "from", fromIso);
}

/** Exact desk-day bounds (today) as reported by the feed's DST-aware sidecar URL. */
export function deskDayBounds(descriptor) {
  const url = descriptor && descriptor.liveBetHistorySidecarCalcTimeUrl;
  if (!url) return null;
  const query = parseHashQuery(url);
  const fromRaw = query.get("from");
  const toTimeRaw = query.get("toTime");
  if (fromRaw === null || toTimeRaw === null) return null;
  const from = Number(fromRaw);
  const toTime = Number(toTimeRaw);
  if (!Number.isFinite(from) || !Number.isFinite(toTime)) return null;
  return {
    fromIso: new Date(from * 1000).toISOString(),
    toIso: new Date((from + toTime) * 1000).toISOString(),
  };
}

function withPlayerText(url, login) {
  const clean = String(login || "")
    .replace(/^player_/i, "")
    .toUpperCase();
  return clean === "" ? url : setUrlParam(url, "text", `player_${clean}`);
}

/**
 * Resolves a `#/reports/users` deep link for a window.
 * `windowKey`: "1" (today) | "7" | "14" | "churn".
 * Uses the wallet's prebuilt URL when present; otherwise substitutes the login into the
 * descriptor's canonical template, which keeps untracked accounts (the CHURN cohort, internal
 * logins) on the live day window instead of a frozen fallback.
 */
/**
 * @param {{ wallet?: any, descriptor?: any, login?: string, windowKey?: string }} input
 */
export function buildReportUrl({ wallet, descriptor, login, windowKey }) {
  const wallet14 = wallet && wallet.gsLivePlayerReportUrl;
  const template14 = descriptor && descriptor.usersReportDeepLink14Day;
  if (!wallet14 && !template14) return null;
  if (!login && !wallet14) return null;

  if (windowKey === "7") {
    if (wallet && wallet.gsLivePlayerReport7DayUrl)
      return wallet.gsLivePlayerReport7DayUrl;
    return descriptor && descriptor.usersReportDeepLink7Day
      ? withPlayerText(descriptor.usersReportDeepLink7Day, login)
      : null;
  }
  if (windowKey === "churn") {
    if (wallet14) {
      return withWindow(
        wallet14,
        GSLIVE_CHURN_WINDOW.fromIso,
        GSLIVE_CHURN_WINDOW.toIso,
      );
    }
    return descriptor && descriptor.usersReportChurnWindowDeepLink
      ? withPlayerText(descriptor.usersReportChurnWindowDeepLink, login)
      : null;
  }

  const base14 = wallet14 || withPlayerText(template14, login);
  if (windowKey === "1") {
    const bounds = deskDayBounds(descriptor);
    return bounds ? withWindow(base14, bounds.fromIso, bounds.toIso) : null;
  }
  return base14;
}

/**
 * Resolves a `#/events/bet-history` sidecar URL with a fresh `t` cache-buster.
 * `dateFilterBy`: "calcTime" (settling/populating) | "betTime" (placement).
 */
/**
 * @param {{ wallet?: any, descriptor?: any, login?: string, dateFilterBy?: string, tickEpochMs?: number }} options
 */
export function buildSidecarUrl({
  wallet,
  descriptor,
  login,
  dateFilterBy = "calcTime",
  tickEpochMs = Date.now(),
}) {
  let base = wallet && wallet.gsLiveBetHistoryUrl;
  if (!base && descriptor) {
    base =
      dateFilterBy === "betTime"
        ? descriptor.liveBetHistorySidecarBetTimeUrl
        : descriptor.liveBetHistorySidecarCalcTimeUrl;
  }
  if (!base) return null;

  let url = setUrlParam(base, "dateFilterBy", dateFilterBy);
  url = login
    ? setUrlParam(
        url,
        "partnerUserId",
        String(login)
          .replace(/^player_/i, "")
          .toUpperCase(),
      )
    : dropUrlParam(url, "partnerUserId");
  return setUrlParam(url, "t", Math.trunc(tickEpochMs));
}

/** Indexes `walletProfiles` by upper-cased Fantasy402 login. */
export function indexWallets(feed) {
  const map = new Map();
  const wallets = (feed && feed.walletProfiles) || [];
  for (const wallet of wallets) {
    if (wallet && wallet.f402CustomerId) {
      map.set(String(wallet.f402CustomerId).toUpperCase(), wallet);
    }
  }
  return map;
}

/**
 * Extracts the registry-row values the portal renders: cost basis, open legs, top-position summary,
 * and the provenance of those numbers. Rows without a feed entry are simply absent.
 *
 * @param {{ walletProfiles?: Array<any> } | null} feed
 * @returns {Record<string, { volumeUsd: number, legs: number, summary: string, dataSource: string, lastError: string | null }>}
 */
export function buildWalletStats(feed) {
  const stats = {};
  for (const wallet of (feed && feed.walletProfiles) || []) {
    const id = String((wallet && wallet.f402CustomerId) || "").toUpperCase();
    if (id === "") continue;
    stats[id] = {
      volumeUsd: Number(wallet.openVolumeUsd) || 0,
      legs: Number(wallet.openLegsCount) || 0,
      summary: String(wallet.openBetsSummary || ""),
      dataSource: String(wallet.dataSource || "FIXTURE"),
      lastError: wallet.lastError ? String(wallet.lastError) : null,
    };
  }
  return stats;
}

/**
 * Computes `{ element, url }` updates for every `[data-gslive]` node. DOM-agnostic: any object
 * exposing `getAttribute` works, which keeps the portal's hydration path unit-testable.
 *
 * @param {Array<any>} elements
 * @param {{ feed?: any, activeReportWindow?: string, tickEpochMs?: number }} options
 */
export function planGsLiveLinks(
  elements,
  { feed, activeReportWindow = "14", tickEpochMs = Date.now() },
) {
  const wallets = indexWallets(feed);
  const descriptor = (feed && feed.gsLiveSidecar) || null;
  const updates = [];

  for (const el of elements) {
    const kind = el.getAttribute("data-gslive");
    const login = (el.getAttribute("data-gslive-login") || "").toUpperCase();
    const wallet = login ? wallets.get(login) : undefined;
    let url = null;

    if (kind === "report") {
      const own = el.getAttribute("data-gslive-window") || "auto";
      url = buildReportUrl({
        wallet,
        descriptor,
        login,
        windowKey: own === "auto" ? activeReportWindow : own,
      });
    } else if (kind === "sidecar") {
      url = buildSidecarUrl({
        wallet,
        descriptor,
        login,
        dateFilterBy: el.getAttribute("data-gslive-filter") || "calcTime",
        tickEpochMs,
      });
    }

    if (url) updates.push({ element: el, url });
  }
  return updates;
}
