/**
 * One `Bun.FetchSession` per F402 origin, each verifying certificates, with a one-time DNS
 * prefetch the first time an origin is used.
 *
 * `fetch.preconnect` is not used: it dials into the default connection pool, and a session keeps
 * its own pool, so a preconnected socket is never reused by a session request (Bun
 * src/runtime/webcore/fetch.rs `preconnect`, fetch/FetchSession.rs `pool`). The DNS cache is shared.
 *
 * A request's own `tls` replaces the session's as a whole (bun-types `FetchSessionInit.tls`), so a
 * per-request `tls` is refused instead of being allowed to turn verification off.
 */

import { prefetchDns } from "./preflight.ts";

export type F402WireFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface F402FetchSessionLike {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  close(): void;
}

export interface F402FetchSessionTls {
  readonly rejectUnauthorized: true;
}

export const F402_FETCH_SESSION_TLS: F402FetchSessionTls = Object.freeze({
  rejectUnauthorized: true,
});

/** Certificate verification codes from Bun src/http/error.rs, plus its handshake failure. */
export const F402_TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  "AKID_ISSUER_SERIAL_MISMATCH",
  "AKID_SKID_MISMATCH",
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_SIGNATURE_FAILURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "KEYUSAGE_NO_CERTSIGN",
  "KEYUSAGE_NO_CRL_SIGN",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "SUBJECT_ISSUER_MISMATCH",
  "TLSHandshakeFailed",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_CRL_ISSUER",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNHANDLED_CRITICAL_EXTENSION",
  "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
]);

export class F402TlsVerificationError extends Error {
  readonly origin: string;
  readonly code: string;

  constructor(origin: string, code: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`TLS verification failed for ${origin}: ${code} (${detail})`, {
      cause,
    });
    this.name = "F402TlsVerificationError";
    this.origin = origin;
    this.code = code;
  }
}

export class F402FetchSessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "F402FetchSessionConfigError";
  }
}

export function tlsErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && F402_TLS_ERROR_CODES.has(code)
    ? code
    : null;
}

export function f402FetchOrigin(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new F402FetchSessionConfigError(
      `F402 fetch needs an absolute URL, got ${String(url)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new F402FetchSessionConfigError(
      `F402 fetch supports http(s) only, got ${parsed.protocol}`,
    );
  }
  return parsed.origin;
}

function warmOriginDns(origin: string): void {
  const parsed = new URL(origin);
  const port =
    parsed.port !== ""
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
  prefetchDns(parsed.hostname, port);
}

export interface F402FetchSessionPoolOptions {
  readonly createSession?: (init: {
    readonly tls: F402FetchSessionTls;
  }) => F402FetchSessionLike;
  readonly warm?: (origin: string) => void;
}

export class F402FetchSessionPool {
  private readonly sessions = new Map<string, F402FetchSessionLike>();
  private readonly createSession: NonNullable<
    F402FetchSessionPoolOptions["createSession"]
  >;
  private readonly warm: (origin: string) => void;

  constructor(options: F402FetchSessionPoolOptions = {}) {
    this.createSession =
      options.createSession ??
      ((init) => new Bun.FetchSession({ tls: { ...init.tls } }));
    this.warm = options.warm ?? warmOriginDns;
  }

  get size(): number {
    return this.sessions.size;
  }

  origins(): readonly string[] {
    return [...this.sessions.keys()];
  }

  sessionFor(url: string | URL): F402FetchSessionLike {
    const origin = f402FetchOrigin(url);
    const existing = this.sessions.get(origin);
    if (existing !== undefined) return existing;
    const session = this.createSession({ tls: F402_FETCH_SESSION_TLS });
    this.sessions.set(origin, session);
    this.warm(origin);
    return session;
  }

  readonly fetch: F402WireFetch = async (url, init) => {
    if (init !== undefined && "tls" in init) {
      throw new F402FetchSessionConfigError(
        "per-request tls is refused: it would replace the session's certificate verification",
      );
    }
    const origin = f402FetchOrigin(url);
    const session = this.sessionFor(origin);
    try {
      return await session.fetch(url, init);
    } catch (error) {
      const code = tlsErrorCode(error);
      if (code !== null)
        throw new F402TlsVerificationError(origin, code, error);
      throw error;
    }
  };

  closeIdle(): void {
    for (const session of this.sessions.values()) session.close();
  }
}

export const f402FetchSessions = new F402FetchSessionPool();

export const f402Fetch: F402WireFetch = f402FetchSessions.fetch;
