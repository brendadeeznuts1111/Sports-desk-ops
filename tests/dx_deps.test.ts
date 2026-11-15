import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `dx deps` is the one entrypoint that must not `cd`: `bun-deps` acts on the
 * directory it runs in, so a workspace add has to land in that workspace's
 * package.json. These spawn the real shell script.
 *
 * `dx` links dotfiles into `$HOME` on every run, so HOME is a scratch dir. The
 * doctor checks selected here read only the repo: no global bunfig, no network.
 */

const ROOT = path.join(import.meta.dir, "..");
const HOME = mkdtempSync(path.join(tmpdir(), "dx-deps-home-"));
const OFFLINE_CHECKS = "lock workspaces,lock versions,patches";
const hasBunDeps = Bun.which("bun-deps") !== null;

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

async function dx(
  args: readonly string[],
  cwd: string = ROOT,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([path.join(ROOT, "bin/dx"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...Bun.env, HOME },
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("dx deps", () => {
  test.skipIf(!hasBunDeps)(
    "shows bun-deps help, including the catalog flag",
    async () => {
      const result = await dx(["deps", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("bun-deps");
      expect(result.stdout).toContain("--catalog");
      expect(result.stdout).toContain("frozenLockfile");
    },
  );

  test("check is the machine policy doctor, with JSON passthrough", async () => {
    const result = await dx(["deps", "check", "--only", "runtime", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok?: boolean;
      checks?: { name: string; status: string; detail: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.checks?.map((c) => c.name)).toContain("runtime pin");
    // Scratch HOME has an empty ~/.bun/bin; the doctor must still see
    // the bun that was on the caller's PATH, not a shadowed system copy.
    expect(
      report.checks?.find((check) => check.name === "runtime pin")?.detail,
    ).toContain(`bun ${Bun.version}`);
  });

  test.skipIf(!hasBunDeps)(
    "unknown dependency commands fail with a usage message, not a stack",
    async () => {
      const result = await dx(["deps", "bogus"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("is not a dependency command");
    },
  );

  test("check passes --only through to the doctor", async () => {
    const result = await dx([
      "deps",
      "check",
      "--only",
      OFFLINE_CHECKS,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "lock workspaces",
      "lock versions",
      "patches",
    ]);
  });

  test("check works from inside a workspace package", async () => {
    const result = await dx(
      ["deps", "check", "--only", OFFLINE_CHECKS, "--json"],
      path.join(ROOT, "packages/ba-example"),
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
  });

  test("an unmatched --only filter is a usage error", async () => {
    const result = await dx(["deps", "check", "--only", "zzz"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no checks match");
  });

  test("version with no argument explains itself instead of prompting", async () => {
    const result = await dx(["deps", "version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dx deps version");
    expect(result.stdout).toContain("bun-deps install");
    expect(result.stdout).toContain("frozen install passes");
  });

  test("the command index lists deps and its version subcommand", async () => {
    const result = await dx(["help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("./bin/dx deps");
    expect(result.stdout).toContain("bun");
    expect(result.stdout).toContain("version");
  });
});
