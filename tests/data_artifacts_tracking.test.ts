import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LIVE_ARTIFACTS = [
  "data/live-bets.json",
  "data/live-wagers.json",
] as const;

function git(args: readonly string[]): {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

describe("live capture artifacts stay untracked", () => {
  test("git does not track data/live-bets.json or data/live-wagers.json", () => {
    const result = git(["ls-files", "--", ...LIVE_ARTIFACTS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test(".gitignore names both local capture paths", async () => {
    const ignore = await Bun.file(join(ROOT, ".gitignore")).text();
    for (const path of LIVE_ARTIFACTS) expect(ignore).toContain(path);
  });

  test("the endpoint test uses the sanitized fixture, not the live file", async () => {
    const fixture = Bun.file(
      join(ROOT, "tests/fixtures/live-wagers.partial.json"),
    );
    expect(await fixture.exists()).toBe(true);

    const source = await Bun.file(
      join(ROOT, "tests/live_wagers_endpoint.test.ts"),
    ).text();
    expect(source).toContain("fixtures/live-wagers.partial.json");
    expect(source).not.toContain("../data/live-wagers.json");
  });
});
