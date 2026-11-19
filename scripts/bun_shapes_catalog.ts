/**
 * @file scripts/bun_shapes_catalog.ts
 * @description Derives `lib/bun_shapes.generated.ts` instead of keeping the
 * shape table by hand.
 *
 * The table used to be hand-maintained: 95 rows of name, kind, subsystem,
 * heading and evidence. Two of those five fields were already machine-checkable
 * (`kind-mismatch` and `heading-missing` catch typos at test time), and the row
 * *set* was already pinned to reality — the coverage test asserts the catalogue
 * and the AST usage scan are the same 95 names in both directions. What was
 * genuinely hand-typed is exactly the part a compiler cannot supply: our
 * subsystem taxonomy and each shape's evidence. That now lives in
 * `lib/bun_shapes_overlay.ts`.
 *
 * Derivation sources, in layer order:
 *   - membership: `collectBunShapeUsage` over the tracked production files, so a
 *     new `Bun.*` call changes the table without anyone editing it
 *   - kind: `declarationDrift` over `bun-types@1.4.4`
 *   - heading: `Bun.<name>`, with ` (type)` for type-only symbols
 *   - subsystem + evidence: the overlay
 *   - `status: "declared-only"`: an overlay row that the scan does not use yet
 *
 * Usage:
 *   bun scripts/bun_shapes_catalog.ts --write   # regenerate
 *   bun scripts/bun_shapes_catalog.ts --check   # fail if stale
 */

import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { declarationDrift } from "../bin/bun_types.ts";
import {
  SHAPE_SUBSYSTEMS,
  WEB_GLOBAL_CATEGORIES,
  collectBunShapeUsage,
  listBunShapeScannedFiles,
  type BunShape,
  type BunWebGlobalShape,
  type ShapeSubsystem,
  type WebGlobalCategory,
} from "../lib/bun_shapes.ts";
import {
  SHAPE_EVIDENCE_FALLBACK,
  SHAPE_SUBSYSTEMS_BY_NAME,
  WEB_GLOBAL_SPECS_BY_NAME,
} from "../lib/bun_shapes_overlay.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = "lib/bun_shapes.generated.ts";
/** Evidence refs are a proof sample, not a coverage report; keep the row readable. */
const EVIDENCE_CAP = 4;
/**
 * Bundler-transformed intrinsics: they can only appear directly inside a
 * `feature(...)` condition, so they are not runtime values. One line of hand
 * data, versus a per-row `kind` field for every submodule symbol.
 */
const MACRO_SUBMODULE_SYMBOLS: ReadonlySet<string> = new Set([
  "bun:bundle/feature",
]);

function subsystemRank(subsystem: ShapeSubsystem): number {
  const index = SHAPE_SUBSYSTEMS.indexOf(subsystem);
  if (index < 0) {
    throw new Error(`ERR_SHAPE_SUBSYSTEM_UNKNOWN: ${subsystem}`);
  }
  return index;
}

function webGlobalCategoryRank(category: WebGlobalCategory): number {
  const index = WEB_GLOBAL_CATEGORIES.indexOf(category);
  if (index < 0) {
    throw new Error(`ERR_WEB_GLOBAL_CATEGORY_UNKNOWN: ${category}`);
  }
  return index;
}

export async function renderBunShapeCatalog(
  root: string = ROOT,
): Promise<{ source: string; shapes: readonly BunShape[] }> {
  const files = await listBunShapeScannedFiles(root);
  const sources = new Map<string, string>();
  for (const file of files) {
    sources.set(file, await Bun.file(`${root}/${file}`).text());
  }
  const usage = collectBunShapeUsage(sources);

  // Evidence is discovered, not typed: `surface:<name>` when the surface probe
  // covers it, `test:<path>` for every tracked test file that names `Bun.<name>`.
  // Only the fallback map (probe-only shapes) stays hand-written.
  const surfaceSource = await Bun.file(`${root}/bin/bun_surface.ts`).text();
  const surfaceNames = new Set(
    [...surfaceSource.matchAll(/name:\s*"([^"]+)"/g)].map(
      (m) => m[1] as string,
    ),
  );
  // Tracked tests only: a scratch or vendored file is not evidence the gate can
  // resolve in CI, and a ref to one would be a broken citation.
  const tracked = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "*.test.ts", "*.test-d.ts"],
    {
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...Bun.env,
        GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  const testFiles = tracked.stdout
    .toString()
    .split("\0")
    .filter(
      (file) =>
        file.length > 0 &&
        !file.startsWith("Scratch/") &&
        !file.startsWith("node_modules/"),
    );
  const testSources = new Map<string, string>();
  for (const file of testFiles) {
    testSources.set(file, await Bun.file(`${root}/${file}`).text());
  }

  const evidenceFor = (name: string, isType: boolean): string[] => {
    // Type-only shapes are exercised through `import type { X } from "bun"`, so a
    // bare-name scan finds them where `Bun.X` never appears.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = isType
      ? new RegExp(`\\b${escaped}\\b`)
      : new RegExp(`Bun\\.${escaped}\\b`);
    const refs = [
      ...(surfaceNames.has(name) ? [`surface:${name}`] : []),
      ...[...testSources]
        .filter(([, text]) => pattern.test(text))
        .map(([file]) => `test:${file}`)
        .sort(),
      ...(SHAPE_EVIDENCE_FALLBACK[name] ?? []),
    ];
    return [...new Set(refs)].slice(0, EVIDENCE_CAP);
  };

  const drift = await declarationDrift([], root);
  if (drift.error !== null) {
    throw new Error(`ERR_SHAPE_DECLARATIONS_UNREADABLE: ${drift.error}`);
  }
  const declaredTypes = new Set(drift.declaredTypes);

  // Membership is the union of what the repo calls and what the overlay tracks
  // on purpose; an overlay row the scan does not use becomes `declared-only`.
  const names = [
    ...new Set([
      ...usage.used.keys(),
      ...Object.keys(SHAPE_SUBSYSTEMS_BY_NAME),
    ]),
  ].sort();

  const shapes: BunShape[] = names.map((name) => {
    const subsystem = SHAPE_SUBSYSTEMS_BY_NAME[name];
    if (subsystem === undefined) {
      throw new Error(
        `ERR_SHAPE_SUBSYSTEM_MISSING: ${name} is used but has no subsystem in lib/bun_shapes_overlay.ts`,
      );
    }
    const kind = declaredTypes.has(name) ? "type" : "value";
    const evidence = evidenceFor(name, kind === "type");
    if (evidence.length === 0) {
      throw new Error(
        `ERR_SHAPE_NO_EVIDENCE: ${name} has no test, surface or fallback evidence`,
      );
    }
    const used = usage.used.has(name);
    // A type we track but do not call is titled `(type, declared-only)` so the
    // runbook says out loud that the row is a declaration, not a call site.
    const heading =
      kind === "type"
        ? used
          ? `Bun.${name} (type)`
          : `Bun.${name} (type, declared-only)`
        : `Bun.${name}`;
    return {
      name,
      kind,
      subsystem,
      heading,
      ...(used ? {} : { status: "declared-only" as const }),
      evidence,
    };
  });

  const ordered = [...shapes].sort(
    (a, b) =>
      subsystemRank(a.subsystem) - subsystemRank(b.subsystem) ||
      a.name.localeCompare(b.name),
  );

  // Submodule symbols come from the same scan: `usage.submodules` is keyed
  // `module/symbol` and carries the files that import it, so the only
  // hand-written part left is which of them is a bundler macro, not a value.
  const submoduleShapes = [
    ...(usage.submodules ?? new Map<string, Set<string>>()),
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key]) => {
      const slash = key.indexOf("/");
      const module = key.slice(0, slash);
      const name = key.slice(slash + 1);
      const surfaceRef = surfaceNames.has(`${module}.${name}`)
        ? [`surface:${module}.${name}`]
        : [];
      // Test evidence has to come from the test sources, not the production scan:
      // the usage map covers shipped code only, so a symbol used solely to prove a
      // bundler macro would otherwise look unevidenced.
      const importPattern = new RegExp(
        `import\\s*\\{[^}]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^}]*\\}\\s*from\\s*["']${module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      );
      const testRefs = [...testSources]
        .filter(([, text]) => importPattern.test(text))
        .map(([file]) => `test:${file}`)
        .sort();
      const evidence = [...new Set([...surfaceRef, ...testRefs])].slice(
        0,
        EVIDENCE_CAP,
      );
      if (evidence.length === 0) {
        throw new Error(
          `ERR_SUBMODULE_NO_EVIDENCE: ${key} has no surface probe and no tracked test importing it`,
        );
      }
      return {
        module,
        name,
        kind: MACRO_SUBMODULE_SYMBOLS.has(key)
          ? ("macro" as const)
          : ("value" as const),
        evidence,
      };
    });

  const globalRecord = globalThis as Record<string, unknown>;
  const webGlobalUsage = usage.webGlobals ?? new Map<string, Set<string>>();
  const webGlobalShapes: BunWebGlobalShape[] = Object.entries(
    WEB_GLOBAL_SPECS_BY_NAME,
  )
    .map(([name, spec]): BunWebGlobalShape => {
      const actualType = typeof globalRecord[name];
      if (actualType !== "function" && actualType !== "object") {
        throw new Error(
          `ERR_WEB_GLOBAL_RUNTIME_UNEXPECTED: ${name} has typeof ${actualType}`,
        );
      }
      const used = webGlobalUsage.has(name);
      return {
        name,
        category: spec.category,
        topic: spec.topic,
        expectedTypeof: actualType,
        ...(used ? {} : { status: "declared-only" as const }),
        ...(spec.note !== undefined ? { note: spec.note } : {}),
      };
    })
    .sort(
      (a, b) =>
        webGlobalCategoryRank(a.category) - webGlobalCategoryRank(b.category) ||
        a.name.localeCompare(b.name),
    );

  const lines: string[] = [
    "/**",
    " * @file bun_shapes.generated.ts",
    " * @description AUTO-GENERATED by `bun scripts/bun_shapes_catalog.ts --write`.",
    " * DO NOT EDIT — the coverage test fails when this file is stale.",
    " *",
    " * Membership comes from the tracked-source usage scan, `kind` and `heading`",
    " * from `bun-types@1.4.4` declarations, and subsystem/evidence from",
    " * `lib/bun_shapes_overlay.ts`.",
    " */",
    "",
    'import type { BunShape, BunSubmoduleSymbol, BunWebGlobalShape } from "./bun_shapes.ts";',
    "",
    "export const BUN_SHAPES: readonly BunShape[] = [",
  ];
  for (const shape of ordered) {
    lines.push("  {");
    lines.push(`    name: ${JSON.stringify(shape.name)},`);
    lines.push(`    kind: ${JSON.stringify(shape.kind)},`);
    lines.push(`    subsystem: ${JSON.stringify(shape.subsystem)},`);
    lines.push(`    heading: ${JSON.stringify(shape.heading)},`);
    if (shape.status !== undefined) {
      lines.push(`    status: ${JSON.stringify(shape.status)},`);
    }
    lines.push(
      `    evidence: [${shape.evidence.map((e) => JSON.stringify(e)).join(", ")}],`,
    );
    lines.push("  },");
  }
  lines.push("];", "");

  lines.push(
    "/** `bun:*` symbols this repo imports, with the surface probe or test that covers each. */",
    "export const BUN_SUBMODULE_SHAPES: readonly BunSubmoduleSymbol[] = [",
  );
  for (const submodule of submoduleShapes) {
    lines.push("  {");
    lines.push(`    module: ${JSON.stringify(submodule.module)},`);
    lines.push(`    name: ${JSON.stringify(submodule.name)},`);
    lines.push(`    kind: ${JSON.stringify(submodule.kind)},`);
    lines.push(
      `    evidence: [${submodule.evidence.map((e) => JSON.stringify(e)).join(", ")}],`,
    );
    lines.push("  },");
  }
  lines.push("];", "");

  lines.push(
    "/** Window-adjacent Web API globals Bun exposes on `globalThis` (no DOM / no `window`). */",
    "export const BUN_WEB_GLOBAL_SHAPES: readonly BunWebGlobalShape[] = [",
  );
  for (const web of webGlobalShapes) {
    lines.push("  {");
    lines.push(`    name: ${JSON.stringify(web.name)},`);
    lines.push(`    category: ${JSON.stringify(web.category)},`);
    lines.push(`    topic: ${JSON.stringify(web.topic)},`);
    lines.push(`    expectedTypeof: ${JSON.stringify(web.expectedTypeof)},`);
    if (web.status !== undefined) {
      lines.push(`    status: ${JSON.stringify(web.status)},`);
    }
    if (web.note !== undefined) {
      lines.push(`    note: ${JSON.stringify(web.note)},`);
    }
    lines.push("  },");
  }
  lines.push("];", "");

  return { source: lines.join("\n"), shapes: ordered };
}

/** Formatted catalog text, for `--write`, `--check` and the coverage test. */
export async function formattedCatalogSource(
  root: string = ROOT,
): Promise<string> {
  const { source } = await renderBunShapeCatalog(root);
  return formatted(source);
}

async function formatted(source: string): Promise<string> {
  // `bun fmt` wraps long evidence arrays, so the gate compares formatted text
  // instead of reimplementing the printer's width rules.
  const tmp = `${tmpdir()}/bun-shapes-${crypto.randomUUID()}.ts`;
  await Bun.write(tmp, source);
  try {
    const proc = Bun.spawnSync(["bun", "fmt", tmp], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `ERR_SHAPE_FORMAT_FAILED: ${proc.stderr.toString().slice(0, 200)}`,
      );
    }
    return await Bun.file(tmp).text();
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const { source, shapes } = await renderBunShapeCatalog();
  const path = resolve(ROOT, OUTPUT);
  const current = (await Bun.file(path).exists())
    ? await Bun.file(path).text()
    : null;
  const expected = await formatted(source);

  if (write) {
    await Bun.write(path, expected);
    console.log(`[bun-shapes] wrote ${OUTPUT}: ${shapes.length} shapes`);
    return;
  }

  if (current === null) {
    console.error(`[bun-shapes] ${OUTPUT} is missing; run with --write`);
    process.exit(1);
  }
  if (current !== expected) {
    console.error(
      `[bun-shapes] ${OUTPUT} is out of date; run \`bun scripts/bun_shapes_catalog.ts --write\``,
    );
    process.exit(1);
  }
  console.log(`[bun-shapes] catalog fresh: ${shapes.length} shapes`);
}

if (import.meta.main) {
  await main();
}
