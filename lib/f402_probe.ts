/**
 * @file lib/f402_probe.ts
 * @description Probe plan for the F402 report and manager.html boot reads, executed inside a signed-in WebView page.
 *
 * The point is to observe what the portal returns for each named report or boot call, not to assert a contract.
 * Paths and payloads come from the cached RequireJS bundles:
 * - `customer/report/report.js` (`Blob F5D0F39D9ABFE7F995C65F3152C690EFF1B0F9EF`)
 * - `app/manager/manager.js?bust=1.0.280` (`Blob 610B48F7F455B4D77131D88AD56832DFBB66A519`)
 *
 * `PendingDelete` is confirmed read-only in `customer/report/report.js:8578` (`setDeleteWager` ->
 * `getPendingWagers({ deleteWagers: true, ticketNumber })` -> renders `e.Pending[]` in the Ticket Detail modal),
 * and remains gated behind `includeUnconfirmed` so the default 6-op report suite stays stable; when probed without
 * `--ticket`, it sends sentinel `ticketNumber=-1`.
 */

import {
  inPageCloudApiHeadersJs,
  inPageCollectResponseHeadersJs,
  inPageInjectWireTokenJs,
  inPageReadSessionAuthJs,
} from "./f402_in_page_fetch.ts";

import { LOG_WRITE_CUSTOMER_ID_WIDTH } from "./f402_field_widths.ts";

export type ProbeParam =
  | "agentID"
  | "agentOwner"
  | "agentType"
  | "acc"
  | "customerID"
  | "week"
  | "date"
  | "type"
  | "layout"
  | "RRO"
  | "token"
  | "operation"
  | "ticketNumber"
  | "wagerNumber"
  | "flag"
  | "days"
  | "description"
  | "additional"
  | "store"
  | "office"
  | "showGraded"
  | "sportType"
  | "sportTypeIn"
  | "sportSubTypeIn"
  | "periodDescriptionIn"
  | "periodNumberIn"
  | "storeIn"
  | "numberStart"
  | "numberEnd"
  | "filtro"
  | "storeAgent"
  | "sportTypeList"
  | "sportSubTypeList"
  | "typeAmount"
  | "positionBySport"
  | "figureDate"
  | "graded"
  | "sortCustom";

export type ProbeWireContentType =
  "application/x-www-form-urlencoded; charset=UTF-8" | "application/json";

export type ProbeSuite = "report" | "manager-boot" | "all";

export interface ProbeOp {
  readonly operation: string;
  readonly method: "POST";
  /** False for operations gated behind `--include-unconfirmed`. */
  readonly readOnly: boolean;
  readonly note: string;
  /** Fields the client sends, read from `customer/report/report.js` or `app/manager/manager.js`. */
  readonly params: readonly ProbeParam[];
  /**
   * Wire Content-Type observed in client JS (`report.js:25633` for `getDailyFiguresByCustomer` and
   * `manager.js:31200` for `getAccountInfoOwner` use `application/json`; all others use form-urlencoded).
   */
  readonly wireContentType?: ProbeWireContentType;
  /** Default route prefix observed in client JS. */
  readonly defaultPrefix?:
    | "/cloud/api/Manager"
    | "/cloud/api/Report"
    | "/cloud/api/System"
    | "/cloud/api/Log";
}

export const PROBE_OPS: readonly ProbeOp[] = [
  {
    operation: "Pending",
    method: "POST",
    readOnly: true,
    note: "already in the capture allowlist as getPending",
    params: ["customerID", "token", "operation"],
    defaultPrefix: "/cloud/api/Report",
  },
  {
    operation: "getDailyFiguresByCustomer",
    method: "POST",
    readOnly: true,
    note: "daily figure report read; verified 200 with real customer (week is integer 0..N) (report.js:25633 sends contentType: application/json)",
    params: ["agentID", "customerID", "week", "token", "operation"],
    wireContentType: "application/json",
    defaultPrefix: "/cloud/api/Report",
  },
  {
    operation: "getGradedWagerByCustomer",
    method: "POST",
    readOnly: true,
    note: "graded wager report read",
    params: ["customerID", "week", "token", "operation"],
    defaultPrefix: "/cloud/api/Report",
  },
  {
    operation: "getTransactions",
    method: "POST",
    readOnly: true,
    note: "transaction report read; `date` is MM/DD/YYYY",
    params: ["customerID", "date", "token", "operation"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getTransactionList",
    method: "POST",
    readOnly: true,
    note: "customer-admin transactions tab (manager/module/customer-admin/transactions.html); days + type filter codes",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "days",
      "type",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getDeletedTransactionHistory",
    method: "POST",
    readOnly: true,
    note: "customer-admin Deleted/Changed filter; wire uses days=all&type=0 (UI label DELETED); returns LIST[] ledger rows",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "days",
      "type",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getInfoPlayer",
    method: "POST",
    readOnly: true,
    note: "customer-admin player info; wire omits token; Chrome manager.html sends RRO=0 with customerID/agentID/agentOwner",
    params: ["customerID", "agentID", "operation", "RRO", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getDeleteWager",
    method: "POST",
    readOnly: true,
    note: "manager delete-wager module (distinct from getReportDeletedTransactions wager report)",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "days",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getCryptoInfo",
    method: "POST",
    readOnly: true,
    note: "customer-admin player-info tab (manager/module/customer-admin/player-info.html)",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getMail",
    method: "POST",
    readOnly: true,
    note: "customer-admin player-info tab mail lookup",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getTeaserProfile",
    method: "POST",
    readOnly: true,
    note: "customer-admin player-info tab; Chrome wire: acc+operation+RRO+agentID+agentOwner (no token)",
    params: ["acc", "operation", "RRO", "agentID", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getPerformancePlayer",
    method: "POST",
    readOnly: true,
    note: "customer-admin performance tab (manager/module/customer-admin/performance.html)",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getWagersByFigureDate",
    method: "POST",
    readOnly: true,
    note: "customer-admin performance tab & daily-figures drill-down (report.js:46608,60279: customerID, figureDate, graded, operation, RRO)",
    params: ["customerID", "figureDate", "graded", "token", "operation", "RRO"],
    defaultPrefix: "/cloud/api/Report",
  },
  {
    operation: "getCasinoSummaryDetails",
    method: "POST",
    readOnly: true,
    note: "customer-admin performance tab casino summary details",
    params: [
      "agentID",
      "agentOwner",
      "customerID",
      "token",
      "operation",
      "RRO",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getGrading",
    method: "POST",
    readOnly: true,
    note: "grading report read; also settles the channel model",
    params: ["customerID", "token", "operation"],
    defaultPrefix: "/cloud/api/Report",
  },
  {
    operation: "getTicketDetailPrint",
    method: "POST",
    readOnly: true,
    note: "ticket detail read; needs a ticket/wager number (portal sends ticketNumber, wagerNumber, flag)",
    params: ["token", "ticketNumber", "wagerNumber", "flag", "operation"],
    defaultPrefix: "/cloud/api/Report",
  },
  {
    operation: "getListAgenstByAgent",
    method: "POST",
    readOnly: true,
    note: "agent list by agent (Manager envelope); form: agentID, agentType, operation, RRO, agentOwner",
    params: ["agentID", "agentType", "operation", "RRO", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getSportsVigSetup",
    method: "POST",
    readOnly: true,
    note: "vig setup read; Chrome wire customerID=* + sportType + agentID/agentOwner; tier A response 2026-10-31",
    params: [
      "customerID",
      "agentID",
      "sportType",
      "operation",
      "RRO",
      "agentOwner",
    ],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getSportsCustomerAdmin",
    method: "POST",
    readOnly: true,
    note: "customer-admin sports catalog read; Chrome wire operation+RRO+agentID+agentOwner (no customerID/token)",
    params: ["operation", "RRO", "agentID", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getAuthorizations",
    method: "POST",
    readOnly: true,
    note: "authorizations (Manager envelope); form: agentID, agentOwner, operation, RRO",
    params: ["agentID", "agentOwner", "operation", "RRO"],
  },
  {
    operation: "getConfigWebReports",
    method: "POST",
    readOnly: true,
    note: "web reports config (Manager envelope); form: agentID, operation, RRO, agentOwner",
    params: ["agentID", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "getConfigWebReportsPending",
    method: "POST",
    readOnly: true,
    note: "pending web reports config (Manager envelope); form: agentID, operation, RRO, agentOwner",
    params: ["agentID", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "getNewUsersInfo",
    method: "POST",
    readOnly: true,
    note: "new users info (Manager envelope); form: agentID, days, operation, RRO, agentOwner",
    params: ["agentID", "days", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "getConfigWebReportsCustomerAdmin",
    method: "POST",
    readOnly: true,
    note: "customer-admin web reports config (Manager envelope); form: agentID, operation, RRO, agentOwner",
    params: ["agentID", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "getCustomerAdmin",
    method: "POST",
    readOnly: true,
    note: "customer-admin player list/grid { LIST[] }; wire agentID+sortCustom+operation+RRO+agentOwner; sortCustom=2 + agentOwner=downline id scopes rows (e.g. CUB22HR)",
    params: ["agentID", "sortCustom", "operation", "RRO", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "updateReportConfigCustomerAdmin",
    method: "POST",
    readOnly: false,
    note: "MUTATION: persists customer-admin report config; requires --include-unconfirmed --i-understand-mutations",
    params: ["agentID", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "renewToken",
    method: "POST",
    readOnly: false,
    note: "token renewal (System prefix); returns a fresh JWT. Form: operation, agentID, agentOwner. Mutation-ish (rotates token).",
    params: ["operation", "agentID", "agentOwner"],
    defaultPrefix: "/cloud/api/System",
  },
  {
    operation: "getAccountInfo",
    method: "POST",
    readOnly: true,
    note: "UNVERIFIED: manager account info read (Manager envelope); form guessed: agentID, operation, RRO, agentOwner",
    params: ["agentID", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "write",
    method: "POST",
    readOnly: false,
    note: "MUTATION: manager view-transition audit log (POST /cloud/api/Log/write, application/json, customerID padded to 10); gated behind --include-unconfirmed",
    params: [
      "customerID",
      "description",
      "additional",
      "operation",
      "agentID",
      "agentOwner",
    ],
    wireContentType: "application/json",
    defaultPrefix: "/cloud/api/Log",
  },
  {
    operation: "getColorsSelections",
    method: "POST",
    readOnly: true,
    note: "color selections (Manager envelope); form: agentID, operation, RRO, agentOwner",
    params: ["agentID", "operation", "RRO", "agentOwner"],
  },
  {
    operation: "getSportsTypesLive",
    method: "POST",
    readOnly: true,
    note: "live sports types (Manager envelope); form: store, agentID, agentOwner, office, showGraded, operation, RRO",
    params: [
      "store",
      "agentID",
      "agentOwner",
      "office",
      "showGraded",
      "operation",
      "RRO",
    ],
  },
  {
    operation: "getPeriodsBySport",
    method: "POST",
    readOnly: true,
    note: "periods by sport (Manager envelope); form: sportType, operation, RRO, agentID, agentOwner",
    params: ["sportType", "operation", "RRO", "agentID", "agentOwner"],
  },
  {
    operation: "getProps",
    method: "POST",
    readOnly: true,
    note: "props list (Manager envelope); form: store, operation, RRO, agentID, agentOwner",
    params: ["store", "operation", "RRO", "agentID", "agentOwner"],
  },
  {
    operation: "getGames",
    method: "POST",
    readOnly: true,
    note: "games list (Manager envelope); captured body: sportTypeIn, sportSubTypeIn, periodDescriptionIn, periodNumberIn, storeIn, agentID, numberStart, numberEnd, filtro, operation, RRO, agentOwner. Verified 200 (empty array).",
    params: [
      "sportTypeIn",
      "sportSubTypeIn",
      "periodDescriptionIn",
      "periodNumberIn",
      "storeIn",
      "agentID",
      "numberStart",
      "numberEnd",
      "filtro",
      "operation",
      "RRO",
      "agentOwner",
    ],
  },
  {
    operation: "getGamesPosition",
    method: "POST",
    readOnly: true,
    note: "games position (Manager envelope); verified 200 (579799 B). Body adds sportTypeList, sportSubTypeList, typeAmount, positionBySport, storeAgent, filtro=O,I,H,C,X.",
    params: [
      "sportTypeIn",
      "sportSubTypeIn",
      "periodDescriptionIn",
      "periodNumberIn",
      "storeIn",
      "agentID",
      "numberStart",
      "numberEnd",
      "storeAgent",
      "filtro",
      "sportTypeList",
      "sportSubTypeList",
      "typeAmount",
      "positionBySport",
      "operation",
      "RRO",
      "agentOwner",
    ],
  },
  {
    operation: "PendingDelete",
    method: "POST",
    readOnly: false,
    note: "confirmed read-only modal lookup in report.js:8578 ({ customerID, ticketNumber, operation: 'PendingDelete' }); sends sentinel ticketNumber=-1 unless overridden",
    params: ["customerID", "ticketNumber", "token", "operation"],
    defaultPrefix: "/cloud/api/Report",
  },
] as const;

/** Wire name says "Delete" but client JS is a read-only Pending[] modal lookup (report.js:8578). */
export const CLIENT_JS_CONFIRMED_READ_ONLY_OPS = new Set<string>([
  "PendingDelete",
]);

/** Player-info tab calls use form field `acc` (padded customer id), not `customerID`. */
export const PROBE_ACC_IS_CUSTOMER_OPS = new Set<string>(["getTeaserProfile"]);

export function isProbeReadOnlyConfirmed(op: ProbeOp): boolean {
  return op.readOnly || CLIENT_JS_CONFIRMED_READ_ONLY_OPS.has(op.operation);
}

/**
 * Log/write pads `customerID` to 10 characters, per the manager boot waterfall.
 *
 * Contradicted on 2026-11-01: `Log/write`, `Log/writeDetail` and `vipListInsert` all sent the bare
 * 7-character login. Behaviour is unchanged because two observations disagree and this is probe
 * code, not a parser — see `docs/evidence/capture-requests.md` for the conflict.
 */
export function padLogWriteCustomerId(customerId: string): string {
  const trimmed = customerId.trim();
  if (trimmed.length >= LOG_WRITE_CUSTOMER_ID_WIDTH) {
    return trimmed.slice(0, LOG_WRITE_CUSTOMER_ID_WIDTH);
  }
  return trimmed.padEnd(LOG_WRITE_CUSTOMER_ID_WIDTH, " ");
}

/**
 * The 9 read-only `/cloud/api/Manager/*` operations fired on `manager.html?v=1793502037202` (`bust=1.0.280`) boot,
 * extracted from `app/manager/manager.js?bust=1.0.280` (`Blob 610B48F7F455B4D77131D88AD56832DFBB66A519`).
 */
export const MANAGER_BOOT_OPS: readonly ProbeOp[] = [
  {
    operation: "getAccountInfoOwner",
    method: "POST",
    readOnly: true,
    note: "manager account info (JSON body: agentID, operation, agentOwner); replaces non-existent getInfoManager",
    params: ["agentID", "operation", "agentOwner"],
    wireContentType: "application/json",
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getConfigWebReports",
    method: "POST",
    readOnly: true,
    note: "manager.js:35023 boot report configuration read -> s.INFO",
    params: ["agentID", "operation", "RRO"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getConfigWebReportsPending",
    method: "POST",
    readOnly: true,
    note: "manager.js:35534 boot pending report configuration read -> n.INFO",
    params: ["agentID", "operation", "RRO"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getSportsType",
    method: "POST",
    readOnly: true,
    note: "manager.js:33998 boot sports catalog list -> n.LIST",
    params: ["agentID", "agentOwner", "operation", "RRO"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getAuthorizations",
    method: "POST",
    readOnly: true,
    note: "manager.js:37628 boot agent permissions & distribution -> a.INFO, a.DISTRIBUTION",
    params: ["agentID", "agentOwner", "operation", "RRO"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getMessage",
    method: "POST",
    readOnly: true,
    note: "manager.js:55125 boot popup messages read -> t.COMMENT[]; replaces speculative System/getMessages",
    params: ["acc", "type", "operation", "RRO", "agentID", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getNewEmailsCount",
    method: "POST",
    readOnly: true,
    note: "manager.js:31845 boot unread message counter -> e.INFO.LIST, e.INFO.COUNT.total",
    params: ["acc", "operation", "RRO", "agentID", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getWeeklyFigureByAgentLite",
    method: "POST",
    readOnly: true,
    note: "manager.js:52703 boot weekly figure summary (populates grand-total-weekly & grand-total-player)",
    params: ["agentID", "week", "type", "layout", "operation", "RRO"],
    defaultPrefix: "/cloud/api/Manager",
  },
  {
    operation: "getListAgenstByAgent",
    method: "POST",
    readOnly: true,
    note: "manager.js getCompleteHeriarchy → POST getListAgenstByAgent (docs/evidence/manager-boot-hierarchy.md); replaces speculative getAgentTree",
    params: ["agentID", "agentType", "operation", "RRO", "agentOwner"],
    defaultPrefix: "/cloud/api/Manager",
  },
] as const;

export function selectProbeOps(
  includeUnconfirmed: boolean,
  suite: ProbeSuite = "report",
): readonly ProbeOp[] {
  let pool: readonly ProbeOp[];
  if (suite === "manager-boot") {
    pool = MANAGER_BOOT_OPS;
  } else if (suite === "all") {
    const byName = new Map<string, ProbeOp>();
    for (const op of PROBE_OPS) byName.set(op.operation, op);
    for (const op of MANAGER_BOOT_OPS) {
      if (!byName.has(op.operation)) byName.set(op.operation, op);
    }
    pool = [...byName.values()];
  } else {
    pool = PROBE_OPS;
  }
  return includeUnconfirmed ? pool : pool.filter((op) => op.readOnly);
}

export interface ProbeRequest {
  readonly operation: string;
  readonly url: string;
  readonly body: string;
  readonly contentType?: ProbeWireContentType;
}

/**
 * Build the in-page expression.
 *
 * Runs in the page context on purpose: the session cookie is HttpOnly, so the browser must attach it.
 * `JSON.stringify` carries the URL/body into the expression so quotes and newlines cannot break it.
 * Supports both `application/x-www-form-urlencoded; charset=UTF-8` (default) and `application/json`
 * (used by `getDailyFiguresByCustomer` in `report.js:25633` and `getAccountInfoOwner` in `manager.js:31200`).
 */
export function buildProbeExpression(
  request: ProbeRequest,
  previewChars = 2_000,
  weekValue?: string,
): string {
  const url = JSON.stringify(request.url);
  const body = JSON.stringify(request.body);
  const preview = Math.max(0, Math.trunc(previewChars));
  const contentType =
    request.contentType ?? "application/x-www-form-urlencoded; charset=UTF-8";
  const isJson = contentType === "application/json";
  const replaceExpr = isJson
    ? `${body}
    .replaceAll("__CUSTOMER_ID__", customerID)
    .replaceAll("__DATE__", mdy)
    .replaceAll("__WEEK__", weekValueResolved)`
    : `${body}
    .replaceAll("__CUSTOMER_ID__", encodeURIComponent(customerID))
    .replaceAll("__DATE__", encodeURIComponent(mdy))
    .replaceAll("__WEEK__", encodeURIComponent(weekValueResolved))`;

  return `(async () => {
  // The edge wants the token the app stored after login. Read it in-page: it never crosses into Bun.
  ${inPageReadSessionAuthJs()}
  ${inPageCloudApiHeadersJs(contentType)}
  // Yesterday: today's date is not a settled day for this endpoint (it answers 500).
  const now = new Date(Date.now() - 86_400_000);
  const mdy = String(now.getMonth() + 1).padStart(2, "0") + "/" + String(now.getDate()).padStart(2, "0") + "/" + now.getFullYear();
  // Optional week override: an integer index, a date string, or any candidate the probe wants to try.
  // The portal's own client sends an integer week index (0 = current week, 1..N weeks ago),
  // not a date string. Default to "0"; a caller may override with --week.
  const weekOverride = ${JSON.stringify(weekValue ?? "")};
  const weekValueResolved = weekOverride !== "" ? weekOverride : "0";
  let resolvedBody = ${replaceExpr};
  ${inPageInjectWireTokenJs(isJson)}
  const response = await fetch(${url}, {
    method: "POST",
    credentials: "include",
    headers,
    body: resolvedBody,
  });
  // Deterministic DOM markers: version from [data-field="version"], origin from [data-field="domain-me"].
  // These ride in the same response the caller captured, so the record can compare the runtime against
  // the spec instead of trusting a JS bundle hash or a static origin config.
  const versionEl = document.querySelector('[data-field="version"]');
  const domVersion = versionEl ? (versionEl.textContent ?? "").trim() : "";
  const domainEl = document.querySelector('[data-field="domain-me"]');
  const domOrigin = domainEl ? (domainEl.textContent ?? "").trim() : "";
  let challengePresent = false;
  let cfRay = "";
  try {
    const cfParams = window.__CF$cv$params;
    if (cfParams && typeof cfParams === "object" && cfParams.r) {
      challengePresent = true;
      cfRay = String(cfParams.r);
    }
  } catch {}
  if (!challengePresent) {
    const edgeScripts = document.querySelectorAll('script[src*="/cdn-cgi/"]');
    if (edgeScripts.length > 0) challengePresent = true;
  }
  ${inPageCollectResponseHeadersJs(false)}
  if (cfRayHeader) cfRay = cfRay || cfRayHeader;
  // Read bytes once. Binary responses (image/pdf/octet-stream) are wrapped in a Blob so callers
  // can inspect type/size without decoding garbage as text; preview/bodyText stay empty.
  const buffer = new Uint8Array(await response.arrayBuffer());
  const respContentType = responseHeaders["content-type"] ?? "";
  const isBinaryResp = new RegExp("^(image/|audio/|video/|application/(pdf|octet-stream|zip|gzip))", "i").test(respContentType);
  let previewText = "";
  let bodyTextOut = "";
  let blobTypeOut = "";
  let blobSizeOut = 0;
  if (isBinaryResp) {
    const blob = new Blob([buffer], { type: respContentType.split(";")[0].trim() });
    blobTypeOut = blob.type;
    blobSizeOut = blob.size;
  } else {
    const decoder = new TextDecoder();
    previewText = decoder.decode(buffer.subarray(0, ${preview}));
    bodyTextOut = decoder.decode(buffer);
  }
  return {
    status: response.status,
    contentType: respContentType,
    bytes: buffer.byteLength,
    preview: previewText,
    bodyText: bodyTextOut,
    dateUsed: mdy,
    weekUsed: weekValueResolved,
    isBinary: isBinaryResp,
    blobType: blobTypeOut,
    blobSize: blobSizeOut,
    ...(domVersion === "" ? {} : { domVersion }),
    ...(domOrigin === "" ? {} : { domOrigin }),
    challengePresent,
    ...(cfRay === "" ? {} : { cfRay }),
    ...(cfRayHeader === "" ? {} : { cfRayFromHeader: cfRayHeader }),
    responseHeaders,
    sessionCustomerPresent: customerID !== "",
    sessionCredentialsCodePresent: token !== "",
    sessionAgentType: String(sessionStorage.getItem("agentType") ?? ""),
    sessionIsAgent:
      sessionStorage.getItem("agentType") === "M" ||
      sessionStorage.getItem("agentType") === "A",
    requestBodyTokenInjected:
      token !== "" &&
      (/(^|&)token=[^&]+/.test(resolvedBody) && !/(^|&)token=(&|$)/.test(resolvedBody)),
  };
})()`;
}

export interface SniffedFormTemplate {
  readonly path: string;
  readonly method: string;
  readonly formKeys: readonly string[];
}

/**
 * In-page `XMLHttpRequest` + `fetch` sniffer expression for WebKit and Chrome.
 *
 * Because `backend: "webkit"` (`WKWebView`) has no CDP bridge, this hook intercepts outbound
 * `/cloud/api/` calls directly inside the page and records **only** the URL pathname, HTTP method,
 * and sorted URL-encoded or JSON top-level parameter names (`formKeys`) — parameter values never leave the page.
 */
export function buildInstallRequestSnifferExpression(): string {
  return `(() => {
  if (window.__f402SnifferInstalled) return true;
  window.__f402SnifferInstalled = true;
  window.__f402SniffedRequests = window.__f402SniffedRequests || [];
  const parseKeys = (raw) => {
    if (typeof raw !== "string" || raw.trim() === "") return [];
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          return Object.keys(obj).map((k) => k.trim()).filter(Boolean).sort();
        }
      } catch {}
    }
    const out = new Set();
    for (const [k] of new URLSearchParams(raw)) {
      if (k.trim() !== "") out.add(k.trim());
    }
    return Array.from(out).sort();
  };
  const record = (rawUrl, rawMethod, rawBody) => {
    try {
      const parsed = new URL(String(rawUrl), location.origin);
      if (parsed.pathname.startsWith("/cdn-cgi/")) return;
      if (!parsed.pathname.includes("/cloud/api/")) return;
      window.__f402SniffedRequests.push({
        path: parsed.pathname,
        method: String(rawMethod || "POST").toUpperCase(),
        formKeys: parseKeys(rawBody),
      });
    } catch {}
  };
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (method, url) {
    this.__f402Method = method;
    this.__f402Url = url;
    return origOpen.apply(this, arguments);
  };
  proto.send = function (body) {
    record(this.__f402Url, this.__f402Method, typeof body === "string" ? body : "");
    return origSend.apply(this, arguments);
  };
  if (typeof window.fetch === "function") {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      const body = init && typeof init.body === "string" ? init.body : "";
      record(url, method, body);
      return origFetch.apply(this, arguments);
    };
  }
  return true;
})()`;
}

/** Read the in-page sniffed `/cloud/api/` request templates collected on WebKit or Chrome. */
export function buildReadRequestSnifferExpression(): string {
  return `(() => Array.isArray(window.__f402SniffedRequests) ? window.__f402SniffedRequests : [])()`;
}

/** Validate and deduplicate sniffed form templates returned from the page or CDP. */
export function parseSniffedTemplates(raw: unknown): SniffedFormTemplate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SniffedFormTemplate[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const path = candidate["path"];
    const method = candidate["method"];
    const formKeys = candidate["formKeys"];
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("/cdn-cgi/") ||
      typeof method !== "string" ||
      !Array.isArray(formKeys) ||
      !formKeys.every((key) => typeof key === "string")
    ) {
      continue;
    }
    const sortedKeys = [...(formKeys as string[])].sort();
    const signature = `${method.toUpperCase()} ${path} ${sortedKeys.join(",")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({
      path,
      method: method.toUpperCase(),
      formKeys: sortedKeys,
    });
  }
  return out;
}

interface ProbePageResultBase {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly preview: string;
  readonly bodyText?: string;
  readonly dateUsed?: string;
  readonly weekUsed?: string;
  /** DOM-extracted version marker (e.g. `"1.0.280"` from `data-field="version"`). Empty when absent. */
  readonly domVersion?: string;
  /** DOM-extracted origin marker (e.g. `"www.fantasy402.com"` from `data-field="domain-me"`). Empty when absent. */
  readonly domOrigin?: string;
  readonly challengePresent?: boolean;
  /** Cloudflare Ray ID from response `Cf-Ray` or `window.__CF$cv$params.r`. */
  readonly cfRay?: string;
  /** Cloudflare Ray ID specifically read from the `Cf-Ray` HTTP response header. */
  readonly cfRayFromHeader?: string;
  /** Observed HTTP response headers (`cf-ray`, `content-type`) from the in-page `fetch()` Response. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** True when `sessionStorage.credentials.customerID` was non-empty before the fetch. */
  readonly sessionCustomerPresent?: boolean;
  /** True when `sessionStorage.credentials.code` (Bearer) was non-empty before the fetch. */
  readonly sessionCredentialsCodePresent?: boolean;
  readonly sessionAgentType?: string;
  readonly sessionIsAgent?: boolean;
  readonly requestBodyTokenInjected?: boolean;
}

export interface TextProbeResult extends ProbePageResultBase {
  readonly isBinary: false;
}

export interface BinaryProbeResult extends ProbePageResultBase {
  readonly isBinary: true;
  /** Blob MIME type, from the response content-type. */
  readonly blobType: string;
  /** Blob byte size (equals bytes). */
  readonly blobSize: number;
}

/**
 * Text and binary payloads are distinct variants: a binary result always carries
 * blobType/blobSize and an empty preview, so `isBinary: true` without them (or vice versa)
 * does not compile.
 */
export type ProbePageResult = TextProbeResult | BinaryProbeResult;

/** Validate what came back from the page before it is written as evidence. */
export function parseProbePageResult(raw: unknown): ProbePageResult {
  if (typeof raw !== "object" || raw === null)
    throw new Error("probe returned no object");
  const candidate = raw as Record<string, unknown>;
  const status = candidate["status"];
  const contentType = candidate["contentType"];
  const bytes = candidate["bytes"];
  const preview = candidate["preview"];
  const bodyText = candidate["bodyText"];
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100) {
    throw new Error("probe result has no HTTP status");
  }
  if (typeof contentType !== "string")
    throw new Error("probe result has no content type");
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
    throw new Error("probe result has no byte count");
  }
  if (typeof preview !== "string")
    throw new Error("probe result has no body preview");
  const dateUsed = candidate["dateUsed"];
  const weekUsed = candidate["weekUsed"];
  const domVersion = candidate["domVersion"];
  const domOrigin = candidate["domOrigin"];
  const challengePresent = candidate["challengePresent"];
  const cfRay = candidate["cfRay"];
  const cfRayFromHeader = candidate["cfRayFromHeader"];
  const rawResponseHeaders = candidate["responseHeaders"];
  let responseHeaders: Record<string, string> | undefined;
  if (
    typeof rawResponseHeaders === "object" &&
    rawResponseHeaders !== null &&
    !Array.isArray(rawResponseHeaders)
  ) {
    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      rawResponseHeaders as Record<string, unknown>,
    )) {
      if (typeof v === "string") cleanHeaders[k.toLowerCase()] = v;
    }
    responseHeaders = cleanHeaders;
  }
  const sessionCustomerPresent = candidate["sessionCustomerPresent"];
  const sessionCredentialsCodePresent =
    candidate["sessionCredentialsCodePresent"];
  const sessionAgentType = candidate["sessionAgentType"];
  const sessionIsAgent = candidate["sessionIsAgent"];
  const requestBodyTokenInjected = candidate["requestBodyTokenInjected"];
  const base = {
    status,
    contentType,
    bytes,
    preview,
    ...(typeof bodyText === "string" ? { bodyText } : {}),
    ...(typeof dateUsed === "string" ? { dateUsed } : {}),
    ...(typeof weekUsed === "string" ? { weekUsed } : {}),
    ...(typeof domVersion === "string" && domVersion !== ""
      ? { domVersion }
      : {}),
    ...(typeof domOrigin === "string" && domOrigin !== "" ? { domOrigin } : {}),
    ...(challengePresent === true ? { challengePresent: true } : {}),
    ...(typeof cfRay === "string" && cfRay !== "" ? { cfRay } : {}),
    ...(typeof cfRayFromHeader === "string" && cfRayFromHeader !== ""
      ? { cfRayFromHeader }
      : {}),
    ...(responseHeaders !== undefined ? { responseHeaders } : {}),
    ...(sessionCustomerPresent === true
      ? { sessionCustomerPresent: true }
      : {}),
    ...(sessionCredentialsCodePresent === true
      ? { sessionCredentialsCodePresent: true }
      : {}),
    ...(typeof sessionAgentType === "string" && sessionAgentType !== ""
      ? { sessionAgentType }
      : {}),
    ...(sessionIsAgent === true ? { sessionIsAgent: true } : {}),
    ...(requestBodyTokenInjected === true
      ? { requestBodyTokenInjected: true }
      : {}),
  };
  // Old scratch files predate blob metadata; missing means text.
  if (candidate["isBinary"] === true) {
    const blobType = candidate["blobType"];
    const blobSize = candidate["blobSize"];
    if (typeof blobType !== "string" || blobType === "")
      throw new Error("binary probe result has no blob type");
    if (
      typeof blobSize !== "number" ||
      !Number.isInteger(blobSize) ||
      blobSize < 0
    )
      throw new Error("binary probe result has no blob size");
    return { ...base, isBinary: true as const, blobType, blobSize };
  }
  return { ...base, isBinary: false as const };
}

export type ProbeVerdict = "exists" | "denied" | "missing" | "error";

export function probeVerdict(status: number): ProbeVerdict {
  if (status >= 200 && status < 300) return "exists";
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || status === 405) return "missing";
  return "error";
}

export function probeSummary(
  op: ProbeOp,
  result: ProbePageResult,
): { operation: string; verdict: ProbeVerdict; status: number; bytes: number } {
  return {
    operation: op.operation,
    verdict: probeVerdict(result.status),
    status: result.status,
    bytes: result.bytes,
  };
}

/**
 * Observed envelope from the 2026-10-31 captures: every Manager call is
 * `/cloud/api/Manager/<operation>`. The report names came from a third-party toolkit without that
 * prefix, so `/cloud/api/Report/<operation>` is the second candidate to test.
 */
export const PROBE_PREFIXES = [
  "/cloud/api/Manager",
  "/cloud/api/Report",
  "/cloud/api/System",
] as const;

export interface ProbeBodyOptions {
  readonly ticketNumber?: string;
  readonly wagerNumber?: string;
  readonly flag?: string;
  readonly type?: string;
  readonly layout?: string;
  readonly days?: string;
  readonly description?: string;
  readonly additional?: string;
  readonly sportType?: string;
  readonly sortCustom?: string;
  readonly agentOwner?: string;
}

function resolveParamMap(
  op: ProbeOp,
  agentId: string,
  customerId?: string,
  options: ProbeBodyOptions = {},
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const name of op.params) {
    if (name === "operation") {
      out[name] = op.operation;
    } else if (name === "agentID") {
      out[name] = agentId;
    } else if (name === "agentOwner") {
      out[name] =
        options.agentOwner !== undefined && options.agentOwner !== ""
          ? options.agentOwner
          : agentId;
    } else if (name === "acc") {
      out[name] = PROBE_ACC_IS_CUSTOMER_OPS.has(op.operation)
        ? customerId !== undefined && customerId !== ""
          ? customerId
          : "__CUSTOMER_ID__"
        : agentId;
    } else if (name === "token") {
      out[name] = "";
    } else if (name === "customerID") {
      if (op.operation === "getSportsVigSetup") {
        out[name] = "*";
      } else {
        const raw =
          customerId !== undefined && customerId !== ""
            ? customerId
            : "__CUSTOMER_ID__";
        out[name] =
          op.operation === "write" && raw !== "__CUSTOMER_ID__"
            ? padLogWriteCustomerId(raw)
            : raw;
      }
    } else if (name === "date") {
      out[name] = "__DATE__";
    } else if (name === "week") {
      out[name] = "__WEEK__";
    } else if (name === "ticketNumber") {
      out[name] =
        options.ticketNumber ?? (op.operation === "PendingDelete" ? "-1" : "0");
    } else if (name === "wagerNumber") {
      out[name] = options.wagerNumber ?? "0";
    } else if (name === "flag") {
      out[name] = options.flag ?? "";
    } else if (name === "agentType") {
      out[name] = "M";
    } else if (name === "type") {
      out[name] =
        options.type ??
        (op.operation === "getWeeklyFigureByAgentLite"
          ? "A"
          : op.operation === "getTransactionList"
            ? "E-I-C-D-Z-Q-B-N"
            : "0");
    } else if (name === "layout") {
      out[name] = options.layout ?? "byDay";
    } else if (name === "RRO") {
      out[name] = op.operation === "getInfoPlayer" ? "0" : "1";
    } else if (name === "days") {
      out[name] =
        options.days ??
        (op.operation === "getTransactionList" ||
        op.operation === "getDeletedTransactionHistory" ||
        op.operation === "getDeleteWager"
          ? "all"
          : "7");
    } else if (name === "description") {
      out[name] = options.description ?? "probe";
    } else if (name === "additional") {
      out[name] = options.additional ?? "";
    } else if (name === "store") {
      out[name] = "Master";
    } else if (name === "office") {
      out[name] = agentId;
    } else if (name === "showGraded") {
      out[name] = "false";
    } else if (name === "sportType") {
      out[name] = options.sportType ?? "Football";
    } else if (name === "sportTypeIn") {
      out[name] = "Football";
    } else if (name === "sportSubTypeIn") {
      out[name] = "NFL";
    } else if (name === "periodDescriptionIn") {
      out[name] = "Game";
    } else if (name === "periodNumberIn") {
      out[name] = "0";
    } else if (name === "storeIn") {
      out[name] = "Master";
    } else if (name === "numberStart") {
      out[name] = "24";
    } else if (name === "numberEnd") {
      out[name] = "24";
    } else if (name === "filtro") {
      out[name] = "O,I,H";
    } else if (name === "storeAgent") {
      out[name] = "";
    } else if (name === "sportTypeList") {
      out[name] = "Football";
    } else if (name === "sportSubTypeList") {
      out[name] = "";
    } else if (name === "typeAmount") {
      out[name] = "2";
    } else if (name === "positionBySport") {
      out[name] = "true";
    } else if (name === "figureDate") {
      out[name] = "__DATE__";
    } else if (name === "graded") {
      out[name] = "1";
    } else if (name === "sortCustom") {
      out[name] = options.sortCustom ?? "1";
    } else {
      // Compile-time exhaustiveness: adding a ProbeParam variant without a case
      // fails the build here instead of silently dropping the field from every body.
      const _exhaustive: never = name;
      throw new Error(`unhandled probe param: ${_exhaustive}`);
    }
  }
  return out;
}

/**
 * Build the URL-encoded form body from the fields the client sends.
 *
 * `customerID`, `date` and `week` stay as placeholders: the page resolves them from sessionStorage and
 * the local date, so the value never has to cross into Bun. `token` is empty because `Security.token`
 * is empty in the browser session — the edge accepts the bearer instead.
 */
export function buildProbeBody(
  op: ProbeOp,
  agentId: string,
  customerId?: string,
  options: ProbeBodyOptions = {},
): string {
  const params = new URLSearchParams();
  const map = resolveParamMap(op, agentId, customerId, options);
  for (const [key, val] of Object.entries(map)) {
    params.set(key, String(val));
  }
  return params.toString();
}

/**
 * Build the JSON body for operations that specify `contentType: "application/json"` in client JS
 * (`getDailyFiguresByCustomer` in `report.js:25633` and `getAccountInfoOwner` in `manager.js:31200`).
 */
export function buildJsonProbeBody(
  op: ProbeOp,
  agentId: string,
  customerId?: string,
  options: ProbeBodyOptions = {},
): string {
  const map = resolveParamMap(op, agentId, customerId, options);
  // In report.js:25633 (`getDailyFiguresByCustomer`), `token` is not part of the JSON object `d`.
  if (op.operation === "getDailyFiguresByCustomer") {
    delete map["token"];
  }
  return JSON.stringify(map);
}

/** Absolute probe URL from a portal base and a route prefix; rejects non-http(s) bases. */
export function probeUrl(
  base: string,
  op: ProbeOp,
  prefix: string = PROBE_PREFIXES[0],
): string {
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`probe base must be http(s), got ${parsed.protocol}`);
  }
  if (!prefix.startsWith("/"))
    throw new Error(`probe prefix must start with /, got ${prefix}`);
  const root = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  return `${root}${prefix.replace(/\/$/, "")}/${op.operation}`;
}
