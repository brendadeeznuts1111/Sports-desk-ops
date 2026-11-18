/**
 * @file tests/bun_publish_recursive.test.ts
 * @description Contract for `bun publish --recursive` / `--filter` against a local mock registry.
 *
 * Re-measures the 1.4.4 release-note claims: private packages are skipped, `--filter` selects a
 * subset, every package is packed before the first upload, and a re-run skips versions already on
 * the registry. The mock accepts any bearer token, so the test never touches npm or the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Upload {
  readonly name: string;
  readonly version: string;
}

interface RegistryState {
  readonly uploads: Upload[];
  readonly versions: Map<string, string[]>;
  markersAtFirstUpload: string[] | null;
  root: string | null;
}

const tempDirs: string[] = [];

const state: RegistryState = {
  uploads: [],
  versions: new Map(),
  markersAtFirstUpload: null,
  root: null,
};

let server: ReturnType<typeof Bun.serve>;
let registryUrl = "";

function markersFor(root: string, markerNames: readonly string[]): string[] {
  return markerNames.filter((name) => existsSync(join(root, name)));
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.replace(/^\//, ""));

      if (request.method === "PUT") {
        if (state.markersAtFirstUpload === null && state.root !== null) {
          state.markersAtFirstUpload = markersFor(state.root, [
            "marker-a",
            "marker-b",
            "marker-c",
          ]);
        }
        const raw = await request.text();
        const manifest = JSON.parse(raw) as {
          versions?: Record<string, unknown>;
        };
        const version = Object.keys(manifest.versions ?? {})[0] ?? "0.0.0";
        state.uploads.push({ name, version });
        const versions = state.versions.get(name) ?? [];
        versions.push(version);
        state.versions.set(name, versions);
        return Response.json({ ok: true }, { status: 201 });
      }

      if (request.method === "GET") {
        const versions = state.versions.get(name);
        if (versions === undefined || versions.length === 0) {
          return new Response("not found", { status: 404 });
        }
        const latest = versions[versions.length - 1] as string;
        return Response.json({
          name,
          versions: Object.fromEntries(versions.map((v) => [v, {}])),
          "dist-tags": { latest },
        });
      }

      return new Response("ok");
    },
  });
  registryUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(() => {
  server.stop(true);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(
  packages: readonly {
    readonly name: string;
    readonly private?: boolean;
    readonly marker?: string;
  }[],
): { dir: string; npmrc: string } {
  const dir = mkdtempSync(join(tmpdir(), "bun-publish-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "publish-fixture-root",
      version: "0.0.0",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  writeFileSync(
    join(dir, "marker.ts"),
    'const out = process.env.PUBLISH_MARKER_DIR ?? process.cwd();\nawait Bun.write(`${out}/marker-${process.argv[2]}`, "packed");\n',
  );
  for (const pkg of packages) {
    const pkgDir = join(dir, "packages", pkg.name.split("/")[1] as string);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: pkg.name,
        version: "1.0.0",
        ...(pkg.private === true ? { private: true } : {}),
        ...(pkg.marker === undefined
          ? {}
          : { scripts: { prepack: `bun ../../marker.ts ${pkg.marker}` } }),
      }),
    );
  }
  const npmrc = join(dir, "npmrc");
  writeFileSync(
    npmrc,
    `registry=${registryUrl}\n//127.0.0.1:${server.port}/:_authToken=fake-token\n`,
  );
  state.root = dir;
  state.markersAtFirstUpload = null;
  return { dir, npmrc };
}

async function publish(
  dir: string,
  npmrc: string,
  args: readonly string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  // Async spawn: the mock registry runs in this process, so a spawnSync would block it.
  const proc = Bun.spawn([process.execPath, "publish", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: npmrc,
      PUBLISH_MARKER_DIR: dir,
      NO_COLOR: "1",
    },
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

// @bun-behavior: publish-recursive

describe("bun publish --recursive on a mock registry", () => {
  test("publishes public workspaces and skips private ones", async () => {
    const fixture = workspace([
      { name: "@probe/a1", marker: "a" },
      { name: "@probe/b1", marker: "b" },
      { name: "@probe/c1", private: true },
    ]);
    const before = state.uploads.length;
    const result = await publish(fixture.dir, fixture.npmrc, [
      "--recursive",
      "--quiet",
    ]);
    expect(result.exitCode).toBe(0);

    const uploaded = state.uploads.slice(before).map((u) => u.name);
    expect(uploaded.sort()).toEqual(["@probe/a1", "@probe/b1"]);
  }, 60_000);

  test("packs every package before the first upload", async () => {
    const fixture = workspace([
      { name: "@probe/a4", marker: "a" },
      { name: "@probe/b4", marker: "b" },
    ]);
    const result = await publish(fixture.dir, fixture.npmrc, [
      "--recursive",
      "--quiet",
    ]);
    expect(result.exitCode).toBe(0);
    expect(state.markersAtFirstUpload).toEqual(["marker-a", "marker-b"]);
  }, 60_000);

  test("publishes only workspaces matching --filter", async () => {
    const fixture = workspace([
      { name: "@probe/a2", marker: "a" },
      { name: "@probe/b2", marker: "b" },
    ]);
    const before = state.uploads.length;
    const result = await publish(fixture.dir, fixture.npmrc, [
      "--recursive",
      "--quiet",
      "--filter",
      "@probe/a2",
    ]);
    expect(result.exitCode).toBe(0);
    expect(state.uploads.slice(before).map((u) => u.name)).toEqual([
      "@probe/a2",
    ]);
  }, 60_000);

  test("skips versions already on the registry on a re-run", async () => {
    const fixture = workspace([{ name: "@probe/a3", marker: "a" }]);
    const first = await publish(fixture.dir, fixture.npmrc, [
      "--recursive",
      "--quiet",
    ]);
    expect(first.exitCode).toBe(0);
    const afterFirst = state.uploads.length;
    expect(state.uploads.slice(afterFirst - 1)[0]?.name).toBe("@probe/a3");

    const second = await publish(fixture.dir, fixture.npmrc, [
      "--recursive",
      "--quiet",
    ]);
    expect(second.exitCode).toBe(0);
    expect(state.uploads.length).toBe(afterFirst);
  }, 60_000);
});
