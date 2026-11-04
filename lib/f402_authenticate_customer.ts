/**
 * @file f402_authenticate_customer.ts
 * @description Live HTTP bearer mint via `POST /cloud/api/System/authenticateCustomer`.
 *
 * The request shape is not the one in the OpenAPI draft: the manager login bundle
 * (`verification/manager-boot-oracle/pinned/security.js`) posts **JSON**, uppercases both
 * credentials, and sends `operation: "authenticateCustomer"` with `response_type: "code"`.
 * Measured live on 2026-11-04: 200, `code` is an HS256 JWT with a 1200 s `exp` claim; that JWT is
 * accepted by `/cloud/api/System/renewToken` and by `/cloud/api/Report/Pending` (customer-scoped).
 *
 * The token is returned to the caller and never logged; errors carry the HTTP status and a short
 * server `msg` (when JSON) but never the password or the token.
 *
 * @see docs/analysis/bridge3-authenticate-customer-capture.md
 */

import { validateF402Token } from "./f402_pending_fetch.ts";

const DEFAULT_BASE_URL = "https://www.fantasy402.com";
const DEFAULT_TIMEOUT_MS = 25_000;

export class F402AuthenticateCustomerError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "F402AuthenticateCustomerError";
    this.status = status;
  }
}

export interface AuthenticateCustomerOptions {
  readonly agentId: string;
  readonly password: string;
  readonly baseUrl?: string;
  /** Injectable for tests; defaults to global `fetch`. */
  readonly fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export interface AuthenticateCustomerResult {
  /** Raw JWT. Never log this field. */
  readonly token: string;
  readonly tokenChars: number;
  readonly expiresAtIso: string | null;
  readonly expiresInSec: number | null;
  /** Agent/customer identifiers from `accountInfo`; safe to log (no secret). */
  readonly customerIdChars: number | null;
  readonly agentTypeChars: number | null;
}

/** `www.` and port stripped: the portal expects the bare domain in `domain`/`redirect_uri`. */
export function domainFromBaseUrl(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  return host.replace(/^www\./i, "");
}

/** The exact body the manager login bundle builds (field order preserved for the shape test). */
export function authenticateCustomerBody(
  agentId: string,
  password: string,
  domain: string,
): Record<string, unknown> {
  const user = agentId.toLocaleUpperCase().trim();
  return {
    customerID: user,
    state: true,
    password: password.toLocaleUpperCase().trim(),
    sufix: "",
    prefix: "",
    multiaccount: 0,
    response_type: "code",
    client_id: user,
    domain,
    redirect_uri: domain,
    token: "",
    operation: "authenticateCustomer",
    RRO: 1,
  };
}

/** Decode a JWT payload without verifying the signature; returns null when malformed. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const segment = token.split(".")[1];
    if (segment === undefined || segment === "") return null;
    const json = Buffer.from(
      segment.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Short, printable server message; never a token. */
function safeServerMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text === "" || text.length > 80) return "";
  return /^[\x20-\x7E]+$/.test(text) ? text : "";
}

function tokenExpiry(token: string): {
  expiresAtIso: string | null;
  expiresInSec: number | null;
} {
  const payload = decodeJwtPayload(token);
  const exp = payload?.["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return { expiresAtIso: null, expiresInSec: null };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    expiresAtIso: new Date(exp * 1000).toISOString(),
    expiresInSec: exp - nowSec,
  };
}

/**
 * Mint one agent bearer over HTTP. No WebView, no cookie session; the caller owns the token.
 * Throws `F402AuthenticateCustomerError` on a non-200 response, a missing/invalid `code`, or a
 * network failure — never with the password or token in the message.
 */
export async function authenticateCustomer(
  options: AuthenticateCustomerOptions,
): Promise<AuthenticateCustomerResult> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const agentId = options.agentId.trim();
  const password = options.password.trim();
  if (agentId === "" || password === "") {
    throw new F402AuthenticateCustomerError(
      "missing F402 agent id or password for authenticateCustomer",
    );
  }
  const domain = domainFromBaseUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(
      `${baseUrl}/cloud/api/System/authenticateCustomer`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/javascript, */*; q=0.01",
          "x-requested-with": "XMLHttpRequest",
          origin: baseUrl,
          referer: `${baseUrl}/manager-tools`,
        },
        body: JSON.stringify(
          authenticateCustomerBody(agentId, password, domain),
        ),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw new F402AuthenticateCustomerError(
      `authenticateCustomer request failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  const record =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;

  if (response.status !== 200) {
    const msg = safeServerMessage(record?.["msg"]);
    throw new F402AuthenticateCustomerError(
      `authenticateCustomer returned HTTP ${response.status}${msg === "" ? "" : `: ${msg}`}`,
      response.status,
    );
  }
  if (record === null) {
    throw new F402AuthenticateCustomerError(
      "authenticateCustomer returned a non-JSON body",
      response.status,
    );
  }
  const code = record["code"];
  if (typeof code !== "string") {
    throw new F402AuthenticateCustomerError(
      "authenticateCustomer response has no `code` token",
      response.status,
    );
  }
  const token = validateF402Token(code);
  if (token === null) {
    throw new F402AuthenticateCustomerError(
      "authenticateCustomer returned a `code` that is not a valid bearer token",
      response.status,
    );
  }

  const accountInfo =
    record["accountInfo"] !== null &&
    typeof record["accountInfo"] === "object" &&
    !Array.isArray(record["accountInfo"])
      ? (record["accountInfo"] as Record<string, unknown>)
      : null;
  const customerID = accountInfo?.["customerID"];
  const agentType = accountInfo?.["AgentType"];
  const expiry = tokenExpiry(token);
  return {
    token,
    tokenChars: token.length,
    expiresAtIso: expiry.expiresAtIso,
    expiresInSec: expiry.expiresInSec,
    customerIdChars: typeof customerID === "string" ? customerID.length : null,
    agentTypeChars: typeof agentType === "string" ? agentType.length : null,
  };
}
