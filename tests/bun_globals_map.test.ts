/**
 * Bun global catalog map invariants.
 *
 * The map's central count is derived, not copied: `kindRowCount - Σ(kinds.length - 1)` must equal
 * the `data-algolia-id` distinct count. A scraper key change or a dropped kind fails here.
 *
 * The summary rules live in `lib/bun_globals_map_summaries.ts`; these cases assert the committed
 * artifact satisfies them, and call the library rather than re-implementing its logic.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  findFalsifiedTypeOnlyClaims,
  findInheritedSummaries,
  loadBunTypesDeclarations,
} from "../lib/bun_globals_map_summaries.ts";

const ROOT = join(import.meta.dir, "..");
const ROWS_PATH = join(ROOT, "docs/bun-globals-map.json");
const META_PATH = join(ROOT, "docs/bun-globals-map.meta.json");

interface MapRow {
  readonly kind: string;
  readonly symbol: string;
  readonly summary?: string;
  readonly signature: "type" | "value";
  readonly declaration: string;
}

interface SuppressedRecord {
  readonly symbol: string;
  readonly reason: string;
  readonly detail: string;
  readonly upstreamSummary: string;
}

interface MergedEntry {
  readonly symbol: string;
  readonly kinds: readonly string[];
}

interface MapMeta {
  readonly scrapedAt: string;
  readonly bunVersion: string;
  readonly bunVersionWithSha: string;
  readonly sourceBuild: string;
  readonly symbolNormalization: string;
  readonly kindRowCount: number;
  readonly distinctSymbolCount: number;
  readonly mergedExcess: number;
  readonly merged: readonly MergedEntry[];
  readonly expectedKindRows: Readonly<Record<string, number>>;
  readonly signatureCounts: Readonly<Record<"type" | "value", number>>;
  readonly summariesSuppressed?: readonly SuppressedRecord[];
  readonly bunTypes?: {
    readonly package?: string;
    readonly files?: readonly string[];
  };
}

const rows = (await Bun.file(ROWS_PATH).json()) as MapRow[];
const meta = (await Bun.file(META_PATH).json()) as MapMeta;
const declarations = loadBunTypesDeclarations(ROOT);

describe("Bun global catalog map", () => {
  test("the metadata names its key and provenance", () => {
    expect(meta.symbolNormalization).toBe("data-algolia-id");
    expect(meta.sourceBuild).toBe("bun.sh docs");
    expect(meta.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.bunVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.bunVersionWithSha).toContain(meta.bunVersion);
  });

  test("every row has a signature space and a declaration", () => {
    for (const row of rows) {
      expect(["type", "value"]).toContain(row.signature);
      expect(row.declaration.length).toBeGreaterThan(0);
    }
  });

  test("kind rows match expectedKindRows and sum to kindRowCount", () => {
    const byKind = Object.fromEntries(
      Object.keys(meta.expectedKindRows).map((kind) => [
        kind,
        rows.filter((row) => row.kind === kind).length,
      ]),
    );
    expect(byKind).toEqual(meta.expectedKindRows);
    expect(
      Object.values(meta.expectedKindRows).reduce(
        (total, count) => total + count,
        0,
      ),
    ).toBe(meta.kindRowCount);
    expect(rows.length).toBe(meta.kindRowCount);
  });

  test("signature counts match the row array", () => {
    const bySignature = {
      type: rows.filter((row) => row.signature === "type").length,
      value: rows.filter((row) => row.signature === "value").length,
    };
    expect(bySignature).toEqual(meta.signatureCounts);
  });

  test("merged excess derives the distinct symbol count", () => {
    const derivedExcess = meta.merged.reduce(
      (total, entry) => total + entry.kinds.length - 1,
      0,
    );
    expect(meta.mergedExcess).toBe(derivedExcess);
    expect(meta.kindRowCount - derivedExcess).toBe(meta.distinctSymbolCount);

    for (const entry of meta.merged) {
      const actualKinds = [
        ...new Set(
          rows
            .filter((row) => row.symbol === entry.symbol)
            .map((row) => row.kind),
        ),
      ];
      expect([...actualKinds].sort()).toEqual([...entry.kinds].sort());
    }
  });

  test("data-algolia-id distinct count matches the metadata", () => {
    expect(new Set(rows.map((row) => row.symbol)).size).toBe(
      meta.distinctSymbolCount,
    );
  });

  test("no summary claims type-only existence for a symbol the pin exposes", () => {
    const falsified = findFalsifiedTypeOnlyClaims(rows);
    expect(falsified.map((claim) => claim.symbol)).toEqual([]);
  });

  test("no summary is inherited from a base declaration", () => {
    expect(declarations).not.toBeNull();
    const inherited = findInheritedSummaries(rows, declarations!.declarations);
    expect(inherited.map((claim) => claim.symbol)).toEqual([]);
  });

  test("the declaration graph covers files beyond bun.d.ts", () => {
    expect(declarations).not.toBeNull();
    // FileSink/NetworkSink only exist in s3.d.ts; a bun.d.ts-only parse misses NetworkSink.
    expect(
      declarations!.relativeFiles.some((file) => file.endsWith("s3.d.ts")),
    ).toBe(true);
    expect(declarations!.package).toMatch(/^bun-types@\d+\.\d+\.\d+/);
    const networkSink = declarations!.declarations.get("NetworkSink");
    expect(networkSink).toBeDefined();
    expect(networkSink?.hasOwnJsDoc).toBe(false);
    expect(networkSink?.bases).toContain("FileSink");
  });

  test("suppressed summaries record their provenance and clear only their own rows", () => {
    const records = meta.summariesSuppressed ?? [];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(["types-only-falsified", "inherited-from-base"]).toContain(
        record.reason,
      );
      expect(record.detail.length).toBeGreaterThan(0);
      const row = rows.find((candidate) => candidate.symbol === record.symbol);
      expect(row).toBeDefined();
      expect((row?.summary ?? "").trim()).toBe("");
    }

    const networkSink = rows.find(
      (row) => row.symbol === "globals.bun.NetworkSink",
    );
    expect(networkSink?.summary).toBe("");
    expect(
      records.some(
        (record) =>
          record.symbol === "globals.bun.NetworkSink" &&
          record.reason === "inherited-from-base" &&
          record.detail === "FileSink",
      ),
    ).toBe(true);
    // The base keeps its own documented text.
    expect(
      rows.find((row) => row.symbol === "globals.bun.FileSink")?.summary,
    ).not.toBe("");
  });

  test("metadata records package-relative declaration provenance, never an absolute path", () => {
    expect(meta.bunTypes?.package).toMatch(/^bun-types@/);
    const files = meta.bunTypes?.files ?? [];
    expect(files.length).toBeGreaterThan(1);
    expect(files.some((file) => file.endsWith("s3.d.ts"))).toBe(true);
    for (const file of files) {
      expect(file.startsWith("/")).toBe(false);
      expect(file.includes("/Users/")).toBe(false);
    }
    expect(JSON.stringify(meta).includes("/Users/")).toBe(false);
    expect("bunTypesDeclaration" in meta).toBe(false);
  });
});
