import { describe, expect, test } from "bun:test";
import {
  BUN_SHAPES,
  BUN_SUBMODULE_SHAPES,
  RUNTIME_ONLY_SHAPES,
  SHAPE_SECTIONS,
  SHAPE_SUBSYSTEMS,
  analyzeBunShapes,
  catalogHeadings,
  collectBunShapeUsage,
  type BunShape,
  type ShapeWorld,
} from "../lib/bun_shapes.ts";

const shape = (name: string, over: Partial<BunShape> = {}): BunShape => ({
  name,
  kind: "value",
  subsystem: "process",
  heading: `Bun.${name}`,
  evidence: ["probe:test.probe"],
  ...over,
});

function sectionMap(shapes: readonly BunShape[]): Map<string, Set<string>> {
  const sections = new Map<string, Set<string>>();
  for (const s of shapes) {
    const title = SHAPE_SECTIONS[s.subsystem];
    const set = sections.get(title) ?? new Set<string>();
    set.add(s.heading);
    sections.set(title, set);
  }
  return sections;
}

function world(over: Partial<ShapeWorld> = {}): ShapeWorld {
  const shapes: readonly BunShape[] = over.shapes ?? [shape("file")];
  return {
    usage: {
      used: new Map([["file", new Set(["lib/x.ts"])]]),
      elementAccess: [],
    },
    shapes,
    headings: shapes.map((s) => s.heading),
    sections: sectionMap(shapes),
    members: new Map(),
    memberBaseline: new Map(),
    probes: new Set(["test.probe"]),
    tests: new Set(["tests/bun_capabilities.test.ts"]),
    surfaces: new Set(["file"]),
    runtimeTypeof: new Map(
      shapes.map((s) => [
        s.name,
        s.kind === "value" ? "function" : "undefined",
      ]),
    ),
    declaredValues: new Set(
      shapes.filter((s) => s.kind === "value").map((s) => s.name),
    ),
    typesSource: "interface FileSink {}\n",
    runtimeOnly: new Map(),
    ...over,
  };
}

const rules = (problems: ReturnType<typeof analyzeBunShapes>) =>
  problems.map((p) => p.rule);

describe("manifest", () => {
  test("partition is 90 shapes across the eight subsystems", () => {
    expect(BUN_SHAPES.length).toBe(90);
    const counts = Object.fromEntries(SHAPE_SUBSYSTEMS.map((s) => [s, 0]));
    for (const s of BUN_SHAPES)
      counts[s.subsystem] = (counts[s.subsystem] ?? 0) + 1;
    expect(counts).toEqual({
      process: 20,
      text: 9,
      data: 14,
      storage: 15,
      crypto: 15,
      network: 10,
      image: 2,
      meta: 5,
    });
  });

  test("75 runtime values and 15 type-only declarations", () => {
    expect(BUN_SHAPES.filter((s) => s.kind === "value").length).toBe(75);
    expect(
      BUN_SHAPES.filter((s) => s.kind === "type")
        .map((s) => s.name)
        .sort(),
    ).toEqual([
      "CronController",
      "Env",
      "FetchProxyOption",
      "FetchSessionInit",
      "FileSink",
      "Import",
      "ImportKind",
      "Password",
      "S3File",
      "S3FilePresignOptions",
      "S3ListObjectsOptions",
      "S3ListObjectsResponse",
      "S3Options",
      "S3Stats",
      "Server",
    ]);
  });

  test("names and headings are unique", () => {
    expect(new Set(BUN_SHAPES.map((s) => s.name)).size).toBe(BUN_SHAPES.length);
    expect(new Set(BUN_SHAPES.map((s) => s.heading)).size).toBe(
      BUN_SHAPES.length,
    );
  });

  test("every entry carries evidence and names its subsystem heading", () => {
    for (const s of BUN_SHAPES) {
      expect(s.evidence.length).toBeGreaterThan(0);
      expect(s.heading).toBe(
        s.kind === "value"
          ? `Bun.${s.name}`
          : s.status === "declared-only"
            ? `Bun.${s.name} (type, declared-only)`
            : `Bun.${s.name} (type)`,
      );
    }
  });

  test("RUNTIME_ONLY_SHAPES is empty on bun-types@1.4.4 and BUN_SUBMODULE_SHAPES are unique", () => {
    expect([...RUNTIME_ONLY_SHAPES.keys()]).toEqual([]);
    const subKeys = BUN_SUBMODULE_SHAPES.map((s) => `${s.module}/${s.name}`);
    expect(new Set(subKeys).size).toBe(BUN_SUBMODULE_SHAPES.length);
    expect(subKeys.sort()).toEqual([
      "bun:bundle/feature",
      "bun:jsc/estimateShallowMemoryUsageOf",
      "bun:jsc/heapStats",
      "bun:sqlite/Database",
      "bun:sqlite/constants",
    ]);
  });
});

describe("catalogHeadings", () => {
  test("reads only #### lines, in order", () => {
    const md =
      "# Title\n## Section\n#### Bun.file\n#### Bun.FileSink (type)\n### Bun.not\n";
    expect(catalogHeadings(md)).toEqual(["Bun.file", "Bun.FileSink (type)"]);
  });
});

describe("collectBunShapeUsage", () => {
  test("ignores comments and strings, reads value and type positions", () => {
    const sources = new Map([
      [
        "lib/x.ts",
        [
          "// Bun.mmap is prose, not a call",
          'const note = "Bun.Password is not a runtime alias";',
          'const a = Bun.file("x");',
          "const b: Bun.FileSink = null as never;",
          "type C = typeof Bun.which;",
        ].join("\n"),
      ],
    ]);
    const usage = collectBunShapeUsage(sources);
    expect([...usage.used.keys()].sort()).toEqual([
      "FileSink",
      "file",
      "which",
    ]);
    expect(usage.used.get("file")).toEqual(new Set(["lib/x.ts"]));
    expect(usage.elementAccess).toEqual([]);
  });

  test("reports bracket access instead of silently missing it", () => {
    const usage = collectBunShapeUsage(
      new Map([["lib/x.ts", 'const x = Bun["file"];']]),
    );
    expect(usage.elementAccess).toHaveLength(1);
    expect(usage.used.size).toBe(0);
  });

  test("tracks named and namespace imports from module 'bun' alongside Bun.*", () => {
    const sources = new Map([
      [
        "lib/auth_and_db.ts",
        [
          'import { password, sql as defaultSql, type Password, type S3FilePresignOptions } from "bun";',
          'import * as bunNs from "bun";',
          "export const h = password.hash;",
          "export const v = bunNs.version;",
          "export type Alg = Password.Argon2Algorithm;",
          "export type Presign = S3FilePresignOptions;",
        ].join("\n"),
      ],
      [
        "lib/dyn.ts",
        [
          'import * as bunNs from "bun";',
          'export const bad = bunNs["sql"];',
        ].join("\n"),
      ],
    ]);
    const usage = collectBunShapeUsage(sources);
    expect([...usage.used.keys()].sort()).toEqual([
      "Password",
      "S3FilePresignOptions",
      "password",
      "sql",
      "version",
    ]);
    expect(usage.elementAccess).toEqual(['lib/dyn.ts: bunNs["sql"]']);
  });

  test("tracks globalThis.Bun, destructuring, re-exports, import('bun').T, TSX, and bun:* submodules", () => {
    const sources = new Map([
      [
        "src/dashboard/view.tsx",
        [
          'import { feature } from "bun:bundle";',
          'import * as sqliteNs from "bun:sqlite";',
          'export { YAML, type Env as BunEnv } from "bun";',
          "const { env, revision: rev } = Bun;",
          "const ver = globalThis.Bun.version;",
          'type SqlPool = import("bun").SQL;',
          'type JscStats = ReturnType<typeof import("bun:jsc").heapStats>;',
          "type GlobalSrv = globalThis.Bun.Server<unknown>;",
          "export const View = () => <div>{feature('PROD') ? rev : String(Boolean(sqliteNs.Database))}</div>;",
          "export type Keep = [SqlPool, JscStats, GlobalSrv, typeof env, typeof ver];",
        ].join("\n"),
      ],
      [
        "lib/rest_bad.ts",
        "const { ...all } = globalThis.Bun;\nexport { all };",
      ],
    ]);
    const usage = collectBunShapeUsage(sources);
    expect([...usage.used.keys()].sort()).toEqual([
      "Env",
      "SQL",
      "Server",
      "YAML",
      "env",
      "revision",
      "version",
    ]);
    expect([...(usage.submodules?.keys() ?? [])].sort()).toEqual([
      "bun:bundle/feature",
      "bun:jsc/heapStats",
      "bun:sqlite/Database",
    ]);
    expect(usage.elementAccess).toEqual([
      "lib/rest_bad.ts: { ...all } = globalThis.Bun",
    ]);
  });
});

describe("analyzeBunShapes", () => {
  test("clean world has no problems", () => {
    expect(analyzeBunShapes(world())).toEqual([]);
  });

  test("unknown shape names the files that use it", () => {
    const problems = analyzeBunShapes(
      world({
        usage: {
          used: new Map([
            ["file", new Set(["a.ts"])],
            ["mmap", new Set(["b.ts"])],
          ]),
          elementAccess: [],
        },
      }),
    );
    expect(problems).toEqual([
      { rule: "unknown-shape", detail: "mmap (b.ts)" },
    ]);
  });

  test("an entry nothing uses is stale", () => {
    const problems = analyzeBunShapes(
      world({
        shapes: [shape("file"), shape("mmap")],
        usage: {
          used: new Map([["file", new Set(["a.ts"])]]),
          elementAccess: [],
        },
      }),
    );
    expect(rules(problems)).toContain("unused-shape");
  });

  test("missing and duplicated headings are reported", () => {
    const missing = analyzeBunShapes(world({ headings: [] }));
    expect(rules(missing)).toContain("heading-missing");
    const duplicated = analyzeBunShapes(
      world({ headings: ["Bun.file", "Bun.file"] }),
    );
    expect(rules(duplicated)).toContain("heading-duplicate");
  });

  test("kind must match the binary", () => {
    const problems = analyzeBunShapes(
      world({ runtimeTypeof: new Map([["file", "undefined"]]) }),
    );
    expect(problems).toEqual([
      { rule: "kind-mismatch", detail: "file: kind=value typeof=undefined" },
    ]);
  });

  test("evidence refs must resolve locally", () => {
    const problems = analyzeBunShapes(
      world({ shapes: [shape("file", { evidence: ["probe:nope"] })] }),
    );
    expect(problems).toEqual([
      { rule: "evidence-unresolved", detail: "probe:nope" },
    ]);
  });

  test("a type-only shape needs a test reference", () => {
    const sink = shape("FileSink", {
      kind: "type",
      heading: "Bun.FileSink (type)",
      evidence: ["probe:test.probe"],
      subsystem: "process",
    });
    const problems = analyzeBunShapes(
      world({
        shapes: [sink],
        usage: {
          used: new Map([["FileSink", new Set(["a.ts"])]]),
          elementAccess: [],
        },
        runtimeTypeof: new Map([["FileSink", "undefined"]]),
        declaredValues: new Set(),
      }),
    );
    expect(rules(problems)).toContain("no-evidence");
  });

  test("a value absent from bun-types needs a runtime-only anchor", () => {
    const problems = analyzeBunShapes(world({ declaredValues: new Set() }));
    expect(problems).toEqual([{ rule: "undeclared-shape", detail: "file" }]);
    const anchored = analyzeBunShapes(
      world({
        declaredValues: new Set(),
        runtimeOnly: new Map([["file", "src/x.rs#1"]]),
      }),
    );
    expect(anchored).toEqual([]);
    const emptyAnchor = analyzeBunShapes(
      world({
        declaredValues: new Set(),
        runtimeOnly: new Map([["file", "  "]]),
      }),
    );
    expect(rules(emptyAnchor)).toContain("runtime-only-without-source");
    const staleAnchor = analyzeBunShapes(
      world({
        declaredValues: new Set(["file"]),
        runtimeOnly: new Map([["file", "no longer undeclared"]]),
      }),
    );
    expect(staleAnchor).toEqual([
      {
        rule: "stale-runtime-only",
        detail: "file is now declared in bun-types",
      },
    ]);
  });

  test("validates bun:* submodule inventory against usage and evidence", () => {
    const unknownSub = analyzeBunShapes(
      world({
        usage: {
          used: new Map([["file", new Set(["lib/x.ts"])]]),
          submodules: new Map([["bun:ffi/dlopen", new Set(["lib/ffi.ts"])]]),
          elementAccess: [],
        },
        submoduleShapes: [],
      }),
    );
    expect(unknownSub).toEqual([
      {
        rule: "unknown-submodule-symbol",
        detail: "bun:ffi/dlopen (lib/ffi.ts)",
      },
    ]);

    const unusedAndBadEvidence = analyzeBunShapes(
      world({
        usage: {
          used: new Map([["file", new Set(["lib/x.ts"])]]),
          submodules: new Map(),
          elementAccess: [],
        },
        submoduleShapes: [
          {
            module: "bun:jsc",
            name: "heapStats",
            kind: "value",
            evidence: ["surface:missing.check"],
          },
        ],
      }),
    );
    expect(unusedAndBadEvidence).toEqual([
      { rule: "unused-submodule-symbol", detail: "bun:jsc/heapStats" },
      {
        rule: "submodule-evidence-unresolved",
        detail: "bun:jsc/heapStats -> surface:missing.check",
      },
    ]);
  });

  test("type shapes must exist in the declaration source", () => {
    const sink = shape("FileSink", {
      kind: "type",
      heading: "Bun.FileSink (type)",
      evidence: ["test:tests/bun_capabilities.test.ts"],
    });
    const problems = analyzeBunShapes(
      world({
        shapes: [sink],
        usage: {
          used: new Map([["FileSink", new Set(["a.ts"])]]),
          elementAccess: [],
        },
        runtimeTypeof: new Map([["FileSink", "undefined"]]),
        declaredValues: new Set(),
        typesSource: "export const x = 1;\n",
      }),
    );
    expect(problems).toEqual([
      { rule: "undeclared-shape", detail: "FileSink (type)" },
    ]);
  });

  test("a changed member surface is reported with the delta", () => {
    const problems = analyzeBunShapes(
      world({
        members: new Map([["file", ["a", "b"]]]),
        memberBaseline: new Map([["file", ["a"]]]),
      }),
    );
    expect(problems).toEqual([
      { rule: "member-drift", detail: "file: added [b] removed []" },
    ]);
  });

  test("a member surface with no baseline entry is reported", () => {
    const problems = analyzeBunShapes(
      world({ members: new Map([["file", ["a"]]]) }),
    );
    expect(problems).toEqual([{ rule: "member-unbaselined", detail: "file" }]);
  });

  test("a heading under the wrong section is reported", () => {
    const sections = new Map([
      ["Text and terminal rendering", new Set(["Bun.file"])],
    ]);
    const problems = analyzeBunShapes(world({ sections }));
    expect(problems).toEqual([
      {
        rule: "section-mismatch",
        detail: 'Bun.file is not under "## Process, filesystem and shell"',
      },
    ]);
  });

  test("a declared-only entry that is called must be promoted", () => {
    const entry = shape("ImportKind", {
      kind: "type",
      heading: "Bun.ImportKind (type, declared-only)",
      evidence: ["test:tests/bun_capabilities.test.ts"],
      status: "declared-only",
      subsystem: "data",
    });
    const problems = analyzeBunShapes(
      world({
        shapes: [entry],
        usage: {
          used: new Map([["ImportKind", new Set(["a.ts"])]]),
          elementAccess: [],
        },
        runtimeTypeof: new Map([["ImportKind", "undefined"]]),
        declaredValues: new Set(),
        typesSource: "type ImportKind = string;\n",
      }),
    );
    expect(problems).toEqual([
      { rule: "declared-only-in-use", detail: "ImportKind" },
    ]);
  });

  test("a declared-only entry nothing calls is accepted", () => {
    const entry = shape("ImportKind", {
      kind: "type",
      heading: "Bun.ImportKind (type, declared-only)",
      evidence: ["test:tests/bun_capabilities.test.ts"],
      status: "declared-only",
      subsystem: "data",
    });
    const problems = analyzeBunShapes(
      world({
        shapes: [entry],
        usage: { used: new Map(), elementAccess: [] },
        runtimeTypeof: new Map([["ImportKind", "undefined"]]),
        declaredValues: new Set(),
        typesSource: "type ImportKind = string;\n",
      }),
    );
    expect(problems).toEqual([]);
  });

  test("bracket access fails rather than disappearing", () => {
    const problems = analyzeBunShapes(
      world({
        usage: {
          used: new Map([["file", new Set(["a.ts"])]]),
          elementAccess: ['a.ts: Bun["file"]'],
        },
      }),
    );
    expect(problems).toEqual([
      { rule: "element-access", detail: 'a.ts: Bun["file"]' },
    ]);
  });
});
