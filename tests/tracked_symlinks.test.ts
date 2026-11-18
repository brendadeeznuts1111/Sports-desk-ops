/**
 * @file tests/tracked_symlinks.test.ts
 * @description Tracked symlinks must stay symlinks on disk.
 *
 * `packages/sportsdesk-ops/bin/*` are symlinks into `cli/`, `bin/` and `scripts/`, so one file is
 * the single definition of each command. A copy that follows symlinks (`cp -r` without `-P`,
 * `rsync` without `-l`, `tar` without `-h`) replaces them with regular files that are byte
 * identical to their target *at copy time*. Nothing fails: the code still runs, but
 * `git status` shows dozens of "modified" files, and one `git add -A` commits the copy and
 * creates a second definition that then drifts.
 *
 * That is what made six agent worktrees unreadable on 2026-11-18: 21 symlinks per worktree
 * dereferenced plus 35 lost executable bits, and no work behind any of it.
 *
 * The check reads the index (`git ls-files -s`), so it compares what git recorded against what
 * is on disk, and reports the path plus how to restore it.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

interface TrackedLink {
  readonly path: string;
  readonly blob: string;
}

/** Symlink entries recorded in `root`'s index, in path order. */
function trackedSymlinks(root: string): TrackedLink[] {
  const ls = Bun.spawnSync(["git", "ls-files", "-s", "-z", "--", "."], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ls.exitCode !== 0) {
    throw new Error(
      `git ls-files failed in ${root}: ${ls.stderr.toString().trim()}`,
    );
  }
  const links: TrackedLink[] = [];
  for (const record of ls.stdout.toString().split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, blob] = record.slice(0, tab).split(" ");
    if (mode !== "120000" || blob === undefined) continue;
    links.push({ path: record.slice(tab + 1), blob });
  }
  return links.sort((a, b) => a.path.localeCompare(b.path));
}

/** The link target git recorded, read from the index so it works even when dereferenced. */
function recordedTarget(root: string, blob: string): string {
  const show = Bun.spawnSync(["git", "cat-file", "blob", blob], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (show.exitCode !== 0) {
    throw new Error(`git cat-file blob ${blob} failed in ${root}`);
  }
  return show.stdout.toString();
}

/**
 * Tracked symlinks that are no longer symlinks on disk, or whose recorded target is absolute
 * (which breaks every worktree) or does not resolve to a file.
 */
function symlinkProblems(root: string): string[] {
  const problems: string[] = [];
  for (const link of trackedSymlinks(root)) {
    const target = recordedTarget(root, link.blob);
    if (isAbsolute(target)) {
      problems.push(
        `${link.path} -> ${target} (absolute target; worktrees cannot share it)`,
      );
      continue;
    }
    if (!existsSync(join(root, link.path))) {
      problems.push(
        `${link.path} -> ${target} (dangling; run: git checkout -- ${link.path})`,
      );
      continue;
    }
    if (!lstatSync(join(root, link.path)).isSymbolicLink()) {
      problems.push(
        `${link.path} is a regular file, not a symlink to ${target}` +
          ` (a copy dereferenced it; run: git checkout -- ${link.path})`,
      );
      continue;
    }
    if (readlinkSync(join(root, link.path)) !== target) {
      problems.push(
        `${link.path} points at ${readlinkSync(join(root, link.path))}, index says ${target}`,
      );
    }
  }
  return problems;
}

describe("tracked symlinks", () => {
  test("the repository records symlinks and none are dereferenced", () => {
    const links = trackedSymlinks(ROOT);
    // If this is zero the check is vacuous — the index is unreadable or the layout moved.
    expect(links.length).toBeGreaterThan(0);

    const problems = symlinkProblems(ROOT);
    expect(problems).toEqual([]);
  });

  test("a dereferenced copy is reported, an intact link is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-tracked-links-"));
    try {
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "cli.ts"), "export const value = 1;\n");
      // Relative target, as the repo records them.
      symlinkSync("../cli.ts", join(dir, "bin", "cli.ts"));
      const init = Bun.spawnSync(["git", "init", "-q"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(init.exitCode).toBe(0);
      const add = Bun.spawnSync(["git", "add", "-A"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(add.exitCode).toBe(0);
      expect(symlinkProblems(dir)).toEqual([]);

      // Replace the symlink with a copy of its target, the way a tree copy does.
      rmSync(join(dir, "bin", "cli.ts"));
      writeFileSync(join(dir, "bin", "cli.ts"), "export const value = 1;\n");
      const problems = symlinkProblems(dir);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain("bin/cli.ts is a regular file");
      expect(problems[0]).toContain("git checkout -- bin/cli.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
