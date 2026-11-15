import { describe, expect, test } from "bun:test";

/**
 * `examples/bun_markdown_ansi.ts` is the runnable form of the official reference
 * page. This test keeps the citation and the measured invariants honest: if a
 * Bun upgrade changes the output shape, the example fails here first.
 */
describe("official Bun.markdown.ansi examples", () => {
  test("the example cites the reference page and its --check mode passes", async () => {
    const source = await Bun.file("examples/bun_markdown_ansi.ts").text();
    expect(source).toContain("https://bun.com/reference/bun/markdown/ansi");

    const run = Bun.spawnSync(
      ["bun", "examples/bun_markdown_ansi.ts", "--check"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("✓ official examples verified");
  });

  test("print mode runs without assertions and shows the escaped output", () => {
    const run = Bun.spawnSync(["bun", "examples/bun_markdown_ansi.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    const out = run.stdout.toString();
    expect(out).toContain('default       "\\u001b[1m');
    expect(out).toContain('plain         "Hello\\n=====\\n"');
  });
});
