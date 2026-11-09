import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Gate Integrity Meta-Test for check-signal-honesty
 * Verifies that bin/check-signal-honesty.ts accurately detects:
 * 1. Generic throw new Error("failed") (must fail, exit 1)
 * 2. Generic throw new Error("error") (must fail, exit 1)
 * 3. Silent catch returning [] (must fail, exit 1)
 * 4. Descriptive throw with subsystem/cause (must pass, exit 0)
 * 5. Annotated intentional swallow with comment (must pass, exit 0)
 */

describe("check-signal-honesty meta-test suite", () => {
  async function runLinter(
    codeSnippet: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "check-signal-honesty-"));
    try {
      const content = `// Scratch test\nexport function test() {\n  ${codeSnippet}\n}\n`;
      await Bun.write(path.join(root, "lib/scratch.ts"), content);

      const proc = Bun.spawnSync(
        [
          process.execPath,
          path.join(import.meta.dir, "../bin/check-signal-honesty.ts"),
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
        stderr: proc.stderr.toString(),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("Case 1: Generic throw new Error('failed') fails with exit code 1", async () => {
    const res = await runLinter('throw new Error("failed");');
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Generic error throw");
    expect(res.stdout).toContain("docs/architecture/signal-honesty.md");
  });

  test("Case 2: Generic throw new Error('error') fails with exit code 1", async () => {
    const res = await runLinter('throw new Error("error");');
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Generic error throw");
  });

  test("Case 3: Silent catch returning [] fails with exit code 1", async () => {
    const res = await runLinter("try { doWork(); } catch (e) { return []; }");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Silent catch");
  });

  test("Case 4: Descriptive error throw passes with exit code 0", async () => {
    const res = await runLinter(
      'throw new Error("getBetTicker failed: HTTP 401 Unauthorized from /cloud/api/Manager");',
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Zero signal honesty violations");
  });

  test("Case 5: Annotated intentional swallow passes with exit code 0", async () => {
    const res = await runLinter(
      "try { doWork(); } catch (e) { return []; } // signal-honesty: intentional-cache-miss",
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Zero signal honesty violations");
  });
});
