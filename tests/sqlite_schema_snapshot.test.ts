import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSqliteSchemaReportForTable } from "../lib/schema_report.ts";
import { MATCH_EVALUATIONS_TABLE } from "../lib/sqlite_schema_registry.ts";
import {
  emitSnapshot,
  schemaReportJsonDocument,
} from "../lib/sqlite_schema_snapshot.ts";
import { decodeManifest } from "../lib/schema_binary.ts";

describe("sqlite_schema_snapshot", () => {
  test("emitSnapshot writes via file URL (Bun.write accepts URL)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-snap-"));
    const outUrl = Bun.pathToFileURL(join(dir, "manifest.bin"));
    const report = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const returned = await emitSnapshot(report, outUrl);
    expect(returned.href).toBe(outUrl.href);
    const bytes = new Uint8Array(await Bun.file(outUrl).arrayBuffer());
    expect(decodeManifest(bytes).length).toBe(1);
  });

  test("schemaReportJsonDocument serializes docsUrl.href", () => {
    const report = buildSqliteSchemaReportForTable(MATCH_EVALUATIONS_TABLE)!;
    const manifestUrl = Bun.pathToFileURL("/tmp/schema.manifest.bin");
    const doc = schemaReportJsonDocument(report, manifestUrl);
    expect(doc.manifestUrl).toBe(manifestUrl.href);
    expect(doc.summary[0]?.docsUrl).toContain("sqlite_schema_registry.ts");
    expect(doc.summary[0]?.docsUrl).toContain("match_evaluations");
  });
});
