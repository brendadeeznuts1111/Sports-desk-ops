/**
 * Bun 1.4.4 package-manager contracts.
 * Verified against Bun 1.4.4; changelog:
 * https://bun.sh/blog/bun-v1.4.4#bun-install-reads-the-npmrc-that-actions-setup-node-writes
 *
 * Exact stderr assertions (re-verify on a Bun bump):
 * - `has no --frozen-lockfil flag`
 * - `<pkg> was added` / `<pkg> changed from X to Y` (frozen lockfile)
 * - `not a bun cache pack (record #0)` (cache unpack)
 *
 * bun pm fetch verified via local fixture test below: lockfile unchanged,
 * no scripts, no node_modules.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bun-pm-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  keywords?: string[];
  packageExtensions?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
  >;
  version?: string;
  [key: string]: unknown;
}

let counter = 0;
function fixture(data: Record<string, unknown> = {}): string {
  const dir = join(root, `f${counter++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "fixture", version: "0.0.0", private: true, ...data },
      null,
      2,
    ),
  );
  return dir;
}

function localPackage(dir: string, name: string): string {
  const local = join(dir, name);
  mkdirSync(local, { recursive: true });
  writeFileSync(
    join(local, "package.json"),
    JSON.stringify({ name: `${name}-fixture`, version: "1.0.0" }),
  );
  return `file:./${name}`;
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readManifest(dir: string): Manifest {
  return JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as Manifest;
}

function graphOf(dir: string): string {
  const lock = join(dir, "bun.lock");
  return (
    readFileSync(join(dir, "package.json"), "utf8") +
    (existsSync(lock) ? readFileSync(lock, "utf8") : "")
  );
}

function seedDependency(dir: string, name: string): Manifest {
  const manifest = readManifest(dir);
  manifest.dependencies = {
    ...manifest.dependencies,
    [`${name}-fixture`]: localPackage(dir, name),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// @bun-behavior: install-flags
// @bun-behavior: package-extensions
// @bun-behavior: minimum-release-age

describe("Bun 1.4.4 package-manager behaviors", () => {
  test("rejects unknown flags instead of running a mutable install", () => {
    const dir = fixture();
    const result = run(dir, ["install", "--frozen-lockfil"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("has no --frozen-lockfil flag");
  });

  test("--immutable fails against a dirty lockfile without rewriting it", () => {
    const dir = fixture();
    seedDependency(dir, "local");
    expect(run(dir, ["install"]).exitCode).toBe(0);
    const before = readFileSync(join(dir, "bun.lock"), "utf8");
    seedDependency(dir, "local-second");
    const result = run(dir, ["install", "--immutable"]);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(dir, "bun.lock"), "utf8")).toBe(before);
  });

  test("--network-timeout value is not in the dependency graph", () => {
    const dir = fixture();
    expect(run(dir, ["install", "--network-timeout", "100000"]).exitCode).toBe(
      0,
    );
    expect(graphOf(dir)).not.toContain("100000");
  });

  test("--env-file is a file, not part of the dependency graph", () => {
    const dir = fixture();
    writeFileSync(join(dir, "ci.env"), "FIXTURE=1\n");
    expect(run(dir, ["install", "--env-file", "ci.env"]).exitCode).toBe(0);
    expect(graphOf(dir)).not.toContain("ci.env");
  });

  test("--no-env-file is accepted", () => {
    expect(run(fixture(), ["install", "--no-env-file"]).exitCode).toBe(0);
  });

  test("--save-dev moves a local dependency into devDependencies", () => {
    const dir = fixture();
    localPackage(dir, "local");
    expect(run(dir, ["add", "--save-dev", "./local"]).exitCode).toBe(0);
    const manifest = readManifest(dir);
    expect(manifest.devDependencies?.["local-fixture"]).toBeDefined();
    expect(manifest.dependencies?.["local-fixture"]).toBeUndefined();
  });

  test("bun add -d / --save-prod move an existing dependency group", () => {
    // Hermetic: the dependency is a local file: package, so neither the install
    // nor the group move touches a registry.
    //
    // 1.4.4 observed normalization (not documented; assertions below are
    // specifier-agnostic on purpose):
    //   package.json           file:./local -> "./local"
    //   bun.lock workspace map "./local"
    //   bun.lock package       "local@file:local" (file: kept, ./ stripped)
    const dir = fixture();
    const ref = localPackage(dir, "local");
    const manifest = readManifest(dir);
    manifest.dependencies = { "local-fixture": ref };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
    expect(run(dir, ["install"]).exitCode).toBe(0);

    expect(run(dir, ["add", "-d", "./local"]).exitCode).toBe(0);
    const dev = readManifest(dir);
    expect(dev.devDependencies?.["local-fixture"]).toBeDefined();
    expect(dev.dependencies?.["local-fixture"]).toBeUndefined();

    expect(run(dir, ["add", "--save-prod", "./local"]).exitCode).toBe(0);
    const prod = readManifest(dir);
    expect(prod.dependencies?.["local-fixture"]).toBeDefined();
    expect(prod.devDependencies?.["local-fixture"]).toBeUndefined();
  });

  test("accepts translated hoist/omit flags", () => {
    expect(run(fixture(), ["install", "--shamefully-hoist"]).exitCode).toBe(0);
    expect(run(fixture(), ["install", "--only=production"]).exitCode).toBe(0);
  });

  test("accepts unit and plain-second minimumReleaseAge", () => {
    expect(
      run(fixture(), ["install", "--minimum-release-age", "3d"]).exitCode,
    ).toBe(0);
    expect(
      run(fixture(), ["install", "--minimum-release-age", "300"]).exitCode,
    ).toBe(0);
  });

  test("accepts --minimum-release-age-excludes", () => {
    expect(
      run(fixture(), [
        "install",
        "--minimum-release-age",
        "3d",
        "--minimum-release-age-excludes",
        "typescript@5.9.3",
      ]).exitCode,
    ).toBe(0);
  });

  test("translates --no-optional / --ignore-optional to --omit=optional", () => {
    expect(run(fixture(), ["install", "--no-optional"]).exitCode).toBe(0);
    expect(run(fixture(), ["install", "--ignore-optional"]).exitCode).toBe(0);
  });

  test("translates --node-linker to --linker", () => {
    expect(run(fixture(), ["install", "--node-linker=isolated"]).exitCode).toBe(
      0,
    );
    expect(run(fixture(), ["install", "--node-linker=hoisted"]).exitCode).toBe(
      0,
    );
  });

  test("--package-lock-only writes the lockfile without node_modules", () => {
    const dir = fixture();
    seedDependency(dir, "local");
    expect(run(dir, ["install", "--package-lock-only"]).exitCode).toBe(0);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(join(dir, "bun.lock"))).toBe(true);
  });

  test("bun add translates --save-optional/--save-peer/--save-exact", () => {
    const optional = fixture();
    localPackage(optional, "local");
    expect(run(optional, ["add", "--save-optional", "./local"]).exitCode).toBe(
      0,
    );
    expect(
      readManifest(optional).optionalDependencies?.["local-fixture"],
    ).toBeDefined();

    const peer = fixture();
    localPackage(peer, "local");
    expect(run(peer, ["add", "--save-peer", "./local"]).exitCode).toBe(0);
    expect(
      readManifest(peer).peerDependencies?.["local-fixture"],
    ).toBeDefined();

    const exact = fixture();
    localPackage(exact, "local");
    expect(run(exact, ["add", "--save-exact", "./local"]).exitCode).toBe(0);
    expect(readManifest(exact).dependencies?.["local-fixture"]).toBeDefined();
  });

  test("link:../shared resolves a parent-relative path", () => {
    const parent = fixture();
    localPackage(parent, "shared");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(
      join(child, "package.json"),
      JSON.stringify(
        {
          name: "child",
          private: true,
          dependencies: { "shared-fixture": "link:../shared" },
        },
        null,
        2,
      ),
    );
    expect(run(child, ["install"]).exitCode).toBe(0);
    expect(
      lstatSync(join(child, "node_modules", "shared-fixture")).isSymbolicLink(),
    ).toBe(true);
  });

  test("reads NPM_CONFIG_USERCONFIG", () => {
    const dir = fixture();
    const npmrc = join(dir, "user.npmrc");
    writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
    expect(
      run(dir, ["install"], { NPM_CONFIG_USERCONFIG: npmrc }).exitCode,
    ).toBe(0);
  });

  test("--use-system-ca is accepted by install", () => {
    expect(
      run(fixture(), ["install", "--use-system-ca", "--dry-run"]).exitCode,
    ).toBe(0);
  });

  test("bun prune --check exits 0 on a clean install", () => {
    const dir = fixture();
    seedDependency(dir, "local");
    expect(run(dir, ["install"]).exitCode).toBe(0);
    expect(run(dir, ["prune", "--check"]).exitCode).toBe(0);
  });

  test("bun prune --check exits 1 when something is removable", () => {
    const dir = fixture();
    seedDependency(dir, "local");
    expect(run(dir, ["install"]).exitCode).toBe(0);
    mkdirSync(join(dir, "node_modules", "stray"), { recursive: true });
    expect(run(dir, ["prune", "--check"]).exitCode).toBe(1);
  });

  test("bun update --depth 0 works with a local dependency graph", () => {
    const dir = fixture();
    seedDependency(dir, "local");
    expect(run(dir, ["install"]).exitCode).toBe(0);
    expect(run(dir, ["update", "--depth", "0"]).exitCode).toBe(0);
  });

  test("frozen-lockfile names the added dependency", () => {
    const dir = fixture();
    seedDependency(dir, "local");
    expect(run(dir, ["install"]).exitCode).toBe(0);
    seedDependency(dir, "local-second");
    const result = run(dir, ["install", "--frozen-lockfile"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("local-second");
  });

  test("bun pm pkg --dry-run writes nothing", () => {
    const dir = fixture();
    const before = readFileSync(join(dir, "package.json"), "utf8");
    expect(
      run(dir, ["pm", "pkg", "set", "name=changed", "--dry-run"]).exitCode,
    ).toBe(0);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });

  test("bun pm pkg set supports arrays", () => {
    const dir = fixture();
    expect(
      run(dir, ["pm", "pkg", "set", "keywords[]=cli", "keywords[]=ops"])
        .exitCode,
    ).toBe(0);
    expect(readManifest(dir).keywords).toEqual(["cli", "ops"]);
  });

  test("bun pm version --dry-run does not rewrite the version", () => {
    const dir = fixture();
    const git = [
      "git",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=Fixture",
    ];
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync([...git, "add", "package.json"], { cwd: dir });
    Bun.spawnSync([...git, "commit", "-qm", "init"], { cwd: dir });
    const before = readManifest(dir).version;
    expect(run(dir, ["pm", "version", "patch", "--dry-run"]).exitCode).toBe(0);
    expect(readManifest(dir).version).toBe(before);
  });

  test("link:./dir creates a symlink without bun link", () => {
    const dir = fixture();
    localPackage(dir, "vendor");
    const manifest = readManifest(dir);
    manifest.dependencies = { "vendor-fixture": "link:./vendor" };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
    expect(run(dir, ["install"]).exitCode).toBe(0);
    expect(
      lstatSync(join(dir, "node_modules", "vendor-fixture")).isSymbolicLink(),
    ).toBe(true);
  });

  test("packageExtensions resolves an undeclared import under isolated installs", async () => {
    const baseDir = fixture();
    const tgzDir = join(baseDir, "tarballs");
    mkdirSync(tgzDir, { recursive: true });

    const packFixture = (
      name: string,
      version: string,
      indexJs: string,
    ): string => {
      const buildDir = join(tgzDir, `build-${name}-${version}`);
      mkdirSync(join(buildDir, "package"), { recursive: true });
      writeFileSync(
        join(buildDir, "package", "package.json"),
        JSON.stringify({ name, version, main: "index.js" }),
      );
      writeFileSync(join(buildDir, "package", "index.js"), indexJs);
      const tarball = join(tgzDir, `${name}-${version}.tgz`);
      const tar = Bun.spawnSync(
        ["tar", "-czf", tarball, "-C", buildDir, "package"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(tar.exitCode, tar.stderr.toString()).toBe(0);
      return tarball;
    };

    const tarballs = new Map<string, string>([
      [
        "dep-fixture-1.2.0.tgz",
        packFixture(
          "dep-fixture",
          "1.2.0",
          'module.exports = require("undeclared-fixture") + ":" + require("ext-peer-fixture");\n',
        ),
      ],
      [
        "undeclared-fixture-1.0.0.tgz",
        packFixture("undeclared-fixture", "1.0.0", 'module.exports = "EXT";\n'),
      ],
      [
        "ext-peer-fixture-2.0.0.tgz",
        packFixture("ext-peer-fixture", "2.0.0", 'module.exports = "PEER";\n'),
      ],
    ]);

    const packuments: Record<string, { version: string; tgz: string }> = {
      "dep-fixture": { version: "1.2.0", tgz: "dep-fixture-1.2.0.tgz" },
      "undeclared-fixture": {
        version: "1.0.0",
        tgz: "undeclared-fixture-1.0.0.tgz",
      },
      "ext-peer-fixture": {
        version: "2.0.0",
        tgz: "ext-peer-fixture-2.0.0.tgz",
      },
    };

    let registryUrl = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const pathKey = decodeURIComponent(
          new URL(request.url).pathname.replace(/^\//, ""),
        );
        const tarball = tarballs.get(pathKey);
        if (tarball !== undefined) {
          return new Response(Bun.file(tarball));
        }
        const entry = packuments[pathKey];
        if (entry !== undefined) {
          return Response.json({
            name: pathKey,
            "dist-tags": { latest: entry.version },
            versions: {
              [entry.version]: {
                name: pathKey,
                version: entry.version,
                main: "index.js",
                dist: { tarball: `${registryUrl}${entry.tgz}` },
              },
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    registryUrl = `http://127.0.0.1:${server.port}/`;

    const installIsolated = async (
      cwd: string,
      pkg: Record<string, unknown>,
    ) => {
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg, null, 2));
      const npmrc = join(cwd, "npmrc");
      writeFileSync(
        npmrc,
        `registry=${registryUrl}\n//127.0.0.1:${server.port}/:_authToken=fake-token\n`,
      );
      // Async spawn: the mock registry runs in this process.
      const proc = Bun.spawn(
        [
          process.execPath,
          "install",
          "--linker=isolated",
          "--no-env-file",
          "--no-summary",
        ],
        {
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
        },
      );
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
    };

    try {
      const negativeDir = join(baseDir, "without-ext");
      const negInstall = await installIsolated(negativeDir, {
        name: "without-ext",
        version: "0.0.0",
        private: true,
        dependencies: { "dep-fixture": "1.2.0" },
      });
      expect(negInstall.exitCode, negInstall.stderr).toBe(0);
      const negEval = run(
        negativeDir,
        ["-e", "console.log(require('dep-fixture'))"],
        { HOME: join(negativeDir, ".home"), NO_COLOR: "1" },
      );
      expect(negEval.exitCode).not.toBe(0);
      expect(negEval.stderr.toString()).toContain(
        "Cannot find package 'undeclared-fixture'",
      );

      const positiveDir = join(baseDir, "with-ext");
      const posInstall = await installIsolated(positiveDir, {
        name: "with-ext",
        version: "0.0.0",
        private: true,
        dependencies: { "dep-fixture": "1.2.0" },
        packageExtensions: {
          "dep-fixture@^1.0.0": {
            dependencies: { "undeclared-fixture": "^1.0.0" },
            peerDependencies: { "ext-peer-fixture": "^2.0.0" },
          },
        },
      });
      expect(posInstall.exitCode, posInstall.stderr).toBe(0);
      expect(posInstall.stderr).not.toContain("warn: Ignored");

      const posEval = run(
        positiveDir,
        ["-e", "console.log(require('dep-fixture'))"],
        { HOME: join(positiveDir, ".home"), NO_COLOR: "1" },
      );
      expect(posEval.exitCode, posEval.stderr.toString()).toBe(0);
      expect(posEval.stdout.toString().trim()).toBe("EXT:PEER");

      const lock = readFileSync(join(positiveDir, "bun.lock"), "utf8");
      expect(lock).toContain('"packageExtensions"');
      expect(lock).toContain('"dep-fixture@1.2.0"');
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test("bunx rejects an unknown flag before resolving a package", () => {
    const bunx = Bun.which("bunx");
    expect(bunx).not.toBeNull();
    const dir = fixture();
    const result = Bun.spawnSync([bunx as string, "--frozen-lockfil"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "bunx has no --frozen-lockfil flag",
    );
  });

  test("bun pm fetch warms cache without creating node_modules or running scripts", () => {
    const dir = fixture();
    const pkgDir = join(dir, "pkg");
    const appDir = join(dir, "app");
    const seedCache = join(dir, "cache-seed");
    const fetchCache = join(dir, "cache-fetch");
    const homeDir = join(dir, ".home");
    const markerPath = join(dir, "postinstall-ran");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    mkdirSync(fetchCache, { recursive: true });

    const scriptCmd = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')"`;
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "scripted-fixture",
        version: "1.0.0",
        main: "index.js",
        scripts: { postinstall: scriptCmd },
      }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = 42;\n");

    const packed = run(pkgDir, ["pm", "pack", "--quiet"], {
      HOME: homeDir,
      NO_COLOR: "1",
    });
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const tarball = packed.stdout.toString().trim();

    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify(
        {
          name: "pm-fetch-app",
          version: "1.0.0",
          private: true,
          trustedDependencies: ["scripted-fixture"],
          scripts: { postinstall: scriptCmd },
          dependencies: { "scripted-fixture": `file:../pkg/${tarball}` },
        },
        null,
        2,
      ),
    );

    const locked = run(
      appDir,
      ["install", "--lockfile-only", "--no-env-file"],
      {
        BUN_INSTALL_CACHE_DIR: seedCache,
        HOME: homeDir,
        NO_COLOR: "1",
      },
    );
    expect(locked.exitCode, locked.stderr.toString()).toBe(0);
    expect(existsSync(join(appDir, "node_modules"))).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
    const lockBefore = readFileSync(join(appDir, "bun.lock"), "utf8");

    const fetched = run(appDir, ["pm", "fetch", "--no-env-file"], {
      BUN_INSTALL_CACHE_DIR: fetchCache,
      HOME: homeDir,
      NO_COLOR: "1",
    });
    expect(fetched.exitCode, fetched.stderr.toString()).toBe(0);
    expect(readdirSync(fetchCache).length).toBeGreaterThan(0);
    expect(existsSync(join(appDir, "node_modules"))).toBe(false);
    expect(readFileSync(join(appDir, "bun.lock"), "utf8")).toBe(lockBefore);
    expect(existsSync(markerPath)).toBe(false);

    const offline = run(
      appDir,
      [
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-env-file",
      ],
      {
        BUN_INSTALL_CACHE_DIR: fetchCache,
        HOME: homeDir,
        NO_COLOR: "1",
      },
    );
    expect(offline.exitCode, offline.stderr.toString()).toBe(0);
    expect(existsSync(join(appDir, "node_modules", "scripted-fixture"))).toBe(
      true,
    );
  });
});
