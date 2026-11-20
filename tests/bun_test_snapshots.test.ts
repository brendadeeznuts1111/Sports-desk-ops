/**
 * @file tests/bun_test_snapshots.test.ts
 * @description Self-contained contract suite for `bun test` snapshot files (`__snapshots__/*.snap`),
 * inline snapshots, error snapshots, property matchers, `--update-snapshots` pruning, and
 * documented pin-drift boundaries (`toMatchFileSnapshot`, `addSnapshotSerializer`, Jest/Vitest
 * header compatibility).
 *
 * Every test runs in a throwaway `tmpdir()` directory so no `.snap` artifacts are written into
 * the repository checkout.
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
import { resolveNativeBunLintBin } from "../scripts/lint_native.ts";

const canaryBin = resolveNativeBunLintBin();
const canaryTest = (name: string, fn: () => void | Promise<void>) => {
  if (canaryBin === null) test.skip(name, fn);
  else test(name, fn);
};

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-snaps-"));
  dirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

function runBunTestWithBin(
  bin: string,
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { readonly exitCode: number | null; readonly output: string } {
  const result = Bun.spawnSync([bin, "test", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CI: "",
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function runBunTest(
  dir: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { readonly exitCode: number | null; readonly output: string } {
  return runBunTestWithBin(process.execPath, dir, args, env);
}

describe("bun test snapshot files (__snapshots__/*.snap)", () => {
  test("creates sibling __snapshots__/<file>.snap with Bun header, numbered keys, named hints, and escaped template characters", () => {
    const dir = createFixture({
      "multi.test.ts": [
        'import { describe, expect, test } from "bun:test";',
        'describe("outer", () => {',
        '  test("multi", () => {',
        '    expect("one").toMatchSnapshot();',
        '    expect("two").toMatchSnapshot("named hint");',
        '    expect("backtick ` and ${x}").toMatchSnapshot();',
        "  });",
        "});",
      ].join("\n"),
    });

    const first = runBunTest(dir, ["./multi.test.ts"], { CI: "" });
    expect(first.exitCode, first.output).toBe(0);

    const snapPath = join(dir, "__snapshots__", "multi.test.ts.snap");
    expect(existsSync(snapPath)).toBe(true);
    const snapText = readFileSync(snapPath, "utf8");
    expect(
      snapText.startsWith(
        "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots",
      ),
    ).toBe(true);
    expect(snapText).toContain('exports[`outer multi 1`] = `"one"`;');
    expect(snapText).toContain(
      'exports[`outer multi: named hint 1`] = `"two"`;',
    );
    expect(snapText).toContain(
      'exports[`outer multi 2`] = `"backtick \\` and \\${x}"`;',
    );

    const ciCheck = runBunTest(dir, ["./multi.test.ts"], { CI: "true" });
    expect(ciCheck.exitCode, ciCheck.output).toBe(0);
  });

  test("refuses recording missing snapshots under CI=true unless --update-snapshots is passed", () => {
    const dir = createFixture({
      "ci.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("ci snap", () => { expect("ci-val").toMatchSnapshot(); });',
      ].join("\n"),
    });

    const snapPath = join(dir, "__snapshots__", "ci.test.ts.snap");
    const blocked = runBunTest(dir, ["./ci.test.ts"], { CI: "true" });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.output).toContain(
      "Snapshot creation is disabled in CI environments unless --update-snapshots is used",
    );
    // Measured on 1.4.4/1.4.5: Bun creates a header-only stub file without writing any snapshot entry.
    const blockedSnap = existsSync(snapPath)
      ? readFileSync(snapPath, "utf8")
      : "";
    expect(blockedSnap).toBe(
      "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n",
    );
    expect(blockedSnap).not.toContain("exports[");

    const updated = runBunTest(dir, ["./ci.test.ts", "--update-snapshots"], {
      CI: "true",
    });
    expect(updated.exitCode, updated.output).toBe(0);
    expect(existsSync(snapPath)).toBe(true);
    expect(readFileSync(snapPath, "utf8")).toContain(
      'exports[`ci snap 1`] = `"ci-val"`;',
    );
  });

  test("fails with a diff on mismatch and rewrites the snapshot on --update-snapshots", () => {
    const dir = createFixture({
      "diff.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("user name", () => {',
        '  expect({ name: process.env.USER_NAME ?? "John" }).toMatchSnapshot();',
        "});",
      ].join("\n"),
    });

    const init = runBunTest(dir, ["./diff.test.ts"], { USER_NAME: "John" });
    expect(init.exitCode, init.output).toBe(0);

    const mismatch = runBunTest(dir, ["./diff.test.ts"], {
      CI: "true",
      USER_NAME: "Jane",
    });
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.output).toContain("John");
    expect(mismatch.output).toContain("Jane");
    expect(mismatch.output).toContain("snapshots: 1 failed");

    const rewritten = runBunTest(
      dir,
      ["./diff.test.ts", "--update-snapshots"],
      { USER_NAME: "Jane" },
    );
    expect(rewritten.exitCode, rewritten.output).toBe(0);

    const snapText = readFileSync(
      join(dir, "__snapshots__", "diff.test.ts.snap"),
      "utf8",
    );
    expect(snapText).toContain('"Jane"');
    expect(snapText).not.toContain('"John"');
  });

  test("supports property matchers for dynamic values across runs", () => {
    const dir = createFixture({
      "prop.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("dynamic fields", () => {',
        "  expect({",
        '    id: Number(process.env.DYN_ID ?? "1"),',
        '    name: "John",',
        '    createdAt: process.env.DYN_TS ?? "2026-01-01",',
        "  }).toMatchSnapshot({",
        "    id: expect.any(Number),",
        "    createdAt: expect.any(String),",
        "  });",
        "});",
      ].join("\n"),
    });

    const first = runBunTest(dir, ["./prop.test.ts"], {
      DYN_ID: "101",
      DYN_TS: "2026-01-01",
    });
    expect(first.exitCode, first.output).toBe(0);

    const snapText = readFileSync(
      join(dir, "__snapshots__", "prop.test.ts.snap"),
      "utf8",
    );
    expect(snapText).toContain('"createdAt": Any<String>,');
    expect(snapText).toContain('"id": Any<Number>,');
    expect(snapText).toContain('"name": "John",');

    const second = runBunTest(dir, ["./prop.test.ts"], {
      CI: "true",
      DYN_ID: "999",
      DYN_TS: "2026-11-20",
    });
    expect(second.exitCode, second.output).toBe(0);
  });

  test("prunes skipped-test entries on --update-snapshots in Bun snapshot format", () => {
    const dir = createFixture({
      "stale.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("kept", () => { expect("a").toMatchSnapshot(); });',
        'test.skipIf(process.env.SKIP === "1")("maybe", () => { expect("b").toMatchSnapshot(); });',
      ].join("\n"),
    });

    const snapPath = join(dir, "__snapshots__", "stale.test.ts.snap");
    const first = runBunTest(dir, ["./stale.test.ts", "--update-snapshots"]);
    expect(first.exitCode, first.output).toBe(0);
    const initialSnap = readFileSync(snapPath, "utf8");
    expect(initialSnap).toContain("exports[`kept 1`]");
    expect(initialSnap).toContain("exports[`maybe 1`]");

    const pruned = runBunTest(dir, ["./stale.test.ts", "--update-snapshots"], {
      SKIP: "1",
    });
    expect(pruned.exitCode, pruned.output).toBe(0);
    const updatedSnap = readFileSync(snapPath, "utf8");
    expect(updatedSnap).toContain("exports[`kept 1`]");
    expect(updatedSnap).not.toContain("exports[`maybe 1`]");
  });
});

describe("inline and error snapshots", () => {
  test("auto-populates .toMatchInlineSnapshot() and .toThrowErrorMatchingInlineSnapshot() and passes under CI=true", () => {
    const dir = createFixture({
      "inline.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("inline", () => {',
        '  expect({ hello: "world" }).toMatchInlineSnapshot();',
        '  expect(() => { throw new Error("Another error"); }).toThrowErrorMatchingInlineSnapshot();',
        "});",
      ].join("\n"),
    });

    const first = runBunTest(dir, ["./inline.test.ts"], { CI: "" });
    expect(first.exitCode, first.output).toBe(0);

    const updatedSource = readFileSync(join(dir, "inline.test.ts"), "utf8");
    expect(updatedSource).toContain(".toMatchInlineSnapshot(");
    expect(updatedSource).toContain('"hello": "world"');
    expect(updatedSource).toContain(
      '.toThrowErrorMatchingInlineSnapshot(`"Another error"`)',
    );

    const ciCheck = runBunTest(dir, ["./inline.test.ts"], { CI: "true" });
    expect(ciCheck.exitCode, ciCheck.output).toBe(0);
  });

  test("records error messages in .toThrowErrorMatchingSnapshot() and fails when the message changes", () => {
    const dir = createFixture({
      "err.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("err snap", () => {',
        "  expect(() => {",
        '    throw new Error(process.env.ERR_MSG ?? "Something went wrong");',
        "  }).toThrowErrorMatchingSnapshot();",
        "});",
      ].join("\n"),
    });

    const init = runBunTest(dir, ["./err.test.ts"]);
    expect(init.exitCode, init.output).toBe(0);
    expect(
      readFileSync(join(dir, "__snapshots__", "err.test.ts.snap"), "utf8"),
    ).toContain('exports[`err snap 1`] = `"Something went wrong"`;');

    const mismatch = runBunTest(dir, ["./err.test.ts"], {
      CI: "true",
      ERR_MSG: "Different error",
    });
    expect(mismatch.exitCode).not.toBe(0);
  });
});

describe("snapshot pin-drift boundaries (live docs vs 1.4.4/1.4.5 runtime)", () => {
  test("documents that toMatchFileSnapshot is absent and expect.addSnapshotSerializer throws Not implemented", () => {
    expect(typeof (Bun as unknown as Record<string, unknown>).snapshot).toBe(
      "undefined",
    );
    const dir = createFixture({
      "drift_api.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("drift surface", () => {',
        "  const bunGlobal = Bun as unknown as Record<string, unknown>;",
        '  expect(typeof bunGlobal.snapshot).toBe("undefined");',
        '  const matcher = expect("x") as unknown as Record<string, unknown>;',
        '  expect(typeof matcher.toMatchFileSnapshot).toBe("undefined");',
        "  const expectFn = expect as unknown as Record<string, unknown>;",
        '  expect(typeof expectFn.addSnapshotSerializer).toBe("function");',
        "  expect(() => {",
        "    expect.addSnapshotSerializer({",
        "      test: () => false,",
        '      serialize: () => "",',
        "    });",
        "  }).toThrow(/Not implemented/);",
        "});",
      ].join("\n"),
    });

    const res = runBunTest(dir, ["./drift_api.test.ts"]);
    expect(res.exitCode, res.output).toBe(0);
  });

  test("pins current Jest and Vitest snapshot header behavior on this runtime", () => {
    const jestDir = createFixture({
      "jest.test.ts": [
        'import { describe, expect, test } from "bun:test";',
        'describe("outer", () => {',
        '  test("inner", () => {',
        "    expect(function myFn() {}).toMatchSnapshot();",
        "  });",
        "});",
      ].join("\n"),
      "__snapshots__/jest.test.ts.snap": [
        "// Jest Snapshot v1, https://goo.gl/fbAQLP",
        "",
        "exports[`outer inner 1`] = `[Function]`;",
        "",
      ].join("\n"),
    });
    const jestRes = runBunTest(jestDir, ["./jest.test.ts"], { CI: "true" });
    expect(jestRes.exitCode).not.toBe(0);
    expect(jestRes.output).toContain("Expected: [Function]");
    expect(jestRes.output).toContain("Received: [Function: myFn]");

    const vitestDir = createFixture({
      "vtest.test.ts": [
        'import { describe, expect, test } from "bun:test";',
        'describe("outer", () => {',
        '  test("inner", () => {',
        "    expect(function myFn() {}).toMatchSnapshot();",
        "  });",
        "});",
      ].join("\n"),
      "__snapshots__/vtest.test.ts.snap": [
        "// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html",
        "",
        "exports[`outer > inner 1`] = `[Function]`;",
        "",
      ].join("\n"),
    });
    const vitestRes = runBunTest(vitestDir, ["./vtest.test.ts"], { CI: "" });
    expect(vitestRes.exitCode, vitestRes.output).toBe(0);
    const vitestSnap = readFileSync(
      join(vitestDir, "__snapshots__", "vtest.test.ts.snap"),
      "utf8",
    );
    expect(vitestSnap).toContain("exports[`outer > inner 1`] = `[Function]`;");
    expect(vitestSnap).toContain(
      "exports[`outer inner 1`] = `[Function: myFn]`;",
    );

    const fromVitestDir = createFixture({
      "from_vitest.test.ts": [
        'import { describe, expect, test } from "vitest";',
        'describe("outer", () => {',
        '  test("inner", () => {',
        "    expect(function myFn() {}).toMatchSnapshot();",
        "  });",
        "});",
      ].join("\n"),
    });
    const fromVitestRes = runBunTest(fromVitestDir, ["./from_vitest.test.ts"], {
      CI: "",
    });
    expect(fromVitestRes.exitCode, fromVitestRes.output).toBe(0);
    const fromVitestSnap = readFileSync(
      join(fromVitestDir, "__snapshots__", "from_vitest.test.ts.snap"),
      "utf8",
    );
    expect(fromVitestSnap.startsWith("// Bun Snapshot v1")).toBe(true);
    expect(fromVitestSnap).toContain(
      "exports[`outer inner 1`] = `[Function: myFn]`;",
    );
  });
});

describe("canary snapshot features (gated on canary binary)", () => {
  canaryTest(
    "Bun.snapshot stays undefined while .toMatchFileSnapshot() writes raw strings and Vitest pretty-format objects",
    () => {
      const dir = createFixture({
        "file.test.ts": [
          'import { expect, test } from "bun:test";',
          'test("file snap", async () => {',
          "  const bunGlobal = Bun as unknown as Record<string, unknown>;",
          '  expect(typeof bunGlobal.snapshot).toBe("undefined");',
          '  await expect("<h1>hi</h1>").toMatchFileSnapshot("./snapshots/page.html");',
          '  await expect({ fn: function myFn() {} }).toMatchFileSnapshot("./snapshots/obj.txt");',
          "});",
        ].join("\n"),
      });

      const first = runBunTestWithBin(canaryBin!, dir, ["./file.test.ts"], {
        CI: "",
      });
      expect(first.exitCode, first.output).toBe(0);

      expect(readFileSync(join(dir, "snapshots", "page.html"), "utf8")).toBe(
        "<h1>hi</h1>",
      );
      expect(readFileSync(join(dir, "snapshots", "obj.txt"), "utf8")).toContain(
        '"fn": [Function],',
      );

      const second = runBunTestWithBin(canaryBin!, dir, ["./file.test.ts"], {
        CI: "true",
      });
      expect(second.exitCode, second.output).toBe(0);
    },
  );

  canaryTest(
    "reads and updates Jest and Vitest snapshot files in their own format and keeps skipped entries on --update-snapshots",
    () => {
      const jestDir = createFixture({
        "jest.test.ts": [
          'import { describe, expect, test } from "bun:test";',
          'describe("outer", () => {',
          '  test("inner", () => {',
          "    expect(function myFn() {}).toMatchSnapshot();",
          "  });",
          "});",
          'test.skip("skipped", () => {',
          '  expect("kept-when-skipped").toMatchSnapshot();',
          "});",
        ].join("\n"),
        "__snapshots__/jest.test.ts.snap": [
          "// Jest Snapshot v1, https://goo.gl/fbAQLP",
          "",
          "exports[`outer inner 1`] = `[Function]`;",
          "",
          'exports[`skipped 1`] = `"kept-when-skipped"`;',
          "",
          'exports[`obsolete 1`] = `"removed"`;',
          "",
        ].join("\n"),
      });

      const jestMatch = runBunTestWithBin(
        canaryBin!,
        jestDir,
        ["./jest.test.ts"],
        { CI: "true" },
      );
      expect(jestMatch.exitCode, jestMatch.output).toBe(0);

      const jestUpdated = runBunTestWithBin(
        canaryBin!,
        jestDir,
        ["./jest.test.ts", "--update-snapshots"],
        { CI: "" },
      );
      expect(jestUpdated.exitCode, jestUpdated.output).toBe(0);

      const jestSnapAfter = readFileSync(
        join(jestDir, "__snapshots__", "jest.test.ts.snap"),
        "utf8",
      );
      expect(jestSnapAfter.startsWith("// Jest Snapshot v1")).toBe(true);
      expect(jestSnapAfter).toContain("exports[`outer inner 1`]");
      expect(jestSnapAfter).toContain("exports[`skipped 1`]");
      expect(jestSnapAfter).not.toContain("exports[`obsolete 1`]");

      const vitestDir = createFixture({
        "from_vitest.test.ts": [
          'import { describe, expect, test } from "vitest";',
          'describe("outer", () => {',
          '  test("inner", () => {',
          "    expect(function myFn() {}).toMatchSnapshot();",
          "  });",
          "});",
        ].join("\n"),
      });

      const vitestRes = runBunTestWithBin(
        canaryBin!,
        vitestDir,
        ["./from_vitest.test.ts"],
        { CI: "" },
      );
      expect(vitestRes.exitCode, vitestRes.output).toBe(0);

      const vitestSnap = readFileSync(
        join(vitestDir, "__snapshots__", "from_vitest.test.ts.snap"),
        "utf8",
      );
      expect(vitestSnap.startsWith("// Vitest Snapshot v1")).toBe(true);
      expect(vitestSnap).toContain(
        "exports[`outer > inner 1`] = `[Function]`;",
      );
    },
  );

  canaryTest(
    "expect.addSnapshotSerializer runs LIFO, scopes file serializers to their file, and applies preload serializers across files",
    () => {
      const dir = createFixture({
        "preload.ts": [
          'import { expect } from "bun:test";',
          "expect.addSnapshotSerializer({",
          '  test: (v: unknown) => typeof v === "object" && v !== null && "tag" in v,',
          "  serialize: (v: { tag: string }) => `PRELOAD(${v.tag})`,",
          "});",
        ].join("\n"),
        "ser_a.test.ts": [
          'import { expect, test } from "bun:test";',
          "expect.addSnapshotSerializer({",
          '  test: (v: unknown) => typeof v === "object" && v !== null && "tag" in v,',
          "  serialize: (v: { tag: string }) => `LOCAL_A(${v.tag})`,",
          "});",
          'test("lifo", () => {',
          '  expect({ tag: "x" }).toMatchSnapshot();',
          "});",
        ].join("\n"),
        "ser_b.test.ts": [
          'import { expect, test } from "bun:test";',
          'test("preload only", () => {',
          '  expect({ tag: "y" }).toMatchSnapshot();',
          "});",
        ].join("\n"),
      });

      const res = runBunTestWithBin(
        canaryBin!,
        dir,
        ["--preload", "./preload.ts", "./ser_a.test.ts", "./ser_b.test.ts"],
        { CI: "" },
      );
      expect(res.exitCode, res.output).toBe(0);

      expect(
        readFileSync(join(dir, "__snapshots__", "ser_a.test.ts.snap"), "utf8"),
      ).toContain("exports[`lifo 1`] = `LOCAL_A(x)`;");
      expect(
        readFileSync(join(dir, "__snapshots__", "ser_b.test.ts.snap"), "utf8"),
      ).toContain("exports[`preload only 1`] = `PRELOAD(y)`;");
    },
  );
});
