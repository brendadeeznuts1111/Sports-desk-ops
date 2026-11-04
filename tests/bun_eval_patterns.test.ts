import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasSecretsWrite } from "./support/capabilities.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pins the one-liner patterns in docs/bun-eval-pitfalls.md; each test name cites its section.
 *
 * Every assertion runs in a child: the behaviours involved are per-process (`-p` output, argv),
 * fatal (SIGBUS, exit 130) or hanging (unclosed stdin), and in-process they would kill or stall
 * the runner. Assert the safe pattern, never the quirk it avoids, so a Bun fix is not a failure.
 */

type ProbeOptions = {
  args?: string[];
  stdin?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  cwd?: string;
  timeoutMs?: number;
};

type ProbeResult = {
  out: string;
  err: string;
  code: number | null;
  signal: NodeJS.Signals | number | null;
  timedOut: boolean;
};

let scratch = tmpdir();

function probe(
  flag: "-e" | "-p",
  src: string,
  opts: ProbeOptions = {},
): ProbeResult {
  const env: Record<string, string | undefined> = { ...Bun.env };
  for (const key of opts.unsetEnv ?? []) delete env[key];
  Object.assign(env, opts.env);
  const p = Bun.spawnSync([process.execPath, flag, src, ...(opts.args ?? [])], {
    env,
    cwd: opts.cwd ?? scratch,
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    timeout: opts.timeoutMs ?? 10_000,
  });
  return {
    out: p.stdout.toString(),
    err: p.stderr.toString(),
    code: p.exitCode,
    signal: p.signalCode ?? null,
    timedOut: p.exitedDueToTimeout === true,
  };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bun-eval-patterns-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("bun -e / -p patterns (docs/bun-eval-pitfalls.md)", () => {
  test("eval-module-mode: import.meta.require keeps an ESM eval", () => {
    const r = probe(
      "-p",
      'typeof import.meta.require + " " + typeof import.meta.dir',
    );
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("function string");
  });

  test("eval-module-mode: static and dynamic import both resolve", () => {
    const r = probe(
      "-e",
      'import { dlopen } from "bun:ffi"; const m = await import("bun:ffi"); console.log(typeof dlopen, m.dlopen === dlopen)',
    );
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("function true");
  });

  test("eval-argv: parseArgs over Bun.argv.slice(1) after --", () => {
    const r = probe(
      "-e",
      'const { parseArgs } = await import("node:util"); const { values, positionals } = parseArgs({ args: Bun.argv.slice(1), options: { n: { type: "string" } }, allowPositionals: true }); console.log(JSON.stringify({ n: values.n, positionals }))',
      { args: ["--", "-n", "5", "tail"] },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ n: "5", positionals: ["tail"] });
  });

  test("eval-print-json: JSON.stringify keeps -p output parseable", () => {
    const r = probe("-p", 'JSON.stringify({ s: "hi", n: 1 })');
    expect(JSON.parse(r.out)).toEqual({ s: "hi", n: 1 });
    expect(JSON.parse(probe("-p", 'JSON.stringify("hi")').out)).toBe("hi");
  });

  test("main-guard: a module imported from an eval skips its main block", () => {
    const lib = join(scratch, "guarded.ts");
    writeFileSync(
      lib,
      'export const ready = true;\nif (import.meta.main) console.log("side-effect");\n',
    );
    const imported = probe(
      "-e",
      `const m = await import(${JSON.stringify(lib)}); console.log("imported", m.ready)`,
    );
    expect(imported.out.trim()).toBe("imported true");

    const direct = Bun.spawnSync([process.execPath, lib]);
    expect(direct.stdout.toString().trim()).toBe("side-effect");
  });

  describe("stdin-lines: text() + /\\r?\\n/ + drop the final empty element", () => {
    const numberLines =
      'const lines = (await Bun.stdin.text()).split(/\\r?\\n/); if (lines.at(-1) === "") lines.pop(); lines.forEach((l, i) => console.log(`${i + 1}: ${l}`))';
    const cases: [label: string, input: string, expected: string][] = [
      ["trailing newline", "a\nb\n", "1: a\n2: b\n"],
      ["no trailing newline", "a\nb", "1: a\n2: b\n"],
      ["CRLF", "a\r\nb\r\n", "1: a\n2: b\n"],
      ["empty input", "", ""],
      ["single blank line", "\n", "1: \n"],
      ["blank line kept", "a\n\n", "1: a\n2: \n"],
    ];
    for (const [label, input, expected] of cases) {
      test(label, () => {
        const r = probe("-e", numberLines, { stdin: input });
        expect(r.code).toBe(0);
        expect(r.out).toBe(expected);
      });
    }
  });

  describe("color-env: =1 is the only portable switch", () => {
    const clean = { unsetEnv: ["NO_COLOR", "FORCE_COLOR"] };
    const colors = (env: Record<string, string> = {}) =>
      probe("-e", "console.log(JSON.stringify(Bun.enableANSIColors))", {
        ...clean,
        env,
      }).out.trim();

    test("piped output is uncoloured by default", () => {
      expect(colors()).toBe("false");
    });
    test("FORCE_COLOR=1 enables colour when piped", () => {
      expect(colors({ FORCE_COLOR: "1" })).toBe("true");
    });
    test("NO_COLOR=1 keeps colour off", () => {
      expect(colors({ NO_COLOR: "1" })).toBe("false");
    });
  });

  test("mmap-truncate: a child isolates the fault from the caller", () => {
    const file = join(scratch, "mapped.bin");
    writeFileSync(file, Buffer.alloc(65_536, 0x61));
    const r = probe(
      "-e",
      `const m = Bun.mmap(${JSON.stringify(file)}); (await import("node:fs")).truncateSync(${JSON.stringify(file)}, 0); console.log(m[m.length - 1])`,
    );
    // Today this is SIGBUS (SIGSEGV on some kernels); a future Bun may throw instead. Either way
    // the child must not report success after reading past the end of a truncated file.
    expect(r.timedOut).toBe(false);
    expect(r.code === 0 && r.signal === null).toBe(false);
  });

  test("spawn-stdin-end: end() after the last write lets the child exit", () => {
    const r = probe(
      "-e",
      'const p = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe" }); p.stdin.write("hi\\n"); p.stdin.end(); console.log(JSON.stringify(await new Response(p.stdout).text()), await p.exited)',
      { timeoutMs: 5_000 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.out.trim()).toBe('"hi\\n" 0');
  });

  test("SIGINT handler owns the exit code", () => {
    const r = probe(
      "-e",
      'process.on("SIGINT", () => process.exit(130)); setTimeout(() => process.kill(process.pid, "SIGINT"), 50); await Bun.sleep(5_000)',
      { timeoutMs: 4_000 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(130);
  });

  test("archive-files: files() lists from bytes without touching disk", async () => {
    const tgz = join(scratch, "x.tgz");
    await Bun.write(
      tgz,
      new Bun.Archive({ "f.txt": "hi\n" }, { compress: "gzip" }),
    );

    const r = probe(
      "-p",
      `const f = await new Bun.Archive(await Bun.file(${JSON.stringify(tgz)}).bytes()).files(); JSON.stringify([[...f.keys()], await f.get("f.txt").text()])`,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([["f.txt"], "hi\n"]);
  });

  test("sql-sqlite-url: sqlite:// selects SQLite and binds parameters", () => {
    const r = probe(
      "-p",
      'const db = new Bun.SQL("sqlite://:memory:"); JSON.stringify([db.options.adapter, await db`select ${"a\'; drop table x; --"} as v`])',
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([
      "sqlite",
      [{ v: "a'; drop table x; --" }],
    ]);
  });

  test("shell-escape: $ interpolation stays one argument", () => {
    const r = probe(
      "-e",
      'const { $ } = await import("bun"); console.log((await $`printf %s ${"a; echo INJECTED"}`.text()))',
    );
    expect(r.out).toBe("a; echo INJECTED\n");
  });

  // Writes and deletes a uniquely named dummy entry; never reads the dx service. Keychain only:
  // libsecret is absent on headless Linux runners and Windows `persist: "local"` is unverified.
  test.skipIf(process.platform !== "darwin" || !hasSecretsWrite)(
    "Bun.secrets: set/get/delete round-trip, null when missing",
    () => {
      const r = probe(
        "-e",
        'const s = "dx-probe"; const name = Bun.randomUUIDv7(); let got; try { await Bun.secrets.set({ service: s, name, value: "v" }); got = await Bun.secrets.get({ service: s, name }); } finally { await Bun.secrets.delete({ service: s, name }); } console.log(JSON.stringify({ got, after: await Bun.secrets.get({ service: s, name }) }))',
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ got: "v", after: null });
    },
  );
});
