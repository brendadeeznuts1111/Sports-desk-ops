/**
 * @file tests/bunx_download_flags.test.ts
 * @description `bunx --minimum-release-age` and `--trust` on packages bunx downloads.
 *
 * Re-measures the 1.4.4 release note: the age flag applies to downloaded packages (a fresh
 * version is blocked until it is old enough), and `--trust` is what allows the package's
 * lifecycle scripts to run. A local mock registry serves the packuments and tarballs; bunx runs
 * asynchronously so the in-process server can answer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: bunx-minimum-release-age
// @bun-behavior: bunx-trust

const tempDirs: string[] = [];
let fixturesDir = "";
let server: ReturnType<typeof Bun.serve>;
let registryUrl = "";

function makeTarball(
  name: string,
  extra: Record<string, unknown> = {},
): string {
  const buildDir = join(fixturesDir, `build-${name}`);
  mkdirSync(join(buildDir, "package"), { recursive: true });
  writeFileSync(
    join(buildDir, "package", "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      bin: { [name]: "cli.js" },
      ...extra,
    }),
  );
  writeFileSync(
    join(buildDir, "package", "cli.js"),
    `#!/usr/bin/env bun\nconsole.log("${name}-ran");\n`,
  );
  chmodSync(join(buildDir, "package", "cli.js"), 0o755);
  if (name === "trust-probe") {
    writeFileSync(
      join(buildDir, "package", "postinstall.js"),
      'await Bun.write(process.env.TRUST_MARKER, "script-ran");\n',
    );
  }
  const tarball = join(fixturesDir, `${name}-1.0.0.tgz`);
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
  fixturesDir = mkdtempSync(join(tmpdir(), "bunx-flags-"));
  tempDirs.push(fixturesDir);
  const tarballs = new Map([
    ["age-probe", makeTarball("age-probe")],
    [
      "trust-probe",
      makeTarball("trust-probe", {
        scripts: { postinstall: "bun postinstall.js" },
      }),
    ],
  ]);
  const now = new Date().toISOString();

  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      registryUrl = `http://127.0.0.1:${server.port}/`;
      const file = tarballs.get(
        url.pathname.replace(/^\//, "").replace(/-1\.0\.0\.tgz$/, ""),
      );
      if (url.pathname.endsWith(".tgz") && file !== undefined) {
        return new Response(Bun.file(file));
      }
      const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (name === "age-probe" || name === "trust-probe") {
        return Response.json({
          name,
          "dist-tags": { latest: "1.0.0" },
          ...(name === "age-probe"
            ? { time: { "1.0.0": now, modified: now, created: now } }
            : {}),
          versions: {
            "1.0.0": {
              name,
              version: "1.0.0",
              bin: { [name]: "cli.js" },
              ...(name === "trust-probe"
                ? { scripts: { postinstall: "bun postinstall.js" } }
                : {}),
              dist: { tarball: `${registryUrl}${name}-1.0.0.tgz` },
            },
          },
        });
      }
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
  const dir = mkdtempSync(join(tmpdir(), "bunx-run-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "bunx-root", version: "0.0.0", private: true }),
  );
  const npmrc = join(dir, "npmrc");
  writeFileSync(
    npmrc,
    `registry=${registryUrl}\n//127.0.0.1:${server.port}/:_authToken=fake-token\n`,
  );
  return { dir, npmrc };
}

async function bunx(
  dir: string,
  npmrc: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cache = mkdtempSync(join(dir, "cache-"));
  const proc = Bun.spawn([process.execPath, "x", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
      NPM_CONFIG_USERCONFIG: npmrc,
      BUN_INSTALL_CACHE_DIR: cache,
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

describe("bunx --minimum-release-age", () => {
  test("blocks a package version newer than the threshold", async () => {
    const { dir, npmrc } = fixture();
    const result = await bunx(dir, npmrc, [
      "--minimum-release-age",
      "3600",
      "age-probe",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("minimum-release-age: 3600 seconds");
    expect(result.stdout).not.toContain("age-probe-ran");
  }, 60_000);

  test("runs the tool when the threshold is zero", async () => {
    const { dir, npmrc } = fixture();
    const result = await bunx(dir, npmrc, [
      "--minimum-release-age",
      "0",
      "age-probe",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("age-probe-ran");
  }, 60_000);
});

describe("bunx --trust", () => {
  test("skips lifecycle scripts without the flag", async () => {
    const { dir, npmrc } = fixture();
    const marker = join(dir, "marker-untrusted");
    const result = await bunx(dir, npmrc, ["trust-probe"], {
      TRUST_MARKER: marker,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("trust-probe-ran");
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test("runs the package lifecycle script with the flag", async () => {
    const { dir, npmrc } = fixture();
    const marker = join(dir, "marker-trusted");
    const result = await bunx(dir, npmrc, ["--trust", "trust-probe"], {
      TRUST_MARKER: marker,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("trust-probe-ran");
    expect(existsSync(marker)).toBe(true);
  }, 60_000);
});
