/**
 * @file tests/bun_test_runtime.test.ts
 * @description Measured runtime-integration behaviors of `bun test` on the pinned runtime.
 *
 * Covers the environment defaults (`NODE_ENV`, `TZ`, `import.meta.env`), the zero-timeout escape,
 * unhandled errors/rejections between tests, top-level load failures, globals, and `--define`.
 * The docs describe Vite-style `import.meta.env` variables and a failing unsettled-await guard;
 * the pin does not match either, so those are recorded as measured drift, not assumed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: bun-test-runtime

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function suite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-runtime-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function baseEnv(
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
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
    env: { ...baseEnv({}), NO_COLOR: "1", ...env },
  });
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function assertFile(body: string): Record<string, string> {
  return {
    "assert.test.ts": [
      'import { expect, test } from "bun:test";',
      'test("assertion", () => {',
      body,
      "});",
    ].join("\n"),
  };
}

describe("environment defaults", () => {
  test("NODE_ENV defaults to test and an explicit value wins", () => {
    const dir = suite(assertFile('expect(process.env.NODE_ENV).toBe("test");'));
    const implicit = run(dir, [], baseEnv({ NODE_ENV: undefined }));
    expect(implicit.exitCode).toBe(0);

    const explicit = run(dir, [], baseEnv({ NODE_ENV: "development" }));
    expect(explicit.exitCode).not.toBe(0);
    expect(explicit.output).toContain('Received: "development"');
  });

  test("TZ defaults to UTC and an explicit value wins", () => {
    const dir = suite(
      assertFile("expect(new Date().getTimezoneOffset()).toBe(0);"),
    );
    const utc = run(dir, [], baseEnv({ TZ: undefined }));
    expect(utc.exitCode).toBe(0);

    const zone = run(dir, [], baseEnv({ TZ: "America/New_York" }));
    expect(zone.exitCode).not.toBe(0);
  });

  test("import.meta.env exposes process.env but not the Vite variables on this pin", () => {
    const envAccess =
      "const env = (import.meta as unknown as { env: Record<string, unknown> }).env;";
    const dir = suite({
      "env.test.ts": [
        'import { expect, test } from "bun:test";',
        envAccess,
        'test("env shape", () => {',
        '  expect(env.NODE_ENV).toBe("test");',
        "  expect(env.MODE).toBeUndefined();",
        "  expect(env.DEV).toBeUndefined();",
        "  expect(env.PROD).toBeUndefined();",
        "  expect(env.SSR).toBeUndefined();",
        "  expect(env.BASE_URL).toBeUndefined();",
        "});",
      ].join("\n"),
    });
    const result = run(dir, [], baseEnv({ MODE: undefined }));
    expect(result.exitCode).toBe(0);

    const staging = suite({
      "env.test.ts": [
        'import { expect, test } from "bun:test";',
        envAccess,
        'test("env passthrough", () => {',
        '  expect(env.MODE).toBe("staging");',
        "});",
      ].join("\n"),
    });
    const passthrough = run(staging, [], baseEnv({ MODE: "staging" }));
    expect(passthrough.exitCode).toBe(0);
  });
});

describe("timeouts and load failures", () => {
  test("a per-test timeout of 0 disables the CLI timeout", () => {
    const dir = suite({
      "zero.test.ts":
        'import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(50); }, 0);',
    });
    const result = run(dir, ["--timeout=10"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("(pass) slow");
  });

  test("an unhandled error between tests exits nonzero", () => {
    const dir = suite({
      "error.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("one", () => { expect(1).toBe(1); });',
        'queueMicrotask(() => { throw new Error("boom"); });',
        'test("two", () => { expect(2).toBe(2); });',
      ].join("\n"),
    });
    const result = run(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Unhandled error between tests");
  });

  test("an unhandled rejection between tests exits nonzero", () => {
    const dir = suite({
      "reject.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("one", () => { expect(1).toBe(1); });',
        'Promise.reject(new Error("rejected"));',
      ].join("\n"),
    });
    const result = run(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Unhandled error between tests");
  });

  test("a top-level throw fails the file and runs no tests", () => {
    const dir = suite({
      "top.test.ts": [
        'throw new Error("load failure");',
        'import { test } from "bun:test";',
        'test("never", () => {});',
      ].join("\n"),
    });
    const result = run(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("load failure");
    expect(result.output).toContain("0 pass");
  });
});

describe("globals and CLI defines", () => {
  test("test, describe, expect, jest and vi are globals; console.timeStamp exists on this pin", () => {
    const dir = suite({
      "globals.test.ts": [
        'test("globals", () => {',
        '  expect(typeof test).toBe("function");',
        '  expect(typeof describe).toBe("function");',
        '  expect(typeof expect).toBe("function");',
        '  expect(typeof jest).toBe("object");',
        '  expect(typeof vi).toBe("object");',
        '  expect(typeof console.timeStamp).toBe("function");',
        "});",
      ].join("\n"),
    });
    const result = run(dir);
    expect(result.exitCode).toBe(0);
  });

  test("--define substitutes the constant in the test file", () => {
    const dir = suite(
      assertFile('expect(process.env.API_URL).toBe("http://x");'),
    );
    const result = run(dir, ["--define", "process.env.API_URL='http://x'"]);
    expect(result.exitCode).toBe(0);
  });
});
