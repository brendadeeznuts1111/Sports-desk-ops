/**
 * Package-manager & monorepo workspace policy shared by tests/bun_config_policy.test.ts,
 * tests/pm_policy_workspaces.test.ts, scripts/pm_doctor.ts, and scripts/dx_workspaces.ts.
 *
 * Install keys are machine-owned (`~/dotfiles/bun/bunfig.toml`), so every project shares one
 * install policy and a project copy can only diverge from it.
 */
import { Transpiler } from "bun";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const NODE_BUILTINS = new Set<string>(
  builtinModules.map((m) => (m.startsWith("node:") ? m.slice(5) : m)),
);
const NSH_GUEST_BUILTINS = new Set<string>([
  "nsh",
  "fs",
  "net",
  "os",
  "process",
  "standard",
  "websocket",
]);

export const MACHINE_OWNED_INSTALL_KEYS = [
  "linker",
  "globalStore",
  "cache",
  "frozenLockfile",
  "minimumReleaseAge",
] as const;

export const FOREIGN_LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
] as const;

export const WORKSPACE_DEP_GROUPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type WorkspaceDependencyGroup = (typeof WORKSPACE_DEP_GROUPS)[number];

/**
 * Bun reads exactly one global bunfig: `$XDG_CONFIG_HOME/.bunfig.toml` when XDG_CONFIG_HOME is an
 * absolute path, otherwise `$HOME/.bunfig.toml`. There is no fallback between them.
 */
export function globalBunfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, ".bunfig.toml");
  }
  return path.join(env.HOME ?? "", ".bunfig.toml");
}

export type WorkspaceNames = Record<string, string | undefined>;

type RawManifest = {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  description?: unknown;
  type?: unknown;
  engines?: { bun?: unknown };
  workspaces?:
    | string[]
    | {
        packages?: string[];
        catalog?: Record<string, string>;
        catalogs?: Record<string, Record<string, string>>;
      };
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  patchedDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
};

type LockWorkspaceEntry = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type LockFile = {
  workspaces?: Record<string, LockWorkspaceEntry>;
  patchedDependencies?: Record<string, string>;
};

export interface WorkspacePackageInfo {
  readonly dir: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly private: boolean;
  readonly description: string | undefined;
  readonly type: string | undefined;
  readonly enginesBun: string | undefined;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
  readonly bin: Readonly<Record<string, string>>;
}

export interface WorkspaceInspection {
  readonly rootPrivate: boolean;
  readonly patterns: readonly string[];
  readonly packages: readonly WorkspacePackageInfo[];
  readonly nameless: readonly string[];
  readonly unregisteredDirs: readonly string[];
  readonly catalog: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface WorkspaceEdge {
  readonly fromDir: string;
  readonly fromName: string;
  readonly toDir: string;
  readonly toName: string;
  readonly depName: string;
  readonly specifier: string;
  readonly group: WorkspaceDependencyGroup;
}

export type WorkspaceGraphIssueKind =
  | "missing-target"
  | "unlinked-workspace-dep"
  | "duplicate-workspace-name"
  | "ambiguous-root-name"
  | "missing-catalog-entry"
  | "cycle";

export interface WorkspaceGraphIssue {
  readonly kind: WorkspaceGraphIssueKind;
  readonly dir: string;
  readonly detail: string;
}

export interface WorkspaceGraphAnalysis {
  readonly edges: readonly WorkspaceEdge[];
  readonly issues: readonly WorkspaceGraphIssue[];
  /** Kahn topological waves across child (`packages/*`) workspaces. */
  readonly waves: readonly (readonly string[])[];
  /** Kahn topological waves across all workspaces including root `""`. */
  readonly allWaves: readonly (readonly string[])[];
  readonly cycles: readonly (readonly string[])[];
}

export interface UndeclaredWorkspaceImport {
  readonly dir: string;
  readonly file: string;
  readonly specifier: string;
  readonly packageName: string;
}

export interface WorkspaceSelfContainmentReport {
  readonly scannedFiles: number;
  readonly scannedImports: number;
  readonly undeclaredImports: readonly UndeclaredWorkspaceImport[];
}

export interface WorkspaceNodeModulesStatus {
  readonly dir: string;
  readonly name: string;
  readonly expectedLinks: readonly string[];
  readonly presentLinks: readonly string[];
  readonly missingLinks: readonly string[];
  readonly brokenLinks: readonly string[];
}

export interface WorkspaceInstallLayoutReport {
  readonly storeMode: "isolated" | "hoisted" | "missing";
  readonly workspaceLinks: readonly WorkspaceNodeModulesStatus[];
  readonly nshVersionDrift: readonly string[];
}

export interface RootWorkspaceHygieneReport {
  readonly rootPrivate: boolean;
  readonly externalDeps: readonly string[];
  readonly externalDevDeps: readonly string[];
  readonly workspaceLinks: readonly string[];
  readonly strictZeroRootDeps: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

async function readLock(root: string): Promise<LockFile> {
  return Bun.JSONC.parse(
    await Bun.file(path.join(root, "bun.lock")).text(),
  ) as LockFile;
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function normalizeBinMap(
  pkgName: string,
  raw: unknown,
): Record<string, string> {
  if (typeof raw === "string" && raw.trim() !== "") {
    const fallbackName = pkgName.includes("/")
      ? (pkgName.split("/").at(-1) ?? pkgName)
      : pkgName;
    return fallbackName ? { [fallbackName]: raw } : {};
  }
  return normalizeStringMap(raw);
}

function toPackageInfo(dir: string, raw: RawManifest): WorkspacePackageInfo {
  const name = typeof raw.name === "string" ? raw.name : "";
  return {
    dir,
    name,
    version: typeof raw.version === "string" ? raw.version : undefined,
    private: raw.private === true,
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    enginesBun:
      typeof raw.engines?.bun === "string" ? raw.engines.bun : undefined,
    dependencies: normalizeStringMap(raw.dependencies),
    devDependencies: normalizeStringMap(raw.devDependencies),
    peerDependencies: normalizeStringMap(raw.peerDependencies),
    optionalDependencies: normalizeStringMap(raw.optionalDependencies),
    scripts: normalizeStringMap(raw.scripts),
    bin: normalizeBinMap(name, raw.bin),
  };
}

function normalizePosixDir(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Finds non-empty child directories inside simple `<parent>/*` workspace patterns (e.g. `packages/*`)
 * that do not declare a `package.json` and are not excluded by `!` patterns.
 */
function findUnregisteredWorkspaceDirs(
  root: string,
  patterns: readonly string[],
  negated: readonly Bun.Glob[],
): string[] {
  const unregistered = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const match = /^([^*?[\]{}()!]+)\/\*$/.exec(pattern.replace(/\/+$/, ""));
    if (!match?.[1]) continue;
    const parentRel = normalizePosixDir(match[1]);
    const parentAbs = path.join(root, parentRel);
    if (!existsSync(parentAbs)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(parentAbs);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const childAbs = path.join(parentAbs, entry);
      try {
        if (!lstatSync(childAbs).isDirectory()) continue;
      } catch {
        continue;
      }
      const childRel = normalizePosixDir(path.posix.join(parentRel, entry));
      const pkgRel = `${childRel}/package.json`;
      if (negated.some((g) => g.match(childRel) || g.match(pkgRel))) continue;
      if (existsSync(path.join(childAbs, "package.json"))) continue;

      let childFiles: string[] = [];
      try {
        childFiles = readdirSync(childAbs).filter(
          (f) => !f.startsWith(".") && f !== "node_modules",
        );
      } catch {
        continue;
      }
      if (childFiles.length > 0) {
        unregistered.add(childRel);
      }
    }
  }
  return [...unregistered].sort();
}

/**
 * Full workspace manifest and directory inspection across the monorepo.
 */
export async function inspectWorkspaces(
  root: string,
): Promise<WorkspaceInspection> {
  const rootRaw = (await Bun.file(
    path.join(root, "package.json"),
  ).json()) as RawManifest;
  const patterns = Array.isArray(rootRaw.workspaces)
    ? rootRaw.workspaces
    : (rootRaw.workspaces?.packages ?? []);
  const negated = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => new Bun.Glob(p.slice(1)));

  const wsObj =
    typeof rootRaw.workspaces === "object" &&
    rootRaw.workspaces !== null &&
    !Array.isArray(rootRaw.workspaces)
      ? rootRaw.workspaces
      : undefined;
  const catalog = normalizeStringMap(wsObj?.catalog ?? rootRaw.catalog);
  const rawCatalogs = wsObj?.catalogs ?? rootRaw.catalogs ?? {};
  const catalogs: Record<string, Record<string, string>> = {};
  for (const [groupName, entries] of Object.entries(rawCatalogs)) {
    catalogs[groupName] = normalizeStringMap(entries);
  }

  const byDir = new Map<string, WorkspacePackageInfo>();
  byDir.set("", toPackageInfo("", rootRaw));
  const namelessSet = new Set<string>();

  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    const literal = !/[*?[\]{}()!]/.test(pattern);
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(
      root,
    )) {
      const dir = normalizePosixDir(path.dirname(file));
      if (dir.split("/").includes("node_modules")) continue;
      if (!literal && negated.some((g) => g.match(dir) || g.match(file))) {
        continue;
      }
      const pkgRaw = (await Bun.file(
        path.join(root, file),
      ).json()) as RawManifest;
      if (typeof pkgRaw.name === "string" && pkgRaw.name !== "") {
        byDir.set(dir, toPackageInfo(dir, pkgRaw));
      } else {
        namelessSet.add(dir);
      }
    }
  }

  const packages = [...byDir.values()].sort((a, b) =>
    a.dir === "" ? -1 : b.dir === "" ? 1 : a.dir.localeCompare(b.dir),
  );
  const unregisteredDirs = findUnregisteredWorkspaceDirs(
    root,
    patterns,
    negated,
  );

  return {
    rootPrivate: rootRaw.private === true,
    patterns,
    packages,
    nameless: [...namelessSet].sort(),
    unregisteredDirs,
    catalog,
    catalogs,
  };
}

/**
 * The workspaces Bun installs, keyed by directory, plus the matched package.json files it skips
 * for having no "name". A `!` pattern removes what the globs match wherever it sits in the list,
 * but not a directory listed by its literal path (bun.com/docs/pm/workspaces).
 */
export async function resolveWorkspaces(root: string): Promise<{
  workspaces: WorkspaceNames;
  versions: WorkspaceNames;
  nameless: string[];
}> {
  const inspection = await inspectWorkspaces(root);
  const workspaces: WorkspaceNames = {};
  const versions: WorkspaceNames = {};
  for (const pkg of inspection.packages) {
    workspaces[pkg.dir] = pkg.name || undefined;
    if (pkg.dir !== "") {
      versions[pkg.dir] = pkg.version;
    }
  }
  return {
    workspaces,
    versions,
    nameless: [...inspection.nameless],
  };
}

/**
 * Workspace path → package name, from the package.json files and from bun.lock. Bun 1.4.4 never
 * rewrites a renamed package in an existing bun.lock and a frozen install does not compare names,
 * so the two drift silently until the lock is regenerated.
 */
export async function lockWorkspaceNames(root: string): Promise<{
  expected: WorkspaceNames;
  locked: WorkspaceNames;
}> {
  const { workspaces: expected } = await resolveWorkspaces(root);
  const lock = await readLock(root);
  const locked: WorkspaceNames = Object.fromEntries(
    Object.entries(lock.workspaces ?? {}).map(([dir, ws]) => [dir, ws.name]),
  );
  return { expected, locked };
}

/**
 * Workspace path → version, from the package.json files and from bun.lock. A frozen install
 * passes after `bun pm version` bumps a workspace and leaves the lock on the old version; an
 * unfrozen `bun install` (`bun-deps install`) rewrites it. Bun never records the root's version.
 */
export async function lockWorkspaceVersions(root: string): Promise<{
  expected: WorkspaceNames;
  locked: WorkspaceNames;
}> {
  const { versions: expected } = await resolveWorkspaces(root);
  const lock = await readLock(root);
  const locked: WorkspaceNames = Object.fromEntries(
    Object.entries(lock.workspaces ?? {})
      .filter(([dir]) => dir !== "")
      .map(([dir, ws]) => [dir, ws.version]),
  );
  return { expected, locked };
}

/**
 * Compares per-workspace dependency maps (`dependencies`, `devDependencies`,
 * `peerDependencies`, `optionalDependencies`) between `package.json` and `bun.lock`.
 */
export async function lockWorkspaceDependencies(root: string): Promise<{
  drift: string[];
}> {
  const inspection = await inspectWorkspaces(root);
  const lock = await readLock(root);
  const drift: string[] = [];

  for (const pkg of inspection.packages) {
    const lockedWs = lock.workspaces?.[pkg.dir];
    if (!lockedWs) {
      drift.push(`${pkg.dir || "<root>"}: missing workspace entry in bun.lock`);
      continue;
    }
    for (const group of WORKSPACE_DEP_GROUPS) {
      const expectedMap = pkg[group];
      const lockedMap = normalizeStringMap(lockedWs[group]);
      const allKeys = [
        ...new Set([...Object.keys(expectedMap), ...Object.keys(lockedMap)]),
      ].sort();
      for (const dep of allKeys) {
        if (expectedMap[dep] !== lockedMap[dep]) {
          drift.push(
            `${pkg.dir || "<root>"} ${group}.${dep}: lock ${JSON.stringify(lockedMap[dep])} vs manifest ${JSON.stringify(expectedMap[dep])}`,
          );
        }
      }
    }
  }
  return { drift };
}

/**
 * Patches declared in package.json and in bun.lock, and declared patch files that are missing.
 * Under a frozen lockfile `bun patch --commit` writes the patch and package.json but not bun.lock,
 * and a frozen install still applies the patch, so nothing else notices the lock is behind.
 */
export async function patchState(root: string): Promise<{
  declared: Record<string, string>;
  locked: Record<string, string>;
  missing: string[];
}> {
  const manifest = (await Bun.file(
    path.join(root, "package.json"),
  ).json()) as RawManifest;
  const declared = manifest.patchedDependencies ?? {};
  const locked = (await readLock(root)).patchedDependencies ?? {};
  const missing: string[] = [];
  for (const file of Object.values(declared)) {
    if (!(await Bun.file(path.join(root, file)).exists())) missing.push(file);
  }
  return { declared, locked, missing };
}

function computeTopologicalWaves(
  nodes: readonly string[],
  edges: readonly { from: string; to: string }[],
): {
  waves: string[][];
  cycles: string[][];
} {
  const nodeSet = new Set(nodes);
  const depsOf = new Map<string, Set<string>>();
  const dependentsOf = new Map<string, Set<string>>();
  for (const n of nodes) {
    depsOf.set(n, new Set());
    dependentsOf.set(n, new Set());
  }
  for (const { from, to } of edges) {
    if (!nodeSet.has(from) || !nodeSet.has(to) || from === to) continue;
    depsOf.get(from)!.add(to);
    dependentsOf.get(to)!.add(from);
  }

  const inDegree = new Map<string, number>();
  for (const [n, deps] of depsOf) {
    inDegree.set(n, deps.size);
  }

  const remaining = new Set(nodes);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((n) => (inDegree.get(n) ?? 0) === 0)
      .sort();
    if (ready.length === 0) break;
    waves.push(ready);
    for (const done of ready) {
      remaining.delete(done);
      for (const dependent of dependentsOf.get(done) ?? []) {
        if (remaining.has(dependent)) {
          inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
        }
      }
    }
  }

  const cycles: string[][] = [];
  if (remaining.size > 0) {
    cycles.push([...remaining].sort());
  }
  return { waves, cycles };
}

/**
 * Validates `workspace:*` / `workspace:^` / `workspace:~` / `workspace:<dir>` edges,
 * `catalog:` references, duplicate sibling workspace names, unlinked local workspace deps,
 * and computes topological execution waves.
 */
export function analyzeWorkspaceGraph(
  inspection: WorkspaceInspection,
): WorkspaceGraphAnalysis {
  const issues: WorkspaceGraphIssue[] = [];
  const edges: WorkspaceEdge[] = [];

  const rootPkg = inspection.packages.find((p) => p.dir === "");
  const childPackages = inspection.packages.filter((p) => p.dir !== "");
  const byDir = new Map(inspection.packages.map((p) => [p.dir, p]));
  const childByName = new Map<string, WorkspacePackageInfo[]>();

  for (const child of childPackages) {
    const list = childByName.get(child.name) ?? [];
    list.push(child);
    childByName.set(child.name, list);
  }

  for (const [name, list] of childByName) {
    if (name !== "" && list.length > 1) {
      issues.push({
        kind: "duplicate-workspace-name",
        dir: list.map((p) => p.dir).join(", "),
        detail: `duplicate workspace name "${name}" across ${list.map((p) => p.dir).join(", ")}`,
      });
    }
  }

  for (const pkg of inspection.packages) {
    const label = pkg.dir || "<root>";
    for (const group of WORKSPACE_DEP_GROUPS) {
      for (const [depName, spec] of Object.entries(pkg[group])) {
        if (spec.startsWith("catalog:")) {
          const catalogKey = spec.slice("catalog:".length).trim();
          if (catalogKey === "" || catalogKey === "default") {
            if (inspection.catalog[depName] === undefined) {
              issues.push({
                kind: "missing-catalog-entry",
                dir: pkg.dir,
                detail: `${label} ${group}.${depName} uses "${spec}" but root catalog has no "${depName}" entry`,
              });
            }
          } else if (inspection.catalogs[catalogKey]?.[depName] === undefined) {
            issues.push({
              kind: "missing-catalog-entry",
              dir: pkg.dir,
              detail: `${label} ${group}.${depName} uses "${spec}" but root catalogs["${catalogKey}"] has no "${depName}" entry`,
            });
          }
          continue;
        }

        if (spec.startsWith("workspace:")) {
          const rawTarget = spec.slice("workspace:".length).trim();
          const normalizedTarget = normalizePosixDir(rawTarget);
          const explicitDirMatch =
            rawTarget !== "" &&
            rawTarget !== "*" &&
            rawTarget !== "^" &&
            rawTarget !== "~" &&
            byDir.get(normalizedTarget);

          if (explicitDirMatch) {
            edges.push({
              fromDir: pkg.dir,
              fromName: pkg.name,
              toDir: explicitDirMatch.dir,
              toName: explicitDirMatch.name,
              depName,
              specifier: spec,
              group,
            });
            continue;
          }

          // Check if rawTarget looked like a directory path that doesn't exist
          if (rawTarget.includes("/")) {
            issues.push({
              kind: "missing-target",
              dir: pkg.dir,
              detail: `${label} ${group}.${depName} -> "${spec}" points to non-existent workspace directory "${normalizedTarget}"`,
            });
            continue;
          }

          // Resolve by workspace package name (preferring child workspaces)
          const matchingChildren = childByName.get(depName) ?? [];
          if (
            rootPkg !== undefined &&
            rootPkg.name === depName &&
            matchingChildren.length > 0
          ) {
            issues.push({
              kind: "ambiguous-root-name",
              dir: pkg.dir,
              detail: `${label} ${group}.${depName} -> "${spec}" collides with root name "${rootPkg.name}"; use "workspace:${matchingChildren[0]!.dir}" or give the child workspace a distinct name`,
            });
            continue;
          }

          const target =
            matchingChildren[0] ??
            (rootPkg?.name === depName ? rootPkg : undefined);
          if (!target) {
            issues.push({
              kind: "missing-target",
              dir: pkg.dir,
              detail: `${label} ${group}.${depName} -> "${spec}" matches no workspace package in this monorepo`,
            });
            continue;
          }

          edges.push({
            fromDir: pkg.dir,
            fromName: pkg.name,
            toDir: target.dir,
            toName: target.name,
            depName,
            specifier: spec,
            group,
          });
          continue;
        }

        // Non-workspace specifier whose depName matches a child workspace in this monorepo
        if (pkg.dir !== "" && childByName.has(depName)) {
          const sibling = childByName.get(depName)?.[0];
          if (sibling && sibling.dir !== pkg.dir) {
            issues.push({
              kind: "unlinked-workspace-dep",
              dir: pkg.dir,
              detail: `${label} ${group}.${depName} declares "${spec}" instead of "workspace:*" for local workspace ${sibling.dir}`,
            });
          }
        }
      }
    }
  }

  const childNodes = childPackages.map((p) => p.dir);
  const childTopo = computeTopologicalWaves(
    childNodes,
    edges.map((e) => ({ from: e.fromDir, to: e.toDir })),
  );
  const allNodes = inspection.packages.map((p) => p.dir);
  const allTopo = computeTopologicalWaves(
    allNodes,
    edges.map((e) => ({ from: e.fromDir, to: e.toDir })),
  );

  for (const cycle of allTopo.cycles) {
    issues.push({
      kind: "cycle",
      dir: cycle[0] ?? "",
      detail: `workspace dependency cycle across [${cycle.map((d) => d || "<root>").join(" <-> ")}]`,
    });
  }

  return {
    edges,
    issues,
    waves: childTopo.waves,
    allWaves: allTopo.waves,
    cycles: allTopo.cycles,
  };
}

function extractBarePackageName(specifier: string): string | null {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("data:") ||
    specifier === "bun"
  ) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  const slash = specifier.indexOf("/");
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

function loaderForExtension(
  filePath: string,
): "ts" | "tsx" | "js" | "jsx" | null {
  if (filePath.endsWith(".d.ts")) return null;
  if (filePath.endsWith(".tsx")) return "tsx";
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".mts") ||
    filePath.endsWith(".cts")
  ) {
    return "ts";
  }
  if (filePath.endsWith(".jsx")) return "jsx";
  if (
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  ) {
    return "js";
  }
  return null;
}

/**
 * Scans every non-root workspace (`packages/*`) with `Bun.Transpiler.scanImports` to verify
 * that each workspace is self-contained and declares every bare npm/workspace package it imports
 * in its own `package.json` (preventing phantom reliance on hoisted root `node_modules`).
 */
export async function auditWorkspaceSelfContainment(
  root: string,
): Promise<WorkspaceSelfContainmentReport> {
  const inspection = await inspectWorkspaces(root);
  const transpilers = {
    ts: new Transpiler({ loader: "ts" }),
    tsx: new Transpiler({ loader: "tsx" }),
    js: new Transpiler({ loader: "js" }),
    jsx: new Transpiler({ loader: "jsx" }),
  } as const;

  let scannedFiles = 0;
  let scannedImports = 0;
  const undeclaredImports: UndeclaredWorkspaceImport[] = [];

  for (const pkg of inspection.packages) {
    if (pkg.dir === "") continue;
    const wsAbs = path.join(root, pkg.dir);
    if (!existsSync(wsAbs)) continue;
    const wsReal = realpathSync(wsAbs);
    const isNshGuest = existsSync(path.join(wsAbs, "nsh.json"));

    const declared = new Set<string>([
      pkg.name,
      ...Object.keys(pkg.dependencies),
      ...Object.keys(pkg.devDependencies),
      ...Object.keys(pkg.peerDependencies),
      ...Object.keys(pkg.optionalDependencies),
    ]);

    const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
    const relFiles: string[] = [];
    for await (const rel of glob.scan({ cwd: wsAbs, dot: false })) {
      const segments = rel.split("/");
      if (
        segments.includes("node_modules") ||
        segments.includes("dist") ||
        segments.includes("coverage") ||
        segments.includes(".nsh")
      ) {
        continue;
      }
      relFiles.push(rel);
    }
    relFiles.sort();

    for (const rel of relFiles) {
      const loader = loaderForExtension(rel);
      if (loader === null) continue;
      const fullPath = path.join(wsAbs, rel);
      try {
        // Direct symlinks pointing outside the workspace (e.g. zero-spawn root CLI bin links)
        // belong to the target root entrypoint rather than this workspace's source tree.
        const resolved = realpathSync(fullPath);
        if (
          resolved !== wsReal &&
          !resolved.startsWith(`${wsReal}${path.sep}`)
        ) {
          continue;
        }
      } catch {
        continue;
      }

      const source = await Bun.file(fullPath).text();
      scannedFiles += 1;
      let imports: { path: string; kind: string }[] = [];
      try {
        imports = transpilers[loader].scanImports(source);
      } catch {
        continue;
      }

      for (const imp of imports) {
        scannedImports += 1;
        if (
          isNshGuest &&
          imp.kind === "require-call" &&
          (imp.path === "react" || imp.path.startsWith("react/"))
        ) {
          continue;
        }
        const pkgName = extractBarePackageName(imp.path);
        if (pkgName === null) continue;
        if (NODE_BUILTINS.has(pkgName)) continue;
        if (isNshGuest && NSH_GUEST_BUILTINS.has(pkgName)) continue;
        if (!declared.has(pkgName)) {
          undeclaredImports.push({
            dir: pkg.dir,
            file: `${pkg.dir}/${rel}`,
            specifier: imp.path,
            packageName: pkgName,
          });
        }
      }
    }
  }

  return { scannedFiles, scannedImports, undeclaredImports };
}

/**
 * Inspects isolated store (`node_modules/.bun`) + per-workspace `node_modules/<dep>` symlinks,
 * plus `nsh.json` version alignment where applicable.
 */
export async function inspectWorkspaceInstallLayout(
  root: string,
): Promise<WorkspaceInstallLayoutReport> {
  const inspection = await inspectWorkspaces(root);
  const rootModules = path.join(root, "node_modules");
  const storeMode: "isolated" | "hoisted" | "missing" = !existsSync(rootModules)
    ? "missing"
    : existsSync(path.join(rootModules, ".bun"))
      ? "isolated"
      : "hoisted";

  const workspaceLinks: WorkspaceNodeModulesStatus[] = [];
  const nshVersionDrift: string[] = [];

  for (const pkg of inspection.packages) {
    if (pkg.dir === "") continue;
    const wsAbs = path.join(root, pkg.dir);
    const expectedLinks = [
      ...new Set([
        ...Object.keys(pkg.dependencies),
        ...Object.keys(pkg.devDependencies),
        ...Object.keys(pkg.optionalDependencies),
      ]),
    ].sort();

    const presentLinks: string[] = [];
    const missingLinks: string[] = [];
    const brokenLinks: string[] = [];

    if (storeMode !== "missing") {
      for (const depName of expectedLinks) {
        const linkPath = path.join(
          wsAbs,
          "node_modules",
          ...depName.split("/"),
        );
        const rootFallback = path.join(rootModules, ...depName.split("/"));
        let lstatOk = false;
        try {
          lstatSync(linkPath);
          lstatOk = true;
        } catch {
          lstatOk = false;
        }

        if (lstatOk) {
          if (existsSync(linkPath)) {
            presentLinks.push(depName);
          } else {
            brokenLinks.push(depName);
          }
        } else if (storeMode === "hoisted" && existsSync(rootFallback)) {
          presentLinks.push(depName);
        } else {
          missingLinks.push(depName);
        }
      }
    }

    workspaceLinks.push({
      dir: pkg.dir,
      name: pkg.name,
      expectedLinks,
      presentLinks,
      missingLinks,
      brokenLinks,
    });

    const nshPath = path.join(wsAbs, "nsh.json");
    if (existsSync(nshPath)) {
      const nshRaw = (await Bun.file(nshPath).json()) as { version?: unknown };
      if (
        typeof nshRaw.version === "string" &&
        pkg.version !== undefined &&
        nshRaw.version !== pkg.version
      ) {
        nshVersionDrift.push(
          `${pkg.dir}: package.json version ${pkg.version} != nsh.json version ${nshRaw.version}`,
        );
      }
    }
  }

  return { storeMode, workspaceLinks, nshVersionDrift };
}

/**
 * Evaluates root `package.json` monorepo hygiene:
 * - `"private": true` is always required so the root manifest is never published to npm.
 * - Separates external root npm dependencies from `"workspace:*"` links.
 * - When `strictZeroRootDeps` is true (pure greenfield monorepo mode), fails if root declares
 *   any `dependencies` or `devDependencies`.
 */
export async function auditRootWorkspaceHygiene(
  root: string,
  options: { readonly strictZeroRootDeps?: boolean } = {},
): Promise<RootWorkspaceHygieneReport> {
  const strictZeroRootDeps = options.strictZeroRootDeps ?? false;
  const inspection = await inspectWorkspaces(root);
  const rootPkg = inspection.packages.find((p) => p.dir === "");
  const deps = rootPkg?.dependencies ?? {};
  const devDeps = rootPkg?.devDependencies ?? {};

  const externalDeps = Object.entries(deps)
    .filter(([, v]) => !v.startsWith("workspace:"))
    .map(([k]) => k)
    .sort();
  const externalDevDeps = Object.entries(devDeps)
    .filter(([, v]) => !v.startsWith("workspace:"))
    .map(([k]) => k)
    .sort();
  const workspaceLinks = [...Object.entries(deps), ...Object.entries(devDeps)]
    .filter(([, v]) => v.startsWith("workspace:"))
    .map(([k, v]) => `${k}@${v}`)
    .sort();

  const totalRootDeps =
    externalDeps.length + externalDevDeps.length + workspaceLinks.length;
  const privateOk = inspection.rootPrivate;
  const strictOk = !strictZeroRootDeps || totalRootDeps === 0;
  const ok = privateOk && strictOk;

  let detail: string;
  if (!privateOk) {
    detail = 'root package.json missing "private": true';
  } else if (!strictOk) {
    detail = `strict zero-root-deps failed: ${externalDeps.length} deps, ${externalDevDeps.length} devDeps, ${workspaceLinks.length} workspace link(s) on root`;
  } else if (totalRootDeps === 0) {
    detail = "private=true; pure zero-dependency monorepo root";
  } else {
    detail = `private=true; hybrid root (${externalDeps.length} deps, ${externalDevDeps.length} devDeps, ${workspaceLinks.length} workspace link)`;
  }

  return {
    rootPrivate: inspection.rootPrivate,
    externalDeps,
    externalDevDeps,
    workspaceLinks,
    strictZeroRootDeps,
    ok,
    detail,
  };
}

/**
 * Resolves a user-supplied workspace selector (`packages/ba-example`, `ba-example`,
 * `@sportsdesk-ops/nsh-desk`, `root`, `.`) to a canonical `WorkspacePackageInfo`.
 */
export function resolveWorkspaceSelector(
  inspection: WorkspaceInspection,
  selector: string,
): WorkspacePackageInfo | null {
  const trimmed = selector.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "root") {
    return inspection.packages.find((p) => p.dir === "") ?? null;
  }
  const norm = normalizePosixDir(trimmed);
  const byExactDir = inspection.packages.find((p) => p.dir === norm);
  if (byExactDir) return byExactDir;

  const byPackagesSlug = inspection.packages.find(
    (p) => p.dir === `packages/${norm}`,
  );
  if (byPackagesSlug) return byPackagesSlug;

  // Prefer child workspaces when matching by package name (since root and a child may share a name)
  const childByName = inspection.packages.find(
    (p) => p.dir !== "" && p.name === trimmed,
  );
  if (childByName) return childByName;

  return inspection.packages.find((p) => p.name === trimmed) ?? null;
}

/**
 * Computes the canonical `"workspace:*"` (or `"workspace:<dir>"` when disambiguating root's name)
 * dependency key & specifier for linking `target` into `from`.
 */
export function formatWorkspaceLinkSpecifier(
  inspection: WorkspaceInspection,
  target: WorkspacePackageInfo,
): { readonly depName: string; readonly specifier: string } {
  const rootPkg = inspection.packages.find((p) => p.dir === "");
  if (
    target.dir !== "" &&
    rootPkg !== undefined &&
    target.name === rootPkg.name
  ) {
    return {
      depName: target.name,
      specifier: `workspace:${target.dir}`,
    };
  }
  return {
    depName: target.name,
    specifier: "workspace:*",
  };
}
