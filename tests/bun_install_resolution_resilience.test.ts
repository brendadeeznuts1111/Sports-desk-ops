/**
 * @file tests/bun_install_resolution_resilience.test.ts
 * @description Contract for Bun v1.4.4 `bun install` version-selection edge cases
 * (`npm-pick-manifest` divergences: missing `latest` tag and `^1.0.0-a.0`) and
 * mutated binary `bun.lockb` crash/hang resilience.
 *
 * Uses an in-process `Bun.serve` mock registry and temporary fixtures so no public
 * registry or network access is ever required.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: install-resolution-and-lockb

interface PackumentSpec {
  readonly distTags: Record<string, string>;
  readonly versions: readonly string[];
}

const PACKUMENTS: Readonly<Record<string, PackumentSpec>> = {
  "missing-latest-pkg": {
    distTags: { latest: "9.9.9" },
    versions: ["1.0.0", "1.0.1"],
  },
  "baseline-a0-pkg": {
    distTags: { latest: "1.0.0" },
    versions: ["1.0.0-a.0", "1.0.0", "1.0.1"],
  },
  "pre-only-a0-pkg": {
    distTags: { latest: "1.0.0-a.1" },
    versions: ["1.0.0-a.0", "1.0.0-a.1", "1.0.0-b.0"],
  },
  "exact-lower-a0-pkg": {
    distTags: { latest: "1.0.0-a.0" },
    versions: ["1.0.0-a.0", "1.0.0-a.1", "1.0.0", "1.0.1"],
  },
  "tuple-excluded-a0-pkg": {
    distTags: { latest: "2.0.0" },
    versions: ["1.0.1-a.0", "2.0.0"],
  },
};

const tempDirs: string[] = [];
const tarballs = new Map<string, string>();
let fixturesDir = "";
let server: ReturnType<typeof Bun.serve>;
let registryUrl = "";

function makeTarball(name: string, version: string): string {
  const buildDir = join(fixturesDir, `build-${name}-${version}`);
  mkdirSync(join(buildDir, "package"), { recursive: true });
  writeFileSync(
    join(buildDir, "package", "package.json"),
    JSON.stringify({ name, version }),
  );
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

function renderPackument(
  name: string,
  spec: PackumentSpec,
  baseUrl: string,
): Record<string, unknown> {
  return {
    name,
    "dist-tags": spec.distTags,
    versions: Object.fromEntries(
      spec.versions.map((version) => [
        version,
        {
          name,
          version,
          dist: { tarball: `${baseUrl}${name}-${version}.tgz` },
        },
      ]),
    ),
  };
}

beforeAll(() => {
  fixturesDir = mkdtempSync(join(tmpdir(), "bun-install-resilience-"));
  tempDirs.push(fixturesDir);

  for (const [name, spec] of Object.entries(PACKUMENTS)) {
    for (const version of spec.versions) {
      tarballs.set(`${name}-${version}.tgz`, makeTarball(name, version));
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
        return new Response(Bun.file(tarball));
      }
      const spec = PACKUMENTS[pathKey];
      if (spec !== undefined) {
        return Response.json(renderPackument(pathKey, spec, registryUrl));
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

async function installFromMockRegistry(
  pkgName: string,
  specifier: string,
): Promise<{
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly installedVersion: string | null;
}> {
  const dir = mkdtempSync(join(tmpdir(), "bun-install-case-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "install-probe-root",
      version: "0.0.0",
      private: true,
      dependencies: { [pkgName]: specifier },
    }),
  );
  const npmrc = join(dir, "npmrc");
  writeFileSync(
    npmrc,
    `registry=${registryUrl}\n//127.0.0.1:${server.port}/:_authToken=fake-token\n`,
  );

  const proc = Bun.spawn(
    [
      process.execPath,
      "install",
      "--no-summary",
      "--cache-dir",
      join(dir, ".cache"),
    ],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc, NO_COLOR: "1" },
    },
  );

  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let installedVersion: string | null = null;
    try {
      const pkg = JSON.parse(
        readFileSync(
          join(dir, "node_modules", pkgName, "package.json"),
          "utf8",
        ),
      ) as { version?: string };
      installedVersion = pkg.version ?? null;
    } catch {
      installedVersion = null;
    }
    return { exitCode, stderr, installedVersion };
  } finally {
    clearTimeout(timer);
  }
}

function generateOfflineLockbFixture(): {
  readonly validLockb: Uint8Array;
  readonly localPkgManifest: string;
} {
  const seedDir = mkdtempSync(join(tmpdir(), "bun-lockb-seed-"));
  tempDirs.push(seedDir);
  mkdirSync(join(seedDir, "pkg-a"), { recursive: true });
  const localPkgManifest = JSON.stringify({ name: "pkg-a", version: "1.0.0" });
  writeFileSync(join(seedDir, "pkg-a", "package.json"), localPkgManifest);
  writeFileSync(
    join(seedDir, "bunfig.toml"),
    "[install]\nsaveTextLockfile = false\n",
  );
  writeFileSync(
    join(seedDir, "package.json"),
    JSON.stringify({
      name: "lockb-seed",
      version: "0.0.0",
      private: true,
      dependencies: { "pkg-a": "file:./pkg-a" },
    }),
  );

  const init = Bun.spawnSync(
    [
      process.execPath,
      "install",
      "--no-summary",
      "--cache-dir",
      join(seedDir, ".cache"),
    ],
    {
      cwd: seedDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  expect(init.exitCode).toBe(0);
  const validLockb = new Uint8Array(readFileSync(join(seedDir, "bun.lockb")));
  expect(validLockb.length).toBeGreaterThan(0);
  return { validLockb, localPkgManifest };
}

function runLockbCommand(
  lockbBytes: Uint8Array,
  args: readonly string[],
  localPkgManifest?: string,
): {
  readonly exitCode: number;
  readonly signalCode: string | number | null;
  readonly stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "bun-lockb-mut-"));
  tempDirs.push(dir);
  if (localPkgManifest !== undefined) {
    mkdirSync(join(dir, "pkg-a"), { recursive: true });
    writeFileSync(join(dir, "pkg-a", "package.json"), localPkgManifest);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "lockb-mut",
        version: "0.0.0",
        private: true,
        dependencies: { "pkg-a": "file:./pkg-a" },
      }),
    );
  } else {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "lockb-mut", version: "0.0.0", private: true }),
    );
  }
  writeFileSync(join(dir, "bun.lockb"), lockbBytes);

  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });

  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode ?? null,
    stderr: result.stderr.toString(),
  };
}

describe("bun install version-selection edge cases (npm-pick-manifest divergences)", () => {
  test("falls back to highest version when dist-tags.latest points to a missing version", async () => {
    for (const specifier of ["latest", "*", "^1.0.0"]) {
      const res = await installFromMockRegistry(
        "missing-latest-pkg",
        specifier,
      );
      expect(res.exitCode, specifier).toBe(0);
      expect(res.installedVersion, specifier).toBe("1.0.1");
    }
  }, 60_000);

  test("handles ^1.0.0-a.0 prerelease selection vs dist-tags.latest", async () => {
    const controlStable = await installFromMockRegistry(
      "baseline-a0-pkg",
      "^1.0.0",
    );
    expect(controlStable.exitCode).toBe(0);
    expect(controlStable.installedVersion).toBe("1.0.0");

    const prereleaseLowerBound = await installFromMockRegistry(
      "baseline-a0-pkg",
      "^1.0.0-a.0",
    );
    expect(prereleaseLowerBound.exitCode).toBe(0);
    expect(prereleaseLowerBound.installedVersion).toBe("1.0.1");

    const prereleaseOnly = await installFromMockRegistry(
      "pre-only-a0-pkg",
      "^1.0.0-a.0",
    );
    expect(prereleaseOnly.exitCode).toBe(0);
    expect(prereleaseOnly.installedVersion).toBe("1.0.0-b.0");

    const exactLowerLatest = await installFromMockRegistry(
      "exact-lower-a0-pkg",
      "^1.0.0-a.0",
    );
    expect(exactLowerLatest.exitCode).toBe(0);
    expect(exactLowerLatest.installedVersion).toBe("1.0.0-a.0");

    const tupleExcluded = await installFromMockRegistry(
      "tuple-excluded-a0-pkg",
      "^1.0.0-a.0",
    );
    expect(tupleExcluded.exitCode).toBe(1);
    expect(tupleExcluded.installedVersion).toBeNull();
    expect(tupleExcluded.stderr).toContain('No version matching "^1.0.0-a.0"');
  }, 60_000);
});

describe("mutated bun.lockb crash and hang resilience", () => {
  test("rejects synthetic corrupt bun.lockb payloads cleanly without crashing or hanging", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly bytes: Uint8Array;
      readonly expectedError: string;
    }> = [
      {
        label: "empty",
        bytes: new Uint8Array(0),
        expectedError: "InvalidLockfile",
      },
      {
        label: "truncated-magic",
        bytes: new TextEncoder().encode(
          "#!/usr/bin/env bun\nbun-lockfile-format-v0\n",
        ),
        expectedError: "EndOfStream",
      },
      {
        label: "garbage-bytes",
        bytes: Uint8Array.from({ length: 256 }, (_, i) => (i * 73 + 19) & 0xff),
        expectedError: "InvalidLockfile",
      },
      {
        label: "zeroed-4kb",
        bytes: new Uint8Array(4096),
        expectedError: "InvalidLockfile",
      },
    ];

    const commands: ReadonlyArray<readonly string[]> = [
      ["install", "--frozen-lockfile"],
      ["pm", "ls"],
      ["pm", "hash"],
    ];

    for (const c of cases) {
      for (const cmd of commands) {
        const res = runLockbCommand(c.bytes, cmd);
        expect(res.signalCode, `${c.label} ${cmd.join(" ")}`).toBeNull();
        expect(res.exitCode, `${c.label} ${cmd.join(" ")}`).toBe(1);
        expect(res.stderr, `${c.label} ${cmd.join(" ")}`).toContain(
          c.expectedError,
        );
      }
    }
  }, 60_000);

  test("handles truncated and bit-flipped real bun.lockb across commands without crash signals", () => {
    const { validLockb, localPkgManifest } = generateOfflineLockbFixture();
    const commands: ReadonlyArray<readonly string[]> = [
      ["install", "--frozen-lockfile"],
      ["pm", "ls"],
      ["pm", "hash"],
    ];

    const halfTruncated = validLockb.subarray(
      0,
      Math.floor(validLockb.length / 2),
    );
    const corruptHeader40 = new Uint8Array(validLockb);
    corruptHeader40[40] = (corruptHeader40[40] ?? 0) ^ 0xff;

    for (const cmd of commands) {
      const halfRes = runLockbCommand(halfTruncated, cmd, localPkgManifest);
      expect(halfRes.signalCode, `half-truncated ${cmd.join(" ")}`).toBeNull();
      expect(halfRes.exitCode, `half-truncated ${cmd.join(" ")}`).toBe(1);
      expect(halfRes.stderr, `half-truncated ${cmd.join(" ")}`).toContain(
        "Lockfile is missing data",
      );

      const hdrRes = runLockbCommand(corruptHeader40, cmd, localPkgManifest);
      expect(hdrRes.signalCode, `header-40 ${cmd.join(" ")}`).toBeNull();
      expect(hdrRes.exitCode, `header-40 ${cmd.join(" ")}`).toBe(1);
      expect(hdrRes.stderr, `header-40 ${cmd.join(" ")}`).toContain(
        "InvalidLockfile",
      );
    }

    const sweepMutations: Array<{
      readonly label: string;
      readonly bytes: Uint8Array;
    }> = [];
    const sliceFractions = [0.05, 0.2, 0.35, 0.75, 0.9, 0.99];
    for (const frac of sliceFractions) {
      sweepMutations.push({
        label: `slice-${frac}`,
        bytes: validLockb.subarray(0, Math.floor(validLockb.length * frac)),
      });
    }

    const flipOffsets = [0, 32, 48, 64, 128, Math.floor(validLockb.length / 2)];
    for (const offset of flipOffsets) {
      const mutated = new Uint8Array(validLockb);
      for (let i = 0; i < 4 && offset + i < mutated.length; i += 1) {
        mutated[offset + i] = (mutated[offset + i] ?? 0) ^ 0xff;
      }
      sweepMutations.push({
        label: `flip-4b-${offset}`,
        bytes: mutated,
      });
    }
    expect(sweepMutations.length).toBe(12);

    for (const mutation of sweepMutations) {
      for (const cmd of commands) {
        const res = runLockbCommand(mutation.bytes, cmd, localPkgManifest);
        expect(res.signalCode, `${mutation.label} ${cmd.join(" ")}`).toBeNull();
        expect([0, 1], `${mutation.label} ${cmd.join(" ")}`).toContain(
          res.exitCode,
        );
      }
    }
  }, 60_000);
});
