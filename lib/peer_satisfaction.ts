/**
 * Peer dependency ranges that the installed tree does not satisfy.
 *
 * `bun install` resolves a peer to the version the project declares, even when that version is
 * outside the dependent's range (Bun 1.4.4, "Peer dependencies resolve more like pnpm"). It only
 * mentions the conflict during a *resolving* install with `--verbose`; a frozen `bun ci` reads the
 * lock and says nothing. That is how `react-dom@18.3.1` sat under `react@19.3.1` on 2026-11-18 and
 * every `react-dom/server` import died at module load.
 *
 * This walks the tree the way a runtime import resolves it — from each workspace manifest's own
 * dependencies, following `Bun.resolveSync` — so the answer is the version a package actually gets,
 * not the version a directory listing suggests. Stale linker directories left by an earlier install
 * are never visited, because nothing resolves to them.
 *
 * Optional peers (`peerDependenciesMeta[x].optional`) and peers the dependent also lists as an
 * optional dependency are skipped: their absence is expected.
 *
 * @see https://bun.com/blog/bun-v1.4.4#peer-dependencies-resolve-more-like-pnpm
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PeerProblem {
  /** The dependent, as `name@version`. */
  readonly package: string;
  /** The peer that is not satisfied. */
  readonly peer: string;
  /** The range the dependent declares. */
  readonly range: string;
  /** The version this peer resolves to, or `null` when nothing resolves. */
  readonly resolved: string | null;
  readonly kind: "out-of-range" | "unresolved";
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<
    Record<string, { readonly optional?: boolean }>
  >;
}

function readManifest(file: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/**
 * The directory of the installed instance `name` resolves to from `from`.
 *
 * Resolves the package entry, not `name/package.json`: a package may hide its manifest behind
 * `exports`, and the entry is what an import gets. The manifest is then found by walking up from
 * the entry, which also covers packages whose entry is a nested file.
 */
function resolveInstance(name: string, from: string): string | null {
  let entry: string;
  try {
    entry = Bun.resolveSync(name, from);
  } catch {
    return null;
  }
  let dir = dirname(entry);
  while (true) {
    const manifest = readManifest(join(dir, "package.json"));
    if (manifest?.name === name) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Root and `packages/<dir>` manifests — the workspace roots a dependency can be declared in. */
function workspaceManifests(
  root: string,
): readonly { readonly dir: string; readonly manifest: Manifest }[] {
  const out: { dir: string; manifest: Manifest }[] = [];
  const rootManifest = readManifest(join(root, "package.json"));
  if (rootManifest !== null) out.push({ dir: root, manifest: rootManifest });
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return out;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifest = readManifest(join(dir, "package.json"));
    if (manifest !== null) out.push({ dir, manifest });
  }
  return out;
}

/** The version this peer resolves to, or `null` when it resolves nowhere. */
function peerVersion(dependentDir: string, peer: string): string | null {
  const dir = resolveInstance(peer, dependentDir);
  if (dir === null) return null;
  return readManifest(join(dir, "package.json"))?.version ?? null;
}

/**
 * Every peer range in the installed tree that its resolved version does not satisfy.
 *
 * @param root - repository root (the directory holding `package.json`).
 * @returns problems in a stable order; empty when every non-optional peer is satisfied.
 */
export function collectPeerProblems(root: string): readonly PeerProblem[] {
  const manifests = workspaceManifests(root);
  const visited = new Set<string>();
  const queue: { readonly dir: string; readonly manifest: Manifest }[] = [];

  for (const { dir, manifest } of manifests) {
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.devDependencies,
    })) {
      const instance = resolveInstance(name, dir);
      if (instance === null) continue;
      const child = readManifest(join(instance, "package.json"));
      if (child !== null) queue.push({ dir: instance, manifest: child });
    }
  }

  const problems: PeerProblem[] = [];
  while (queue.length > 0) {
    const { dir, manifest } = queue.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);

    for (const [peer, range] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional === true) continue;
      if (manifest.optionalDependencies?.[peer] !== undefined) continue;
      const version = peerVersion(dir, peer);
      const label = `${manifest.name}@${manifest.version}`;
      if (version === null) {
        problems.push({
          package: label,
          peer,
          range,
          resolved: null,
          kind: "unresolved",
        });
      } else if (!Bun.semver.satisfies(version, range)) {
        problems.push({
          package: label,
          peer,
          range,
          resolved: version,
          kind: "out-of-range",
        });
      }
    }

    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      const instance = resolveInstance(name, dir);
      if (instance === null || visited.has(instance)) continue;
      const child = readManifest(join(instance, "package.json"));
      if (child !== null) queue.push({ dir: instance, manifest: child });
    }
  }

  return problems.sort(
    (a, b) =>
      a.package.localeCompare(b.package) ||
      a.peer.localeCompare(b.peer) ||
      (a.resolved ?? "").localeCompare(b.resolved ?? ""),
  );
}

/** One line per problem, for a test assertion or a doctor row. */
export function formatPeerProblem(problem: PeerProblem): string {
  return problem.resolved === null
    ? `${problem.package} -> ${problem.peer} "${problem.range}" resolves nowhere`
    : `${problem.package} -> ${problem.peer}@${problem.resolved} outside "${problem.range}"`;
}
