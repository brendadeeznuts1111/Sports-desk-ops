/**
 * @file tests/bun_strict_codegen_and_jsc.test.ts
 * @description Contracts for Bun v1.4.4 `--disallow-code-generation-from-strings=strict`
 * (runtime + `--compile` executables) and the v1.4.4 JavaScriptCore semantic fixes.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

interface ImportProbeResult {
  readonly ok: boolean;
  readonly val?: unknown;
  readonly err?: string;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("--disallow-code-generation-from-strings=strict (v1.4.4)", () => {
  test("runtime mode blocks eval, data: JS, plugin contents, and macros while allowing disk files, data: JSON, and plugin exports", () => {
    const dir = makeTempDir("bun-strict-codegen-");
    try {
      const diskJsPath = join(dir, "disk.js");
      writeFileSync(diskJsPath, "export const ok = 42;\n");

      const runnerPath = join(dir, "non_compiled.ts");
      const runnerSource = [
        "const out: Record<string, unknown> = {};",
        "try {",
        '  out.eval = eval("1 + 1");',
        "} catch (e) {",
        '  out.eval = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "try {",
        `  out.diskJs = (await import(${JSON.stringify(diskJsPath)})).ok;`,
        "} catch (e) {",
        '  out.diskJs = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "try {",
        '  out.dataJs = (await import("data:text/javascript,export default 8")).default;',
        "} catch (e) {",
        '  out.dataJs = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "try {",
        '  out.dataJsonPct = (await import("data:application/json,%7B%22j%22%3A7%7D", { with: { type: "json" } })).default;',
        "} catch (e) {",
        '  out.dataJsonPct = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "try {",
        '  out.dataJsonBase64 = (await import("data:application/json;base64,eyJqIjo3fQ==", { with: { type: "json" } })).default;',
        "} catch (e) {",
        '  out.dataJsonBase64 = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "await Bun.plugin({",
        '  name: "strict-codegen-probe",',
        "  setup(build) {",
        '    build.onResolve({ filter: /^virt:/ }, (args) => ({ path: args.path.slice(5), namespace: "virt" }));',
        '    build.onLoad({ filter: /^js-contents$/, namespace: "virt" }, () => ({ contents: "export const a = 1;", loader: "js" }));',
        '    build.onLoad({ filter: /^json-contents$/, namespace: "virt" }, () => ({ contents: \'{"z":9}\', loader: "json" }));',
        '    build.onLoad({ filter: /^exports-obj$/, namespace: "virt" }, () => ({ exports: { b: 2 }, loader: "object" }));',
        "  },",
        "});",
        "try {",
        '  out.pluginJsContents = (await import("virt:js-contents")).a;',
        "} catch (e) {",
        '  out.pluginJsContents = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "try {",
        '  out.pluginJsonContents = (await import("virt:json-contents")).default;',
        "} catch (e) {",
        '  out.pluginJsonContents = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "try {",
        '  out.pluginExports = (await import("virt:exports-obj")).b;',
        "} catch (e) {",
        '  out.pluginExports = (e as Error).name + ": " + (e as Error).message;',
        "}",
        "console.log(JSON.stringify(out));",
      ].join("\n");
      writeFileSync(runnerPath, runnerSource);

      const runResult = Bun.spawnSync(
        [
          process.execPath,
          "--disallow-code-generation-from-strings=strict",
          runnerPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(runResult.exitCode).toBe(0);

      const parsed = JSON.parse(runResult.stdout.toString()) as {
        eval: string;
        diskJs: number;
        dataJs: string;
        dataJsonPct: { j: number };
        dataJsonBase64: { j: number };
        pluginJsContents: string;
        pluginJsonContents: string;
        pluginExports: number;
      };

      expect(parsed.eval).toContain("EvalError");
      expect(parsed.eval).toContain(
        "Code generation from strings disallowed for this context",
      );
      expect(parsed.diskJs).toBe(42);
      expect(parsed.dataJs).toContain("EvalError");
      expect(parsed.dataJsonPct).toEqual({ j: 7 });
      expect(parsed.dataJsonBase64).toEqual({ j: 7 });
      expect(parsed.pluginJsContents).toContain("EvalError");
      expect(parsed.pluginJsonContents).toContain("EvalError");
      expect(parsed.pluginExports).toBe(2);

      // Macros are blocked under --disallow-code-generation-from-strings=strict.
      writeFileSync(
        join(dir, "macro.ts"),
        "export function m() { return 99; }\n",
      );
      const useMacroPath = join(dir, "use_macro.ts");
      writeFileSync(
        useMacroPath,
        'import { m } from "./macro.ts" with { type: "macro" };\nconsole.log(m());\n',
      );
      const macroResult = Bun.spawnSync(
        [
          process.execPath,
          "--disallow-code-generation-from-strings=strict",
          useMacroPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(macroResult.exitCode).toBe(1);
      expect(macroResult.stderr.toString()).toContain(
        "Macros cannot be used with --disallow-code-generation-from-strings=strict",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compiled binary with =strict blocks disk JS/txt/md and BUN_OPTIONS --preload while allowing disk JSON/TOML/YAML and data: JSON", () => {
    const dir = makeTempDir("bun-strict-compiled-");
    try {
      writeFileSync(join(dir, "data.json"), '{"k":1}\n');
      writeFileSync(join(dir, "data.toml"), "k = 2\n");
      writeFileSync(join(dir, "data.yaml"), "k: 3\n");
      writeFileSync(join(dir, "note.txt"), "hello-txt\n");
      writeFileSync(join(dir, "note.md"), "# hi\n");

      const preloadPath = join(dir, "preload.js");
      writeFileSync(preloadPath, "globalThis.__PRELOADED = true;\n");

      const entryPath = join(dir, "entry.ts");
      const entrySource = [
        "const base = process.argv[2] as string;",
        "const out: Record<string, unknown> = {};",
        "async function tryImp(spec: string, withJson = false) {",
        "  try {",
        "    const mod = withJson",
        '      ? await import(spec, { with: { type: "json" } })',
        "      : await import(spec);",
        "    return { ok: true, val: mod.default ?? mod.ok ?? Object.keys(mod) };",
        "  } catch (e) {",
        '    return { ok: false, err: (e as Error).name + ": " + (e as Error).message };',
        "  }",
        "}",
        'const dynPath = base + "/written_at_runtime.js";',
        'await Bun.write(dynPath, "export const ok = 123;");',
        "out.diskJs = await tryImp(dynPath);",
        'out.diskTxt = await tryImp(base + "/note.txt");',
        'out.diskMd = await tryImp(base + "/note.md");',
        'out.diskJson = await tryImp(base + "/data.json");',
        'out.diskToml = await tryImp(base + "/data.toml");',
        'out.diskYaml = await tryImp(base + "/data.yaml");',
        'out.dataJson = await tryImp("data:application/json,%7B%22j%22%3A7%7D", true);',
        "console.log(JSON.stringify(out));",
      ].join("\n");
      writeFileSync(entryPath, entrySource);

      const binPath = join(dir, "strict-app");
      const buildResult = Bun.spawnSync(
        [
          process.execPath,
          "build",
          entryPath,
          "--compile",
          "--compile-exec-argv=--disallow-code-generation-from-strings=strict",
          "--outfile",
          binPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(buildResult.exitCode).toBe(0);

      const execResult = Bun.spawnSync([binPath, dir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(execResult.exitCode).toBe(0);

      const parsed = JSON.parse(execResult.stdout.toString()) as {
        diskJs: ImportProbeResult;
        diskTxt: ImportProbeResult;
        diskMd: ImportProbeResult;
        diskJson: ImportProbeResult;
        diskToml: ImportProbeResult;
        diskYaml: ImportProbeResult;
        dataJson: ImportProbeResult;
      };

      expect(parsed.diskJs.ok).toBe(false);
      expect(parsed.diskJs.err).toContain("EvalError");
      expect(parsed.diskTxt.ok).toBe(false);
      expect(parsed.diskTxt.err).toContain("EvalError");
      expect(parsed.diskMd.ok).toBe(false);
      expect(parsed.diskMd.err).toContain("EvalError");

      expect(parsed.diskJson).toEqual({ ok: true, val: { k: 1 } });
      expect(parsed.diskToml).toEqual({ ok: true, val: { k: 2 } });
      expect(parsed.diskYaml).toEqual({ ok: true, val: { k: 3 } });
      expect(parsed.dataJson).toEqual({ ok: true, val: { j: 7 } });

      // BUN_OPTIONS=--preload is rejected before main executes.
      const preloadResult = Bun.spawnSync([binPath, dir], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Bun.env,
          BUN_OPTIONS: `--preload=${preloadPath}`,
        },
      });
      expect(preloadResult.exitCode).toBe(1);
      expect(preloadResult.stderr.toString()).toContain("EvalError");
      expect(preloadResult.stdout.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("package.json shadow-price compiled build scripts wire =strict", async () => {
    const pkg = (await Bun.file(
      join(import.meta.dir, "..", "package.json"),
    ).json()) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["points:shadow-price:build"]).toContain(
      "--compile-exec-argv=--disallow-code-generation-from-strings=strict",
    );
    expect(pkg.scripts?.["points:shadow-price:analyze"]).toContain(
      "--compile-exec-argv=--disallow-code-generation-from-strings=strict",
    );
  });
});

describe("JavaScriptCore v1.4.4 semantic contracts", () => {
  test('toLocaleString("en-US") without options matches Intl.NumberFormat for numbers and BigInts', () => {
    const formatter = new Intl.NumberFormat("en-US");
    expect((1_234_567).toLocaleString("en-US")).toBe("1,234,567");
    expect((1_234_567).toLocaleString("en-US")).toBe(
      formatter.format(1_234_567),
    );
    expect(12345678901234567890n.toLocaleString("en-US")).toBe(
      "12,345,678,901,234,567,890",
    );
    expect(12345678901234567890n.toLocaleString("en-US")).toBe(
      formatter.format(12345678901234567890n),
    );
  });

  test("using is allowed inside a function nested in a switch case", () => {
    let disposed = false;
    const selector = 1;
    let out = 0;

    switch (selector) {
      case 1: {
        function runWithResource(): number {
          using _resource = {
            [Symbol.dispose]() {
              disposed = true;
            },
          };
          return 42;
        }
        out = runWithResource();
        break;
      }
      default: {
        break;
      }
    }

    expect(out).toBe(42);
    expect(disposed).toBe(true);
  });

  test("+1n * 2n throws TypeError in both JSC VM execution and Bun transpiler", () => {
    let vmErr: unknown = null;
    try {
      runInNewContext("+1n * 2n");
    } catch (error) {
      vmErr = error;
    }
    expect(vmErr).toBeTruthy();
    expect((vmErr as Error).name).toBe("TypeError");
    expect((vmErr as Error).message).toContain(
      "Conversion from 'BigInt' to 'number' is not allowed.",
    );

    const cliProbe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        "try { console.log(+1n * 2n); } catch (e) { console.log((e as Error).name); }",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(cliProbe.exitCode).toBe(0);
    expect(cliProbe.stdout.toString().trim()).toBe("TypeError");
  });

  test("+a * b() evaluates a.valueOf() before calling b()", () => {
    const order: string[] = [];
    const a = {
      valueOf(): number {
        order.push("a.valueOf");
        return 3;
      },
    };
    const b = (): number => {
      order.push("b()");
      return 4;
    };

    const product = +(a as unknown as number) * b();
    expect(product).toBe(12);
    expect(order).toEqual(["a.valueOf", "b()"]);
  });

  test("for...in over a function visits indexed properties", () => {
    const fn = Object.assign(() => {}, { 0: "zero", foo: "bar" });
    const keys: string[] = [];
    for (const k in fn) {
      keys.push(k);
    }
    expect(keys).toEqual(["0", "foo"]);
  });

  test("JIT-optimized (x + y + 0.5) | 0 wraps 32-bit integer overflow accurately", () => {
    function addHalfOrZero(x: number, y: number): number {
      return (x + y + 0.5) | 0;
    }

    let acc = 0;
    for (let i = 0; i < 100_000; i++) {
      acc = addHalfOrZero(0x7fff_ffff, 1);
    }
    expect(acc).toBe(-2_147_483_648);
  });

  test("JIT-optimized unused new Uint8Array(-1) still throws RangeError", () => {
    function deadTypedArray(n: number): number {
      void new Uint8Array(n);
      return 1;
    }

    for (let i = 0; i < 100_000; i++) {
      expect(deadTypedArray(1)).toBe(1);
    }
    expect(() => deadTypedArray(-1)).toThrow(RangeError);
  });

  test("sloppy-mode label: function f() {} is hoisted", () => {
    const res = runInNewContext(
      "var before = typeof f; lbl: function f() { return 7; } [before, f()];",
    ) as unknown[];
    expect(res).toEqual(["function", 7]);
  });
});
