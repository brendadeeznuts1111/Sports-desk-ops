#!/usr/bin/env bun
/**
 * @file scripts/check_staged.ts
 * @description Type-check only the TypeScript files staged for commit.
 *
 *   bun run check:staged                # staged .ts/.tsx/.mts/.cts files
 *   bun run check:staged --root <dir>   # check another checkout (tests)
 *
 * `bun check` has no `--staged`; the file set comes from `git diff --cached`. The listing is
 * NUL-separated so a path containing a space survives, and an empty set exits 0 without invoking
 * `bun check` — a bare `bun check` type-checks the whole project rather than nothing.
 */
import {
  parseStagedFiles,
  typecheckableStagedFiles,
} from "../lib/staged_check.ts";

const argv = Bun.argv.slice(2);
const rootIndex = argv.indexOf("--root");
const ROOT =
  rootIndex === -1 ? `${import.meta.dir}/..` : (argv[rootIndex + 1] ?? ".");

const staged = Bun.spawnSync(
  [
    "git",
    "diff",
    "--cached",
    "-z",
    "--name-only",
    "--diff-filter=ACMR",
    "--",
    ".",
  ],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
if (staged.exitCode !== 0) {
  console.error(
    `check:staged: git diff --cached failed: ${staged.stderr.toString().trim()}`,
  );
  process.exit(2);
}

const files = typecheckableStagedFiles(
  parseStagedFiles(staged.stdout.toString()),
);
if (files.length === 0) {
  // Deliberately not a project-wide check: nothing staged means nothing to verify, and widening the
  // scope here would turn a fast pre-commit step into a full type-check.
  console.log(
    "check:staged: no staged TypeScript files — nothing to check (not a project-wide check)",
  );
  process.exit(0);
}

const checked = Bun.spawnSync([process.execPath, "check", ...files], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(checked.exitCode ?? 1);
