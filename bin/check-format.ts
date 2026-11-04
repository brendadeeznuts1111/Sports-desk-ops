#!/usr/bin/env bun
/**
 * @file check-format.ts
 * @description `format:check` over **tracked files only**.
 *
 * Why this exists: `bun fmt --check` walks the working tree, so an untracked scratch file belongs
 * to the person who happens to have it — and the repo's format gate turns red for everyone else.
 * The index is the contract: check the bytes that will be committed. New files are included once
 * `git add` stages them, and CI (which only ever sees the checkout) keeps the same guarantee.
 *
 * `--ignore-unknown` keeps non-code tracked files (a `.py` verification helper, fixtures) from
 * erroring the run; `bunfig.toml`'s `[fmt] ignorePatterns` still decides what Bun will not
 * format. Files are passed in chunks so a large repo cannot exceed the argv limit.
 */

/** Files handed to one `bun fmt` invocation; keeps argv well under the platform limit. */
const CHUNK_SIZE = 300;

/** `git ls-files` emits NUL-separated paths; the index is the source of truth. */
export function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "");
}

/** Run the check; returns the process exit code (0 = every tracked file is formatted). */
export function checkFormat(files: readonly string[] = trackedFiles()): number {
  let failed = false;
  for (let index = 0; index < files.length; index += CHUNK_SIZE) {
    const chunk = files.slice(index, index + CHUNK_SIZE);
    const result = Bun.spawnSync(
      [process.execPath, "fmt", "--check", "--ignore-unknown", ...chunk],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      failed = true;
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      if (stdout !== "") process.stdout.write(stdout);
      if (stderr !== "") process.stderr.write(stderr);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(checkFormat());
}
