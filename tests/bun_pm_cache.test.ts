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
  const pkgDir = join(root, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "cache-pkg-fixture", version: "1.0.0" }, null, 2),
  );
  writeFileSync(join(pkgDir, "index.js"), "export default 1;\n");
  const packRes = Bun.spawnSync([process.execPath, "pm", "pack", "--quiet"], {
    cwd: pkgDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const tgzName = packRes.stdout.toString().trim();

  const dir = join(root, "fixture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "cache-fixture",
        private: true,
        dependencies: { "cache-pkg-fixture": `file:../pkg/${tgzName}` },
      },
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

  test("unpack is additive and preserves existing cache entries", () => {
    const root = mkdtempSync(join(tmpdir(), "bun-pm-cache-additive-"));
    roots.push(root);
    const cacheA = join(root, "cache-a");
    const cacheB = join(root, "cache-b");
    const baseEnv = {
      ...process.env,
      XDG_CACHE_HOME: join(root, "xdg"),
      HOME: join(root, "home"),
      BUN_INSTALL: join(root, "bun"),
      NO_COLOR: "1",
    };

    const makePacked = (pkgName: string): string => {
      const pkgDir = join(root, "pkgs", pkgName);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify(
          { name: pkgName, version: "1.0.0", main: "index.js" },
          null,
          2,
        ),
      );
      writeFileSync(
        join(pkgDir, "index.js"),
        `module.exports = ${JSON.stringify(pkgName)};\n`,
      );
      const packRes = Bun.spawnSync(
        [process.execPath, "pm", "pack", "--quiet"],
        { cwd: pkgDir, env: baseEnv, stdout: "pipe", stderr: "pipe" },
      );
      expect(packRes.exitCode, packRes.stderr.toString()).toBe(0);
      return `file:../../pkgs/${pkgName}/${packRes.stdout.toString().trim()}`;
    };

    const specA = makePacked("pkg-a-fixture");
    const specB = makePacked("pkg-b-fixture");

    const appA = join(root, "apps", "app-a");
    const appB = join(root, "apps", "app-b");
    mkdirSync(appA, { recursive: true });
    mkdirSync(appB, { recursive: true });
    writeFileSync(
      join(appA, "package.json"),
      JSON.stringify(
        {
          name: "app-a",
          private: true,
          dependencies: { "pkg-a-fixture": specA },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(appB, "package.json"),
      JSON.stringify(
        {
          name: "app-b",
          private: true,
          dependencies: { "pkg-b-fixture": specB },
        },
        null,
        2,
      ),
    );

    const runWithCache = (cwd: string, args: string[], cacheDir: string) =>
      Bun.spawnSync([process.execPath, ...args], {
        cwd,
        env: { ...baseEnv, BUN_INSTALL_CACHE_DIR: cacheDir },
        stdout: "pipe",
        stderr: "pipe",
      });

    const installA = runWithCache(
      appA,
      ["install", "--no-env-file", "--no-summary"],
      cacheA,
    );
    expect(installA.exitCode, installA.stderr.toString()).toBe(0);
    const installB = runWithCache(
      appB,
      ["install", "--no-env-file", "--no-summary"],
      cacheB,
    );
    expect(installB.exitCode, installB.stderr.toString()).toBe(0);

    const packB = join(root, "b.pack");
    const packed = runWithCache(appB, ["pm", "cache", "pack", packB], cacheB);
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);

    const entriesBefore = readdirSync(cacheA);
    expect(entriesBefore.length).toBeGreaterThan(0);

    const unpacked = runWithCache(
      appA,
      ["pm", "cache", "unpack", packB],
      cacheA,
    );
    expect(unpacked.exitCode, unpacked.stderr.toString()).toBe(0);

    const entriesAfter = readdirSync(cacheA);
    for (const entry of entriesBefore) {
      expect(entriesAfter).toContain(entry);
    }
    expect(entriesAfter.length).toBeGreaterThan(entriesBefore.length);

    rmSync(join(appA, "node_modules"), { recursive: true, force: true });
    rmSync(join(appB, "node_modules"), { recursive: true, force: true });

    const offlineA = runWithCache(
      appA,
      ["install", "--offline", "--frozen-lockfile", "--no-env-file"],
      cacheA,
    );
    expect(offlineA.exitCode, offlineA.stderr.toString()).toBe(0);
    expect(existsSync(join(appA, "node_modules", "pkg-a-fixture"))).toBe(true);

    const offlineB = runWithCache(
      appB,
      ["install", "--offline", "--frozen-lockfile", "--no-env-file"],
      cacheA,
    );
    expect(offlineB.exitCode, offlineB.stderr.toString()).toBe(0);
    expect(existsSync(join(appB, "node_modules", "pkg-b-fixture"))).toBe(true);
  });
});
