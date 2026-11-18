/**
 * @file tests/tracked_git_modes.test.ts
 * @description Git-recorded file modes must hold on disk: symlinks stay symlinks, executables
 * stay executable.
 *
 * `packages/sportsdesk-ops/bin/*` are symlinks into `cli/`, `bin/` and `scripts/`, so one file is
 * the single definition of each command. A copy that follows symlinks (`cp -r` without `-P`,
 * `rsync` without `-l`, `tar` without `-h`) replaces them with regular files that are byte
 * identical to their target *at copy time*. A copy that does not preserve permissions drops the
 * executable bit at the same time.
 *
 * Neither failure announces itself. The dereferenced file still runs; a `100755` path that lost
 * its bit only fails when someone finally executes it. What both do produce is dozens of
 * "modified" files in `git status`, which is how six agent worktrees came to look like they held
 * 11-35 files of unclaimed work on 2026-11-18 when four of them held none: 21 symlinks
 * dereferenced and 35 executable bits dropped, per worktree.
 *
 * The checks read the index (`git ls-files -s`), so they compare what git recorded against what
 * is on disk, and each failure names the command that restores the recorded state.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SYMLINK_MODE = "120000";
const EXECUTABLE_MODE = "100755";

interface TrackedEntry {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
}

/** Index entries under `root`, in path order. */
function trackedEntries(root: string): TrackedEntry[] {
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
  const entries: TrackedEntry[] = [];
  for (const record of ls.stdout.toString().split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, blob] = record.slice(0, tab).split(" ");
    if (mode === undefined || blob === undefined) continue;
    entries.push({ path: record.slice(tab + 1), mode, blob });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
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
  for (const entry of trackedEntries(root)) {
    if (entry.mode !== SYMLINK_MODE) continue;
    const target = recordedTarget(root, entry.blob);
    if (isAbsolute(target)) {
      problems.push(
        `${entry.path} -> ${target} (absolute target; worktrees cannot share it)`,
      );
      continue;
    }
    if (!existsSync(join(root, entry.path))) {
      problems.push(
        `${entry.path} -> ${target} (dangling; run: git checkout -- ${entry.path})`,
      );
      continue;
    }
    if (!lstatSync(join(root, entry.path)).isSymbolicLink()) {
      problems.push(
        `${entry.path} is a regular file, not a symlink to ${target}` +
          ` (a copy dereferenced it; run: git checkout -- ${entry.path})`,
      );
      continue;
    }
    const onDisk = readlinkSync(join(root, entry.path));
    if (onDisk !== target) {
      problems.push(`${entry.path} points at ${onDisk}, index says ${target}`);
    }
  }
  return problems;
}

/** Tracked `100755` paths whose on-disk mode lost every executable bit. */
function executableProblems(root: string): string[] {
  const problems: string[] = [];
  for (const entry of trackedEntries(root)) {
    if (entry.mode !== EXECUTABLE_MODE) continue;
    const path = join(root, entry.path);
    if (!existsSync(path)) {
      problems.push(
        `${entry.path} is missing (run: git checkout -- ${entry.path})`,
      );
      continue;
    }
    if ((statSync(path).mode & 0o111) === 0) {
      problems.push(
        `${entry.path} is tracked as 100755 but has no executable bit` +
          ` (a copy dropped it; run: git checkout -- ${entry.path})`,
      );
    }
  }
  return problems;
}

/** A tmp repo holding one committed executable and one committed symlink. */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sd-tracked-modes-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "cli.ts"), "export const value = 1;\n");
  writeFileSync(join(dir, "bin", "run.ts"), "#!/usr/bin/env bun\n");
  chmodSync(join(dir, "bin", "run.ts"), 0o755);
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
  return dir;
}

describe("tracked git modes", () => {
  test("the repository records no dereferenced symlink", () => {
    const links = trackedEntries(ROOT).filter(
      (entry) => entry.mode === SYMLINK_MODE,
    );
    // If this is zero the check is vacuous — the index is unreadable or the layout moved.
    expect(links.length).toBeGreaterThan(0);
    expect(symlinkProblems(ROOT)).toEqual([]);
  });

  test("every file recorded as 100755 is executable on disk", () => {
    const executables = trackedEntries(ROOT).filter(
      (entry) => entry.mode === EXECUTABLE_MODE,
    );
    expect(executables.length).toBeGreaterThan(0);
    expect(executableProblems(ROOT)).toEqual([]);
  });

  test("a dereferenced copy and a dropped exec bit are both reported", () => {
    const dir = fixtureRepo();
    try {
      expect(symlinkProblems(dir)).toEqual([]);
      expect(executableProblems(dir)).toEqual([]);

      // Replace the symlink with a copy of its target, the way a tree copy does.
      rmSync(join(dir, "bin", "cli.ts"));
      writeFileSync(join(dir, "bin", "cli.ts"), "export const value = 1;\n");
      const linkProblems = symlinkProblems(dir);
      expect(linkProblems.length).toBe(1);
      expect(linkProblems[0]).toContain("bin/cli.ts is a regular file");
      expect(linkProblems[0]).toContain("git checkout -- bin/cli.ts");

      // Drop the executable bit from the other file, the way the same copy does.
      chmodSync(join(dir, "bin", "run.ts"), 0o644);
      const execProblems = executableProblems(dir);
      expect(execProblems.length).toBe(1);
      expect(execProblems[0]).toContain("bin/run.ts is tracked as 100755");
      expect(execProblems[0]).toContain("git checkout -- bin/run.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
