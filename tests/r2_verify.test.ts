import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = "scripts/r2_verify.ts";

function run(
  args: readonly string[],
  env: Record<string, string | undefined> = Bun.env as Record<
    string,
    string | undefined
  >,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function withoutR2Credentials(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...Bun.env };
  for (const key of [
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
  ]) {
    delete env[key];
  }
  return env;
}

describe("r2:verify:local scope", () => {
  test("defaults to dist/ and documents the Pages-only exclusions", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("default: dist/");
    expect(result.stdout).toContain("_headers");
    expect(result.stdout).toContain("assets/live-ops.d.ts");
    expect(result.stdout).toContain("dashboard-view.html");
    expect(result.stdout).toContain("Pages-only");
  });

  test("still refuses to read without credentials and names both endpoint options", () => {
    const result = run(["--prefix", "dist"], withoutR2Credentials());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Need CLOUDFLARE_ACCOUNT_ID");
    expect(result.stderr).toContain("R2_ENDPOINT");
    expect(result.stderr).toContain("R2_ACCESS_KEY_ID");
  });
});
