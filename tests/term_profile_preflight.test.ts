/**
 * @file tests/term_profile_preflight.test.ts
 * @description Contract tests for the term-profile preflight guard.
 *
 * Two layers:
 *   - assertSafeEnvFileArgs  — argument rules only, no filesystem.
 *   - assertSafeExecArgv     — argument rules plus path provenance (exists / not a symlink /
 *                              inside the allowed roots).
 *
 * The provenance cases use a real temp directory because a basename allowlist that never
 * touches the filesystem accepts `/tmp/attacker/r2.env`, which is the bug this layer exists
 * to prevent.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOWED_ENV_FILE_BASENAMES,
  BLEED_ERR,
  assertSafeEnvFileArgs,
  assertSafeExecArgv,
  defaultGuardRoots,
  resolveGuardRoots,
} from "../packages/sportsdesk-ops/src/lib/preflight_guard.ts";

const BLEED = BLEED_ERR;

describe("argument contract (no filesystem)", () => {
  test("accepts only r2.env and pages.env basenames", () => {
    expect(ALLOWED_ENV_FILE_BASENAMES.has("r2.env")).toBe(true);
    expect(ALLOWED_ENV_FILE_BASENAMES.has("pages.env")).toBe(true);

    expect(() =>
      assertSafeEnvFileArgs(["--no-env-file", "--env-file=r2.env"]),
    ).not.toThrow();
    expect(() =>
      assertSafeEnvFileArgs([
        "--no-env-file",
        "--env-file=./secrets/pages.env",
      ]),
    ).not.toThrow();
    expect(() =>
      assertSafeEnvFileArgs(["--no-env-file", "--env-file", "/etc/ops/r2.env"]),
    ).not.toThrow();
  });

  test("rejects non-allowlisted basenames even with --no-env-file", () => {
    for (const bad of [
      ".env",
      "prod.env",
      "r2.env.local",
      "r2.env/",
      "R2.ENV",
      "r2.env\u200b",
    ]) {
      expect(() =>
        assertSafeEnvFileArgs(["--no-env-file", `--env-file=${bad}`]),
      ).toThrow(BLEED);
    }
  });

  test("rejects bare and empty --env-file", () => {
    expect(() =>
      assertSafeEnvFileArgs(["--no-env-file", "--env-file"]),
    ).toThrow(BLEED);
    expect(() =>
      assertSafeEnvFileArgs(["--no-env-file", "--env-file="]),
    ).toThrow(BLEED);
  });

  test("rejects --env-file without --no-env-file in the same source", () => {
    expect(() => assertSafeEnvFileArgs(["--env-file=r2.env"])).toThrow(BLEED);
  });

  test("rejects two --env-file flags in the same source", () => {
    expect(() =>
      assertSafeEnvFileArgs([
        "--no-env-file",
        "--env-file=a/r2.env",
        "--env-file=b/pages.env",
      ]),
    ).toThrow(BLEED);
  });

  test("cross-source: --no-env-file in execArgv does not authorise BUN_OPTIONS", () => {
    expect(() =>
      assertSafeEnvFileArgs(["--no-env-file"], "--env-file=r2.env"),
    ).toThrow(BLEED);
  });

  test("cross-source: one per source is rejected as multi-file", () => {
    expect(() =>
      assertSafeEnvFileArgs(
        ["--no-env-file", "--env-file=a/r2.env"],
        "--no-env-file --env-file=b/pages.env",
      ),
    ).toThrow(BLEED);
  });

  test("cross-source: each source isolated, one total, is allowed", () => {
    expect(() =>
      assertSafeEnvFileArgs(
        ["--no-env-file"],
        "--no-env-file --env-file=r2.env",
      ),
    ).not.toThrow();
  });

  test("tokens after a bare -- are positional and never scanned", () => {
    expect(() =>
      assertSafeEnvFileArgs([
        "--no-env-file",
        "--",
        "--env-file=.env",
        "--env-file=prod.env",
      ]),
    ).not.toThrow();
  });
});

describe("path provenance (real filesystem)", () => {
  const root = mkdtempSync(join(tmpdir(), "pf-root-"));
  const outside = mkdtempSync(join(tmpdir(), "pf-outside-"));

  const insideEnv = join(root, "r2.env");
  writeFileSync(insideEnv, "TOKEN=ok\n");

  const outsideEnv = join(outside, "r2.env");
  writeFileSync(outsideEnv, "TOKEN=attacker\n");

  const linkEnv = join(root, "pages-link.env");
  const symlinkTarget = join(root, "pages.env");
  writeFileSync(symlinkTarget, "TOKEN=ok\n");
  symlinkSync(symlinkTarget, linkEnv);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("accepts an allowlisted file inside an allowed root", () => {
    expect(() =>
      assertSafeExecArgv(
        ["--no-env-file", `--env-file=${insideEnv}`],
        undefined,
        {
          roots: [root],
        },
      ),
    ).not.toThrow();
  });

  test("rejects an allowlisted basename from outside the allowed roots", () => {
    expect(() =>
      assertSafeExecArgv(
        ["--no-env-file", `--env-file=${outsideEnv}`],
        undefined,
        {
          roots: [root],
        },
      ),
    ).toThrow(BLEED);
  });

  test("rejects traversal that resolves outside the allowed roots", () => {
    expect(() =>
      assertSafeExecArgv(["--no-env-file", "--env-file=../r2.env"], undefined, {
        roots: [root],
      }),
    ).toThrow(BLEED);
  });

  test("rejects a symlink even when its basename is allowlisted", () => {
    expect(() =>
      assertSafeExecArgv(
        ["--no-env-file", `--env-file=${linkEnv}`],
        undefined,
        {
          roots: [root],
        },
      ),
    ).toThrow(BLEED);
  });

  test("fails closed when the env file does not exist", () => {
    expect(() =>
      assertSafeExecArgv(
        ["--no-env-file", `--env-file=${join(root, "missing", "r2.env")}`],
        undefined,
        { roots: [root] },
      ),
    ).toThrow(BLEED);
  });

  test("a disallowed basename is rejected before the filesystem is consulted", () => {
    mkdirSync(join(outside, "nested"), { recursive: true });
    writeFileSync(join(outside, "nested", "prod.env"), "TOKEN=x\n");
    expect(() =>
      assertSafeExecArgv(
        ["--no-env-file", `--env-file=${join(outside, "nested", "prod.env")}`],
        undefined,
        { roots: [outside] },
      ),
    ).toThrow(BLEED);
  });
});

describe("root resolution", () => {
  test("compiled builds root on the binary's directory, not the invocation cwd", () => {
    expect(
      resolveGuardRoots({
        isCompiled: true,
        execPath: "/opt/desk/term-profile",
        cwd: "/Users/operator/somewhere",
      }),
    ).toEqual(["/opt/desk"]);
  });

  test("under bun run the runtime path is not a config root, so cwd wins", () => {
    expect(
      resolveGuardRoots({
        isCompiled: false,
        execPath: "/Users/operator/.bun/bin/bun",
        cwd: "/work/repo",
      }),
    ).toEqual(["/work/repo"]);
  });

  test("defaultGuardRoots is cwd in a non-compiled runtime (the test runner)", () => {
    expect(defaultGuardRoots()).toEqual([process.cwd()]);
  });

  test("a compiled root outside the invocation dir still blocks a cwd-relative env file", () => {
    const binDir = mkdtempSync(join(tmpdir(), "pf-bindir-"));
    const runDir = mkdtempSync(join(tmpdir(), "pf-rundir-"));
    writeFileSync(join(runDir, "r2.env"), "TOKEN=attacker\n");
    afterAll(() => {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    });
    expect(() =>
      assertSafeExecArgv(
        ["--no-env-file", `--env-file=${join(runDir, "r2.env")}`],
        undefined,
        { roots: [binDir] },
      ),
    ).toThrow(BLEED);
  });
});
