// auth.js — browser session controller for the manager portal.
//
// Contracts this file deliberately mirrors (see verification/manager-boot-oracle/pinned/security.js
// and lib/f402_browser_token_manager.ts):
//   * the login body comes from buildAuthenticateCustomerBody(), one source of truth;
//   * sessionStorage.credentials is written for BOTH branches — verifySession() and the token
//     manager's remint() both require it;
//   * agents write only the keys the vendor writes, and never set MASTER_ID (manager.js owns it);
//   * agent/skin routing is keyed by the *values* the server sends ("Gotham", "NewClassic"), not
//     by the constant names ("VISOR_GOTHAM", "NEWCLASSIC");
//   * renewToken carries operation:"renewToken" in the body.
//
// Build for the browser with `bun build client/auth/auth.js --outfile=...` (it imports the
// TS builder). Tests: `bun test tests/auth/auth.test.ts`.

import { buildAuthenticateCustomerBody } from "../../lib/f402_browser_token_manager.ts";

const API = "/cloud/api/System/";

export const CONFIG = {
  REFRESH_MS: 5 * 60 * 1000,
  IDLE_MS: 30 * 60 * 1000,
  IDLE_CHECK_MS: 60 * 1000,
  REQUEST_TIMEOUT_MS: 30 * 1000,
  REFRESH_WARN_AFTER: 3,
  REFRESH_LOGOUT_AFTER: 6,
  // Vendor parity: every shipped web client calls toLocaleUpperCase() on the password before
  // sending it, so existing hashes are uppercase unless the server normalizes. Keep this true
  // until the server's case handling is confirmed; flip to false together with that change.
  UPPERCASE_PASSWORD: true,
  /** @type {null | ((error: unknown, consecutiveFailures: number) => void)} */
  onRefreshError: null,
  /** @type {null | ((value: string) => void)} — a value outside AGENT_SKIN_ROUTES fell back */
  onUnknownAgentSkin: null,
};

// Keys the vendor writes or clears. `credentials` is load-bearing: verifySession() and remint()
// both refuse to continue without it.
export const SESSION_KEYS = [
  "credentials",
  "token",
  "customerID",
  "agentType",
  "office",
  "skin",
  "language",
  "playerID",
  "MASTER_ID",
  "isOnlyPoker",
  "site",
  "showMobile",
  "closeWidget",
  "forceMobile",
  "AgentSkinOverride",
];

// DefaultSiteSkin values as returned by the server (client/util.js `skins`).
const SKIN_ROUTES = {
  Gotham: { desktop: "/skin/gotham.html?url=StraightSportSelection.php" },
  DPU: "skin/dpu.html",
  Sisepd: "skin/condensed-bs.html",
  Buckeye: {
    mobile: "skin/m-sbsports.html?url=StraightSportSelection.php",
    desktop: "skin/sbsports.html?url=StraightSportSelection.php",
  },
  IBET: { mobile: "skin/m-ibet.html", desktop: "skin/ibet.html" },
  "Ninja Cat": "skin/ninja-cat.html",
  "BLUE-SKY": "skin/blue-sky.html",
  MGM: { mobile: "skin/m-mgm.html", desktop: "skin/mgm.html" },
  "Neon Lime": "skin/neon-lime.html",
  "Vegas Gold": { mobile: "skin/m-vegas.html", desktop: "skin/vegas.html" },
  "Wager Attack": {
    mobile: "skin/m-wager-attack.html",
    desktop: "skin/wager-attack.html",
  },
  Toronto: "skin/toronto.html",
  Euro: "skin/euro.html",
  LINEPROS: "skin/line-pros.html",
  BEATLINES: {
    mobile: "skin/lines.html",
    desktop: "sports.html",
    extra: { SKIN: "GROUP-BEAT-LINES" },
  },
  BetMelon: "/skin/bet-melon.html",
  NoLimitBet: "/skin/no-limit-bet.html?url=StraightSportSelection.php",
  Latam: { mobile: "skin/m-latam.html", desktop: "skin/latam.html" },
  "EZ BetSlip": "/skin/ez-slip.html",
  // Vendor emits these without a cache buster.
  "EZ Classic": {
    mobile: "skin/m-ez-classic.html?url=WelcomePage.php",
    desktop: "skin/ez-classic.html?url=WelcomePage.php",
    noV: true,
    mobileCheck: "only",
  },
  "EZ Classic Mobile": {
    mobile: "skin/m-ez-classic.html?url=WelcomePage.php",
    desktop: "skin/ez-classic.html?url=WelcomePage.php",
    noV: true,
    mobileCheck: "only",
  },
};

// AgentSkinOverride values (client/util.js `skinsAgents`), keyed by value, not constant name.
const AGENT_SKIN_ROUTES = {
  NewClassic: "skin/agent/classic/index.html",
  Toronto: "skin/agent/toronto/index.html",
  BEATLINES: "skin/agent/line-group/index.html",
  Gotham: "skin/agent/gotham/index.html",
};

const LEGACY_CLASSIC = "Classic"; // lowercase; skinsAgents.CLASSIC is "CLASSIC" and never matches
const DSI_OFFICE = "DSIMA";
const BAS_OFFICE = "BAS";

// ---------- storage / token ----------

const storage = () => globalThis.sessionStorage;

export function getToken() {
  return storage().getItem("token");
}

export function isUsableToken(token) {
  return (
    typeof token === "string" &&
    token !== "" &&
    token !== "undefined" &&
    token !== "null" &&
    token !== "0"
  );
}

export function isLoggedIn() {
  return isUsableToken(getToken());
}

function clearSession() {
  for (const key of SESSION_KEYS) storage().removeItem(key);
}

// ---------- transport ----------

function defaultSignal() {
  if (
    typeof AbortSignal === "undefined" ||
    typeof AbortSignal.timeout !== "function"
  )
    return undefined;
  return AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS);
}

export async function apiCall(operation, body, opts = {}) {
  const { bearer, noScope, signal, skipLogoutOn401 } = opts;
  let payload = body ?? {};

  const agentType = storage().getItem("agentType");
  const masterRaw = storage().getItem("MASTER_ID");
  if (!noScope && masterRaw && (agentType === "M" || agentType === "A")) {
    const master = Number(masterRaw);
    if (!Number.isNaN(master)) {
      // vendor semantics: agentID is the master id (or the target when master is 0);
      // agentOwner is the target the caller named, when it differs.
      let target = payload.agentID;
      if (payload.agentOwner && target !== payload.agentOwner)
        target = payload.agentOwner;
      const scoped = master === 0 ? target : master;
      payload = { ...payload, agentID: scoped, agentOwner: target };
    }
  }

  // bearer === undefined -> session token. bearer === "" -> no auth header.
  const raw = bearer !== undefined ? bearer : getToken();
  const token = isUsableToken(raw) ? raw : null;

  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (token) headers.Authorization = "Bearer " + token;

  const res = await fetch(API + operation, {
    method: "POST",
    credentials: "include",
    signal: signal ?? defaultSignal(),
    headers,
    body: JSON.stringify(payload),
  });

  if (
    res.status === 401 &&
    !skipLogoutOn401 &&
    !operation.startsWith("authenticateCustomer")
  ) {
    logout();
    throw new Error("session_expired");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {}
    throw new Error("http_" + res.status + (detail ? ": " + detail : ""));
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("non_json_response");
  return res.json();
}

// ---------- login ----------

export async function login(opts = {}) {
  const {
    customerID,
    password,
    domain,
    multiaccount,
    agentToken,
    rro,
    plb,
    manager,
  } = opts;

  if (typeof customerID !== "string" || !customerID.trim()) {
    throw new Error("missing_customer_id");
  }
  if (typeof password !== "string" || password === "") {
    throw new Error("missing_password");
  }

  clearSession();

  const host = (globalThis.location?.host ?? "").replace(/^www\./, "");
  const hostDomain = domain || host;
  const sentPassword = CONFIG.UPPERCASE_PASSWORD
    ? password.toLocaleUpperCase()
    : password;
  const operation = agentToken
    ? "authenticateCustomerforAgent"
    : "authenticateCustomer";

  const body = buildAuthenticateCustomerBody(
    customerID.toUpperCase().trim(),
    sentPassword,
    {
      domain: hostDomain,
      multiaccount: multiaccount ?? 0,
      operation,
      token: agentToken ?? "",
      ...(rro !== undefined ? { RRO: rro } : {}),
    },
  );

  const r = await apiCall(operation, body, {
    bearer: agentToken ?? "",
    skipLogoutOn401: true,
  });

  // Vendor order: reset -> captcha -> otp -> normal (security.js authenticate success handler).
  if (r.reset === 1) return { step: "reset", data: r };
  if (r.accountInfo?.UseCaptcha === "Y" && !agentToken)
    return { step: "captcha", data: r };
  if (r.tokenauth === 1) return { step: "otp", data: r };
  if (!r.code) throw new Error("missing_token");

  persistSession(r, { password: sentPassword, redirectUri: hostDomain });

  startRefresh();
  startIdle();

  return {
    step: "done",
    data: r,
    route: routeAfterLogin(r, { agentToken, plb, manager }),
  };
}

/**
 * Writes the session. Players get the full vendor key set; agents get only the keys the vendor
 * writes for agents (customerID, agentType, token, AgentSkinOverride) plus `credentials`.
 * MASTER_ID is reset here and owned by manager.js's bootstrap, which sets it from `e.ID`.
 */
export function persistSession(r, ctx = {}) {
  const a = r.accountInfo;
  const isAgent = a.AgentType === "M" || a.AgentType === "A";
  const skin = String(a.DefaultSiteSkin ?? "").trim();

  storage().setItem(
    "credentials",
    JSON.stringify({
      code: r.code,
      redirect_uri: ctx.redirectUri ?? "",
      password: ctx.password ?? "",
      customerID: a.customerID,
    }),
  );
  storage().setItem("token", r.code);
  storage().setItem("customerID", a.customerID);
  storage().setItem("agentType", a.AgentType || "");
  storage().setItem("MASTER_ID", "");

  if (isAgent) {
    storage().setItem("AgentSkinOverride", a.AgentSkinOverride || "");
    return;
  }

  storage().setItem("isOnlyPoker", "OFF");
  storage().setItem("office", a.Office || "");
  storage().setItem("playerID", a.customerID);
  storage().setItem("site", "NEW");
  storage().setItem(
    "language",
    ((a.Language || "EN").split(" ")[0] || "EN").toUpperCase().trim(),
  );
  storage().setItem("showMobile", "NOT");
  storage().setItem("closeWidget", "NOT");
  storage().setItem("skin", skin);
  // The vendor writes the boolean true; sessionStorage stores "true" and isForceMobile() uses !!.
  if (skin === "Gotham") storage().setItem("forceMobile", "true");
}

export function logout() {
  clearSession();
  stopTimers();
  const loc = globalThis.location;
  if (loc) loc.href = "/";
}

// ---------- token refresh ----------

let refreshTimer = null;
let refreshFailures = 0;

export async function refreshNow() {
  const r = await apiCall(
    "renewToken",
    { operation: "renewToken" },
    { skipLogoutOn401: true },
  );
  if (!r || !isUsableToken(r.code)) throw new Error("renew_failed");
  storage().setItem("token", r.code);
  refreshFailures = 0;
  return r.code;
}

export function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(async () => {
    try {
      await refreshNow();
    } catch (e) {
      const message = String(e && e.message);
      if (message === "session_expired" || message.startsWith("http_401")) {
        logout();
        return;
      }
      refreshFailures += 1;
      if (
        refreshFailures === CONFIG.REFRESH_WARN_AFTER &&
        CONFIG.onRefreshError
      ) {
        CONFIG.onRefreshError(e, refreshFailures);
      }
      if (refreshFailures >= CONFIG.REFRESH_LOGOUT_AFTER) logout();
    }
  }, CONFIG.REFRESH_MS);
}

export function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * The vendor `verifySession()` path: a session is resumable when `credentials` exists. If the
 * token is missing, remint immediately instead of waiting for the first refresh tick.
 */
export async function bootstrapSession() {
  if (!storage().getItem("credentials")) return false;
  if (!isUsableToken(getToken())) {
    try {
      await refreshNow();
    } catch {
      return false;
    }
  }
  startRefresh();
  startIdle();
  return true;
}

// ---------- idle ----------

let idleTimer = null;
let idleLast = Date.now();
let idleBound = false;

export function startIdle(opts = {}) {
  const idleMs = opts.idleMs ?? CONFIG.IDLE_MS;
  const checkMs = opts.checkMs ?? CONFIG.IDLE_CHECK_MS;
  stopIdle();
  idleLast = Date.now();
  if (!idleBound && typeof document !== "undefined") {
    const touch = () => {
      idleLast = Date.now();
    };
    ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((ev) =>
      document.addEventListener(ev, touch, { passive: true }),
    );
    idleBound = true;
  }
  idleTimer = setInterval(() => {
    if (Date.now() - idleLast > idleMs) logout();
  }, checkMs);
}

export function stopIdle() {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

export function stopTimers() {
  stopRefresh();
  stopIdle();
}

/** Test seam: stop timers and clear the refresh failure counter. */
export function resetAuthState() {
  stopTimers();
  refreshFailures = 0;
}

// ---------- routing ----------

/** Join a query string onto a URL that may already carry one. Never emits a second "?". */
export function withQuery(url, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const qs = q.toString();
  if (!qs) return url;
  return url + (url.includes("?") ? "&" : "?") + qs;
}

const WIDTH_LIMIT = 1024;

function viewportWidth() {
  const w = globalThis.window?.innerWidth;
  return typeof w === "number" ? w : Infinity;
}

function isForceMobile() {
  return !!storage().getItem("forceMobile");
}

function uaIsMobile() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    globalThis.navigator?.userAgent ?? "",
  );
}

function hasOrientation() {
  const mm = globalThis.matchMedia;
  if (typeof mm !== "function") return false;
  return !!(
    mm("(orientation: portrait)")?.matches ||
    mm("(orientation: landscape)")?.matches
  );
}

/** Port of util.js isMobile(): forceMobile, then UA+orientation under the width limit. */
export function isMobile() {
  if (isForceMobile()) return true;
  const width = viewportWidth();
  if (uaIsMobile() && hasOrientation()) return !(width >= WIDTH_LIMIT);
  return width <= WIDTH_LIMIT;
}

/** Port of util.js isOnlyMobile(): forceMobile, or a mobile UA below 768 px. */
export function isOnlyMobile() {
  return isForceMobile() || (uaIsMobile() && viewportWidth() < 768);
}

/**
 * Returns one of:
 *   { kind: "url", url }                 — navigate here
 *   { kind: "legacy", customerID }       — account is pinned to the legacy agents site; the caller
 *                                          must show an explicit notice (never silently redirect)
 */
export function routeAfterLogin(data, opts = {}) {
  const a = data.accountInfo;
  const v = String(Date.now());
  const site =
    new URLSearchParams(globalThis.location?.search ?? "").get("site") || "";

  if (a.AgentType === "M" || a.AgentType === "A") {
    const override = String(a.AgentSkinOverride ?? "");
    // "Classic" is the vendor's lowercase legacy check; it sends credentials over plain http.
    if (override === LEGACY_CLASSIC)
      return { kind: "legacy", customerID: a.customerID };
    const target = AGENT_SKIN_ROUTES[override];
    // An unmapped value is not a guess we can make: report it and use the vendor default.
    if (!target && override !== "" && CONFIG.onUnknownAgentSkin)
      CONFIG.onUnknownAgentSkin(override);
    const destination = target || "manager.html";
    return { kind: "url", url: withQuery(destination, { v }) };
  }

  const skinParam = new URLSearchParams(globalThis.location?.search ?? "").get(
    "SKIN",
  );
  if (skinParam === "NEON-LIME") {
    storage().setItem("skin", "Neon Lime");
    return { kind: "url", url: withQuery("skin/neon-lime.html", { v }) };
  }
  if (skinParam === "EURO") {
    storage().setItem("skin", "Euro");
    return {
      kind: "url",
      url: withQuery("skin/euro.html", { v, SKIN: "EURO" }),
    };
  }
  if (skinParam === "LINE-PROS") {
    storage().setItem("skin", "LINEPROS");
    return {
      kind: "url",
      url: withQuery("skin/line-pros.html", { v, SKIN: "LINE-PROS" }),
    };
  }
  if (skinParam === "GROUP-BEAT-LINES") {
    storage().setItem("skin", "BEATLINES");
    const base = isMobile() ? "skin/lines.html" : "sports.html";
    return {
      kind: "url",
      url: withQuery(base, { v, SKIN: "GROUP-BEAT-LINES", site }),
    };
  }

  if (opts.plb === "true") {
    return {
      kind: "url",
      url: withQuery("pbl.html", {
        v,
        manager: opts.manager,
        plb: opts.plb,
        agToken: opts.agentToken,
      }),
    };
  }

  const office = String(a.Office ?? "").trim();
  if (office === DSI_OFFICE || office === BAS_OFFICE) {
    return { kind: "url", url: withQuery("skin/dsi-project.html", { v }) };
  }

  const entry = SKIN_ROUTES[String(a.DefaultSiteSkin ?? "").trim()];
  if (!entry) return { kind: "url", url: withQuery("sports.html", { v }) }; // vendor default
  const useMobile = entry.mobileCheck === "only" ? isOnlyMobile() : isMobile();
  // Some entries exist only in desktop form (Gotham is the case that bites: login forces
  // mobile for it, but the vendor has a single URL).
  const target =
    typeof entry === "string"
      ? entry
      : ((useMobile ? entry.mobile : undefined) ?? entry.desktop);
  return {
    kind: "url",
    url: withQuery(target, {
      ...(entry.noV ? {} : { v }),
      ...entry.extra,
    }),
  };
}
