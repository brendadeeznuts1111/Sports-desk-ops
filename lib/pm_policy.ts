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
};

/**
 * The workspaces Bun installs, keyed by directory, plus the matched package.json files it skips
 * for having no "name". A `!` pattern removes what the globs match wherever it sits in the list,
 * but not a directory listed by its literal path (bun.com/docs/pm/workspaces).
 */
export async function resolveWorkspaces(root: string): Promise<{
  workspaces: WorkspaceNames;
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
      };
      if (typeof pkg.name === "string" && pkg.name !== "") {
        workspaces[dir] = pkg.name;
      } else {
        nameless.push(dir);
      }
    }
  }
  return { workspaces, nameless };
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
  const lock = Bun.JSONC.parse(
    await Bun.file(path.join(root, "bun.lock")).text(),
  ) as { workspaces?: Record<string, { name?: string }> };
  const locked: WorkspaceNames = Object.fromEntries(
    Object.entries(lock.workspaces ?? {}).map(([dir, ws]) => [dir, ws.name]),
  );
  return { expected, locked };
}
