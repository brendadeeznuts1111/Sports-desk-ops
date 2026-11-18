/**
 * @file tests/bun_fmt_contract.test.ts
 * @description `bun fmt` check/edit contract on the pinned runtime.
 *
 * Re-measures the table in `docs/bun-upstream-reference.md` ("`bun fmt` — check/edit contract"):
 * `--check` exits 1 for an unformatted file, `bun fmt` rewrites it, and the second `--check`
 * exits 0. A temp directory keeps the repo's own Prettier/oxfmt config out of the probe.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runFmt(cwd: string, args: readonly string[]) {
  return Bun.spawnSync([process.execPath, "fmt", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

// @bun-behavior: bun-fmt

describe("bun fmt check/edit contract", () => {
  test("--check fails on an unformatted file and passes after the write", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-fmt-"));
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "const x=1\n");

      expect(runFmt(dir, ["--check", "a.ts"]).exitCode).toBe(1);

      expect(runFmt(dir, ["a.ts"]).exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toContain("const x = 1;");

      expect(runFmt(dir, ["--check", "a.ts"]).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
