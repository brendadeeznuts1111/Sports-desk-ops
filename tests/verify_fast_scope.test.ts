import { describe, expect, test } from "bun:test";
import {
  inferTestsForFiles,
  planTypecheckTasks,
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
