import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * `packages/ba-example` exists to keep `bun run --filter` documented and exercised. These cases pin
 * the parts the runbook states, so the reference workspace cannot be renamed away from the glob or
 * the failure mode cannot soften into a silent skip.
 *
 * Measured on Bun 1.4.4, 2026-11-18:
 * - `--filter 'ba*' schema`                exit 0, output prefixed `ba-example schema:`
 * - `--filter 'ba*' typecheck`             exit 1, `Script "typecheck" not found in package "ba-example"`
 * - `--filter 'ba*' --if-present typecheck` exit 0, nothing to run
 * - `--filter 'packages/ba*' schema`       exit 1, `No workspace packages matched the filter`
 *
 * Re-measured 2026-11-19: a directory path *does* match, but only with a leading `./` —
 * `--filter './packages/ba*'` and `--filter './packages/ba-example'` both run the workspace,
 * while the bare form above stays unmatched. The prefix is the rule, not whether paths work.
 */

const ROOT = join(import.meta.dir, "..");

function runFilter(args: readonly string[]): {
  readonly code: number;
  readonly out: string;
  readonly err: string;
} {
  const result = Bun.spawnSync([process.execPath, "run", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("bun run --filter on the ba-example reference workspace", () => {
  test("the name glob selects the workspace and runs its script", () => {
    const result = runFilter(["--filter", "ba*", "schema"]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n")[0]).toStartWith("ba-example schema:");
  }, 30_000);

  test("a matched package without the script fails the run", () => {
    const result = runFilter(["--filter", "ba*", "typecheck"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'Script "typecheck" not found in package "ba-example"',
    );
  }, 30_000);

  test("--if-present turns that failure into a no-op", () => {
    const result = runFilter(["--filter", "ba*", "--if-present", "typecheck"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
  }, 30_000);

  test("a directory path matches only when it carries the leading ./", () => {
    // The rule is the prefix, not path support: `packages/ba*` is neither a package name nor a
    // path Bun resolves, while `./packages/ba*` is a path it does.
    const bare = runFilter(["--filter", "packages/ba*", "schema"]);
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("No workspace packages matched");

    const globbed = runFilter(["--filter", "./packages/ba*", "schema"]);
    expect(globbed.code).toBe(0);
    expect(globbed.out.split("\n")[0]).toStartWith("ba-example schema:");

    const exact = runFilter(["--filter", "./packages/ba-example", "schema"]);
    expect(exact.code).toBe(0);
    expect(exact.out.split("\n")[0]).toStartWith("ba-example schema:");
  }, 30_000);
});
