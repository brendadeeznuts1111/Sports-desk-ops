/**
 * @file scripts/bun_globals_map_summaries.ts
 * @description CLI for auditing or patching the inherited-JSDoc summaries in
 * `docs/bun-globals-map.json` against the pinned runtime and the installed `bun-types` graph.
 *
 * This is a thin wrapper: flag parsing, declaration resolution (fail closed), the real `bun fmt`
 * formatter, and reporting. The writer — provenance migration, metadata rewriting, rollback — lives
 * in `lib/bun_globals_map_apply.ts` so it can be tested without the repository or a network.
 *
 *   bun scripts/bun_globals_map_summaries.ts            # report; exit 1 while a defect remains
 *   bun scripts/bun_globals_map_summaries.ts --check    # explicit read-only alias of the report
 *   bun scripts/bun_globals_map_summaries.ts --apply    # clear defective summaries, record metadata
 *   bun scripts/bun_globals_map_summaries.ts --json     # machine-readable report only
 *
 * Exit codes: 0 clean / patched, 1 defects remain or a rewrite failed and was rolled back,
 * 2 usage error, 3 bun-types declarations unavailable (fail closed).
 */
import { join } from "node:path";
import { applySummaryFixes } from "../lib/bun_globals_map_apply.ts";
import { loadBunTypesDeclarations } from "../lib/bun_globals_map_summaries.ts";

const ROOT = join(import.meta.dir, "..");
const ROWS_PATH = join(ROOT, "docs/bun-globals-map.json");
const META_PATH = join(ROOT, "docs/bun-globals-map.meta.json");
const KNOWN_FLAGS = new Set(["--apply", "--check", "--json"]);

const argv = Bun.argv.slice(2);
const unknown = argv.filter((flag) => !KNOWN_FLAGS.has(flag));
if (unknown.length > 0) {
  console.error(`unknown flag: ${unknown.join(", ")}`);
  process.exit(2);
}
const apply = argv.includes("--apply");
const jsonOnly = argv.includes("--json");

/** Real formatter: the running binary, repository cwd, and a reported failure. */
function formatArtifacts(paths: readonly string[]): boolean {
  try {
    const formatted = Bun.spawnSync([process.execPath, "fmt", ...paths], {
      cwd: ROOT,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (formatted.exitCode !== 0) {
      console.error(
        `bun fmt failed on the patched artifacts (exit ${formatted.exitCode})`,
      );
    }
    return formatted.exitCode === 0;
  } catch (error) {
    console.error(
      `bun fmt could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

const declarations = loadBunTypesDeclarations(ROOT);
if (declarations === null) {
  console.error(
    "bun-types declarations unavailable; refusing to validate summaries (run bun install)",
  );
  process.exit(3);
}

const result = await applySummaryFixes({
  rowsPath: ROWS_PATH,
  metaPath: META_PATH,
  declarations,
  apply,
  format: formatArtifacts,
});

if (result.restored) {
  console.error("artifacts restored unchanged");
  process.exitCode = 1;
}

const report = {
  runtime: `${Bun.version}+${Bun.revision.slice(0, 8)}`,
  bunTypes: {
    package: declarations.package,
    files: declarations.relativeFiles,
  },
  path: ROWS_PATH,
  rows: result.rows.length,
  applied: apply ? result.applied : false,
  wrote: result.wrote,
  formatted: result.formatted,
  restored: result.restored,
  found: {
    falsified: result.falsified.length,
    inherited: result.inherited.length,
  },
  falsified: result.falsified,
  inherited: result.inherited,
  remaining: result.remaining,
  legacyRecords: result.legacyRecords,
};

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `runtime ${report.runtime} · ${report.rows} rows · ${declarations.package} (${declarations.relativeFiles.length} files)`,
  );
  console.log(
    `  types-only falsified: ${report.found.falsified} · inherited from base: ${report.found.inherited}${apply ? " · applied" : ""}`,
  );
  for (const claim of [...result.falsified, ...result.inherited]) {
    console.log(
      `  ${claim.symbol.padEnd(28)} ${claim.reason.padEnd(22)} ${claim.detail.padEnd(14)} "${claim.upstreamSummary.slice(0, 48)}"`,
    );
  }
  if (report.remaining === 0) console.log("  none");
  if (report.legacyRecords > 0) {
    console.log(
      `  ${report.legacyRecords} legacy provenance record(s) need normalization`,
    );
  }
  if (report.wrote) console.log("  artifacts rewritten");
}

if (!apply && (report.remaining > 0 || report.legacyRecords > 0)) {
  process.exitCode = 1;
}
