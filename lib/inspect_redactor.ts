/**
 * @file lib/inspect_redactor.ts
 * @description Redaction primitives for diagnostic surfaces printed by `Bun.inspect.custom`,
 * `toJSON()` and OSC-8 terminal links.
 *
 * Visibility tiers are inspection profiles, not directory roles. `DESK_ROLE_VISIBILITY` maps the
 * `DeskRoleId` values from `lib/rbac_governance.ts` onto one, the default is `AUDITOR_SANITIZED`
 * (fail closed), and `runWithInspectVisibility()` scopes a tier through `AsyncLocalStorage` so a
 * formatter cannot silently widen its own audience.
 *
 * Measured on Bun 1.4.4: `Bun.FileSystemRouter#match()` returns a live native `MatchedRoute` that
 * is not frozen, whose `params` and `query` getters hand back the same mutable object on every
 * read, whose `pathname` carries the decoded query string, and whose `filePath` is an absolute
 * host path. `Bun.inspect(match, { showHidden: true, depth: null })` therefore prints both the
 * token and the host path. Everything this module returns is a scrubbed copy.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { ipv6Prefix64, parseIpv6Hextets, replaceIpv6InText } from "./ipv6.ts";
import type { DeskRoleId } from "./rbac_governance.ts";
import { manifestNames } from "./secret_manifest.ts";

export const INSPECT_VISIBILITIES = [
  "OWNER_ADMIN",
  "RISK_MANAGER",
  "AUDITOR_SANITIZED",
] as const;

export type InspectVisibility = (typeof INSPECT_VISIBILITIES)[number];

/**
 * Inspection tier for each desk role. Security and the business owner see host paths; the risk and
 * settlement planes see workspace-relative targets and /24 subnets; compliance, client/seam and
 * any caller that names no role get leaf filenames, masked identities and masked addresses.
 */
export const DESK_ROLE_VISIBILITY: Readonly<
  Record<DeskRoleId, InspectVisibility>
> = Object.freeze({
  operator: "RISK_MANAGER",
  "security/operator": "OWNER_ADMIN",
  "client/seam": "AUDITOR_SANITIZED",
  settlement: "RISK_MANAGER",
  compliance: "AUDITOR_SANITIZED",
  "server-team-lead": "RISK_MANAGER",
  "business-owner": "OWNER_ADMIN",
  RISK_DESK_ANALYST: "RISK_MANAGER",
});

export function visibilityForDeskRole(role: DeskRoleId): InspectVisibility {
  return DESK_ROLE_VISIBILITY[role];
}

const visibilityStore = new AsyncLocalStorage<InspectVisibility>();

/** Runs `run` with `visibility` as the ambient tier; nested scopes restore the outer tier. */
export function runWithInspectVisibility<T>(
  visibility: InspectVisibility,
  run: () => T,
): T {
  return visibilityStore.run(visibility, run);
}

/** Explicit tier wins over an ambient `AsyncLocalStorage` scope; the fallback is fail-closed. */
export function resolveInspectVisibility(
  explicit?: InspectVisibility,
): InspectVisibility {
  return explicit ?? visibilityStore.getStore() ?? "AUDITOR_SANITIZED";
}

/** Key names on `MatchedRoute.params` / `.query` whose value is a credential, never route state. */
const SENSITIVE_RESERVED_KEY_RE =
  /^(?:x-amz-(?:signature|credential|security-token|date|signedheaders)|(?:access|refresh|id|api|auth|csrf|session)?_?token|api[-_]?key|secret|client[-_]?secret|auth|authorization|jwt|key|sig|signature|password|passwd|pwd|cookie|set-cookie|gslive_session_id|phpsessid|cf_clearance|f402_auth_jwt|bearer)$/i;

const SENSITIVE_KEY_SUFFIX_RE =
  /(?:^|[_-])(?:token|secret|password|passwd|pwd|api_key|apikey|session_id|sessionid|signature|jwt|cookie|authorization)(?:$|[_-])/i;

/** Account and agent identifiers: masked for every tier that is not the business owner. */
const ACCOUNT_OR_AGENT_KEY_RE =
  /^(?:customer_?id|customer_?login|customer|account_?id|acct|login|agent_?id|leaf_?agent_?id|player_?id)$/i;

/** Address keys: masked to a /24 (or /64) subnet for the risk plane and fully for auditors. */
const IP_BAG_KEY_RE =
  /^(?:ip|client_?ip|source_?ip|remote_?addr|x[-_]forwarded[-_]for|forwarded)$/i;

export function isSensitiveRouteKey(key: string): boolean {
  return (
    SENSITIVE_RESERVED_KEY_RE.test(key) || SENSITIVE_KEY_SUFFIX_RE.test(key)
  );
}

const IPV4_BODY = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const IPV4_EXACT_RE = new RegExp(`^${IPV4_BODY}(?:\\.${IPV4_BODY}){3}$`);

const IPV4_ANY_RE = new RegExp(IPV4_BODY + "(?:\\." + IPV4_BODY + "){3}", "g");

// oxlint-disable-next-line no-control-regex -- OSC-8 sequences are the target.
const TERMINAL_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex -- terminal escape sequences are the target.
const TERMINAL_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// oxlint-disable-next-line no-control-regex -- control bytes are what this strips.
const TERMINAL_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const BEARER_OR_BASIC_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

const SECRET_QUERY_KEY =
  "(?:x-amz-(?:signature|credential|security-token)|token|api[_-]?key|secret|auth|jwt|key|sig|signature|password|passwd|pwd|cookie|gslive_session_id|session[_-]?id|phpsessid|cf_clearance)";
const URL_SECRET_QUERY_RE = new RegExp(
  `([?&]${SECRET_QUERY_KEY}=)[^&\\s#]+`,
  "gi",
);
const COOKIE_HEADER_RE = /\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi;
const DSN_PASSWORD_RE =
  /\b((?:postgres|postgresql|mysql|redis|rediss|https?):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi;

const SECRET_ENV_NAME_RE =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|SESSION|API_KEY|JWT|SIGNATURE|CREDENTIAL)(?:_|$)/i;

const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_COOKIE = "[REDACTED_COOKIE]";
const REDACTED_IP = "[REDACTED_IP]";
const REDACTED_ID = "[REDACTED_ID]";
const REDACTED_ROLE = "[REDACTED_ROLE]";
const SOR_LABEL_RE = /\b(?:ORIGIN_LEADER|BRIDGE_RELAY)\b/g;

/** SOR-adjacent syndicate roles stay behind the inspect gate; auditors never see the labels. */
export function maskSorLabelByRole(
  value: string,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    visibility === "OWNER_ADMIN" ||
    visibility === "RISK_MANAGER"
  ) {
    return trimmed;
  }
  if (trimmed === "ORIGIN_LEADER" || trimmed === "BRIDGE_RELAY") {
    return REDACTED_ROLE;
  }
  return trimmed.replace(SOR_LABEL_RE, REDACTED_ROLE);
}

function maskSorLabelsInText(
  text: string,
  visibility: InspectVisibility,
): string {
  if (visibility === "OWNER_ADMIN" || visibility === "RISK_MANAGER")
    return text;
  return text.replace(SOR_LABEL_RE, REDACTED_ROLE);
}

/** Strips terminal escapes and non-printable control bytes, keeping newlines and tabs. */
export function stripTerminalEscapes(text: string): string {
  return text
    .replace(TERMINAL_OSC_RE, "")
    .replace(TERMINAL_CSI_RE, "")
    .replace(TERMINAL_CONTROL_RE, "");
}

function activeSecretValues(): readonly string[] {
  const names = new Set<string>(manifestNames());
  for (const name of Object.keys(Bun.env)) {
    if (SECRET_ENV_NAME_RE.test(name)) names.add(name);
  }
  const values: string[] = [];
  for (const name of names) {
    const value = Bun.env[name];
    if (typeof value !== "string" || value.length < 8) continue;
    values.push(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) values.push(encoded);
  }
  return values;
}

function replaceActiveSecretValues(text: string): string {
  let out = text;
  for (const value of activeSecretValues()) {
    if (value.length < 8 || !out.includes(value)) continue;
    out = out.split(value).join(REDACTED_SECRET);
  }
  return out;
}

function maskIpv6Literal(
  candidate: string,
  visibility: InspectVisibility,
): string {
  if (visibility !== "RISK_MANAGER") return REDACTED_IP;
  const prefix64 = ipv6Prefix64(candidate);
  return prefix64 === null ? REDACTED_IP : `${prefix64}::/64`;
}

function maskIpsInText(text: string, visibility: InspectVisibility): string {
  if (visibility === "OWNER_ADMIN") return text;
  const maskedV6 = replaceIpv6InText(text, (candidate) =>
    maskIpv6Literal(candidate, visibility),
  );
  return maskedV6.replace(IPV4_ANY_RE, (candidate) =>
    visibility === "RISK_MANAGER"
      ? `${candidate.split(".").slice(0, 3).join(".")}.0/24`
      : REDACTED_IP,
  );
}

/** Scrubs secrets and, above `OWNER_ADMIN`, addresses from an arbitrary diagnostic string. */
export function redactDiagnosticSurface(
  text: string,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  let out = stripTerminalEscapes(text);
  out = out.replace(BEARER_OR_BASIC_RE, `$1 ${REDACTED_SECRET}`);
  out = out.replace(JWT_RE, REDACTED_SECRET);
  out = out.replace(URL_SECRET_QUERY_RE, `$1${REDACTED_SECRET}`);
  out = out.replace(COOKIE_HEADER_RE, `$1: ${REDACTED_COOKIE}`);
  out = out.replace(DSN_PASSWORD_RE, `$1${REDACTED_SECRET}$3`);
  out = replaceActiveSecretValues(out);
  out = maskSorLabelsInText(out, visibility);
  return maskIpsInText(out, visibility);
}

/** Masks one address value; comma-separated `X-Forwarded-For` chains are masked per hop. */
export function maskIpByRole(
  value: string,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  const trimmed = value.trim();
  if (trimmed === "" || visibility === "OWNER_ADMIN") return trimmed;
  const hops = trimmed.split(",").map((hop) => hop.trim());
  const masked = hops.map((hop) => {
    const candidate = hop.replace(/^\[/, "").replace(/\]$/, "");
    if (IPV4_EXACT_RE.test(candidate)) {
      return visibility === "RISK_MANAGER"
        ? `${candidate.split(".").slice(0, 3).join(".")}.0/24`
        : REDACTED_IP;
    }
    if (candidate.includes(":") && parseIpv6Hextets(candidate) !== null) {
      return maskIpv6Literal(candidate, visibility);
    }
    return redactDiagnosticSurface(hop, visibility);
  });
  return masked.join(", ");
}

/**
 * Masks an account or agent identifier. The risk plane keeps a four-character fingerprint so a
 * record can still be paired across reports; auditors see nothing but the placeholder.
 */
export function maskCustomerIdByRole(
  value: string,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  const trimmed = value.trim();
  if (trimmed === "" || visibility === "OWNER_ADMIN") return trimmed;
  if (visibility === "RISK_MANAGER") {
    return trimmed.length <= 4 ? REDACTED_ID : `***${trimmed.slice(-4)}`;
  }
  return REDACTED_ID;
}

/**
 * Scrubs a `MatchedRoute.query` or `MatchedRoute.params` dictionary.
 *
 * - Non-sensitive route state (`params.slug`, `params["0"]`, `query.filter`) passes through.
 * - Credential/signature/session keys become `[REDACTED_SECRET]`.
 * - Address and account keys are masked per visibility tier.
 * - The result is a frozen `null`-prototype object, so `__proto__` cannot pollute a prototype and
 *   a caller cannot mutate the diagnostic's view of the route.
 */
export function sanitizeRouteRecord(
  bag: Readonly<Record<string, string>>,
  visibility: InspectVisibility = resolveInspectVisibility(),
  opts: { readonly redactSensitiveKeys?: boolean } = {},
): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  const redactKeys = opts.redactSensitiveKeys !== false;
  for (const key of Object.keys(bag)) {
    if (!Object.hasOwn(bag, key)) continue;
    const raw = String(bag[key] ?? "");
    if (redactKeys && isSensitiveRouteKey(key)) {
      out[key] = REDACTED_SECRET;
      continue;
    }
    if (IP_BAG_KEY_RE.test(key)) {
      out[key] = maskIpByRole(raw, visibility);
      continue;
    }
    if (ACCOUNT_OR_AGENT_KEY_RE.test(key)) {
      out[key] = maskCustomerIdByRole(raw, visibility);
      continue;
    }
    out[key] = redactDiagnosticSurface(raw, visibility);
  }
  return Object.freeze(out);
}

/**
 * Sanitizes a URL before it is embedded in an OSC-8 hyperlink. Auditors keep the origin and path
 * only; every tier loses query secrets, userinfo passwords and terminal control bytes.
 */
export function sanitizeDiagnosticUrl(
  url: string,
  visibility: InspectVisibility = resolveInspectVisibility(),
): string {
  let out = stripTerminalEscapes(url);
  out = out.replace(URL_SECRET_QUERY_RE, `$1${REDACTED_SECRET}`);
  out = out.replace(DSN_PASSWORD_RE, `$1${REDACTED_SECRET}$3`);
  if (visibility !== "OWNER_ADMIN") out = out.replace(/\/\/[^/@\s]+@/, "//");
  if (visibility === "AUDITOR_SANITIZED") {
    const queryAt = out.indexOf("?");
    if (queryAt !== -1) out = out.slice(0, queryAt);
  }
  return out;
}
