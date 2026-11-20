import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedInstallGraph,
  addedShapeSources,
  dataPathPattern,
  dataReaderTestFiles,
  filterImported,
  importedSpecifierPaths,
  inferTestsForFiles,
  isSnapshotFile,
  nonModuleChangedFiles,
  ownerHint,
  parseSelectedFileCount,
  planReaderRecovery,
  planSelectionRecovery,
  planTypecheckTasks,
  snapshotOwnerTestFile,
  type WorkspaceEdgeRef,
} from "../scripts/verify_fast.ts";

const REPO_EDGES: readonly WorkspaceEdgeRef[] = [
  { fromDir: "", toDir: "packages/sportsdesk-ops" },
  { fromDir: "", toDir: "packages/contracts" },
  { fromDir: "", toDir: "packages/ui" },
  { fromDir: "", toDir: "packages/backend" },
  { fromDir: "", toDir: "packages/api" },
  { fromDir: "packages/ui", toDir: "packages/contracts" },
  { fromDir: "packages/backend", toDir: "packages/contracts" },
  { fromDir: "packages/api", toDir: "packages/backend" },
  { fromDir: "packages/api", toDir: "packages/contracts" },
];

describe("verify_fast workspace scoping", () => {
  test("Case A: pure UI/dashboard edits run only UI typechecks and skip root tsconfig.json", () => {
    const tasks = planTypecheckTasks(["packages/ui/src/App.tsx"], {
      hasRootBlast: false,
      edges: REPO_EDGES,
    });
    expect(tasks.map((t) => t.name)).toEqual([
      "typecheck:pkg:ui",
      "typecheck:ui",
    ]);

    const shimTasks = planTypecheckTasks(["src/dashboard/ansi.tsx"], {
      hasRootBlast: false,
      edges: REPO_EDGES,
    });
    expect(shimTasks.map((t) => t.name)).toEqual([
      "typecheck:pkg:ui",
      "typecheck:ui",
    ]);
  });

  test("Case B: isolated backend edits check backend + api and skip root tsconfig.json", () => {
    const tasks = planTypecheckTasks(["packages/backend/src/index.ts"], {
      hasRootBlast: false,
      edges: REPO_EDGES,
    });
    expect(tasks.map((t) => t.name)).toEqual([
      "typecheck:pkg:backend",
      "typecheck:pkg:api",
    ]);

    const apiOnly = planTypecheckTasks(["packages/api/src/index.ts"], {
      hasRootBlast: false,
      edges: REPO_EDGES,
    });
    expect(apiOnly.map((t) => t.name)).toEqual(["typecheck:pkg:api"]);
  });

  test("Case B: contracts edits pull in all downstream workspaces plus root", () => {
    const tasks = planTypecheckTasks(
      ["packages/contracts/src/wager_tokens.ts"],
      {
        hasRootBlast: false,
        edges: REPO_EDGES,
      },
    );
    expect(tasks.map((t) => t.name)).toEqual([
      "typecheck:pkg:contracts",
      "typecheck:pkg:ui",
      "typecheck:pkg:backend",
      "typecheck:pkg:api",
      "typecheck:ui",
      "typecheck",
      "ensure:tsconfig",
    ]);
  });

  test("Case C: root source or root blast files run the full typecheck set", () => {
    const rootEdit = planTypecheckTasks(["lib/pm_policy.ts"], {
      hasRootBlast: false,
      edges: REPO_EDGES,
    });
    expect(rootEdit.map((t) => t.name)).toContain("typecheck");
    expect(rootEdit.map((t) => t.name)).toContain("typecheck:ui");
    expect(rootEdit.map((t) => t.name)).toContain("typecheck:pkg:ui");

    const blast = planTypecheckTasks(
      ["packages/ui/src/ansi.tsx", "package.json"],
      {
        hasRootBlast: true,
        edges: REPO_EDGES,
      },
    );
    expect(blast.map((t) => t.name)).toContain("typecheck");
    expect(blast.map((t) => t.name)).toContain("ensure:tsconfig");
  });

  test("infers workspace UI, contract, and pack boundary tests from changed files", () => {
    expect(inferTestsForFiles(["packages/ui/src/ansi.tsx"])).toContain(
      "tests/dashboard_build_and_markdown.test.ts",
    );
    expect(
      inferTestsForFiles(["packages/contracts/src/wager_tokens.ts"]),
    ).toContain("tests/wager_tiers_toml.test.ts");
    expect(
      inferTestsForFiles(["packages/ui/src/ShadowPricingPanel.tsx"]),
    ).toContain("tests/enhanced_dashboard_builder.test.ts");
    expect(
      inferTestsForFiles(["packages/contracts/src/slice_metrics.ts"]),
    ).toContain("tests/slice_metrics.test.ts");
    expect(inferTestsForFiles(["packages/ui/package.json"])).toContain(
      "tests/workspace_packs.test.ts",
    );
    expect(inferTestsForFiles(["packages/backend/src/wagers.ts"])).toContain(
      "tests/dashboard_backend_workspace.test.ts",
    );
    expect(
      inferTestsForFiles(["packages/ui/src/panels/CustomersTabPanel.tsx"]),
    ).toContain("tests/dashboard_ui_panels.test.tsx");
  });
});

describe("verify_fast changed-test selection warning", () => {
  test("parses Bun's summary in singular and plural form", () => {
    expect(parseSelectedFileCount("Ran 1 test across 1 file. [8.00ms]")).toBe(
      1,
    );
    expect(
      parseSelectedFileCount("Ran 12 tests across 3 files. [21.00ms]"),
    ).toBe(3);
    expect(
      parseSelectedFileCount("Ran 0 tests across 0 files. [19.00ms]"),
    ).toBe(0);
    expect(parseSelectedFileCount("no summary line here")).toBeNull();
  });

  test("flags data, fixture, design, schema and config changes as unreachable by --changed", () => {
    expect(nonModuleChangedFiles(["lib/foo.ts", "tests/foo.test.ts"])).toEqual(
      [],
    );
    expect(
      nonModuleChangedFiles([
        "data/agent-tree.json",
        "tests/fixtures/foo.json",
        "design/tokens.toml",
        "schema/foo.json",
        "config/test-timings.json",
        "bunfig.toml",
      ]),
    ).toEqual([
      "data/agent-tree.json",
      "tests/fixtures/foo.json",
      "design/tokens.toml",
      "schema/foo.json",
      "config/test-timings.json",
      "bunfig.toml",
    ]);
  });
});

/**
 * The silent-zero warning must not fire for a file `--changed` can follow. `design/` and `config/`
 * hold both kinds: `design/domain-branded-types.ts`, `design/tokens.toml` and `config/slab.toml` are
 * imported, `config/fraud-model.json` is only read through the filesystem.
 */
describe("non-module paths", () => {
  test("only data-shaped files are candidates", () => {
    expect(
      filterImported(
        [
          "design/README.md",
          "design/domain-branded-types.ts",
          "config/fraud-model.json",
          "schema/dod6-v54.schema.json",
        ],
        new Set(),
      ),
    ).toEqual(["config/fraud-model.json", "schema/dod6-v54.schema.json"]);
  });

  test("an imported data file is not reported", () => {
    expect(
      filterImported(
        ["design/tokens.toml", "config/slab.toml", "config/fraud-model.json"],
        new Set(["design/tokens.toml", "config/slab.toml"]),
      ),
    ).toEqual(["config/fraud-model.json"]);
  });

  test("the real tree marks design and config artefacts as imported", () => {
    const imported = importedSpecifierPaths(
      ["design/tokens.toml", "design/domain-branded-types.ts"],
      join(import.meta.dir, ".."),
    );
    expect(imported.size).toBe(2);
  });

  test("a filesystem reference is not an import", () => {
    // `lib/fraud_logs.ts` names this path as a string (`agentTreeRelPath`); nothing imports it,
    // so `--changed` does not follow it and the warning is correct.
    const imported = importedSpecifierPaths(
      ["data/agent-tree.json"],
      join(import.meta.dir, ".."),
    );
    expect(imported.size).toBe(0);
  });

  test("hints name the command that owns the path", () => {
    expect(ownerHint(".bun-version")).toContain("bun_runtime_pin");
    expect(ownerHint("bunfig.toml")).toContain("bun_config_policy");
    expect(ownerHint("schema/dod6-v54.schema.json")).toBe(
      "bun run schema:gate",
    );
    expect(ownerHint("data/live-bets.json")).toBeNull();
  });
});

describe("reader recovery for non-imported paths", () => {
  test("recovers only test files that mention the path", () => {
    const grep = () => [
      "lib/agent_tree.test.ts",
      "lib/agent_tree.ts",
      "tests/agent_tree_contract.test.ts",
    ];
    expect(
      dataReaderTestFiles(["data/agent-tree.json"], "/root", grep),
    ).toEqual(["lib/agent_tree.test.ts", "tests/agent_tree_contract.test.ts"]);
  });

  test("dedupes readers shared by several paths and sorts them", () => {
    const grep = (file: string) =>
      file === "a"
        ? ["tests/b.test.ts", "tests/a.test.ts"]
        : ["tests/a.test.ts"];
    expect(dataReaderTestFiles(["a", "b"], "/root", grep)).toEqual([
      "tests/a.test.ts",
      "tests/b.test.ts",
    ]);
  });

  test("plans none, run, and both warning reasons", () => {
    expect(planReaderRecovery([], [])).toEqual({ kind: "none" });
    expect(planReaderRecovery(["data/x.json"], [])).toEqual({
      kind: "warn",
      reason: "no-references",
      count: 0,
    });
    expect(
      planReaderRecovery(["data/x.json"], ["tests/a.test.ts"], 12),
    ).toEqual({
      kind: "run",
      files: ["tests/a.test.ts"],
    });
    const many = Array.from(
      { length: 13 },
      (_, index) => `tests/${index}.test.ts`,
    );
    expect(planReaderRecovery(["data/x.json"], many, 12)).toEqual({
      kind: "warn",
      reason: "too-many",
      count: 13,
    });
  });
});

test("reads are distinguished from prose mentions by the real git grep", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-readers-"));
  try {
    mkdirSync(join(dir, "data"));
    mkdirSync(join(dir, "tests"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    writeFileSync(join(dir, "data/x.json"), "{}\n");
    writeFileSync(
      join(dir, "tests/reads.test.ts"),
      'import { readFileSync } from "node:fs";\nreadFileSync("data/x.json", "utf8");\n',
    );
    writeFileSync(
      join(dir, "tests/prose.test.ts"),
      "// mirrors data/x.json in a comment only\n",
    );
    // A different file whose name extends the changed one: `-F` would match it, the path
    // boundaries must not.
    writeFileSync(
      join(dir, "tests/sibling.test.ts"),
      'import { readFileSync } from "node:fs";\nreadFileSync("data/x.jsonl", "utf8");\n',
    );
    // A colocated suite outside tests/, lib/ and scripts/.
    mkdirSync(join(dir, "packages/app"), { recursive: true });
    writeFileSync(
      join(dir, "packages/app/App.test.ts"),
      'import { readFileSync } from "node:fs";\nreadFileSync("data/x.json", "utf8");\n',
    );
    Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
    expect(dataReaderTestFiles(["data/x.json"], dir)).toEqual([
      "packages/app/App.test.ts",
      "tests/reads.test.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dataPathPattern", () => {
  const matches = (file: string, line: string): boolean =>
    new RegExp(dataPathPattern(file)).test(line);

  test("matches the path as a whole token, including a relative specifier", () => {
    expect(matches("bunfig.toml", 'Bun.file("bunfig.toml")')).toBe(true);
    expect(
      matches("design/tokens.toml", 'from "../../design/tokens.toml"'),
    ).toBe(true);
    expect(matches("data/x.json", "data/x.json")).toBe(true);
  });

  test("does not match a longer path that merely contains it", () => {
    expect(matches("bunfig.toml", '"/unfrozen.bunfig.toml"')).toBe(false);
    expect(matches("data/x.json", 'Bun.file("data/x.jsonl")')).toBe(false);
    expect(matches("schema/a.json", "schema/a.json5")).toBe(false);
  });
});

describe("selection recovery for mixed diffs", () => {
  test("recovers readers even when --changed selected other tests", () => {
    const { unreachable, recovery } = planSelectionRecovery(
      ["lib/foo.ts", "data/agent-tree.json"],
      "/root",
      { imported: () => new Set(), readers: () => ["tests/a.test.ts"] },
    );
    expect(unreachable).toEqual(["data/agent-tree.json"]);
    expect(recovery).toEqual({ kind: "run", files: ["tests/a.test.ts"] });
  });

  test("drops a data path a module imports and plans nothing", () => {
    const { unreachable, recovery } = planSelectionRecovery(
      ["design/tokens.toml"],
      "/root",
      { imported: () => new Set(["design/tokens.toml"]), readers: () => [] },
    );
    expect(unreachable).toEqual([]);
    expect(recovery).toEqual({ kind: "none" });
  });

  test("warns when an unreachable path has no reader", () => {
    const { unreachable, recovery } = planSelectionRecovery(
      ["data/unused.json"],
      "/root",
      { imported: () => new Set(), readers: () => [] },
    );
    expect(unreachable).toEqual(["data/unused.json"]);
    expect(recovery).toEqual({
      kind: "warn",
      reason: "no-references",
      count: 0,
    });
  });
});

describe("install-graph gate", () => {
  test("a manifest or lockfile change runs the install-graph suites", () => {
    expect(changedInstallGraph(["package.json"])).toBe(true);
    expect(changedInstallGraph(["bun.lock"])).toBe(true);
    expect(changedInstallGraph(["packages/ui/package.json"])).toBe(true);
    expect(
      changedInstallGraph([
        "packages/nsh-desk/package.json",
        "lib/pm_policy.ts",
      ]),
    ).toBe(true);
  });

  test("changes that test:changed already covers do not trigger it", () => {
    expect(changedInstallGraph([])).toBe(false);
    expect(changedInstallGraph(["lib/pm_policy.ts"])).toBe(false);
    // A foreign lockfile is rejected by the single-lockfile gate, not by this one.
    expect(changedInstallGraph(["package-lock.json"])).toBe(false);
    // Nested JSON such as a tsconfig is not a manifest.
    expect(changedInstallGraph(["packages/ui/tsconfig.json"])).toBe(false);
  });
});

/**
 * The derived shape catalogue scans `git ls-files`, so a file that is **added to the index**
 * changes what it sees — a new source with a `Bun.*` call, or a new test that names a shape. CI
 * catches the resulting staleness in `verify-changed`; the push gate runs typecheck alone, which
 * cost three round-trips before this gate existed. Untracked files are deliberately excluded: the
 * generator cannot see them, so checking would fail on work that is not part of the commit yet.
 */
describe("shape-source gate", () => {
  test("a staged production or test file can move the catalogue", () => {
    expect(addedShapeSources(["lib/token_automation.ts"])).toBe(true);
    expect(addedShapeSources(["src/preview-server.ts"])).toBe(true);
    expect(addedShapeSources(["services/sportsdesk_webview_server.ts"])).toBe(
      true,
    );
    expect(addedShapeSources(["tests/token_theme_registry.test.ts"])).toBe(
      true,
    );
    expect(addedShapeSources(["cli/bun_reference_cli.ts"])).toBe(true);
  });

  test("trees the scan never reads do not trigger it", () => {
    expect(addedShapeSources([])).toBe(false);
    expect(addedShapeSources(["docs/runbooks/bun-pm-policy.md"])).toBe(false);
    expect(addedShapeSources(["verification/manager-boot/probe.ts"])).toBe(
      false,
    );
    expect(addedShapeSources(["scratch/gen_operator_book.ts"])).toBe(false);
    expect(addedShapeSources(["tests/fixtures/fraud/live-bets.json"])).toBe(
      false,
    );
  });
});

describe("snapshot file recovery (__snapshots__/*.snap)", () => {
  test("recognizes __snapshots__/*.snap files and maps test snapshots to their owning suite", () => {
    expect(isSnapshotFile("tests/__snapshots__/foo.test.ts.snap")).toBe(true);
    expect(snapshotOwnerTestFile("tests/__snapshots__/foo.test.ts.snap")).toBe(
      "tests/foo.test.ts",
    );

    expect(
      isSnapshotFile("packages/ui/src/__snapshots__/Button.test.tsx.snap"),
    ).toBe(true);
    expect(
      snapshotOwnerTestFile(
        "packages/ui/src/__snapshots__/Button.test.tsx.snap",
      ),
    ).toBe("packages/ui/src/Button.test.tsx");

    expect(isSnapshotFile("__snapshots__/root.spec.ts.snap")).toBe(true);
    expect(snapshotOwnerTestFile("__snapshots__/root.spec.ts.snap")).toBe(
      "root.spec.ts",
    );

    expect(isSnapshotFile("tests/__snapshots__/notes.txt.snap")).toBe(true);
    expect(
      snapshotOwnerTestFile("tests/__snapshots__/notes.txt.snap"),
    ).toBeNull();

    expect(isSnapshotFile("tests/foo.test.ts")).toBe(false);
    expect(snapshotOwnerTestFile("tests/foo.test.ts")).toBeNull();
    expect(isSnapshotFile("data/profile-snapshot.json")).toBe(false);
    expect(snapshotOwnerTestFile("data/profile-snapshot.json")).toBeNull();
  });

  test("treats __snapshots__/*.snap as non-module and provides the owning bun test hint", () => {
    const snap = "tests/__snapshots__/foo.test.ts.snap";
    expect(nonModuleChangedFiles([snap])).toEqual([snap]);
    expect(filterImported([snap], new Set())).toEqual([snap]);
    expect(ownerHint(snap)).toBe("bun test tests/foo.test.ts");
  });

  test("recovers existing owning test files without invoking git grep", () => {
    let grepCalled = false;
    const grep = () => {
      grepCalled = true;
      return [];
    };
    const recovered = dataReaderTestFiles(
      [
        "tests/__snapshots__/snap.test.ts.snap",
        "tests/__snapshots__/deleted.test.ts.snap",
      ],
      "/root",
      grep,
      (relPath) => relPath === "tests/snap.test.ts",
    );
    expect(grepCalled).toBe(false);
    expect(recovered).toEqual(["tests/snap.test.ts"]);

    const dir = mkdtempSync(join(tmpdir(), "verify-snap-recovery-"));
    try {
      mkdirSync(join(dir, "tests", "__snapshots__"), { recursive: true });
      writeFileSync(join(dir, "tests", "snap.test.ts"), "// test owner\n");
      writeFileSync(
        join(dir, "tests", "__snapshots__", "snap.test.ts.snap"),
        "// Bun Snapshot v1\n",
      );
      writeFileSync(
        join(dir, "tests", "__snapshots__", "deleted.test.ts.snap"),
        "// Bun Snapshot v1\n",
      );

      expect(
        dataReaderTestFiles(
          [
            "tests/__snapshots__/snap.test.ts.snap",
            "tests/__snapshots__/deleted.test.ts.snap",
          ],
          dir,
        ),
      ).toEqual(["tests/snap.test.ts"]);

      const snapOnly = planSelectionRecovery(
        ["tests/__snapshots__/snap.test.ts.snap"],
        dir,
        { imported: () => new Set() },
      );
      expect(snapOnly.unreachable).toEqual([
        "tests/__snapshots__/snap.test.ts.snap",
      ]);
      expect(snapOnly.recovery).toEqual({
        kind: "run",
        files: ["tests/snap.test.ts"],
      });

      const mixed = planSelectionRecovery(
        ["lib/foo.ts", "tests/__snapshots__/snap.test.ts.snap"],
        dir,
        { imported: () => new Set() },
      );
      expect(mixed.unreachable).toEqual([
        "tests/__snapshots__/snap.test.ts.snap",
      ]);
      expect(mixed.recovery).toEqual({
        kind: "run",
        files: ["tests/snap.test.ts"],
      });

      const orphan = planSelectionRecovery(
        ["tests/__snapshots__/deleted.test.ts.snap"],
        dir,
        { imported: () => new Set() },
      );
      expect(orphan.unreachable).toEqual([
        "tests/__snapshots__/deleted.test.ts.snap",
      ]);
      expect(orphan.recovery).toEqual({
        kind: "warn",
        reason: "no-references",
        count: 0,
      });

      expect(
        inferTestsForFiles(["tests/__snapshots__/snap.test.ts.snap"], dir),
      ).toEqual(["tests/snap.test.ts"]);
      expect(
        inferTestsForFiles(["tests/__snapshots__/deleted.test.ts.snap"], dir),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
