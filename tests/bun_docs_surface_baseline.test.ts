/**
 * @file tests/bun_docs_surface_baseline.test.ts
 * @description Offline coverage gate for `tests/bun_docs_surface_baseline.json`.
 *
 * The online audit (`bun run bun:docs-mcp surfaces --update <path>`) is the only way to refresh
 * the baseline. This test makes the *coverage* half of that contract run in the inner loop, so a
 * new catalogue shape cannot ship with the baseline silently behind it (that happened when the
 * catalogue grew from 95 to 128 rows).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkBunShapeDocsBaseline,
  type BunShapeDocsBaseline,
} from "../scripts/bun_docs_mcp.ts";

const ROOT = join(import.meta.dir, "..");
const BASELINE_PATH = join(ROOT, "tests/bun_docs_surface_baseline.json");

describe("Bun docs surface baseline", () => {
  test("covers every catalogue shape, with no stale entries", async () => {
    const baseline = (await Bun.file(
      BASELINE_PATH,
    ).json()) as BunShapeDocsBaseline;
    expect(checkBunShapeDocsBaseline(baseline)).toEqual([]);
  });

  test("records generatedAt and runtime provenance", async () => {
    const baseline = (await Bun.file(
      BASELINE_PATH,
    ).json()) as BunShapeDocsBaseline;
    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(baseline.runtime).toBe(`Bun ${Bun.version}`);
  });
});
