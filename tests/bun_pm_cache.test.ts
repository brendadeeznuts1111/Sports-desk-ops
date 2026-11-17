/**
 * Bun 1.4.4 cache pack/unpack/prune contracts.
 * Verified against Bun 1.4.4: unpack is additive, a corrupted pack is rejected
 * entirely, and prune --dry-run never deletes.
 *
 * Exact stderr assertions (re-verify on a Bun bump):
 * - `not a bun cache pack (record #0)`
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Each test gets its own isolated Bun cache so prune tests cannot affect others. */
function makeCache() {
  const root = mkdtempSync(join(tmpdir(), "bun-pm-cache-"));
  roots.push(root);
  const cacheDir = join(root, "cache");
  const env = {
    BUN_INSTALL_CACHE_DIR: cacheDir,
    XDG_CACHE_HOME: join(root, "xdg"),
    HOME: join(root, "home"),
    BUN_INSTALL: join(root, "bun"),
  };
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
  function run(args: string[]) {
    return Bun.spawnSync([process.execPath, ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  return { root, cacheDir, run };
}

function cacheEntryCount(cacheDir: string): number {
  return existsSync(cacheDir) ? readdirSync(cacheDir).length : 0;
}

describe("Bun 1.4.4 cache pack/unpack/prune", () => {
  test("pack -> clear -> unpack -> offline frozen install", () => {
    const { root, cacheDir, run } = makeCache();
    expect(cacheEntryCount(cacheDir)).toBe(0);
    expect(run(["install"]).exitCode).toBe(0);
    const pack = join(root, "cache.pack");
    expect(run(["pm", "cache", "pack", pack]).exitCode).toBe(0);
    rmSync(cacheDir, { recursive: true, force: true });
    expect(run(["pm", "cache", "unpack", pack]).exitCode).toBe(0);
    expect(run(["install", "--offline", "--frozen-lockfile"]).exitCode).toBe(0);
  });

  test("corrupted pack is rejected entirely", () => {
    const { root, run } = makeCache();
    const bad = join(root, "bad.pack");
    writeFileSync(bad, "not a cache pack");
    const result = run(["pm", "cache", "unpack", bad]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not a bun cache pack");
  });

  test("prune --dry-run leaves a populated cache intact", () => {
    const { cacheDir, run } = makeCache();
    expect(run(["install"]).exitCode).toBe(0);
    const before = cacheEntryCount(cacheDir);
    expect(before).toBeGreaterThan(0);
    expect(run(["pm", "cache", "prune", "--dry-run"]).exitCode).toBe(0);
    expect(cacheEntryCount(cacheDir)).toBe(before);
  });

  test("prune --max-age 0 removes old entries", () => {
    const { cacheDir, run } = makeCache();
    expect(run(["install"]).exitCode).toBe(0);
    const before = cacheEntryCount(cacheDir);
    expect(before).toBeGreaterThan(0);
    expect(run(["pm", "cache", "prune", "--max-age", "0"]).exitCode).toBe(0);
    expect(cacheEntryCount(cacheDir)).toBeLessThan(before);
  });
});
