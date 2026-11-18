#!/usr/bin/env bun
/**
 * @file scripts/check_pm_state.ts
 * @description Fail when `node_modules` does not match `bun.lock`, before anything reconciles it.
 *
 * `check:pm-state` used to be `bun ci && bun prune --check`, which cannot fail for the reason it
 * exists: `bun ci` has just rewritten `node_modules` to match the lock, so the prune that follows
 * always finds nothing. This runs the prune against the tree as it is found.
 *
 * It also closes the one state `bun prune --check` reports as healthy. With a node_modules that
 * does not exist, or a symlink that does not resolve, prune prints "No node_modules folder
 * (nothing to prune)" and exits 0 (measured on 1.4.4) — indistinguishable in CI from a clean
 * install. A *resolvable* symlink is refused with exit 1, so the two symlink states disagree;
 * both are refused here.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type NodeModulesState =
  /** Nothing at `node_modules`. */
  | "missing"
  /** A symlink whose target does not resolve to a directory. */
  | "broken-symlink"
  /** A real directory. */
  | "directory"
  /** A symlink to a directory; prune refuses this layout, so the check does too. */
  | "linked-directory"
  /** Something that is neither a directory nor a symlink. */
  | "not-a-directory";

/**
 * What is actually at `<root>/node_modules`.
 *
 * `lstat` first, because `existsSync`/`stat` follow a symlink and would report a dangling link as
 * simply absent — the exact confusion this check exists to remove.
 */
export function nodeModulesState(root: string): NodeModulesState {
  const target = join(root, "node_modules");
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return "missing";
  }
  if (stats.isSymbolicLink()) {
    try {
      return statSync(realpathSync(target)).isDirectory()
        ? "linked-directory"
        : "broken-symlink";
    } catch {
      return "broken-symlink";
    }
  }
  return stats.isDirectory() ? "directory" : "not-a-directory";
}

/** Why the state cannot be trusted; `null` when it can. */
export function stateFailure(state: NodeModulesState): string | null {
  switch (state) {
    case "missing":
      return "node_modules is absent — run `bun install`";
    case "broken-symlink":
      return "node_modules is a symlink that does not resolve — remove it and run `bun install`";
    case "not-a-directory":
      return "node_modules is not a directory — remove it and run `bun install`";
    case "linked-directory":
      return "node_modules is a symlink, a layout prune refuses — remove the link and run `bun install`";
    case "directory":
      return null;
  }
}

function run(): never {
  const root = resolve(import.meta.dir, "..");
  const failure = stateFailure(nodeModulesState(root));
  if (failure !== null) {
    console.error(`check:pm-state: ${failure}`);
    process.exit(1);
  }

  const prune = Bun.spawnSync([process.execPath, "prune", "--check"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  process.exit(prune.exitCode ?? 1);
}

// Guarded so a test can import the classifier without the script deciding to exit.
if (import.meta.main) run();
