#!/usr/bin/env bun
/**
 * @file scripts/dx_worktrees.ts
 * @description Zero-data-loss Git worktree & local/remote branch hygiene for SportsDesk DX.
 *
 * Usage:
 *   ./bin/dx worktrees                              # Dry-run audit (worktrees + local/remote branches)
 *   ./bin/dx worktrees --offline                    # Offline audit (skip git fetch & GitHub PR query)
 *   ./bin/dx worktrees --apply                      # Prune/remove clean merged worktrees & local branches
 *   ./bin/dx worktrees --apply --remote             # Also delete proven-merged remote branches on origin
 *   ./bin/dx worktrees --apply --ensure-auto-delete # Enable GitHub deleteBranchOnMerge on the repo
 *   ./bin/dx worktrees --json | --yaml              # Machine-readable JSON or YAML report
 *
 * Safety invariants:
 *   1. Never removes the primary repo worktree, the active working directory, a locked worktree,
 *      a dirty worktree (`git status --porcelain` non-empty), or an unregistered non-git directory.
 *   2. Never deletes a branch unless its exact tip SHA is proven merged into `origin/main` (or `main`)
 *      by Git ancestry (`merge-base --is-ancestor`), patch equivalence (`git cherry`), or an exact
 *      `headRefOid === sha` match on a `MERGED` GitHub PR (preventing deletion when post-PR commits
 *      were pushed to the same branch name).
 */

import { YAML } from "bun";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type BunInspectOptions,
  cliInspectOptions,
  inspectReport,
  padDisplay,
} from "../lib/cli_inspect.ts";

export interface ParsedWorktreeEntry {
  readonly path: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export interface GithubPrRecord {
  readonly number: number;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly mergedAt: string | null;
}

/** One entry from `git diff --raw -z --no-renames HEAD`. */
export interface RawDiffEntry {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
}

/** How one uncommitted path differs from HEAD. */
export type DirtyPathKind = "content" | "mode-only" | "typechange";

/**
 * Uncommitted paths split by what they actually are. A dirty worktree is not
 * automatically work: chmod noise and dereferenced symlinks inflate
 * `git status` without holding a single edited line.
 */
export interface DirtyWorkBreakdown {
  /** Bytes changed: work that a checkout or reset would discard. */
  readonly contentEdits: readonly string[];
  /** Mode-bit-only change (100755 <-> 100644): chmod noise, no edit. */
  readonly modeOnly: readonly string[];
  /** Symlink swapped for a regular file (or the reverse): tooling damage. */
  readonly typeChanges: readonly string[];
  /** Files git does not track yet. */
  readonly untracked: readonly string[];
}

export type DirtyWorkKind = "clean" | "artifacts-only" | "has-work";

/**
 * The disposition vocabulary as data. The union type is derived from these
 * tuples, so a new disposition cannot reach the type without also reaching the
 * report's zero-filled count map.
 */
export const WORKTREE_DISPOSITIONS = [
  "keep:primary",
  "keep:cwd",
  "keep:locked",
  "keep:orphan-dir",
  "keep:dirty",
  "keep:dirty-artifacts",
  "keep:ahead",
  "clean:missing-dir",
  "clean:merged",
  "clean:detached-anchored",
] as const;

export type WorktreeDisposition = (typeof WORKTREE_DISPOSITIONS)[number];

export const BRANCH_DISPOSITIONS = [
  "protected:default",
  "protected:worktree",
  "clean:ancestor",
  "clean:patch-equivalent",
  "clean:squash-pr",
  "keep:post-pr-commits",
  "keep:open-pr",
  "keep:unmerged",
  "unknown:shallow-ancestry",
] as const;

export type BranchDisposition = (typeof BRANCH_DISPOSITIONS)[number];

/**
 * Bumped only when a field is removed or changes meaning. Adding a key is
 * additive, so a consumer must ignore keys it does not know.
 */
export const WORKTREE_REPORT_SCHEMA_VERSION = 1;

/** Counts over a closed vocabulary: every key is present, including zeros. */
export interface DispositionCounts<D extends string> {
  readonly total: number;
  readonly byDisposition: Readonly<Record<D, number>>;
}

/** What the uncommitted paths across every worktree add up to. */
export interface DirtyWorkTotals {
  /** Worktrees whose dirt is more than mode bits and symlink type. */
  readonly worktreesDirty: number;
  readonly contentEdits: number;
  readonly modeOnly: number;
  readonly typeChanges: number;
  readonly untracked: number;
  /** contentEdits + untracked: what a discard would actually lose. */
  readonly workPaths: number;
  /** modeOnly + typeChanges: recoverable without losing an edit. */
  readonly artifactPaths: number;
}

/** How much provably-clean material the audit found, ready for --apply. */
export interface HygieneCandidatesSummary {
  readonly pruneWorktrees: number;
  readonly removeWorktrees: number;
  readonly deleteLocalBranches: number;
  readonly deleteRemoteBranches: number;
}

/**
 * Order-independent totals, so a consumer never has to re-derive them from the
 * row arrays (and so a row-order change cannot change a headline number).
 */
export interface WorktreeHygieneSummary {
  readonly worktrees: DispositionCounts<WorktreeDisposition>;
  readonly localBranches: DispositionCounts<BranchDisposition>;
  readonly remoteBranches: DispositionCounts<BranchDisposition>;
  readonly dirty: DirtyWorkTotals;
  readonly candidates: HygieneCandidatesSummary;
}

export interface WorktreeAuditRow {
  readonly path: string;
  readonly label: string;
  readonly headShort: string;
  readonly branch: string | null;
  readonly registered: boolean;
  readonly existsOnDisk: boolean;
  readonly modifiedCount: number;
  readonly untrackedCount: number;
  readonly dirty: DirtyWorkBreakdown;
  readonly dirtyKind: DirtyWorkKind;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly disposition: WorktreeDisposition;
  readonly reason: string;
}

export interface BranchAuditRow {
  readonly scope: "local" | "remote";
  readonly name: string;
  readonly fullRef: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly committerDate: string;
  readonly worktreePath: string | null;
  readonly aheadCount: number;
  readonly disposition: BranchDisposition;
  readonly reason: string;
}

export interface AppliedCleanupSummary {
  readonly prunedWorktrees: boolean;
  readonly removedWorktrees: readonly string[];
  readonly deletedLocalBranches: readonly string[];
  readonly deletedRemoteBranches: readonly string[];
  readonly enabledDeleteBranchOnMerge: boolean;
}

/** The exact operations --apply would perform, derived from dispositions alone. */
export interface CleanupCandidates {
  readonly pruneWorktrees: number;
  readonly removeWorktrees: readonly string[];
  readonly deleteLocalBranches: readonly string[];
  readonly deleteRemoteBranches: readonly string[];
}

/**
 * The JSON/YAML contract for `dx worktrees`.
 *
 * Stability: `schemaVersion` changes only when a field is removed or changes
 * meaning, so an added key is always safe to ignore. `summary` is the
 * order-independent view — a consumer must not re-derive its totals from the
 * rows. The row arrays carry a documented order (worktrees by label; branches
 * newest-first, name as tie-break), so two runs over the same repository emit
 * the same bytes and a diff shows only real change.
 */
export interface WorktreeHygieneReport {
  readonly schemaVersion: number;
  readonly repoCommonRoot: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly offline: boolean;
  readonly githubPrsLoaded: number;
  /**
   * True when the PR listing hit its page limit, so an older merged PR may be
   * invisible. Read as "ancestry/cherry evidence only", never as "no PR".
   */
  readonly githubPrListTruncated: boolean;
  /**
   * True when the clone is shallow. `merge-base --is-ancestor` and `git cherry`
   * cannot see past the graft, so they return "not merged" for branches that
   * are in fact merged. Ancestry is then reported as unknown, not as unmerged.
   */
  readonly shallow: boolean;
  readonly deleteBranchOnMerge: boolean | null;
  readonly worktrees: readonly WorktreeAuditRow[];
  readonly localBranches: readonly BranchAuditRow[];
  readonly remoteBranches: readonly BranchAuditRow[];
  readonly candidates: CleanupCandidates;
  readonly summary: WorktreeHygieneSummary;
  readonly applied: AppliedCleanupSummary | null;
}

export function parseWorktreeListPorcelain(raw: string): ParsedWorktreeEntry[] {
  const entries: ParsedWorktreeEntry[] = [];
  const blocks = raw.trim().split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let wtPath = "";
    let headSha = "";
    let branch: string | null = null;
    let detached = false;
    let locked = false;
    let prunable = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
      } else if (line === "detached") {
        detached = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
    }

    if (wtPath.length > 0) {
      entries.push({
        path: wtPath,
        headSha,
        branch,
        detached,
        locked,
        prunable,
      });
    }
  }

  return entries;
}

/** Locale-independent string order, so the report is byte-stable across hosts. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Zero-filled counters over a closed vocabulary. The cast is earned: `keys` is
 * the same `as const` tuple the disposition union derives from, and the report
 * test pins the resulting key set.
 */
function zeroCounts<D extends string>(keys: readonly D[]): Record<D, number> {
  const counts = {} as Record<D, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

function countDispositions<D extends string>(
  values: Iterable<D>,
  keys: readonly D[],
): DispositionCounts<D> {
  const byDisposition = zeroCounts(keys);
  let total = 0;
  for (const value of values) {
    byDisposition[value] += 1;
    total += 1;
  }
  return { total, byDisposition };
}

/** Worktrees sort by label then path; both are stable for a given checkout. */
export function sortWorktreeRows(
  rows: readonly WorktreeAuditRow[],
): WorktreeAuditRow[] {
  return [...rows].sort(
    (a, b) => compareText(a.label, b.label) || compareText(a.path, b.path),
  );
}

/** Branches sort newest-first, with the name as a deterministic tie-break. */
export function sortBranchRows(
  rows: readonly BranchAuditRow[],
): BranchAuditRow[] {
  return [...rows].sort(
    (a, b) =>
      compareText(b.committerDate, a.committerDate) ||
      compareText(a.name, b.name),
  );
}

export function summarizeDirtyWorktrees(
  rows: readonly WorktreeAuditRow[],
): DirtyWorkTotals {
  let worktreesDirty = 0;
  let contentEdits = 0;
  let modeOnly = 0;
  let typeChanges = 0;
  let untracked = 0;
  for (const row of rows) {
    if (row.dirtyKind !== "clean") worktreesDirty += 1;
    contentEdits += row.dirty.contentEdits.length;
    modeOnly += row.dirty.modeOnly.length;
    typeChanges += row.dirty.typeChanges.length;
    untracked += row.dirty.untracked.length;
  }
  return {
    worktreesDirty,
    contentEdits,
    modeOnly,
    typeChanges,
    untracked,
    workPaths: contentEdits + untracked,
    artifactPaths: modeOnly + typeChanges,
  };
}

export interface HygieneSummaryInput {
  readonly worktrees: readonly WorktreeAuditRow[];
  readonly localBranches: readonly BranchAuditRow[];
  readonly remoteBranches: readonly BranchAuditRow[];
  readonly candidates: CleanupCandidates;
}

/** Fold the rows into the order-independent totals the report publishes. */
export function buildHygieneSummary(
  input: HygieneSummaryInput,
): WorktreeHygieneSummary {
  return {
    worktrees: countDispositions(
      input.worktrees.map((row) => row.disposition),
      WORKTREE_DISPOSITIONS,
    ),
    localBranches: countDispositions(
      input.localBranches.map((row) => row.disposition),
      BRANCH_DISPOSITIONS,
    ),
    remoteBranches: countDispositions(
      input.remoteBranches.map((row) => row.disposition),
      BRANCH_DISPOSITIONS,
    ),
    dirty: summarizeDirtyWorktrees(input.worktrees),
    candidates: {
      pruneWorktrees: input.candidates.pruneWorktrees,
      removeWorktrees: input.candidates.removeWorktrees.length,
      deleteLocalBranches: input.candidates.deleteLocalBranches.length,
      deleteRemoteBranches: input.candidates.deleteRemoteBranches.length,
    },
  };
}

export interface MergeProofInput {
  readonly name: string;
  readonly fullSha: string;
  readonly isDefaultBranch: boolean;
  readonly checkedOutInKeptWorktree: boolean;
  readonly isAncestor: boolean;
  readonly shallow: boolean;
  readonly aheadCount: number;
  readonly unappliedCherryCount: number | null;
  readonly prsForBranch: readonly GithubPrRecord[];
}

export function classifyBranchMergeProof(input: MergeProofInput): {
  readonly disposition: BranchDisposition;
  readonly reason: string;
} {
  if (input.isDefaultBranch) {
    return { disposition: "protected:default", reason: "default branch" };
  }
  if (input.checkedOutInKeptWorktree) {
    return {
      disposition: "protected:worktree",
      reason: "checked out in active/kept worktree",
    };
  }
  if (input.isAncestor) {
    return {
      disposition: "clean:ancestor",
      reason: "commit is ancestor of base branch",
    };
  }

  const exactMerged = input.prsForBranch.find(
    (p) => p.state === "MERGED" && p.headRefOid === input.fullSha,
  );
  if (exactMerged !== undefined) {
    return {
      disposition: "clean:squash-pr",
      reason: `PR #${exactMerged.number} merged exact tip ${input.fullSha.slice(0, 7)}`,
    };
  }

  if (
    input.aheadCount > 0 &&
    input.unappliedCherryCount !== null &&
    input.unappliedCherryCount === 0
  ) {
    return {
      disposition: "clean:patch-equivalent",
      reason: "all commits patch-equivalent on base branch (git cherry)",
    };
  }

  const openPr = input.prsForBranch.find((p) => p.state === "OPEN");
  if (openPr !== undefined) {
    return {
      disposition: "keep:open-pr",
      reason: `open PR #${openPr.number}`,
    };
  }

  const olderMerged = input.prsForBranch.find((p) => p.state === "MERGED");
  if (olderMerged !== undefined) {
    return {
      disposition: "keep:post-pr-commits",
      reason: `PR #${olderMerged.number} merged ${olderMerged.headRefOid.slice(0, 7)}, but tip is ${input.fullSha.slice(0, 7)}`,
    };
  }

  if (input.shallow && input.unappliedCherryCount === null) {
    return {
      disposition: "unknown:shallow-ancestry",
      reason: `shallow clone: ancestry is cut off at the graft, so "not merged" is unproven (deepen with 'git fetch --deepen=<n>')`,
    };
  }

  return {
    disposition: "keep:unmerged",
    reason: `${input.aheadCount} unmerged commit(s), no merged PR match`,
  };
}

export interface WorktreeClassificationInput {
  readonly isPrimary: boolean;
  readonly containsCwd: boolean;
  readonly registered: boolean;
  readonly detached: boolean;
  readonly anchoredBranch: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly existsOnDisk: boolean;
  readonly modifiedCount: number;
  readonly untrackedCount: number;
  readonly dirtyKind: DirtyWorkKind;
  readonly contentEditCount: number;
  readonly headMerged: boolean;
  readonly mergeReason: string;
  readonly aheadCount: number;
}

export function classifyWorktreeDisposition(
  input: WorktreeClassificationInput,
): { readonly disposition: WorktreeDisposition; readonly reason: string } {
  if (!input.registered) {
    return {
      disposition: "keep:orphan-dir",
      reason: "unregistered directory (not in git worktree list; protected)",
    };
  }
  if (input.isPrimary) {
    const dirtyTotal = input.modifiedCount + input.untrackedCount;
    return {
      disposition: "keep:primary",
      reason:
        dirtyTotal > 0
          ? `primary worktree (${dirtyTotal} uncommitted path(s))`
          : "primary worktree",
    };
  }
  if (!input.existsOnDisk || input.prunable) {
    return {
      disposition: "clean:missing-dir",
      reason: "directory missing on disk (prunable)",
    };
  }
  if (input.locked) {
    return { disposition: "keep:locked", reason: "git worktree locked" };
  }
  if (input.containsCwd) {
    return {
      disposition: "keep:cwd",
      reason: "current working directory",
    };
  }
  const dirtyTotal = input.modifiedCount + input.untrackedCount;
  if (dirtyTotal > 0) {
    if (input.dirtyKind === "artifacts-only") {
      return {
        disposition: "keep:dirty-artifacts",
        reason: `${dirtyTotal} path(s) differ only by mode bits or symlink type — no content edits; restore with 'git checkout -- .'`,
      };
    }
    return {
      disposition: "keep:dirty",
      reason: `${input.contentEditCount + input.untrackedCount} path(s) of real work (${input.contentEditCount} content edit(s), ${input.untrackedCount} untracked)`,
    };
  }
  if (input.headMerged) {
    return {
      disposition: "clean:merged",
      reason: `clean tree & ${input.mergeReason}`,
    };
  }
  if (input.detached && input.anchoredBranch !== null) {
    return {
      disposition: "clean:detached-anchored",
      reason: `clean detached tree; commit preserved by '${input.anchoredBranch}'`,
    };
  }
  return {
    disposition: "keep:ahead",
    reason: `clean tree, ${input.aheadCount} unmerged commit(s)`,
  };
}

function isCleanBranchDisposition(d: BranchDisposition): boolean {
  return (
    d === "clean:ancestor" ||
    d === "clean:patch-equivalent" ||
    d === "clean:squash-pr"
  );
}

async function runCmd(
  argv: readonly string[],
  cwd: string,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: Bun.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * A shallow clone grafts history, so `merge-base --is-ancestor` answers "no"
 * for a branch that was merged before the graft and `git cherry` exits
 * non-zero. Detecting it stops the audit from reporting that as "unmerged".
 */
async function detectShallowClone(repoDir: string): Promise<boolean> {
  const res = await runCmd(
    ["git", "rev-parse", "--is-shallow-repository"],
    repoDir,
  );
  return res.code === 0 && res.stdout.trim() === "true";
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function resolveCommonRepoRoot(cwd: string): Promise<string> {
  const res = await runCmd(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  if (res.code === 0 && res.stdout.trim().length > 0) {
    return path.dirname(res.stdout.trim());
  }
  const top = await runCmd(["git", "rev-parse", "--show-toplevel"], cwd);
  if (top.code === 0 && top.stdout.trim().length > 0) {
    return top.stdout.trim();
  }
  throw new Error(`Not inside a git repository: ${cwd}`);
}

async function checkIsAncestor(
  repoDir: string,
  candidateShaOrRef: string,
  baseRef: string,
): Promise<boolean> {
  const res = await runCmd(
    ["git", "merge-base", "--is-ancestor", candidateShaOrRef, baseRef],
    repoDir,
  );
  return res.code === 0;
}

function parseAheadBehindAtom(raw: string): {
  readonly ahead: number;
  readonly behind: number;
} | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
  return { ahead, behind };
}

async function getAheadBehind(
  repoDir: string,
  candidateShaOrRef: string,
  baseRef: string,
): Promise<{
  readonly ahead: number;
  readonly behind: number;
  readonly ok: boolean;
}> {
  const res = await runCmd(
    [
      "git",
      "rev-list",
      "--left-right",
      "--count",
      `${baseRef}...${candidateShaOrRef}`,
    ],
    repoDir,
  );
  if (res.code !== 0) return { ahead: 0, behind: 0, ok: false };
  const parts = res.stdout.trim().split(/\s+/);
  return {
    behind: Number.parseInt(parts[0] ?? "0", 10) || 0,
    ahead: Number.parseInt(parts[1] ?? "0", 10) || 0,
    ok: true,
  };
}

async function getUnappliedCherryCount(
  repoDir: string,
  candidateShaOrRef: string,
  baseRef: string,
): Promise<number | null> {
  const res = await runCmd(
    ["git", "cherry", baseRef, candidateShaOrRef],
    repoDir,
  );
  if (res.code !== 0) return null;
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.filter((l) => l.startsWith("+")).length;
}

/** Added/deleted line counts for one path; null when git reports "-" (binary). */
export interface DiffLineCounts {
  readonly added: number | null;
  readonly deleted: number | null;
}

function absurdDirtyPathKind(value: never): never {
  throw new Error(`unreachable dirty path kind: ${String(value)}`);
}

/** Parse `git diff --raw -z --no-renames HEAD` into one entry per path. */
export function parseRawDiffZ(raw: string): RawDiffEntry[] {
  const entries: RawDiffEntry[] = [];
  const tokens = raw.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const header = tokens[i] ?? "";
    const diffPath = tokens[i + 1] ?? "";
    if (!header.startsWith(":") || diffPath.length === 0) continue;
    const fields = header.slice(1).split(" ");
    const oldMode = fields[0];
    const newMode = fields[1];
    const status = fields[4];
    if (
      oldMode === undefined ||
      newMode === undefined ||
      status === undefined
    ) {
      continue;
    }
    entries.push({
      path: diffPath,
      status: status.slice(0, 1),
      oldMode,
      newMode,
    });
  }
  return entries;
}

/** Parse `git diff --numstat -z --no-renames HEAD` into per-path line counts. */
export function parseNumstatZ(
  raw: string,
): ReadonlyMap<string, DiffLineCounts> {
  const counts = new Map<string, DiffLineCounts>();
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const fields = record.split("\t");
    if (fields.length < 3) continue;
    const addedRaw = fields[0];
    const deletedRaw = fields[1];
    const diffPath = fields.slice(2).join("\t");
    if (diffPath.length === 0) continue;
    const toCount = (value: string | undefined): number | null => {
      if (value === undefined || value === "-") return null;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    };
    counts.set(diffPath, {
      added: toCount(addedRaw),
      deleted: toCount(deletedRaw),
    });
  }
  return counts;
}

/**
 * Decide what one changed path represents.
 *
 * A worktree-vs-HEAD raw diff reports `0000000…` as the destination object, so
 * the shas cannot separate a mode flip from an edit — measured on Bun 1.4.4,
 * `:100755 100644 d95f3ad 0000000 M` is a chmod and nothing else. The line
 * counts decide it instead: a chmod-only change is the only entry with zero
 * added and zero deleted lines.
 */
export function classifyDirtyPath(
  entry: RawDiffEntry,
  counts: DiffLineCounts | undefined,
): DirtyPathKind {
  if (entry.status === "T") return "typechange";
  const wasSymlink = entry.oldMode === "120000";
  const isSymlink = entry.newMode === "120000";
  if (wasSymlink !== isSymlink) return "typechange";
  if (counts !== undefined && counts.added === 0 && counts.deleted === 0) {
    return "mode-only";
  }
  return "content";
}

export function summarizeDirtyWork(
  entries: readonly RawDiffEntry[],
  numstat: ReadonlyMap<string, DiffLineCounts>,
  untracked: readonly string[],
): DirtyWorkBreakdown {
  const contentEdits: string[] = [];
  const modeOnly: string[] = [];
  const typeChanges: string[] = [];
  for (const entry of entries) {
    const kind = classifyDirtyPath(entry, numstat.get(entry.path));
    switch (kind) {
      case "content":
        contentEdits.push(entry.path);
        break;
      case "mode-only":
        modeOnly.push(entry.path);
        break;
      case "typechange":
        typeChanges.push(entry.path);
        break;
      default:
        absurdDirtyPathKind(kind);
    }
  }
  return { contentEdits, modeOnly, typeChanges, untracked: [...untracked] };
}

export function classifyDirtyWork(
  breakdown: DirtyWorkBreakdown,
): DirtyWorkKind {
  if (breakdown.contentEdits.length > 0 || breakdown.untracked.length > 0) {
    return "has-work";
  }
  if (breakdown.modeOnly.length > 0 || breakdown.typeChanges.length > 0) {
    return "artifacts-only";
  }
  return "clean";
}

export interface WorktreeWorkState {
  readonly modifiedCount: number;
  readonly untrackedCount: number;
  readonly breakdown: DirtyWorkBreakdown;
  readonly kind: DirtyWorkKind;
}

const EMPTY_DIRTY_BREAKDOWN: DirtyWorkBreakdown = {
  contentEdits: [],
  modeOnly: [],
  typeChanges: [],
  untracked: [],
};

async function inspectWorktreeWork(wtPath: string): Promise<WorktreeWorkState> {
  const [rawRes, numstatRes, untrackedRes] = await Promise.all([
    runCmd(["git", "diff", "--raw", "-z", "--no-renames", "HEAD"], wtPath),
    runCmd(["git", "diff", "--numstat", "-z", "--no-renames", "HEAD"], wtPath),
    runCmd(["git", "ls-files", "--others", "--exclude-standard", "-z"], wtPath),
  ]);
  const entries = rawRes.code === 0 ? parseRawDiffZ(rawRes.stdout) : [];
  const numstat =
    numstatRes.code === 0
      ? parseNumstatZ(numstatRes.stdout)
      : new Map<string, DiffLineCounts>();
  // Untracked files are readable even when the branch has no commit yet, so
  // they are collected independently of the diff.
  const untracked =
    untrackedRes.code === 0
      ? untrackedRes.stdout.split("\0").filter((p) => p.length > 0)
      : [];
  const breakdown = summarizeDirtyWork(entries, numstat, untracked);
  return {
    modifiedCount: entries.length,
    untrackedCount: untracked.length,
    breakdown,
    kind: classifyDirtyWork(breakdown),
  };
}

async function loadGithubState(
  repoDir: string,
  prLimit: number,
): Promise<{
  readonly prsByBranch: ReadonlyMap<string, readonly GithubPrRecord[]>;
  readonly prCount: number;
  readonly truncated: boolean;
  readonly deleteBranchOnMerge: boolean | null;
}> {
  const ghBin = Bun.which("gh", { PATH: Bun.env["PATH"] ?? "" });
  if (!ghBin) {
    return {
      prsByBranch: new Map(),
      prCount: 0,
      truncated: false,
      deleteBranchOnMerge: null,
    };
  }

  const [prRes, repoRes] = await Promise.all([
    runCmd(
      [
        ghBin,
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        String(prLimit),
        "--json",
        "number,headRefName,headRefOid,state,mergedAt",
      ],
      repoDir,
    ),
    runCmd([ghBin, "repo", "view", "--json", "deleteBranchOnMerge"], repoDir),
  ]);

  const map = new Map<string, GithubPrRecord[]>();
  let prCount = 0;
  if (prRes.code === 0) {
    try {
      const parsed = JSON.parse(prRes.stdout) as Array<{
        number?: unknown;
        headRefName?: unknown;
        headRefOid?: unknown;
        state?: unknown;
        mergedAt?: unknown;
      }>;
      for (const item of parsed) {
        if (
          typeof item.number === "number" &&
          typeof item.headRefName === "string" &&
          typeof item.headRefOid === "string" &&
          (item.state === "OPEN" ||
            item.state === "MERGED" ||
            item.state === "CLOSED")
        ) {
          const rec: GithubPrRecord = {
            number: item.number,
            headRefName: item.headRefName,
            headRefOid: item.headRefOid,
            state: item.state,
            mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : null,
          };
          const bucket = map.get(rec.headRefName);
          if (bucket) bucket.push(rec);
          else map.set(rec.headRefName, [rec]);
          prCount += 1;
        }
      }
    } catch {
      // Non-fatal if gh JSON cannot be parsed.
    }
  }

  let deleteBranchOnMerge: boolean | null = null;
  if (repoRes.code === 0) {
    try {
      const parsed = JSON.parse(repoRes.stdout) as {
        deleteBranchOnMerge?: unknown;
      };
      if (typeof parsed.deleteBranchOnMerge === "boolean") {
        deleteBranchOnMerge = parsed.deleteBranchOnMerge;
      }
    } catch {
      // Non-fatal
    }
  }

  return {
    prsByBranch: map,
    prCount,
    // A full page means older PRs may have been left out, so their branches can
    // look unmerged. Reporting the truncation keeps "no PR" honest.
    truncated: prCount >= prLimit,
    deleteBranchOnMerge,
  };
}

export class InspectableWorktreeHygieneReport {
  readonly data: WorktreeHygieneReport;

  constructor(data: WorktreeHygieneReport) {
    this.data = data;
  }

  [Bun.inspect.custom](_depth?: number, options?: BunInspectOptions): string {
    const colors = options?.colors === true;
    const autoDelLabel =
      this.data.deleteBranchOnMerge === null
        ? "not probed"
        : this.data.deleteBranchOnMerge
          ? "enabled"
          : "disabled (recommend --ensure-auto-delete)";

    const prLine = this.data.offline
      ? "offline"
      : this.data.githubPrListTruncated
        ? `${this.data.githubPrsLoaded} PR(s) loaded — PAGE FULL, so an older merged PR may be invisible (raise --pr-limit)`
        : `${this.data.githubPrsLoaded} PR(s) loaded`;
    const cloneLine = this.data.shallow
      ? "shallow — ancestry and cherry cannot prove a merge; deepen with 'git fetch --deepen=<n>' before trusting unknown:shallow-ancestry"
      : "complete";

    const { dirty, candidates } = this.data.summary;
    const dirtLine = `${dirty.worktreesDirty} worktree(s) · ${dirty.workPaths} work path(s) · ${dirty.artifactPaths} artifact path(s)`;
    const cleanLine = `${candidates.removeWorktrees} worktree(s), ${candidates.deleteLocalBranches} local branch(es), ${candidates.deleteRemoteBranches} remote branch(es)${candidates.pruneWorktrees > 0 ? `, ${candidates.pruneWorktrees} prunable` : ""}`;

    const summaryLines = [
      `${padDisplay("Schema", 24)}: v${this.data.schemaVersion}`,
      `${padDisplay("Repo Common Root", 24)}: ${this.data.repoCommonRoot}`,
      `${padDisplay("Base Reference", 24)}: ${this.data.baseRef} (${this.data.baseSha.slice(0, 7)})`,
      `${padDisplay("Clone History", 24)}: ${cloneLine}`,
      `${padDisplay("GitHub PR Metadata", 24)}: ${prLine}`,
      `${padDisplay("Dirty Work", 24)}: ${dirtLine}`,
      `${padDisplay("Provably Clean", 24)}: ${cleanLine}`,
      `${padDisplay("deleteBranchOnMerge", 24)}: ${autoDelLabel}`,
    ];

    const wtTable = Bun.inspect.table(
      this.data.worktrees.map((w) => ({
        worktree: w.label,
        branch: w.branch ?? `(detached@${w.headShort})`,
        dirty: w.modifiedCount + w.untrackedCount,
        work: w.dirty.contentEdits.length + w.dirty.untracked.length,
        artifacts: w.dirty.modeOnly.length + w.dirty.typeChanges.length,
        ahead: w.aheadCount,
        disposition: w.disposition,
        reason: w.reason,
      })),
      [
        "worktree",
        "branch",
        "dirty",
        "work",
        "artifacts",
        "ahead",
        "disposition",
        "reason",
      ],
      { colors },
    );

    const localTable = Bun.inspect.table(
      this.data.localBranches.map((b) => ({
        branch: b.name,
        sha: b.shortSha,
        date: b.committerDate,
        ahead: b.aheadCount,
        disposition: b.disposition,
        reason: b.reason,
      })),
      ["branch", "sha", "date", "ahead", "disposition", "reason"],
      { colors },
    );

    const remoteTable = Bun.inspect.table(
      this.data.remoteBranches.map((b) => ({
        remoteBranch: b.name,
        sha: b.shortSha,
        date: b.committerDate,
        ahead: b.aheadCount,
        disposition: b.disposition,
        reason: b.reason,
      })),
      ["remoteBranch", "sha", "date", "ahead", "disposition", "reason"],
      { colors },
    );

    const candidateSummary = [
      `Safe Cleanup Candidates:`,
      `  • Prunable missing worktrees : ${this.data.candidates.pruneWorktrees}`,
      `  • Stale clean worktrees      : ${this.data.candidates.removeWorktrees.length} (${this.data.candidates.removeWorktrees.join(", ") || "none"})`,
      `  • Merged local branches      : ${this.data.candidates.deleteLocalBranches.length} (${this.data.candidates.deleteLocalBranches.join(", ") || "none"})`,
      `  • Merged remote branches     : ${this.data.candidates.deleteRemoteBranches.length} (${this.data.candidates.deleteRemoteBranches.join(", ") || "none"})`,
    ];

    if (this.data.applied !== null) {
      candidateSummary.push(
        `Applied Actions:`,
        `  • Removed worktrees          : ${this.data.applied.removedWorktrees.length} (${this.data.applied.removedWorktrees.join(", ") || "none"})`,
        `  • Deleted local branches     : ${this.data.applied.deletedLocalBranches.length} (${this.data.applied.deletedLocalBranches.join(", ") || "none"})`,
        `  • Deleted remote branches    : ${this.data.applied.deletedRemoteBranches.length} (${this.data.applied.deletedRemoteBranches.join(", ") || "none"})`,
        `  • deleteBranchOnMerge set    : ${this.data.applied.enabledDeleteBranchOnMerge ? "yes" : "unchanged"}`,
      );
    } else {
      candidateSummary.push(
        `Run './bin/dx worktrees --apply [--remote] [--ensure-auto-delete]' to execute safe cleanups.`,
      );
    }

    return [
      summaryLines.join("\n"),
      `\nWorktrees (${this.data.worktrees.length}):\n${wtTable.trimEnd()}`,
      `\nLocal Branches (${this.data.localBranches.length}):\n${localTable.trimEnd()}`,
      `\nRemote Branches (${this.data.remoteBranches.length}):\n${remoteTable.trimEnd()}`,
      `\n${candidateSummary.join("\n")}`,
    ].join("\n");
  }
}

/**
 * Default GitHub PR page size. The desk repo carried 392 PRs in Nov 2026, so a
 * 200-row page silently hid older merges; the report also flags truncation.
 */
export const DEFAULT_PR_LIMIT = 1000;

export interface AuditWorktreesOptions {
  readonly cwd: string;
  readonly offline: boolean;
  readonly fetchRemote: boolean;
  readonly apply: boolean;
  readonly applyRemote: boolean;
  readonly ensureAutoDelete: boolean;
  /** GitHub PR page size; defaults to DEFAULT_PR_LIMIT. */
  readonly prLimit?: number;
}

function compactWorktreeLabel(wtPath: string, commonRoot: string): string {
  if (wtPath === commonRoot) return ". (primary)";
  if (wtPath.startsWith(`${commonRoot}/`)) {
    return wtPath.slice(commonRoot.length + 1);
  }
  const home = Bun.env["HOME"] ?? "";
  if (home.length > 0 && wtPath.startsWith(`${home}/`)) {
    return `~/${wtPath.slice(home.length + 1)}`;
  }
  return wtPath;
}

export async function runWorktreeHygiene(
  options: AuditWorktreesOptions,
): Promise<WorktreeHygieneReport> {
  const repoCommonRoot = await canonicalPath(
    await resolveCommonRepoRoot(options.cwd),
  );
  const resolvedCwd = await canonicalPath(options.cwd);

  if (!options.offline && (options.fetchRemote || options.apply)) {
    await runCmd(["git", "fetch", "--prune", "origin"], repoCommonRoot);
  }

  const originMainRes = await runCmd(
    ["git", "rev-parse", "--verify", "origin/main"],
    repoCommonRoot,
  );
  const baseRef = originMainRes.code === 0 ? "origin/main" : "main";
  const baseShaRes = await runCmd(
    ["git", "rev-parse", baseRef],
    repoCommonRoot,
  );
  const baseSha = baseShaRes.stdout.trim();
  const prLimit = options.prLimit ?? DEFAULT_PR_LIMIT;

  const [ghState, wtRaw, localRefsRes, remoteRefsRes, shallow] =
    await Promise.all([
      options.offline
        ? Promise.resolve({
            prsByBranch: new Map<string, readonly GithubPrRecord[]>(),
            prCount: 0,
            truncated: false,
            deleteBranchOnMerge: null,
          })
        : loadGithubState(repoCommonRoot, prLimit),
      runCmd(["git", "worktree", "list", "--porcelain"], repoCommonRoot),
      (async () => {
        const res = await runCmd(
          [
            "git",
            "for-each-ref",
            "--sort=-committerdate",
            `--format=%(refname:short)|%(objectname)|%(committerdate:short)|%(worktreepath)|%(ahead-behind:${baseRef})`,
            "refs/heads/",
          ],
          repoCommonRoot,
        );
        if (res.code === 0) return res;
        return runCmd(
          [
            "git",
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)|%(objectname)|%(committerdate:short)|%(worktreepath)|",
            "refs/heads/",
          ],
          repoCommonRoot,
        );
      })(),
      (async () => {
        const res = await runCmd(
          [
            "git",
            "for-each-ref",
            "--sort=-committerdate",
            `--format=%(refname:short)|%(objectname)|%(committerdate:short)|%(ahead-behind:${baseRef})`,
            "refs/remotes/origin/",
          ],
          repoCommonRoot,
        );
        if (res.code === 0) return res;
        return runCmd(
          [
            "git",
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)|%(objectname)|%(committerdate:short)|",
            "refs/remotes/origin/",
          ],
          repoCommonRoot,
        );
      })(),
      detectShallowClone(repoCommonRoot),
    ]);

  const parsedWorktrees = parseWorktreeListPorcelain(wtRaw.stdout);
  const resolvedWorktreeRows = await Promise.all(
    parsedWorktrees.map(async (wt): Promise<WorktreeAuditRow> => {
      const absPath = await canonicalPath(wt.path);
      const isPrimary = absPath === repoCommonRoot;
      const containsCwd =
        resolvedCwd === absPath || resolvedCwd.startsWith(`${absPath}/`);
      const existsOnDisk = await dirExists(absPath);

      const [work, abRes] = await Promise.all([
        existsOnDisk
          ? inspectWorktreeWork(absPath)
          : Promise.resolve({
              modifiedCount: 0,
              untrackedCount: 0,
              breakdown: EMPTY_DIRTY_BREAKDOWN,
              kind: "clean" as const,
            }),
        wt.headSha.length > 0
          ? getAheadBehind(repoCommonRoot, wt.headSha, baseRef)
          : Promise.resolve({ ahead: 0, behind: 0, ok: false }),
      ]);
      const ahead = abRes.ahead;
      const behind = abRes.behind;
      const isAnc =
        wt.headSha.length > 0
          ? abRes.ok
            ? ahead === 0
            : await checkIsAncestor(repoCommonRoot, wt.headSha, baseRef)
          : false;
      const branchPrs =
        wt.branch !== null ? (ghState.prsByBranch.get(wt.branch) ?? []) : [];
      const hasExactMergedPr = branchPrs.some(
        (p) => p.state === "MERGED" && p.headRefOid === wt.headSha,
      );
      const unapplied =
        !isAnc && ahead > 0 && wt.headSha.length > 0 && !hasExactMergedPr
          ? await getUnappliedCherryCount(repoCommonRoot, wt.headSha, baseRef)
          : null;
      const mergeProof = classifyBranchMergeProof({
        name: wt.branch ?? wt.headSha,
        fullSha: wt.headSha,
        isDefaultBranch: false,
        checkedOutInKeptWorktree: false,
        isAncestor: isAnc,
        shallow,
        aheadCount: ahead,
        unappliedCherryCount: unapplied,
        prsForBranch: branchPrs,
      });
      const headMerged = isCleanBranchDisposition(mergeProof.disposition);
      let anchoredBranch: string | null = null;
      if (wt.detached && wt.headSha.length > 0 && !headMerged) {
        const containsRes = await runCmd(
          [
            "git",
            "for-each-ref",
            "--contains",
            wt.headSha,
            "--format=%(refname:short)",
            "refs/heads/",
            "refs/remotes/origin/",
          ],
          repoCommonRoot,
        );
        if (containsRes.code === 0) {
          const refNames = containsRes.stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(
              (s) => s.length > 0 && s !== "origin" && s !== "origin/HEAD",
            );
          anchoredBranch = refNames[0] ?? null;
        }
      }

      const classified = classifyWorktreeDisposition({
        isPrimary,
        containsCwd,
        registered: true,
        detached: wt.detached,
        anchoredBranch,
        locked: wt.locked,
        prunable: wt.prunable,
        existsOnDisk,
        modifiedCount: work.modifiedCount,
        untrackedCount: work.untrackedCount,
        dirtyKind: work.kind,
        contentEditCount: work.breakdown.contentEdits.length,
        headMerged,
        mergeReason: mergeProof.reason,
        aheadCount: ahead,
      });

      return {
        path: absPath,
        label: compactWorktreeLabel(absPath, repoCommonRoot),
        headShort: wt.headSha.slice(0, 7),
        branch: wt.branch,
        registered: true,
        existsOnDisk,
        modifiedCount: work.modifiedCount,
        untrackedCount: work.untrackedCount,
        dirty: work.breakdown,
        dirtyKind: work.kind,
        aheadCount: ahead,
        behindCount: behind,
        disposition: classified.disposition,
        reason: classified.reason,
      };
    }),
  );

  const registeredPaths = new Set(resolvedWorktreeRows.map((w) => w.path));
  const worktreeRows: WorktreeAuditRow[] = [...resolvedWorktreeRows];

  // Scan known worktree container directories for unregistered orphan folders.
  const home = Bun.env["HOME"] ?? "";
  const repoBaseName = path.basename(repoCommonRoot);
  const candidateContainers = [
    path.join(repoCommonRoot, ".agents", "worktrees"),
    ...(home.length > 0
      ? [path.join(home, ".gemini", "antigravity", "worktrees", repoBaseName)]
      : []),
  ];

  for (const container of candidateContainers) {
    if (!(await dirExists(container))) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(container);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const fullDir = await canonicalPath(path.join(container, name));
      if (registeredPaths.has(fullDir)) continue;
      if (!(await dirExists(fullDir))) continue;
      worktreeRows.push({
        path: fullDir,
        label: compactWorktreeLabel(fullDir, repoCommonRoot),
        headShort: "-",
        branch: null,
        registered: false,
        existsOnDisk: true,
        modifiedCount: 0,
        untrackedCount: 0,
        dirty: EMPTY_DIRTY_BREAKDOWN,
        dirtyKind: "clean",
        aheadCount: 0,
        behindCount: 0,
        disposition: "keep:orphan-dir",
        reason: "unregistered directory (not in git worktree list; protected)",
      });
    }
  }

  // Track which branches are checked out in worktrees that WILL BE KEPT.
  const keptWorktreeBranches = new Set<string>();
  for (const row of worktreeRows) {
    if (
      row.branch !== null &&
      row.disposition !== "clean:merged" &&
      row.disposition !== "clean:detached-anchored" &&
      row.disposition !== "clean:missing-dir"
    ) {
      keptWorktreeBranches.add(row.branch);
    }
  }

  // Audit local and remote branches in parallel using precomputed %(ahead-behind:<baseRef>).
  const localRefEntries = localRefsRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const [name = "", sha = "", committerDate = "", wtPath = "", abRaw = ""] =
        line.split("|");
      return { name, sha, committerDate, wtPath, abRaw };
    })
    .filter((e) => e.name.length > 0 && e.sha.length > 0);

  const remoteRefEntries = remoteRefsRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const [shortRef = "", sha = "", committerDate = "", abRaw = ""] =
        line.split("|");
      return { shortRef, sha, committerDate, abRaw };
    })
    .filter(
      (e) =>
        e.shortRef !== "origin" &&
        e.shortRef !== "origin/HEAD" &&
        e.shortRef.length > 0 &&
        e.sha.length > 0,
    );

  const [localBranches, remoteBranches] = await Promise.all([
    Promise.all(
      localRefEntries.map(async (entry): Promise<BranchAuditRow> => {
        const isDefault = entry.name === "main" || entry.name === "master";
        const parsedAb = parseAheadBehindAtom(entry.abRaw);
        const ab =
          parsedAb ??
          (await getAheadBehind(repoCommonRoot, entry.name, baseRef));
        const ahead = ab.ahead;
        const isAnc =
          parsedAb !== null
            ? ahead === 0
            : await checkIsAncestor(repoCommonRoot, entry.name, baseRef);
        const prs = ghState.prsByBranch.get(entry.name) ?? [];
        const hasExactMergedPr = prs.some(
          (p) => p.state === "MERGED" && p.headRefOid === entry.sha,
        );
        const checkedOutInKept = keptWorktreeBranches.has(entry.name);
        const unapplied =
          !isDefault &&
          !checkedOutInKept &&
          !isAnc &&
          ahead > 0 &&
          !hasExactMergedPr
            ? await getUnappliedCherryCount(repoCommonRoot, entry.name, baseRef)
            : null;
        const proof = classifyBranchMergeProof({
          name: entry.name,
          fullSha: entry.sha,
          isDefaultBranch: isDefault,
          checkedOutInKeptWorktree: checkedOutInKept,
          isAncestor: isAnc,
          shallow,
          aheadCount: ahead,
          unappliedCherryCount: unapplied,
          prsForBranch: prs,
        });

        return {
          scope: "local",
          name: entry.name,
          fullRef: `refs/heads/${entry.name}`,
          sha: entry.sha,
          shortSha: entry.sha.slice(0, 7),
          committerDate: entry.committerDate,
          worktreePath: entry.wtPath.length > 0 ? entry.wtPath : null,
          aheadCount: ahead,
          disposition: proof.disposition,
          reason: proof.reason,
        };
      }),
    ),
    Promise.all(
      remoteRefEntries.map(async (entry): Promise<BranchAuditRow> => {
        const name = entry.shortRef.startsWith("origin/")
          ? entry.shortRef.slice("origin/".length)
          : entry.shortRef;
        const isDefault = name === "main" || name === "master";
        const parsedAb = parseAheadBehindAtom(entry.abRaw);
        const ab =
          parsedAb ??
          (await getAheadBehind(repoCommonRoot, entry.shortRef, baseRef));
        const ahead = ab.ahead;
        const isAnc =
          parsedAb !== null
            ? ahead === 0
            : await checkIsAncestor(repoCommonRoot, entry.shortRef, baseRef);
        const prs = ghState.prsByBranch.get(name) ?? [];
        const hasExactMergedPr = prs.some(
          (p) => p.state === "MERGED" && p.headRefOid === entry.sha,
        );
        const unapplied =
          !isDefault && !isAnc && ahead > 0 && !hasExactMergedPr
            ? await getUnappliedCherryCount(
                repoCommonRoot,
                entry.shortRef,
                baseRef,
              )
            : null;
        const proof = classifyBranchMergeProof({
          name,
          fullSha: entry.sha,
          isDefaultBranch: isDefault,
          checkedOutInKeptWorktree: false,
          isAncestor: isAnc,
          shallow,
          aheadCount: ahead,
          unappliedCherryCount: unapplied,
          prsForBranch: prs,
        });

        return {
          scope: "remote",
          name,
          fullRef: `refs/remotes/${entry.shortRef}`,
          sha: entry.sha,
          shortSha: entry.sha.slice(0, 7),
          committerDate: entry.committerDate,
          worktreePath: null,
          aheadCount: ahead,
          disposition: proof.disposition,
          reason: proof.reason,
        };
      }),
    ),
  ]);

  // Deterministic shape: sort once, then derive every candidate list from the
  // sorted rows, so two runs over the same repository emit identical bytes.
  const sortedWorktrees = sortWorktreeRows(worktreeRows);
  const sortedLocalBranches = sortBranchRows(localBranches);
  const sortedRemoteBranches = sortBranchRows(remoteBranches);

  const pruneCount = sortedWorktrees.filter(
    (w) => w.disposition === "clean:missing-dir",
  ).length;
  const removeWorktrees = sortedWorktrees
    .filter(
      (w) =>
        w.disposition === "clean:merged" ||
        w.disposition === "clean:detached-anchored",
    )
    .map((w) => w.path);
  const deleteLocalBranches = sortedLocalBranches
    .filter((b) => isCleanBranchDisposition(b.disposition))
    .map((b) => b.name);
  const deleteRemoteBranches = sortedRemoteBranches
    .filter((b) => isCleanBranchDisposition(b.disposition))
    .map((b) => b.name);

  const candidates: CleanupCandidates = {
    pruneWorktrees: pruneCount,
    removeWorktrees,
    deleteLocalBranches,
    deleteRemoteBranches,
  };

  let applied: AppliedCleanupSummary | null = null;
  let finalDeleteBranchOnMerge = ghState.deleteBranchOnMerge;

  if (options.apply) {
    await runCmd(["git", "worktree", "prune"], repoCommonRoot);

    const removedWorktrees: string[] = [];
    for (const wtPath of removeWorktrees) {
      const freshCheck = await inspectWorktreeWork(wtPath);
      if (freshCheck.modifiedCount > 0 || freshCheck.untrackedCount > 0) {
        continue;
      }
      const rmRes = await runCmd(
        ["git", "worktree", "remove", wtPath],
        repoCommonRoot,
      );
      if (rmRes.code === 0) {
        removedWorktrees.push(wtPath);
      } else {
        // Re-verify porcelain status is still 100% clean before allowing removal of a
        // clean worktree that only contains gitignored build/dependency artifacts (e.g. node_modules).
        const recheck = await runCmd(["git", "status", "--porcelain"], wtPath);
        if (recheck.code === 0 && recheck.stdout.trim().length === 0) {
          const forceCleanRes = await runCmd(
            ["git", "worktree", "remove", "--force", wtPath],
            repoCommonRoot,
          );
          if (forceCleanRes.code === 0) {
            removedWorktrees.push(wtPath);
          }
        }
      }
    }

    const deletedLocalBranches: string[] = [];
    for (const branchName of deleteLocalBranches) {
      const delRes = await runCmd(
        ["git", "branch", "-D", branchName],
        repoCommonRoot,
      );
      if (delRes.code === 0) {
        deletedLocalBranches.push(branchName);
      }
    }

    const deletedRemoteBranches: string[] = [];
    if (
      options.applyRemote &&
      !options.offline &&
      deleteRemoteBranches.length > 0
    ) {
      // Remote deletions send zero commits (`0000...`); run from `resolvedCwd` so git hooks
      // evaluate the operator's active worktree rather than any unrelated WIP in primary root.
      const pushRes = await runCmd(
        ["git", "push", "origin", "--delete", ...deleteRemoteBranches],
        resolvedCwd,
      );
      if (pushRes.code === 0) {
        deletedRemoteBranches.push(...deleteRemoteBranches);
      } else {
        // Fall back to one-by-one if any single ref raced or was already deleted on remote.
        for (const remoteName of deleteRemoteBranches) {
          const singleRes = await runCmd(
            ["git", "push", "origin", "--delete", remoteName],
            resolvedCwd,
          );
          if (singleRes.code === 0) {
            deletedRemoteBranches.push(remoteName);
          }
        }
      }
      await runCmd(["git", "fetch", "--prune", "origin"], repoCommonRoot);
    }

    let enabledDeleteBranchOnMerge = false;
    if (
      options.ensureAutoDelete &&
      !options.offline &&
      finalDeleteBranchOnMerge === false
    ) {
      const ghBin = Bun.which("gh", { PATH: Bun.env["PATH"] ?? "" });
      if (ghBin) {
        const editRes = await runCmd(
          [ghBin, "repo", "edit", "--delete-branch-on-merge"],
          repoCommonRoot,
        );
        if (editRes.code === 0) {
          enabledDeleteBranchOnMerge = true;
          finalDeleteBranchOnMerge = true;
        }
      }
    }

    applied = {
      prunedWorktrees: true,
      removedWorktrees,
      deletedLocalBranches,
      deletedRemoteBranches,
      enabledDeleteBranchOnMerge,
    };
  }

  return {
    schemaVersion: WORKTREE_REPORT_SCHEMA_VERSION,
    repoCommonRoot,
    baseRef,
    baseSha,
    offline: options.offline,
    githubPrsLoaded: ghState.prCount,
    githubPrListTruncated: ghState.truncated,
    shallow,
    deleteBranchOnMerge: finalDeleteBranchOnMerge,
    worktrees: sortedWorktrees,
    localBranches: sortedLocalBranches,
    remoteBranches: sortedRemoteBranches,
    candidates,
    summary: buildHygieneSummary({
      worktrees: sortedWorktrees,
      localBranches: sortedLocalBranches,
      remoteBranches: sortedRemoteBranches,
      candidates,
    }),
    applied,
  };
}

function printUsage(): void {
  console.log(`dx worktrees — Git worktree & local/remote branch hygiene

Usage:
  ./bin/dx worktrees [flags]

Flags:
  --apply                Execute safe local cleanups (prune missing, remove clean merged worktrees & local branches)
  --remote               With --apply, also delete proven-merged remote branches on origin
  --ensure-auto-delete   With --apply, enable GitHub deleteBranchOnMerge on the repository
  --fetch                Run 'git fetch --prune origin' during a dry-run audit
  --offline              Skip network/GitHub queries (local git ancestry & cherry only)
  --pr-limit <n>         GitHub PRs to read, newest first (default ${DEFAULT_PR_LIMIT});
                         the report flags truncation rather than treating a full page as "no PR"
  --json                 Output machine-readable JSON
  --yaml                 Output machine-readable YAML (Bun.YAML)
  -h, --help             Show this help

Dirty worktrees are split into real work and artifacts: a path counts as work when
its bytes changed or git does not track it, and as an artifact when only the mode
bits or the symlink type changed. A shallow clone is reported as such, because
'merge-base --is-ancestor' and 'git cherry' cannot see past the graft and would
otherwise label merged branches as unmerged.

Examples:
  ./bin/dx worktrees                                  # audit, no writes
  ./bin/dx worktrees --offline --json                 # audit without network
  ./bin/dx worktrees --apply                          # prune clean merged worktrees & branches
  ./bin/dx worktrees --pr-limit 2000 --yaml           # widen the PR page for an old branch`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      apply: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      "ensure-auto-delete": { type: "boolean", default: false },
      fetch: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      "pr-limit": { type: "string" },
      json: { type: "boolean", default: false },
      yaml: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    return 0;
  }

  const prLimitRaw = values["pr-limit"];
  let prLimit: number | undefined;
  if (prLimitRaw !== undefined) {
    const parsed = Number.parseInt(prLimitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(
        `Error: --pr-limit expects a positive integer, got '${prLimitRaw}'.\n  ./bin/dx worktrees --pr-limit 2000`,
      );
      return 2;
    }
    prLimit = parsed;
  }

  const report = await runWorktreeHygiene({
    cwd: process.cwd(),
    offline: values.offline ?? false,
    fetchRemote: values.fetch ?? false,
    apply: values.apply ?? false,
    applyRemote: values.remote ?? false,
    ensureAutoDelete: values["ensure-auto-delete"] ?? false,
    ...(prLimit === undefined ? {} : { prLimit }),
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (values.yaml) {
    console.log(YAML.stringify(report, null, 2).trimEnd());
  } else {
    console.log(
      inspectReport(
        new InspectableWorktreeHygieneReport(report),
        cliInspectOptions(),
      ),
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
