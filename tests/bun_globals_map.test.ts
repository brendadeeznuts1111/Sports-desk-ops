/**
 * Bun global catalog map invariants.
 *
 * The map's central count is derived, not copied: `kindRowCount - Σ(kinds.length - 1)` must equal
 * the `data-algolia-id` distinct count. A scraper key change or a dropped kind fails here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ROWS_PATH = join(ROOT, "docs/bun-globals-map.json");
const META_PATH = join(ROOT, "docs/bun-globals-map.meta.json");

interface MapRow {
  readonly kind: string;
  readonly symbol: string;
  readonly signature: "type" | "value";
  readonly declaration: string;
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
}

const rows = (await Bun.file(ROWS_PATH).json()) as MapRow[];
const meta = (await Bun.file(META_PATH).json()) as MapMeta;

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
});
