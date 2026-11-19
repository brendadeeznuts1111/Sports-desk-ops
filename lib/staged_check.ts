/**
 * @file staged_check.ts
 * @description The staged file set that `check:staged` type-checks.
 *
 * Bun has no `--staged` flag on `bun check` (it is native on `bun fmt`, and this repository's lint
 * script implements its own), so the set comes from git: `git diff --cached -z --name-only`. Two
 * details are load-bearing:
 *
 * - the listing is NUL-separated, because a path may contain a space (`src/lib/terminal links.ts`);
 * - an empty set is a legitimate answer. A bare `bun check` type-checks the whole project instead of
 *   nothing, so the caller must skip rather than invoke it with zero files.
 */

/** Extensions `bun check` type-checks in this repository. */
export const TYPECHECK_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

export function isTypecheckable(path: string): boolean {
  return TYPECHECK_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Parse `git diff --cached -z --name-only` output. */
export function parseStagedFiles(stdout: string): string[] {
  return stdout.split("\0").filter((file) => file.length > 0);
}

/** The staged paths worth type-checking, sorted for a stable invocation. */
export function typecheckableStagedFiles(files: readonly string[]): string[] {
  return files.filter(isTypecheckable).sort();
}
