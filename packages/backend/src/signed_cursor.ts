/**
 * @file packages/backend/src/signed_cursor.ts
 * @description Hardened HMAC-SHA256 signed opaque cursor utilities and array pagination.
 *
 * Wire format: `<payloadB64Url>.<sigB64Url>`
 * Payload    : `v1|<scope0>|<scope1>|...|<position>`
 * MAC        : `new Bun.CryptoHasher("sha256", secret).update(encodedPayload).digest()`
 * Comparison : constant-time `timingSafeEqual(expectedSig, actualSig)`
 */

import { CryptoHasher } from "bun";
import { timingSafeEqual } from "node:crypto";

export const CURSOR_VERSION = "v1";
export const CURSOR_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
export const CURSOR_POSITIVE_INT_RE = /^[1-9]\d*$/;
export const CURSOR_SCOPE_DELIMITER = "|";

export type CursorSecretInput = string | readonly string[];

export interface CursorPageInfo {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly total: number;
}

export type CursorPaginationErrorCode = "INVALID_CURSOR" | "INVALID_LIMIT";

export type CursorPaginationResult<T> =
  | {
      readonly ok: true;
      readonly items: readonly T[];
      readonly offset: number;
      readonly pageInfo: CursorPageInfo;
    }
  | {
      readonly ok: false;
      readonly error: CursorPaginationErrorCode;
    };

export interface SignedCursorPaginationOptions {
  readonly rawLimit: string | null;
  readonly rawCursor: string | null;
  readonly scope: readonly string[];
  readonly secret: CursorSecretInput;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

function isValidScope(scope: readonly string[]): boolean {
  if (scope.length === 0) return false;
  for (const segment of scope) {
    if (segment.length === 0 || segment.includes(CURSOR_SCOPE_DELIMITER)) {
      return false;
    }
  }
  return true;
}

function normalizeCandidateSecrets(
  input: CursorSecretInput,
): readonly string[] {
  const raw = typeof input === "string" ? [input] : input;
  const out: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Resolve one or more non-empty HMAC signing/verification keys.
 * When `input` is omitted, generates a process-ephemeral random UUID secret.
 */
export function resolveCursorSecrets(
  input?: CursorSecretInput,
): readonly [string, ...string[]] {
  if (input === undefined) {
    return [crypto.randomUUID()];
  }
  const normalized = normalizeCandidateSecrets(input);
  const first = normalized[0];
  if (first === undefined) {
    throw new Error(
      "SIGNED_CURSOR_EMPTY_SECRET: signed cursor configuration requires a non-empty secret",
    );
  }
  return [first, ...normalized.slice(1)];
}

function signEncodedPayload(
  encodedPayload: string,
  secret: string,
): Uint8Array {
  return new CryptoHasher("sha256", secret).update(encodedPayload).digest();
}

/**
 * Encode and HMAC-SHA256 sign an opaque pagination cursor bound to `scope`.
 */
export function encodeSignedCursor(
  scope: readonly string[],
  position: number,
  secret: string,
): string {
  if (!isValidScope(scope)) {
    throw new Error(
      `SIGNED_CURSOR_INVALID_SCOPE: scope must contain non-empty segments without "${CURSOR_SCOPE_DELIMITER}"`,
    );
  }
  if (!Number.isSafeInteger(position) || position <= 0) {
    throw new RangeError(
      `SIGNED_CURSOR_INVALID_POSITION: cursor position must be a positive safe integer, got ${position}`,
    );
  }
  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) {
    throw new Error(
      "SIGNED_CURSOR_EMPTY_SECRET: encodeSignedCursor requires a non-empty HMAC secret",
    );
  }

  const payload = `${CURSOR_VERSION}${CURSOR_SCOPE_DELIMITER}${scope.join(CURSOR_SCOPE_DELIMITER)}${CURSOR_SCOPE_DELIMITER}${position}`;
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const sig = Buffer.from(
    signEncodedPayload(encodedPayload, trimmedSecret),
  ).toString("base64url");
  return `${encodedPayload}.${sig}`;
}

/**
 * Verify HMAC-SHA256 signature (constant-time) and tenant/route scope binding.
 * Fails closed (`null`) on malformed wire format, tampering, secret mismatch, or cross-scope replay.
 */
export function decodeSignedCursor(
  cursor: string,
  expectedScope: readonly string[],
  secret: CursorSecretInput,
): number | null {
  if (!isValidScope(expectedScope)) return null;

  const candidates = normalizeCandidateSecrets(secret);
  if (candidates.length === 0) return null;

  const parts = cursor.split(".");
  if (parts.length !== 2) return null;

  const encodedPayload = parts[0];
  const encodedSig = parts[1];
  if (
    !encodedPayload ||
    !encodedSig ||
    !CURSOR_BASE64URL_RE.test(encodedPayload) ||
    !CURSOR_BASE64URL_RE.test(encodedSig)
  ) {
    return null;
  }

  const actualSig = Buffer.from(encodedSig, "base64url");
  if (actualSig.length === 0) return null;

  let verified = false;
  for (const key of candidates) {
    const expectedSig = signEncodedPayload(encodedPayload, key);
    if (
      actualSig.length === expectedSig.length &&
      timingSafeEqual(expectedSig, actualSig)
    ) {
      verified = true;
      break;
    }
  }
  if (!verified) return null;

  const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const segments = decoded.split(CURSOR_SCOPE_DELIMITER);
  if (segments.length !== expectedScope.length + 2) return null;
  if (segments[0] !== CURSOR_VERSION) return null;

  for (let i = 0; i < expectedScope.length; i++) {
    if (segments[i + 1] !== expectedScope[i]) {
      return null;
    }
  }

  const rawPos = segments[segments.length - 1];
  if (!rawPos || !CURSOR_POSITIVE_INT_RE.test(rawPos)) return null;

  const parsed = Number(rawPos);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Parse `?limit=` against a safe integer range, returning `null` when invalid.
 */
export function parseCursorPageLimit(
  rawLimit: string | null,
  defaultLimit: number,
  maxLimit: number,
): number | null {
  const safeMax = Math.max(1, Math.trunc(maxLimit));
  const safeDefault = Math.min(Math.max(1, Math.trunc(defaultLimit)), safeMax);
  if (rawLimit === null) return safeDefault;
  const trimmed = rawLimit.trim();
  if (!CURSOR_POSITIVE_INT_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, safeMax);
}

/**
 * Slice an ordered array with an HMAC-signed opaque cursor bound to `scope`.
 */
export function paginateArrayWithSignedCursor<T>(
  items: readonly T[],
  options: SignedCursorPaginationOptions,
): CursorPaginationResult<T> {
  const limit = parseCursorPageLimit(
    options.rawLimit,
    options.defaultLimit,
    options.maxLimit,
  );
  if (limit === null) {
    return { ok: false, error: "INVALID_LIMIT" };
  }

  const candidates = normalizeCandidateSecrets(options.secret);
  const primarySecret = candidates[0];
  if (primarySecret === undefined || !isValidScope(options.scope)) {
    return { ok: false, error: "INVALID_CURSOR" };
  }

  let offset = 0;
  if (options.rawCursor !== null) {
    const decoded = decodeSignedCursor(
      options.rawCursor,
      options.scope,
      candidates,
    );
    if (decoded === null) {
      return { ok: false, error: "INVALID_CURSOR" };
    }
    offset = decoded;
  }

  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < items.length;
  const nextCursor = hasMore
    ? encodeSignedCursor(options.scope, nextOffset, primarySecret)
    : null;

  return {
    ok: true,
    items: pageItems,
    offset,
    pageInfo: {
      limit,
      hasMore,
      nextCursor,
      total: items.length,
    },
  };
}
