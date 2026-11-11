/**
 * @file lib/db.ts
 * @description Env-gated, TLS-aware PostgreSQL connection pool via `import { env, sql, SQL } from "bun"`.
 *
 * Resolution order:
 *  1. `env.DATABASE_URL` when set: parses host/password to enforce the non-local empty-password
 *     and TLS guards, and reuses `sql` (`Bun.sql`) when TLS policy matches or constructs an explicit
 *     `new SQL(url, { tls, idleTimeout, max })` pool.
 *  2. `env.PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`: constructs `new SQL(...)`.
 */
import { env, sql as defaultBunSql, SQL } from "bun";

export const isLocalDbHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

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
    const tls = local && !forceTls ? false : { rejectUnauthorized: true };
    return {
      db: new SQL(databaseUrl, {
        tls,
        idleTimeout: 30,
        max: 20,
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

  // TLS: forced off for localhost (dev), required everywhere else.
  // SPORTSDESK_DB_TLS=1 flips it on even for local (e.g. docker with certs).
  const tls =
    local && env.SPORTSDESK_DB_TLS !== "1"
      ? false
      : { rejectUnauthorized: true };

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
