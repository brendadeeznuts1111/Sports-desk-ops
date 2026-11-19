import { YAML } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BRANCH_DISPOSITIONS,
  buildHygieneSummary,
  classifyBranchMergeProof,
  classifyDirtyPath,
  classifyDirtyWork,
  classifyWorktreeDisposition,
  DEFAULT_PR_LIMIT,
  InspectableWorktreeHygieneReport,
  parseNumstatZ,
  parseRawDiffZ,
  parseWorktreeListPorcelain,
  runWorktreeHygiene,
  sortBranchRows,
  sortWorktreeRows,
  summarizeDirtyWork,
  summarizeDirtyWorktrees,
  type BranchAuditRow,
  type BranchDisposition,
  type CleanupCandidates,
  type DirtyWorkBreakdown,
  type WorktreeAuditRow,
  type WorktreeDisposition,
  WORKTREE_DISPOSITIONS,
  WORKTREE_REPORT_SCHEMA_VERSION,
} from "../scripts/dx_worktrees.ts";
import { cliInspectOptions, inspectReport } from "../lib/cli_inspect.ts";

const SCRATCH = realpathSync(
  mkdtempSync(path.join(tmpdir(), "dx-worktrees-test-")),
);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: "Test Operator",
      GIT_AUTHOR_EMAIL: "operator@example.com",
      GIT_COMMITTER_NAME: "Test Operator",
      GIT_COMMITTER_EMAIL: "operator@example.com",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
  }
  return stdout.trim();
}

describe("parseWorktreeListPorcelain", () => {
  test("parses primary, attached, detached, locked, and prunable entries", () => {
    const sample = [
      "worktree /repo/root",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/wt-detached",
      "HEAD 2222222222222222222222222222222222222222",
      "detached",
      "locked active experiment",
      "",
      "worktree /tmp/wt-missing",
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/feat/gone",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const parsed = parseWorktreeListPorcelain(sample);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      path: "/repo/root",
      headSha: "1111111111111111111111111111111111111111",
      branch: "main",
      detached: false,
      locked: false,
      prunable: false,
    });
    expect(parsed[1]).toEqual({
      path: "/tmp/wt-detached",
      headSha: "2222222222222222222222222222222222222222",
      branch: null,
      detached: true,
      locked: true,
      prunable: false,
    });
    expect(parsed[2]).toEqual({
      path: "/tmp/wt-missing",
      headSha: "3333333333333333333333333333333333333333",
      branch: "feat/gone",
      detached: false,
      locked: false,
      prunable: true,
    });
  });
});

describe("classifyBranchMergeProof", () => {
  const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  test("protects default and kept-worktree branches before merge checks", () => {
    expect(
      classifyBranchMergeProof({
        name: "main",
        fullSha: shaA,
        isDefaultBranch: true,
        checkedOutInKeptWorktree: false,
        isAncestor: true,
        shallow: false,
        aheadCount: 0,
        unappliedCherryCount: null,
        prsForBranch: [],
      }).disposition,
    ).toBe("protected:default");

    expect(
      classifyBranchMergeProof({
        name: "feat/active",
        fullSha: shaA,
        isDefaultBranch: false,
        checkedOutInKeptWorktree: true,
        isAncestor: true,
        shallow: false,
        aheadCount: 0,
        unappliedCherryCount: null,
        prsForBranch: [],
      }).disposition,
    ).toBe("protected:worktree");
  });

  test("distinguishes exact squash-PR match from post-PR commits on the same branch name", () => {
    const exact = classifyBranchMergeProof({
      name: "feat/squash",
      fullSha: shaA,
      isDefaultBranch: false,
      checkedOutInKeptWorktree: false,
      isAncestor: false,
      shallow: false,
      aheadCount: 2,
      unappliedCherryCount: 2,
      prsForBranch: [
        {
          number: 113,
          headRefName: "feat/squash",
          headRefOid: shaA,
          state: "MERGED",
          mergedAt: "2026-11-09T00:00:00Z",
        },
      ],
    });
    expect(exact.disposition).toBe("clean:squash-pr");
    expect(exact.reason).toContain("PR #113");

    const postPr = classifyBranchMergeProof({
      name: "feat/squash",
      fullSha: shaB,
      isDefaultBranch: false,
      checkedOutInKeptWorktree: false,
      isAncestor: false,
      shallow: false,
      aheadCount: 3,
      unappliedCherryCount: 1,
      prsForBranch: [
        {
          number: 113,
          headRefName: "feat/squash",
          headRefOid: shaA,
          state: "MERGED",
          mergedAt: "2026-11-09T00:00:00Z",
        },
      ],
    });
    expect(postPr.disposition).toBe("keep:post-pr-commits");
  });

  test("detects git cherry patch-equivalence, open PRs, ancestry, and unmerged branches", () => {
    expect(
      classifyBranchMergeProof({
        name: "feat/anc",
        fullSha: shaA,
        isDefaultBranch: false,
        checkedOutInKeptWorktree: false,
        isAncestor: true,
        shallow: false,
        aheadCount: 0,
        unappliedCherryCount: null,
        prsForBranch: [],
      }).disposition,
    ).toBe("clean:ancestor");

    expect(
      classifyBranchMergeProof({
        name: "feat/cherry",
        fullSha: shaA,
        isDefaultBranch: false,
        checkedOutInKeptWorktree: false,
        isAncestor: false,
        shallow: false,
        aheadCount: 1,
        unappliedCherryCount: 0,
        prsForBranch: [],
      }).disposition,
    ).toBe("clean:patch-equivalent");

    expect(
      classifyBranchMergeProof({
        name: "feat/open",
        fullSha: shaA,
        isDefaultBranch: false,
        checkedOutInKeptWorktree: false,
        isAncestor: false,
        shallow: false,
        aheadCount: 1,
        unappliedCherryCount: 1,
        prsForBranch: [
          {
            number: 150,
            headRefName: "feat/open",
            headRefOid: shaA,
            state: "OPEN",
            mergedAt: null,
          },
        ],
      }).disposition,
    ).toBe("keep:open-pr");

    expect(
      classifyBranchMergeProof({
        name: "feat/wip",
        fullSha: shaA,
        isDefaultBranch: false,
        checkedOutInKeptWorktree: false,
        isAncestor: false,
        shallow: false,
        aheadCount: 4,
        unappliedCherryCount: 4,
        prsForBranch: [],
      }).disposition,
    ).toBe("keep:unmerged");
  });
});

describe("classifyWorktreeDisposition", () => {
  const base = {
    isPrimary: false,
    containsCwd: false,
    registered: true,
    detached: false,
    anchoredBranch: null,
    locked: false,
    prunable: false,
    existsOnDisk: true,
    modifiedCount: 0,
    untrackedCount: 0,
    dirtyKind: "clean",
    contentEditCount: 0,
    headMerged: false,
    mergeReason: "unmerged",
    aheadCount: 1,
  } as const;

  test("enforces all zero-data-loss protection invariants", () => {
    expect(
      classifyWorktreeDisposition({ ...base, registered: false }).disposition,
    ).toBe("keep:orphan-dir");
    expect(
      classifyWorktreeDisposition({
        ...base,
        isPrimary: true,
        headMerged: true,
      }).disposition,
    ).toBe("keep:primary");
    expect(
      classifyWorktreeDisposition({ ...base, existsOnDisk: false }).disposition,
    ).toBe("clean:missing-dir");
    expect(
      classifyWorktreeDisposition({ ...base, locked: true, headMerged: true })
        .disposition,
    ).toBe("keep:locked");
    expect(
      classifyWorktreeDisposition({
        ...base,
        containsCwd: true,
        headMerged: true,
      }).disposition,
    ).toBe("keep:cwd");
    expect(
      classifyWorktreeDisposition({
        ...base,
        modifiedCount: 1,
        headMerged: true,
      }).disposition,
    ).toBe("keep:dirty");
    expect(
      classifyWorktreeDisposition({
        ...base,
        headMerged: true,
        mergeReason: "commit is ancestor of base branch",
      }).disposition,
    ).toBe("clean:merged");
    expect(
      classifyWorktreeDisposition({
        ...base,
        detached: true,
        anchoredBranch: "fix/anchor",
      }).disposition,
    ).toBe("clean:detached-anchored");
    expect(classifyWorktreeDisposition(base).disposition).toBe("keep:ahead");
  });
});

describe("runWorktreeHygiene end-to-end in isolated scratch repo", () => {
  test("removes clean merged/anchored worktrees & merged branches while preserving dirty, unmerged, cwd, and orphan dirs", async () => {
    const repo = mkdtempSync(path.join(SCRATCH, "repo-"));
    await git(repo, ["init", "-b", "main"]);
    await Bun.write(path.join(repo, ".gitignore"), "node_modules/\n");
    await Bun.write(path.join(repo, "README.md"), "# Scratch Repo\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial commit"]);

    // 1. Merged branch + clean worktree WITH ignored node_modules (verifies safe clean removal)
    const wtMerged = path.join(SCRATCH, "wt-merged");
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "feat/merged-wt",
      wtMerged,
      "main",
    ]);
    mkdirSync(path.join(wtMerged, "node_modules", "pkg"), { recursive: true });
    await Bun.write(
      path.join(wtMerged, "node_modules", "pkg", "index.js"),
      "export {};\n",
    );

    // 2. Dirty worktree on merged commit (MUST BE KEPT)
    const wtDirty = path.join(SCRATCH, "wt-dirty");
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "feat/dirty-wt",
      wtDirty,
      "main",
    ]);
    await Bun.write(
      path.join(wtDirty, "uncommitted.txt"),
      "precious local work\n",
    );

    // 3. Active CWD worktree on merged commit (MUST BE KEPT)
    const wtCwd = path.join(SCRATCH, "wt-cwd");
    await git(repo, ["worktree", "add", "-b", "feat/cwd-wt", wtCwd, "main"]);

    // 4. Unmerged branch + detached clean worktree anchored by that branch
    await git(repo, ["checkout", "-b", "feat/unmerged-anchor"]);
    await Bun.write(path.join(repo, "feature.txt"), "unmerged feature\n");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "unmerged commit"]);
    const unmergedSha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "main"]);

    const wtDetachedAnchored = path.join(SCRATCH, "wt-detached-anchored");
    await git(repo, [
      "worktree",
      "add",
      "--detach",
      wtDetachedAnchored,
      unmergedSha,
    ]);

    // 5. Standalone merged local branch (no worktree)
    await git(repo, ["branch", "chore/standalone-merged", "main"]);

    // 6. Unregistered orphan folder inside .agents/worktrees (MUST BE KEPT)
    const orphanDir = path.join(repo, ".agents", "worktrees", "private-patch");
    mkdirSync(orphanDir, { recursive: true });
    await Bun.write(path.join(orphanDir, "apply.sh"), "#!/bin/sh\n");

    // Dry-run first from wtCwd
    const dryRun = await runWorktreeHygiene({
      cwd: wtCwd,
      offline: true,
      fetchRemote: false,
      apply: false,
      applyRemote: false,
      ensureAutoDelete: false,
    });

    expect(dryRun.applied).toBeNull();
    expect([...dryRun.candidates.removeWorktrees].sort()).toEqual(
      [wtDetachedAnchored, wtMerged].sort(),
    );
    // Once wtMerged is slated for removal, feat/merged-wt is no longer in a kept worktree -> clean:ancestor!
    expect([...dryRun.candidates.deleteLocalBranches].sort()).toEqual(
      ["chore/standalone-merged", "feat/merged-wt"].sort(),
    );

    // Verify YAML & custom inspect rendering round-trip cleanly
    const yamlOut = YAML.stringify(dryRun, null, 2);
    const reparsed = YAML.parse(yamlOut) as { baseRef: string };
    expect(reparsed.baseRef).toBe("main");
    const rendered = inspectReport(
      new InspectableWorktreeHygieneReport(dryRun),
      cliInspectOptions({ isTTY: false }),
    );
    expect(rendered).toContain("Safe Cleanup Candidates:");
    expect(rendered).toContain("keep:orphan-dir");

    // The report shape is a contract: versioned, summarized, order-stable.
    expect(dryRun.schemaVersion).toBe(WORKTREE_REPORT_SCHEMA_VERSION);
    expect(Object.keys(dryRun).sort()).toEqual([
      "applied",
      "baseRef",
      "baseSha",
      "candidates",
      "deleteBranchOnMerge",
      "githubPrListTruncated",
      "githubPrsLoaded",
      "localBranches",
      "offline",
      "remoteBranches",
      "repoCommonRoot",
      "schemaVersion",
      "shallow",
      "summary",
      "worktrees",
    ]);
    // Summary totals are derived from the rows, never counted twice.
    expect(dryRun.summary.worktrees.total).toBe(dryRun.worktrees.length);
    expect(dryRun.summary.localBranches.total).toBe(
      dryRun.localBranches.length,
    );
    expect(dryRun.summary.remoteBranches.total).toBe(
      dryRun.remoteBranches.length,
    );
    expect(dryRun.summary.candidates.removeWorktrees).toBe(
      dryRun.candidates.removeWorktrees.length,
    );
    expect(Object.keys(dryRun.summary.worktrees.byDisposition)).toEqual([
      ...WORKTREE_DISPOSITIONS,
    ]);
    // Order is part of the shape, so a diff shows only real change.
    const labels = dryRun.worktrees.map((w) => w.label);
    expect([...labels].sort()).toEqual(labels);

    // Now apply local cleanup
    const appliedReport = await runWorktreeHygiene({
      cwd: wtCwd,
      offline: true,
      fetchRemote: false,
      apply: true,
      applyRemote: false,
      ensureAutoDelete: false,
    });

    expect(appliedReport.applied).not.toBeNull();
    expect([...(appliedReport.applied?.removedWorktrees ?? [])].sort()).toEqual(
      [wtDetachedAnchored, wtMerged].sort(),
    );
    expect(
      [...(appliedReport.applied?.deletedLocalBranches ?? [])].sort(),
    ).toEqual(["chore/standalone-merged", "feat/merged-wt"].sort());

    // Clean worktrees were removed
    expect(existsSync(wtMerged)).toBe(false);
    expect(existsSync(wtDetachedAnchored)).toBe(false);

    // Protected worktrees, uncommitted files, unmerged branch, and orphan dir remain intact
    expect(existsSync(path.join(wtDirty, "uncommitted.txt"))).toBe(true);
    expect(existsSync(wtCwd)).toBe(true);
    expect(existsSync(path.join(orphanDir, "apply.sh"))).toBe(true);

    const remainingBranches = (
      await git(repo, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ])
    ).split("\n");
    expect(remainingBranches).toContain("main");
    expect(remainingBranches).toContain("feat/dirty-wt");
    expect(remainingBranches).toContain("feat/cwd-wt");
    expect(remainingBranches).toContain("feat/unmerged-anchor");
    expect(remainingBranches).not.toContain("feat/merged-wt");
    expect(remainingBranches).not.toContain("chore/standalone-merged");
  });
});

// Fixtures captured from git 2.x on Bun 1.4.4 with:
//   rm link.ts && printf 'line1\n' > link.ts   (symlink dereferenced into a file)
//   chmod -x mode-only.ts                      (mode bits only)
//   printf 'changed\n' > content.ts            (a real edit)
const RAW_DIFF_FIXTURE = [
  ":100644 100644 dcc2780 0000000 M",
  "content.ts",
  ":120000 100644 de76b08 0000000 T",
  "link.ts",
  ":100755 100644 d95f3ad 0000000 M",
  "mode-only.ts",
  "",
].join("\0");

const NUMSTAT_FIXTURE = [
  "1\t1\tcontent.ts",
  "1\t1\tlink.ts",
  "0\t0\tmode-only.ts",
  "",
].join("\0");

describe("dirty work classification", () => {
  test("pairs each raw header with its NUL-terminated path", () => {
    const entries = parseRawDiffZ(RAW_DIFF_FIXTURE);
    expect(entries.map((e) => e.path)).toEqual([
      "content.ts",
      "link.ts",
      "mode-only.ts",
    ]);
    expect(entries.map((e) => e.status)).toEqual(["M", "T", "M"]);
    const chmodOnly = entries.find((e) => e.path === "mode-only.ts");
    expect(chmodOnly?.oldMode).toBe("100755");
    expect(chmodOnly?.newMode).toBe("100644");
  });

  test("keeps tabs inside a path and reports binary counts as null", () => {
    const counts = parseNumstatZ(
      ["1\t2\ta\tb.ts", "-\t-\tlogo.png", ""].join("\0"),
    );
    expect(counts.get("a\tb.ts")).toEqual({ added: 1, deleted: 2 });
    expect(counts.get("logo.png")).toEqual({ added: null, deleted: null });
  });

  test("separates real edits from chmod noise and symlink dereference", () => {
    const breakdown = summarizeDirtyWork(
      parseRawDiffZ(RAW_DIFF_FIXTURE),
      parseNumstatZ(NUMSTAT_FIXTURE),
      ["untracked.ts"],
    );
    expect(breakdown.contentEdits).toEqual(["content.ts"]);
    expect(breakdown.typeChanges).toEqual(["link.ts"]);
    expect(breakdown.modeOnly).toEqual(["mode-only.ts"]);
    expect(breakdown.untracked).toEqual(["untracked.ts"]);
    expect(classifyDirtyWork(breakdown)).toBe("has-work");
  });

  test("a binary edit is content even though its line counts are '-'", () => {
    const logo = parseRawDiffZ(
      [":100644 100644 1111111 0000000 M", "logo.png", ""].join("\0"),
    ).at(0);
    if (logo === undefined) throw new Error("fixture did not parse");
    const counts = parseNumstatZ(["-\t-\tlogo.png", ""].join("\0"));
    expect(classifyDirtyPath(logo, counts.get("logo.png"))).toBe("content");
  });

  test("mode bits and dereferenced symlinks alone are artifacts, not work", () => {
    const artifactsOnly = summarizeDirtyWork(
      parseRawDiffZ(RAW_DIFF_FIXTURE),
      parseNumstatZ(NUMSTAT_FIXTURE),
      [],
    );
    expect(classifyDirtyWork({ ...artifactsOnly, contentEdits: [] })).toBe(
      "artifacts-only",
    );
    expect(
      classifyDirtyWork({
        contentEdits: [],
        modeOnly: [],
        typeChanges: [],
        untracked: [],
      }),
    ).toBe("clean");
  });
});

describe("classifyBranchMergeProof under a shallow clone", () => {
  const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const proof = (overrides: {
    readonly shallow: boolean;
    readonly unappliedCherryCount: number | null;
    readonly prsForBranch?: readonly {
      readonly number: number;
      readonly headRefName: string;
      readonly headRefOid: string;
      readonly state: "OPEN" | "MERGED" | "CLOSED";
      readonly mergedAt: string | null;
    }[];
  }) =>
    classifyBranchMergeProof({
      name: "feat/deep-history",
      fullSha: shaA,
      isDefaultBranch: false,
      checkedOutInKeptWorktree: false,
      isAncestor: false,
      shallow: overrides.shallow,
      aheadCount: 40,
      unappliedCherryCount: overrides.unappliedCherryCount,
      prsForBranch: overrides.prsForBranch ?? [],
    });

  test("reports unknown ancestry instead of a confident unmerged verdict", () => {
    const shallow = proof({ shallow: true, unappliedCherryCount: null });
    expect(shallow.disposition).toBe("unknown:shallow-ancestry");
    expect(shallow.reason).toContain("--deepen");
  });

  test("a complete clone still answers unmerged when cherry cannot prove equivalence", () => {
    expect(
      proof({ shallow: false, unappliedCherryCount: 40 }).disposition,
    ).toBe("keep:unmerged");
  });

  test("an exact merged PR proves a squash merge even in a shallow clone", () => {
    const prShallow = proof({
      shallow: true,
      unappliedCherryCount: null,
      prsForBranch: [
        {
          number: 180,
          headRefName: "feat/deep-history",
          headRefOid: shaA,
          state: "MERGED",
          mergedAt: "2026-11-13T00:00:00Z",
        },
      ],
    });
    expect(prShallow.disposition).toBe("clean:squash-pr");
  });
});

describe("classifyWorktreeDisposition distinguishes artifact dirt from work", () => {
  const base = {
    isPrimary: false,
    containsCwd: false,
    registered: true,
    detached: false,
    anchoredBranch: null,
    locked: false,
    prunable: false,
    existsOnDisk: true,
    headMerged: false,
    mergeReason: "unmerged",
    aheadCount: 1,
  } as const;

  test("artifact-only dirt names the recovery command", () => {
    const artifacts = classifyWorktreeDisposition({
      ...base,
      modifiedCount: 35,
      untrackedCount: 0,
      dirtyKind: "artifacts-only",
      contentEditCount: 0,
    });
    expect(artifacts.disposition).toBe("keep:dirty-artifacts");
    expect(artifacts.reason).toContain("git checkout -- .");
  });

  test("real work counts content edits and untracked files", () => {
    const work = classifyWorktreeDisposition({
      ...base,
      modifiedCount: 5,
      untrackedCount: 2,
      dirtyKind: "has-work",
      contentEditCount: 3,
    });
    expect(work.disposition).toBe("keep:dirty");
    expect(work.reason).toContain("3 content edit(s)");
  });
});

describe("runWorktreeHygiene reports dirty work and clone depth", () => {
  test("splits a copy-damaged worktree into content, symlink and chmod artifacts", async () => {
    const repo = mkdtempSync(path.join(SCRATCH, "damaged-"));
    await git(repo, ["init", "-b", "main"]);
    await Bun.write(path.join(repo, "content.ts"), "original\n");
    await Bun.write(path.join(repo, "mode-only.ts"), "stable\n");
    await Bun.write(path.join(repo, "target.ts"), "line1\n");
    symlinkSync("target.ts", path.join(repo, "link.ts"));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);

    const wt = path.join(SCRATCH, "wt-damaged");
    await git(repo, ["worktree", "add", "-b", "feat/damaged", wt, "main"]);

    // What a copy tool does to a checkout: the symlink becomes a regular file.
    rmSync(path.join(wt, "link.ts"));
    await Bun.write(path.join(wt, "link.ts"), "line1\n");
    chmodSync(path.join(wt, "mode-only.ts"), 0o755);
    await Bun.write(path.join(wt, "content.ts"), "edited\n");
    await Bun.write(path.join(wt, "untracked.ts"), "new\n");

    const report = await runWorktreeHygiene({
      cwd: repo,
      offline: true,
      fetchRemote: false,
      apply: false,
      applyRemote: false,
      ensureAutoDelete: false,
    });

    expect(report.shallow).toBe(false);
    const row = report.worktrees.find((w) => w.path === realpathSync(wt));
    if (row === undefined) throw new Error("damaged worktree was not reported");
    expect(row.dirtyKind).toBe("has-work");
    expect(row.dirty.contentEdits).toContain("content.ts");
    expect(row.dirty.typeChanges).toContain("link.ts");
    expect(row.dirty.modeOnly).toContain("mode-only.ts");
    expect(row.dirty.untracked).toEqual(["untracked.ts"]);
    expect(row.disposition).toBe("keep:dirty");

    // Artifact damage is reported, never removed: the worktree survives the audit.
    expect(existsSync(path.join(wt, "content.ts"))).toBe(true);
  });

  test("flags a shallow clone so graft-cut ancestry is not read as evidence", async () => {
    const source = mkdtempSync(path.join(SCRATCH, "shallow-src-"));
    await git(source, ["init", "-b", "main"]);
    await Bun.write(path.join(source, "a.txt"), "a\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "one"]);
    await Bun.write(path.join(source, "b.txt"), "b\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "two"]);

    const clone = path.join(SCRATCH, "shallow-clone");
    await git(SCRATCH, ["clone", "--depth", "1", `file://${source}`, clone]);

    const report = await runWorktreeHygiene({
      cwd: clone,
      offline: true,
      fetchRemote: false,
      apply: false,
      applyRemote: false,
      ensureAutoDelete: false,
    });

    expect(report.shallow).toBe(true);
    const rendered = inspectReport(
      new InspectableWorktreeHygieneReport(report),
      cliInspectOptions({ isTTY: false }),
    );
    expect(rendered).toContain("shallow");
  });
});

describe("dx worktrees CLI surface", () => {
  const script = path.join(import.meta.dir, "..", "scripts", "dx_worktrees.ts");

  test("--help documents the flags with runnable examples", async () => {
    const proc = Bun.spawn([process.execPath, script, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("--pr-limit");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("./bin/dx worktrees --apply");
    expect(stdout).toContain(`default ${DEFAULT_PR_LIMIT}`);
  });

  test("--pr-limit rejects a non-positive page size with a corrective example", async () => {
    const proc = Bun.spawn(
      [process.execPath, script, "--pr-limit", "0", "--offline"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("positive integer");
    expect(stderr).toContain("--pr-limit 2000");
  });
});

const CLEAN_BREAKDOWN: DirtyWorkBreakdown = {
  contentEdits: [],
  modeOnly: [],
  typeChanges: [],
  untracked: [],
};

function worktreeRow(
  label: string,
  disposition: WorktreeDisposition,
  dirty: DirtyWorkBreakdown = CLEAN_BREAKDOWN,
): WorktreeAuditRow {
  return {
    path: `/repo/${label}`,
    label,
    headShort: "0000000",
    branch: label,
    registered: true,
    existsOnDisk: true,
    modifiedCount:
      dirty.contentEdits.length +
      dirty.modeOnly.length +
      dirty.typeChanges.length,
    untrackedCount: dirty.untracked.length,
    dirty,
    dirtyKind: classifyDirtyWork(dirty),
    aheadCount: 0,
    behindCount: 0,
    disposition,
    reason: "fixture",
  };
}

function branchRow(
  name: string,
  disposition: BranchDisposition,
  committerDate = "2026-11-18",
): BranchAuditRow {
  return {
    scope: "local",
    name,
    fullRef: `refs/heads/${name}`,
    sha: "0".repeat(40),
    shortSha: "0000000",
    committerDate,
    worktreePath: null,
    aheadCount: 0,
    disposition,
    reason: "fixture",
  };
}

const NO_CANDIDATES: CleanupCandidates = {
  pruneWorktrees: 0,
  removeWorktrees: [],
  deleteLocalBranches: [],
  deleteRemoteBranches: [],
};

describe("report summary shape", () => {
  test("every disposition key is present, so zero is never mistaken for missing", () => {
    const summary = buildHygieneSummary({
      worktrees: [worktreeRow("a", "keep:primary")],
      localBranches: [branchRow("main", "protected:default")],
      remoteBranches: [],
      candidates: NO_CANDIDATES,
    });
    expect(Object.keys(summary.worktrees.byDisposition)).toEqual([
      ...WORKTREE_DISPOSITIONS,
    ]);
    expect(Object.keys(summary.localBranches.byDisposition)).toEqual([
      ...BRANCH_DISPOSITIONS,
    ]);
    expect(summary.worktrees.total).toBe(1);
    expect(summary.worktrees.byDisposition["keep:primary"]).toBe(1);
    expect(summary.worktrees.byDisposition["clean:merged"]).toBe(0);
    expect(summary.localBranches.total).toBe(1);
    expect(summary.remoteBranches.total).toBe(0);
  });

  test("dirty totals separate work from recoverable artifacts", () => {
    const summary = buildHygieneSummary({
      worktrees: [
        worktreeRow("a", "keep:dirty", {
          contentEdits: ["x.ts"],
          modeOnly: [],
          typeChanges: [],
          untracked: ["u.ts"],
        }),
        worktreeRow("b", "keep:dirty-artifacts", {
          contentEdits: [],
          modeOnly: ["m1.ts", "m2.ts"],
          typeChanges: ["t.ts"],
          untracked: [],
        }),
      ],
      localBranches: [],
      remoteBranches: [],
      candidates: NO_CANDIDATES,
    });
    expect(summary.dirty.worktreesDirty).toBe(2);
    expect(summary.dirty.contentEdits).toBe(1);
    expect(summary.dirty.untracked).toBe(1);
    expect(summary.dirty.modeOnly).toBe(2);
    expect(summary.dirty.typeChanges).toBe(1);
    expect(summary.dirty.workPaths).toBe(2);
    expect(summary.dirty.artifactPaths).toBe(3);
  });

  test("candidate counts are the array lengths, not a second tally", () => {
    const summary = buildHygieneSummary({
      worktrees: [],
      localBranches: [],
      remoteBranches: [],
      candidates: {
        pruneWorktrees: 2,
        removeWorktrees: ["/a", "/b"],
        deleteLocalBranches: ["x"],
        deleteRemoteBranches: [],
      },
    });
    expect(summary.candidates).toEqual({
      pruneWorktrees: 2,
      removeWorktrees: 2,
      deleteLocalBranches: 1,
      deleteRemoteBranches: 0,
    });
  });

  test("only a tree with more than mode bits or symlink type counts as dirty", () => {
    const totals = summarizeDirtyWorktrees([
      worktreeRow("clean", "keep:primary"),
      worktreeRow("artifacts", "keep:dirty-artifacts", {
        contentEdits: [],
        modeOnly: ["m.ts"],
        typeChanges: [],
        untracked: [],
      }),
      worktreeRow("work", "keep:dirty", {
        contentEdits: ["a.ts"],
        modeOnly: [],
        typeChanges: [],
        untracked: [],
      }),
    ]);
    expect(totals.worktreesDirty).toBe(2);
    expect(totals.workPaths).toBe(1);
    expect(totals.artifactPaths).toBe(1);
  });
});

describe("deterministic ordering", () => {
  test("worktrees sort by label, whatever order they were audited in", () => {
    const rows = [
      worktreeRow("zeta", "keep:primary"),
      worktreeRow("alpha", "keep:dirty"),
      worktreeRow("middle", "clean:merged"),
    ];
    expect(sortWorktreeRows(rows).map((r) => r.label)).toEqual([
      "alpha",
      "middle",
      "zeta",
    ]);
  });

  test("branches sort newest first, breaking date ties by name", () => {
    const rows = [
      branchRow("b-old", "keep:unmerged", "2026-11-10"),
      branchRow("c-new", "keep:unmerged", "2026-11-18"),
      branchRow("a-tie", "keep:unmerged", "2026-11-18"),
    ];
    expect(sortBranchRows(rows).map((r) => r.name)).toEqual([
      "a-tie",
      "c-new",
      "b-old",
    ]);
  });
});
