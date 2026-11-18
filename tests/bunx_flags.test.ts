/**
 * @file tests/bunx_flags.test.ts
 * @description `bunx --cwd` and `bunx --env-file` reach the executed tool.
 *
 * Re-measures the 1.4.4 release note ("--env-file for the package manager, and new bunx flags").
 * The fixture provides its own `node_modules/.bin` shim, so the test never resolves from the
 * network.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: bunx-cwd-env-file

interface Fixture {
  readonly bunx: string;
  readonly dir: string;
  readonly outside: string;
  readonly envFile: string;
}

function fixture(): Fixture {
  const bunx = Bun.which("bunx");
  if (bunx === null) throw new Error("bunx not found");
  const dir = mkdtempSync(join(tmpdir(), "bunx-flags-"));
  const outside = mkdtempSync(join(tmpdir(), "bunx-outside-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const cli = join(dir, "bin", "probe-cli.ts");
  writeFileSync(
    cli,
    "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ cwd: process.cwd(), token: process.env.PROBE_TOKEN ?? null }));\n",
  );
  chmodSync(cli, 0o755);
  symlinkSync(
    join("..", "..", "bin", "probe-cli.ts"),
    join(dir, "node_modules", ".bin", "probe-cli"),
  );
  const envFile = join(dir, "ci.env");
  writeFileSync(envFile, "PROBE_TOKEN=abc123\n");
  return { bunx, dir, outside, envFile };
}

function run(f: Fixture, args: readonly string[]) {
  return Bun.spawnSync([f.bunx, ...args], {
    cwd: f.outside,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function cleanup(f: Fixture): void {
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(f.outside, { recursive: true, force: true });
}

describe("bunx --cwd", () => {
  test("runs the tool in the given directory", () => {
    const f = fixture();
    try {
      const result = run(f, ["--cwd", f.dir, "probe-cli"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout.toString()) as {
        cwd: string;
      };
      expect(realpathSync(payload.cwd)).toBe(realpathSync(f.dir));
    } finally {
      cleanup(f);
    }
  }, 30_000);
});

describe("bunx --env-file", () => {
  test("loads the file into the tool environment", () => {
    const f = fixture();
    try {
      const result = run(f, [
        "--cwd",
        f.dir,
        "--env-file",
        f.envFile,
        "probe-cli",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout.toString()) as {
        token: string | null;
      };
      expect(payload.token).toBe("abc123");
    } finally {
      cleanup(f);
    }
  }, 30_000);
});
