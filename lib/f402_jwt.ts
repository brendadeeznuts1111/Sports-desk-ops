/**
 * @file f402_jwt.ts
 *
 * Decode the F402 portal bearer JWT's `nbf`/`exp` claims without exposing the token. The
 * session file's `expiresAtIso` is derived from `exp` (see `sessionFromAuth` in
 * `lib/f402_session.ts`), and the refresh runner uses the same window for its observability
 * alert. This module never returns the token and never throws.
 */

/** Bearer validity window, decoded without exposing the token. */
export interface F402TokenWindow {
  readonly nbfIso: string;
  readonly expIso: string;
  readonly windowMinutes: number;
  /** Expiry as epoch milliseconds; the basis for a derived session expiry. */
  readonly expMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Decode the bearer JWT's `nbf`/`exp` claims. Returns null for an opaque token, a missing
 * header, or an unparseable payload — never throws, and never returns the token.
 */
export function decodeF402BearerWindow(
  authorizationHeader: string | undefined,
): F402TokenWindow | null {
  if (authorizationHeader === undefined) return null;
  const raw = authorizationHeader.replace(/^Bearer\s+/i, "");
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (payloadPart === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const { nbf, exp } = decoded;
  if (typeof nbf !== "number" || typeof exp !== "number") return null;
  return {
    nbfIso: new Date(nbf * 1000).toISOString(),
    expIso: new Date(exp * 1000).toISOString(),
    windowMinutes: Math.round((exp - nbf) / 60),
    expMs: exp * 1000,
  };
}
