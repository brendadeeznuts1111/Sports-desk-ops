#!/usr/bin/env bun
/**
 * @file scripts/bun_lint.ts
 * @description Read-only native `bun lint` entrypoint (`bun lint --no-script --type-aware`).
 *
 * Driven by `bunfig.toml` `[lint]` (both standard and type-aware rules in one pass).
 * Run: bun run lint:bun [files ...]
 */

import { resolveNativeBunLintBin } from "./lint_native.ts";

export interface LintCommand {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly native: boolean;
}

/** Native `bun lint` pass reading `bunfig.toml` `[lint]` (standard + type-aware). */
export function nativeLintCommands(
  bin: string,
  files: readonly string[],
): readonly LintCommand[] {
  return Object.freeze([
    Object.freeze({
      bin,
      native: true,
      argv: Object.freeze([
        "lint",
        "--no-script",
        "--type-aware",
        "--deny-warnings",
        ...files,
      ]),
    }),
  ]);
}

if (import.meta.main) {
  const files = Bun.argv.slice(2);
  const nativeBin = resolveNativeBunLintBin();
  if (nativeBin === null) {
    console.error(
      `bun_lint: no native \`bun lint\` binary found (current: Bun ${Bun.version}; requires Bun canary / 1.4.5+ or BUN_LINT_BIN).`,
    );
    process.exit(2);
  }
  for (const command of nativeLintCommands(nativeBin, files)) {
    const result = Bun.spawnSync([command.bin, ...command.argv], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode ?? 1);
    }
  }
}
