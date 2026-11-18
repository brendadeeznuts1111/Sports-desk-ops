/**
 * @file tests/bun_release_behaviors.test.ts
 * @description Keeps the measured release-behavior registry honest.
 *
 * The registry is derived: `<!-- bun-behavior: <id> -->` in the reference doc supplies the
 * section, `// @bun-behavior: <id>` in a contract test supplies the evidence, and only the
 * human metadata lives in `lib/bun_release_behaviors.ts`. These cases assert the merged view:
 * every row has both anchors, every contract test actually carries its tag, and every shape it
 * names is catalogued and covered by the docs-MCP baseline.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseBehaviorDocSections,
  readBunReleaseBehaviors,
} from "../lib/bun_release_behaviors.ts";
import { BUN_SHAPES } from "../lib/bun_shapes.ts";

const ROOT = join(import.meta.dir, "..");

async function behaviors() {
  return readBunReleaseBehaviors(ROOT);
}

describe("Bun release behavior registry", () => {
  test("every row merges a doc marker, metadata and a contract test", async () => {
    const rows = await behaviors();
    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sections = rows.map((row) => row.docSection);
    expect(new Set(sections).size).toBe(sections.length);
    for (const row of rows) {
      expect(row.docSection, row.id).toMatch(/^#{2,3} /);
      expect(row.contractTests.length, row.id).toBeGreaterThan(0);
    }
  });

  test("each doc section appears once and parses back to the same id", async () => {
    const doc = await Bun.file(
      join(ROOT, "docs/bun-upstream-reference.md"),
    ).text();
    const sections = parseBehaviorDocSections(doc);
    for (const row of await behaviors()) {
      expect(sections.get(row.id), row.id).toBe(row.docSection);
      expect(doc.split(row.docSection).length - 1, row.id).toBe(1);
    }
  });

  test("every contract test exists and carries its behavior tag", async () => {
    for (const row of await behaviors()) {
      for (const testPath of row.contractTests) {
        const file = Bun.file(join(ROOT, testPath));
        expect(await file.exists(), `${row.id}: ${testPath}`).toBe(true);
        expect(await file.text(), `${row.id}: ${testPath}`).toContain(
          `@bun-behavior: ${row.id}`,
        );
      }
    }
  });

  test("every named shape is catalogued and covered by the docs baseline", async () => {
    const catalogue = new Set(BUN_SHAPES.map((shape) => shape.name));
    const baseline = (await Bun.file(
      join(ROOT, "tests/bun_docs_surface_baseline.json"),
    ).json()) as { shapes: Record<string, { documented: boolean }> };

    for (const row of await behaviors()) {
      for (const shape of row.shapes) {
        expect(catalogue.has(shape), `${row.id}: ${shape}`).toBe(true);
        expect(
          baseline.shapes[shape] !== undefined,
          `${row.id}: ${shape} missing from the docs baseline`,
        ).toBe(true);
      }
    }
  });
});
