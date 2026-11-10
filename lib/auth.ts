/**
 * @file lib/auth.ts
 * @description Operator credentials authentication, Argon2id hashing, and high-entropy token verification.
 */

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { password, type Password } from "bun";
import { loginKey, loginLimiter } from "./rate_limit.ts";

export const ARGON2ID_PARAMS = {
  algorithm: "argon2id",
  memoryCost: 47104, // 46 MiB — OWASP second-tier; KB, not bytes
  timeCost: 2,
} as const satisfies Password.Argon2Algorithm;

const TARGET_MEM_KIB = ARGON2ID_PARAMS.memoryCost;
const TARGET_TIME = ARGON2ID_PARAMS.timeCost;

/** Hash a human-chosen password. Argon2id only — never for API keys. */
export const hashPassword = (pw: string): Promise<string> =>
  password.hash(pw, ARGON2ID_PARAMS);

/**
 * Verify against a stored PHC string. Fails closed on malformed hashes
 * (treats DB corruption as a mismatch, not a throw).
 */
export const verifyPassword = async (
  pw: string,
  phc: string,
): Promise<boolean> => {
  try {
    return await password.verify(pw, phc);
  } catch {
    return false; // malformed / unsupported PHC string fails closed as mismatch
  }
};

/**
 * True if the stored hash uses weaker params than the current target,
 * or an algorithm we no longer accept. Call after a successful verify;
 * rehash-and-store on true (rehash-on-login migration).
 */
export const needsRehash = (phc: string): boolean => {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=\d+\$/.exec(phc);
  if (!m) return true; // bcrypt, argon2i/d, or garbage → upgrade to argon2id
  const [, memStr, timeStr] = m;
  return Number(memStr) < TARGET_MEM_KIB || Number(timeStr) < TARGET_TIME;
};

// ── High-entropy token path (API keys, session tokens) ──────────────────────
// Argon2 is for low-entropy human passwords. A 256-bit CSPRNG token needs only
// a fast hash + constant-time compare; argon2 here would add ~200ms per check
// for zero security gain.

export const sha256Hex = async (data: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
};

/** Generate an opaque 256-bit token (base64url) and its SHA-256 hex. */
export const mintSessionToken = async (): Promise<{
  token: string;
  hash: string;
}> => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(bytes).toString("base64url");
  return { token, hash: await sha256Hex(token) };
};

/** Constant-time compare of a presented token against a stored SHA-256 hex. */
export const tokenMatches = async (
  presented: string,
  storedHashHex: string,
): Promise<boolean> => {
  const a = new TextEncoder().encode(await sha256Hex(presented));
  const b = new TextEncoder().encode(storedHashHex);
  return constantTimeEqual(a, b);
};

// ── Rate-limited login flow ─────────────────────────────────────────────────

export type LoginFailure =
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "invalid_credentials" }
  | { kind: "disabled" };

export type LoginResult =
  | { kind: "ok"; rehash: false }
  | { kind: "ok"; rehash: true; newHash: string }
  | LoginFailure;

/**
 * Pre-worker rate limit → fetch → verify → rehash-on-login.
 * The limiter check happens BEFORE any argon2 work, so a flood cannot
 * exhaust the worker pool and starve the WS broadcast loop.
 */
export const attemptLogin = async (
  ip: string,
  username: string,
  password: string,
  deps: {
    getOperatorByUsername: (u: string) => Promise<{
      id: number;
      username: string;
      role: string;
      password_hash: string;
      disabled: boolean;
      locked_until: string | null;
    } | null>;
    hashPassword: (pw: string) => Promise<string>;
    touchLogin: (id: number) => Promise<void>;
    verifyPassword: (pw: string, phc: string) => Promise<boolean>;
    needsRehash: (phc: string) => boolean;
    recordFailedAttempt?: (id: number) => Promise<void>;
  },
): Promise<LoginResult> => {
  // 1. Pre-verify rate limit — cheap, no worker involved.
  const rl = loginLimiter.check(loginKey(ip));
  if (!rl.allowed)
    return { kind: "rate_limited", retryAfterMs: rl.retryAfterMs };

  // 2. Fetch row (auth projection only).
  const op = await deps.getOperatorByUsername(username);
  // Constant-ish time regardless of whether the user exists:
  // hash a throwaway password when there's no row, so an attacker
  // cannot distinguish "no such user" from "wrong password" by timing.
  if (!op) {
    await deps.hashPassword(password);
    return { kind: "invalid_credentials" };
  }
  if (op.disabled) return { kind: "disabled" };
  if (op.locked_until && new Date(op.locked_until).getTime() > Date.now()) {
    return { kind: "invalid_credentials" };
  }

  // 3. Verify.
  const ok = await deps.verifyPassword(password, op.password_hash);
  if (!ok) {
    await deps.recordFailedAttempt?.(op.id).catch(() => {});
    return { kind: "invalid_credentials" };
  }

  // 4. Rehash-on-login if params drifted.
  const rehash = deps.needsRehash(op.password_hash);
  let newHash: string | undefined;
  if (rehash) {
    // Caller persists the new hash — auth.ts stays storage-agnostic.
    newHash = await deps.hashPassword(password);
  }
  await deps.touchLogin(op.id);
  loginLimiter.reset(loginKey(ip));
  return rehash
    ? { kind: "ok", rehash: true, newHash: newHash! }
    : { kind: "ok", rehash: false };
};
