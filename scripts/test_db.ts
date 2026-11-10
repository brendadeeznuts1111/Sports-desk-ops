#!/usr/bin/env bun
/**
 * @file scripts/test_db.ts
 * @description Isolated test database lifecycle runner:
 *  - Drops & recreates database `sportsdesk_test` using native Bun.SQL
 *  - Executes migrations via `scripts/migrate.ts`
 *  - Executes `tests/db_integration.test.ts`
 *  - Automatically drops `sportsdesk_test` on completion (unless `--keep` is passed)
 */

import { SQL } from "bun";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const help = args.includes("-h") || args.includes("--help");

if (help) {
  console.log(`Usage: bun scripts/test_db.ts [options]

Options:
  --keep     Keep the sportsdesk_test database after test run (for inspection)
  -h, --help Show this help
`);
  process.exit(0);
}

const host = process.env.PGHOST ?? "localhost";
const port = Number(process.env.PGPORT ?? 5432);
const username = process.env.PGUSER ?? process.env.USER ?? "nolarose";
const password = process.env.PGPASSWORD ?? "";
const testDbName = process.env.PGDATABASE ?? "sportsdesk_test";

console.log(
  `[test_db] preparing test database "${testDbName}" on ${host}:${port}...`,
);

const adminSql = new SQL({
  hostname: host,
  port,
  username,
  password,
  database: "postgres",
  tls: false,
});

try {
  await adminSql.unsafe(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await adminSql.unsafe(`CREATE DATABASE ${testDbName}`);
  console.log(`[test_db] fresh "${testDbName}" created.`);
} catch (err) {
  console.error("[test_db] failed to recreate test database:", err);
  await adminSql.close();
  process.exit(1);
} finally {
  await adminSql.close();
}

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PGHOST: host,
  PGPORT: String(port),
  PGUSER: username,
  PGPASSWORD: password,
  PGDATABASE: testDbName,
  SPORTSDESK_CSRF_SECRET:
    process.env.SPORTSDESK_CSRF_SECRET ??
    "sportsdesk_test_csrf_secret_integration_key_32chars",
};

// 1. Run migrations
console.log(`[test_db] running migrations...`);
const migrateProc = Bun.spawnSync(["bun", "scripts/migrate.ts"], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});

if (migrateProc.exitCode !== 0) {
  console.error("[test_db] migrations failed with code", migrateProc.exitCode);
  process.exit(migrateProc.exitCode);
}

// 2. Run tests
console.log(
  `[test_db] running integration suite tests/db_integration.test.ts...`,
);
const testProc = Bun.spawnSync(
  ["bun", "test", "tests/db_integration.test.ts"],
  {
    env,
    stdout: "inherit",
    stderr: "inherit",
  },
);

const testExitCode = testProc.exitCode;

// 3. Teardown
if (keep) {
  console.log(`[test_db] keeping "${testDbName}" (--keep specified).`);
} else {
  console.log(`[test_db] dropping test database "${testDbName}"...`);
  const teardownSql = new SQL({
    hostname: host,
    port,
    username,
    password,
    database: "postgres",
    tls: false,
  });
  try {
    await teardownSql.unsafe(
      `DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`,
    );
    console.log(`[test_db] "${testDbName}" dropped cleanly.`);
  } catch (e) {
    console.warn("[test_db] teardown drop failed:", e);
  } finally {
    await teardownSql.close();
  }
}

process.exit(testExitCode);
