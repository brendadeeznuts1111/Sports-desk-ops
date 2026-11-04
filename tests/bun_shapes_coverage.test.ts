import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
  BUN_SHAPES,
  VOLATILE_SHAPES,
  analyzeBunShapes,
  catalogHeadings,
  collectBunShapeUsage,
  surfaceMembers,
} from "../lib/bun_shapes.ts";
import { declarationDrift } from "../bin/bun_types.ts";
import { listSourceFiles } from "../lib/source_files.ts";

const root = resolve(import.meta.dir, "..");
const CATALOG = "docs/runbooks/bun_shape_contracts_runbook.md";

/** `## Section` → `#### Shape` headings listed under it. */
function catalogSections(markdown: string): Map<string, Set<string>> {
  const sections = new Map<string, Set<string>>();
  let current: string | undefined;
  for (const line of markdown.split("\n")) {
    const section = /^##\s+(.+?)\s*$/.exec(line);
    const shape = /^####\s+(.+?)\s*$/.exec(line);
    if (section) {
      current = section[1] as string;
      sections.set(current, new Set());
    } else if (shape && current !== undefined) {
      sections.get(current)?.add(shape[1] as string);
    }
  }
  return sections;
}

/** Same scope the inventory was taken from: source, not tests, not the pinned vendor tree. */
const isScanned = (file: string): boolean =>
  !file.includes(".test.") &&
  !file.startsWith("tests/") &&
  !file.startsWith("verification/");

async function bunTypesDir(): Promise<string> {
  const types = Bun.resolveSync("@types/bun/package.json", root);
  return dirname(Bun.resolveSync("bun-types/package.json", dirname(types)));
}

async function bunTypesSource(): Promise<string> {
  const dir = await bunTypesDir();
  const dts = Array.fromAsync(
    new Bun.Glob("*.d.ts").scan({ cwd: dir, onlyFiles: true }),
  );
  const parts: string[] = [];
  for (const file of await dts) {
    parts.push(await Bun.file(join(dir, file)).text());
  }
  return parts.join("\n");
}

describe("Bun shape coverage", () => {
  test("every used shape is documented, evidenced and declared", async () => {
    const files = (await listSourceFiles(root, ["ts", "mjs", "js"])).filter(
      isScanned,
    );
    const sources = new Map<string, string>();
    for (const file of files) sources.set(file, await Bun.file(file).text());
    const usage = collectBunShapeUsage(sources);

    const catalog = await Bun.file(join(root, CATALOG)).text();
    const headings = catalogHeadings(catalog);

    const baseline = (await Bun.file(
      join(root, "tests/bun_baseline.json"),
    ).json()) as Record<string, unknown>;
    const probes = new Set(Object.keys(baseline));

    const surfaceSource = await Bun.file(
      join(root, "bin/bun_surface.ts"),
    ).text();
    const surfaces = new Set(
      [...surfaceSource.matchAll(/name:\s*"([^"]+)"/g)].map(
        (m) => m[1] as string,
      ),
    );

    const tests = new Set<string>();
    for (const shape of BUN_SHAPES) {
      for (const ref of shape.evidence) {
        if (!ref.startsWith("test:")) continue;
        const path = ref.slice("test:".length);
        if (await Bun.file(join(root, path)).exists()) tests.add(path);
      }
    }

    const runtimeTypeof = new Map<string, string>();
    for (const shape of BUN_SHAPES) {
      runtimeTypeof.set(
        shape.name,
        typeof (Bun as unknown as Record<string, unknown>)[shape.name],
      );
    }

    const drift = await declarationDrift([], root);
    expect(drift.error).toBeNull();
    const undeclared = new Set(drift.undeclared);
    const declaredValues = new Set(
      BUN_SHAPES.filter(
        (shape) =>
          shape.kind === "value" &&
          runtimeTypeof.get(shape.name) !== "undefined" &&
          !undeclared.has(shape.name),
      ).map((shape) => shape.name),
    );

    const members = new Map<string, readonly string[]>();
    for (const shape of BUN_SHAPES) {
      if (shape.kind !== "value" || VOLATILE_SHAPES.has(shape.name)) continue;
      const value = (Bun as unknown as Record<string, unknown>)[shape.name];
      if (typeof value !== "object" && typeof value !== "function") continue;
      members.set(shape.name, surfaceMembers(value));
    }
    const memberFile = (await Bun.file(
      join(root, "tests/bun_shape_members.json"),
    ).json()) as { shapes: Record<string, string[]> };
    // Volatile shapes (env, argv, stdio, Bun.s3) are not snapshotted: their members depend on
    // the caller/environment. Filtering the baseline keeps an absent map entry from reading as
    // "no member surface in the binary now".
    const memberBaseline = new Map(
      Object.entries(memberFile.shapes).filter(
        ([name]) => !VOLATILE_SHAPES.has(name),
      ),
    );

    const problems = analyzeBunShapes({
      usage,
      shapes: BUN_SHAPES,
      members,
      memberBaseline,
      headings,
      sections: catalogSections(catalog),
      probes,
      tests,
      surfaces,
      runtimeTypeof,
      declaredValues,
      typesSource: await bunTypesSource(),
    });

    expect(problems.map((p) => `${p.rule}: ${p.detail}`)).toEqual([]);
    expect(usage.used.size).toBe(
      BUN_SHAPES.filter((s) => s.status !== "declared-only").length,
    );
    expect(headings).toHaveLength(BUN_SHAPES.length);
  }, 30_000); // scans every source file plus bun-types' .d.ts set: I/O-bound, not a unit test.

  test("the manifest is written against this binary", async () => {
    const { BUN_SHAPE_PINS } = await import("../lib/bun_shapes.ts");
    expect(String(BUN_SHAPE_PINS.bunVersion)).toBe(Bun.version);
    const typesPkg = await Bun.file(
      join(await bunTypesDir(), "package.json"),
    ).json();
    expect(String(typesPkg.version)).toBe(String(BUN_SHAPE_PINS.typesVersion));
  });
});
