/**
 * @file tests/bun_test_coverage_and_snapshots.test.ts
 * @description Measured `bun test` coverage accounting, LCOV `DA:` hit counts, snapshot bail
 * safety, and `--changed` import-graph scoping on the active runtime.
 *
 * Each case builds an isolated throwaway project in `tmpdir()` and spawns `bun test`, asserting
 * exact table rows, `lcov.info` records, snapshot files, and exit codes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// @bun-behavior: bun-test-coverage-and-snapshots

interface LcovRecord {
  readonly fnf: number;
  readonly fnh: number;
  readonly lf: number;
  readonly lh: number;
  readonly da: Record<number, number>;
}

interface CoverageRow {
  readonly funcs: string;
  readonly lines: string;
  readonly uncovered: string;
}

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createSuite(files: Record<string, string>, bunfig?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-cov-snap-"));
  dirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (bunfig !== undefined) {
    writeFileSync(join(dir, "bunfig.toml"), bunfig);
  }
  return dir;
}

function runBunTest(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { exitCode: number | null; output: string } {
  const result = Bun.spawnSync([process.execPath, "test", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function runGit(dir: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
}

function parseLcovRecords(lcovText: string): Record<string, LcovRecord> {
  const records: Record<string, LcovRecord> = {};
  let currentFile: string | null = null;
  let fnf = 0;
  let fnh = 0;
  let lf = 0;
  let lh = 0;
  let da: Record<number, number> = {};

  for (const rawLine of lcovText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line === "end_of_record") {
      if (currentFile !== null) {
        records[currentFile] = { fnf, fnh, lf, lh, da };
      }
      currentFile = null;
      fnf = 0;
      fnh = 0;
      lf = 0;
      lh = 0;
      da = {};
      continue;
    }

    if (line.startsWith("SF:")) {
      currentFile = line.slice(3);
    } else if (line.startsWith("FNF:")) {
      fnf = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      fnh = Number(line.slice(4));
    } else if (line.startsWith("LF:")) {
      lf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      lh = Number(line.slice(3));
    } else if (line.startsWith("DA:")) {
      const comma = line.indexOf(",");
      if (comma !== -1) {
        const lineNum = Number(line.slice(3, comma));
        const hits = Number(line.slice(comma + 1));
        da[lineNum] = hits;
      }
    }
  }

  return records;
}

function parseCoverageRow(output: string, fileName: string): CoverageRow {
  for (const rawLine of output.split("\n")) {
    const line = Bun.stripANSI(rawLine);
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const fileCol = parts[0]?.trim() ?? "";
    if (fileCol !== fileName) continue;
    return {
      funcs: parts[1]?.trim() ?? "",
      lines: parts[2]?.trim() ?? "",
      uncovered: parts[3]?.trim() ?? "",
    };
  }
  throw new Error(`Missing coverage row for ${fileName} in output:\n${output}`);
}

const COV_BUNFIG = [
  "[test]",
  'coverageReporter = ["text", "lcov"]',
  'coverageDir = "coverage"',
  "coverageSkipTestFiles = true",
  "",
].join("\n");

describe("bun test snapshots and --changed scoping", () => {
  test("--update-snapshots --bail=1 preserves existing snapshot file on early exit", () => {
    const dir = createSuite({
      "snap.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("first", () => { expect(process.env.V1 ?? "v1").toMatchSnapshot(); });',
        'test("second", () => { if (process.env.FAIL2 === "1") expect(1).toBe(2); });',
        'test("third", () => { expect("v3").toMatchSnapshot(); });',
      ].join("\n"),
    });

    const init = runBunTest(dir, ["--update-snapshots"]);
    expect(init.exitCode).toBe(0);

    const snapPath = join(dir, "__snapshots__", "snap.test.ts.snap");
    expect(existsSync(snapPath)).toBe(true);
    const snapInitial = readFileSync(snapPath, "utf8");
    expect(snapInitial).toContain('exports[`first 1`] = `"v1"`;');
    expect(snapInitial).toContain('exports[`third 1`] = `"v3"`;');

    const bailed = runBunTest(dir, ["--update-snapshots", "--bail=1"], {
      FAIL2: "1",
      V1: "v1-updated",
    });
    expect(bailed.exitCode).not.toBe(0);
    expect(existsSync(snapPath)).toBe(true);
    const snapAfterBail = readFileSync(snapPath, "utf8");
    expect(snapAfterBail.length).toBeGreaterThan(0);
    expect(snapAfterBail).toBe(snapInitial);

    const completed = runBunTest(dir, ["--update-snapshots"], {
      V1: "v1-updated",
    });
    expect(completed.exitCode).toBe(0);
    const snapUpdated = readFileSync(snapPath, "utf8");
    expect(snapUpdated).toContain('exports[`first 1`] = `"v1-updated"`;');
    expect(snapUpdated).toContain('exports[`third 1`] = `"v3"`;');
  });

  test("--changed=HEAD scopes execution through the module import graph", () => {
    const dir = createSuite({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 2;\n",
      "a.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { a } from "./a.ts";',
        'test("a case", () => { expect(a).toBe(1); });',
      ].join("\n"),
      "b.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { b } from "./b.ts";',
        'test("b case", () => { expect(b).toBe(2); });',
      ].join("\n"),
    });

    runGit(dir, ["init", "-q", "-b", "main"]);
    runGit(dir, ["add", "."]);
    runGit(dir, ["commit", "-q", "-m", "init"]);

    // Modify only the imported dependency `a.ts` without touching `a.test.ts`.
    writeFileSync(join(dir, "a.ts"), "export const a = 1; // touched\n");

    const res = runBunTest(dir, ["--changed=HEAD"]);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("a.test.ts");
    expect(res.output).not.toContain("b.test.ts");
  });
});

describe("bun test --coverage line, branch, and source-map attribution", () => {
  test("marks skipped short-circuit, optional-chain, logical-assignment, unused default, and untaken break lines uncovered", () => {
    const dir = createSuite(
      {
        "skipped_ml.ts": [
          "export function evalSkippedMl(",
          "  a: boolean,",
          "  b: boolean,",
          "  n: number | null,",
          "  obj: { fn: (v: number) => number } | null,",
          "  defVal =",
          "    99,",
          ") {",
          "  const r1 = a ||",
          "    10;",
          "  const r2 = b &&",
          "    20;",
          "  const r3 = n ??",
          "    30;",
          "  const r4 = a",
          "    ? 40",
          "    : 50;",
          "  const r5 = obj?.fn(",
          "    55,",
          "  );",
          "  let m1: number = 1;",
          "  m1 ||=",
          "    60;",
          "  let m2: number = 0;",
          "  m2 &&=",
          "    70;",
          "  let m3: number | null = 2;",
          "  m3 ??=",
          "    80;",
          "  for (let i = 0; i < 1; i++) {",
          "    if (b) {",
          "      break;",
          "    }",
          "  }",
          "  return [r1, r2, r3, r4, r5, m1, m2, m3, defVal];",
          "}",
        ].join("\n"),
        "skipped.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { evalSkippedMl } from "./skipped_ml.ts";',
          'test("skipped branches stay uncovered", () => {',
          "  expect(evalSkippedMl(true, false, 5, null, 7)).toBeDefined();",
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    const row = parseCoverageRow(res.output, "skipped_ml.ts");
    expect(row).toEqual({
      funcs: "100.00",
      lines: "65.62",
      uncovered: "7,10,12,14,17,19-20,23,26,29,32",
    });

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const rec = lcov["skipped_ml.ts"];
    expect(rec).toBeDefined();
    for (const line of [7, 10, 12, 14, 17, 19, 20, 23, 26, 29, 32]) {
      expect(rec?.da[line]).toBe(0);
    }
    for (const line of [9, 11, 13, 15, 16, 18, 22, 25, 28, 35]) {
      expect(rec?.da[line]).toBe(1);
    }
  });

  test("marks lines after unresumed await and yield as uncovered", () => {
    const dir = createSuite(
      {
        "suspend.ts": [
          "export async function stopsAtAwaitReject(p: Promise<number>) {",
          "  const val = await p;",
          "  const after1 = val + 1;",
          "  return after1;",
          "}",
          "export async function stopsAtAwaitPending(p: Promise<number>) {",
          "  const val = await p;",
          "  const after2 = val + 2;",
          "  return after2;",
          "}",
          "export function* stopsAtYield() {",
          "  yield 1;",
          "  const afterYield = 2;",
          "  yield afterYield;",
          "}",
        ].join("\n"),
        "suspend.test.ts": [
          'import { expect, test } from "bun:test";',
          "import {",
          "  stopsAtAwaitPending,",
          "  stopsAtAwaitReject,",
          "  stopsAtYield,",
          '} from "./suspend.ts";',
          'test("unresumed suspensions stay uncovered", async () => {',
          '  await expect(stopsAtAwaitReject(Promise.reject(new Error("boom")))).rejects.toThrow("boom");',
          "  void stopsAtAwaitPending(new Promise(() => {}));",
          "  const g = stopsAtYield();",
          "  expect(g.next().value).toBe(1);",
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    const row = parseCoverageRow(res.output, "suspend.ts");
    expect(row).toEqual({
      funcs: "100.00",
      lines: "50.00",
      uncovered: "3-4,8-9,13-14",
    });

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const rec = lcov["suspend.ts"];
    expect(rec).toBeDefined();
    expect(rec?.lf).toBe(12);
    expect(rec?.lh).toBe(6);
    for (const line of [3, 4, 8, 9, 13, 14]) {
      expect(rec?.da[line]).toBe(0);
    }
  });

  test("reports exact Uncovered Line #s for uncalled functions", () => {
    const dir = createSuite(
      {
        "uncalled.ts": [
          "export function calledBefore() {",
          "  return 1;",
          "}",
          "// comment line 4",
          "export function neverRuns(x: number) {",
          "  const a = x + 1;",
          "  const b = a * 2;",
          "  return b;",
          "}",
          "export function calledAfter() {",
          "  return 2;",
          "}",
        ].join("\n"),
        "uncalled_tight.ts": [
          "export function first() {",
          "  return 1;",
          "}",
          "export function second(x: number) {",
          "  const y = x + 1;",
          "  return y * 2;",
          "}",
        ].join("\n"),
        "uncalled.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { calledAfter, calledBefore } from "./uncalled.ts";',
          'import { first } from "./uncalled_tight.ts";',
          'test("exact uncalled bounds", () => {',
          "  expect(calledBefore() + calledAfter() + first()).toBe(4);",
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    expect(parseCoverageRow(res.output, "uncalled.ts").uncovered).toBe("5-8");
    expect(parseCoverageRow(res.output, "uncalled_tight.ts").uncovered).toBe(
      "4-6",
    );

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const uRec = lcov["uncalled.ts"];
    expect(uRec?.da[4]).toBeUndefined();
    for (const line of [5, 6, 7, 8]) {
      expect(uRec?.da[line]).toBe(0);
    }
    for (const line of [1, 2, 10, 11]) {
      expect(uRec?.da[line]).toBe(1);
    }

    const tightRec = lcov["uncalled_tight.ts"];
    expect(tightRec?.da[1]).toBe(1);
    expect(tightRec?.da[2]).toBe(1);
    for (const line of [4, 5, 6]) {
      expect(tightRec?.da[line]).toBe(0);
    }
  });

  test("covers executed break inside while (true) block and import above class Derived extends Base() {}", () => {
    const dir = createSuite(
      {
        "base_factory.ts": [
          "export function Base() {",
          "  return class {",
          "    baseVal = 1;",
          "  };",
          "}",
        ].join("\n"),
        "executed.ts": [
          'import { Base } from "./base_factory.ts";',
          "export class Derived extends Base() {",
          "  runLoop() {",
          "    let count = 0;",
          "    while (true) {",
          "      {",
          "        count += 1;",
          "        break;",
          "      }",
          "    }",
          "    return count;",
          "  }",
          "}",
        ].join("\n"),
        "executed.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { Derived } from "./executed.ts";',
          'test("loop break and derived import covered", () => {',
          "  expect(new Derived().runLoop()).toBe(1);",
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    expect(parseCoverageRow(res.output, "executed.ts")).toEqual({
      funcs: "100.00",
      lines: "100.00",
      uncovered: "",
    });

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const rec = lcov["executed.ts"];
    expect(rec).toBeDefined();
    expect(rec?.da[1]).toBe(1);
    expect(rec?.da[8]).toBe(1);
    expect(rec?.lf).toBe(rec?.lh);
  });

  test("tracks standalone default: and multiline case value lines", () => {
    const dir = createSuite(
      {
        "switches_case.ts": [
          "export function pick(v: number) {",
          "  switch (v) {",
          "    case",
          "      1:",
          '      return "one";',
          "    case",
          "      2:",
          '      return "two";',
          "    default:",
          '      return "other";',
          "  }",
          "}",
        ].join("\n"),
        "switches_default.ts": [
          "export function pickHit(v: number) {",
          "  switch (v) {",
          "    case",
          "      1:",
          '      return "one";',
          "    default:",
          '      return "other";',
          "  }",
          "}",
        ].join("\n"),
        "switches.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { pick } from "./switches_case.ts";',
          'import { pickHit } from "./switches_default.ts";',
          'test("switch lines tracked", () => {',
          '  expect(pick(1)).toBe("one");',
          '  expect(pickHit(99)).toBe("other");',
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    expect(parseCoverageRow(res.output, "switches_case.ts").uncovered).toBe(
      "6-10",
    );
    expect(parseCoverageRow(res.output, "switches_default.ts").uncovered).toBe(
      "3-5",
    );

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const caseRec = lcov["switches_case.ts"];
    for (const line of [3, 4, 5]) {
      expect(caseRec?.da[line]).toBe(1);
    }
    for (const line of [6, 7, 8, 9, 10]) {
      expect(caseRec?.da[line]).toBe(0);
    }

    const defRec = lcov["switches_default.ts"];
    for (const line of [3, 4, 5]) {
      expect(defRec?.da[line]).toBe(0);
    }
    expect(defRec?.da[6]).toBe(1);
    expect(defRec?.da[7]).toBe(1);
  });

  test("attributes uncovered Allman-style else to the else line rather than {", () => {
    const dir = createSuite(
      {
        "allman.ts": [
          "export function branch(flag: boolean) {",
          "  if (flag)",
          "  {",
          '    return "yes";',
          "  }",
          "  else",
          "  {",
          '    return "no";',
          "  }",
          "}",
        ].join("\n"),
        "allman.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { branch } from "./allman.ts";',
          'test("else attribution", () => {',
          '  expect(branch(true)).toBe("yes");',
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    expect(parseCoverageRow(res.output, "allman.ts")).toEqual({
      funcs: "100.00",
      lines: "60.00",
      uncovered: "6,8",
    });

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const rec = lcov["allman.ts"];
    expect(rec?.da[6]).toBe(0);
    expect(rec?.da[7]).toBeUndefined();
    expect(rec?.da[8]).toBe(0);
  });

  test("does not mark top-of-file comments as code under --define with non-empty object/array", () => {
    const dir = createSuite(
      {
        "defined.ts": [
          "// Line 1 header comment",
          "// Line 2 header comment",
          "/* Line 3 block comment",
          " * Line 4 block comment */",
          "declare const CFG_OBJ: { mode: string };",
          "declare const CFG_ARR: number[];",
          "export function readDefined() {",
          "  return `${CFG_OBJ.mode}:${CFG_ARR.length}`;",
          "}",
        ].join("\n"),
        "def_top.ts": [
          "// top comment 1",
          "// top comment 2",
          "declare const CFG_OBJ: { mode: string };",
          "declare const CFG_ARR: number[];",
          'export const VALUE = `${CFG_OBJ.mode}:${CFG_ARR.join(",")}`;',
        ].join("\n"),
        "defined.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { readDefined } from "./defined.ts";',
          'import { VALUE } from "./def_top.ts";',
          'test("defined values do not mark header comments", () => {',
          '  expect(readDefined()).toBe("prod:2");',
          '  expect(VALUE).toBe("prod:10,20");',
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, [
      "--coverage",
      "--define",
      'CFG_OBJ={"mode":"prod"}',
      "--define",
      "CFG_ARR=[10,20]",
    ]);
    expect(res.exitCode).toBe(0);

    expect(parseCoverageRow(res.output, "defined.ts")).toEqual({
      funcs: "100.00",
      lines: "100.00",
      uncovered: "",
    });
    expect(parseCoverageRow(res.output, "def_top.ts")).toEqual({
      funcs: "100.00",
      lines: "100.00",
      uncovered: "",
    });

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    const definedRec = lcov["defined.ts"];
    expect(definedRec?.lf).toBe(2);
    expect(definedRec?.lh).toBe(2);
    expect(Object.keys(definedRec?.da ?? {}).map(Number)).toEqual([7, 8]);

    const topRec = lcov["def_top.ts"];
    expect(topRec?.lf).toBe(1);
    expect(topRec?.lh).toBe(1);
    expect(Object.keys(topRec?.da ?? {}).map(Number)).toEqual([5]);
  });

  test("% Funcs excludes implicit constructors, field initializers, static blocks, and async/generator bodies", () => {
    const dir = createSuite(
      {
        "class_funcs.ts": [
          "class Parent {",
          "  parentField = 10;",
          "}",
          "export class FullClass extends Parent {",
          "  fieldA = 1;",
          '  fieldB = "two";',
          "  static initialized = 0;",
          "  static {",
          "    FullClass.initialized = 42;",
          "  }",
          "  async asyncMethod() {",
          "    await Promise.resolve();",
          "    return this.fieldA + this.parentField;",
          "  }",
          "  *genMethod() {",
          "    yield this.fieldB;",
          "    return FullClass.initialized;",
          "  }",
          "}",
        ].join("\n"),
        "class_simple.ts": [
          "export class Simple {",
          "  a = 1;",
          "  b = 2;",
          "  static s = 0;",
          "  static {",
          "    Simple.s = 3;",
          "  }",
          "  sum() {",
          "    return this.a + this.b + Simple.s;",
          "  }",
          "}",
        ].join("\n"),
        "classes.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { FullClass } from "./class_funcs.ts";',
          'import { Simple } from "./class_simple.ts";',
          'test("class % Funcs matches explicit methods", async () => {',
          "  const fc = new FullClass();",
          "  expect(await fc.asyncMethod()).toBe(11);",
          "  const g = fc.genMethod();",
          '  expect(g.next().value).toBe("two");',
          "  expect(g.next().value).toBe(42);",
          "  expect(new Simple().sum()).toBe(6);",
          "});",
        ].join("\n"),
      },
      COV_BUNFIG,
    );

    const res = runBunTest(dir, ["--coverage"]);
    expect(res.exitCode).toBe(0);

    expect(parseCoverageRow(res.output, "class_funcs.ts")).toEqual({
      funcs: "100.00",
      lines: "100.00",
      uncovered: "",
    });
    expect(parseCoverageRow(res.output, "class_simple.ts")).toEqual({
      funcs: "100.00",
      lines: "100.00",
      uncovered: "",
    });

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "coverage", "lcov.info"), "utf8"),
    );
    expect(lcov["class_funcs.ts"]?.fnf).toBe(2);
    expect(lcov["class_funcs.ts"]?.fnh).toBe(2);
    expect(lcov["class_simple.ts"]?.fnf).toBe(1);
    expect(lcov["class_simple.ts"]?.fnh).toBe(1);
  });
});

describe("bun test lcov DA hit counts and coverageThreshold", () => {
  test("lcov.info DA hit counts record actual per-line execution counts via CLI flags", () => {
    const dir = createSuite({
      "once.ts": [
        "export function onceOnly(a: number, b: number, c: number) {",
        "  const summary = { sum: a + b + c, prod: a * b * c, tag: `${a}-${b}-${c}`, arr: [a, b, c, a + b, b + c] };",
        "  let acc = 0;",
        "  for (let i = 0; i < 4; i++) {",
        "    acc += summary.sum + i;",
        "  }",
        "  return acc;",
        "}",
      ].join("\n"),
      "complex_hit.ts": [
        "export function onceComplex(a: number, b: number, c: number) {",
        "  const summary = { sum: a + b + c, prod: a * b * c, tag: `${a}-${b}-${c}`, list: [a, b, c].map((x) => x + 1) };",
        "  let total = 0;",
        "  for (let i = 0; i < 4; i++) {",
        "    total += summary.sum + i;",
        "  }",
        "  return { summary, total };",
        "}",
      ].join("\n"),
      "hits.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { onceComplex } from "./complex_hit.ts";',
        'import { onceOnly } from "./once.ts";',
        'test("DA hit counts", () => {',
        "  expect(onceOnly(1, 2, 3)).toBe(30);",
        "  expect(onceComplex(1, 2, 3).total).toBe(30);",
        "});",
      ].join("\n"),
    });

    const res = runBunTest(dir, [
      "--coverage",
      "--coverage-reporter=text",
      "--coverage-reporter=lcov",
      "--coverage-dir=cov-out",
      "--coverage-skip-test-files",
    ]);
    expect(res.exitCode).toBe(0);

    const lcov = parseLcovRecords(
      readFileSync(join(dir, "cov-out", "lcov.info"), "utf8"),
    );
    const onceRec = lcov["once.ts"];
    expect(onceRec?.da[2]).toBe(1);
    expect(onceRec?.da[5]).toBe(4);
    expect(onceRec?.da[7]).toBe(1);

    const complexRec = lcov["complex_hit.ts"];
    expect(complexRec?.da[2]).toBe(3);
    expect(complexRec?.da[5]).toBe(4);
  });

  test("coverageThreshold enforces numeric and table bounds, ignores misspelled keys, and defaults omitted keys to 0.90", () => {
    const dir = createSuite({
      "mod.ts": [
        "export async function half(p: Promise<number>) {",
        "  const v = await p;",
        "  const a = v + 1;",
        "  return a;",
        "}",
      ].join("\n"),
      "mod.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { half } from "./mod.ts";',
        'test("rejects at await", async () => {',
        '  await expect(half(Promise.reject(new Error("x")))).rejects.toThrow("x");',
        "});",
      ].join("\n"),
    });

    const cases: readonly { config: string; expectedExit: number }[] = [
      { config: "coverageThreshold = 0.5", expectedExit: 0 },
      { config: "coverageThreshold = 0.51", expectedExit: 1 },
      { config: "coverageThreshold = { lines = 0.5 }", expectedExit: 0 },
      { config: "coverageThreshold = { lines = 0.8 }", expectedExit: 1 },
      { config: "coverageThreshold = { line = 0.8 }", expectedExit: 0 },
    ];

    for (const item of cases) {
      writeFileSync(
        join(dir, "bunfig.toml"),
        `[test]\ncoverageSkipTestFiles = true\n${item.config}\n`,
      );
      const res = runBunTest(dir, ["--coverage"]);
      expect(res.exitCode, item.config).toBe(item.expectedExit);
    }

    const partialDir = createSuite({});
    const writeSizedModule = (uncoveredLines: number) => {
      const coveredCount = 96 - uncoveredLines;
      const lines = [
        "export function sized(flag: boolean) {",
        "  let x = 0;",
        ...Array.from({ length: coveredCount }, (_, i) => `  x += ${i};`),
        "  if (flag) {",
        ...Array.from(
          { length: uncoveredLines },
          (_, i) => `    x += ${i + 100};`,
        ),
        "  }",
        "  return x;",
        "}",
      ];
      writeFileSync(join(partialDir, "sized.ts"), lines.join("\n"));
      writeFileSync(
        join(partialDir, "sized.test.ts"),
        [
          'import { expect, test } from "bun:test";',
          'import { sized } from "./sized.ts";',
          'test("sized", () => { expect(sized(false)).toBeGreaterThanOrEqual(0); });',
        ].join("\n"),
      );
      writeFileSync(
        join(partialDir, "bunfig.toml"),
        "[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = { functions = 0.5 }\n",
      );
    };

    // 89 covered of 100 executable lines -> 89.00% < default 0.90 -> exit 1
    writeSizedModule(11);
    const failDefault = runBunTest(partialDir, ["--coverage"]);
    expect(failDefault.exitCode).toBe(1);
    expect(parseCoverageRow(failDefault.output, "sized.ts").lines).toBe(
      "89.00",
    );

    // 90 covered of 100 executable lines -> 90.00% >= default 0.90 -> exit 0
    writeSizedModule(10);
    const passDefault = runBunTest(partialDir, ["--coverage"]);
    expect(passDefault.exitCode).toBe(0);
    expect(parseCoverageRow(passDefault.output, "sized.ts").lines).toBe(
      "90.00",
    );
  });
});
