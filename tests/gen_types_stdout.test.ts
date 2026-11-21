import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function runStdin(input: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(
    [process.execPath, "run", "--silent", "gen:types:stdout"],
    {
      cwd: ROOT,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("gen:types:stdout", () => {
  test("formats generated TypeScript from stdin", async () => {
    const result = await runStdin(
      "type A={x:number}\nconst f=(a:A)=>({...a})\n",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "type A = { x: number };\nconst f = (a: A) => ({ ...a });\n",
    );
    expect(result.stderr).toBe("");
  });

  test("resolves the repo bunfig printWidth", async () => {
    const result = await runStdin(
      'const result = someFunction("aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccc", "dddddddddddddddddddd");\n',
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      80,
    );
  });

  test("fails with no stdout on invalid TypeScript", async () => {
    const result = await runStdin("type {\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
  });

  test("does not write types.ts", async () => {
    await runStdin("type B = { y: string };\n");
    expect(existsSync(join(ROOT, "types.ts"))).toBe(false);
  });

  test("works through a shell pipeline", () => {
    const proc = Bun.spawnSync({
      cmd: [
        "bash",
        "-lc",
        "printf 'type C={z:boolean}\\n' | bun run --silent gen:types:stdout",
      ],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("type C = { z: boolean };\n");
  });
});
