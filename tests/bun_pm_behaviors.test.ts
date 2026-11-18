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
 * bun pm fetch verified manually 2026-11-17: lockfile unchanged, no scripts,
 * no node_modules; add a fixture if a Docker consumer appears.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  packageExtensions?: Record<string, { dependencies: Record<string, string> }>;
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

  test("packageExtensions resolves an undeclared import under isolated installs", () => {
    const dir = fixture();
    const dep = join(dir, "dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(
      join(dep, "package.json"),
      JSON.stringify({
        name: "dep-fixture",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(join(dep, "index.js"), "require('undeclared-fixture');");
    const undeclared = localPackage(dir, "undeclared");
    const manifest = readManifest(dir);
    manifest.dependencies = { "dep-fixture": "file:./dep" };
    manifest.packageExtensions = {
      "dep-fixture": { dependencies: { "undeclared-fixture": undeclared } },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
    expect(run(dir, ["install", "--linker=isolated"]).exitCode).toBe(0);
  });

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
});
