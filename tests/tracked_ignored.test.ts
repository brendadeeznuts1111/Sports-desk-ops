import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TRACKED_IGNORED_ALLOWLIST,
  parseTrackedIgnored,
  unexpectedTrackedIgnored,
} from "../lib/tracked_ignored.ts";

/**
 * A tracked file matching `.gitignore` was force-added, or the rule arrived later. Either way the
 * tree ships something it declared it would not, and the rule stops protecting anyone — this is how
 * a generated 874 KB report and eight scratch benchmarks stayed in the repository.
 *
 * Git answers the question directly, so the check shells `git ls-files -i -c --exclude-standard`;
 * these cases pin the parser and exercise the CLI against a repository that has such a file.
 */

const ROOT = join(import.meta.dir, "..");

const spawnGate = (root: string) =>
  Bun.spawnSync(
    ["bun", "run", "scripts/check_tracked_ignored.ts", "--root", root],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

describe("parseTrackedIgnored", () => {
  test("parses nul-separated git output, sorted, ignoring empties", () => {
    expect(parseTrackedIgnored("b\0a\0\0")).toEqual(["a", "b"]);
    expect(parseTrackedIgnored("")).toEqual([]);
  });

  test("the allowlist starts empty so every hit needs a decision", () => {
    expect(TRACKED_IGNORED_ALLOWLIST).toEqual([]);
    expect(unexpectedTrackedIgnored(["out/x.txt"])).toEqual(["out/x.txt"]);
  });
});

describe("scripts/check_tracked_ignored.ts", () => {
  const tempRepo = async () => {
    const dir = await mkdtemp(join(tmpdir(), "tracked-ignored-"));
    const repo = join(dir, "repo");
    await mkdir(join(repo, "out"), { recursive: true });
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
    git(["init", "-q"]);
    await writeFile(join(repo, ".gitignore"), "out/\n");
    await writeFile(join(repo, "kept.ts"), "export const value = 1;\n");
    git(["add", ".gitignore", "kept.ts"]);
    return { repo, git };
  };

  test("fails when a force-added file matches .gitignore", async () => {
    const { repo, git } = await tempRepo();
    await writeFile(join(repo, "out", "generated.html"), "<html></html>\n");
    git(["add", "-f", "out/generated.html"]);

    const result = spawnGate(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("out/generated.html");
  });

  test("passes when every tracked file is inside the rules", async () => {
    const { repo } = await tempRepo();
    const result = spawnGate(repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("ok —");
  });

  test("the real tree tracks no ignored file", () => {
    const result = spawnGate(ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("0 unexpected");
  });

  test("verify:fast runs both hygiene gates", async () => {
    const verifyFast = await Bun.file(
      join(ROOT, "scripts", "verify_fast.ts"),
    ).text();
    expect(verifyFast).toContain('"check:home-paths"');
    expect(verifyFast).toContain('"check:tracked-ignored"');
  });
});
