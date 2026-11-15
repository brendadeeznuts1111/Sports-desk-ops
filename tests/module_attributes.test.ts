import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * Enforcement for `unicorn/require-module-attributes`.
 *
 * The rule (https://bun.com/docs/lint/rules/unicorn/require-module-attributes)
 * rejects an **empty** attribute list: `with {}` on a static import/export,
 * `import("./x.json", {})`, or `{ with: {} }`. It is off by default upstream and
 * only exists in Bun's native linter.
 *
 * Measured on Bun 1.4.4: there is no native `bun lint` command — in a clean
 * project it reports `Script not found "lint"`, and in this repository the
 * `lint` script shadows it (`--no-script` does not bypass it here). oxlint does
 * not implement the rule (`oxlint --rules` has no match). So the `bunfig.toml`
 * entry is inert until the native linter lands; this test enforces the same
 * intent in CI. Delete the test when `bun lint` becomes reachable.
 */

const SKIP_PREFIXES = [
  ".agents/",
  ".worktrees/",
  "dist/",
  "node_modules/",
  "scratch/",
  "Scratch/",
  "tests/fixtures/",
  "verification/",
];
const SELF = "tests/module_attributes.test.ts";

/** `import x from "./y.json" with {};` — attribute shell with nothing inside. */
const EMPTY_STATIC = /\bwith\s*\{\s*\}\s*;?/;
/** `import("./y.json", {})` — empty options object as the second argument. */
const EMPTY_DYNAMIC_ARG = /\bimport\s*\(\s*[^)\n]*,\s*\{\s*\}\s*\)/;
/** `import("./y.json", { with: {} })` — options object with an empty attribute map. */
const EMPTY_WITH_OPTION = /\bwith\s*:\s*\{\s*\}/;

const DETECTORS = [EMPTY_STATIC, EMPTY_DYNAMIC_ARG, EMPTY_WITH_OPTION];

function hitsIn(text: string): string[] {
  return DETECTORS.filter((pattern) => pattern.test(text)).map(
    (pattern) => pattern.source,
  );
}

async function trackedSources(): Promise<string[]> {
  const listed = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(listed.exitCode).toBe(0);
  return listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file !== "" && file !== SELF)
    .filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

describe("module attributes", () => {
  test("detectors catch empty attribute lists and leave valid ones alone", () => {
    // Assembled at runtime so this file does not match its own scan.
    const emptyStatic = `import x from "./y.json" ${"with"} ${"{}"};`;
    const emptyDynamic = `const m = await ${"import"}("./y.json", ${"{}"});`;
    const emptyWith = `const m = await ${"import"}("./y.json", { ${"with"}: ${"{}"} });`;
    for (const sample of [emptyStatic, emptyDynamic, emptyWith]) {
      expect(hitsIn(sample).length).toBeGreaterThan(0);
    }

    const valid = [
      `import x from "./y.json" with { type: "json" };`,
      `const m = await import("./y.js");`,
      `const m = await import("./y.json", { with: { type: "json" } });`,
    ];
    for (const sample of valid) expect(hitsIn(sample)).toEqual([]);
  });

  test("no tracked source carries an empty module-attribute list", async () => {
    const files = await trackedSources();
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await Bun.file(resolve(process.cwd(), file)).text();
      const hits = hitsIn(text);
      if (hits.length > 0) offenders.push(`${file} :: ${hits.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });
});
