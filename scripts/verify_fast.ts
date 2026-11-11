#!/usr/bin/env bun
/**
 * @file scripts/verify_fast.ts
 * @description Sub-2s parallel inner-loop verification for rapid local development.
 *
 * Replaces 15+ sequential gate commands and 60s+ full-repo test sweeps with:
 *   1. Scoped `bun fmt` on changed files (~30ms; `--check` for read-only)
 *   2. Parallel `Promise.all` execution of:
 *      - `bun check --no-script -p tsconfig.json` + `src/dashboard/tsconfig.json` (.ts + .tsx)
 *      - `oxlint --deny-warnings` scoped to changed JS/TS/TSX files (`--deep` adds `--type-aware`)
 *      - Path-triggered gates ONLY when relevant directories changed
 *      - Targeted tests: `bun test --parallel --changed` (or head shard `--shard=1/8` + explicit
 *        changed/matched `*.test.ts` when root configs changed or inside a sandboxed worktree).
 *
 * Usage:
 *   bun run verify:fast                      # auto-detect changed files (git diff or mtime fallback)
 *   bun run verify:fast lib/foo.ts           # verify specific file(s) + matching tests
 *   bun run verify:fast --check              # read-only format check
 *   bun run verify:fast --shard              # force head shard (1/8)
 *   bun run verify:fast --deep               # include type-aware oxlint pass
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const ROOT = path.resolve(import.meta.dir, "..");

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    check: { type: "boolean", default: false },
    shard: { type: "boolean", default: false },
    deep: { type: "boolean", default: false },
    base: { type: "string" },
    "since-min": { type: "string", default: "45" },
  },
  allowPositionals: true,
  strict: true,
});

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
      // ignore transient files
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

const probeGit = gitQuery(["rev-parse", "--is-inside-work-tree"]);
const gitAvailable = probeGit.ok;

function collectChangedFiles(): string[] {
  if (positionals.length > 0) {
    return positionals.filter((f) => existsSync(path.join(ROOT, f)));
  }
  if (!gitAvailable) {
    return collectRecentByMtime(Number(values["since-min"]) || 45);
  }
  const set = new Set<string>();
  for (const f of gitQuery(["diff", "--name-only", "HEAD"]).lines) set.add(f);
  for (const f of gitQuery(["diff", "--name-only", "--cached"]).lines)
    set.add(f);
  for (const f of gitQuery(["ls-files", "--others", "--exclude-standard"])
    .lines) {
    set.add(f);
  }
  if (set.size === 0 || values.base) {
    const ref = values.base ?? "origin/main...HEAD";
    for (const f of gitQuery(["diff", "--name-only", ref]).lines) set.add(f);
  }
  return [...set].filter((f) => {
    const full = path.join(ROOT, f);
    return existsSync(full) && !lstatSync(full).isSymbolicLink();
  });
}

function inferTestsForFiles(files: string[]): string[] {
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
    const stem = path
      .basename(f)
      .replace(/\.(types\.)?(ts|tsx|js|mjs|toml|json)$/, "");
    if (
      !stem ||
      stem === "index" ||
      stem === "package" ||
      stem === "tsconfig"
    ) {
      continue;
    }
    const candidates = [`tests/${stem}.test.ts`, `tests/${stem}_toml.test.ts`];
    if (f.startsWith("packages/nsh-desk/")) {
      candidates.push("tests/nsh_desk_contract.test.ts");
    }
    if (/\.(ts|tsx)$/.test(f)) {
      candidates.push(f.replace(/\.(ts|tsx)$/, ".test.$1"));
    }
    for (const c of candidates) {
      if (
        existsSync(path.join(ROOT, c)) &&
        /\.test\.(ts|tsx|js|mjs)$/.test(c) &&
        !c.includes("market_index")
      ) {
        tests.add(c);
      }
    }
  }
  return [...tests];
}

interface TaskResult {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
}

async function runTask(
  name: string,
  cmd: string[],
  extraEnv?: Record<string, string>,
): Promise<TaskResult> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
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

const started = performance.now();
const changed = collectChangedFiles();

const FORMAT_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|json5|md|html|css|yml|yaml|toml)$/;
const LINT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ROOT_BLAST_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "bun.lock",
  "bunfig.toml",
]);

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
    process.exit(1);
  }
}

let tokensGateResult: TaskResult | null = null;
if (
  gitAvailable &&
  changed.some(
    (f) => f.startsWith("design/") || f.startsWith("lib/gen_tokens/"),
  )
) {
  tokensGateResult = await runTask("gen:tokens:gate", [
    "bun",
    "run",
    "scripts/gen_tokens_gate.ts",
  ]);
  if (!tokensGateResult.ok) {
    console.error(
      `✗ ${tokensGateResult.name} (${tokensGateResult.ms}ms)\n${tokensGateResult.output}`,
    );
    process.exit(1);
  }
}

function resolveOxlintBin(): string | null {
  const localBin = path.join(ROOT, "node_modules", ".bin", "oxlint");
  if (existsSync(localBin)) return localBin;
  return Bun.which("oxlint", { PATH: Bun.env.PATH ?? "" });
}

const oxlintBin = resolveOxlintBin();

// Phase 2: Parallel typecheck + UI typecheck + scoped lint + targeted tests
const tasks: Promise<TaskResult>[] = [
  runTask("typecheck", ["bun", "check", "--no-script", "-p", "tsconfig.json"]),
  runTask("typecheck:ui", [
    "bun",
    "check",
    "--no-script",
    "-p",
    "src/dashboard/tsconfig.json",
  ]),
  runTask("ensure:tsconfig", ["bun", "run", "scripts/ensure_deep_tsconfig.ts"]),
];

if (lintTargets.length > 0 && oxlintBin !== null) {
  tasks.push(
    runTask(`oxlint (${lintTargets.length})`, [
      oxlintBin,
      "--deny-warnings",
      ...lintTargets,
    ]),
  );
}

if (values.deep && oxlintBin !== null) {
  tasks.push(
    runTask("oxlint:type-aware", [
      oxlintBin,
      "--type-aware",
      "-c",
      ".oxlintrc.type-aware.json",
      "--deny-warnings",
    ]),
  );
}

if (changed.some((f) => f.startsWith("packages/nsh-desk/"))) {
  const { tryResolveNshBinary } = await import("./nsh_desk_cli.ts");
  const nsh = await tryResolveNshBinary(ROOT);
  if (nsh !== null) {
    tasks.push(
      runTask("nsh:check", ["bun", "run", "scripts/nsh_desk_cli.ts", "check"]),
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

// Smart test step: NEVER run all 520+ suites in the inner loop.
if (values.shard) {
  tasks.push(
    runTask("test:shard (1/8)", ["bun", "test", "--parallel", "--shard=1/8"], {
      PRETEST_SKIP: "1",
    }),
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
const all = [
  ...(fmtResult ? [fmtResult] : []),
  ...(tokensGateResult ? [tokensGateResult] : []),
  ...results,
];
const failures = all.filter((r) => !r.ok);
const totalSec = ((performance.now() - started) / 1000).toFixed(2);

const summary = all
  .map((r) => `${r.ok ? "✓" : "✗"} ${r.name} ${r.ms}ms`)
  .join(" · ");

if (failures.length === 0) {
  console.log(`${summary} — OK in ${totalSec}s`);
  process.exit(0);
}

console.error(`${summary} — FAILED (${failures.length}) in ${totalSec}s\n`);
for (const f of failures) {
  console.error(`── ✗ ${f.name} (${f.ms}ms) ──\n${f.output}\n`);
}
process.exit(1);
