/**
 * @file lib/session.ts
 * @description Secure operator session management with SHA-256 token hashing, sliding idle timeouts, and throttled activity touches.
 */

import { Buffer } from "node:buffer";
import { sql, type OperatorListRow } from "./db.ts";
import { sha256Hex } from "./auth.ts";

// ── Tunables ────────────────────────────────────────────────────────────────
/** Absolute lifetime — hard cap, regardless of activity. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Idle timeout — no successful verify for this long → session dies. */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // 8 hours
/** Minimum gap between last_seen_at writes per session. */
export const SESSION_LAST_SEEN_THROTTLE_MS = 60 * 1000; // 1 minute

/** Cookie name — used by the HTTP layer, not by these helpers. */
export const SESSION_COOKIE_NAME = "sd_session";

/**
 * Recommended cookie attributes for the HTTP layer:
 *   name:     sd_session
 *   httpOnly: true
 *   secure:   !isLocalhost
 *   sameSite: "Lax"      // "Strict" if CSRF tokens are fully rolled out
 *   path:     "/"
 *   maxAge:   SESSION_TTL_MS / 1000
 */

const nowIso = (): string => new Date().toISOString();
const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

export interface IssuedSession {
  /** Raw token — send to the client once, never store or log. */
  token: string;
  /** ISO-8601 — matches the row's expires_at. */
  expiresAt: string;
}

/** Create a fresh session for an operator. Does not touch any existing rows. */
export const sessionCreate = async (
  operatorId: number,
  ip?: string,
  userAgent?: string,
  db = sql,
): Promise<IssuedSession> => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(bytes).toString("base64url");
  const hash = await sha256Hex(token);
  const expiresAt = isoIn(SESSION_TTL_MS);

  await db`
    INSERT INTO sessions (token_hash, operator_id, expires_at, ip, user_agent)
    VALUES (
      ${hash},
      ${operatorId},
      ${expiresAt}::timestamptz,
      ${ip ?? null},
      ${userAgent ?? null}
    )
  `;
  return { token, expiresAt };
};

/**
 * Issue a new session and revoke the previous one atomically from the caller's
 * perspective (the old token stops working the moment this returns).
 *
 * Pass `oldToken` for periodic rotation / privilege change; pass `null` for login.
 */
export const sessionRotate = async (
  oldToken: string | null,
  operatorId: number,
  ip?: string,
  userAgent?: string,
  db = sql,
): Promise<IssuedSession> => {
  return db.begin(async (tx) => {
    const issued = await sessionCreate(operatorId, ip, userAgent, tx);
    if (oldToken) {
      const oldHash = await sha256Hex(oldToken);
      await tx`DELETE FROM sessions WHERE token_hash = ${oldHash}`;
    }
    return issued;
  });
};

export interface VerifiedSession {
  operator: OperatorListRow;
  session: { expiresAt: string; lastSeenAt: string };
}

/**
 * Validate a raw token. Returns null for: unknown token, expired, idle-expired,
 * or operator disabled. Updates last_seen_at on a throttle (≤ 1 write/min).
 *
 * No constant-time compare is needed: lookup is on the SHA-256 (preimage
 * resistance 2^256) via an indexed B-tree, so timing cannot reveal stored
 * values or let an attacker enumerate tokens.
 */
export const sessionVerify = async (
  rawToken: string,
  db = sql,
): Promise<VerifiedSession | null> => {
  if (!rawToken) return null;

  const hash = await sha256Hex(rawToken);
  const now = nowIso();
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_MS).toISOString();

  const rows = await db<
    {
      id: number;
      username: string;
      role: "admin" | "operator" | "viewer";
      disabled: boolean;
      created_at: string;
      expires_at: string;
      last_seen_at: string;
    }[]
  >`
    SELECT
      o.id,
      o.username,
      o.role,
      o.disabled,
      o.created_at::text          AS created_at,
      s.expires_at::text          AS expires_at,
      s.last_seen_at::text        AS last_seen_at
    FROM sessions s
    JOIN operators o ON o.id = s.operator_id
    WHERE s.token_hash = ${hash}
      AND s.expires_at   > ${now}::timestamptz
      AND s.last_seen_at > ${idleCutoff}::timestamptz
      AND o.disabled = FALSE
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  // Throttled touch — updates at most once per SESSION_LAST_SEEN_THROTTLE_MS.
  const throttleCutoff = new Date(
    Date.now() - SESSION_LAST_SEEN_THROTTLE_MS,
  ).toISOString();
  await db`
    UPDATE sessions
    SET last_seen_at = ${now}::timestamptz
    WHERE token_hash = ${hash}
      AND last_seen_at < ${throttleCutoff}::timestamptz
  `;

  return {
    operator: {
      id: row.id,
      username: row.username,
      role: row.role,
      disabled: row.disabled,
      created_at: row.created_at,
    },
    session: { expiresAt: row.expires_at, lastSeenAt: row.last_seen_at },
  };
};

/** Logout: delete one session by raw token. No-op if already gone. */
export const sessionRevoke = async (
  rawToken: string,
  db = sql,
): Promise<void> => {
  const hash = await sha256Hex(rawToken);
  await db`DELETE FROM sessions WHERE token_hash = ${hash}`;
};

/** Logout-everywhere / admin action: revoke all sessions for an operator. */
export const sessionRevokeAllForOperator = async (
  operatorId: number,
  db = sql,
): Promise<number> => {
  const rows = await db<{ token_hash: string }[]>`
    DELETE FROM sessions WHERE operator_id = ${operatorId} RETURNING token_hash
  `;
  return rows.length;
};

/**
 * Sweep expired, idle-expired, and disabled-operator sessions.
 * Safe to call from the health probe or a periodic maintenance task.
 */
export const sessionCleanup = async (db = sql): Promise<number> => {
  const now = nowIso();
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_MS).toISOString();
  const rows = await db<{ token_hash: string }[]>`
    DELETE FROM sessions s
    WHERE s.expires_at   <= ${now}::timestamptz
       OR s.last_seen_at <= ${idleCutoff}::timestamptz
       OR s.operator_id IN (SELECT id FROM operators WHERE disabled = TRUE)
    RETURNING s.token_hash
  `;
  return rows.length;
};

// snake_case aliases for call sites that prefer the spec-style names.
export {
  sessionCreate as session_create,
  sessionRotate as session_rotate,
  sessionVerify as session_verify,
  sessionRevoke as session_revoke,
};
