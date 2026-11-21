/**
 * @file packages/sportsdesk-ops/src/lib/preflight_guard.ts
 * @description Preflight guard for `--env-file` / `--no-env-file` on a compiled term-profile
 * binary. Enforces two independent rules:
 *
 *   1. Name discipline — a `--env-file` basename must be one of ALLOWED_ENV_FILE_BASENAMES.
 *   2. Provenance discipline — the file must exist, must not be a symlink, and must resolve
 *      inside one of the allowed roots (default: process.cwd()).
 *
 * Why both: the basename check alone accepts `/tmp/attacker/r2.env`, which is an
 * uncontrolled variable set with a blessed name — exactly the token-injection surface this
 * guard exists to close.
 *
 * Cross-source rule: `console` sources are validated independently. A `--no-env-file` in
 * `process.execArgv` never authorises an `--env-file` arriving via `BUN_OPTIONS`, and the
 * combined `--env-file` count must stay <= 1.
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

export const BLEED_ERR = "ERR_CF_TOKEN_BLEED_10000";

export const ALLOWED_ENV_FILE_BASENAMES: ReadonlySet<string> = new Set([
  "r2.env",
  "pages.env",
]);

export interface EnvFileGuardOptions {
  /** Directories a resolved `--env-file` path may live in. Defaults to [process.cwd()]. */
  readonly roots?: readonly string[];
}

interface SourceScan {
  readonly envFileCount: number;
  readonly hasNoEnvFile: boolean;
  readonly paths: readonly string[];
}

/**
 * Rejects malformed paths and any basename outside the allowlist.
 *
 * Windows separators are normalised before basename extraction so the result is the same on
 * every platform; a path whose segments traverse out of the allowed roots is caught later by
 * the realpath check, not here.
 */
function assertAllowedEnvFileBasename(
  rawPath: string,
  sourceLabel: string,
): void {
  if (
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    rawPath.endsWith("/") ||
    rawPath.endsWith("\\")
  ) {
    throw new Error(
      `${BLEED_ERR}: invalid --env-file path "${rawPath}" in ${sourceLabel}`,
    );
  }

  const fileBasename = basename(rawPath.replaceAll("\\", "/"));
  if (!ALLOWED_ENV_FILE_BASENAMES.has(fileBasename)) {
    throw new Error(
      `${BLEED_ERR}: disallowed --env-file basename "${fileBasename}" in ${sourceLabel} (allowed: r2.env, pages.env)`,
    );
  }
}

/**
 * Prefix scan, not a full CLI parser. Everything after a bare `--` is treated as positional
 * and never scanned, so `-- --env-file=x` cannot trigger a false bleed error.
 */
function scanArgSource(
  tokens: readonly string[],
  sourceLabel: string,
): SourceScan {
  let envFileCount = 0;
  let hasNoEnvFile = false;
  const paths: string[] = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex]!;

    if (token === "--") break;

    if (token === "--no-env-file") {
      hasNoEnvFile = true;
      continue;
    }

    if (token === "--env-file") {
      const nextToken = tokens[tokenIndex + 1];
      if (
        nextToken === undefined ||
        nextToken.length === 0 ||
        nextToken.startsWith("-")
      ) {
        throw new Error(
          `${BLEED_ERR}: bare --env-file without path in ${sourceLabel}`,
        );
      }
      assertAllowedEnvFileBasename(nextToken, sourceLabel);
      paths.push(nextToken);
      envFileCount++;
      tokenIndex++;
      continue;
    }

    if (token.startsWith("--env-file=")) {
      const pathValue = token.slice("--env-file=".length);
      if (pathValue.length === 0) {
        throw new Error(`${BLEED_ERR}: empty --env-file= in ${sourceLabel}`);
      }
      assertAllowedEnvFileBasename(pathValue, sourceLabel);
      paths.push(pathValue);
      envFileCount++;
    }
  }

  return { envFileCount, hasNoEnvFile, paths };
}

/**
 * Resolves every `--env-file` path and asserts it is a non-symlink inside an allowed root.
 * Fails closed when the file is missing: an env file that cannot be read is a configuration
 * error, not a reason to continue with a partially populated environment.
 */
function assertAllowedEnvFileLocation(
  rawPath: string,
  sourceLabel: string,
  roots: readonly string[],
): void {
  let stats;
  try {
    stats = lstatSync(rawPath);
  } catch {
    throw new Error(
      `${BLEED_ERR}: --env-file "${rawPath}" does not exist (${sourceLabel})`,
    );
  }

  if (stats.isSymbolicLink()) {
    throw new Error(
      `${BLEED_ERR}: --env-file "${rawPath}" is a symlink (${sourceLabel})`,
    );
  }

  let resolved: string;
  try {
    resolved = realpathSync(rawPath);
  } catch {
    throw new Error(
      `${BLEED_ERR}: --env-file "${rawPath}" cannot be resolved (${sourceLabel})`,
    );
  }

  const inside = roots.some(
    (root) => resolved === root || resolved.startsWith(root + sep),
  );
  if (!inside) {
    throw new Error(
      `${BLEED_ERR}: --env-file "${resolved}" is outside the allowed roots (${roots.join(", ")})`,
    );
  }
}

/** Argument-level contract only; performs no filesystem access. */
export function assertSafeEnvFileArgs(
  execArgv: readonly string[] = process.execArgv,
  bunOptionsRaw: string | undefined = process.env.BUN_OPTIONS,
): void {
  collectEnvFilePaths(execArgv, bunOptionsRaw);
}

function collectEnvFilePaths(
  execArgv: readonly string[],
  bunOptionsRaw: string | undefined,
): readonly string[] {
  const execScan = scanArgSource(execArgv, "process.execArgv");
  if (execScan.envFileCount > 0 && !execScan.hasNoEnvFile) {
    throw new Error(
      `${BLEED_ERR}: --env-file in process.execArgv requires --no-env-file to block CWD .env bleed`,
    );
  }

  const bunOptTokens =
    bunOptionsRaw !== undefined && bunOptionsRaw.trim().length > 0
      ? bunOptionsRaw.trim().split(/\s+/)
      : [];
  const bunOptScan = scanArgSource(bunOptTokens, "BUN_OPTIONS");
  if (bunOptScan.envFileCount > 0 && !bunOptScan.hasNoEnvFile) {
    throw new Error(
      `${BLEED_ERR}: --env-file in BUN_OPTIONS requires --no-env-file in BUN_OPTIONS`,
    );
  }

  if (execScan.envFileCount + bunOptScan.envFileCount > 1) {
    throw new Error(
      `${BLEED_ERR}: multiple --env-file flags detected across process.execArgv and BUN_OPTIONS`,
    );
  }

  return [...execScan.paths, ...bunOptScan.paths];
}

/**
 * Picks the directory a `--env-file` is allowed to live in.
 *
 * Compiled binaries must NOT fall back to `process.cwd()`: a compiled term-profile is
 * launched from wherever the operator happens to be, and `process.cwd()` is that directory.
 * `import.meta.dir` is no help either — in a compiled build it is `/$bunfs/root`, Bun's
 * virtual embed filesystem, so it only addresses `--asset`-embedded files and never a real
 * `r2.env` on disk. `process.execPath` is the real binary path, and Bun reports it with the
 * symlink already resolved: a `/usr/local/bin/term-profile -> /opt/desk/term-profile` link
 * yields `/opt/desk/term-profile`, so the root is the real install directory.
 *
 * Under `bun run` (scripts, tests) `execPath` is the Bun runtime itself, whose directory is
 * meaningless as a config root, so cwd is correct there.
 */
export interface GuardRootInput {
  readonly isCompiled: boolean;
  readonly execPath: string;
  readonly cwd: string;
}

export function resolveGuardRoots(input: GuardRootInput): readonly string[] {
  return [input.isCompiled ? dirname(input.execPath) : input.cwd];
}

/** True inside a `bun build --compile` binary; false under `bun run`. */
export function isCompiledBinary(): boolean {
  return (
    import.meta.dir.startsWith("/$bunfs/") ||
    (process.argv[1] ?? "").startsWith("/$bunfs/")
  );
}

export function defaultGuardRoots(): readonly string[] {
  return resolveGuardRoots({
    isCompiled: isCompiledBinary(),
    execPath: process.execPath,
    cwd: process.cwd(),
  });
}

/**
 * Full guard: argument contract plus filesystem provenance. This is the entry point a CLI
 * should call before spawning a PTY.
 */
export function assertSafeExecArgv(
  execArgv: readonly string[] = process.execArgv,
  bunOptionsRaw: string | undefined = process.env.BUN_OPTIONS,
  options: EnvFileGuardOptions = {},
): void {
  const paths = collectEnvFilePaths(execArgv, bunOptionsRaw);
  // Normalise roots through realpath too: on macOS /var is a symlink to /private/var, so an
  // un-resolved root would never prefix-match the resolved file path and would reject a file
  // that genuinely sits inside it.
  const roots = (options.roots ?? defaultGuardRoots()).map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
  for (const path of paths) {
    assertAllowedEnvFileLocation(path, "env-file", roots);
  }
}
