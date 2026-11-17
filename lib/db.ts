/**
 * @file lib/db.ts
 * @description Env-gated, TLS-aware PostgreSQL connection pool via `import { env, sql, SQL } from "bun"`.
 *
 * Resolution order:
 *  1. `env.DATABASE_URL` when set: parses host/password to enforce the non-local empty-password
 *     and TLS guards, and reuses `sql` (`Bun.sql`) when TLS policy matches or constructs an explicit
 *     `new SQL(url, { tls, idleTimeout, max })` pool.
 *  2. `env.PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`: constructs `new SQL(...)`.
 *
 * Connect timeout precedence: `?connect_timeout=` in `DATABASE_URL`, then
 * `SPORTSDESK_DB_CONNECT_TIMEOUT`, then libpq's `PGCONNECT_TIMEOUT`, then 10 s.
 *
 * TLS hardening (non-local, or `SPORTSDESK_DB_TLS=1`): `SPORTSDESK_DB_CERT_FINGERPRINT`
 * pins the server certificate's SHA-256 (with the hostname check still applied),
 * `SPORTSDESK_DB_CA_FILE` supplies an explicit CA bundle, and channel binding defaults to
 * `prefer` (URL `?channel_binding=` > `SPORTSDESK_DB_CHANNEL_BINDING` > `PGCHANNELBINDING`).
 */
import { checkServerIdentity as nodeCheckServerIdentity } from "node:tls";
import type { PeerCertificate } from "node:tls";

import { env, sql as defaultBunSql, SQL } from "bun";

export const isLocalDbHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

export const DEFAULT_DB_CONNECT_TIMEOUT_SECONDS = 10;

function positiveSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Resolve the PostgreSQL connect timeout in seconds. An explicit URL
 * `connect_timeout` wins, then the repo override, then libpq's env var, then 10 s.
 * Invalid or non-positive values fall through instead of failing pool construction.
 */
export function resolveDbConnectionTimeout(
  source: Record<string, string | undefined> = env,
  urlConnectTimeout?: string | null,
): number {
  return (
    positiveSeconds(urlConnectTimeout) ??
    positiveSeconds(source.SPORTSDESK_DB_CONNECT_TIMEOUT) ??
    positiveSeconds(source.PGCONNECT_TIMEOUT) ??
    DEFAULT_DB_CONNECT_TIMEOUT_SECONDS
  );
}

export type DbChannelBinding = "disable" | "prefer" | "require";

export function resolveDbChannelBinding(
  source: Record<string, string | undefined> = env,
  urlChannelBinding?: string | null,
): DbChannelBinding {
  for (const candidate of [
    urlChannelBinding,
    source.SPORTSDESK_DB_CHANNEL_BINDING,
    source.PGCHANNELBINDING,
  ]) {
    const normalized = candidate?.trim().toLowerCase();
    if (normalized === undefined || normalized === "") continue;
    if (
      normalized === "disable" ||
      normalized === "prefer" ||
      normalized === "require"
    ) {
      return normalized;
    }
    throw new Error(
      "lib/db.ts: channel binding must be disable, prefer or require (channel_binding / SPORTSDESK_DB_CHANNEL_BINDING / PGCHANNELBINDING)",
    );
  }
  return "prefer";
}

export interface DbTlsOptions {
  readonly rejectUnauthorized: true;
  readonly ca?: ReturnType<typeof Bun.file>;
  readonly checkServerIdentity?: (
    hostname: string,
    cert: PeerCertificate,
  ) => Error | undefined;
}

function normalizeFingerprint(raw: string | undefined): string | null {
  const compact = raw?.replace(/[^0-9a-f]/gi, "") ?? "";
  return /^[0-9a-f]{64}$/i.test(compact) ? compact.toUpperCase() : null;
}

/**
 * TLS policy for PostgreSQL/MySQL. Localhost stays plaintext unless
 * `SPORTSDESK_DB_TLS=1`. A non-empty `SPORTSDESK_DB_CERT_FINGERPRINT` pins the
 * server certificate's SHA-256 (colon-separated or bare, 64 hex chars) and still
 * runs the hostname check; a malformed pin fails closed rather than silently
 * disabling the pin.
 */
export function resolveDbTlsConfig(
  source: Record<string, string | undefined> = env,
  options: { readonly local: boolean; readonly forceTls: boolean },
): false | DbTlsOptions {
  if (options.local && !options.forceTls) return false;
  const caPath = source.SPORTSDESK_DB_CA_FILE?.trim();
  const ca =
    caPath === undefined || caPath === "" ? undefined : Bun.file(caPath);
  const base = {
    rejectUnauthorized: true as const,
    ...(ca === undefined ? {} : { ca }),
  };
  const rawPin = source.SPORTSDESK_DB_CERT_FINGERPRINT?.trim();
  let expected: string | null = null;
  if (rawPin !== undefined && rawPin !== "") {
    expected = normalizeFingerprint(rawPin);
    if (expected === null) {
      throw new Error(
        "lib/db.ts: SPORTSDESK_DB_CERT_FINGERPRINT must be a SHA-256 fingerprint (64 hex chars)",
      );
    }
  }
  if (expected === null) return base;
  const pin = expected;
  return {
    ...base,
    checkServerIdentity: (hostname, cert) => {
      const actual = normalizeFingerprint(cert.fingerprint256);
      if (actual === null || actual !== pin) {
        return new Error(
          "lib/db.ts: database certificate fingerprint mismatch",
        );
      }
      return nodeCheckServerIdentity(hostname, cert);
    },
  };
}

const required = (k: keyof Bun.Env): string => {
  const v = env[k];
  if (v === undefined || v === null)
    throw new Error(`lib/db.ts: missing required env ${String(k)}`);
  return v;
};

let _sqlInstance: SQL | null = null;
let _usingDefaultGlobal = false;

export function createConfiguredSql(): {
  readonly db: SQL;
  readonly isDefaultGlobal: boolean;
} {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl !== undefined && databaseUrl !== "") {
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error("lib/db.ts: invalid DATABASE_URL");
    }
    const host = parsed.hostname || "localhost";
    const local = isLocalDbHost(host);
    const password = decodeURIComponent(parsed.password ?? "");
    if (!local && password === "") {
      throw new Error(
        `lib/db.ts: PGPASSWORD required for non-local host ${host}`,
      );
    }
    const forceTls = env.SPORTSDESK_DB_TLS === "1";
    // When connecting locally without forced TLS, Bun's built-in `Bun.sql` default client
    // already points at `DATABASE_URL`.
    if (local && !forceTls) {
      return { db: defaultBunSql, isDefaultGlobal: true };
    }
    const tls = resolveDbTlsConfig(env, { local, forceTls });
    const channelBinding = resolveDbChannelBinding(
      env,
      parsed.searchParams.get("channel_binding"),
    );
    const connectionTimeout = resolveDbConnectionTimeout(
      env,
      parsed.searchParams.get("connect_timeout"),
    );
    return {
      db: new SQL(databaseUrl, {
        tls,
        idleTimeout: 30,
        max: 20,
        connectionTimeout,
        channelBinding,
        onconnect: (err) => {
          if (err) console.error("[db] connect failed:", err.message);
        },
      }),
      isDefaultGlobal: false,
    };
  }

  const host = env.PGHOST ?? "localhost";
  const local = isLocalDbHost(host);

  const user = required("PGUSER");
  const password = required("PGPASSWORD");

  if (!local && password === "") {
    throw new Error(
      `lib/db.ts: PGPASSWORD required for non-local host ${host}`,
    );
  }

  const forceTls = env.SPORTSDESK_DB_TLS === "1";
  const tls = resolveDbTlsConfig(env, { local, forceTls });
  const channelBinding = resolveDbChannelBinding(env);
  const connectionTimeout = resolveDbConnectionTimeout(env);

  return {
    db: new SQL({
      hostname: host,
      port: Number(env.PGPORT ?? 5432),
      username: user,
      password,
      database: env.PGDATABASE ?? "myapp",
      tls,
      idleTimeout: 30, // seconds
      max: 20,
      connectionTimeout,
      channelBinding,
      onconnect: (err) => {
        if (err) console.error("[db] connect failed:", err.message);
      },
    }),
    isDefaultGlobal: false,
  };
}

function getSql(): SQL {
  if (!_sqlInstance) {
    const resolved = createConfiguredSql();
    _sqlInstance = resolved.db;
    _usingDefaultGlobal = resolved.isDefaultGlobal;
  }
  return _sqlInstance;
}

/**
 * Lazy proxy to `Bun.SQL` / `Bun.sql` PostgreSQL connection pool.
 * Defers reading required environment variables (`DATABASE_URL` or `PGUSER`/`PGPASSWORD`) until first query.
 */
export const sql: SQL = new Proxy((() => {}) as unknown as SQL, {
  apply(_target, _thisArg, args) {
    const db = getSql();
    return Reflect.apply(
      db as unknown as (...a: unknown[]) => unknown,
      db,
      args,
    );
  },
  get(_target, prop) {
    if (prop === "close") {
      return async () => {
        if (_sqlInstance) {
          const inst = _sqlInstance;
          const wasDefault = _usingDefaultGlobal;
          _sqlInstance = null;
          _usingDefaultGlobal = false;
          if (!wasDefault) {
            await inst.close();
          }
        }
      };
    }
    const db = getSql();
    const val = Reflect.get(db, prop);
    return typeof val === "function" ? val.bind(db) : val;
  },
});

/** Typed row shapes — never `SELECT *`. */
export interface OperatorListRow {
  id: number;
  username: string;
  role: "admin" | "operator" | "viewer";
  disabled: boolean;
  /** ISO-ish text — cast in SQL, never a JS Date, never a Temporal. */
  created_at: string;
}

/** Auth-only projection: includes password_hash. Do NOT use for list views. */
export interface OperatorAuthRow extends OperatorListRow {
  password_hash: string;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
}

const LIST_COLS =
  "id, username, role, disabled, created_at::text AS created_at";
const AUTH_COLS = `${LIST_COLS}, password_hash, failed_attempts, locked_until::text AS locked_until, last_login_at::text AS last_login_at`;

export const listOperators = async (): Promise<OperatorListRow[]> =>
  sql<
    OperatorListRow[]
  >`SELECT ${sql.unsafe(LIST_COLS)} FROM operators ORDER BY id`;

export const getOperatorByUsername = async (
  username: string,
): Promise<OperatorAuthRow | null> => {
  const rows = await sql<OperatorAuthRow[]>`
    SELECT ${sql.unsafe(AUTH_COLS)}
    FROM operators
    WHERE LOWER(username) = LOWER(${username})
    LIMIT 1
  `;
  return rows[0] ?? null;
};

export const touchLogin = async (id: number): Promise<void> => {
  await sql`UPDATE operators SET last_login_at = NOW(), failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ${id}`;
};

export const updatePasswordHash = async (
  id: number,
  newHash: string,
): Promise<void> => {
  await sql`UPDATE operators SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${id}`;
};

export const recordFailedAttempt = async (id: number): Promise<void> => {
  await sql`
    UPDATE operators
    SET failed_attempts = failed_attempts + 1,
        locked_until = CASE
          WHEN failed_attempts + 1 >= 10 THEN NOW() + INTERVAL '15 minutes'
          ELSE locked_until
        END
    WHERE id = ${id}
  `;
};

/** HMR: close the pool on reload so dev sessions don't leak connections. */
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    try {
      await sql.close();
    } catch (e) {
      console.error("[db] close failed:", e);
    }
  });
}
