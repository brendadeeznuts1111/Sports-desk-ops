import path from "node:path";

const ALWAYS_SKIPPED = [
  "/.git/",
  "/node_modules/",
  "/archive/",
  "/opencode/",
  "/vscode/",
  // Byte-pinned third-party portal bundles: the oracle diffs them, so they are never edited.
  "/verification/manager-boot-oracle/pinned/",
];

/**
 * Source files under `root` with one of `extensions`, as root-relative paths.
 *
 * Inside a git work tree this is tracked plus untracked-but-not-ignored files, so a gitignored
 * scratch file cannot fail a gate. Outside one (a throwaway fixture root) every file counts.
 */
export async function listSourceFiles(
  root: string,
  extensions: readonly string[],
): Promise<string[]> {
  const files =
    (await gitListing(root, extensions)) ?? (await walk(root, extensions));
  const kept: string[] = [];
  for (const file of files.sort()) {
    const norm = `/${file.replaceAll("\\", "/")}`;
    if (ALWAYS_SKIPPED.some((skip) => norm.includes(skip))) continue;
    if (await Bun.file(path.join(root, file)).exists()) kept.push(file);
  }
  return kept;
}

async function gitListing(
  root: string,
  extensions: readonly string[],
): Promise<string[] | null> {
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--deduplicate",
      "--",
      ...extensions.map((ext) => `*.${ext}`),
    ],
    {
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...Bun.env,
        GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  const [out, code] = await Promise.all([proc.stdout.text(), proc.exited]);
  if (code !== 0) return null;
  return out.split("\0").filter((file) => file !== "");
}

async function walk(
  root: string,
  extensions: readonly string[],
): Promise<string[]> {
  const glob = new Bun.Glob(`**/*.{${extensions.join(",")}}`);
  return Array.fromAsync(glob.scan({ cwd: root, onlyFiles: true }));
}
