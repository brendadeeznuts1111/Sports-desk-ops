#!/usr/bin/env bun
/**
 * @file dx_scripts.ts
 * `./bin/dx scripts [filter] [--json]` — groups `package.json` scripts by their `prefix:`
 * and lists the commands behind a name filter.
 *
 *   ./bin/dx scripts            prefixes with counts and names (largest group first)
 *   ./bin/dx scripts schema     every script whose name contains "schema", with its command
 *   ./bin/dx scripts --json     machine-readable { prefix: { name: command } }
 */
import { parseArgs } from "node:util";

export type ScriptMap = Readonly<Record<string, string>>;

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

function renderGrouped(scripts: ScriptMap): string {
  const lines: string[] = [];
  for (const [prefix, names] of groupScripts(scripts)) {
    lines.push(`${prefix} (${names.length})`);
    lines.push(`  ${names.join("  ")}`);
  }
  lines.push("");
  lines.push(
    `${Object.keys(scripts).length} scripts. Filter: ./bin/dx scripts <substring> shows the commands.`,
  );
  return lines.join("\n");
}

function renderFiltered(matches: [string, string][]): string {
  const width = Math.max(0, ...matches.map(([name]) => name.length));
  return matches
    .map(([name, command]) => `${name.padEnd(width)}  ${command}`)
    .join("\n");
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log("usage: ./bin/dx scripts [substring] [--json]");
    return 0;
  }
  const manifest: unknown = await Bun.file(
    `${import.meta.dir}/../package.json`,
  ).json();
  const scripts: ScriptMap =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? (manifest.scripts as ScriptMap)
      : {};
  const needle = positionals[0];

  if (needle !== undefined) {
    const matches = filterScripts(scripts, needle);
    if (matches.length === 0) {
      console.error(`dx scripts: no script name contains "${needle}"`);
      return 1;
    }
    if (values.json)
      console.log(JSON.stringify(Object.fromEntries(matches), null, 2));
    else console.log(renderFiltered(matches));
    return 0;
  }

  if (values.json) {
    const grouped: Record<string, Record<string, string>> = {};
    for (const [prefix, names] of groupScripts(scripts)) {
      grouped[prefix] = Object.fromEntries(
        names.map((name) => [name, scripts[name] ?? ""]),
      );
    }
    console.log(JSON.stringify(grouped, null, 2));
  } else {
    console.log(renderGrouped(scripts));
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
