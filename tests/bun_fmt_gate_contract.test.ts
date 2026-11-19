import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `bun run format:check` is the format gate in the CI chain, and it is only a gate because of three
 * exit codes that nothing else in the repo pins. Measured on the pinned Bun 1.4.4:
 *
 * - `bun fmt --check <file>` exits **1** and names the file when it needs formatting.
 * - the same command exits **0** on a formatted file.
 * - a Prettier config naming a plugin `bun fmt` does not include prints
 *   `… because the Prettier config uses plugins that bun fmt does not include: <plugin>` and exits
 *   **2**, suggesting `--allow-unsupported`.
 *
 * The last one matters because 2 is not 1: a plugin added to a Prettier config later makes the gate
 * fail without any file being misformatted, and the message is the only thing that says why.
 *
 * Release notes: bun.com/blog/release-notes/bun-v1.4.4 §"Prettier's Tailwind, package.json and
 * Svelte plugins are built in".
 */

const SCRATCH = mkdtempSync(path.join(tmpdir(), "bun-fmt-gate-"));
const ROOT = path.join(import.meta.dir, "..");

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function fmt(args: readonly string[], cwd: string): Run {
  const proc = Bun.spawnSync([process.execPath, "fmt", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

async function project(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const dir = mkdtempSync(path.join(SCRATCH, "p-"));
  await Promise.all(
    Object.entries(files).map(([name, body]) =>
      Bun.write(path.join(dir, name), body),
    ),
  );
  return dir;
}

describe("bun fmt --check exit codes", () => {
  test("a file that needs formatting exits 1 and is named", async () => {
    const dir = await project({ "dirty.ts": "const x = { a:1,   b:2 };\n" });
    const result = fmt(["--check", "dirty.ts"], dir);
    expect(result.code).toBe(1);
    // The file list is stdout; the summary that a CI log shows is stderr.
    expect(result.out).toContain("dirty.ts");
    expect(result.err).toContain("needs formatting");
  });

  test("a formatted file exits 0", async () => {
    const dir = await project({ "clean.ts": "const x = { a: 1, b: 2 };\n" });
    expect(fmt(["--check", "clean.ts"], dir).code).toBe(0);
  });
});

describe("bun fmt and an unsupported Prettier plugin", () => {
  test("exits 2, names the plugin, and offers --allow-unsupported", async () => {
    const dir = await project({
      ".prettierrc.json": '{"plugins":["prettier-plugin-jsdoc"]}\n',
      "doc.ts": "/** doc */\nconst y = 1;\n",
    });
    const result = fmt(["doc.ts"], dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      "plugins that bun fmt does not include: prettier-plugin-jsdoc",
    );
    expect(result.err).toContain("--allow-unsupported");
  });
});

describe("the repo's format gate definition", () => {
  test("format:check checks, and does not rewrite", async () => {
    const pkg = (await Bun.file(path.join(ROOT, "package.json")).json()) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.["format:check"] ?? "";
    expect(script).toContain("bun fmt");
    expect(script).toContain("--check");
    // A gate that writes would report success after fixing the tree it was meant to judge.
    expect(script).not.toMatch(/bun fmt\s*$/);
  });

  test("the repo ships no Prettier or oxfmt config, so plugins cannot trip the gate", async () => {
    for (const candidate of [
      ".prettierrc",
      ".prettierrc.json",
      "prettier.config.js",
      "prettier.config.ts",
      ".oxfmtrc.json",
    ]) {
      expect(await Bun.file(path.join(ROOT, candidate)).exists()).toBe(false);
    }
    const pkg = (await Bun.file(path.join(ROOT, "package.json")).json()) as {
      prettier?: unknown;
    };
    expect(pkg.prettier).toBeUndefined();
  });
});
