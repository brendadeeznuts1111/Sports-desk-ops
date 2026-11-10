import { YAML } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyBranchMergeProof,
  classifyWorktreeDisposition,
  InspectableWorktreeHygieneReport,
  parseWorktreeListPorcelain,
  runWorktreeHygiene,
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
