import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Bun 1.4.4 package-manager **setup** contracts: what a CI job is allowed to assume before the
 * first build step.
 *
 * Everything runs in a throwaway root with `BUN_INSTALL_CACHE_DIR` per case, so the operator's
 * global store and this checkout are never touched. Dependencies are local (`file:` tarball and
 * `link:` directory), so no case reaches the registry.
 *
 * The cache cases are only meaningful against a *populated* cache: a `link:`-only project would
 * make `bun pm fetch`, `pack` and `prune` pass on an empty directory. `makePackedFixture()` builds
 * a real tarball so every assertion has something to measure.
 */

const BUN_BIN = Bun.which("bun") ?? process.execPath;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBun(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  const proc = Bun.spawnSync([BUN_BIN, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

async function cacheEntries(cacheDir: string): Promise<string[]> {
  return readdir(cacheDir).catch(() => [] as string[]);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch(() => false);
}

describe("Bun 1.4.4 package manager setup contracts", () => {
  let rootDir: string;
  let projectDir: string;
  let cacheA: string;
  let cacheB: string;
  let packFile: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "bun-pm-setup-"));
    projectDir = join(rootDir, "app");
    cacheA = join(rootDir, "cache-a");
    cacheB = join(rootDir, "cache-b");
    packFile = join(rootDir, ".ci", "bun-cache.pack");

    // A real package to pack, with a bin so `bunx` has something local to run.
    const packageDir = join(rootDir, "packed-pkg");
    await mkdir(packageDir, { recursive: true });
    await Bun.write(
      join(packageDir, "package.json"),
      JSON.stringify(
        {
          name: "cache-pkg-fixture",
          version: "1.0.0",
          main: "index.js",
          bin: { "desk-enam": "./cli.js" },
        },
        null,
        2,
      ) + "\n",
    );
    await Bun.write(join(packageDir, "index.js"), "export default 1;\n");
    await Bun.write(
      join(packageDir, "cli.js"),
      '#!/usr/bin/env bun\nconsole.log(process.env.PROFILE_DESK_ENAM_01_COLOR_HEX ?? "unset");\n',
    );
    const packed = runBun(["pm", "pack", "--quiet"], packageDir);
    expect(packed.exitCode, packed.stderr).toBe(0);
    const tarball = packed.stdout.trim();

    await mkdir(join(projectDir, "vendor", "design-tokens"), {
      recursive: true,
    });
    await mkdir(join(rootDir, ".ci"), { recursive: true });
    await mkdir(cacheA, { recursive: true });

    // `link:` directory — must resolve as a symlink without `bun link`.
    await Bun.write(
      join(projectDir, "vendor", "design-tokens", "package.json"),
      JSON.stringify(
        { name: "design-tokens", version: "1.0.0", main: "index.ts" },
        null,
        2,
      ),
    );
    await Bun.write(
      join(projectDir, "vendor", "design-tokens", "index.ts"),
      `export const ACCENT_HEX = "#38bdf8";\n`,
    );

    await Bun.write(
      join(projectDir, "package.json"),
      JSON.stringify(
        {
          name: "pm-setup-fixture",
          version: "1.0.0",
          private: true,
          dependencies: {
            "cache-pkg-fixture": `file:../packed-pkg/${tarball}`,
            "design-tokens": "link:./vendor/design-tokens",
          },
        },
        null,
        2,
      ) + "\n",
    );

    await Bun.write(
      join(projectDir, "bunfig.toml"),
      [
        `[install]`,
        `minimumReleaseAge = "3d"`,
        `minimumReleaseAgeExcludes = ["@types/bun", "typescript@5.9.3"]`,
        ``,
      ].join("\n"),
    );

    // Lock only: no node_modules yet, and the resolution warms `cache-a`.
    const lock = runBun(["install", "--lockfile-only"], projectDir, {
      BUN_INSTALL_CACHE_DIR: cacheA,
    });
    expect(lock.exitCode, lock.stderr).toBe(0);
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("bun pm fetch fills an empty cache without node_modules or a lockfile rewrite", async () => {
    const lockBefore = await Bun.file(join(projectDir, "bun.lock")).text();
    expect(await cacheEntries(cacheB)).toEqual([]);
    expect(await exists(join(projectDir, "node_modules"))).toBe(false);

    const res = runBun(["pm", "fetch"], projectDir, {
      BUN_INSTALL_CACHE_DIR: cacheB,
    });
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toContain("Fetched");

    // The cache is the only thing that grew.
    expect((await cacheEntries(cacheB)).length).toBeGreaterThan(0);
    expect(await exists(join(projectDir, "node_modules"))).toBe(false);
    expect(await Bun.file(join(projectDir, "bun.lock")).text()).toBe(
      lockBefore,
    );
  });

  test("link:./dir populates a relative symlink without running bun link", async () => {
    const install = runBun(["install", "--frozen-lockfile"], projectDir, {
      BUN_INSTALL_CACHE_DIR: cacheB,
    });
    expect(install.exitCode, install.stderr).toBe(0);

    const link = join(projectDir, "node_modules", "design-tokens");
    expect(await exists(link)).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // It points at the relative source directory, not at a registry tarball copy.
    expect((await readlink(link)).replaceAll("\\", "/")).toMatch(
      /vendor\/design-tokens$/,
    );
  });

  test("pack -> wipe -> unpack -> offline frozen-lockfile install", async () => {
    // The cache is populated by the previous case; packing an empty one would prove nothing.
    expect((await cacheEntries(cacheB)).length).toBeGreaterThan(0);

    const packed = runBun(["pm", "cache", "pack", packFile], projectDir, {
      BUN_INSTALL_CACHE_DIR: cacheB,
    });
    expect(packed.exitCode, packed.stderr).toBe(0);
    expect(await exists(packFile)).toBe(true);

    const freshCache = join(rootDir, "cache-runner-2");
    await mkdir(freshCache, { recursive: true });
    expect(await cacheEntries(freshCache)).toEqual([]);

    const unpacked = runBun(["pm", "cache", "unpack", packFile], projectDir, {
      BUN_INSTALL_CACHE_DIR: freshCache,
    });
    expect(unpacked.exitCode, unpacked.stderr).toBe(0);
    expect((await cacheEntries(freshCache)).length).toBeGreaterThan(0);

    await rm(join(projectDir, "node_modules"), {
      recursive: true,
      force: true,
    });
    const offline = runBun(
      ["install", "--offline", "--frozen-lockfile"],
      projectDir,
      { BUN_INSTALL_CACHE_DIR: freshCache },
    );
    expect(offline.exitCode, offline.stderr).toBe(0);
    expect(
      await exists(join(projectDir, "node_modules", "cache-pkg-fixture")),
    ).toBe(true);
  });

  test("bun pm cache prune --dry-run leaves a populated cache intact", async () => {
    const cache = join(rootDir, "cache-runner-2");
    const before = await cacheEntries(cache);
    expect(before.length).toBeGreaterThan(0);

    const res = runBun(
      ["pm", "cache", "prune", "--max-age", "7", "--dry-run"],
      projectDir,
      { BUN_INSTALL_CACHE_DIR: cache },
    );
    expect(res.exitCode, res.stderr).toBe(0);
    expect((await cacheEntries(cache)).sort()).toEqual(before.sort());
  });

  test("bun install rejects a typo'd flag instead of silently installing", () => {
    const res = runBun(["install", "--frozen-lockfil"], projectDir, {
      BUN_INSTALL_CACHE_DIR: cacheA,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("--frozen-lockfil");
  });

  test("bunx honours --env-file and --cwd", async () => {
    const envPath = join(rootDir, "ci.env");
    await Bun.write(envPath, `PROFILE_DESK_ENAM_01_COLOR_HEX="#38bdf8"\n`);

    // Run from the root and point --cwd at the project, so the assertion proves --cwd works
    // rather than merely inheriting the spawn directory.
    const res = runBun(
      ["x", "--env-file", envPath, "--cwd", projectDir, "desk-enam"],
      rootDir,
      { BUN_INSTALL_CACHE_DIR: cacheB },
    );
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe("#38bdf8");
  });
});
