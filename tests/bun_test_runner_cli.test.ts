/**
 * @file tests/bun_test_runner_cli.test.ts
 * @description Measured subset of the `bun test` runner knobs on the pinned runtime.
 *
 * Covers the large-codebase controls this repo actually relies on (sharding, parallel workers,
 * timing files) plus the filtering/reporting/AI-output flags. Each case builds a throwaway suite
 * in a temp directory and spawns the real CLI, so the assertions are about observable output and
 * exit codes, not the flag's presence in `--help`.
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

// @bun-behavior: bun-test-runner

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function suite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-runner-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function run(
  dir: string,
  args: readonly string[],
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

function lines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

describe("bun test runner: filtering and failure control", () => {
  test("--test-name-pattern runs only matching names", () => {
    const dir = suite({
      "filter.test.ts": [
        'import { test } from "bun:test";',
        'test("alpha case", () => {});',
        'test("beta case", () => {});',
      ].join("\n"),
    });
    const result = run(dir, ["--test-name-pattern", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("alpha case");
    expect(result.output).not.toContain("beta case");
  });

  test("--bail=1 stops after the first failure", () => {
    const dir = suite({
      "bail.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("first fails", () => { expect(1).toBe(2); });',
        'test("second fails", () => { expect(1).toBe(2); });',
      ].join("\n"),
    });
    const result = run(dir, ["--bail=1"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output.match(/\(fail\)/g)?.length ?? 0).toBe(1);
    expect(result.output).not.toContain("second fails");
  });

  test("--retry=1 retries a failed test until it passes", () => {
    const dir = suite({
      "retry.test.ts": [
        'import { expect, test } from "bun:test";',
        'import { existsSync, writeFileSync } from "node:fs";',
        'test("eventually passes", () => {',
        "  const marker = process.env.RETRY_MARKER as string;",
        "  if (!existsSync(marker)) {",
        '    writeFileSync(marker, "1");',
        '    throw new Error("first attempt");',
        "  }",
        "  expect(1).toBe(1);",
        "});",
      ].join("\n"),
    });
    const marker = join(dir, "retry-marker");
    const result = run(dir, ["--retry=1"], { RETRY_MARKER: marker });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("eventually passes");
    expect(existsSync(marker)).toBe(true);
  });

  test("--rerun-each=2 evaluates each file twice", () => {
    const log = join(dirLog(), "rerun.log");
    const dir = suite({
      "rerun.test.ts": [
        'import { appendFileSync } from "node:fs";',
        'import { test } from "bun:test";',
        'appendFileSync(process.env.RUN_LOG as string, "run\\n");',
        'test("reruns", () => {});',
      ].join("\n"),
    });
    const result = run(dir, ["--rerun-each=2"], { RUN_LOG: log });
    expect(result.exitCode).toBe(0);
    expect(lines(log).length).toBe(2);
  });
});

describe("bun test runner: sharding and workers", () => {
  test("--shard partitions the files deterministically", () => {
    const files = Object.fromEntries(
      ["a", "b", "c", "d"].map((name) => [
        `${name}.test.ts`,
        [
          'import { appendFileSync } from "node:fs";',
          'import { test } from "bun:test";',
          `appendFileSync(process.env.RUN_LOG as string, "${name}\\n");`,
          `test("${name}", () => {});`,
        ].join("\n"),
      ]),
    );
    const dir = suite(files);
    const log1 = join(dirLog(), "shard1.log");
    const log2 = join(dirLog(), "shard2.log");
    const log1b = join(dirLog(), "shard1b.log");

    const first = run(dir, ["--shard=1/2"], { RUN_LOG: log1 });
    const second = run(dir, ["--shard=2/2"], { RUN_LOG: log2 });
    const again = run(dir, ["--shard=1/2"], { RUN_LOG: log1b });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(again.exitCode).toBe(0);

    const one = lines(log1);
    const two = lines(log2);
    expect([...one, ...two].sort()).toEqual(["a", "b", "c", "d"]);
    expect(one.filter((name) => two.includes(name))).toEqual([]);
    expect(one.length).toBeGreaterThan(0);
    expect(lines(log1b)).toEqual(one);
  });

  test("--parallel --no-isolate runs every file in worker processes", () => {
    const log = join(dirLog(), "parallel.log");
    const files = Object.fromEntries(
      ["one", "two", "three"].map((name) => [
        `${name}.test.ts`,
        [
          'import { appendFileSync } from "node:fs";',
          'import { test } from "bun:test";',
          `appendFileSync(process.env.RUN_LOG as string, "${name}\\n");`,
          `test("${name}", () => {});`,
        ].join("\n"),
      ]),
    );
    const result = run(suite(files), ["--parallel=2", "--no-isolate"], {
      RUN_LOG: log,
    });
    expect(result.exitCode).toBe(0);
    expect(lines(log).sort()).toEqual(["one", "three", "two"]);
  });
});

describe("bun test runner: timings and reporting", () => {
  test("--update-timings writes a file the next run can read", () => {
    const dir = suite({
      "first.test.ts":
        'import { test } from "bun:test";\ntest("first", () => {});',
      "second.test.ts":
        'import { test } from "bun:test";\ntest("second", () => {});',
    });
    const timings = join(dir, "timings.json");
    const update = run(dir, ["--update-timings", `--timings=${timings}`]);
    expect(update.exitCode).toBe(0);
    const parsed = JSON.parse(readFileSync(timings, "utf8")) as {
      version: number;
      files: Record<string, number>;
    };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.files).length).toBeGreaterThanOrEqual(2);

    const replay = run(dir, [`--timings=${timings}`]);
    expect(replay.exitCode).toBe(0);
  });

  test("--reporter=junit writes a JUnit XML file", () => {
    const dir = suite({
      "report.test.ts":
        'import { test } from "bun:test";\ntest("reported", () => {});',
    });
    const outfile = join(dir, "junit.xml");
    const result = run(dir, [
      "--reporter=junit",
      `--reporter-outfile=${outfile}`,
    ]);
    expect(result.exitCode).toBe(0);
    const xml = readFileSync(outfile, "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toContain("<testcase");
    expect(xml).toContain("reported");
  });
});

describe("bun test runner: AI agent output", () => {
  test("CLAUDECODE=1 hides passing indicators but keeps failures", () => {
    const dir = suite({
      "agent.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("pass case", () => { expect(1).toBe(1); });',
        'test("fail case", () => { expect(1).toBe(2); });',
      ].join("\n"),
    });
    const plain = run(dir, []);
    const agent = run(dir, [], { CLAUDECODE: "1" });
    expect(plain.exitCode).not.toBe(0);
    expect(plain.output).toContain("(pass) pass case");
    expect(agent.exitCode).not.toBe(0);
    expect(agent.output).not.toContain("(pass) pass case");
    expect(agent.output).toContain("(fail) fail case");
    expect(agent.output).toContain("1 pass");
  });
});

function dirLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-log-"));
  dirs.push(dir);
  return dir;
}
