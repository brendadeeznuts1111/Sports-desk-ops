/**
 * Shared in-page fetch header + session auth snippets for F402 /cloud/api/* calls.
 * Serialized into WebView evaluate expressions (browser context, not Bun).
 */

/** Chrome DevTools request headers for Manager/Report XHR (e.g. getDeletedTransactionHistory). */
export const F402_WIRE_ACCEPT = "*/*" as const;

/** @deprecated use F402_WIRE_ACCEPT */
export const F402_CLOUD_API_ACCEPT = F402_WIRE_ACCEPT;

/**
 * Browser sends `Accept-Encoding` automatically (gzip, deflate, br, zstd); fetch decodes the body.
 * Not set on the in-page `headers` object passed to fetch().
 */
export const F402_ACCEPT_ENCODING_BROWSER_DEFAULT =
  "gzip, deflate, br, zstd" as const;

export const F402_ACCEPT_LANGUAGE_BROWSER_DEFAULT = "en-US,en;q=0.9" as const;

/**
 * Response headers to snapshot from `Response.headers` on F402 /cloud/api/* (DevTools Network).
 */
export const F402_RESPONSE_HEADER_NAMES = [
  "cf-ray",
  "cf-cache-status",
  "content-type",
  "content-encoding",
  "date",
  "server",
  "vary",
  "x-auth-userid",
  "x-frame-options",
  "x-server",
  "strict-transport-security",
] as const;

export const F402_FORM_WIRE_CONTENT_TYPE =
  "application/x-www-form-urlencoded; charset=UTF-8" as const;

export interface RedactedDevToolsRequestOptions {
  readonly baseUrl: string;
  readonly path: string;
  readonly contentType: string;
  readonly tokenPresent: boolean;
  readonly refererPath?: string;
}

export interface RequestHeaderProtocolVariants {
  /** Chrome HTTP/2 `:authority` / `:method` / `:path` / `:scheme` view. */
  readonly http2: Record<string, string>;
  /** HTTP/1.1 wire spelling (Host + request-target); same semantics, different names. */
  readonly http1: Record<string, string>;
}

/**
 * Headers the probe sets on `fetch(..., { headers })` (secrets redacted).
 */
export function redactedInPageRequestHeaders(
  contentType: string,
  tokenPresent: boolean,
): Record<string, string> {
  return {
    accept: F402_WIRE_ACCEPT,
    "content-type": contentType,
    "x-requested-with": "XMLHttpRequest",
    ...(tokenPresent ? { authorization: "Bearer <redacted>" } : {}),
  };
}

/**
 * DevTools-shaped request view for artifacts: explicit fetch headers plus redacted
 * browser-added fields (cookie, sec-fetch-*, origin, referer, accept-encoding, …).
 */
function sharedRedactedRequestFields(
  options: RedactedDevToolsRequestOptions,
): Record<string, string> {
  const origin = new URL(options.baseUrl).origin;
  const referer = options.refererPath ?? `${origin}/manager.html?v=<session>`;
  return {
    accept: F402_WIRE_ACCEPT,
    "accept-encoding": F402_ACCEPT_ENCODING_BROWSER_DEFAULT,
    "accept-language": F402_ACCEPT_LANGUAGE_BROWSER_DEFAULT,
    ...(options.tokenPresent ? { authorization: "Bearer <redacted>" } : {}),
    "content-type": options.contentType,
    cookie: "<redacted>",
    origin,
    referer,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "<browser>",
    "x-requested-with": "XMLHttpRequest",
  };
}

export function redactedRequestHeaderProtocolVariants(
  options: RedactedDevToolsRequestOptions,
): RequestHeaderProtocolVariants {
  const authority = new URL(options.baseUrl).host;
  const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const shared = sharedRedactedRequestFields(options);
  return {
    http2: {
      ":authority": authority,
      ":method": "POST",
      ":path": path,
      ":scheme": "https",
      ...shared,
    },
    http1: {
      host: authority,
      "request-target": `POST ${path} HTTP/1.1`,
      ...shared,
    },
  };
}

/** HTTP/2 DevTools view (alias of {@link redactedRequestHeaderProtocolVariants}.http2). */
export function redactedDevToolsRequestHeaders(
  options: RedactedDevToolsRequestOptions,
): Record<string, string> {
  return redactedRequestHeaderProtocolVariants(options).http2;
}

/** API route prefixes to compare (Manager is canonical for customer-admin). */
export const F402_API_PREFIXES = [
  "/cloud/api/Manager",
  "/cloud/api/Report",
  "/cloud/api/System",
] as const;

export interface ProtocolMatrixItem {
  readonly prefix: string;
  readonly operation: string;
  readonly body: string;
}

/**
 * In-page sweep: same POST body, different `/cloud/api/{Manager|Report|System}/<op>` URLs.
 */
export function buildApiPrefixMatrixExpression(
  baseUrl: string,
  items: readonly ProtocolMatrixItem[],
  contentType: string = F402_FORM_WIRE_CONTENT_TYPE,
): string {
  const origin = JSON.stringify(new URL(baseUrl).origin);
  const itemsLit = JSON.stringify(items);
  const isJson = contentType === "application/json";
  return `(async () => {
  ${inPageReadSessionAuthJs()}
  ${inPageCloudApiHeadersJs(contentType)}
  const origin = ${origin};
  const matrix = ${itemsLit};
  const results = [];
  for (const row of matrix) {
    const path = (row.prefix.replace(/\\/$/, "") + "/" + row.operation).replace(/^\\/+/, "/");
    const url = origin + path;
    let resolvedBody = row.body;
    ${inPageInjectWireTokenJs(isJson)}
    let status = 0;
    let bodyText = "";
    let responseHeaders = {};
    let cfRay = "";
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: resolvedBody,
      });
      status = response.status;
      bodyText = await response.text();
      ${inPageCollectResponseHeadersJs(true)}
    } catch (err) {
      bodyText = String(err && err.message ? err.message : err);
    }
    results.push({
      prefix: row.prefix,
      operation: row.operation,
      url,
      status,
      bytes: bodyText.length,
      cfRay,
      responseHeaders,
      bodySample: bodyText.slice(0, 200),
    });
  }
  return results;
})()`;
}

/** Read bearer token + effective customerID from sessionStorage (report customer wins). */
export function inPageReadSessionAuthJs(): string {
  return `let token = (sessionStorage.getItem("token") ?? "").trim();
  let customerID = "";
  try {
    const credentials = JSON.parse(sessionStorage.getItem("credentials") ?? "{}");
    if (!token) token = (credentials.code ?? "").trim();
    customerID = credentials.customerID ?? "";
    const reportCustomer = (sessionStorage.getItem("customerID") ?? "").trim();
    if (reportCustomer) customerID = reportCustomer;
  } catch {}`;
}

/** Portal AJAX headers; mutates when token is set (call after inPageReadSessionAuthJs). */
export function inPageCloudApiHeadersJs(contentType: string): string {
  return `const headers = {
    accept: ${JSON.stringify(F402_WIRE_ACCEPT)},
    "content-type": ${JSON.stringify(contentType)},
    "x-requested-with": "XMLHttpRequest",
  };
  if (token) headers.authorization = "Bearer " + token;`;
}

/** Merge session token into form or JSON wire body (mutates resolvedBody). */
export function inPageInjectWireTokenJs(isJson: boolean): string {
  if (isJson) {
    return `if (token && ${isJson}) {
    try {
      const parsed = JSON.parse(resolvedBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parsed.token = token;
        resolvedBody = JSON.stringify(parsed);
      }
    } catch {}
  }`;
  }
  return `if (token && !${isJson}) {
    resolvedBody = /(^|&)token=[^&]*/.test(resolvedBody)
      ? resolvedBody.replace(/(^|&)token=[^&]*/, "$1token=" + encodeURIComponent(token))
      : resolvedBody + "&token=" + encodeURIComponent(token);
  }`;
}

/** In-page loop: copy observed F402 response headers into a plain object (lowercase keys). */
export function inPageCollectResponseHeadersJs(assign = false): string {
  const namesLit = JSON.stringify([...F402_RESPONSE_HEADER_NAMES]);
  const decl = assign ? "responseHeaders = {}" : "const responseHeaders = {}";
  const cfRayFromMap = assign
    ? 'cfRay = (responseHeaders["cf-ray"] ?? "").trim();'
    : 'const cfRayHeader = (responseHeaders["cf-ray"] ?? "").trim();';
  return `${decl};
  for (const name of ${namesLit}) {
    const v = response.headers.get(name);
    if (v !== null && String(v).trim() !== "") responseHeaders[name] = String(v);
  }
  ${cfRayFromMap}`;
}

/** @deprecated alias */
export function inPageReadResponseHeaderMetaJs(assign = false): string {
  return inPageCollectResponseHeadersJs(assign);
}
