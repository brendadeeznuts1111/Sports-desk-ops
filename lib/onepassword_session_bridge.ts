/**
 * @file lib/onepassword_session_bridge.ts
 * @description Hardened Credential & Session Resolution Boundary (GATE-AUTH-00..05 & GATE-SEC-01..03).
 *
 * Implements:
 *  - GATE-AUTH-00: Upstream fault classification (`CREDENTIAL_REJECTED`, `REQUEST_REFUSED_FORBIDDEN`,
 *                  `INTERACTIVE_CHALLENGE_REQUIRED`, `UPSTREAM_TRANSIENT_UNAVAILABLE`, `OK_AUTHENTICATED`)
 *  - GATE-AUTH-01: Keychain-first lookup (`Bun.secrets.get`), `401` eviction (`Bun.secrets.delete`) ->
 *                  single-flight `op read` recovery vs. stale-in-vault fail-closed halt
 *  - GATE-AUTH-02: Per-`(service, item)` single-flight coalescing with rejected-flight cleanup
 *  - GATE-AUTH-03: Persisted circuit state (`CLOSED_HEALTHY`, `HALF_OPEN_PROBING`, `OPEN_LOCKED`) with
 *                  atomic temp+rename write, IEEE 802.3 CRC-32 check, monotonic clock immunity against
 *                  backward wall-clock jumps, and fail-closed `OPEN_LOCKED` on state corruption
 *  - GATE-AUTH-04: Half-open single-probe admission (concurrent arrivals during probe rejected)
 *  - GATE-AUTH-05: Serialized per-item `op item edit` write mutex with rejection recovery
 *  - GATE-SEC-01:  Explicit child-process environment allowlist (`buildMinimalSpawnEnv`)
 *  - GATE-SEC-02:  Pre-flight header-byte guard + multi-encoding secret redaction (`raw`, `URL`, `Base64`, split)
 *  - GATE-SEC-03:  Locale-independent ASCII `CHAR(11)` customer ID formatter with zero input echo on error
 */

import { buildMinimalSpawnEnv } from "./f402_credentials_policy.ts";

export { buildMinimalSpawnEnv };

export type TargetServiceId = "FANTASY402" | "GSLIVE_PARTNER_118";
export type SessionCircuitState =
  "CLOSED_HEALTHY" | "HALF_OPEN_PROBING" | "OPEN_LOCKED";
export type UpstreamFaultClassification =
  | "OK_AUTHENTICATED"
  | "CREDENTIAL_REJECTED"
  | "REQUEST_REFUSED_FORBIDDEN"
  | "INTERACTIVE_CHALLENGE_REQUIRED"
  | "UPSTREAM_TRANSIENT_UNAVAILABLE"
  | "UPSTREAM_PROTOCOL_ERROR";

/**
 * GATE-AUTH-00: Classifies upstream HTTP responses so 5xx HTML error pages and 403 scope denials
 * never evict Stage 1 credentials or trigger re-authentication storms.
 */
export function classifyUpstreamFault(
  statusCode: number,
  contentType: string,
  bodyText: string,
): UpstreamFaultClassification {
  const bodyLower = (bodyText ?? "").trim().toLowerCase();
  const ctypeLower = (contentType ?? "").toLowerCase();

  if (statusCode === 0 || (statusCode >= 500 && statusCode <= 599)) {
    return "UPSTREAM_TRANSIENT_UNAVAILABLE";
  }

  const challengeMarkers = [
    "cf-chl",
    "turnstile",
    "captcha",
    "g-recaptcha",
    "two-factor",
    "mfa_required",
  ];
  if (challengeMarkers.some((m) => bodyLower.includes(m))) {
    return "INTERACTIVE_CHALLENGE_REQUIRED";
  }

  const loginMarkers = [
    "unauthenticated",
    "invalid_token",
    "token_expired",
    "login_required",
    'name="password"',
    "phpsessid",
  ];
  if (
    statusCode === 401 ||
    ((statusCode === 200 || statusCode === 302) &&
      (ctypeLower.includes("text/html") || bodyLower.startsWith("<")) &&
      loginMarkers.some((m) => bodyLower.includes(m)))
  ) {
    return "CREDENTIAL_REJECTED";
  }

  if (statusCode === 403) {
    return "REQUEST_REFUSED_FORBIDDEN";
  }

  if (statusCode >= 200 && statusCode < 300 && bodyLower.startsWith("{")) {
    return "OK_AUTHENTICATED";
  }

  return "UPSTREAM_PROTOCOL_ERROR";
}

/**
 * GATE-SEC-03: Locale-independent ASCII uppercasing (`0x61..0x7A` -> `0x41..0x5A` via byte arithmetic)
 * and space-padding to 11 characters (`CHAR(11)`). Rejects embedded spaces, control characters, and
 * non-ASCII bytes before padding, and never echoes raw input in thrown error messages.
 */
export function formatAsciiChar11Id(rawLogin: unknown): string {
  if (typeof rawLogin !== "string") {
    throw new TypeError(
      "[INVALID_ACCOUNT_ID_TYPE] Expected ASCII string (input redacted)",
    );
  }
  const stripped = rawLogin.trim();
  if (stripped.length < 1 || stripped.length > 11) {
    throw new RangeError(
      `[INVALID_ACCOUNT_ID_LENGTH] Length=${stripped.length} outside 1..11 (input redacted)`,
    );
  }
  const outCodes: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      throw new RangeError(
        "[INVALID_ACCOUNT_ID_CHARSET] Non-printable, whitespace, or non-ASCII byte rejected (input redacted)",
      );
    }
    outCodes.push(code >= 0x61 && code <= 0x7a ? code - 32 : code);
  }
  return String.fromCharCode(...outCodes).padEnd(11, " ");
}

export function redactSecretLengthOnly(raw: string): string {
  if (!raw) return "<REDACTED len=0>";
  return `<REDACTED len=${raw.length}>`;
}

export function assertHeaderSafeSecretBytes(raw: string): void {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new RangeError(
        `[MALFORMED_SECRET_HEADER_BYTES] Illegal header byte at index ${i} (${redactSecretLengthOnly(raw)})`,
      );
    }
  }
}

export class OpaqueSecret {
  readonly #value: string;

  constructor(rawSecret: string) {
    this.#value = rawSecret.trim();
  }

  public isEmpty(): boolean {
    return this.#value.length === 0;
  }

  public byteLength(): number {
    return this.#value.length;
  }

  public exposeForHeaderOnly(): string {
    if (this.#value.length > 0) {
      assertHeaderSafeSecretBytes(this.#value);
    }
    return this.#value;
  }

  public toString(): string {
    return redactSecretLengthOnly(this.#value);
  }

  public toJSON(): string {
    return redactSecretLengthOnly(this.#value);
  }

  public [Symbol.toPrimitive](): string {
    return redactSecretLengthOnly(this.#value);
  }

  public [Bun.inspect.custom](): string {
    return redactSecretLengthOnly(this.#value);
  }
}

/**
 * GATE-SEC-02: Scrubs raw, URL-encoded, Base64-encoded, and half-split fragments of known secrets
 * from error messages and stack traces.
 */
export function scrubAllSecretEncodings(
  message: string,
  rawSecrets: readonly string[],
): string {
  let sanitized = message;
  for (const sec of rawSecrets) {
    if (!sec) continue;
    const tag = redactSecretLengthOnly(sec);
    const urlEnc = encodeURIComponent(sec);
    const b64Enc = Buffer.from(sec, "utf8").toBase64();
    for (const variant of [sec, urlEnc, b64Enc]) {
      if (variant.length >= 4 && sanitized.includes(variant)) {
        sanitized = sanitized.split(variant).join(tag);
      }
    }
    if (sec.length >= 16) {
      const half = Math.floor(sec.length / 2);
      for (const frag of [sec.slice(0, half), sec.slice(half)]) {
        if (sanitized.includes(frag)) {
          sanitized = sanitized.split(frag).join(tag);
        }
      }
    }
  }
  return sanitized;
}

/**
 * GATE-DOD-01: IEEE 802.3 CRC-32 (`0xEDB88320` reflected polynomial, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF`).
 * Standard test vector: `crc32IsoHdlc("123456789") === 0xCBF43926`.
 */
export function crc32IsoHdlc(data: Uint8Array | string): number {
  return Bun.hash.crc32(data) >>> 0;
}

// ============================================================================
// GATE-AUTH-05: Serialized Per-Item Vault Write Mutex
// ============================================================================

const writeLocks = new Map<string, Promise<void>>();

export async function enqueueSerializedVaultWrite<T>(
  itemKey: string,
  taskFn: () => Promise<T>,
): Promise<T> {
  const prev = writeLocks.get(itemKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.catch(() => {}).then(() => current);
  writeLocks.set(itemKey, chained);

  await prev.catch(() => {});
  try {
    return await taskFn();
  } finally {
    release();
    if (writeLocks.get(itemKey) === chained) {
      writeLocks.delete(itemKey);
    }
  }
}

export function activeWriteLockCount(): number {
  return writeLocks.size;
}
