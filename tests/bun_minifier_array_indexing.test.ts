/**
 * @file tests/bun_minifier_array_indexing.test.ts
 * @description Pins the documented `--minify-syntax` array-indexing fold on Bun 1.4.4
 * (bun.com/docs/bundler/minifier#array-indexing): `[x][0]` → `x`, a constant array index → the
 * element literal, and an elision → `void 0`. The hole case is the one that silently changes
 * meaning if a future minifier starts treating elisions as empty strings or nulls.
 *
 * Also pins the boundary: out-of-range, negative, fractional and NaN indices are left as runtime
 * lookups. Folding those would be a semantic change, not an optimisation.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function buildSyntax(source: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bun-min-array-"));
  dirs.push(dir);
  const entry = join(dir, "in.ts");
  await Bun.write(entry, source);
  const outdir = join(dir, "out");
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    minify: { syntax: true },
  });
  expect(result.success).toBe(true);
  return Bun.file(join(outdir, "in.js")).text();
}

test("constant array access folds to the element, an elision folds to void 0", async () => {
  const output = await buildSyntax(
    [
      "declare const x: string;",
      "export const a = [x][0];",
      "export const b = ['a', 'b', 'c'][1];",
      "export const c = ['a', , 'c'][1];",
    ].join("\n"),
  );
  expect(output).toMatch(/var a\s*=\s*x/);
  expect(output).toMatch(/b\s*=\s*"b"/);
  expect(output).toMatch(/c\s*=\s*void 0;/);
});

test("nested and first-slot folds happen; non-integer indices stay runtime lookups", async () => {
  const output = await buildSyntax(
    [
      "export const d = ['a', 'b'][5];",
      "export const e = ['a', 'b'][-1];",
      "export const f = [1, 2][1.5];",
      "export const g = ['a', , 'c'][2];",
      "export const h = [[1, 2], [3, 4]][1][0];",
      "export const j = [, 'a'][0];",
      "export const k = ['a',][1];",
      "export const l = ['a', 'b'][NaN];",
    ].join("\n"),
  );
  expect(output).toMatch(/g\s*=\s*"c"/);
  expect(output).toMatch(/h\s*=\s*3/);
  expect(output).toMatch(/j\s*=\s*void 0/);
  expect(output).toMatch(/d\s*=\s*\["a", "b"\]\[5\]/);
  expect(output).toMatch(/e\s*=\s*\["a", "b"\]\[-1\]/);
  expect(output).toMatch(/f\s*=\s*\[1, 2\]\[1\.5\]/);
  expect(output).toMatch(/l\s*=\s*\["a", "b"\]\[NaN\]/);
});
