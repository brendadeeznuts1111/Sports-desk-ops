import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `export * as ns` used to keep every export of the group. Bun 1.4.1 compiles a member access
 * to a direct reference and tree-shakes the rest; this pins the behavior and the namespace
 * setter switch (`deprecatedNamespaceObjectSetters: false` makes assignment throw).
 */

const LIB = `
export function used() { return "USED_MARKER"; }
export function unused() { return "UNUSED_MARKER"; }
export const alpha = "UNUSED_ALPHA";
export const beta = "UNUSED_BETA";
`;

const ENTRY = `
import { group } from "./ns.ts";
console.log(group.used());
`;

const ASSIGN = `
import { group } from "./ns.ts";
try {
  (group as any).used = () => "HACKED";
  console.log("ASSIGNED");
} catch {
  console.log("THREW");
}
console.log(group.used());
`;

async function withProject(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bun-namespace-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await Bun.write(join(dir, name), contents);
    }
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function buildAndRun(
  dir: string,
  outdir: string,
  deprecatedNamespaceObjectSetters: boolean,
): Promise<string> {
  const build = await Bun.build({
    entrypoints: [join(dir, "assign.ts")],
    target: "bun",
    minify: true,
    outdir: join(dir, outdir),
    deprecatedNamespaceObjectSetters,
  });
  expect(build.success).toBe(true);
  const output = build.outputs[0];
  if (output === undefined) throw new Error("build produced no output");
  const run = Bun.spawnSync([process.execPath, output.path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return run.stdout.toString();
}

describe("Bun.build export * as", () => {
  test("tree-shakes unused namespace exports", async () => {
    await withProject(
      {
        "lib.ts": LIB,
        "ns.ts": 'export * as group from "./lib.ts";',
        "entry.ts": ENTRY,
      },
      async (dir) => {
        const build = await Bun.build({
          entrypoints: [join(dir, "entry.ts")],
          target: "bun",
          minify: true,
        });
        expect(build.success).toBe(true);
        const text = await build.outputs[0]!.text();
        expect(text).toContain("USED_MARKER");
        expect(text).not.toContain("UNUSED_MARKER");
        expect(text).not.toContain("UNUSED_ALPHA");
        expect(text.length).toBeLessThan(500);
      },
    );
  });

  test("namespace setters are deprecated and can be disabled", async () => {
    await withProject(
      {
        "lib.ts": LIB,
        "ns.ts": 'export * as group from "./lib.ts";',
        "assign.ts": ASSIGN,
      },
      async (dir) => {
        expect(await buildAndRun(dir, "default", true)).toContain("ASSIGNED");
        const getterOnly = await buildAndRun(dir, "getter-only", false);
        expect(getterOnly).toContain("THREW");
        expect(getterOnly).toContain("USED_MARKER");
      },
    );
  });
});
