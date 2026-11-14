/**
 * Named login outcomes for the F402 WebView flow (signal-honesty).
 *
 * The portal authenticates with a Bearer token in sessionStorage (plus
 * MASTER_ID for agentID/agentOwner). A failed login returns HTTP 204 and
 * raises a blocking `alert("Wrong User or Password")` — callers must dismiss
 * the dialog and fail fast rather than waiting for the password field to
 * disappear or for cookies to appear.
 */

export type F402LoginFailureReason =
  "bad-credentials" | "captcha-required" | "otp-required" | "timeout";

export class F402LoginError extends Error {
  readonly reason: F402LoginFailureReason;

  constructor(reason: F402LoginFailureReason, detail?: string) {
    super(
      detail === undefined || detail.trim() === ""
        ? `F402 login failed: ${reason}`
        : `F402 login failed: ${reason}: ${detail}`,
    );
    this.name = "F402LoginError";
    this.reason = reason;
  }
}

export interface F402LoginPageSnapshot {
  readonly hasPassword: boolean;
  readonly hasToken: boolean;
  readonly hasCredentials: boolean;
  readonly hasMasterId: boolean;
  readonly hasCaptcha: boolean;
  readonly hasOtp: boolean;
  readonly dialogMessage?: string;
  /** HTTP status of System/authenticateCustomer(forAgent), when observed. */
  readonly loginHttpStatus?: number;
}

export type F402LoginVerdict =
  | { readonly status: "success" }
  | { readonly status: "pending" }
  | { readonly status: "failure"; readonly reason: F402LoginFailureReason };

const BAD_CREDENTIALS_RE = /wrong user or password|wrong user|wrong password/i;
/** Portal client treats any non-200 authenticateCustomer success (notably 204) as bad credentials. */
const LOGIN_SUCCESS_STATUS = 200;

export function classifyF402LoginSnapshot(
  snapshot: F402LoginPageSnapshot,
): F402LoginVerdict {
  if (snapshot.hasCaptcha) {
    return { status: "failure", reason: "captcha-required" };
  }
  if (snapshot.hasOtp) {
    return { status: "failure", reason: "otp-required" };
  }
  const dialog = snapshot.dialogMessage ?? "";
  if (dialog.length > 0 && BAD_CREDENTIALS_RE.test(dialog)) {
    return { status: "failure", reason: "bad-credentials" };
  }
  if (
    snapshot.loginHttpStatus !== undefined &&
    snapshot.loginHttpStatus !== LOGIN_SUCCESS_STATUS
  ) {
    return { status: "failure", reason: "bad-credentials" };
  }
  if (snapshot.hasToken || snapshot.hasCredentials || snapshot.hasMasterId) {
    return { status: "success" };
  }
  return { status: "pending" };
}

/**
 * IIFE that reports login page state and in-memory storage values.
 * The result's token/ids must never be logged.
 */
export const F402_PORTAL_SESSION_EXPRESSION =
  '(() => { const keys = []; try { for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i)); } catch (e) {} const token = sessionStorage.getItem("token") || ""; const credentials = sessionStorage.getItem("credentials") || ""; const masterId = sessionStorage.getItem("MASTER_ID") || ""; const customerId = sessionStorage.getItem("customerID") || ""; const captcha = document.querySelector(".g-recaptcha, iframe[src*=\\"recaptcha\\"], iframe[src*=\\"turnstile\\"], iframe[src*=\\"challenges.cloudflare.com\\"], #captcha") !== null; const body = (document.body && document.body.innerText) || ""; const otp = document.querySelector("#otp, input[name=\\"otp\\"], input[name=\\"tokenauth\\"]") !== null || /enter.{0,16}otp|one[\\s-]?time (password|code)|verification code/i.test(body); return { hasPassword: document.querySelector("input[type=password]") !== null, hasToken: token.length > 0, hasCredentials: credentials.length > 0, hasMasterId: masterId.length > 0, hasCaptcha: captcha, hasOtp: otp, token, credentials, masterId, customerId, sessionStorageKeyNames: keys, href: location.href }; })()';

export interface F402PortalStorage {
  readonly authorizationHeader?: string;
  readonly agentId?: string;
  readonly agentOwner?: string;
}

function bearerFromToken(raw: string): string | undefined {
  const token = raw.trim();
  if (token.length === 0) return undefined;
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

function tokenFromCredentialsJson(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    for (const key of ["token", "code", "access_token"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * Pulls Bearer + agent ids from a portal storage evaluate result.
 * Values are for the session file only — never log them.
 */
export function portalAuthFromStorageEvaluate(
  value: unknown,
): F402PortalStorage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const authorizationHeader =
    bearerFromToken(
      typeof record["token"] === "string" ? record["token"] : "",
    ) ??
    (typeof record["credentials"] === "string"
      ? bearerFromToken(tokenFromCredentialsJson(record["credentials"]) ?? "")
      : undefined);
  const masterId = nonEmpty(record["masterId"]);
  const customerId = nonEmpty(record["customerId"]);
  const agentId = masterId ?? customerId;
  return {
    ...(authorizationHeader === undefined ? {} : { authorizationHeader }),
    ...(agentId === undefined ? {} : { agentId, agentOwner: agentId }),
  };
}

export function isLoginApiUrl(url: string): boolean {
  return /\/(?:cloud|qubic)\/api\/System\/authenticateCustomer/i.test(url);
}
