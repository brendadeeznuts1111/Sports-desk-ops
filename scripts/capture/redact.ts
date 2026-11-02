/**
 * Redaction policy for evidence captures (policy v1).
 *
 * Two rules drive everything here:
 *   1. A capture record stores shapes, hashes and header *names* — never raw
 *      values. So redaction runs before the record is built, and the built
 *      record is scanned again before it can be persisted.
 *   2. Error/log text is data too. `redactError` strips URL userinfo, query
 *      values, bare `name=value` credential pairs, bearer/JWT tokens,
 *      cookie/authorization headers, emails and public IPs so a failed live
 *      capture cannot leak a credential.
 */

import { isPlainObject, sha256Hex } from "./json.ts";

/** Replacement for an entire sensitive value. */
export const REDACTED = "<redacted>";

/**
 * PII categories. The first five are detectable by pattern; the rest are
 * detected from the field name in a JSON body.
 */
export type PiiKind =
  | "email"
  | "ip"
  | "phone"
  | "jwt"
  | "bearer"
  | "customer-id"
  | "login"
  | "agent-id"
  | "password"
  | "token"
  | "address";

export interface PiiFinding {
  kind: PiiKind;
  count: number;
}

export interface BodyRedactionResult {
  /** The sanitized copy; callers may discard it (records never persist bodies). */
  clean: unknown;
  fieldsRedacted: string[];
  piiRedacted: PiiKind[];
}

export interface HeaderRedactionResult {
  clean: Record<string, string>;
  fieldsRedacted: string[];
}

/** Stable placeholder for a whole sensitive field, e.g. `<redacted:agent-id>`. */
export function placeholderFor(kind: PiiKind): string {
  return `<redacted:${kind}>`;
}

/**
 * Optional stable placeholder that keeps cross-record linkage. Only use when
 * the value is high-entropy: hashing a customer ID is reversible by brute force.
 */
export function hashedPlaceholderFor(kind: PiiKind, value: string): string {
  return `<redacted:${kind}:${sha256Hex(value).slice(0, 12)}>`;
}

// ---------------------------------------------------------------------------
// Field-name classification
// ---------------------------------------------------------------------------

interface KeyRule {
  readonly kind: PiiKind;
  readonly pattern: RegExp;
}

const PII_KEY_RULES: readonly KeyRule[] = [
  {
    kind: "customer-id",
    pattern:
      /^(?:customer_?id|padded_?customer_?id|acct|account_?id|customer_?number|telegram_?id)$/i,
  },
  {
    kind: "login",
    pattern:
      /^(?:login|customer_?login|user_?name|username|user_?id|userid|bettor|player_?id|name_?first|name_?last|name_?mi|first_?name|last_?name)$/i,
  },
  {
    kind: "agent-id",
    pattern:
      /^(?:agent_?id|agent_?owner|agent_?login|owner_?id|master_?agent)$/i,
  },
  {
    kind: "ip",
    pattern: /^(?:ip|ip_?address|client_?ip|remote_?addr|remote_?ip)$/i,
  },
  {
    kind: "email",
    pattern: /^(?:email|e_?mail|email_?address)$/i,
  },
  {
    kind: "password",
    pattern: /^(?:password|passwordt|passwd|pass_?code|pwd|secret)$/i,
  },
  {
    kind: "token",
    pattern:
      /^(?:token|access_?token|refresh_?token|jwt|bearer|authorization|session_?id|sid|api_?key|csrf(?:_?token)?|xsrf(?:_?token)?)$/i,
  },
  {
    kind: "phone",
    pattern:
      /^(?:phone|telephone|mobile|cell|phone_?number|sms_?phone_?number|home_?phone|business_?phone|fax)$/i,
  },
  {
    kind: "address",
    pattern:
      /^(?:address|street|street_?address|city|state|zip|zip_?code|postal_?code)$/i,
  },
];

/** Classify a JSON body key as PII, or return null for an ordinary key. */
export function classifyPiiKey(key: string): PiiKind | null {
  for (const rule of PII_KEY_RULES) {
    if (rule.pattern.test(key)) return rule.kind;
  }
  return null;
}

/** True when a field name must never have its value persisted. */
export function isSensitiveKey(key: string): boolean {
  return classifyPiiKey(key) !== null;
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE_RE = /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Credential-shaped names, shared by the pair rule and the cookie-group rule so
 * the two lists cannot drift. Matched case-insensitively; `-`/`_` variants of
 * the multi-word names are covered where they exist.
 */
const SENSITIVE_NAME_SOURCE =
  "session|sess|sid|csrftoken|csrf[_-]?token|csrf|xsrftoken|xsrf[_-]?token|xsrf|access[_-]?token|refresh[_-]?token|id[_-]?token|token|jwt|bearer|authorization|auth|cookie|set-cookie|__cf[\\w-]*|cf[_-]?clearance|phpsessid|jsessionid|connect\\.sid|api[_-]?key|apikey|secret|password";

/**
 * A credential-shaped `name=value` pair: `session=…`, `csrftoken=…`,
 * `cf_clearance=…`. A bare cookie string (`session=…; scoped=…`) carries no
 * `cookie:` label, so the labeled-header pass in `redactError` never sees it;
 * this pattern matches the pair itself and keeps the name.
 *
 * The value may be single- or double-quoted (`session="abcdefghij"`) or bare.
 * A quoted value is self-delimiting, so it needs no length floor: `cookie="abc"`
 * is still a credential. A bare value keeps the six-character floor so ordinary
 * settings such as `width=1440` and `timeout=30000` are left alone. The
 * replacement is the fixed `REDACTED` literal, so an already-redacted value
 * (quoted or bare) maps to itself and placeholders never nest.
 */
/**
 * A name may carry a namespace prefix that ends in a separator (`F402_PASSWORD`,
 * `ASP.NET_SessionId`) and a short credential suffix (`sessionid`, `auth_token`,
 * `authToken`). Free affixes are not allowed: `consider=` and `residual=`
 * contain `sid` and are not credentials.
 */
const SENSITIVE_NAME_FULL = `(?:[\\w.]*[_.-])?(?:${SENSITIVE_NAME_SOURCE})(?:[_.-]?(?:id|key|token|value))?`;

const SENSITIVE_PAIR_RE = new RegExp(
  `(?<![\\w.-])(${SENSITIVE_NAME_FULL})(\\s*=\\s*)("[^"\\n]+"|'[^'\\n]+'|[^\\s;&,"']{6,})`,
  "gi",
);

/** Passwords and secrets have no safe length floor: `password=abc12` is still one. */
const SHORT_SECRET_PAIR_RE =
  /(?<![\w.-])((?:[\w.]*[_.-])?(?:password|passwd|pwd|secret))(\s*=\s*)([^\s;&,"']{1,5})(?![^\s;&,"'])/gi;

/** Replace a pair value with `REDACTED`, keeping any quotes around it. */
function redactPairValue(name: string, assign: string, value: string): string {
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${name}${assign}${quote}${REDACTED}${quote}`;
}

/**
 * The same credential-shaped pair written as JSON: `{"session":"abcdef123456"}`.
 * The value side allows escaped characters (`\\.`) so a `\"` or `\n` escape is
 * consumed as part of the value and cannot terminate the match early. Six
 * characters is the floor, matching the bare pair rule; an already-redacted
 * value (`"<redacted>"`) re-matches to itself, so the pass is idempotent.
 */
const SENSITIVE_JSON_PAIR_RE = new RegExp(
  `("${SENSITIVE_NAME_FULL}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.){6,}"`,
  "gi",
);

/** Name-only test that decides a `;`-separated group is a cookie header. */
const SENSITIVE_NAME_RE = new RegExp(
  `(?<![\\w.-])${SENSITIVE_NAME_FULL}\\s*=`,
  "i",
);

/**
 * A labeled credential inside log text: `authorization: …`, `cookie: …`,
 * `set-cookie: …`, `token: …`, `x-auth-token: …`, `x-csrf-token: …`. The name
 * list is the shared `SENSITIVE_NAME_SOURCE`, so a custom header is caught by
 * its trailing `token`/`auth`/`session` segment, and the value is the rest of
 * the line: a cookie value can itself contain `;`-separated pairs, so stopping
 * at the first `;` would leak the remainder.
 *
 * `=` is deliberately not accepted here. Bare `name=value` text is the pair
 * rule's job, and consuming to end-of-line on `session=…; scoped=…` would
 * destroy the group structure that rule preserves; `authorization=Bearer …`
 * still loses its value through the pair rule.
 */
const LABELED_HEADER_RE = new RegExp(
  `(\\b(?:${SENSITIVE_NAME_SOURCE})\\b)\\s*:\\s*[^\\n]+`,
  "gi",
);

/** Any `name=value` pair inside a cookie group; same six-character floor. */
const ASSIGNMENT_RE =
  /(?<![\w.-])([A-Za-z_$][\w.$-]*)(\s*=\s*)([^\s;&,"']{6,})/g;

/** A value that is already a placeholder: leave it instead of nesting it. */
const PLACEHOLDER_VALUE_RE = /^<redacted(?::[a-z-]+)?>$/;

const PRIVATE_IPV4_FIRST_OCTETS = new Set([0, 10, 127, 255]);

function isPublicIpv4(candidate: string): boolean {
  const octets = candidate.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
  }
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  if (PRIVATE_IPV4_FIRST_OCTETS.has(first)) return false;
  if (first === 192 && second === 168) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 169 && second === 254) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  return true;
}

function isIpv4Candidate(candidate: string): boolean {
  const octets = candidate.split(".");
  if (octets.length !== 4) return false;
  return octets.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number.parseInt(part, 10);
    return value >= 0 && value <= 255;
  });
}

/**
 * Find detectable PII in arbitrary text. Returns one entry per category.
 * Private/loopback IPv4 addresses are not treated as PII (they identify a
 * machine, not a person, and local test servers legitimately use them).
 */
export function scanPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  let rest = text;

  const bearerCount = [...rest.matchAll(BEARER_RE)].length;
  if (bearerCount > 0) {
    findings.push({ kind: "bearer", count: bearerCount });
    rest = rest.replace(BEARER_RE, " ");
  }
  const jwtCount = [...rest.matchAll(JWT_RE)].length;
  if (jwtCount > 0) {
    findings.push({ kind: "jwt", count: jwtCount });
    rest = rest.replace(JWT_RE, " ");
  }
  const emailCount = [...rest.matchAll(EMAIL_RE)].length;
  if (emailCount > 0) {
    findings.push({ kind: "email", count: emailCount });
    rest = rest.replace(EMAIL_RE, " ");
  }
  let ipCount = 0;
  for (const match of rest.matchAll(IPV4_RE)) {
    if (isIpv4Candidate(match[0]) && isPublicIpv4(match[0])) ipCount += 1;
  }
  if (ipCount > 0) findings.push({ kind: "ip", count: ipCount });
  rest = rest.replace(IPV4_RE, " ");
  const phoneCount = [...rest.matchAll(PHONE_RE)].length;
  if (phoneCount > 0) findings.push({ kind: "phone", count: phoneCount });

  return findings.sort((left, right) => left.kind.localeCompare(right.kind));
}

/**
 * Redact a `;`-separated group once any segment names a credential.
 *
 * `document.cookie` lets page code use arbitrary cookie names (`scoped=…`), so
 * name matching alone cannot cover a bare cookie string. One sensitive name in
 * the group marks the whole group as a cookie header and every value in it is
 * replaced. A group with no sensitive name (`width=1440; height=1080`) is
 * returned untouched, and the six-character floor plus the placeholder check
 * keep short and already-redacted values alone.
 */
function redactCookieGroups(text: string): string {
  const segments = text.split(";");
  if (!segments.some((segment) => SENSITIVE_NAME_RE.test(segment))) {
    return text;
  }
  return segments
    .map((segment) =>
      segment.replace(
        ASSIGNMENT_RE,
        (match, name: string, assign: string, value: string) =>
          PLACEHOLDER_VALUE_RE.test(value)
            ? match
            : `${name}${assign}${REDACTED}`,
      ),
    )
    .join(";");
}

/**
 * Redact detectable PII tokens and credential-shaped `name=value` pairs.
 *
 * Cookie groups run before the pair rule but after the bearer/JWT/email/IP/phone
 * passes: `authorization=Bearer abc…` must lose the Bearer token as a token
 * first, and only then is the leftover value collapsed to one placeholder.
 */
export function redactString(text: string): string {
  let out = text;
  out = out.replace(BEARER_RE, placeholderFor("bearer"));
  out = out.replace(JWT_RE, placeholderFor("jwt"));
  out = out.replace(EMAIL_RE, placeholderFor("email"));
  out = out.replace(IPV4_RE, (match) =>
    isIpv4Candidate(match) && isPublicIpv4(match)
      ? placeholderFor("ip")
      : match,
  );
  out = out.replace(PHONE_RE, placeholderFor("phone"));
  out = redactCookieGroups(out);
  // JSON pairs first: `{"session":"…"}` has no `=` for the pair rule to anchor
  // on, and the earlier cookie-group split cannot see inside a quoted value.
  out = out.replace(
    SENSITIVE_JSON_PAIR_RE,
    (_match, prefix: string) => `${prefix}"${REDACTED}"`,
  );
  out = out.replace(
    SENSITIVE_PAIR_RE,
    (_match, name: string, assign: string, value: string) =>
      redactPairValue(name, assign, value),
  );
  out = out.replace(
    SHORT_SECRET_PAIR_RE,
    (_match, name: string, assign: string, value: string) =>
      redactPairValue(name, assign, value),
  );
  return out;
}

/** True when the value (any JSON value, walked recursively) contains PII. */
export function hasPii(value: unknown): boolean {
  return findPiiInValue(value).length > 0;
}

/** Find PII inside every string of a JSON value; numbers are not scanned. */
export function findPiiInValue(value: unknown): PiiFinding[] {
  const totals = new Map<PiiKind, number>();
  walk(value, (text) => {
    for (const finding of scanPii(text)) {
      totals.set(finding.kind, (totals.get(finding.kind) ?? 0) + finding.count);
    }
  });
  return [...totals.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function walk(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) walk(child, visit);
  }
}

export class PiiLeakError extends Error {
  readonly findings: PiiFinding[];

  constructor(label: string, findings: PiiFinding[]) {
    const detail = findings
      .map((finding) => `${finding.kind} x${finding.count}`)
      .join(", ");
    super(`${label} contains unredacted PII (${detail})`);
    this.name = "PiiLeakError";
    this.findings = findings;
  }
}

/** Refuse to persist anything that still contains detectable PII. */
export function assertNoPii(value: unknown, label: string): void {
  const findings = findPiiInValue(value);
  if (findings.length > 0) throw new PiiLeakError(label, findings);
}

// ---------------------------------------------------------------------------
// Header redaction
// ---------------------------------------------------------------------------

const DENY_HEADER_RE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|csrf-token|x-xsrf-token|xsrf-token|x-auth-token|auth-token|x-api-key|api-key|x-session-id|session|sessionid|jwt|bearer|token|password)$/i;

const SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "host",
  "origin",
  "pragma",
  "user-agent",
  "x-requested-with",
]);

/**
 * Redact request/response headers for persistence.
 *
 * - Deny-listed names keep their name with `<redacted>` as the value.
 * - `referer` keeps origin+path only (query strings can carry session tokens).
 * - Allow-listed names keep their value, sanitized for PII tokens.
 * - Anything else is not trusted: value becomes `<redacted>`.
 */
export function redactHeaders(
  headers: Record<string, string>,
): HeaderRedactionResult {
  const clean: Record<string, string> = {};
  const fields: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (name.length === 0) continue;
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    if (DENY_HEADER_RE.test(name)) {
      clean[name] = REDACTED;
      fields.push(name);
      continue;
    }
    if (name === "referer") {
      clean[name] = sanitizeReferer(value);
      fields.push(name);
      continue;
    }
    if (!SAFE_HEADERS.has(name)) {
      clean[name] = REDACTED;
      fields.push(name);
      continue;
    }
    const sanitized = redactString(value);
    if (sanitized !== value) fields.push(name);
    clean[name] = sanitized;
  }
  return { clean, fieldsRedacted: [...new Set(fields)].sort() };
}

/** Keep only scheme://host/path from a referer; never the query or fragment. */
export function sanitizeReferer(value: string): string {
  try {
    const url = new URL(value);
    const userinfo =
      url.username.length > 0 || url.password.length > 0 ? `${REDACTED}@` : "";
    return `${url.protocol}//${userinfo}${url.host}${url.pathname}`;
  } catch {
    return REDACTED;
  }
}

// ---------------------------------------------------------------------------
// Body redaction
// ---------------------------------------------------------------------------

/**
 * Redact PII from a parsed JSON body.
 *
 * Sensitive keys become `<redacted:kind>` placeholders (values discarded);
 * other string values are scanned for emails/IPs/phones/tokens. The result is
 * for diagnostics only — capture records persist the skeleton, not this body.
 */
export function redactJson(value: unknown): BodyRedactionResult {
  const fields = new Set<string>();
  const kinds = new Set<PiiKind>();

  const redactNode = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) {
      return node.map((item, index) => redactNode(item, `${path}[${index}]`));
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) {
        const kind = classifyPiiKey(key);
        const childPath = `${path}.${key}`;
        if (kind !== null) {
          fields.add(childPath);
          kinds.add(kind);
          out[key] = placeholderFor(kind);
          continue;
        }
        out[key] = redactNode(node[key], childPath);
      }
      return out;
    }
    if (typeof node === "string") {
      const findings = scanPii(node);
      if (findings.length > 0) {
        fields.add(path);
        for (const finding of findings) kinds.add(finding.kind);
        return redactString(node);
      }
      return node;
    }
    return node;
  };

  const clean = redactNode(value, "body");
  return {
    clean,
    fieldsRedacted: [...fields].sort(),
    piiRedacted: [...kinds].sort(),
  };
}

// ---------------------------------------------------------------------------
// Log / error redaction
// ---------------------------------------------------------------------------

/**
 * Scheme+host+path of a URL, with userinfo and query removed. A URL with no host
 * (`about:blank`, `data:text/html,…`) keeps its own shape; a `data:` payload is
 * dropped after its media type.
 */
export function redactUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "data:") {
      return `data:${url.pathname.split(/[;,]/, 1)[0] ?? ""},…`;
    }
    if (url.host === "" && url.protocol !== "file:") {
      return `${url.protocol}${url.pathname}`;
    }
    const userinfo =
      url.username.length > 0 || url.password.length > 0 ? `${REDACTED}@` : "";
    const path = url.pathname.replace(/\d{2,}/g, ":id");
    return `${url.protocol}//${userinfo}${url.host}${path}`;
  } catch {
    return REDACTED;
  }
}

/**
 * Turn any thrown value into a single redacted line. Never includes a stack
 * trace: stacks carry file paths and local variable text that may hold secrets.
 */
export function redactError(
  error: unknown,
  extraSecrets: readonly string[] = [],
): string {
  let message: string;
  if (error instanceof Error) {
    message = `${error.name}: ${error.message}`;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "unknown error";
  }

  let out = message;
  for (const secret of extraSecrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join(REDACTED);
  }
  // URL userinfo first: an email-shaped `user:pass@host` must keep its host and
  // must not be mistaken for an email address by the pattern pass below.
  out = out.replace(/\/\/[^/@\s]+@/g, `//${REDACTED}@`);
  out = redactString(out);
  out = out.replace(/([?&][^=&\s#]+)=([^&\s#]*)/g, (_match, key: string) => {
    return `${key}=${REDACTED}`;
  });
  out = out.replace(LABELED_HEADER_RE, (_match, name: string) => {
    return `${name}: ${REDACTED}`;
  });
  return out;
}
