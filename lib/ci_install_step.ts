/**
 * @file ci_install_step.ts
 * @description Whether a CI `run` step installs dependencies, across both spellings this repo uses.
 *
 * The workflows install with `bun ci --no-env-file`; `bun install --frozen-lockfile` is the
 * equivalent form the README keeps for a local clone, and what the workflow used before it moved
 * to `bun ci`. `bun run ci:local` gates the install steps behind `--install`, so the predicate has
 * to recognize both: when it matched only `bun install`, the rename to `bun ci` silently made every
 * plain replay install dependencies.
 */

/** True when `run` is exactly `command`, or `command` followed by arguments. */
function isCommand(run: string, command: string): boolean {
  return run === command || run.startsWith(`${command} `);
}

/**
 * True when a workflow `run` step installs dependencies: `bun install …` or `bun ci …`.
 *
 * The whole command is matched, so `bun run ci:local`, `bun test`, and `npm ci` stay run steps.
 */
export function isInstallStep(run: string): boolean {
  const command = run.trim();
  return isCommand(command, "bun install") || isCommand(command, "bun ci");
}
