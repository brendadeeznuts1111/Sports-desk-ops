import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Gate Integrity Meta-Test for no-unsafe-innerhtml
 * Verifies that bin/check-innerhtml.ts accurately detects:
 * 1. Simple dynamic variable assignment (must fail, exit 1)
 * 2. Template literal with interpolation (must fail, exit 1)
 * 3. String concatenation (must fail, exit 1)
 * 4. Static string literal assignment (must pass, exit 0)
 * 5. Sanitized assignment with structured comment (must pass, exit 0)
 */

describe("check-innerhtml 5-case meta-test suite", () => {
  async function runLinter(
    codeLine: string,
  ): Promise<{ exitCode: number; stdout: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "check-innerhtml-"));
    try {
      const content = `// Scratch test\nexport function test(container: HTMLElement, untrusted: string, a: string, b: string, x: string) {\n  ${codeLine}\n}\n`;
      await Bun.write(path.join(root, "lib/scratch.ts"), content);

      const proc = Bun.spawnSync(
        [
          process.execPath,
          path.join(import.meta.dir, "../bin/check-innerhtml.ts"),
          root,
        ],
        {
          env: {
            PATH: Bun.env.PATH ?? "",
            HOME: Bun.env.HOME ?? "",
          },
        },
      );

      return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("Case 1: Simple dynamic variable assignment fails with exit code 1", async () => {
    const res = await runLinter("container.innerHTML = untrusted;");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(
      "Unsafe innerHTML assignment with dynamic expression 'untrusted'",
    );
  });

  test("Case 2: Template literal with interpolation fails with exit code 1", async () => {
    const res = await runLinter("container.innerHTML = `<div>${x}</div>`;");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(
      "Unsafe innerHTML assignment with dynamic expression",
    );
  });

  test("Case 3: String concatenation expression fails with exit code 1", async () => {
    const res = await runLinter("container.innerHTML = a + b;");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(
      "Unsafe innerHTML assignment with dynamic expression 'a + b'",
    );
  });

  test("Case 4: Static string literal passes with exit code 0", async () => {
    const res = await runLinter('container.innerHTML = "<div>static</div>";');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Zero unsafe innerHTML assignments");
  });

  test("Case 5: Explicitly annotated assignment passes with exit code 0", async () => {
    const res = await runLinter(
      "container.innerHTML = untrusted; // sanitized: SEC-101 — trusted upstream render",
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Zero unsafe innerHTML assignments");
  });

  test("Case 6: Double-escaped quotes from a TS template literal pass", async () => {
    const res = await runLinter(
      String.raw`container.innerHTML = "<p style=\\"padding:1rem\\">missing</p>";`,
    );
    expect(res.exitCode).toBe(0);
  });

  test("Case 7: An escaped quote does not hide a concatenation", async () => {
    const res = await runLinter(
      String.raw`container.innerHTML = "<p>\\" + untrusted + "</p>";`,
    );
    expect(res.exitCode).toBe(1);
  });
});

/**
 * Bun.markdown.html()/render() pass raw HTML and attributes through unsanitized (the native
 * renderer is not a sanitizer), so the gate treats every render call as a sink unless it carries a
 * `// trusted-markdown:` annotation. Help text that merely names the API is not a call.
 */
describe("check-innerhtml Bun.markdown sink coverage", () => {
  async function runSource(
    source: string,
  ): Promise<{ exitCode: number; stdout: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "check-innerhtml-md-"));
    try {
      await Bun.write(path.join(root, "lib/scratch.ts"), source);
      const proc = Bun.spawnSync(
        [
          process.execPath,
          path.join(import.meta.dir, "../bin/check-innerhtml.ts"),
          root,
        ],
        { env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" } },
      );
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const wrap = (body: string): string =>
    `export function render(untrusted: string) {\n${body}\n}\n`;

  test("an unannotated Bun.markdown.html() call fails the gate", async () => {
    const res = await runSource(wrap(`  return Bun.markdown.html(untrusted);`));
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Unsafe Bun.markdown render sink");
  });

  test("an unannotated Bun.markdown.render() call fails the gate", async () => {
    const res = await runSource(
      wrap(`  return Bun.markdown.render(untrusted, {});`),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Unsafe Bun.markdown render sink");
  });

  test("a same-line trusted-markdown annotation passes", async () => {
    const res = await runSource(
      wrap(
        `  return Bun.markdown.html(untrusted); // trusted-markdown: fixture only`,
      ),
    );
    expect(res.exitCode).toBe(0);
  });

  test("a preceding-line trusted-markdown annotation passes", async () => {
    const res = await runSource(
      wrap(
        `  // trusted-markdown: repo-owned markdown only\n  return Bun.markdown.html(untrusted);`,
      ),
    );
    expect(res.exitCode).toBe(0);
  });

  test("help text that names the renderer is not a sink", async () => {
    const res = await runSource(
      wrap('  return "--html   Bun.markdown.html() + DOCS_RENDER_OPTIONS";'),
    );
    expect(res.exitCode).toBe(0);
  });
});
