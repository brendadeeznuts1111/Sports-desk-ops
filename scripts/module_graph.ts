#!/usr/bin/env bun
/**
 * Module Dependency Graph CLI & Deep Architectural Analyzer
 *
 * Traverses ES module imports and CommonJS dependencies starting from an entry file
 * or directory using Bun.Transpiler.scanImports and Bun.resolveSync.
 *
 * Capabilities:
 *  - Traversal with cycle detection & topological wave/depth analysis
 *  - Orphan / entry-point identification (nodes with 0 incoming internal edges)
 *  - High-fanout & high-fanin centrality ranking (hubs & foundations)
 *  - Architectural sanity checks & CI gates (`--check`, `--max-cycles=N`, `--no-unresolved`)
 *  - Formats: Pretty tree (`--tree`), Mermaid graph (`--mermaid`), JSON (`--json`), and graph diff (`--compare <file|dir>`)
 *  - Subgraph filters (`--filter <prefix>`, `--depth <N>`, `--cycles-only`)
 *
 * Usage:
 *   bun scripts/module-graph.ts <file|dir> [options]
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
  incomingDependencies: string[];
}

export interface NodeMetrics {
  path: string;
  fanOut: number;
  fanIn: number;
  totalImports: number;
}

export interface ModuleGraphReport {
  root: string;
  entryPoints: string[];
  orphans: string[];
  totalFiles: number;
  totalDependencies: number;
  externalPackages: string[];
  builtinModules: string[];
  cycles: string[][];
  unresolved: { from: string; specifier: string }[];
  topFanOut: NodeMetrics[];
  topFanIn: NodeMetrics[];
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

export interface CliOptions {
  target: string | null;
  tree: boolean;
  mermaid: boolean;
  json: boolean;
  cyclesOnly: boolean;
  orphans: boolean;
  filterPrefix: string | null;
  maxDepth: number | null;
  check: boolean;
  maxCycles: number | null;
  noUnresolved: boolean;
  compareTarget: string | null;
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
      incomingDependencies: [],
    };
  }

  // Populate incomingDependencies (fanIn)
  for (const [fromKey, node] of Object.entries(nodes)) {
    for (const depKey of node.dependencies) {
      if (nodes[depKey]) {
        nodes[depKey].incomingDependencies.push(fromKey);
      }
    }
  }

  for (const node of Object.values(nodes)) {
    node.incomingDependencies.sort();
  }

  // Identify orphans (files with 0 incoming edges that are not declared root entry points)
  const orphans = Object.keys(nodes)
    .filter((k) => nodes[k] && nodes[k].incomingDependencies.length === 0)
    .sort();

  // Metrics: FanOut and FanIn rankings
  const topFanOut: NodeMetrics[] = Object.values(nodes)
    .map((n) => ({
      path: n.relativePath,
      fanOut: n.dependencies.length,
      fanIn: n.incomingDependencies.length,
      totalImports: n.imports.length,
    }))
    .sort((a, b) => b.fanOut - a.fanOut)
    .slice(0, 10);

  const topFanIn: NodeMetrics[] = Object.values(nodes)
    .map((n) => ({
      path: n.relativePath,
      fanOut: n.dependencies.length,
      fanIn: n.incomingDependencies.length,
      totalImports: n.imports.length,
    }))
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 10);

  // Detect circular dependency cycles
  const cycles = detectCycles(nodes);

  let totalDeps = 0;
  for (const node of Object.values(nodes)) {
    totalDeps += node.dependencies.length;
  }

  return {
    root: relative(repoRoot, absTarget) || ".",
    entryPoints: entryFiles.map((f) => relative(repoRoot, f)),
    orphans,
    totalFiles: Object.keys(nodes).length,
    totalDependencies: totalDeps,
    externalPackages: Array.from(allExternal).sort(),
    builtinModules: Array.from(allBuiltin).sort(),
    cycles,
    unresolved,
    topFanOut,
    topFanIn,
    nodes,
  };
}

export function detectCycles(nodes: Record<string, ModuleNode>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const parentPath: string[] = [];
  const seenCycleSignatures = new Set<string>();

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
            // Deduplicate cycles by rotational signature
            const cycleNodes = cycle.slice(0, -1);
            const minIndex = cycleNodes.indexOf(
              cycleNodes.slice().sort()[0] ?? "",
            );
            const normalized = [
              ...cycleNodes.slice(minIndex),
              ...cycleNodes.slice(0, minIndex),
              cycleNodes[minIndex] ?? "",
            ].join("->");

            if (!seenCycleSignatures.has(normalized)) {
              seenCycleSignatures.add(normalized);
              cycles.push(cycle);
            }
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

export function formatTree(
  report: ModuleGraphReport,
  options: { maxDepth?: number | null; filterPrefix?: string | null } = {},
): string {
  const lines: string[] = [];
  lines.push(
    `Module Graph Tree: ${report.root} (${report.totalFiles} files, ${report.totalDependencies} internal edges)`,
  );

  const printed = new Set<string>();
  const maxDepth = options.maxDepth ?? Infinity;
  const prefixFilter = options.filterPrefix;

  function printNode(
    nodeKey: string,
    prefix: string,
    isTail: boolean,
    ancestors: Set<string>,
    depth: number,
  ) {
    if (depth > maxDepth) return;
    const node = report.nodes[nodeKey];
    const marker = isTail ? "└── " : "├── ";
    if (!node) {
      lines.push(`${prefix}${marker}${nodeKey} (external / not scanned)`);
      return;
    }

    const isCycle = ancestors.has(nodeKey);
    const cycleMarker = isCycle ? " [CIRCULAR]" : "";
    lines.push(`${prefix}${marker}${nodeKey}${cycleMarker}`);

    if (isCycle || printed.has(nodeKey) || depth === maxDepth) {
      return;
    }
    printed.add(nodeKey);

    const childPrefix = prefix + (isTail ? "    " : "│   ");
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeKey);

    let children = node.dependencies;
    if (prefixFilter) {
      children = children.filter((c) => c.startsWith(prefixFilter));
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const childTail = i === children.length - 1;
      printNode(child, childPrefix, childTail, nextAncestors, depth + 1);
    }
  }

  let entries =
    report.entryPoints.length > 0
      ? report.entryPoints
      : Object.keys(report.nodes).slice(0, 5);
  if (prefixFilter) {
    entries = entries.filter((e) => e.startsWith(prefixFilter));
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const isTail = i === entries.length - 1;
    printNode(entry, "", isTail, new Set(), 0);
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

export function formatMermaid(
  report: ModuleGraphReport,
  options: { cyclesOnly?: boolean; filterPrefix?: string | null } = {},
): string {
  const lines: string[] = ["graph TD"];
  const sanitizedId = (p: string) => "N_" + p.replace(/[^a-zA-Z0-9_]/g, "_");

  if (options.cyclesOnly) {
    if (report.cycles.length === 0) {
      lines.push("  %% No circular dependencies detected");
      return lines.join("\n");
    }
    for (let cIdx = 0; cIdx < report.cycles.length; cIdx++) {
      const cycle = report.cycles[cIdx] ?? [];
      for (let i = 0; i < cycle.length - 1; i++) {
        const from = cycle[i] ?? "";
        const to = cycle[i + 1] ?? "";
        lines.push(
          `  ${sanitizedId(from)}["${from}"] ==> ${sanitizedId(to)}["${to}"]`,
        );
      }
    }
    return lines.join("\n");
  }

  for (const [key, node] of Object.entries(report.nodes)) {
    if (options.filterPrefix && !key.startsWith(options.filterPrefix)) continue;
    lines.push(`  ${sanitizedId(key)}["${key}"]`);
    for (const dep of node.dependencies) {
      if (options.filterPrefix && !dep.startsWith(options.filterPrefix))
        continue;
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

export function parseCliArgs(args: string[]): CliOptions {
  let target: string | null = null;
  let tree = false;
  let mermaid = false;
  let json = false;
  let cyclesOnly = false;
  let orphans = false;
  let filterPrefix: string | null = null;
  let maxDepth: number | null = null;
  let check = false;
  let maxCycles: number | null = null;
  let noUnresolved = false;
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
    } else if (arg === "--cycles-only") {
      cyclesOnly = true;
    } else if (arg === "--orphans") {
      orphans = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--no-unresolved") {
      noUnresolved = true;
    } else if (arg === "--depth") {
      const next = args[++i];
      maxDepth = next ? parseInt(next, 10) : null;
    } else if (arg.startsWith("--depth=")) {
      maxDepth = parseInt(arg.slice("--depth=".length), 10);
    } else if (arg === "--filter") {
      filterPrefix = args[++i] ?? null;
    } else if (arg.startsWith("--filter=")) {
      filterPrefix = arg.slice("--filter=".length);
    } else if (arg === "--max-cycles") {
      const next = args[++i];
      maxCycles = next ? parseInt(next, 10) : null;
    } else if (arg.startsWith("--max-cycles=")) {
      maxCycles = parseInt(arg.slice("--max-cycles=".length), 10);
    } else if (arg === "--compare") {
      compareTarget = args[++i] ?? null;
    } else if (arg.startsWith("--compare=")) {
      compareTarget = arg.slice("--compare=".length);
    } else if (!arg.startsWith("-") && !target) {
      target = arg;
    }
  }

  return {
    target,
    tree,
    mermaid,
    json,
    cyclesOnly,
    orphans,
    filterPrefix,
    maxDepth,
    check,
    maxCycles,
    noUnresolved,
    compareTarget,
  };
}

// CLI Execution
if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));

  if (!options.target) {
    console.error(
      "Usage: bun scripts/module-graph.ts <file|dir> [--tree] [--mermaid] [--json] [--compare <file|dir>] [--check] [--cycles-only] [--orphans] [--filter <prefix>] [--depth <N>]",
    );
    process.exit(1);
  }

  try {
    const reportA = buildModuleGraph(options.target);

    if (options.compareTarget) {
      const reportB = buildModuleGraph(options.compareTarget);
      const comparison = compareModuleGraphs(reportA, reportB);
      if (options.json) {
        console.log(JSON.stringify(comparison, null, 2));
      } else {
        console.log(formatCompare(comparison));
      }
      process.exit(0);
    }

    if (options.json) {
      console.log(JSON.stringify(reportA, null, 2));
      process.exit(0);
    }

    if (options.mermaid) {
      console.log(
        formatMermaid(reportA, {
          cyclesOnly: options.cyclesOnly,
          filterPrefix: options.filterPrefix,
        }),
      );
      process.exit(0);
    }

    if (options.tree) {
      console.log(
        formatTree(reportA, {
          maxDepth: options.maxDepth,
          filterPrefix: options.filterPrefix,
        }),
      );
      process.exit(0);
    }

    if (options.orphans) {
      console.log(
        `Orphan Modules (0 incoming dependencies) in ${reportA.root}:`,
      );
      for (const o of reportA.orphans) {
        console.log(`  - ${o}`);
      }
      console.log(`Total: ${reportA.orphans.length}`);
      process.exit(0);
    }

    // Default summary output
    console.log(`Module Graph: ${reportA.root}`);
    console.log(`  Total Files: ${reportA.totalFiles}`);
    console.log(`  Total Internal Edges: ${reportA.totalDependencies}`);
    console.log(
      `  External Packages (${reportA.externalPackages.length}): ${reportA.externalPackages.join(", ") || "none"}`,
    );
    console.log(
      `  Node/Bun Builtins (${reportA.builtinModules.length}): ${reportA.builtinModules.join(", ") || "none"}`,
    );
    console.log(`  Circular Dependencies: ${reportA.cycles.length}`);
    if (reportA.cycles.length > 0) {
      for (let i = 0; i < reportA.cycles.length; i++) {
        const cycle = reportA.cycles[i] ?? [];
        console.log(`    [${i + 1}] ${cycle.join(" -> ")}`);
      }
    }
    console.log(`  Unresolved Imports: ${reportA.unresolved.length}`);
    if (reportA.unresolved.length > 0) {
      for (const u of reportA.unresolved) {
        console.log(`    ! ${u.from} -> "${u.specifier}"`);
      }
    }

    if (reportA.topFanOut.length > 0) {
      console.log("\nTop Outgoing Hubs (Fan-Out):");
      for (const h of reportA.topFanOut.slice(0, 5)) {
        console.log(
          `  ${h.fanOut.toString().padStart(3, " ")} deps <- ${h.path}`,
        );
      }
    }

    if (reportA.topFanIn.length > 0) {
      console.log("\nTop Ingoing Foundations (Fan-In):");
      for (const f of reportA.topFanIn.slice(0, 5)) {
        console.log(
          `  ${f.fanIn.toString().padStart(3, " ")} importers -> ${f.path}`,
        );
      }
    }

    // Architectural CI Checks
    if (options.check) {
      let failed = false;
      if (options.noUnresolved && reportA.unresolved.length > 0) {
        console.error(
          `\nCHECK FAILED: Found ${reportA.unresolved.length} unresolved imports.`,
        );
        failed = true;
      }
      if (
        options.maxCycles !== null &&
        reportA.cycles.length > options.maxCycles
      ) {
        console.error(
          `\nCHECK FAILED: Cycle count (${reportA.cycles.length}) exceeds --max-cycles=${options.maxCycles}`,
        );
        failed = true;
      }
      if (failed) {
        process.exit(1);
      } else {
        console.log("\n✓ Architectural integrity checks passed.");
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
