/**
 * Runtime boundary helpers for scripts that may be typechecked alongside Node-shaped tooling.
 * Desk production paths are Bun-only; DSH Cordis plugins should use `process.versions.bun` in .js,
 * not `Bun.*`, when the host is Node.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Git executable name — constant argv segment (never interpolate a path here). */
export const GIT = "git" as const;

/** Immutable argv for `git rev-parse HEAD` — repo identity, not `Bun.revision`. */
export const GIT_REV_PARSE_HEAD = [GIT, "rev-parse", "HEAD"] as const;

export const GIT_SYMBOLIC_REF_HEAD = [
  GIT,
  "symbolic-ref",
  "--short",
  "HEAD",
] as const;

export const GIT_STATUS_PORCELAIN = [GIT, "status", "--porcelain"] as const;

export const GIT_WORKTREE_LIST_PORCELAIN = [
  GIT,
  "worktree",
  "list",
  "--porcelain",
] as const;

export interface BunRuntimeIdentity {
  readonly version: string;
  readonly revision: string;
  readonly revisionShort: string;
  readonly revisionComposite: string;
  readonly versionWithSha: string;
  readonly execPath: string;
}

export interface RepoGitIdentity {
  readonly name: string;
  readonly path: string;
  readonly head?: string | undefined;
  readonly headShort?: string | undefined;
  readonly branch?: string | undefined;
  readonly dirtyCount?: number | undefined;
  readonly dirty?: boolean | undefined;
}

export interface BunOraclePinCheck {
  readonly manifestPath: string;
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

export interface DeskProvenanceSnapshot {
  readonly capturedAt: string;
  readonly codeRoot: string;
  readonly bun: BunRuntimeIdentity;
  readonly repos: readonly RepoGitIdentity[];
  readonly worktrees?: readonly RepoGitIdentity[];
  readonly oracle?: BunOraclePinCheck;
}

const DESK_REPO_NAMES = [
  "sportsdesk-ops",
  "scratch",
  "dsh-ops",
  "bookdeskops",
  "PPH-Opps",
] as const;

export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}

export function requireBunRuntime(caller = "this module"): void {
  if (!isBunRuntime()) {
    throw new Error(`${caller} requires Bun (process.versions.bun)`);
  }
}

/**
 * Full oven-sh/bun commit for this binary — prefer over shelling out to `bun --revision`.
 * @see https://bun.com/guides/util/version — docs show e.g. `49231b2c…`; read live `Bun.revision`, never that literal.
 */
export function bunRevisionSha(): string {
  requireBunRuntime();
  return Bun.revision;
}

export function bunRevisionComposite(): string {
  requireBunRuntime();
  return `${Bun.version}+${Bun.revision.slice(0, 9)}`;
}

export function bunVersionWithSha(): string {
  requireBunRuntime();
  return Bun.version_with_sha;
}

/**
 * Checkout HEAD SHA — constant until you commit; not the Bun binary (`Bun.revision` is fixed per install).
 */
function gitCmd(argv: readonly string[]): string[] {
  const bin = Bun.which(GIT) ?? GIT;
  return [bin, ...argv.slice(1)];
}

function gitStdout(argv: readonly string[], cwd: string): string | undefined {
  const proc = Bun.spawnSync({
    cmd: gitCmd(argv),
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return undefined;
  const text = new TextDecoder().decode(proc.stdout).trim();
  return text === "" ? undefined : text;
}

function gitPorcelainLineCount(cwd: string): number {
  if (!existsSync(cwd)) return 0;
  const proc = Bun.spawnSync({
    cmd: gitCmd(GIT_STATUS_PORCELAIN),
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return 0;
  const text = new TextDecoder().decode(proc.stdout);
  return text === ""
    ? 0
    : text.split("\n").filter((line) => line.trim() !== "").length;
}

export function gitShortSha(sha: string, length = 9): string {
  return sha.slice(0, length);
}

export function gitRepoHead(cwd = process.cwd()): string | undefined {
  requireBunRuntime();
  return gitStdout(GIT_REV_PARSE_HEAD, cwd);
}

export function gitRepoBranch(cwd: string): string | undefined {
  requireBunRuntime();
  return gitStdout(GIT_SYMBOLIC_REF_HEAD, cwd);
}

export function bunRuntimeIdentity(): BunRuntimeIdentity {
  requireBunRuntime();
  return {
    version: Bun.version,
    revision: Bun.revision,
    revisionShort: gitShortSha(Bun.revision),
    revisionComposite: bunRevisionComposite(),
    versionWithSha: Bun.version_with_sha,
    execPath: process.execPath,
  };
}

export function resolveCodeRoot(env: NodeJS.ProcessEnv = Bun.env): string {
  const home = env.HOME ?? "";
  return env.CODE_ROOT?.trim() || join(home, "code");
}

export function deskRepoIdentities(
  codeRoot = resolveCodeRoot(),
  repoNames: readonly string[] = DESK_REPO_NAMES,
): RepoGitIdentity[] {
  requireBunRuntime();
  const out: RepoGitIdentity[] = [];
  for (const name of repoNames) {
    const path = join(codeRoot, name);
    if (!existsSync(join(path, ".git"))) {
      out.push({ name, path });
      continue;
    }
    const head = gitRepoHead(path);
    const dirtyCount = gitPorcelainLineCount(path);
    out.push({
      name,
      path,
      head,
      headShort: head ? gitShortSha(head) : undefined,
      branch: gitRepoBranch(path),
      dirtyCount,
      dirty: dirtyCount > 0,
    });
  }
  return out;
}

/** Parse `git worktree list --porcelain` for a host repo (e.g. deepseek-harness). */
export function gitWorktreeIdentities(
  hostRepoPath: string,
  namePrefix: string,
): RepoGitIdentity[] {
  requireBunRuntime();
  if (!existsSync(join(hostRepoPath, ".git"))) return [];
  const proc = Bun.spawnSync({
    cmd: gitCmd(GIT_WORKTREE_LIST_PORCELAIN),
    cwd: hostRepoPath,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return [];
  const blocks = new TextDecoder()
    .decode(proc.stdout)
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean);

  const out: RepoGitIdentity[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const worktreeLine = lines.find((l) => l.startsWith("worktree "));
    const headLine = lines.find((l) => l.startsWith("HEAD "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (!worktreeLine || !headLine) continue;
    const path = worktreeLine.slice("worktree ".length).trim();
    const head = headLine.slice("HEAD ".length).trim();
    const branchRef = branchLine?.slice("branch ".length).trim();
    const branch = branchRef?.replace(/^refs\/heads\//, "");
    const label = path.includes("deepseek-harness-web")
      ? `${namePrefix}/web-tip`
      : path.endsWith("deepseek-harness")
        ? `${namePrefix}/wip`
        : `${namePrefix}/${path.split("/").pop() ?? "worktree"}`;
    const dirtyCount = gitPorcelainLineCount(path);
    out.push({
      name: label,
      path,
      head,
      headShort: gitShortSha(head),
      branch,
      dirtyCount,
      dirty: dirtyCount > 0,
    });
  }
  return out;
}

const DEFAULT_ORACLE_MANIFEST = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/pinned/manifest.json",
);

export interface DeskProvenanceOptions {
  readonly codeRoot?: string | undefined;
  readonly includeWorktrees?: boolean | undefined;
  readonly oracleManifestPath?: string | false | undefined;
  /** Enforce exact `bunExecutablePath` match in oracle manifest (default: `false` for portable CI/runner layouts). */
  readonly strictExecPath?: boolean | undefined;
}

export function compareBunToOracleManifest(
  manifestPath = DEFAULT_ORACLE_MANIFEST,
  options: { readonly strictExecPath?: boolean | undefined } = {},
): BunOraclePinCheck {
  requireBunRuntime();
  const mismatches: string[] = [];
  if (!existsSync(manifestPath)) {
    return { manifestPath, ok: false, mismatches: ["manifest missing"] };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    runtime?: {
      bunVersion?: string;
      bunRevision?: string;
      bunExecutablePath?: string;
    };
  };
  const expectedVersion = manifest.runtime?.bunVersion;
  const expectedRevision = manifest.runtime?.bunRevision;
  const expectedExec = manifest.runtime?.bunExecutablePath;
  if (expectedVersion && expectedVersion !== Bun.version) {
    mismatches.push(`bunVersion: want ${expectedVersion} got ${Bun.version}`);
  }
  if (expectedRevision && expectedRevision !== Bun.revision) {
    mismatches.push(
      `bunRevision: want ${expectedRevision} got ${Bun.revision}`,
    );
  }
  if (
    options.strictExecPath &&
    expectedExec &&
    expectedExec !== process.execPath
  ) {
    mismatches.push(`execPath: want ${expectedExec} got ${process.execPath}`);
  }
  return { manifestPath, ok: mismatches.length === 0, mismatches };
}

/** Bun binary + spine repo SHAs — for drift logs, oracles, and operator paste. */
export function deskProvenanceSnapshot(
  options: DeskProvenanceOptions = {},
): DeskProvenanceSnapshot {
  const codeRoot = options.codeRoot ?? resolveCodeRoot();
  const harnessPath = join(codeRoot, "deepseek-harness");
  const oraclePath = options.oracleManifestPath;
  return {
    capturedAt: new Date().toISOString(),
    codeRoot,
    bun: bunRuntimeIdentity(),
    repos: deskRepoIdentities(codeRoot),
    ...(options.includeWorktrees
      ? { worktrees: gitWorktreeIdentities(harnessPath, "dsh") }
      : {}),
    ...(oraclePath !== false
      ? {
          oracle: compareBunToOracleManifest(
            oraclePath ?? DEFAULT_ORACLE_MANIFEST,
            { strictExecPath: options.strictExecPath },
          ),
        }
      : {}),
  };
}
