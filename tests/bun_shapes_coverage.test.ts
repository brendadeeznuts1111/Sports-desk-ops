import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
  ABSENT_DOM_GLOBALS,
  BUN_SHAPES,
  BUN_SUBMODULE_SHAPES,
  BUN_WEB_GLOBAL_SHAPES,
  PROTOTYPE_SNAPSHOT_EXCLUDED,
  VOLATILE_SHAPES,
  analyzeBunShapes,
  catalogHeadings,
  collectBunShapeUsage,
  listBunShapeScannedFiles,
  surfaceMembers,
  surfacePrototypeMembers,
  webGlobalSurfaceMembers,
} from "../lib/bun_shapes.ts";
import { declarationDrift } from "../bin/bun_types.ts";
import {
  SHAPE_CATALOG_PATH,
  renderBunShapeContractsCatalog,
} from "../scripts/bun_shape_contracts.ts";
import { formattedCatalogSource } from "../scripts/bun_shapes_catalog.ts";

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
    // The shape table is derived too: a new `Bun.*` call or a bun-types bump
    // must show up as a regenerated file, not as a hand-typed row.
    const derivedShapes = await formattedCatalogSource(root);
    expect(
      await Bun.file(join(root, "lib/bun_shapes.generated.ts")).text(),
    ).toBe(derivedShapes);
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
    ).json()) as {
      shapes: Record<string, string[]>;
      webGlobals?: Record<string, string[]>;
    };
    const memberBaseline = new Map(Object.entries(memberFile.shapes));

    const g = globalThis as Record<string, unknown>;
    const webGlobalRuntimeTypeof = new Map<string, string>();
    const webGlobalMembers = new Map<string, readonly string[]>();
    for (const web of BUN_WEB_GLOBAL_SHAPES) {
      const value = g[web.name];
      webGlobalRuntimeTypeof.set(web.name, typeof value);
      const list = webGlobalSurfaceMembers(value);
      if (list.length > 0) webGlobalMembers.set(web.name, list);
    }
    const webGlobalMemberBaseline = new Map(
      Object.entries(memberFile.webGlobals ?? {}),
    );
    const absentDomRuntimeTypeof = new Map<string, string>(
      ABSENT_DOM_GLOBALS.map((dom) => [dom, typeof g[dom]]),
    );

    const problems = analyzeBunShapes({
      usage,
      shapes: BUN_SHAPES,
      submoduleShapes: BUN_SUBMODULE_SHAPES,
      webGlobalShapes: BUN_WEB_GLOBAL_SHAPES,
      webGlobalRuntimeTypeof,
      webGlobalMembers,
      webGlobalMemberBaseline,
      absentDomRuntimeTypeof,
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

  test("Bun.* prototype members match the snapshot", async () => {
    const snapshot = (await Bun.file(
      join(root, "tests/bun_shape_members.json"),
    ).json()) as { prototypes?: Record<string, string[]> };
    const expected = snapshot.prototypes ?? {};
    const actual: Record<string, string[]> = {};
    for (const shape of BUN_SHAPES) {
      if (shape.kind !== "value" || VOLATILE_SHAPES.has(shape.name)) continue;
      if (PROTOTYPE_SNAPSHOT_EXCLUDED.has(shape.name)) continue;
      const value = (Bun as unknown as Record<string, unknown>)[shape.name];
      const members = surfacePrototypeMembers(value);
      if (members.length > 0) actual[shape.name] = members;
    }
    const drift: string[] = [];
    const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const name of [...names].sort()) {
      const before = expected[name];
      const now = actual[name];
      if (before === undefined) drift.push(`NEW ${name}`);
      else if (now === undefined) drift.push(`MISSING ${name}`);
      else {
        const added = now.filter((m) => !before.includes(m));
        const removed = before.filter((m) => !now.includes(m));
        if (added.length > 0 || removed.length > 0) {
          drift.push(
            `DIFF ${name}: added [${added.join(", ")}] removed [${removed.join(", ")}]`,
          );
        }
      }
    }
    expect(drift).toEqual([]);
  });

  test("Window-adjacent Web globals satisfy desk runtime contracts on this binary", () => {
    const g = globalThis as Record<string, unknown>;
    for (const dom of ABSENT_DOM_GLOBALS) {
      expect(typeof g[dom]).toBe("undefined");
    }

    expect(URL.canParse("file:///tmp/desk.sqlite")).toBe(true);
    const parsed = URL.parse("file:///tmp/desk.sqlite");
    expect(parsed?.protocol).toBe("file:");
    expect(parsed?.pathname).toBe("/tmp/desk.sqlite");
    parsed?.searchParams.set("mode", "ro");
    expect(Bun.file(parsed!).name).toBe("/tmp/desk.sqlite");
    expect(Bun.file("s3://bucket/key").name).toBe("bucket/key");
    expect(() => Bun.file(new URL("s3://bucket/key"))).toThrow(
      /ERR_INVALID_URL_SCHEME|file:/,
    );

    const encoded = new TextEncoder().encode("desk");
    expect(new TextDecoder().decode(encoded)).toBe("desk");
    expect(atob(btoa("f402"))).toBe("f402");
    expect(structuredClone({ a: [1, 2] })).toEqual({ a: [1, 2] });
    expect(AbortSignal.timeout(50)).toBeInstanceOf(AbortSignal);

    const target = new EventTarget();
    let seen = "";
    target.addEventListener("ping", (ev) => {
      seen = (ev as CustomEvent<string>).detail;
    });
    target.dispatchEvent(new CustomEvent("ping", { detail: "ok" }));
    expect(seen).toBe("ok");

    const realm = new ShadowRealm();
    expect(realm.evaluate("2 + 2")).toBe(4);
  });
});
