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
    const parsed = parseCliArgs(["lib/pm_policy.ts", "--tree", "--json"]);
    expect(parsed.target).toBe("lib/pm_policy.ts");
    expect(parsed.tree).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.mermaid).toBe(false);
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

  it("formats tree view without throwing", () => {
    const report = buildModuleGraph("packages/nsh-desk/ui/Dialog.tsx");
    const tree = formatTree(report);
    expect(tree).toContain("packages/nsh-desk/ui/Dialog.tsx");
    expect(tree).toContain("packages/nsh-desk/ui/Button.tsx");
  });

  it("formats mermaid diagram with valid graph syntax", () => {
    const report = buildModuleGraph("packages/nsh-desk/ui/Dialog.tsx");
    const mermaid = formatMermaid(report);
    expect(mermaid.startsWith("graph TD")).toBe(true);
    expect(mermaid).toContain("-->");
    expect(mermaid).toContain("npm:nsh");
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
      },
    };
    const cycles = detectCycles(
      mockNodes as unknown as Record<
        string,
        import("../scripts/module_graph").ModuleNode
      >,
    );
    expect(cycles.length).toBeGreaterThan(0);
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
