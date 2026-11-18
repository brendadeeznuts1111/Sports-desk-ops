import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "theme-codegen-"));
  dirs.push(dir);
  return dir;
}

function runCli(args: readonly string[]) {
  return Bun.spawnSync([process.execPath, "cli/theme_codegen.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("theme codegen CLI", () => {
  test("writes both artifacts for a built-in profile", () => {
    const dir = scratch();
    const result = runCli([
      "codegen",
      "--profile",
      "crimson-dry",
      "--out-dir",
      join(dir, "out"),
      "--db",
      join(dir, "tokens.sqlite"),
    ]);

    expect(result.exitCode).toBe(0);
    const envFile = join(dir, "out", ".env.crimson-dry");
    const tsFile = join(dir, "out", "crimson-dry.theme.gen.ts");
    expect(existsSync(envFile)).toBe(true);
    expect(existsSync(tsFile)).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain(
      'PTY_PROFILE="crimson-dry"',
    );
    expect(readFileSync(tsFile, "utf8")).toContain(
      "GENERATED_PROFILE_CRIMSON_DRY",
    );
  });

  test("exits 2 for an unknown profile and prints the store error", () => {
    const dir = scratch();
    const result = runCli([
      "codegen",
      "--profile",
      "does-not-exist",
      "--out-dir",
      join(dir, "out"),
      "--db",
      join(dir, "tokens.sqlite"),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("ERR_PROFILE_NOT_FOUND");
  });

  test("exits 2 with usage when no subcommand is given", () => {
    const result = runCli([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "usage: bun cli/theme_codegen.ts codegen",
    );
  });
});
