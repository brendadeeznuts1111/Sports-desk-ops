/**
 * @file tests/bun_deprecated_add.test.ts
 * @description `bun add` warns about a deprecated direct dependency and skips a deprecated latest.
 *
 * Re-measures the 1.4.4 release note ("bun install warns about deprecated packages"). A local
 * mock registry serves the packument and tiny tarballs, so the assertions do not depend on npm's
 * current deprecation state. `bun add` is spawned asynchronously because the registry runs in this
 * process.
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

// @bun-behavior: deprecated-packages

const tempDirs: string[] = [];
let fixturesDir = "";
let server: ReturnType<typeof Bun.serve>;
let registryUrl = "";

function makeTarball(version: string): string {
  const buildDir = join(fixturesDir, `build-${version}`);
  mkdirSync(join(buildDir, "package"), { recursive: true });
  writeFileSync(
    join(buildDir, "package", "package.json"),
    JSON.stringify({ name: "dep-probe", version: `1.0.${version}` }),
  );
  const tarball = join(fixturesDir, `dep-probe-1.0.${version}.tgz`);
  const tar = Bun.spawnSync(
    ["tar", "-czf", tarball, "-C", buildDir, "package"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (tar.exitCode !== 0) {
    throw new Error(`tar failed: ${tar.stderr.toString()}`);
  }
  return tarball;
}

function packument(): Record<string, unknown> {
  return {
    name: "dep-probe",
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name: "dep-probe",
        version: "1.0.0",
        deprecated: "use 1.0.1",
        dist: { tarball: `${registryUrl}dep-probe-1.0.0.tgz` },
      },
      "1.0.1": {
        name: "dep-probe",
        version: "1.0.1",
        dist: { tarball: `${registryUrl}dep-probe-1.0.1.tgz` },
      },
    },
  };
}

beforeAll(() => {
  fixturesDir = mkdtempSync(join(tmpdir(), "bun-deprecated-"));
  tempDirs.push(fixturesDir);
  const tarballs = new Map([
    ["dep-probe-1.0.0.tgz", makeTarball("0")],
    ["dep-probe-1.0.1.tgz", makeTarball("1")],
  ]);

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      registryUrl = `http://127.0.0.1:${server.port}/`;
      const file = tarballs.get(url.pathname.replace(/^\//, ""));
      if (file !== undefined) return new Response(Bun.file(file));
      if (url.pathname === "/dep-probe") return Response.json(packument());
      return new Response("not found", { status: 404 });
    },
  });
  registryUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { dir: string; npmrc: string } {
  const dir = mkdtempSync(join(tmpdir(), "bun-deprecated-add-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "dep-root", version: "0.0.0", private: true }),
  );
  const npmrc = join(dir, "npmrc");
  writeFileSync(
    npmrc,
    `registry=${registryUrl}\n//127.0.0.1:${server.port}/:_authToken=fake-token\n`,
  );
  return { dir, npmrc };
}

async function add(
  dir: string,
  npmrc: string,
  spec: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "add",
      spec,
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
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stderr };
}

describe("bun add deprecated packages", () => {
  test("warns once for a deprecated direct dependency", async () => {
    const { dir, npmrc } = fixture();
    const result = await add(dir, npmrc, "dep-probe@1.0.0");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warn: deprecated dep-probe@1.0.0");
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["dep-probe"]).toBe("1.0.0");
  }, 60_000);

  test("skips a deprecated latest version", async () => {
    const { dir, npmrc } = fixture();
    const result = await add(dir, npmrc, "dep-probe");
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["dep-probe"]).toBe("^1.0.1");
  }, 60_000);
});
