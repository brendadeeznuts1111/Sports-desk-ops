/**
 * @file tests/bun_test_config.test.ts
 * @description Measured `[test]` bunfig.toml options on the pinned runtime.
 *
 * Each case writes a throwaway project with its own bunfig.toml and spawns `bun test` there, so
 * the assertions cover discovery, preloads, ignore patterns, retry/repeat defaults, randomized
 * order with a seed, the JUnit reporter path, and `.env.test` loading. CLI overrides are measured
 * where the docs claim they replace (not merge with) the config value.
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

// @bun-behavior: bun-test-config

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>, bunfig?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-test-config-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (bunfig !== undefined) {
    writeFileSync(join(dir, "bunfig.toml"), bunfig);
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

function logLine(name: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    'import { test } from "bun:test";',
    `appendFileSync(process.env.RUN_LOG as string, "${name}\\n");`,
    `test("${name}", () => {});`,
  ].join("\n");
}

function lines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

describe("test discovery", () => {
  test("root limits scanning to the configured directory", () => {
    const log = join(mkdtempSync(join(tmpdir(), "bun-test-log-")), "root.log");
    const dir = project(
      {
        "src/in.test.ts": logLine("in"),
        "out.test.ts": logLine("out"),
      },
      '[test]\nroot = "src"\n',
    );
    const result = run(dir, [], { RUN_LOG: log });
    expect(result.exitCode).toBe(0);
    expect(lines(log)).toEqual(["in"]);
  });

  test("preload runs before the test file", () => {
    const log = join(
      mkdtempSync(join(tmpdir(), "bun-test-log-")),
      "preload.log",
    );
    const dir = project(
      {
        "preload.ts": [
          'import { appendFileSync } from "node:fs";',
          'appendFileSync(process.env.RUN_LOG as string, "preload\\n");',
          'process.env.PRELOADED = "1";',
        ].join("\n"),
        "test/preloaded.test.ts": [
          'import { expect, test } from "bun:test";',
          'test("sees preload", () => {',
          '  expect(process.env.PRELOADED).toBe("1");',
          "});",
        ].join("\n"),
      },
      '[test]\npreload = ["./preload.ts"]\n',
    );
    const result = run(dir, [], { RUN_LOG: log });
    expect(result.exitCode).toBe(0);
    expect(lines(log)).toEqual(["preload"]);
  });

  test("pathIgnorePatterns prunes matching files, and the CLI replaces the list", () => {
    const log = join(
      mkdtempSync(join(tmpdir(), "bun-test-log-")),
      "ignored.log",
    );
    const dir = project(
      {
        "ignored/ignored.test.ts": logLine("ignored"),
        "kept/kept.test.ts": logLine("kept"),
      },
      '[test]\npathIgnorePatterns = ["ignored/**"]\n',
    );
    const config = run(dir, [], { RUN_LOG: log });
    expect(config.exitCode).toBe(0);
    expect(lines(log)).toEqual(["kept"]);

    const cliLog = join(dir, "cli.log");
    const cli = run(dir, ["--path-ignore-patterns", "kept/**"], {
      RUN_LOG: cliLog,
    });
    expect(cli.exitCode).toBe(0);
    expect(lines(cliLog)).toEqual(["ignored"]);
  });
});

describe("test execution defaults", () => {
  test("retry in bunfig.toml retries a flaky test; --retry=0 does not disable it", () => {
    const dir = project(
      {
        "flaky.test.ts": [
          'import { expect, test } from "bun:test";',
          'import { existsSync, writeFileSync } from "node:fs";',
          'test("flaky", () => {',
          "  const marker = process.env.RETRY_MARKER as string;",
          "  if (!existsSync(marker)) {",
          '    writeFileSync(marker, "1");',
          '    throw new Error("first attempt");',
          "  }",
          "  expect(1).toBe(1);",
          "});",
        ].join("\n"),
      },
      "[test]\nretry = 1\n",
    );
    const passed = run(dir, [], { RETRY_MARKER: join(dir, "pass-marker") });
    expect(passed.exitCode).toBe(0);
    expect(passed.output).toContain("attempt 2");

    // Measured nuance: --retry=0 does not turn the bunfig retry off on 1.4.4.
    const zero = run(dir, ["--retry=0"], {
      RETRY_MARKER: join(dir, "zero-marker"),
    });
    expect(zero.exitCode).toBe(0);
  });

  test("rerunEach in bunfig.toml evaluates each file twice", () => {
    const log = join(mkdtempSync(join(tmpdir(), "bun-test-log-")), "rerun.log");
    const dir = project(
      {
        "rerun.test.ts": [
          'import { appendFileSync } from "node:fs";',
          'import { test } from "bun:test";',
          'appendFileSync(process.env.RUN_LOG as string, "run\\n");',
          'test("reruns", () => {});',
        ].join("\n"),
      },
      "[test]\nrerunEach = 2\n",
    );
    const result = run(dir, [], { RUN_LOG: log });
    expect(result.exitCode).toBe(0);
    expect(lines(log).length).toBe(2);
  });

  test("randomize with a seed produces the same order on a rerun", () => {
    const files = Object.fromEntries(
      ["a", "b", "c"].map((name) => [`${name}.test.ts`, logLine(name)]),
    );
    const dir = project(files, "[test]\nrandomize = true\nseed = 42\n");
    const firstLog = join(dir, "first.log");
    const secondLog = join(dir, "second.log");
    const first = run(dir, [], { RUN_LOG: firstLog });
    const second = run(dir, [], { RUN_LOG: secondLog });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(lines(secondLog)).toEqual(lines(firstLog));
  });
});

describe("reporting and environment files", () => {
  test("[test.reporter] junit writes the configured XML path", () => {
    const dir = project(
      {
        "report.test.ts":
          'import { test } from "bun:test";\ntest("reported", () => {});',
      },
      '[test.reporter]\njunit = "junit.xml"\n',
    );
    const result = run(dir);
    expect(result.exitCode).toBe(0);
    const xml = readFileSync(join(dir, "junit.xml"), "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toContain("reported");
  });

  test(".env.test is loaded automatically", () => {
    const dir = project({
      ".env.test": "TEST_ENV_VAR=from-dotenv-test\n",
      "env.test.ts": [
        'import { expect, test } from "bun:test";',
        'test("reads .env.test", () => {',
        '  expect(process.env.TEST_ENV_VAR).toBe("from-dotenv-test");',
        "});",
      ].join("\n"),
    });
    const result = run(dir);
    expect(result.exitCode).toBe(0);
  });
});

describe("runtime, env, and newer [test] bunfig options", () => {
  test("[console].depth in bunfig.toml wins over --console-depth", () => {
    const dir = project(
      {
        "show.ts": "console.log({ a: { b: { c: { d: 1 } } } });\n",
      },
      "[console]\ndepth = 4\n",
    );
    const res = Bun.spawnSync(
      [process.execPath, "--console-depth=1", "run", "show.ts"],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    expect(res.exitCode, res.stderr.toString()).toBe(0);
    expect(res.stdout.toString()).toContain("d: 1");
  });

  test("env = false and [env] file = false suppress automatic .env loading", () => {
    for (const bunfig of ["env = false\n", "[env]\nfile = false\n"]) {
      const dir = project(
        {
          ".env": "BUNFIG_ENV_PROBE=from-dotenv\n",
        },
        bunfig,
      );
      const env: Record<string, string | undefined> = {
        ...process.env,
        NO_COLOR: "1",
      };
      delete env.BUNFIG_ENV_PROBE;
      const res = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'console.log(process.env.BUNFIG_ENV_PROBE ?? "unset")',
        ],
        {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
          env,
        },
      );
      expect(res.exitCode, res.stderr.toString()).toBe(0);
      expect(res.stdout.toString().trim()).toBe("unset");
    }
  });

  test("[test] onlyFailures = true suppresses passing test lines", () => {
    const dir = project(
      {
        "only.test.ts": [
          'import { expect, test } from "bun:test";',
          'test("alpha", () => { expect(1).toBe(1); });',
          'test("beta", () => { expect(2).toBe(2); });',
        ].join("\n"),
      },
      "[test]\nonlyFailures = true\n",
    );
    const res = run(dir, ["./only.test.ts"]);
    expect(res.exitCode, res.output).toBe(0);
    expect(res.output).toContain("2 pass");
    expect(res.output).not.toContain("(pass) alpha");
    expect(res.output).not.toContain("(pass) beta");
  });

  test("[test] clearMocks = true is ignored on stable 1.4.4/1.4.5 and clears mock calls on canary", () => {
    const dir = project(
      {
        "clear.test.ts": [
          'import { expect, mock, test } from "bun:test";',
          "const fn = mock(() => 1);",
          'test("first", () => { fn(); expect(fn).toHaveBeenCalledTimes(1); });',
          'test("second", () => { expect(fn).toHaveBeenCalledTimes(0); });',
        ].join("\n"),
      },
      "[test]\nclearMocks = true\n",
    );
    const stableRes = run(dir, ["./clear.test.ts"]);
    expect(stableRes.exitCode).not.toBe(0);
    expect(stableRes.output).toContain("Received number of calls: 1");

    const canaryBin = resolveNativeBunLintBin();
    if (canaryBin !== null) {
      const canaryProc = Bun.spawnSync([canaryBin, "test", "./clear.test.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const canaryOut =
        canaryProc.stdout.toString() + canaryProc.stderr.toString();
      expect(canaryProc.exitCode, canaryOut).toBe(0);
      expect(canaryOut).toContain("2 pass");
    }
  });
});
