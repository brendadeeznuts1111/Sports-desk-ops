#!/usr/bin/env bun
/**
 * Module Dependency Graph CLI & Analyzer
 *
 * Traverses ES module imports and CommonJS dependencies starting from an entry file
 * or directory using Bun.Transpiler.scanImports and Bun.resolveSync.
 *
 * Features:
 *  - Traversal with cycle detection & topological depth analysis
 *  - Formats: Pretty tree (`--tree`), Mermaid graph (`--mermaid`), JSON (`--json`), and graph diff (`--compare <file|dir>`)
 *  - Tracks internal local files, external npm packages, node:* builtins, and bun:* submodules
 *  - Detects circular dependencies and unresolved imports
 *
 * Usage:
 *   bun scripts/module-graph.ts <file|dir> [--tree] [--mermaid] [--json] [--compare <other>]
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { relative, resolve, dirname, extname, join } from "node:path";
import { builtinModules } from "node:module";
import { Transpiler, resolveSync } from "bun";

export interface ImportEdge {
  specifier: string;
  kind: "import-statement" | "dynamic-import" | "require-call";
  resolvedPath: string | null;
  category: "internal" | "external" | "builtin" | "unresolved";
}

export interface ModuleNode {
  path: string;
  relativePath: string;
  sizeBytes: number;
  imports: ImportEdge[];
  dependencies: string[];
  externalDependencies: string[];
  builtinDependencies: string[];
  unresolvedImports: string[];
}

export interface ModuleGraphReport {
  root: string;
  entryPoints: string[];
  totalFiles: number;
  totalDependencies: number;
  externalPackages: string[];
  builtinModules: string[];
  cycles: string[][];
  unresolved: { from: string; specifier: string }[];
  nodes: Record<string, ModuleNode>;
}

export interface ModuleGraphCompare {
  targetA: string;
  targetB: string;
  filesOnlyInA: string[];
  filesOnlyInB: string[];
  sharedFiles: string[];
  externalOnlyInA: string[];
  externalOnlyInB: string[];
  sharedExternal: string[];
  dependencyEdgeDeltas: {
    added: { from: string; to: string }[];
    removed: { from: string; to: string }[];
  };
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "bun",
  "bun:test",
  "bun:ffi",
  "bun:jsc",
  "bun:sqlite",
]);

function getLoader(filePath: string): "ts" | "tsx" | "js" | "jsx" {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  return "js";
}

export function collectEntryFiles(target: string): string[] {
  const abs = resolve(target);
  if (!existsSync(abs)) {
    throw new Error(`Target path does not exist: ${target}`);
  }
  const stat = lstatSync(abs);
  if (stat.isFile()) {
    return [abs];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Target path is neither file nor directory: ${target}`);
  }

  const entries: string[] = [];
  function walk(dir: string) {
    const files = readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      if (
        file.name.startsWith(".") ||
        file.name === "node_modules" ||
        file.name === "dist" ||
        file.name === ".nsh"
      ) {
        continue;
      }
      const full = join(dir, file.name);
      if (file.isDirectory()) {
        walk(full);
      } else if (
        file.isFile() &&
        SUPPORTED_EXTENSIONS.has(extname(file.name).toLowerCase())
      ) {
        entries.push(full);
      }
    }
  }
  walk(abs);
  return entries.sort();
}

export function buildModuleGraph(
  target: string,
  repoRoot: string = process.cwd(),
): ModuleGraphReport {
  const absTarget = resolve(target);
  const entryFiles = collectEntryFiles(absTarget);
  const transpilerCache: Record<string, Transpiler> = {
    ts: new Transpiler({ loader: "ts" }),
    tsx: new Transpiler({ loader: "tsx" }),
    js: new Transpiler({ loader: "js" }),
    jsx: new Transpiler({ loader: "jsx" }),
  };

  const nodes: Record<string, ModuleNode> = {};
  const queue: string[] = [...entryFiles];
  const visited = new Set<string>();
  const allExternal = new Set<string>();
  const allBuiltin = new Set<string>();
  const unresolved: { from: string; specifier: string }[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let content: string;
    let sizeBytes = 0;
    try {
      content = readFileSync(current, "utf8");
      sizeBytes = Buffer.byteLength(content, "utf8");
    } catch {
      continue;
    }

    const loader = getLoader(current);
    const transpiler = transpilerCache[loader] ?? transpilerCache["ts"]!;
    let rawImports: { path: string; kind: string }[] = [];
    try {
      rawImports = transpiler.scanImports(content) as {
        path: string;
        kind: string;
      }[];
    } catch {
      rawImports = [];
    }

    const edges: ImportEdge[] = [];
    const internalDeps = new Set<string>();
    const externalDeps = new Set<string>();
    const builtinDeps = new Set<string>();
    const unresDeps = new Set<string>();

    const currentDir = dirname(current);

    for (const imp of rawImports) {
      const spec = imp.path;
      // Skip synthetic jsx runtime calls if detected
      if (
        imp.kind === "require-call" &&
        (spec === "react" ||
          spec === "react/jsx-dev-runtime" ||
          spec === "react/jsx-runtime")
      ) {
        continue;
      }

      if (
        NODE_BUILTINS.has(spec) ||
        spec.startsWith("node:") ||
        spec.startsWith("bun:")
      ) {
        builtinDeps.add(spec);
        allBuiltin.add(spec);
        edges.push({
          specifier: spec,
          kind: imp.kind as ImportEdge["kind"],
          resolvedPath: null,
          category: "builtin",
        });
        continue;
      }

      // Check if relative or absolute import
      const isRelative =
        spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
      if (isRelative) {
        let resolved: string | null = null;
        try {
          resolved = resolveSync(spec, currentDir);
        } catch {
          // Attempt fallback extension check
          for (const ext of [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            "/index.ts",
            "/index.tsx",
            "/index.js",
          ]) {
            const probe = resolve(currentDir, spec + ext);
            if (existsSync(probe)) {
              resolved = probe;
              break;
            }
          }
        }

        if (resolved && existsSync(resolved)) {
          try {
            resolved = realpathSync(resolved);
          } catch {
            // keep as resolved
          }
          const relDep = relative(repoRoot, resolved);
          internalDeps.add(relDep);
          edges.push({
            specifier: spec,
            kind: imp.kind as ImportEdge["kind"],
            resolvedPath: relDep,
            category: "internal",
          });
          if (
            !visited.has(resolved) &&
            SUPPORTED_EXTENSIONS.has(extname(resolved).toLowerCase())
          ) {
            queue.push(resolved);
          }
        } else {
          unresDeps.add(spec);
          unresolved.push({
            from: relative(repoRoot, current),
            specifier: spec,
          });
          edges.push({
            specifier: spec,
            kind: imp.kind as ImportEdge["kind"],
            resolvedPath: null,
            category: "unresolved",
          });
        }
      } else {
        // Bare npm package or workspace import
        let pkgName = spec;
        if (spec.startsWith("@")) {
          const parts = spec.split("/");
          pkgName = parts.slice(0, 2).join("/");
        } else {
          pkgName = spec.split("/")[0] ?? spec;
        }
        externalDeps.add(pkgName);
        allExternal.add(pkgName);
        edges.push({
          specifier: spec,
          kind: imp.kind as ImportEdge["kind"],
          resolvedPath: null,
          category: "external",
        });
      }
    }

    const relCurrent = relative(repoRoot, current);
    nodes[relCurrent] = {
      path: current,
      relativePath: relCurrent,
      sizeBytes,
      imports: edges,
      dependencies: Array.from(internalDeps).sort(),
      externalDependencies: Array.from(externalDeps).sort(),
      builtinDependencies: Array.from(builtinDeps).sort(),
      unresolvedImports: Array.from(unresDeps).sort(),
    };
  }

  // Detect circular dependency cycles
  const cycles = detectCycles(nodes);

  let totalDeps = 0;
  for (const node of Object.values(nodes)) {
    totalDeps += node.dependencies.length;
  }

  return {
    root: relative(repoRoot, absTarget) || ".",
    entryPoints: entryFiles.map((f) => relative(repoRoot, f)),
    totalFiles: Object.keys(nodes).length,
    totalDependencies: totalDeps,
    externalPackages: Array.from(allExternal).sort(),
    builtinModules: Array.from(allBuiltin).sort(),
    cycles,
    unresolved,
    nodes,
  };
}

export function detectCycles(nodes: Record<string, ModuleNode>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const parentPath: string[] = [];

  function dfs(nodeId: string) {
    visited.add(nodeId);
    recStack.add(nodeId);
    parentPath.push(nodeId);

    const node = nodes[nodeId];
    if (node) {
      for (const neighbor of node.dependencies) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recStack.has(neighbor)) {
          const cycleStart = parentPath.indexOf(neighbor);
          if (cycleStart !== -1) {
            const cycle = parentPath.slice(cycleStart).concat(neighbor);
            cycles.push(cycle);
          }
        }
      }
    }

    parentPath.pop();
    recStack.delete(nodeId);
  }

  for (const key of Object.keys(nodes)) {
    if (!visited.has(key)) {
      dfs(key);
    }
  }

  return cycles;
}

export function formatTree(report: ModuleGraphReport): string {
  const lines: string[] = [];
  lines.push(
    `Module Graph Tree: ${report.root} (${report.totalFiles} files, ${report.totalDependencies} internal edges)`,
  );

  const printed = new Set<string>();

  function printNode(
    nodeKey: string,
    prefix: string,
    isTail: boolean,
    ancestors: Set<string>,
  ) {
    const node = report.nodes[nodeKey];
    const marker = isTail ? "└── " : "├── ";
    if (!node) {
      lines.push(`${prefix}${marker}${nodeKey} (external / not scanned)`);
      return;
    }

    const isCycle = ancestors.has(nodeKey);
    const cycleMarker = isCycle ? " [CIRCULAR]" : "";
    lines.push(`${prefix}${marker}${nodeKey}${cycleMarker}`);

    if (isCycle || printed.has(nodeKey)) {
      return;
    }
    printed.add(nodeKey);

    const childPrefix = prefix + (isTail ? "    " : "│   ");
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeKey);

    const children = node.dependencies;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const childTail = i === children.length - 1;
      printNode(child, childPrefix, childTail, nextAncestors);
    }
  }

  const entries =
    report.entryPoints.length > 0
      ? report.entryPoints
      : Object.keys(report.nodes).slice(0, 5);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const isTail = i === entries.length - 1;
    printNode(entry, "", isTail, new Set());
  }

  if (report.externalPackages.length > 0) {
    lines.push(`\nExternal Packages (${report.externalPackages.length}):`);
    for (const pkg of report.externalPackages) {
      lines.push(`  - ${pkg}`);
    }
  }

  if (report.cycles.length > 0) {
    lines.push(`\nCircular Dependencies (${report.cycles.length}):`);
    for (const cycle of report.cycles) {
      lines.push(`  ! ${cycle.join(" -> ")}`);
    }
  }

  return lines.join("\n");
}

export function formatMermaid(report: ModuleGraphReport): string {
  const lines: string[] = ["graph TD"];
  const sanitizedId = (p: string) => "N_" + p.replace(/[^a-zA-Z0-9_]/g, "_");

  for (const [key, node] of Object.entries(report.nodes)) {
    lines.push(`  ${sanitizedId(key)}["${key}"]`);
    for (const dep of node.dependencies) {
      lines.push(`  ${sanitizedId(key)} --> ${sanitizedId(dep)}`);
    }
    for (const ext of node.externalDependencies) {
      const extId = "EXT_" + ext.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`  ${sanitizedId(key)} -.-> ${extId}["npm:${ext}"]`);
    }
  }

  return lines.join("\n");
}

export function compareModuleGraphs(
  reportA: ModuleGraphReport,
  reportB: ModuleGraphReport,
): ModuleGraphCompare {
  const filesA = new Set(Object.keys(reportA.nodes));
  const filesB = new Set(Object.keys(reportB.nodes));

  const extA = new Set(reportA.externalPackages);
  const extB = new Set(reportB.externalPackages);

  const edgesA = new Set<string>();
  for (const [from, node] of Object.entries(reportA.nodes)) {
    for (const to of node.dependencies) {
      edgesA.add(`${from} => ${to}`);
    }
  }

  const edgesB = new Set<string>();
  for (const [from, node] of Object.entries(reportB.nodes)) {
    for (const to of node.dependencies) {
      edgesB.add(`${from} => ${to}`);
    }
  }

  const addedEdges: { from: string; to: string }[] = [];
  const removedEdges: { from: string; to: string }[] = [];

  for (const edge of edgesB) {
    if (!edgesA.has(edge)) {
      const parts = edge.split(" => ");
      const from = parts[0] ?? "";
      const to = parts[1] ?? "";
      addedEdges.push({ from, to });
    }
  }
  for (const edge of edgesA) {
    if (!edgesB.has(edge)) {
      const parts = edge.split(" => ");
      const from = parts[0] ?? "";
      const to = parts[1] ?? "";
      removedEdges.push({ from, to });
    }
  }

  return {
    targetA: reportA.root,
    targetB: reportB.root,
    filesOnlyInA: Array.from(filesA)
      .filter((f) => !filesB.has(f))
      .sort(),
    filesOnlyInB: Array.from(filesB)
      .filter((f) => !filesA.has(f))
      .sort(),
    sharedFiles: Array.from(filesA)
      .filter((f) => filesB.has(f))
      .sort(),
    externalOnlyInA: Array.from(extA)
      .filter((e) => !extB.has(e))
      .sort(),
    externalOnlyInB: Array.from(extB)
      .filter((e) => !extA.has(e))
      .sort(),
    sharedExternal: Array.from(extA)
      .filter((e) => extB.has(e))
      .sort(),
    dependencyEdgeDeltas: {
      added: addedEdges,
      removed: removedEdges,
    },
  };
}

export function formatCompare(compare: ModuleGraphCompare): string {
  const lines: string[] = [];
  lines.push(`Module Graph Comparison:`);
  lines.push(`  Base (A): ${compare.targetA}`);
  lines.push(`  Diff (B): ${compare.targetB}`);
  lines.push(`\nShared Files: ${compare.sharedFiles.length}`);
  lines.push(`Files Only in Base (A): ${compare.filesOnlyInA.length}`);
  for (const f of compare.filesOnlyInA.slice(0, 10)) lines.push(`  - ${f}`);
  if (compare.filesOnlyInA.length > 10)
    lines.push(`  ... and ${compare.filesOnlyInA.length - 10} more`);

  lines.push(`\nFiles Only in Diff (B): ${compare.filesOnlyInB.length}`);
  for (const f of compare.filesOnlyInB.slice(0, 10)) lines.push(`  + ${f}`);
  if (compare.filesOnlyInB.length > 10)
    lines.push(`  ... and ${compare.filesOnlyInB.length - 10} more`);

  lines.push(
    `\nDependency Edges: +${compare.dependencyEdgeDeltas.added.length} added, -${compare.dependencyEdgeDeltas.removed.length} removed`,
  );
  for (const a of compare.dependencyEdgeDeltas.added.slice(0, 5)) {
    lines.push(`  + ${a.from} -> ${a.to}`);
  }
  for (const r of compare.dependencyEdgeDeltas.removed.slice(0, 5)) {
    lines.push(`  - ${r.from} -> ${r.to}`);
  }

  return lines.join("\n");
}

export function parseCliArgs(args: string[]): {
  target: string | null;
  tree: boolean;
  mermaid: boolean;
  json: boolean;
  compareTarget: string | null;
} {
  let target: string | null = null;
  let tree = false;
  let mermaid = false;
  let json = false;
  let compareTarget: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--tree") {
      tree = true;
    } else if (arg === "--mermaid") {
      mermaid = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--compare") {
      const next = args[++i];
      compareTarget = next ?? null;
    } else if (arg.startsWith("--compare=")) {
      compareTarget = arg.slice("--compare=".length);
    } else if (!arg.startsWith("-") && !target) {
      target = arg;
    }
  }

  return { target, tree, mermaid, json, compareTarget };
}

// CLI Execution
if (import.meta.main) {
  const { target, tree, mermaid, json, compareTarget } = parseCliArgs(
    process.argv.slice(2),
  );

  if (!target) {
    console.error(
      "Usage: bun scripts/module-graph.ts <file|dir> [--tree] [--mermaid] [--json] [--compare <file|dir>]",
    );
    process.exit(1);
  }

  try {
    const reportA = buildModuleGraph(target);

    if (compareTarget) {
      const reportB = buildModuleGraph(compareTarget);
      const comparison = compareModuleGraphs(reportA, reportB);
      if (json) {
        console.log(JSON.stringify(comparison, null, 2));
      } else {
        console.log(formatCompare(comparison));
      }
      process.exit(0);
    }

    if (json) {
      console.log(JSON.stringify(reportA, null, 2));
    } else if (mermaid) {
      console.log(formatMermaid(reportA));
    } else if (tree) {
      console.log(formatTree(reportA));
    } else {
      // Default summary
      console.log(`Module Graph: ${reportA.root}`);
      console.log(`  Total Files: ${reportA.totalFiles}`);
      console.log(`  Total Internal Edges: ${reportA.totalDependencies}`);
      console.log(
        `  External Packages: ${reportA.externalPackages.join(", ") || "none"}`,
      );
      console.log(
        `  Node/Bun Builtins: ${reportA.builtinModules.join(", ") || "none"}`,
      );
      if (reportA.cycles.length > 0) {
        console.log(`  Circular Dependencies: ${reportA.cycles.length}`);
      }
      if (reportA.unresolved.length > 0) {
        console.log(`  Unresolved Imports: ${reportA.unresolved.length}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
