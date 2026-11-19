import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * `dx pr` is a thin wrapper: it handles a few flags itself and forwards every other argument to the
 * `bun-pr` executable, which owns the build variants. The help is the only documentation of that
 * workflow, so it has to stay honest in both directions — every advertised flag must actually work
 * (through `dx` or through `bun-pr`), and `dx` must not start swallowing a forwarded flag.
 *
 * The forwarded set was verified against `bun-pr@1.0.39`, whose source parses `--asan`, `--profile`,
 * `--baseline`, `--musl`, `--lldb`, `--gdb`, `--core` and `--run`/`-x`.
 */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "bun_pr_cli.ts");
const DX = join(ROOT, "bin", "dx");

/** Flags `dx pr` implements itself. */
const DX_FLAGS = ["--verify", "--list", "--clean", "--help"] as const;

/** Flags forwarded verbatim to `bun-pr`, which implements each one. */
const FORWARDED_FLAGS = [
  "--asan",
  "--profile",
  "--baseline",
  "--musl",
  "--lldb",
  "--gdb",
  "-x, --run",
] as const;

function run(
  argv: readonly string[],
  useBash = false,
): {
  readonly code: number;
  readonly out: string;
} {
  const command = useBash ? ["bash", ...argv] : [process.execPath, ...argv];
  const proc = Bun.spawnSync(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
  });
  return {
    code: proc.exitCode ?? -1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

describe("dx pr help documents what actually works", () => {
  test("every flag dx implements is in the help", () => {
    const result = run([CLI, "-h"]);
    expect(result.code).toBe(0);
    for (const flag of DX_FLAGS) expect(result.out).toContain(flag);
  });

  test("every flag bun-pr implements is in the help, including the -x alias", () => {
    const result = run([CLI, "-h"]);
    for (const flag of FORWARDED_FLAGS) expect(result.out).toContain(flag);
    // The example must exercise a forwarded flag, not only dx's own.
    expect(result.out).toContain("-x run");
  });

  test("the help names the tool that owns the forwarded flags", () => {
    const result = run([CLI, "-h"]);
    expect(result.out).toContain("bun-pr");
  });

  test("dx help advertises the same wrapper", () => {
    const result = run([DX, "help"], true);
    expect(result.code).toBe(0);
    expect(result.out).toContain("./bin/dx pr");
    expect(result.out).toContain("--verify");
    expect(result.out).toContain("-x");
  });
});

describe("dx pr forwards instead of swallowing", () => {
  test("--verify is the only argument dx removes before calling bun-pr", async () => {
    const source = await Bun.file(CLI).text();
    const splices = [...source.matchAll(/args\.splice\(/g)].length;
    expect(splices).toBe(1);
    // A second splice would mean a forwarded flag silently stopped reaching bun-pr.
    expect(source).toContain('args.findIndex((a) => a === "--verify")');
  });

  test("the wrapper invokes bun-pr rather than reimplementing it", async () => {
    const source = await Bun.file(CLI).text();
    expect(source).toContain('join(BUN_BIN_DIR, "bun-pr")');
    expect(source).toContain("[bunPrExec, ...args]");
  });
});
