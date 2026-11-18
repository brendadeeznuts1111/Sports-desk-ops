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

describe("bunx flags", () => {
  test("--cwd sets the tool cwd and --env-file loads its environment", () => {
    const bunx = Bun.which("bunx");
    expect(bunx).not.toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "bunx-flags-"));
    const outside = mkdtempSync(join(tmpdir(), "bunx-outside-"));
    try {
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

      const result = Bun.spawnSync(
        [bunx as string, "--cwd", dir, "--env-file", envFile, "probe-cli"],
        { cwd: outside, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout.toString()) as {
        cwd: string;
        token: string | null;
      };
      expect(realpathSync(payload.cwd)).toBe(realpathSync(dir));
      expect(payload.token).toBe("abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
