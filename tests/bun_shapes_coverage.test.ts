import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
  BUN_SHAPES,
  BUN_SUBMODULE_SHAPES,
  VOLATILE_SHAPES,
  analyzeBunShapes,
  catalogHeadings,
  collectBunShapeUsage,
  listBunShapeScannedFiles,
  surfaceMembers,
} from "../lib/bun_shapes.ts";
import { declarationDrift } from "../bin/bun_types.ts";
import {
  SHAPE_CATALOG_PATH,
  renderBunShapeContractsCatalog,
} from "../scripts/bun_shape_contracts.ts";

const root = resolve(import.meta.dir, "..");

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
  test("every used shape and bun:* submodule symbol is documented, evidenced, declared, and fresh", async () => {
    const files = await listBunShapeScannedFiles(root);
    const sources = new Map<string, string>();
    for (const file of files) {
      sources.set(file, await Bun.file(join(root, file)).text());
    }
    const usage = collectBunShapeUsage(sources);

    const catalog = await Bun.file(join(root, SHAPE_CATALOG_PATH)).text();
    const rendered = await renderBunShapeContractsCatalog(root);
    expect(catalog).toBe(rendered.markdown);
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
    for (const entry of [...BUN_SHAPES, ...BUN_SUBMODULE_SHAPES]) {
      for (const ref of entry.evidence) {
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
    expect(drift.moduleParity).toBe(true);
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
    const memberBaseline = new Map(Object.entries(memberFile.shapes));

    const problems = analyzeBunShapes({
      usage,
      shapes: BUN_SHAPES,
      submoduleShapes: BUN_SUBMODULE_SHAPES,
      members,
      memberBaseline,
      headings,
      sections: catalogSections(catalog),
      probes,
      tests,
      surfaces,
      runtimeTypeof,
      declaredValues,
      declaredTypes: new Set(drift.declaredTypes),
      typesSource: await bunTypesSource(),
    });

    expect(problems.map((p) => `${p.rule}: ${p.detail}`)).toEqual([]);
    expect(usage.used.size).toBe(
      BUN_SHAPES.filter((s) => s.status !== "declared-only").length,
    );
    expect(usage.submodules?.size).toBe(BUN_SUBMODULE_SHAPES.length);
    expect(headings).toHaveLength(BUN_SHAPES.length);

    // Runtime verification for value-backed bun:* submodule exports
    for (const sub of BUN_SUBMODULE_SHAPES) {
      if (sub.kind !== "value") continue;
      const mod = (await import(sub.module)) as Record<string, unknown>;
      expect(typeof mod[sub.name]).not.toBe("undefined");
    }
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
