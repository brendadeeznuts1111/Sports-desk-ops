/**
 * @file lib/csrf.ts
 * @description Stateless CSRF token issuance and verification using native Bun.CSRF.
 * Enforces stable secret from env across multi-process clusters and HMR lifecycles.
 */

import { CSRF } from "bun";
import { SESSION_IDLE_MS } from "./session.ts";

const SECRET = process.env.SPORTSDESK_CSRF_SECRET;

// Fail closed in prod: the random in-memory default is process-local
// and silently breaks on HMR / multi-instance / rolling deploys.
if (!SECRET && process.env.NODE_ENV === "production") {
  throw new Error(
    "SPORTSDESK_CSRF_SECRET required in production (see secret_manifest)",
  );
}

export const CSRF_COOKIE_NAME = "sd_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

export interface CsrfOptions {
  secret?: string;
  maxAge?: number;
}

export const issueCsrf = (opts?: CsrfOptions): string => {
  const sec = opts?.secret ?? SECRET;
  return sec !== undefined ? CSRF.generate(sec) : CSRF.generate();
};

export const verifyCsrf = (token: string, opts?: CsrfOptions): boolean => {
  if (!token) return false;
  try {
    const sec = opts?.secret ?? SECRET;
    const verifyOpts: { secret?: string; maxAge?: number } = {
      maxAge: opts?.maxAge ?? SESSION_IDLE_MS,
    };
    if (sec !== undefined) {
      verifyOpts.secret = sec;
    }
    return CSRF.verify(token, verifyOpts);
  } catch {
    return false; // malformed token → treat as invalid, never throw to caller
  }
};
