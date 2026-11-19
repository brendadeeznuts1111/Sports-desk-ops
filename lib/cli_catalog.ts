/**
 * @file lib/cli_catalog.ts
 * @description Derive the `bun x` CLI catalog from root `package.json` instead of hand-maintaining it.
 *
 * Three artifacts used to repeat the same 23 rows by hand: `cli/README.md`'s table, the
 * `REQUIRED_CLI_BINS` array in `scripts/verify_cli_bins.ts`, and several hardcoded counts in
 * tests. This module is the single derivation: bin names and targets come from the root `bin`
 * map, the `bun run` column from the `scripts` map, and the one-line description from the
 * target's own header comment.
 */

import { join } from "node:path";
import { clipDisplay } from "./terminal_format.ts";

export const CLI_README_BEGIN =
  "<!-- BEGIN GENERATED BUN X CATALOG (run bun run cli:readme) -->";
export const CLI_README_END = "<!-- END GENERATED BUN X CATALOG -->";

export interface CliCatalogRow {
  readonly bin: string;
  readonly script: string | null;
  readonly target: string;
  readonly description: string | null;
}

export interface RootCliManifest {
  readonly bins: Readonly<Record<string, string>>;
  readonly scripts: Readonly<Record<string, string>>;
}

/** Read the root `bin` and `scripts` maps; the only inputs the catalog needs. */
export async function readRootCliManifest(
  root: string,
): Promise<RootCliManifest> {
  const pkg = (await Bun.file(join(root, "package.json")).json()) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  return { bins: pkg.bin ?? {}, scripts: pkg.scripts ?? {} };
}

/** Every declared bin name, sorted. Used by the verifier and tests instead of a literal list. */
export async function requiredCliBins(
  root: string,
): Promise<readonly string[]> {
  return Object.keys((await readRootCliManifest(root)).bins).sort();
}

/** Match a `bin` target to the script that invokes it, preferring an exact invocation. */
export function findMatchingScript(
  scripts: Readonly<Record<string, string>>,
  target: string,
): string | null {
  const normalized = target.replace(/^\.\//, "");
  let fallback: string | null = null;
  for (const [name, cmd] of Object.entries(scripts)) {
    const trimmed = cmd.trim();
    if (
      trimmed === `bun run ${normalized}` ||
      trimmed === `bun ${normalized}` ||
      trimmed === `./${normalized}`
    ) {
      return name;
    }
    if (fallback === null && trimmed.includes(normalized)) fallback = name;
  }
  return fallback;
}

function cleanDescription(value: string): string | null {
  const clean = value
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .trim();
  if (clean === "") return null;
  // 120 display columns; `slice(0, 117)` measured code units and produced 118 characters.
  return clipDisplay(clean, 120);
}

/**
 * One-line description from the target's header comment: `@description` first, then the first
 * prose line of a `/** *\/` block, then the first non-rule `#` comment (shell shims).
 */
export function extractBinDescription(text: string): string | null {
  const lines = text.split("\n");
  const descriptionLine = lines.find((line) =>
    /^\s*\*\s*@description\s+/.test(line),
  );
  if (descriptionLine !== undefined) {
    return cleanDescription(
      descriptionLine.replace(/^\s*\*\s*@description\s+/, ""),
    );
  }

  let inBlock = false;
  for (const line of lines) {
    if (/^\s*\/\*\*/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/\*\//.test(line)) break;
      const prose = /^\s*\*\s*(.*)$/.exec(line)?.[1]?.trim();
      if (prose !== undefined && prose !== "" && !prose.startsWith("@")) {
        return cleanDescription(prose);
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith("#!")) continue;
    const comment = /^\s*#\s*(.*)$/.exec(line)?.[1]?.trim();
    if (comment === undefined || comment === "") continue;
    if (/^[=\-#*_]{3,}/.test(comment)) continue;
    return cleanDescription(comment);
  }
  return null;
}

/** Derive one row per declared bin, sorted by bin name. */
export async function readCliCatalog(
  root: string,
): Promise<readonly CliCatalogRow[]> {
  const { bins, scripts } = await readRootCliManifest(root);
  const entries = Object.entries(bins).sort(([a], [b]) => a.localeCompare(b));
  return Promise.all(
    entries.map(async ([bin, target]): Promise<CliCatalogRow> => {
      let description: string | null = null;
      try {
        description = extractBinDescription(
          await Bun.file(join(root, target)).text(),
        );
      } catch {
        // signal-honesty: intentional-missing-bin-target-description-omitted
        description = null;
      }
      return {
        bin,
        target,
        script: findMatchingScript(scripts, target),
        description,
      };
    }),
  );
}

/** Markdown table plus the derived "all N mappings" line. */
export function renderCliCatalogMarkdown(
  rows: readonly CliCatalogRow[],
): string {
  const lines = [
    "<!-- prettier-ignore -->",
    "| `bun x` Bin | `bun run` Script | Target | Description |",
    "| :-- | :-- | :-- | :-- |",
  ];
  for (const row of rows) {
    const script = row.script === null ? "—" : `\`bun run ${row.script}\``;
    lines.push(
      `| \`bun x ${row.bin}\` | ${script} | \`${row.target}\` | ${row.description ?? "—"} |`,
    );
  }
  lines.push(
    "",
    `Run \`bun run cli:bins\` (or \`./bin/dx scripts --bins [--json | --yaml]\`) to inspect all ${rows.length} workspace CLI mappings and verify \`node_modules/.bin/\` symlink status.`,
  );
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace the marker-delimited catalog in a README; markers must appear exactly once. */
export async function renderCliReadmeCatalog(
  root: string,
  current: string,
): Promise<string> {
  const pattern = new RegExp(
    `${escapeRegExp(CLI_README_BEGIN)}[\\s\\S]*?${escapeRegExp(CLI_README_END)}`,
  );
  if ((current.match(pattern)?.length ?? 0) !== 1) {
    throw new Error(
      "ERR_CLI_README_MARKERS: expected one generated catalog block",
    );
  }
  const rows = await readCliCatalog(root);
  const body = renderCliCatalogMarkdown(rows);
  return current.replace(
    pattern,
    `${CLI_README_BEGIN}\n${body}\n${CLI_README_END}`,
  );
}
