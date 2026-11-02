/**
 * Package-manager policy shared by tests/bun_config_policy.test.ts and scripts/pm_doctor.ts.
 *
 * Install keys are machine-owned (`~/dotfiles/bun/bunfig.toml`), so every project shares one
 * install policy and a project copy can only diverge from it.
 */
import path from "node:path";

export const MACHINE_OWNED_INSTALL_KEYS = [
  "linker",
  "globalStore",
  "cache",
  "frozenLockfile",
  "minimumReleaseAge",
] as const;

export const FOREIGN_LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
] as const;

/**
 * Bun reads exactly one global bunfig: `$XDG_CONFIG_HOME/.bunfig.toml` when XDG_CONFIG_HOME is an
 * absolute path, otherwise `$HOME/.bunfig.toml`. There is no fallback between them.
 */
export function globalBunfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, ".bunfig.toml");
  }
  return path.join(env.HOME ?? "", ".bunfig.toml");
}

export type WorkspaceNames = Record<string, string | undefined>;

type RootManifest = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  patchedDependencies?: Record<string, string>;
};

type LockFile = {
  workspaces?: Record<string, { name?: string; version?: string }>;
  patchedDependencies?: Record<string, string>;
};

async function readLock(root: string): Promise<LockFile> {
  return Bun.JSONC.parse(
    await Bun.file(path.join(root, "bun.lock")).text(),
  ) as LockFile;
}

/**
 * The workspaces Bun installs, keyed by directory, plus the matched package.json files it skips
 * for having no "name". A `!` pattern removes what the globs match wherever it sits in the list,
 * but not a directory listed by its literal path (bun.com/docs/pm/workspaces).
 */
export async function resolveWorkspaces(root: string): Promise<{
  workspaces: WorkspaceNames;
  versions: WorkspaceNames;
  nameless: string[];
}> {
  const manifest = (await Bun.file(
    path.join(root, "package.json"),
  ).json()) as RootManifest;
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const negated = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => new Bun.Glob(p.slice(1)));
  const workspaces: WorkspaceNames = { "": manifest.name };
  const versions: WorkspaceNames = {};
  const nameless: string[] = [];
  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    const literal = !/[*?[\]{}()!]/.test(pattern);
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(
      root,
    )) {
      const dir = path.dirname(file);
      if (dir.split("/").includes("node_modules")) continue;
      if (!literal && negated.some((g) => g.match(dir) || g.match(file))) {
        continue;
      }
      const pkg = (await Bun.file(path.join(root, file)).json()) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof pkg.name === "string" && pkg.name !== "") {
        workspaces[dir] = pkg.name;
        versions[dir] =
          typeof pkg.version === "string" ? pkg.version : undefined;
      } else {
        nameless.push(dir);
      }
    }
  }
  return { workspaces, versions, nameless };
}

/**
 * Workspace path → package name, from the package.json files and from bun.lock. Bun 1.4.4 never
 * rewrites a renamed package in an existing bun.lock and a frozen install does not compare names,
 * so the two drift silently until the lock is regenerated.
 */
export async function lockWorkspaceNames(root: string): Promise<{
  expected: WorkspaceNames;
  locked: WorkspaceNames;
}> {
  const { workspaces: expected } = await resolveWorkspaces(root);
  const lock = await readLock(root);
  const locked: WorkspaceNames = Object.fromEntries(
    Object.entries(lock.workspaces ?? {}).map(([dir, ws]) => [dir, ws.name]),
  );
  return { expected, locked };
}

/**
 * Workspace path → version, from the package.json files and from bun.lock. A frozen install
 * passes after `bun pm version` bumps a workspace and leaves the lock on the old version; an
 * unfrozen `bun install` (`bun-deps install`) rewrites it. Bun never records the root's version.
 */
export async function lockWorkspaceVersions(root: string): Promise<{
  expected: WorkspaceNames;
  locked: WorkspaceNames;
}> {
  const { versions: expected } = await resolveWorkspaces(root);
  const lock = await readLock(root);
  const locked: WorkspaceNames = Object.fromEntries(
    Object.entries(lock.workspaces ?? {})
      .filter(([dir]) => dir !== "")
      .map(([dir, ws]) => [dir, ws.version]),
  );
  return { expected, locked };
}

/**
 * Patches declared in package.json and in bun.lock, and declared patch files that are missing.
 * Under a frozen lockfile `bun patch --commit` writes the patch and package.json but not bun.lock,
 * and a frozen install still applies the patch, so nothing else notices the lock is behind.
 */
export async function patchState(root: string): Promise<{
  declared: Record<string, string>;
  locked: Record<string, string>;
  missing: string[];
}> {
  const manifest = (await Bun.file(
    path.join(root, "package.json"),
  ).json()) as RootManifest;
  const declared = manifest.patchedDependencies ?? {};
  const locked = (await readLock(root)).patchedDependencies ?? {};
  const missing: string[] = [];
  for (const file of Object.values(declared)) {
    if (!(await Bun.file(path.join(root, file)).exists())) missing.push(file);
  }
  return { declared, locked, missing };
}
