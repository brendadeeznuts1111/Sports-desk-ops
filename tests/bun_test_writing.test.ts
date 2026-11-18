/**
 * @file tests/bun_test_writing.test.ts
 * @description Measured writing-side behaviors from the Bun test docs on the pinned runtime.
 *
 * Covers per-test and CLI timeouts, `{ retry }`/`{ repeats }`, the `done` callback, `test.only`,
 * `test.todo` with `--todo`, `test.todoIf`, object-row `test.each`, and assertion counting. The
 * live docs also describe `test.fails`, `test.for`, `test.extend`, `test.override`, `describe.for`,
 * `expect.soft`, `expect.poll` and the custom-equality/test-state helpers; the final block records
 * which of those the pin does **not** expose instead of assuming them.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: bun-test-writing

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function suite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-writing-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function run(
  dir: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): { exitCode: number | null; output: string } {
  const result = Bun.spawnSync([process.execPath, "test", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function logLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

describe("test options", () => {
  test("{ retry: 1 } retries a failed test and reports the attempt", () => {
    const dir = suite({
      "retry.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { existsSync, writeFileSync } from "node:fs";',
        'test("flaky", () => {',
        "  const marker = process.env.RETRY_MARKER as string;",
        "  if (!existsSync(marker)) {",
        '    writeFileSync(marker, "1");',
        '    throw new Error("first attempt");',
        "  }",
        "  expect(1).toBe(1);",
        "}, { retry: 1 });",
      ].join("\n"),
    });
    const result = run(dir, [], { RETRY_MARKER: join(dir, "marker") });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("attempt 2");
  });

  test("{ repeats: 2 } runs the test three times", () => {
    const dir = suite({
      "repeats.test.ts": [
        'import { test } from "bun:test";',
        'import { appendFileSync } from "node:fs";',
        'test("repeat", () => {',
        '  appendFileSync(process.env.REPEAT_LOG as string, "run\\n");',
        "}, { repeats: 2 });",
      ].join("\n"),
    });
    const log = join(dir, "repeats.log");
    const result = run(dir, [], { REPEAT_LOG: log });
    expect(result.exitCode).toBe(0);
    expect(logLines(log).length).toBe(3);
    expect(result.output).toContain("run 3");
  });

  test("a per-test timeout fails the test", () => {
    const dir = suite({
      "timeout.test.ts":
        'import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(100); }, 10);',
    });
    const result = run(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("timed out");
  });

  test("--timeout applies to tests without their own timeout", () => {
    const dir = suite({
      "slow.test.ts":
        'import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(100); });',
    });
    const result = run(dir, ["--timeout=10"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("timed out");
  });

  test("a done callback completes an async test", () => {
    const dir = suite({
      "done.test.ts":
        'import { test } from "bun:test";\ntest("done", (done) => { setTimeout(done, 5); });',
    });
    const result = run(dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("(pass) done");
  });
});

describe("test modifiers", () => {
  test("test.only runs only the marked test", () => {
    const dir = suite({
      "only.test.ts": [
        'import { test } from "bun:test";',
        'import { appendFileSync } from "node:fs";',
        'test("one", () => { appendFileSync(process.env.RUN_LOG as string, "one\\n"); });',
        'test.only("two", () => { appendFileSync(process.env.RUN_LOG as string, "two\\n"); });',
      ].join("\n"),
    });
    const log = join(dir, "only.log");
    const result = run(dir, [], { RUN_LOG: log });
    expect(result.exitCode).toBe(0);
    expect(logLines(log)).toEqual(["two"]);
  });

  test("test.todo is reported, and --todo fails a passing todo", () => {
    const dir = suite({
      "todo.test.ts": [
        'import { test } from "bun:test";',
        'test.todo("passes later", () => {});',
      ].join("\n"),
    });
    const reported = run(dir);
    expect(reported.exitCode).toBe(0);
    expect(reported.output).toContain("(todo) passes later");

    const checked = run(dir, ["--todo"]);
    expect(checked.exitCode).not.toBe(0);
    expect(checked.output).toContain("marked as todo but passes");
  });

  test("test.todoIf(true) marks the test as todo", () => {
    const dir = suite({
      "todo-if.test.ts":
        'import { test } from "bun:test";\ntest.todoIf(true)("todo if", () => {});',
    });
    const result = run(dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("(todo) todo if");
  });
});

describe("assertion counting", () => {
  test("expect.assertions checks the exact count", () => {
    expect.assertions(2);
    expect(1).toBe(1);
    expect(2).toBe(2);
  });

  test("expect.hasAssertions requires at least one assertion", () => {
    expect.hasAssertions();
    expect(1).toBe(1);
  });
});

describe("documented but absent on the pin", () => {
  test("the newer writing helpers are undefined", () => {
    const testApi = test as unknown as Record<string, unknown>;
    for (const name of ["fails", "for", "extend", "override"]) {
      expect(testApi[name], name).toBeUndefined();
    }
    const describeApi = describe as unknown as Record<string, unknown>;
    expect(describeApi.for).toBeUndefined();

    const expectApi = expect as unknown as Record<string, unknown>;
    for (const name of [
      "soft",
      "poll",
      "toSatisfy",
      "addEqualityTesters",
      "getState",
      "setState",
    ]) {
      expect(expectApi[name], name).toBeUndefined();
    }
  });
});

test.each([
  { a: 1, b: 2, expected: 3 },
  { a: 4, b: 5, expected: 9 },
])("add($a, $b) = $expected", ({ a, b, expected }) => {
  expect(a + b).toBe(expected);
});
