import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The CLI's inspect surface end to end: the branded-types report renders through
 * `Bun.inspect.table`, and the shared flags change colour/depth without touching the table.
 * Only the pure `--brands` command is spawned; book-backed reports need the gitignored corpus.
 */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli", "sportsdesk_cli.ts");

function run(
  args: readonly string[],
  env: Record<string, string> = {},
): { readonly code: number; readonly out: string; readonly err: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", CLI, ...args],
    cwd: ROOT,
    env: { ...Bun.env, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("sportsdesk CLI inspect output", () => {
  test("--brands renders a Bun.inspect.table with the requested columns", () => {
    const { code, out, err } = run(["--brands"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("16 SPECIFICATION-GRADE NOMINAL BRANDED TYPES");
    for (const column of [
      "Type",
      "Primitive",
      "Constructor",
      "Value",
      "Invariant",
    ]) {
      expect(out).toContain(column);
    }
    // Box-drawing table, and no ANSI under NO_COLOR.
    expect(out).toContain("┌");
    expect(out).not.toContain("\x1b[");
  });

  test("--inspect-color=always is the NO_COLOR escape hatch", () => {
    const { code, out } = run(["--brands", "--inspect-color=always"]);
    expect(code).toBe(0);
    expect(out).toContain("\x1b[");
  });

  test("a malformed inspect flag is a one-line usage error, not a stack", () => {
    const { code, out, err } = run(["--brands", "--inspect-depth=99"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("[USAGE]");
    expect(err).toContain("integer 0..8");
    expect(err).not.toContain("parseInspectFlags");
    expect(err).not.toContain("    at ");
  });

  test("an unknown inspect flag is rejected the same way", () => {
    const { code, err } = run(["--brands", "--inspect-verbose"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown inspect flag --inspect-verbose");
  });
});
