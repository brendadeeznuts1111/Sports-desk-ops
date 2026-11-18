/**
 * @file tests/bun_x_catalog_docs.test.ts
 * @description `cli/README.md`'s `bun x` catalog is generated, not hand-maintained.
 *
 * `lib/cli_catalog.ts` derives the rows from root `package.json` `bin`/`scripts` plus each
 * target's header comment; `scripts/render_cli_readme.ts` writes the marker-delimited block.
 * These cases fail when the committed text is stale, when a row loses its target, or when the
 * description derivation stops producing anything useful.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  readCliCatalog,
  renderCliReadmeCatalog,
  requiredCliBins,
} from "../lib/cli_catalog.ts";

const ROOT = join(import.meta.dir, "..");

// @bun-behavior: bun-x-catalog

describe("bun x catalog documentation", () => {
  test("cli/README.md catalog matches the generator output", async () => {
    const current = await Bun.file(join(ROOT, "cli/README.md")).text();
    expect(await renderCliReadmeCatalog(ROOT, current)).toBe(current);
  });

  test("generated rows cover every declared bin exactly once", async () => {
    const rows = await readCliCatalog(ROOT);
    const bins = await requiredCliBins(ROOT);
    expect(bins.length).toBeGreaterThan(20);
    expect(rows.map((row) => row.bin)).toEqual([...bins]);
    expect(new Set(rows.map((row) => row.bin)).size).toBe(rows.length);
  });

  test("every row keeps an existing target with a shebang", async () => {
    for (const row of await readCliCatalog(ROOT)) {
      const file = Bun.file(join(ROOT, row.target));
      expect(await file.exists(), `${row.bin} (${row.target})`).toBe(true);
      const head = (await file.text()).split("\n")[0] ?? "";
      expect(head.startsWith("#!/usr/bin/env "), row.bin).toBe(true);
    }
  });

  test("descriptions are derived from target headers", async () => {
    const rows = await readCliCatalog(ROOT);
    const withDescription = rows.filter((row) => row.description !== null);
    expect(withDescription.length).toBeGreaterThan(rows.length / 2);
    expect(rows.find((row) => row.bin === "sportsdesk")?.description).toContain(
      "SportsDesk",
    );
  });
});
