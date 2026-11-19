/**
 * @file tracked_ignored.ts
 * @description Find tracked files that the repository's own ignore rules exclude.
 *
 * A tracked file matching `.gitignore` is nearly always a mistake: it was force-added (`git add -f`)
 * or the rule arrived after the file did. Either way the repository now ships something it declared
 * it would not — a generated report, a scratch benchmark, a captured report with real data — and the
 * ignore rule silently stops protecting anyone.
 *
 * Git answers this directly: `git ls-files -i -c --exclude-standard` lists exactly those files.
 * This module parses that output and applies the allowlist, so the check can be unit-tested without
 * a repository.
 *
 * One platform trap: on a case-insensitive checkout a rule such as `betReport*.json` also matches
 * `betreport-small.json`, so a file can be "ignored but tracked" on macOS and not on Linux CI. The
 * allowlist is the wrong fix for that; negate the pattern (`!path/to/file`) so both platforms agree.
 */

export interface TrackedIgnoredAllowance {
  readonly path: string;
  readonly reason: string;
}

/**
 * Tracked files that a reviewer has agreed may match an ignore rule. Empty by design: a case that
 * needs an entry usually needs the rule fixed instead (a negation, or the file untracked).
 */
export const TRACKED_IGNORED_ALLOWLIST: readonly TrackedIgnoredAllowance[] = [];

export function isTrackedIgnoredAllowlisted(file: string): boolean {
  return TRACKED_IGNORED_ALLOWLIST.some((entry) => entry.path === file);
}

/** Parse `git ls-files -z -i -c --exclude-standard` output into a sorted path list. */
export function parseTrackedIgnored(stdout: string): string[] {
  return stdout
    .split("\0")
    .filter((file) => file.length > 0)
    .sort();
}

/** The tracked-ignored files that are not allowlisted. */
export function unexpectedTrackedIgnored(files: readonly string[]): string[] {
  return files.filter((file) => !isTrackedIgnoredAllowlisted(file));
}
