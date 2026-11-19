import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TYPECHECK_EXTENSIONS,
  isTypecheckable,
  parseStagedFiles,
  typecheckableStagedFiles,
} from "../lib/staged_check.ts";

/**
 * `bun check` has no `--staged` flag, so the staged set comes from git. These cases pin the three
 * behaviours that make the script safe to run from a pre-commit hook:
 *
 * - an empty staged set exits 0 **without** invoking `bun check` (a bare `bun check` type-checks the
 *   whole project instead of nothing);
 * - a path containing a space survives, because the listing is NUL-separated;
 * - a staged type error exits nonzero, so the hook blocks the commit.
 */

const ROOT = join(import.meta.dir, "..");

const spawnCheck = (root: string) => {
  const result = Bun.spawnSync(
    ["bun", "run", "scripts/check_staged.ts", "--root", root],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  // `bun check` writes its success summary to stderr and type errors to stdout. Assertions target
  // substrings that contain no colour run, because `verify:fast` forces ANSI on the child; stripping
  // the codes with a regex literal trips the native linter's no-control-regex rule.
  return {
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
};

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ["**/*.ts"],
  },
  null,
  2,
);

const tempRepo = async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-staged-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
  git(["init", "-q"]);
  await writeFile(join(repo, "tsconfig.json"), `${TSCONFIG}\n`);
  // Left unstaged on purpose: each case stages exactly the file it wants counted.
  await writeFile(join(repo, "kept.ts"), "export const kept: number = 1;\n");
  return { repo, git };
};

describe("staged file selection", () => {
  test("only TypeScript extensions are checked", () => {
    for (const extension of TYPECHECK_EXTENSIONS) {
      expect(isTypecheckable(`src/file${extension}`)).toBe(true);
    }
    for (const path of ["README.md", "data/x.json", "scripts/x.sh"]) {
      expect(isTypecheckable(path)).toBe(false);
    }
  });

  test("parses NUL-separated git output and sorts what it keeps", () => {
    expect(parseStagedFiles("b.ts\0a.ts\0\0")).toEqual(["b.ts", "a.ts"]);
    expect(parseStagedFiles("")).toEqual([]);
    expect(typecheckableStagedFiles(["b.ts", "notes.md", "a.tsx"])).toEqual([
      "a.tsx",
      "b.ts",
    ]);
  });
});

describe("scripts/check_staged.ts", () => {
  test("nothing staged exits 0 without widening to the whole project", async () => {
    const { repo } = await tempRepo();

    const result = spawnCheck(repo);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("nothing to check");
    // A project-wide run would report a file count; the skip must not.
    expect(result.output).not.toContain("No type errors");
  });

  test("a clean staged file passes", async () => {
    const { repo, git } = await tempRepo();
    await writeFile(join(repo, "ok.ts"), "export const ok: string = 'x';\n");
    git(["add", "ok.ts"]);

    const result = spawnCheck(repo);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("in 1 file");
  });

  test("a staged type error fails the check", async () => {
    const { repo, git } = await tempRepo();
    await writeFile(
      join(repo, "bad.ts"),
      "export const bad: number = 'nope';\n",
    );
    git(["add", "bad.ts"]);

    const result = spawnCheck(repo);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("TS2322");
  });

  test("a staged path containing a space is not split", async () => {
    const { repo, git } = await tempRepo();
    const spaced = join(repo, "a b.ts");
    await writeFile(spaced, "export const spaced: number = 2;\n");
    git(["add", "a b.ts"]);

    const result = spawnCheck(repo);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("in 1 file");
  });

  test("the pre-commit hook formats first, then type-checks", async () => {
    const hook = await Bun.file(join(ROOT, ".githooks", "pre-commit")).text();
    const formatAt = hook.indexOf("bun fmt --staged");
    const checkAt = hook.indexOf("exec bun run scripts/check_staged.ts");
    expect(formatAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(formatAt);
  });
});
