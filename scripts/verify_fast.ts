#!/usr/bin/env bun
/**
 * @file scripts/verify_fast.ts
 * @description Sub-2s parallel inner-loop verification for rapid local development.
 *
 * Replaces 15+ sequential gate commands and 60s+ full-repo test sweeps with:
 *   1. Scoped `bun fmt` on changed files (~30ms; `--check` for read-only)
 *   2. Parallel `Promise.all` execution of:
 *      - Workspace-scoped `bun check --no-script -p <tsconfig>` (UI-only edits skip root `tsconfig.json`)
 *      - Native `bun lint --no-script --deny-warnings` scoped to changed JS/TS/TSX files (`--deep` adds `--type-aware`)
 *      - Path-triggered gates ONLY when relevant directories changed
 *      - Targeted tests: `bun test --parallel --changed` (or head shard `--shard=1/8` + explicit
 *        changed/matched `*.test.ts` when root configs changed or inside a sandboxed worktree).
 *
 * Usage:
 *   bun run verify:fast                      # auto-detect changed files (git diff or mtime fallback)
 *   bun run verify:fast lib/foo.ts           # verify specific file(s) + matching tests
 *   bun run verify:fast --check              # read-only format check
 *   bun run verify:fast --shard              # force head shard (1/8)
 *   bun run verify:fast --deep               # include type-aware bun lint pass
 *   bun run verify:fast --no-lint            # skip lint when no native binary is available
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeWorkspaceGraph, inspectWorkspaces } from "../lib/pm_policy.ts";
import { resolveNativeBunLintBin } from "./lint_native.ts";

const ROOT = path.resolve(import.meta.dir, "..");

export const FORMAT_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|json5|md|html|css|yml|yaml|toml)$/;
export const LINT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const ROOT_BLAST_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.workspaces.json",
  "bun.lock",
  "bunfig.toml",
]);

/** Paths whose contents nothing imports: `bun test --changed` cannot select them. */
export const NON_MODULE_PATHS: readonly string[] = [
  "data/",
  "tests/fixtures/",
  "design/",
  "schema/",
  "config/",
];

/** Root files with the same property (nothing imports them). */
export const NON_MODULE_FILES: ReadonlySet<string> = new Set([
  "bunfig.toml",
  ".bun-version",
]);

/**
 * Extensions that hold behaviour a test reads through the filesystem rather than an import.
 * Anything else under a non-module path (README, images, CSVs) changes no test expectation, so
 * warning about it is noise.
 */
const DATA_EXTENSIONS: readonly string[] = [
  ".json",
  ".jsonl",
  ".toml",
  ".yml",
  ".yaml",
  ".xml",
  ".sql",
];

function hasDataExtension(file: string): boolean {
  return DATA_EXTENSIONS.some((ext) => file.endsWith(ext));
}

const SNAPSHOT_FILE_RE = /^(?:(.+)\/)?__snapshots__\/([^/]+)\.snap$/;
const SNAPSHOT_OWNER_TEST_RE =
  /(?:\.|_)(?:test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** True for any Bun/Jest snapshot file (`__snapshots__/*.snap`). */
export function isSnapshotFile(file: string): boolean {
  return SNAPSHOT_FILE_RE.test(file);
}

/**
 * Map a snapshot file (`<dir>/__snapshots__/<test>.snap` or `__snapshots__/<test>.snap`)
 * back to its owning test file (`<dir>/<test>` or `<test>`).
 * Returns null when the path is not a snapshot of a test file.
 */
export function snapshotOwnerTestFile(file: string): string | null {
  const match = SNAPSHOT_FILE_RE.exec(file);
  if (match === null) return null;
  const dir = match[1];
  const testFile = match[2] as string;
  if (!SNAPSHOT_OWNER_TEST_RE.test(testFile)) return null;
  return dir === undefined ? testFile : `${dir}/${testFile}`;
}

/**
 * Drop paths a module imports, because `--changed` follows those and the warning would be wrong.
 *
 * The path list is a coarse prefix filter: `design/` and `config/` contain both imported artefacts
 * (`design/domain-branded-types.ts`, `design/tokens.toml`, `config/slab.toml`) and files nothing
 * imports (`config/fraud-model.json`). Import reachability decides per file.
 *
 * @param files - candidate paths from {@link nonModuleChangedFiles}.
 * @param imported - the subset some module imports (see `importedSpecifierPaths`).
 */
export function filterImported(
  files: readonly string[],
  imported: ReadonlySet<string>,
): string[] {
  return files.filter(
    (file) =>
      (hasDataExtension(file) || isSnapshotFile(file)) && !imported.has(file),
  );
}

/**
 * The subset of `files` a module **imports**, found by matching each path inside an import
 * specifier (`from "…"`, `import("…")`, `import "…"`).
 *
 * A plain substring search is not enough: `Bun.file("data/agent-tree.json")` mentions the path but
 * is a filesystem read, which `--changed` does not follow. Runs only on the zero-selection branch,
 * so the subprocess cost is bounded by a diff that already produced no tests.
 */
export function importedSpecifierPaths(
  files: readonly string[],
  root: string,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const file of files) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // POSIX ERE (git grep -E): no `(?:…)` and no `\s`.
    const ws = "[[:space:]]";
    const pattern = `(from${ws}*|import${ws}*\\(${ws}*|import${ws}+)["'][^"']*${escaped}["']`;
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        root,
        "grep",
        "-q",
        "-E",
        "-e",
        pattern,
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.mjs",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (result.exitCode === 0) imported.add(file);
  }
  return imported;
}

/**
 * The command that owns a non-module path, when one is known.
 *
 * A warning that says "run the owning suite" is only useful if the operator can guess it; these
 * are the ones this repository actually has.
 */
export function ownerHint(file: string): string | null {
  if (file === ".bun-version") return "bun test tests/bun_runtime_pin.test.ts";
  if (file === "bunfig.toml") return "bun test tests/bun_config_policy.test.ts";
  if (file.startsWith("schema/")) return "bun run schema:gate";
  const snapOwner = snapshotOwnerTestFile(file);
  if (snapOwner !== null) return `bun test ${snapOwner}`;
  if (file.startsWith("tests/fixtures/")) {
    const base = file.slice("tests/fixtures/".length);
    return `the suite that reads tests/fixtures/${base} (name it explicitly)`;
  }
  return null;
}

/**
 * Read the file count from Bun's test summary (`Ran N tests across M files.`).
 * @param output - captured stdout/stderr of a `bun test` run.
 * @returns M, or null when the summary line is absent.
 */
export function parseSelectedFileCount(output: string): number | null {
  const match = /Ran \d+ tests? across (\d+) files?\./.exec(output);
  return match === null ? null : Number(match[1]);
}

/**
 * Changed files that `bun test --changed` cannot select, because selection follows module
 * imports and nothing imports data, fixtures, or config.
 * @param changed - repository-relative paths of the changed files.
 * @returns the subset a changed-only test run cannot reach.
 */
export function nonModuleChangedFiles(changed: readonly string[]): string[] {
  return changed.filter(
    (file) =>
      NON_MODULE_FILES.has(file) ||
      NON_MODULE_PATHS.some((prefix) => file.startsWith(prefix)) ||
      isSnapshotFile(file),
  );
}

/**
 * Upper bound on the reader suites a silent-zero run will execute automatically. A data-only diff
 * currently runs zero tests, so spending a few seconds on its real readers is cheaper than a false
 * green; beyond this the run warns instead of turning the inner loop into a suite run.
 */
export const MAX_READER_FILES = 25;

/** Lines that only mention a path in prose (comments/docs) are not reads. */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;

/**
 * `git grep -E` pattern for a path that must appear as a whole path token.
 *
 * A literal (`-F`) search matches `bunfig.toml` inside `unfrozen.bunfig.toml`, and
 * `data/x.json` inside `data/x.jsonl` — different files — which would recover suites that read
 * something else and hide the "no references" warning for a path only ever named as a substring.
 * The boundaries reject a neighbouring path character on either side; `/` is not one of them, so a
 * relative specifier (`"../../design/tokens.toml"`) still matches.
 */
export function dataPathPattern(file: string): string {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(^|[^A-Za-z0-9_.-])${escaped}([^A-Za-z0-9_.-]|$)`;
}

/**
 * `git grep -n -E` over every tracked test file, keeping the ones that touch the path in code.
 * Exit 1 means "no match", not an error. A comment that merely names the file is dropped.
 *
 * The pathspec is `*.test.ts`/`*.test.tsx` rather than a directory list, so a colocated suite is
 * found wherever it lives (`tests/`, `lib/`, `scripts/`, `packages/`).
 */
function gitGrepReaders(file: string, root: string): string[] {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "grep",
      "-n",
      "-E",
      "-e",
      dataPathPattern(file),
      "--",
      "*.test.ts",
      "*.test.tsx",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) return [];
  const readers = new Set<string>();
  for (const line of result.stdout.toString().split("\n")) {
    const first = line.indexOf(":");
    const second = first === -1 ? -1 : line.indexOf(":", first + 1);
    if (first === -1 || second === -1) continue;
    const filePart = line.slice(0, first);
    const content = line.slice(second + 1);
    if (filePart === "" || COMMENT_LINE.test(content)) continue;
    readers.add(filePart);
  }
  return [...readers];
}

/**
 * Test files whose source mentions an unreachable path.
 *
 * `--changed` follows module imports only, so a data change selects nothing; the suites that read
 * that path do not import it, they pass it to `Bun.file`/`readFileSync`. A literal search over the
 * test trees recovers those files without guessing at a test-name convention.
 * @param files - changed paths no module imports.
 * @param root - repository root for `git grep`.
 * @param grep - seam for tests; defaults to the literal `git grep` above.
 * @param exists - seam for snapshot-owner existence checks in tests.
 */
export function dataReaderTestFiles(
  files: readonly string[],
  root: string,
  grep: (file: string) => string[] = (file) => gitGrepReaders(file, root),
  exists: (relPath: string) => boolean = (relPath) =>
    existsSync(path.join(root, relPath)),
): string[] {
  const readers = new Set<string>();
  for (const file of files) {
    if (isSnapshotFile(file)) {
      const snapOwner = snapshotOwnerTestFile(file);
      if (snapOwner !== null && exists(snapOwner)) {
        readers.add(snapOwner);
      }
      continue;
    }
    for (const hit of grep(file)) {
      if (hit.endsWith(".test.ts") || hit.endsWith(".test.tsx"))
        readers.add(hit);
    }
  }
  return [...readers].sort();
}

export type ReaderRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "run"; readonly files: readonly string[] }
  | {
      readonly kind: "warn";
      readonly reason: "no-references" | "too-many";
      readonly count: number;
    };

/**
 * Decide what a silent-zero selection should do with the reader tests it recovered.
 * @param unreachable - paths `--changed` cannot see.
 * @param readers - test files recovered by {@link dataReaderTestFiles}.
 * @param max - cap on files a single inner-loop run may execute.
 */
export function planReaderRecovery(
  unreachable: readonly string[],
  readers: readonly string[],
  max: number = MAX_READER_FILES,
): ReaderRecovery {
  if (unreachable.length === 0) return { kind: "none" };
  if (readers.length === 0)
    return { kind: "warn", reason: "no-references", count: 0 };
  if (readers.length > max)
    return { kind: "warn", reason: "too-many", count: readers.length };
  return { kind: "run", files: readers };
}

export type SelectionRecovery = {
  /** Changed paths no module imports, after dropping what `--changed` already follows. */
  readonly unreachable: string[];
  readonly recovery: ReaderRecovery;
};

/**
 * Plan the extra coverage for a diff, independently of how many tests `--changed` selected.
 *
 * A mixed diff (one code change plus one data change) selects tests, so a zero-selection gate
 * would skip the data readers entirely; this runs them whenever an unreachable path changed.
 * @param changed - repository-relative paths of the changed files.
 * @param root - repository root, passed to the git greps.
 * @param seams - injectable import/reader resolvers, for tests.
 */
export function planSelectionRecovery(
  changed: readonly string[],
  root: string,
  seams: {
    readonly imported?: (
      files: readonly string[],
      root: string,
    ) => ReadonlySet<string>;
    readonly readers?: (
      files: readonly string[],
      root: string,
    ) => readonly string[];
  } = {},
): SelectionRecovery {
  const imported = (seams.imported ?? importedSpecifierPaths)(changed, root);
  const unreachable = filterImported(nonModuleChangedFiles(changed), imported);
  const readers = (seams.readers ?? dataReaderTestFiles)(unreachable, root);
  return { unreachable, recovery: planReaderRecovery(unreachable, readers) };
}

export const SCOPED_WORKSPACE_DIRS = [
  "packages/contracts",
  "packages/ui",
  "packages/backend",
  "packages/api",
] as const;

export interface WorkspaceEdgeRef {
  readonly fromDir: string;
  readonly toDir: string;
}

export interface TypecheckTaskSpec {
  readonly name: string;
  readonly cmd: readonly string[];
}

export function workspaceDirOfFile(file: string): string | null {
  for (const ws of SCOPED_WORKSPACE_DIRS) {
    if (file === ws || file.startsWith(`${ws}/`)) {
      return ws;
    }
  }
  return null;
}

export function buildDownstreamDependents(
  edges: readonly WorkspaceEdgeRef[],
): Map<string, Set<string>> {
  const downstream = new Map<string, Set<string>>();
  for (const { fromDir, toDir } of edges) {
    if (fromDir === toDir) continue;
    let set = downstream.get(toDir);
    if (!set) {
      set = new Set<string>();
      downstream.set(toDir, set);
    }
    set.add(fromDir);
  }
  return downstream;
}

function fullTypecheckSpecs(): TypecheckTaskSpec[] {
  return [
    {
      name: "typecheck",
      cmd: ["bun", "check", "--no-script", "-p", "tsconfig.json"],
    },
    {
      name: "typecheck:ui",
      cmd: ["bun", "check", "--no-script", "-p", "src/dashboard/tsconfig.json"],
    },
    ...SCOPED_WORKSPACE_DIRS.map((ws) => ({
      name: `typecheck:pkg:${ws.slice("packages/".length)}`,
      cmd: ["bun", "check", "--no-script", "-p", `${ws}/tsconfig.json`],
    })),
    {
      name: "ensure:tsconfig",
      cmd: ["bun", "run", "scripts/ensure_deep_tsconfig.ts"],
    },
  ];
}

/**
 * Select the minimal set of `bun check -p <tsconfig>` tasks needed for `changed`:
 * - Case A: pure UI/dashboard edits run only `packages/ui/tsconfig.json` + `src/dashboard/tsconfig.json`.
 * - Case B: pure workspace edits run affected workspace `tsconfig.json`s + transitive downstream
 *   dependents (and include root `tsconfig.json` only if root `""` is in the downstream closure).
 * - Case C: root/mixed/empty/`hasRootBlast` runs the full typecheck set.
 */
export function planTypecheckTasks(
  changed: readonly string[],
  options: {
    readonly hasRootBlast: boolean;
    readonly edges: readonly WorkspaceEdgeRef[];
  },
): TypecheckTaskSpec[] {
  if (changed.length === 0 || options.hasRootBlast) {
    return fullTypecheckSpecs();
  }

  const isUiFile = (f: string): boolean =>
    f.startsWith("packages/ui/") || f.startsWith("src/dashboard/");
  if (changed.every(isUiFile)) {
    return [
      {
        name: "typecheck:pkg:ui",
        cmd: ["bun", "check", "--no-script", "-p", "packages/ui/tsconfig.json"],
      },
      {
        name: "typecheck:ui",
        cmd: [
          "bun",
          "check",
          "--no-script",
          "-p",
          "src/dashboard/tsconfig.json",
        ],
      },
    ];
  }

  const isWorkspaceOrUiFile = (f: string): boolean =>
    workspaceDirOfFile(f) !== null || f.startsWith("src/dashboard/");
  if (!changed.every(isWorkspaceOrUiFile)) {
    return fullTypecheckSpecs();
  }

  const downstream = buildDownstreamDependents(options.edges);
  const closure = new Set<string>();
  const queue: string[] = [];

  for (const file of changed) {
    const ws = workspaceDirOfFile(file);
    if (ws !== null && !closure.has(ws)) {
      closure.add(ws);
      queue.push(ws);
    }
    if (file.startsWith("src/dashboard/") && !closure.has("packages/ui")) {
      closure.add("packages/ui");
      queue.push("packages/ui");
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dep of downstream.get(current) ?? []) {
      // Isolated backend/api edits keep sub-100ms scoping by checking workspace
      // boundaries without dragging root tsconfig.json into every inner-loop save;
      // contracts/sportsdesk-ops edits still propagate into root.
      if (
        dep === "" &&
        current !== "packages/contracts" &&
        current !== "packages/sportsdesk-ops"
      ) {
        continue;
      }
      if (!closure.has(dep)) {
        closure.add(dep);
        queue.push(dep);
      }
    }
  }

  const specs: TypecheckTaskSpec[] = [];
  for (const ws of SCOPED_WORKSPACE_DIRS) {
    if (closure.has(ws)) {
      specs.push({
        name: `typecheck:pkg:${ws.slice("packages/".length)}`,
        cmd: ["bun", "check", "--no-script", "-p", `${ws}/tsconfig.json`],
      });
    }
  }

  if (
    closure.has("packages/ui") ||
    changed.some((f) => f.startsWith("src/dashboard/"))
  ) {
    specs.push({
      name: "typecheck:ui",
      cmd: ["bun", "check", "--no-script", "-p", "src/dashboard/tsconfig.json"],
    });
  }

  if (closure.has("")) {
    specs.push(
      {
        name: "typecheck",
        cmd: ["bun", "check", "--no-script", "-p", "tsconfig.json"],
      },
      {
        name: "ensure:tsconfig",
        cmd: ["bun", "run", "scripts/ensure_deep_tsconfig.ts"],
      },
    );
  }

  return specs.length > 0 ? specs : fullTypecheckSpecs();
}

export function inferTestsForFiles(
  files: readonly string[],
  root: string = ROOT,
): string[] {
  const tests = new Set<string>();
  for (const f of files) {
    if (
      /\.test\.(ts|tsx|js|mjs)$/.test(f) &&
      !f.includes("language_coverage") &&
      !f.includes("market_index")
    ) {
      tests.add(f);
      continue;
    }

    const snapOwner = snapshotOwnerTestFile(f);
    if (snapOwner !== null) {
      if (
        existsSync(path.join(root, snapOwner)) &&
        !snapOwner.includes("language_coverage") &&
        !snapOwner.includes("market_index")
      ) {
        tests.add(snapOwner);
      }
      continue;
    }

    const candidates: string[] = [];
    const stem = path
      .basename(f)
      .replace(/\.(types\.)?(ts|tsx|js|mjs|toml|json|css)$/, "");

    if (stem && stem !== "index" && stem !== "package" && stem !== "tsconfig") {
      candidates.push(`tests/${stem}.test.ts`, `tests/${stem}_toml.test.ts`);
      if (/\.(ts|tsx)$/.test(f)) {
        candidates.push(f.replace(/\.(ts|tsx)$/, ".test.$1"));
      }
    }

    if (f.startsWith("packages/nsh-desk/")) {
      candidates.push("tests/nsh_desk_contract.test.ts");
    }

    // A `bin` map edit reaches three surfaces that no stem-matching test covers: the root and
    // workspace bin maps must agree, the generated `cli/README.md` catalog must be regenerated, and
    // every declared bin must answer `--help`. Without this, #416 added a bin with a stale catalog
    // and an unmirrored package entry, and `main`'s full chain found it only after merge (10
    // failures, run 44354504618).
    if (
      f === "package.json" ||
      f === "packages/sportsdesk-ops/package.json" ||
      f.startsWith("packages/sportsdesk-ops/bin/") ||
      f === "cli/README.md"
    ) {
      candidates.push(
        "tests/bunx_cli_root_layout.test.ts",
        "tests/bun_x_catalog_docs.test.ts",
        "tests/bun_x_cli_help.test.ts",
      );
    }

    if (f === "config/wager_tiers.toml") {
      candidates.push(
        "tests/wager_tiers_toml.test.ts",
        "tests/slice_metrics.test.ts",
      );
    } else if (f === "design/tokens.toml") {
      candidates.push(
        "tests/verify_tokens.test.ts",
        "tests/gen_tokens_tokens_ssot.test.ts",
      );
    } else if (
      f.startsWith("packages/ui/src/config/") ||
      f === "scripts/validate_dashboard_config.ts"
    ) {
      candidates.push("tests/dashboard_config_validation.test.ts");
    }

    if (
      f === "schema/wagers_field_contract.json" ||
      f === "scripts/validate_wagers_field_contract.ts"
    ) {
      candidates.push(
        "tests/wagers_field_contract.test.ts",
        "tests/wagers_field_roundtrip.test.ts",
      );
    }

    if (f.startsWith("packages/backend/")) {
      candidates.push(
        "tests/dashboard_backend_workspace.test.ts",
        "tests/dashboard_api_inmemory.test.ts",
        "tests/dashboard_ui_hydration.test.tsx",
        "tests/wagers_field_roundtrip.test.ts",
      );
    } else if (f.startsWith("packages/api/")) {
      candidates.push(
        "tests/dashboard_api_inmemory.test.ts",
        "tests/dashboard_ui_hydration.test.tsx",
      );
    }

    if (
      f.startsWith("packages/ui/") ||
      f.startsWith("packages/contracts/") ||
      f.startsWith("src/dashboard/") ||
      f.startsWith("src/risk/")
    ) {
      if (f.startsWith("packages/ui/src/")) {
        candidates.push(
          "tests/dashboard_ui_panels.test.tsx",
          "tests/dashboard_ui_hydration.test.tsx",
        );
      } else if (f.startsWith("packages/contracts/src/")) {
        candidates.push("tests/dashboard_ui_hydration.test.tsx");
      }
      if (stem === "ansi") {
        candidates.push("tests/dashboard_build_and_markdown.test.ts");
      } else if (stem === "wager_tokens" || stem === "runtime_flags") {
        candidates.push(
          "tests/wager_tiers_toml.test.ts",
          "tests/dashboard_build_and_markdown.test.ts",
        );
      } else if (stem === "features") {
        candidates.push("tests/wager_tiers_toml.test.ts");
      } else if (
        stem === "ShadowPricingPanel" ||
        stem === "SliceMetricsViews" ||
        stem === "shadow_pricing" ||
        stem.startsWith("slice_") ||
        f.startsWith("packages/ui/src/shadow_pricing/")
      ) {
        candidates.push(
          "tests/dashboard_shadow_panel.test.tsx",
          "tests/slice_metrics.test.ts",
          "tests/enhanced_dashboard_builder.test.ts",
        );
      } else if (
        stem === "App" ||
        stem === "index" ||
        stem === "desk" ||
        stem === "tokens" ||
        stem === "reset" ||
        stem === "dashboard"
      ) {
        candidates.push("tests/enhanced_dashboard_builder.test.ts");
      }
    }

    if (
      /^packages\/(contracts|ui|backend|api)\/package\.json$/.test(f) ||
      f === "scripts/check_workspace_packs.ts"
    ) {
      candidates.push("tests/workspace_packs.test.ts");
    }

    for (const c of candidates) {
      if (
        existsSync(path.join(root, c)) &&
        /\.test\.(ts|tsx|js|mjs)$/.test(c) &&
        !c.includes("market_index")
      ) {
        tests.add(c);
      }
    }
  }
  return [...tests];
}

function gitQuery(args: string[]): { ok: boolean; lines: string[] } {
  const res = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    env: {
      ...Bun.env,
      GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (res.exitCode !== 0) return { ok: false, lines: [] };
  const lines = new TextDecoder()
    .decode(res.stdout)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: true, lines };
}

function collectRecentByMtime(minutes: number): string[] {
  const cutoff = Date.now() - minutes * 60_000;
  const glob = new Bun.Glob(
    "{lib,src,packages,scripts,tests,config,design,bin,cli,services,workers,types,migrations}/**/*.{ts,tsx,js,mjs,json,toml,md,sql}",
  );
  const found: string[] = [];
  for (const rel of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
    if (rel.includes("node_modules/")) continue;
    try {
      if (statSync(path.join(ROOT, rel)).mtimeMs >= cutoff) {
        found.push(rel);
      }
    } catch {
      // signal-honesty: intentional-ignore transient file removed mid-scan
    }
  }
  for (const top of [
    "package.json",
    "tsconfig.json",
    "AGENTS.md",
    "README.md",
  ]) {
    const p = path.join(ROOT, top);
    if (existsSync(p) && statSync(p).mtimeMs >= cutoff) found.push(top);
  }
  return found;
}

function collectChangedFiles(
  positionals: readonly string[],
  gitAvailable: boolean,
  options: { readonly base: string | undefined; readonly sinceMin: string },
): string[] {
  if (positionals.length > 0) {
    return positionals.filter((f) => existsSync(path.join(ROOT, f)));
  }
  if (!gitAvailable) {
    return collectRecentByMtime(Number(options.sinceMin) || 45);
  }
  const set = new Set<string>();
  for (const f of gitQuery(["diff", "--name-only", "HEAD"]).lines) set.add(f);
  for (const f of gitQuery(["diff", "--name-only", "--cached"]).lines)
    set.add(f);
  for (const f of gitQuery(["ls-files", "--others", "--exclude-standard"])
    .lines) {
    set.add(f);
  }
  if (set.size === 0 || options.base) {
    const ref = options.base ?? "origin/main...HEAD";
    for (const f of gitQuery(["diff", "--name-only", ref]).lines) set.add(f);
  }
  return [...set].filter((f) => {
    const full = path.join(ROOT, f);
    return existsSync(full) && !lstatSync(full).isSymbolicLink();
  });
}

/**
 * Code extensions whose content can add a `Bun.*` call site (production) or a shape reference
 * (test evidence). Changing one means the derived shape catalogue and its runbook may be stale.
 */
const SHAPE_SOURCE_RE = /\.(?:ts|tsx|mts|cts|mjs|js|jsx)$/;

/** Trees the shape scan never reads, so a change there cannot move the catalogue. */
const SHAPE_IGNORED_PREFIXES = [
  "verification/",
  "examples/",
  "scratch/",
  "Scratch/",
];

/**
 * Whether the staged additions can move `lib/bun_shapes.generated.ts` or the runbook that renders
 * it.
 *
 * The generator scans `git ls-files`, so only a file that is **added to the index** changes what
 * it sees: an untracked file is invisible and a modified file was already counted. That is why
 * this takes the `--diff-filter=A` set rather than the whole diff — and why the gate is cheap
 * enough for the inner loop, since it fires only on the commit that introduces a file.
 */
export function addedShapeSources(changed: readonly string[]): boolean {
  return changed.some(
    (file) =>
      SHAPE_SOURCE_RE.test(file) &&
      !SHAPE_IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

/**
 * Whether the change can move the installed dependency graph.
 *
 * `bun test --changed` follows module imports, so a change confined to a manifest or the lockfile
 * selects no tests at all — nothing imports them (measured 2026-11-18, recorded in AGENTS.md). The
 * install-graph suites read those files, so they are triggered from here instead.
 */
export function changedInstallGraph(changed: readonly string[]): boolean {
  return changed.some(
    (file) =>
      file === "bun.lock" ||
      file === "package.json" ||
      file.endsWith("/package.json"),
  );
}

interface TaskResult {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
}

async function runTask(
  name: string,
  cmd: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<TaskResult> {
  const t0 = performance.now();
  const proc = Bun.spawn([...cmd], {
    cwd: ROOT,
    env: { FORCE_COLOR: "1", ...Bun.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ms = Math.round(performance.now() - t0);
  return {
    name,
    ok: exitCode === 0,
    ms,
    output: [out.trim(), err.trim()].filter(Boolean).join("\n"),
  };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      check: { type: "boolean", default: false },
      shard: { type: "boolean", default: false },
      deep: { type: "boolean", default: false },
      "no-lint": { type: "boolean", default: false },
      base: { type: "string" },
      "since-min": { type: "string", default: "45" },
    },
    allowPositionals: true,
    strict: true,
  });

  const started = performance.now();
  const probeGit = gitQuery(["rev-parse", "--is-inside-work-tree"]);
  const gitAvailable = probeGit.ok;
  const changed = collectChangedFiles(positionals, gitAvailable, {
    base: values.base,
    sinceMin: values["since-min"],
  });

  const fmtTargets = changed.filter((f) => FORMAT_EXT.test(f));
  const lintTargets = changed.filter((f) => LINT_EXT.test(f));
  const inferredTests = inferTestsForFiles(changed);
  const hasRootBlast = changed.some((f) => ROOT_BLAST_FILES.has(f));

  // Phase 1: Format & token gate (avoids racing parallel readers on unlinked files)
  let fmtResult: TaskResult | null = null;
  if (fmtTargets.length > 0) {
    const fmtCmd = values.check
      ? ["bun", "fmt", "--check", ...fmtTargets]
      : ["bun", "fmt", ...fmtTargets];
    fmtResult = await runTask(
      values.check
        ? `fmt:check (${fmtTargets.length})`
        : `fmt (${fmtTargets.length})`,
      fmtCmd,
    );
    if (!fmtResult.ok) {
      console.error(
        `✗ ${fmtResult.name} (${fmtResult.ms}ms)\n${fmtResult.output}`,
      );
      return 1;
    }
  }

  let tokensGateResult: TaskResult | null = null;
  if (
    gitAvailable &&
    changed.some(
      (f) => f.startsWith("design/") || f.startsWith("lib/gen_tokens/"),
    )
  ) {
    const { GEN_TOKEN_EMISSION_PATHS } =
      await import("../lib/gen_tokens/emission_targets.ts");
    const dirtyOutputs = gitQuery([
      "status",
      "--porcelain",
      "--",
      ...GEN_TOKEN_EMISSION_PATHS,
    ]);
    if (dirtyOutputs.ok && dirtyOutputs.lines.length === 0) {
      tokensGateResult = await runTask("gen:tokens:gate", [
        "bun",
        "run",
        "scripts/gen_tokens_gate.ts",
      ]);
    } else {
      // Same-process before/after change detection only — xxHash64 suffices.
      const hashOutputs = async (): Promise<Map<string, string>> => {
        const out = new Map<string, string>();
        for (const rel of GEN_TOKEN_EMISSION_PATHS) {
          const bytes = await Bun.file(path.join(ROOT, rel)).bytes();
          out.set(rel, Bun.hash(bytes).toString(16));
        }
        return out;
      };
      const t0 = performance.now();
      const beforeHashes = await hashOutputs();
      const genRun = await runTask("gen:tokens (idempotence)", [
        "bun",
        "run",
        "gen:tokens",
      ]);
      if (!genRun.ok) {
        tokensGateResult = genRun;
      } else {
        const afterHashes = await hashOutputs();
        const drifted = [...beforeHashes.entries()]
          .filter(([rel, hash]) => afterHashes.get(rel) !== hash)
          .map(([rel]) => rel);
        tokensGateResult = {
          name: "gen:tokens (working-tree zero-drift)",
          ok: drifted.length === 0,
          ms: Math.round(performance.now() - t0),
          output:
            drifted.length === 0
              ? ""
              : `Uncommitted token outputs drifted on re-generation: ${drifted.join(", ")}`,
        };
      }
    }
    if (!tokensGateResult.ok) {
      console.error(
        `✗ ${tokensGateResult.name} (${tokensGateResult.ms}ms)\n${tokensGateResult.output}`,
      );
      return 1;
    }
  }

  const nativeLintBin = resolveNativeBunLintBin();
  const lintLabel = "bun-lint";
  const lintCmd =
    nativeLintBin !== null ? [nativeLintBin, "lint", "--no-script"] : null;
  const workspaceGraph = analyzeWorkspaceGraph(await inspectWorkspaces(ROOT));
  const typecheckSpecs = planTypecheckTasks(changed, {
    hasRootBlast,
    edges: workspaceGraph.edges,
  });

  // Phase 2: Parallel workspace-scoped typecheck + scoped lint + targeted tests
  const tasks: Promise<TaskResult>[] = typecheckSpecs.map((spec) =>
    runTask(spec.name, spec.cmd),
  );

  // Runs on every invocation, not path-triggered: a tracked path that names this machine's home
  // cannot resolve on another checkout, and the check costs a few hundred milliseconds.
  tasks.push(
    runTask("check:home-paths", ["bun", "run", "scripts/check_home_paths.ts"]),
  );
  // A tracked file under an ignored path means the tree ships what it declared it would not.
  tasks.push(
    runTask("check:tracked-ignored", [
      "bun",
      "run",
      "scripts/check_tracked_ignored.ts",
    ]),
  );

  if (lintTargets.length > 0 && lintCmd === null && !values["no-lint"]) {
    console.error(
      `[verify:fast] cannot lint ${lintTargets.length} changed file(s): no native \`bun lint\` binary on Bun ${Bun.version}. Set BUN_LINT_BIN or install bun-canary, or pass --no-lint to skip deliberately.`,
    );
    return 1;
  }

  if (lintTargets.length > 0 && lintCmd !== null && !values["no-lint"]) {
    tasks.push(
      runTask(`${lintLabel} (${lintTargets.length})`, [
        ...lintCmd,
        "--deny-warnings",
        ...lintTargets,
      ]),
    );
  }

  if (values.deep && lintCmd !== null && !values["no-lint"]) {
    tasks.push(
      runTask(`${lintLabel}:type-aware`, [
        ...lintCmd,
        "--type-aware",
        "--deny-warnings",
      ]),
    );
  }

  if (changed.some((f) => f.startsWith("packages/nsh-desk/"))) {
    const { tryResolveNshBinary } = await import("./nsh_desk_cli.ts");
    const nsh = await tryResolveNshBinary(ROOT);
    if (nsh !== null) {
      tasks.push(
        runTask("nsh:check", [
          "bun",
          "run",
          "scripts/nsh_desk_cli.ts",
          "check",
        ]),
      );
    }
  }

  if (
    changed.some(
      (f) =>
        f === "lib/secret_manifest.ts" ||
        f === "types/env.d.ts" ||
        f.includes("secret"),
    )
  ) {
    tasks.push(
      runTask("audit:secrets", ["bun", "run", "scripts/audit_secrets.ts"]),
    );
  }

  if (changedInstallGraph(changed)) {
    tasks.push(
      runTask(
        "install-graph (react pairing, peer ranges)",
        [
          "bun",
          "test",
          "tests/react_version_pairing.test.ts",
          "tests/peer_satisfaction.test.ts",
        ],
        { PRETEST_SKIP: "1" },
      ),
    );
  }

  const addedCode = gitAvailable
    ? gitQuery(["diff", "--cached", "--name-only", "--diff-filter=A"]).lines
    : [];
  if (addedShapeSources(addedCode)) {
    tasks.push(
      runTask("shape catalog", ["bun", "scripts/bun_shapes_catalog.ts"]),
      runTask("shape contracts", [
        "bun",
        "scripts/bun_shape_contracts.ts",
        "--check",
      ]),
    );
  }

  // Smart test step: NEVER run all 520+ suites in the inner loop.
  if (values.shard) {
    tasks.push(
      runTask(
        "test:shard (1/8)",
        ["bun", "test", "--parallel", "--shard=1/8"],
        {
          PRETEST_SKIP: "1",
        },
      ),
    );
  } else if (positionals.length > 0 || !gitAvailable || hasRootBlast) {
    if (inferredTests.length > 0) {
      tasks.push(
        runTask(
          `test:targeted (${inferredTests.length})`,
          ["bun", "test", "--parallel", ...inferredTests],
          { PRETEST_SKIP: "1" },
        ),
      );
    } else if (hasRootBlast) {
      tasks.push(
        runTask(
          "test:shard (1/8)",
          ["bun", "test", "--parallel", "--shard=1/8"],
          { PRETEST_SKIP: "1" },
        ),
      );
    }
  } else if (changed.length > 0) {
    tasks.push(
      runTask("test:changed", ["bun", "test", "--parallel", "--changed"], {
        PRETEST_SKIP: "1",
      }),
    );
  }

  const results = await Promise.all(tasks);

  // `bun test --changed` follows module imports, so a data/fixture/config-only diff selects
  // nothing and looks green. Surface that instead of reporting a silent pass — but only for paths
  // nothing imports (an imported `design/*.ts` or `config/slab.toml` *is* followed).
  const changedTask = results.find((r) => r.name === "test:changed");
  const selectedFiles =
    changedTask === undefined
      ? null
      : parseSelectedFileCount(changedTask.output);

  // Deeper than a warning: run the suites that read unreachable paths, even when `--changed`
  // selected other tests. A mixed diff would otherwise leave its data change unverified.
  const { unreachable, recovery } = planSelectionRecovery(changed, ROOT);
  const readersResult =
    recovery.kind === "run"
      ? await runTask("test:readers", ["bun", "test", ...recovery.files], {
          PRETEST_SKIP: "1",
        })
      : undefined;

  const reportUnreachable = (): void => {
    if (unreachable.length === 0) return;
    if (recovery.kind === "run") {
      const selected =
        selectedFiles === null ? "an unknown number of" : String(selectedFiles);
      console.log(
        `[verify:fast] test:changed selected ${selected} file(s); test:readers ran ${recovery.files.length} suite(s) for paths nothing imports.`,
      );
      return;
    }
    console.error("[verify:fast] the diff touches files no module imports:");
    for (const file of unreachable) {
      const hint = ownerHint(file);
      console.error(`  ${file}${hint === null ? "" : `  → ${hint}`}`);
    }
    console.error(
      recovery.kind === "warn" && recovery.reason === "too-many"
        ? `  ${recovery.count} suites read these paths; too many to run here (cap ${MAX_READER_FILES}) — run one explicitly.`
        : "  --changed cannot see filesystem reads; run the owner explicitly.",
    );
  };

  const all = [
    ...(fmtResult ? [fmtResult] : []),
    ...(tokensGateResult ? [tokensGateResult] : []),
    ...results,
    ...(readersResult ? [readersResult] : []),
  ];
  const failures = all.filter((r) => !r.ok);
  const totalSec = ((performance.now() - started) / 1000).toFixed(2);

  const summary = all
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.name} ${r.ms}ms`)
    .join(" · ");

  if (failures.length === 0) {
    console.log(`${summary} — OK in ${totalSec}s`);
    reportUnreachable();
    return 0;
  }

  console.error(`${summary} — FAILED (${failures.length}) in ${totalSec}s\n`);
  reportUnreachable();
  for (const f of failures) {
    console.error(`── ✗ ${f.name} (${f.ms}ms) ──\n${f.output}\n`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
