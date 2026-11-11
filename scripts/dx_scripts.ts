#!/usr/bin/env bun
/**
 * @file dx_scripts.ts
 * `./bin/dx scripts [filter] [--bins] [--json] [--yaml]` — groups `package.json` scripts by their
 * `prefix:` or lists the unified `bun x <bin>` ↔ `bun run <script>` workspace CLI catalog.
 *
 *   ./bin/dx scripts            prefixes with counts and names (largest group first)
 *   ./bin/dx scripts schema     every script whose name contains "schema", with its command
 *   ./bin/dx scripts --bins     unified bun x <bin> ↔ bun run <script> ↔ target CLI catalog
 *   ./bin/dx scripts --json     machine-readable JSON
 *   ./bin/dx scripts --yaml     machine-readable YAML via Bun.YAML.stringify
 */
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type ScriptMap = Readonly<Record<string, string>>;
export type BinMap = Readonly<Record<string, string>>;

export interface BinCatalogRow {
  readonly bin: string;
  readonly bunx: string;
  readonly script: string | null;
  readonly target: string;
  readonly workspaceLinked: boolean;
}

/** The part of a script name before the first `:`; unprefixed names group under "(none)". */
export function scriptPrefix(name: string): string {
  const colon = name.indexOf(":");
  return colon > 0 ? name.slice(0, colon) : "(none)";
}

export function groupScripts(scripts: ScriptMap): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(scripts).sort()) {
    const prefix = scriptPrefix(name);
    const bucket = groups.get(prefix);
    if (bucket) bucket.push(name);
    else groups.set(prefix, [name]);
  }
  return new Map(
    [...groups].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    ),
  );
}

export function filterScripts(
  scripts: ScriptMap,
  needle: string,
): [string, string][] {
  const lower = needle.toLowerCase();
  return Object.entries(scripts)
    .filter(([name]) => name.toLowerCase().includes(lower))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function findMatchingScript(scripts: ScriptMap, target: string): string | null {
  const normalized = target.replace(/^\.\//, "");
  // Prefer short exact invocations (`bun run <target>` or `./<target>` without subcommand args)
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
    if (fallback === null && trimmed.includes(normalized)) {
      fallback = name;
    }
  }
  return fallback;
}

export function collectBinCatalog(
  root: string,
  bins: BinMap,
  scripts: ScriptMap,
  needle?: string,
): BinCatalogRow[] {
  const lower = needle?.toLowerCase();
  return Object.entries(bins)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bin, target]): BinCatalogRow => {
      const script = findMatchingScript(scripts, target);
      return {
        bin,
        bunx: `bun x ${bin}`,
        script: script === null ? null : `bun run ${script}`,
        target,
        workspaceLinked: isSymlink(join(root, "node_modules", ".bin", bin)),
      };
    })
    .filter(
      (row) =>
        lower === undefined ||
        row.bin.toLowerCase().includes(lower) ||
        row.target.toLowerCase().includes(lower) ||
        (row.script?.toLowerCase().includes(lower) ?? false),
    );
}

function renderGrouped(scripts: ScriptMap): string {
  const lines: string[] = [];
  for (const [prefix, names] of groupScripts(scripts)) {
    lines.push(`${prefix} (${names.length})`);
    lines.push(`  ${names.join("  ")}`);
  }
  lines.push("");
  lines.push(
    `${Object.keys(scripts).length} scripts. Filter: ./bin/dx scripts <substring> (or --bins for bun x CLIs).`,
  );
  return lines.join("\n");
}

function renderFiltered(matches: [string, string][]): string {
  const width = Math.max(0, ...matches.map(([name]) => name.length));
  return matches
    .map(([name, command]) => `${name.padEnd(width)}  ${command}`)
    .join("\n");
}

function renderBins(rows: readonly BinCatalogRow[]): string {
  const tableRows = rows.map((row) => ({
    bunx: row.bunx,
    script: row.script ?? "—",
    target: row.target,
    linked: row.workspaceLinked ? "yes" : "no",
  }));
  const linkedCount = rows.filter((r) => r.workspaceLinked).length;
  return [
    Bun.inspect.table(tableRows).trimEnd(),
    `${rows.length} CLI bins (${linkedCount}/${rows.length} linked in node_modules/.bin).`,
  ].join("\n");
}

function emitStructured(payload: unknown, asYaml: boolean): void {
  if (asYaml) {
    console.log(Bun.YAML.stringify(payload, null, 2).trimEnd());
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      bins: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      yaml: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      "usage: ./bin/dx scripts [substring] [--bins] [--json | --yaml]",
    );
    return 0;
  }
  const root = resolve(import.meta.dir, "..");
  const manifest: unknown = await Bun.file(join(root, "package.json")).json();
  const scripts: ScriptMap =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? (manifest.scripts as ScriptMap)
      : {};
  const bins: BinMap =
    typeof manifest === "object" && manifest !== null && "bin" in manifest
      ? (manifest.bin as BinMap)
      : {};
  const needle = positionals[0];
  const structured = Boolean(values.json || values.yaml);

  if (values.bins) {
    const rows = collectBinCatalog(root, bins, scripts, needle);
    if (rows.length === 0) {
      console.error(`dx scripts --bins: no bin matches "${needle ?? ""}"`);
      return 1;
    }
    if (structured) {
      emitStructured({ count: rows.length, bins: rows }, Boolean(values.yaml));
    } else {
      console.log(renderBins(rows));
    }
    return 0;
  }

  if (needle !== undefined) {
    const matches = filterScripts(scripts, needle);
    if (matches.length === 0) {
      console.error(`dx scripts: no script name contains "${needle}"`);
      return 1;
    }
    if (structured)
      emitStructured(Object.fromEntries(matches), Boolean(values.yaml));
    else console.log(renderFiltered(matches));
    return 0;
  }

  if (structured) {
    const grouped: Record<string, Record<string, string>> = {};
    for (const [prefix, names] of groupScripts(scripts)) {
      grouped[prefix] = Object.fromEntries(
        names.map((name) => [name, scripts[name] ?? ""]),
      );
    }
    emitStructured(grouped, Boolean(values.yaml));
  } else {
    console.log(renderGrouped(scripts));
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
