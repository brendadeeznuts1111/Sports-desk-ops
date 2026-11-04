import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import type { DecodedManifestTable } from "../lib/schema_binary.ts";
import {
  ManifestDumpParityFailedError,
  SCHEMA_DUMP_PARITY_POLICY_EXIT,
  assertManifestMatchesDump,
  assertManifestMatchesLiveDb,
  collectManifestDumpParityDiagnostics,
  exitCodeFromParityDiagnostics,
  runManifestDumpParity,
} from "../lib/schema_manifest_db_parity.ts";
import { allowlistRotWarnings } from "../lib/schema_prod_dump.ts";
import {
  buildRegistryBaselineProdDump,
  captureProdSchemaFromDb,
  filterVisibleXInfoColumns,
  parseProdSchemaDump,
} from "../lib/schema_prod_dump.ts";
import { decodeManifest, encodeManifest } from "../lib/schema_binary.ts";
import { buildSqliteSchemaReport } from "../lib/schema_report.ts";

const fixtureManifest: DecodedManifestTable[] = [
  {
    table: "ingestion_trades",
    columns: [
      { column: "id", kind: "integer_pk", nullable: false },
      { column: "qty", kind: "integer", nullable: true },
      { column: "note", kind: "text", nullable: true },
    ],
  },
];

function prodDumpFromManifest(
  manifest: DecodedManifestTable[],
  tableSql: Record<string, string>,
): ReturnType<typeof parseProdSchemaDump> {
  const dir = mkdtempSync(join(tmpdir(), "schema-parity-"));
  const dbPath = join(dir, "t.sqlite");
  const db = new Database(dbPath);
  for (const [, sql] of Object.entries(tableSql)) {
    db.exec(sql);
  }
  db.close();
  return captureProdSchemaFromDb(dbPath, "test-fixture");
}

describe("schema_manifest_db_parity", () => {
  test("assertManifestMatchesDump passes when dump matches manifest", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT
        );
      `,
    });
    expect(() =>
      assertManifestMatchesDump(dump, fixtureManifest, {
        strictProdOnlyTables: false,
      }),
    ).not.toThrow();
  });

  test("assertManifestMatchesDump fails on extra dump column", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT,
          surprise_column TEXT
        );
      `,
    });
    expect(() =>
      assertManifestMatchesDump(dump, fixtureManifest, {
        strictProdOnlyTables: false,
      }),
    ).toThrow(/surprise_column in dump but not in manifest/);
  });

  test("assertManifestMatchesDump fails on prod-only table when strict", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT
        );
      `,
      orphan_hotfix: `CREATE TABLE orphan_hotfix (x TEXT);`,
    });
    expect(() =>
      assertManifestMatchesDump(dump, fixtureManifest, {
        strictProdOnlyTables: true,
      }),
    ).toThrow(/prod-only table: orphan_hotfix/);
  });

  test("nullability: manifest nullable, dump NOT NULL", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER NOT NULL,
          note TEXT
        );
      `,
    });
    expect(() =>
      assertManifestMatchesDump(dump, fixtureManifest, {
        strictProdOnlyTables: false,
      }),
    ).toThrow(/manifest nullable, dump NOT NULL/);
  });

  test("nullability: manifest NOT NULL, dump nullable", () => {
    const manifest: DecodedManifestTable[] = [
      {
        table: "prices",
        columns: [{ column: "price", kind: "real", nullable: false }],
      },
    ];
    const dump = prodDumpFromManifest(manifest, {
      prices: `CREATE TABLE prices (price REAL);`,
    });
    expect(() =>
      assertManifestMatchesDump(dump, manifest, {
        strictProdOnlyTables: false,
      }),
    ).toThrow(/manifest NOT NULL, dump nullable/);
  });

  test("nullability: manifest nullable, dump NOT NULL (notes)", () => {
    const manifest: DecodedManifestTable[] = [
      {
        table: "notes",
        columns: [{ column: "notes", kind: "text", nullable: true }],
      },
    ];
    const dump = prodDumpFromManifest(manifest, {
      notes: `CREATE TABLE notes (notes TEXT NOT NULL);`,
    });
    expect(() =>
      assertManifestMatchesDump(dump, manifest, {
        strictProdOnlyTables: false,
      }),
    ).toThrow(/manifest nullable, dump NOT NULL/);
  });

  test("integer_pk with notnull=0 skips nullability compare", () => {
    const manifest: DecodedManifestTable[] = [
      {
        table: "t",
        columns: [{ column: "id", kind: "integer_pk", nullable: false }],
      },
    ];
    const dump = prodDumpFromManifest(manifest, {
      t: `CREATE TABLE t (id INTEGER PRIMARY KEY);`,
    });
    expect(() =>
      assertManifestMatchesDump(dump, manifest, {
        strictProdOnlyTables: false,
      }),
    ).not.toThrow();
  });

  test("manifest matches registry baseline dump", () => {
    const report = buildSqliteSchemaReport();
    const manifest = decodeManifest(encodeManifest(report));
    const baseline = buildRegistryBaselineProdDump();
    expect(() =>
      assertManifestMatchesDump(baseline, manifest, {
        strictProdOnlyTables: true,
      }),
    ).not.toThrow();
  });

  test("parseProdSchemaDump rejects newer format_version", () => {
    expect(() =>
      parseProdSchemaDump({
        format_version: 99,
        captured_at: "x",
        source: "y",
        tables: {},
      }),
    ).toThrow(/format v99 unsupported; upgrade parity code/);
  });

  test("parseProdSchemaDump rejects obsolete format_version", () => {
    expect(() =>
      parseProdSchemaDump({
        format_version: 0,
        captured_at: "x",
        source: "y",
        tables: {},
      }),
    ).toThrow(/format v0 obsolete; re-run schema:dump-prod/);
  });

  test("fixture allowlist permits prod-only tables in CI", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT
        );
      `,
      ingestion_trades_backup_2026_10: `CREATE TABLE ingestion_trades_backup_2026_10 (x TEXT);`,
    });
    dump.allowlist = {
      ingestion_trades_backup_2026_10: {
        reason: "leftover from migration 0042",
        review_by: "2099-12-31",
      },
    };
    expect(() =>
      assertManifestMatchesDump(dump, fixtureManifest, {
        strictProdOnlyTables: true,
      }),
    ).not.toThrow();
  });

  test("parity reports stale allowlist and structural drift in one pass", () => {
    const manifest: DecodedManifestTable[] = [
      {
        table: "ingestion_trades",
        columns: [{ column: "price", kind: "real", nullable: false }],
      },
    ];
    const dump = prodDumpFromManifest(manifest, {
      ingestion_trades: `CREATE TABLE ingestion_trades (price REAL);`,
    });
    dump.allowlist = {
      orphan_hotfix: {
        reason: "temporary",
        review_by: "2020-01-01",
      },
    };
    dump.tables.orphan_hotfix = [
      { name: "x", type: "TEXT", notnull: 0, pk: 0, hidden: 0 },
    ];

    const diagnostics = collectManifestDumpParityDiagnostics(dump, manifest, {
      strictProdOnlyTables: true,
      strictStaleAllowlist: true,
    });
    const messages = diagnostics.map((d) => d.message).join("\n");
    expect(messages).toMatch(/STALE.*orphan_hotfix/);
    expect(messages).toMatch(
      /manifest NOT NULL, dump nullable|ingestion_trades\.price/,
    );
    expect(exitCodeFromParityDiagnostics(diagnostics)).toBe(
      SCHEMA_DUMP_PARITY_POLICY_EXIT,
    );
  });

  test("stale allowlist fails under strictStaleAllowlist", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT
        );
      `,
      orphan_hotfix: `CREATE TABLE orphan_hotfix (x TEXT);`,
    });
    dump.allowlist = {
      orphan_hotfix: {
        reason: "temporary",
        review_by: "2020-01-01",
      },
    };
    expect(() =>
      assertManifestMatchesDump(dump, fixtureManifest, {
        strictProdOnlyTables: true,
        strictStaleAllowlist: true,
      }),
    ).toThrow(ManifestDumpParityFailedError);
  });

  test("allowlist rot warns when entry is orphaned", () => {
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT
        );
      `,
    });
    dump.allowlist = {
      gone_table: { reason: "was temporary", review_by: null },
    };
    const warnings = allowlistRotWarnings(dump, new Set(["ingestion_trades"]));
    expect(warnings[0]).toMatch(/gone_table.*orphaned/);
  });

  test("runManifestDumpParity logs bypass to stderr", () => {
    const prevCi = Bun.env.CI;
    delete Bun.env.CI;
    const dump = prodDumpFromManifest(fixtureManifest, {
      ingestion_trades: `
        CREATE TABLE ingestion_trades (
          id INTEGER PRIMARY KEY,
          qty INTEGER,
          note TEXT
        );
      `,
      extra: `CREATE TABLE extra (x TEXT);`,
    });
    const stderrLines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      stderrLines.push(String(args[0]));
      orig(...args);
    };
    try {
      const code = runManifestDumpParity(dump, fixtureManifest, {
        strictProdOnlyTables: true,
        allowlistBypass: true,
      });
      expect(code).toBe(0);
      expect(stderrLines.some((l) => l.includes("[BYPASS]"))).toBe(true);
    } finally {
      console.error = orig;
      if (prevCi === undefined) delete Bun.env.CI;
      else Bun.env.CI = prevCi;
    }
  });

  test("table_xinfo includes stored generated columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-xinfo-"));
    const dbPath = join(dir, "t.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE g (
        a INTEGER,
        b INTEGER GENERATED ALWAYS AS (a * 2) STORED
      );
    `);
    db.close();
    const dump = captureProdSchemaFromDb(dbPath, "test");
    const cols = dump.tables.g?.map((c) => c.name) ?? [];
    expect(cols).toContain("a");
    expect(cols).toContain("b");
  });

  test("filterVisibleXInfoColumns drops hidden rowid alias", () => {
    const visible = filterVisibleXInfoColumns([
      { name: "a", type: "INT", notnull: 0, pk: 0, hidden: 0 },
      { name: "rowid", type: "", notnull: 0, pk: 0, hidden: 1 },
      { name: "gen", type: "INT", notnull: 0, pk: 0, hidden: 2 },
    ]);
    expect(visible.map((c) => c.name)).toEqual(["a", "gen"]);
  });

  test("assertManifestMatchesLiveDb delegates to dump parity", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-live-"));
    const dbPath = join(dir, "live.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE ingestion_trades (
        id INTEGER PRIMARY KEY,
        qty INTEGER,
        note TEXT
      );
    `);
    db.close();
    expect(() =>
      assertManifestMatchesLiveDb(dbPath, fixtureManifest, {
        strictProdOnlyTables: false,
      }),
    ).not.toThrow();
  });
});
