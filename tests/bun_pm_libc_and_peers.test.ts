/**
 * @file tests/bun_pm_libc_and_peers.test.ts
 * @description Offline mock-registry contracts for Bun v1.4.4 `--libc` platform
 * filtering (plus `bun.lock` `libc` metadata) and pnpm-like peer dependency resolution.
 *
 * Uses an in-process `Bun.serve` mock registry and temporary fixtures so no public
 * registry or network access is required.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RegistryPackageSpec {
  readonly versions: Readonly<
    Record<
      string,
      {
        readonly meta: Record<string, unknown>;
        readonly indexJs: string;
      }
    >
  >;
}

const REGISTRY_PACKAGES: Readonly<Record<string, RegistryPackageSpec>> = {
  "native-host": {
    versions: {
      "1.0.0": {
        meta: {
          name: "native-host",
          version: "1.0.0",
          main: "index.js",
          optionalDependencies: {
            "native-linux-glibc": "1.0.0",
            "native-linux-musl": "1.0.0",
          },
        },
        indexJs: 'module.exports = "host";\n',
      },
    },
  },
  "native-linux-glibc": {
    versions: {
      "1.0.0": {
        meta: {
          name: "native-linux-glibc",
          version: "1.0.0",
          main: "index.js",
          os: ["linux"],
          libc: ["glibc"],
        },
        indexJs: 'module.exports = "glibc";\n',
      },
    },
  },
  "native-linux-musl": {
    versions: {
      "1.0.0": {
        meta: {
          name: "native-linux-musl",
          version: "1.0.0",
          main: "index.js",
          os: ["linux"],
          libc: ["musl"],
        },
        indexJs: 'module.exports = "musl";\n',
      },
    },
  },
  "core-peer": {
    versions: {
      "4.20.0": {
        meta: { name: "core-peer", version: "4.20.0", main: "index.js" },
        indexJs: 'module.exports = "4.20.0";\n',
      },
      "5.0.0": {
        meta: { name: "core-peer", version: "5.0.0", main: "index.js" },
        indexJs: 'module.exports = "5.0.0";\n',
      },
    },
  },
  "unrelated-v5": {
    versions: {
      "1.0.0": {
        meta: {
          name: "unrelated-v5",
          version: "1.0.0",
          main: "index.js",
          dependencies: { "core-peer": "^5.0.0" },
        },
        indexJs: 'module.exports = require("core-peer");\n',
      },
    },
  },
  "consumer-v4": {
    versions: {
      "1.0.0": {
        meta: {
          name: "consumer-v4",
          version: "1.0.0",
          main: "index.js",
          peerDependencies: { "core-peer": "^4.20.0" },
        },
        indexJs: 'module.exports = require("core-peer");\n',
      },
    },
  },
  "shared-peer": {
    versions: {
      "1.0.0": {
        meta: { name: "shared-peer", version: "1.0.0", main: "index.js" },
        indexJs: 'module.exports = "1.0.0";\n',
      },
      "2.0.0": {
        meta: { name: "shared-peer", version: "2.0.0", main: "index.js" },
        indexJs: 'module.exports = "2.0.0";\n',
      },
      "2.1.0": {
        meta: { name: "shared-peer", version: "2.1.0", main: "index.js" },
        indexJs: 'module.exports = "2.1.0";\n',
      },
      "3.0.0": {
        meta: { name: "shared-peer", version: "3.0.0", main: "index.js" },
        indexJs: 'module.exports = "3.0.0";\n',
      },
    },
  },
  "shared-a": {
    versions: {
      "1.0.0": {
        meta: {
          name: "shared-a",
          version: "1.0.0",
          main: "index.js",
          peerDependencies: { "shared-peer": ">=1.0.0 <3.0.0" },
        },
        indexJs: 'module.exports = require("shared-peer");\n',
      },
    },
  },
  "shared-b": {
    versions: {
      "1.0.0": {
        meta: {
          name: "shared-b",
          version: "1.0.0",
          main: "index.js",
          peerDependencies: { "shared-peer": "^2.0.0" },
        },
        indexJs: 'module.exports = require("shared-peer");\n',
      },
    },
  },
  "conflict-peer": {
    versions: {
      "1.0.0": {
        meta: { name: "conflict-peer", version: "1.0.0", main: "index.js" },
        indexJs: 'module.exports = "1.0.0";\n',
      },
      "2.0.0": {
        meta: { name: "conflict-peer", version: "2.0.0", main: "index.js" },
        indexJs: 'module.exports = "2.0.0";\n',
      },
    },
  },
  "conflict-a": {
    versions: {
      "1.0.0": {
        meta: {
          name: "conflict-a",
          version: "1.0.0",
          main: "index.js",
          peerDependencies: { "conflict-peer": "^1.0.0" },
        },
        indexJs: 'module.exports = require("conflict-peer");\n',
      },
    },
  },
  "conflict-b": {
    versions: {
      "1.0.0": {
        meta: {
          name: "conflict-b",
          version: "1.0.0",
          main: "index.js",
          peerDependencies: { "conflict-peer": "^2.0.0" },
        },
        indexJs: 'module.exports = require("conflict-peer");\n',
      },
    },
  },
  "ui-core": {
    versions: {
      "17.0.0": {
        meta: { name: "ui-core", version: "17.0.0", main: "index.js" },
        indexJs: 'module.exports = "17.0.0";\n',
      },
      "19.0.0": {
        meta: { name: "ui-core", version: "19.0.0", main: "index.js" },
        indexJs: 'module.exports = "19.0.0";\n',
      },
    },
  },
  "ui-dom": {
    versions: {
      "17.0.0": {
        meta: {
          name: "ui-dom",
          version: "17.0.0",
          main: "index.js",
          peerDependencies: { "ui-core": "^17.0.0" },
        },
        indexJs: 'module.exports = require("ui-core");\n',
      },
      "19.0.0": {
        meta: {
          name: "ui-dom",
          version: "19.0.0",
          main: "index.js",
          peerDependencies: { "ui-core": "^19.0.0" },
        },
        indexJs: 'module.exports = require("ui-core");\n',
      },
    },
  },
};

const tempDirs: string[] = [];
const tarballs = new Map<string, string>();
let fixturesDir = "";
let server: ReturnType<typeof Bun.serve>;
let registryUrl = "";
let fetchedTarballs: string[] = [];

function makeTarball(
  pkgJson: Record<string, unknown>,
  indexJs: string,
): string {
  const name = String(pkgJson.name);
  const version = String(pkgJson.version);
  const buildDir = join(fixturesDir, `build-${name}-${version}`);
  mkdirSync(join(buildDir, "package"), { recursive: true });
  writeFileSync(
    join(buildDir, "package", "package.json"),
    JSON.stringify(pkgJson),
  );
  writeFileSync(join(buildDir, "package", "index.js"), indexJs);
  const tarball = join(fixturesDir, `${name}-${version}.tgz`);
  const tar = Bun.spawnSync(
    ["tar", "-czf", tarball, "-C", buildDir, "package"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (tar.exitCode !== 0) {
    throw new Error(`tar failed: ${tar.stderr.toString()}`);
  }
  return tarball;
}

beforeAll(() => {
  fixturesDir = mkdtempSync(join(tmpdir(), "bun-libc-peers-reg-"));
  tempDirs.push(fixturesDir);

  for (const [name, spec] of Object.entries(REGISTRY_PACKAGES)) {
    for (const [version, entry] of Object.entries(spec.versions)) {
      tarballs.set(
        `${name}-${version}.tgz`,
        makeTarball(entry.meta, entry.indexJs),
      );
    }
  }

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      const pathKey = decodeURIComponent(url.pathname.replace(/^\//, ""));
      const tarball = tarballs.get(pathKey);
      if (tarball !== undefined) {
        fetchedTarballs.push(pathKey);
        return new Response(Bun.file(tarball));
      }
      const pkgSpec = REGISTRY_PACKAGES[pathKey];
      if (pkgSpec !== undefined) {
        const versionKeys = Object.keys(pkgSpec.versions);
        const latest = versionKeys[versionKeys.length - 1] ?? "0.0.0";
        return Response.json({
          name: pathKey,
          "dist-tags": { latest },
          versions: Object.fromEntries(
            Object.entries(pkgSpec.versions).map(([version, entry]) => [
              version,
              {
                ...entry.meta,
                dist: { tarball: `${registryUrl}${pathKey}-${version}.tgz` },
              },
            ]),
          ),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  registryUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeProject(dependencies: Record<string, string>): {
  readonly dir: string;
  readonly npmrc: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "bun-libc-peers-case-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "pm-probe-root",
      version: "0.0.0",
      private: true,
      dependencies,
    }),
  );
  const npmrc = join(dir, "npmrc");
  writeFileSync(
    npmrc,
    `registry=${registryUrl}\n//127.0.0.1:${server.port}/:_authToken=fake-token\n`,
  );
  return { dir, npmrc };
}

async function runBun(
  cwd: string,
  args: readonly string[],
  npmrc: string,
): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  // Async spawn: the mock registry runs in this process, so spawnSync would deadlock it.
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: npmrc,
      BUN_INSTALL_CACHE_DIR: join(cwd, ".cache"),
      HOME: join(cwd, ".home"),
      NO_COLOR: "1",
    },
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function evalIn(cwd: string, code: string) {
  return Bun.spawnSync([process.execPath, "-e", code], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: join(cwd, ".home"),
      NO_COLOR: "1",
    },
  });
}

function canResolveFromNativeHost(cwd: string, optionalPkg: string): boolean {
  const res = evalIn(
    cwd,
    `require.resolve(${JSON.stringify(optionalPkg)}, { paths: [require.resolve("native-host")] })`,
  );
  return res.exitCode === 0;
}

describe("bun install --libc filtering and bun.lock metadata", () => {
  test("--os=linux --libc musl downloads and links only the musl native optional package and records libc in bun.lock", async () => {
    for (const linker of ["hoisted", "isolated"] as const) {
      const { dir, npmrc } = makeProject({ "native-host": "1.0.0" });
      fetchedTarballs = [];

      const res = await runBun(
        dir,
        [
          "install",
          `--linker=${linker}`,
          "--os=linux",
          "--libc",
          "musl",
          "--no-env-file",
          "--no-summary",
        ],
        npmrc,
      );
      expect(res.exitCode, res.stderr).toBe(0);
      expect([...fetchedTarballs].sort()).toEqual([
        "native-host-1.0.0.tgz",
        "native-linux-musl-1.0.0.tgz",
      ]);
      expect(canResolveFromNativeHost(dir, "native-linux-musl")).toBe(true);
      expect(canResolveFromNativeHost(dir, "native-linux-glibc")).toBe(false);

      const lock = readFileSync(join(dir, "bun.lock"), "utf8");
      expect(lock).toContain('"libc": "musl"');
      expect(lock).toContain('"libc": "glibc"');
    }
  }, 60_000);

  test("--os=linux --libc glibc downloads and links only the glibc native optional package", async () => {
    for (const linker of ["hoisted", "isolated"] as const) {
      const { dir, npmrc } = makeProject({ "native-host": "1.0.0" });
      fetchedTarballs = [];

      const res = await runBun(
        dir,
        [
          "install",
          `--linker=${linker}`,
          "--os=linux",
          "--libc",
          "glibc",
          "--no-env-file",
          "--no-summary",
        ],
        npmrc,
      );
      expect(res.exitCode, res.stderr).toBe(0);
      expect([...fetchedTarballs].sort()).toEqual([
        "native-host-1.0.0.tgz",
        "native-linux-glibc-1.0.0.tgz",
      ]);
      expect(canResolveFromNativeHost(dir, "native-linux-glibc")).toBe(true);
      expect(canResolveFromNativeHost(dir, "native-linux-musl")).toBe(false);
    }
  }, 60_000);

  test("--os=linux --libc * downloads and links both glibc and musl optional packages", async () => {
    for (const linker of ["hoisted", "isolated"] as const) {
      const { dir, npmrc } = makeProject({ "native-host": "1.0.0" });
      fetchedTarballs = [];

      const res = await runBun(
        dir,
        [
          "install",
          `--linker=${linker}`,
          "--os=linux",
          "--libc",
          "*",
          "--no-env-file",
          "--no-summary",
        ],
        npmrc,
      );
      expect(res.exitCode, res.stderr).toBe(0);
      expect([...fetchedTarballs].sort()).toEqual([
        "native-host-1.0.0.tgz",
        "native-linux-glibc-1.0.0.tgz",
        "native-linux-musl-1.0.0.tgz",
      ]);
      expect(canResolveFromNativeHost(dir, "native-linux-glibc")).toBe(true);
      expect(canResolveFromNativeHost(dir, "native-linux-musl")).toBe(true);
    }
  }, 60_000);

  test("frozen-lockfile switches libc targets from the same bun.lock without downloading the other libc", async () => {
    const { dir, npmrc } = makeProject({ "native-host": "1.0.0" });
    const initial = await runBun(
      dir,
      [
        "install",
        "--os=linux",
        "--libc",
        "musl",
        "--no-env-file",
        "--no-summary",
      ],
      npmrc,
    );
    expect(initial.exitCode, initial.stderr).toBe(0);
    expect(existsSync(join(dir, "bun.lock"))).toBe(true);

    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    rmSync(join(dir, ".cache"), { recursive: true, force: true });
    fetchedTarballs = [];

    const frozenGlibc = await runBun(
      dir,
      [
        "install",
        "--frozen-lockfile",
        "--os=linux",
        "--libc",
        "glibc",
        "--no-env-file",
        "--no-summary",
      ],
      npmrc,
    );
    expect(frozenGlibc.exitCode, frozenGlibc.stderr).toBe(0);
    expect([...fetchedTarballs].sort()).toEqual([
      "native-host-1.0.0.tgz",
      "native-linux-glibc-1.0.0.tgz",
    ]);
    expect(canResolveFromNativeHost(dir, "native-linux-glibc")).toBe(true);
    expect(canResolveFromNativeHost(dir, "native-linux-musl")).toBe(false);
  }, 60_000);
});

describe("pnpm-like peer dependency resolution", () => {
  test("isolates peer resolution from an unrelated dependency's newer major version", async () => {
    for (const linker of ["hoisted", "isolated"] as const) {
      const { dir, npmrc } = makeProject({
        "unrelated-v5": "1.0.0",
        "consumer-v4": "1.0.0",
      });
      const res = await runBun(
        dir,
        ["install", `--linker=${linker}`, "--no-env-file", "--no-summary"],
        npmrc,
      );
      expect(res.exitCode, res.stderr).toBe(0);

      const evaluated = evalIn(
        dir,
        'console.log(JSON.stringify({ v4: require("consumer-v4"), v5: require("unrelated-v5") }))',
      );
      expect(evaluated.exitCode, evaluated.stderr.toString()).toBe(0);
      expect(evaluated.stdout.toString().trim()).toBe(
        '{"v4":"4.20.0","v5":"5.0.0"}',
      );
    }
  }, 60_000);

  test("project dependency wins even when outside a dependent's peer range and --verbose warns", async () => {
    const { dir, npmrc } = makeProject({
      "core-peer": "5.0.0",
      "consumer-v4": "1.0.0",
    });
    const res = await runBun(
      dir,
      ["install", "--verbose", "--no-env-file", "--no-summary"],
      npmrc,
    );
    expect(res.exitCode, res.stderr).toBe(0);

    const evaluated = evalIn(dir, 'console.log(require("consumer-v4"))');
    expect(evaluated.exitCode, evaluated.stderr.toString()).toBe(0);
    expect(evaluated.stdout.toString().trim()).toBe("5.0.0");

    const output = `${res.stdout}\n${res.stderr}`;
    expect(output).toContain(
      'warn: incorrect peer dependency "core-peer@5.0.0": "consumer-v4@1.0.0" requires "core-peer@^4.20.0"',
    );
  }, 60_000);

  test("multiple peer consumers share the single newest version satisfying all ranges", async () => {
    const { dir, npmrc } = makeProject({
      "shared-a": "1.0.0",
      "shared-b": "1.0.0",
    });
    const res = await runBun(
      dir,
      ["install", "--no-env-file", "--no-summary"],
      npmrc,
    );
    expect(res.exitCode, res.stderr).toBe(0);

    const lock = readFileSync(join(dir, "bun.lock"), "utf8");
    expect(lock).toContain('"shared-peer@2.1.0"');
    expect(lock.match(/"shared-peer@/g)?.length).toBe(1);
  }, 60_000);

  test("conflicting peer ranges share a single peer copy rather than duplicating", async () => {
    const { dir, npmrc } = makeProject({
      "conflict-a": "1.0.0",
      "conflict-b": "1.0.0",
    });
    const res = await runBun(
      dir,
      ["install", "--linker=isolated", "--no-env-file", "--no-summary"],
      npmrc,
    );
    expect(res.exitCode, res.stderr).toBe(0);

    const evaluated = evalIn(
      dir,
      'console.log(JSON.stringify({ a: require("conflict-a"), b: require("conflict-b") }))',
    );
    expect(evaluated.exitCode, evaluated.stderr.toString()).toBe(0);
    const parsed = JSON.parse(evaluated.stdout.toString().trim()) as {
      a: string;
      b: string;
    };
    expect(parsed.a).toBe(parsed.b);
    expect(["1.0.0", "2.0.0"]).toContain(parsed.a);

    const lock = readFileSync(join(dir, "bun.lock"), "utf8");
    expect(lock.match(/"conflict-peer@/g)?.length).toBe(1);
  }, 60_000);

  test("bun update --latest updates a peer-only dependency in a single pass", async () => {
    const { dir, npmrc } = makeProject({
      "ui-dom": "17.0.0",
    });
    const initial = await runBun(
      dir,
      ["install", "--no-env-file", "--no-summary"],
      npmrc,
    );
    expect(initial.exitCode, initial.stderr).toBe(0);
    expect(readFileSync(join(dir, "bun.lock"), "utf8")).toContain(
      '"ui-core@17.0.0"',
    );

    const updated = await runBun(
      dir,
      ["update", "--latest", "--no-env-file", "--no-summary"],
      npmrc,
    );
    expect(updated.exitCode, updated.stderr).toBe(0);

    const lockAfter = readFileSync(join(dir, "bun.lock"), "utf8");
    expect(lockAfter).toContain('"ui-dom@19.0.0"');
    expect(lockAfter).toContain('"ui-core@19.0.0"');
    expect(lockAfter).not.toContain('"ui-core@17.0.0"');
  }, 60_000);
});
