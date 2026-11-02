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

/**
 * Workspace path → package name, from the package.json files and from bun.lock. Bun 1.4.4 never
 * rewrites a renamed package in an existing bun.lock and a frozen install does not compare names,
 * so the two drift silently until the lock is regenerated.
 */
export async function lockWorkspaceNames(root: string): Promise<{
  expected: WorkspaceNames;
  locked: WorkspaceNames;
}> {
  const manifest = (await Bun.file(path.join(root, "package.json")).json()) as {
    name?: string;
    workspaces?: string[];
  };
  const expected: WorkspaceNames = { "": manifest.name };
  for (const pattern of manifest.workspaces ?? []) {
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(
      root,
    )) {
      const pkg = (await Bun.file(path.join(root, file)).json()) as {
        name?: string;
      };
      expected[path.dirname(file)] = pkg.name;
    }
  }
  const lock = Bun.JSONC.parse(
    await Bun.file(path.join(root, "bun.lock")).text(),
  ) as { workspaces?: Record<string, { name?: string }> };
  const locked: WorkspaceNames = Object.fromEntries(
    Object.entries(lock.workspaces ?? {}).map(([dir, ws]) => [dir, ws.name]),
  );
  return { expected, locked };
}
