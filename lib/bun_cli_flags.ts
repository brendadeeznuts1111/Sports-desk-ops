/**
 * The pinned runtime's CLI surface as data: which `bun` flags exist in 1.4.4, and which flags our
 * package scripts ask Bun itself to parse (before the entrypoint). A flag that only the script
 * receives (after the file) is not Bun's flag and is not checked here.
 */

import { spawnSync } from "bun";

/** Flags our tooling relies on; a runtime upgrade/downgrade must keep them. */
export const REQUIRED_BUN_CLI_FLAGS = [
  "--eval",
  "--print",
  "--port",
  "--env-file",
  "--no-env-file",
  "--no-orphans",
] as const;

export interface BunCliSurface {
  readonly version: string;
  readonly helpText: string;
  /** Long flags declared in `bun --help`. */
  readonly flags: ReadonlySet<string>;
}

/**
 * One flag per declaration line, in either `-x, --long=<val>` or `--long=<val>` form. A line only
 * counts when a description column follows it: prose examples that merely start with `--` do not.
 */
export function parseBunHelpFlags(helpText: string): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const line of helpText.split("\n")) {
    const match = line.match(
      /^\s{2,}(?:-\w,\s*)?(--[a-z0-9][a-z0-9-]*)(?:=\S+)?\s{2,}\S/i,
    );
    if (match?.[1] !== undefined) flags.add(match[1]);
  }
  return flags;
}

/** Flags declared by one Bun help invocation, e.g. `readBunHelpFlags(["test", "--help"])`. */
export function readBunHelpFlags(
  args: readonly string[],
  bunPath = "bun",
): ReadonlySet<string> {
  const result = spawnSync([bunPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${bunPath} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().slice(0, 200)}`,
    );
  }
  return parseBunHelpFlags(result.stdout.toString());
}

/** Read the runtime's own help once; never hand-maintain the flag list. */
export function readBunCliSurface(bunPath = "bun"): BunCliSurface {
  const result = spawnSync([bunPath, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${bunPath} --help exited ${result.exitCode}: ${result.stderr.toString().slice(0, 200)}`,
    );
  }
  const helpText = result.stdout.toString();
  return { version: Bun.version, helpText, flags: parseBunHelpFlags(helpText) };
}

export function missingRequiredFlags(
  surface: BunCliSurface,
): readonly (typeof REQUIRED_BUN_CLI_FLAGS)[number][] {
  return REQUIRED_BUN_CLI_FLAGS.filter((flag) => !surface.flags.has(flag));
}

/**
 * Bun flags a package script asks the runtime to parse: the run of `--flags` right after `bun`,
 * before an entrypoint/command. `bun run script --x` passes `--x` to the script, so it is skipped.
 */
export function bunFlagsInScripts(
  scripts: Readonly<Record<string, string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const perScript = new Map<string, Set<string>>();
  for (const [name, command] of Object.entries(scripts)) {
    const flags = new Set<string>();
    for (const match of command.matchAll(
      /\bbun\s+((?:--[a-z0-9-]+(?:=\S*)?\s+)*)/gi,
    )) {
      const run = match[1] ?? "";
      for (const flag of run.matchAll(/--[a-z0-9-]+/gi)) {
        flags.add(flag[0]);
      }
    }
    if (flags.size > 0) perScript.set(name, flags);
  }
  return perScript;
}

/** Script flags the pinned runtime does not declare (a broken script would fail at startup). */
export function unsupportedScriptFlags(
  scripts: Readonly<Record<string, string>>,
  surface: BunCliSurface,
): readonly string[] {
  const unsupported = new Set<string>();
  for (const flags of bunFlagsInScripts(scripts).values()) {
    for (const flag of flags) {
      if (!surface.flags.has(flag)) unsupported.add(flag);
    }
  }
  return [...unsupported].sort();
}
