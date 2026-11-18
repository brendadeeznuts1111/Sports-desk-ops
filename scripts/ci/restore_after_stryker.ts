#!/usr/bin/env bun
/**
 * @file scripts/ci/restore_after_stryker.ts
 * @description Undo the file-mode damage of an in-place Stryker run.
 *
 * The bun runner's in-place mode backs up and restores files by content, which drops the
 * executable bit from tracked scripts and replaces symlinks with regular files. Both show up as
 * "mode change" entries in `git diff --summary`; this restores them from HEAD without touching any
 * content change the run legitimately made (mutants are reverted by Stryker itself).
 *
 *   bun run scripts/ci/restore_after_stryker.ts
 */

import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, rmSync, symlinkSync } from "node:fs";

const git = (args: readonly string[]): string => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

const MODE_CHANGE = /^ mode change (100755|120000) => 100644 (.+)$/;
let restored = 0;

for (const line of git(["diff", "--summary", "HEAD"]).split("\n")) {
  const match = MODE_CHANGE.exec(line);
  if (match === null) continue;
  const [, fromMode, path] = match;
  if (path === undefined) continue;

  if (fromMode === "100755") {
    chmodSync(path, 0o755);
    restored += 1;
    continue;
  }

  // A symlink restored as a regular file: its HEAD blob content is the link target.
  const current = lstatSync(path);
  if (!current.isFile()) continue;
  const target = git(["show", `HEAD:${path}`]).trimEnd();
  rmSync(path, { force: true });
  symlinkSync(target, path);
  restored += 1;
}

console.log(
  `restore_after_stryker: restored ${restored} tracked file mode(s)/symlink(s)`,
);
