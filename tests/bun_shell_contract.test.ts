/**
 * Bun Shell (`Bun.$`) contract, measured on Bun 1.4.4 (2026-11-04).
 *
 * The tag is lazy; output methods on the awaited `ShellOutput` are synchronous; `.lines()` is
 * the async iterator (the promise itself is not iterable); an output method implicitly quiets,
 * while a bare await echoes to the parent stdout; `ShellError` carries Buffer stdout/stderr.
 *
 * Production source must not use the tag at all: interpolation routes bytes through a shell
 * parser (see lib/f402_credentials_policy.ts). Subprocess work uses Bun.spawn with an argv array.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");
const PRODUCTION_ROOTS = ["lib", "scripts", "services", "bin", "cli"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Comments and string/template literals are not call sites (`Bun.${name}` is not `Bun.$`). */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("Bun Shell contract", () => {
  test("the template tag starts no process until awaited", async () => {
    const { $ } = await import("bun");
    const marker = join(
      tmpdir(),
      `bun-shell-lazy-${process.pid}-${Date.now()}`,
    );
    const pending = $`touch ${marker}`.quiet();
    try {
      expect(await Bun.file(marker).exists()).toBe(false);
      await pending;
      expect(await Bun.file(marker).exists()).toBe(true);
    } finally {
      await $`rm -f ${marker}`.quiet().nothrow();
    }
  });

  test("ShellOutput methods are synchronous, ShellPromise mirrors them", async () => {
    const { $ } = await import("bun");
    const output = await $`printf 'alpha\nbeta\n'`.quiet();
    expect(output.text()).toBe("alpha\nbeta\n");
    expect(output.bytes()).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(output.bytes()).toString("utf8")).toBe("alpha\nbeta\n");
    expect(output.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
    expect(typeof output.blob()).toBe("object");
    expect(await $`printf '{"ok":true}'`.json()).toEqual({ ok: true });

    const pending = $`true`;
    expect(pending.text()).toBeInstanceOf(Promise);
    for (const method of [
      "lines",
      "quiet",
      "nothrow",
      "throws",
      "cwd",
      "env",
    ] as const) {
      expect(typeof pending[method]).toBe("function");
    }
  });

  test("lines() is the async iterable and keeps the trailing empty line", async () => {
    const { $ } = await import("bun");
    const lines: string[] = [];
    for await (const line of $`printf 'one\ntwo\nthree\n'`.lines()) {
      lines.push(line);
    }
    expect(lines).toEqual(["one", "two", "three", ""]);
  });

  test("ShellError carries exitCode and Buffer stdout/stderr", async () => {
    const { $ } = await import("bun");
    let caught: unknown = null;
    try {
      await $`sh -c 'echo OUT; echo ERR >&2; exit 3'`.quiet();
    } catch (error) {
      caught = error;
    }
    const shellError = caught as {
      name: string;
      exitCode: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    expect(shellError.name).toBe("ShellError");
    expect(shellError.exitCode).toBe(3);
    expect(Buffer.isBuffer(shellError.stdout)).toBe(true);
    expect(Buffer.isBuffer(shellError.stderr)).toBe(true);
    expect(shellError.stdout.toString().trim()).toBe("OUT");
    expect(shellError.stderr.toString().trim()).toBe("ERR");
  });

  test("an output method quiets, a bare await echoes to the parent stdout", async () => {
    const run = async (code: string): Promise<string> => {
      const child = Bun.spawn([process.execPath, "-e", code], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.exited;
      return await new Response(child.stdout).text();
    };

    const captured = await run(
      'import { $ } from "bun"; const text = await $`echo CAPTURED`.text(); console.log("TEXT:" + text.trim());',
    );
    expect(captured.trim()).toBe("TEXT:CAPTURED");

    const bare = await run(
      'import { $ } from "bun"; await $`echo BARE-ECHO`; console.log("DONE");',
    );
    expect(bare).toContain("BARE-ECHO");
    expect(bare).toContain("DONE");
  });

  test("production source does not use the shell tag", async () => {
    const listed = Bun.spawnSync({
      cmd: ["git", "ls-files", ...PRODUCTION_ROOTS],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (listed.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
    }
    const offenders: string[] = [];
    // The tag is reachable only through `Bun.$` or an imported `$`; matching the bare
    // `$` + backtick shape would also match regex template literals that end in `$`.
    const importTag =
      /import\s*\{[^}]*\b\$\b[^}]*\}\s*from\s*["']bun["']|\{\s*\$\s*\}\s*=\s*await\s+import\(\s*["']bun["']\s*\)/;
    for (const path of listed.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((entry) =>
        SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)),
      )) {
      const text = codeOnly(await Bun.file(join(ROOT, path)).text());
      if (/Bun\.\$(?!\{)/.test(text) || importTag.test(text))
        offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
