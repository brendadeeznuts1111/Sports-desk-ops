/**
 * Bun Shell (`Bun.$`) contract, measured on Bun 1.4.4 (2026-11-04).
 *
 * The tag is lazy; output methods on the awaited `ShellOutput` are synchronous; `.lines()` is
 * the async iterator (the promise itself is not iterable); an output method implicitly quiets,
 * while a bare await echoes to the parent stdout; `ShellError` carries Buffer stdout/stderr.
 *
 * Policy: the tag is tooling-only (`scripts/`, `bin/`) and every use captures its output or
 * calls `.quiet()`. Library and daemon code (`lib/`, `services/`, `cli/`) uses Bun.spawn with an
 * argv array, and credentials/TTY reads never use a shell (lib/f402_credentials_policy.ts).
 */
import { describe, expect, test } from "bun:test";
import { $ as namedDollar } from "bun";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSourceFiles } from "../lib/source_files.ts";

// @bun-behavior: bun-shell-globals

const ROOT = join(import.meta.dir, "..");
const LIBRARY_ROOTS = ["lib", "services", "cli"];
const TOOLING_ROOTS = ["scripts", "bin"];
const ALL_ROOTS = [...LIBRARY_ROOTS, ...TOOLING_ROOTS];
const SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"] as const;
const QUIETING_METHODS = new Set([
  "quiet",
  "text",
  "json",
  "bytes",
  "arrayBuffer",
  "blob",
  "lines",
]);

/** Comments and string/template literals are not call sites (`Bun.${name}` is not `Bun.$`); keep `"bun"` for import matching. */
function codeOnly(text: string): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.|(?:\$(?!\{))|\$\{(?:[^{}]|\{[^}]*\})*\})*`/g,
    (token) => {
      if (token.startsWith("/*") || token.startsWith("//")) return "";
      if (token === '"bun"' || token === "'bun'") return token;
      if (token.startsWith('"')) return '""';
      if (token.startsWith("'")) return "''";
      return "``";
    },
  );
}

/** Collect method names chained directly onto a `$`` ` invocation. */
function readChainedMethods(code: string, startIndex: number): string[] {
  const methods: string[] = [];
  let cursor = startIndex;
  while (cursor < code.length) {
    while (cursor < code.length && /\s/.test(code[cursor]!)) cursor++;
    if (code[cursor] !== ".") break;
    cursor++;
    while (cursor < code.length && /\s/.test(code[cursor]!)) cursor++;
    const nameMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(cursor));
    if (!nameMatch) break;
    methods.push(nameMatch[1]!);
    cursor += nameMatch[0].length;
    let depth = 1;
    while (cursor < code.length && depth > 0) {
      const ch = code[cursor]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      cursor++;
    }
  }
  return methods;
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

  test("quoted text and ${} interpolations stay literal and ignore extglob/brace ranges", async () => {
    const { $ } = await import("bun");
    expect(await $`printf "%s|%s" "*(1).txt" "{1..3}"`.text()).toBe(
      "*(1).txt|{1..3}",
    );
    const pat1 = "*(1).txt";
    const pat2 = "{1..3}";
    expect(await $`printf "%s|%s" ${pat1} ${pat2}`.text()).toBe(
      "*(1).txt|{1..3}",
    );
  });

  test("named export identity and auto-escaping prevent shell injection", async () => {
    expect(namedDollar).toBe(Bun.$);
    const injected = "foo; echo PWNED";
    const out = await namedDollar`printf %s ${injected}`.quiet().text();
    expect(out).toBe("foo; echo PWNED");
  });

  test("quoted flag strings are single args unless wrapped with { raw }", async () => {
    const flags = "-n hello";
    expect(await namedDollar`echo ${flags}`.quiet().text()).toBe("-n hello\n");
    expect(await namedDollar`echo ${{ raw: flags }}`.quiet().text()).toBe(
      "hello",
    );
  });

  test("streams directly from Response, Buffer, and Blob without temp files", async () => {
    const payload = "alpha\nbeta\ngamma\n";
    expect(
      await namedDollar`grep beta < ${new Response(payload)}`.quiet().text(),
    ).toBe("beta\n");
    expect(
      await namedDollar`grep beta < ${Buffer.from(payload)}`.quiet().text(),
    ).toBe("beta\n");
    expect(
      await namedDollar`grep beta < ${new Blob([payload])}`.quiet().text(),
    ).toBe("beta\n");
  });

  test(".env(), .cwd(), and .nothrow().quiet() scope execution cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-shell-cwd-"));
    const realDir = realpathSync(dir);
    try {
      const envOut = await namedDollar`printf %s "$SPORTSDESK_SHELL_SCOPED"`
        .env({ ...process.env, SPORTSDESK_SHELL_SCOPED: "scoped-ok" })
        .quiet()
        .text();
      expect(envOut).toBe("scoped-ok");
      expect(process.env.SPORTSDESK_SHELL_SCOPED).toBeUndefined();

      const cwdOut = (
        await namedDollar`pwd`.cwd(realDir).quiet().text()
      ).trim();
      expect(cwdOut).toBe(realDir);

      const res = await namedDollar`exit 42`.nothrow().quiet();
      expect(res.exitCode).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the tag is tooling-only and always captures or quiets", async () => {
    const files = (await listSourceFiles(ROOT, SOURCE_EXTENSIONS)).filter(
      (entry) => ALL_ROOTS.some((root) => entry.startsWith(`${root}/`)),
    );
    const libraryOffenders: string[] = [];
    const uncapturedToolingOffenders: string[] = [];
    const inspectedTooling: string[] = [];
    // The tag is reachable only through `Bun.$` or an imported `$`; matching the bare
    // `$` + backtick shape would also match regex template literals that end in `$`.
    const importTag =
      /import\s*\{[^}]*(?:^|[,{\s])\$(?=\s*[,}]|\s+as\b)[^}]*\}\s*from\s*["']bun["']|\{[^}]*(?:^|[,{\s])\$(?=\s*[,}]|\s*:\s*\w)[^}]*\}\s*=\s*await\s+import\(\s*["']bun["']\s*\)/;

    for (const path of files) {
      const text = codeOnly(await Bun.file(join(ROOT, path)).text());
      const usesTag = /Bun\.\$(?!\{)/.test(text) || importTag.test(text);
      if (!usesTag) continue;

      if (LIBRARY_ROOTS.some((root) => path.startsWith(`${root}/`))) {
        libraryOffenders.push(path);
        continue;
      }

      // Presence pins in bin/bun_surface.ts read Bun.$ / $.escape / $.braces; they never invoke
      // the template tag (see docs/bun-upstream-reference.md "Bun.$ — argv-only for credentials").
      if (path === "bin/bun_surface.ts") continue;

      inspectedTooling.push(path);
      const invocations = [...text.matchAll(/(?:Bun\.)?\$``/g)];
      if (invocations.length === 0) {
        uncapturedToolingOffenders.push(path);
        continue;
      }
      for (const match of invocations) {
        const methods = readChainedMethods(
          text,
          (match.index ?? 0) + match[0].length,
        );
        if (!methods.some((name) => QUIETING_METHODS.has(name))) {
          uncapturedToolingOffenders.push(path);
        }
      }
    }

    expect(libraryOffenders).toEqual([]);
    expect(uncapturedToolingOffenders).toEqual([]);
    expect(inspectedTooling).toContain("scripts/compute_dump_lag.ts");
  });
});
