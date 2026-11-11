import { describe, expect, it } from "bun:test";
import {
  buildModuleGraph,
  compareModuleGraphs,
  detectCycles,
  formatMermaid,
  formatTree,
  parseCliArgs,
} from "../scripts/module_graph";

describe("Module Graph CLI & Analyzer", () => {
  it("parses CLI flags correctly", () => {
    const parsed = parseCliArgs([
      "lib/pm_policy.ts",
      "--tree",
      "--json",
      "--check",
      "--max-cycles=0",
      "--no-unresolved",
      "--depth=2",
      "--filter=lib/",
      "--cycles-only",
      "--orphans",
    ]);
    expect(parsed.target).toBe("lib/pm_policy.ts");
    expect(parsed.tree).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.check).toBe(true);
    expect(parsed.maxCycles).toBe(0);
    expect(parsed.noUnresolved).toBe(true);
    expect(parsed.maxDepth).toBe(2);
    expect(parsed.filterPrefix).toBe("lib/");
    expect(parsed.cyclesOnly).toBe(true);
    expect(parsed.orphans).toBe(true);
    expect(parsed.compareTarget).toBeNull();

    const compareParsed = parseCliArgs([
      "a.ts",
      "--compare",
      "b.ts",
      "--mermaid",
    ]);
    expect(compareParsed.target).toBe("a.ts");
    expect(compareParsed.compareTarget).toBe("b.ts");
    expect(compareParsed.mermaid).toBe(true);
  });

  it("builds a graph for a single file and discovers internal dependencies", () => {
    const report = buildModuleGraph("packages/nsh-desk/ui/Dialog.tsx");
    expect(report.totalFiles).toBeGreaterThanOrEqual(2);
    expect(report.nodes["packages/nsh-desk/ui/Dialog.tsx"]).toBeDefined();
    const dialogNode = report.nodes["packages/nsh-desk/ui/Dialog.tsx"];
    expect(dialogNode).toBeDefined();
    if (dialogNode) {
      expect(dialogNode.dependencies).toContain(
        "packages/nsh-desk/ui/Button.tsx",
      );
      expect(dialogNode.dependencies).toContain(
        "packages/nsh-desk/ui/tokens.ts",
      );
      expect(dialogNode.externalDependencies).toContain("nsh");
    }
  });

  it("computes fan-in and fan-out metrics accurately", () => {
    const report = buildModuleGraph("packages/nsh-desk");
    expect(report.topFanIn.length).toBeGreaterThan(0);
    expect(report.topFanOut.length).toBeGreaterThan(0);

    const storeMetric = report.topFanIn.find(
      (m) => m.path === "packages/nsh-desk/store.ts",
    );
    expect(storeMetric).toBeDefined();
    expect(storeMetric?.fanIn).toBeGreaterThanOrEqual(5);

    const indexMetric = report.topFanOut.find(
      (m) => m.path === "packages/nsh-desk/ui/index.ts",
    );
    expect(indexMetric).toBeDefined();
    expect(indexMetric?.fanOut).toBeGreaterThanOrEqual(5);
  });

  it("formats tree view with depth filtering without throwing", () => {
    const report = buildModuleGraph("packages/nsh-desk/ui/Dialog.tsx");
    const tree = formatTree(report, { maxDepth: 1 });
    expect(tree).toContain("packages/nsh-desk/ui/Dialog.tsx");
  });

  it("formats mermaid diagram with cycles-only filter", () => {
    const report = buildModuleGraph("packages/nsh-desk/ui/Dialog.tsx");
    const mermaid = formatMermaid(report, { cyclesOnly: true });
    expect(mermaid).toContain("No circular dependencies");
  });

  it("detects circular dependency cycles", () => {
    const mockNodes = {
      "a.ts": {
        path: "/mock/a.ts",
        relativePath: "a.ts",
        sizeBytes: 10,
        imports: [],
        dependencies: ["b.ts"],
        externalDependencies: [],
        builtinDependencies: [],
        unresolvedImports: [],
        incomingDependencies: ["c.ts"],
      },
      "b.ts": {
        path: "/mock/b.ts",
        relativePath: "b.ts",
        sizeBytes: 10,
        imports: [],
        dependencies: ["c.ts"],
        externalDependencies: [],
        builtinDependencies: [],
        unresolvedImports: [],
        incomingDependencies: ["a.ts"],
      },
      "c.ts": {
        path: "/mock/c.ts",
        relativePath: "c.ts",
        sizeBytes: 10,
        imports: [],
        dependencies: ["a.ts"],
        externalDependencies: [],
        builtinDependencies: [],
        unresolvedImports: [],
        incomingDependencies: ["b.ts"],
      },
    };
    const cycles = detectCycles(
      mockNodes as unknown as Record<
        string,
        import("../scripts/module_graph").ModuleNode
      >,
    );
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["a.ts", "b.ts", "c.ts", "a.ts"]);
  });

  it("compares two module graphs accurately", () => {
    const reportA = buildModuleGraph(
      "packages/nsh-desk/components/ExposurePanel.tsx",
    );
    const reportB = buildModuleGraph(
      "packages/nsh-desk/components/SignalsPanel.tsx",
    );
    const diff = compareModuleGraphs(reportA, reportB);

    expect(diff.sharedFiles.length).toBeGreaterThan(0);
    expect(diff.filesOnlyInA).toContain(
      "packages/nsh-desk/components/ExposurePanel.tsx",
    );
    expect(diff.filesOnlyInB).toContain(
      "packages/nsh-desk/components/SignalsPanel.tsx",
    );
    expect(diff.filesOnlyInB).toContain(
      "packages/nsh-desk/components/provenance.ts",
    );
    expect(diff.dependencyEdgeDeltas.added.length).toBeGreaterThan(0);
    expect(diff.dependencyEdgeDeltas.removed.length).toBeGreaterThan(0);
  });
});
