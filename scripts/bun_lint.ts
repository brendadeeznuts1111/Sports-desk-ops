#!/usr/bin/env bun
/**
 * @file scripts/bun_lint.ts
 * @description `bun lint` entrypoint that refuses to rewrite files on 1.4.4.
 *
 * Native `bun lint` (`--no-script`, `--type-aware`, `[lint]` config) exists from 1.4.5. On the
 * pinned 1.4.4, a bare `bun lint` resolves to the package `"lint"` script (`oxlint --fix`), and
 * `--no-script` is forwarded to oxlint, so it rewrites files. This wrapper reuses the canary
 * resolver in `scripts/lint_native.ts`: when a native binary is available it runs the native
 * linter, otherwise it runs the repo's two read-only oxlint passes.
 *
 * Run: bun run lint:bun [files ...]
 */

import { resolveNativeBunLintBin } from "./lint_native.ts";

export interface LintCommand {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly native: boolean;
}

/** Read-only oxlint passes, equivalent to `lint:check` but scoped to the given files. */
export function oxlintCommands(
  files: readonly string[],
): readonly LintCommand[] {
  return Object.freeze([
    Object.freeze({
      bin: process.execPath,
      native: false,
      argv: Object.freeze([
        "--bun",
        "run",
        "oxlint",
        "--deny-warnings",
        ...files,
      ]),
    }),
    Object.freeze({
      bin: process.execPath,
      native: false,
      argv: Object.freeze([
        "--bun",
        "run",
        "oxlint",
        "--type-aware",
        "-c",
        ".oxlintrc.type-aware.json",
        "--deny-warnings",
        ...files,
      ]),
    }),
  ]);
}

/** Native `bun lint` passes, mirroring `lint:native` + `lint:native:type-aware`. */
export function nativeLintCommands(
  bin: string,
  files: readonly string[],
): readonly LintCommand[] {
  return Object.freeze([
    Object.freeze({
      bin,
      native: true,
      argv: Object.freeze(["lint", "--no-script", "--deny-warnings", ...files]),
    }),
    Object.freeze({
      bin,
      native: true,
      argv: Object.freeze([
        "lint",
        "--no-script",
        "--type-aware",
        "-c",
        ".oxlintrc.type-aware.json",
        "--deny-warnings",
        ...files,
      ]),
    }),
  ]);
}

if (import.meta.main) {
  const files = Bun.argv.slice(2);
  const nativeBin = resolveNativeBunLintBin();
  const commands =
    nativeBin === null
      ? oxlintCommands(files)
      : nativeLintCommands(nativeBin, files);
  if (nativeBin === null) {
    console.error(
      `bun_lint: no native \`bun lint\` binary on Bun ${Bun.version}; running oxlint read-only ` +
        "(a bare `bun lint` would pass oxlint --fix here).",
    );
  }
  for (const command of commands) {
    const result = Bun.spawnSync([command.bin, ...command.argv], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode ?? 1);
    }
  }
}
