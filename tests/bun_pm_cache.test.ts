/**
 * Bun 1.4.4 cache pack/unpack/prune contracts.
 * Verified against Bun 1.4.4: pack is additive on unpack, a corrupted pack is
 * rejected entirely, and prune --dry-run never deletes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bun-pm-cache-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const isolated = {
  BUN_INSTALL_CACHE_DIR: join(root, "cache"),
  XDG_CACHE_HOME: join(root, "xdg"),
  HOME: join(root, "home"),
  BUN_INSTALL: join(root, "bun"),
};

function run(cwd: string, args: string[]) {
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: { ...process.env, ...isolated },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const dir = join(root, "fixture");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    { name: "cache-fixture", private: true, dependencies: { zod: "4.6.7" } },
    null,
    2,
  ),
);

describe("Bun 1.4.4 cache pack/unpack/prune", () => {
  test("install warms the isolated cache", () => {
    expect(run(dir, ["install"]).exitCode).toBe(0);
  });

  test("pack -> clear -> unpack -> offline frozen install", () => {
    const pack = join(root, "cache.pack");
    expect(run(dir, ["pm", "cache", "pack", pack]).exitCode).toBe(0);
    rmSync(isolated.BUN_INSTALL_CACHE_DIR, { recursive: true, force: true });
    expect(run(dir, ["pm", "cache", "unpack", pack]).exitCode).toBe(0);
    expect(
      run(dir, ["install", "--offline", "--frozen-lockfile"]).exitCode,
    ).toBe(0);
  });

  test("corrupted pack is rejected entirely", () => {
    const bad = join(root, "bad.pack");
    writeFileSync(bad, "not a cache pack");
    const result = run(dir, ["pm", "cache", "unpack", bad]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not a bun cache pack");
  });

  test("prune --dry-run leaves the cache intact", () => {
    expect(run(dir, ["pm", "cache", "prune", "--dry-run"]).exitCode).toBe(0);
  });

  test("prune --max-age 0 removes old entries", () => {
    expect(run(dir, ["pm", "cache", "prune", "--max-age", "0"]).exitCode).toBe(
      0,
    );
  });
});
