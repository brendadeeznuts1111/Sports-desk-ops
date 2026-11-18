import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * React and React DOM are one library released as two packages: `react-dom` reads React's
 * internal dispatcher, and the server and client renderers both refuse a React whose internals
 * object they do not recognise. The repository pins both by hand (`dependencies` at the root,
 * `catalog` for the workspaces), so nothing stops a single `bun add react` from moving one
 * without the other — which is exactly what happened on 2026-11-18: root `react` 19.3.1 against
 * `react-dom` 18.3.1, and every root-level `react-dom/server` import died at load with
 * `TypeError: undefined is not an object (evaluating 'ReactSharedInternals.ReactCurrentDispatcher')`.
 *
 * These assertions make the pairing a contract instead of a convention: the declared ranges agree,
 * the installed renderer accepts the installed React, and the type packages track the real major.
 */

const ROOT = join(import.meta.dir, "..");

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly catalog?: Readonly<Record<string, string>>;
  readonly catalogs?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}

async function readManifest(path: string): Promise<Manifest> {
  return (await Bun.file(path).json()) as Manifest;
}

/** Resolve `catalog:` / `catalog:default` / `catalog:<name>` against the root manifest. */
function declaredVersion(
  name: string,
  range: string | undefined,
  root: Manifest,
): string | undefined {
  if (range === undefined) return undefined;
  if (!range.startsWith("catalog:")) return range;
  const catalogName = range.slice("catalog:".length) || "default";
  const table =
    catalogName === "default" ? root.catalog : root.catalogs?.[catalogName];
  return table?.[name];
}

/** `18.3.1`, `^18.3.1`, `~18.3.1` and `>=18` all name major 18 for this contract. */
function majorOf(range: string | undefined): string | undefined {
  if (range === undefined) return undefined;
  return /(\d+)/.exec(range)?.[1];
}

async function workspaceManifests(): Promise<
  ReadonlyArray<{ readonly path: string; readonly manifest: Manifest }>
> {
  const packagesDir = join(ROOT, "packages");
  if (!existsSync(packagesDir)) return [];
  const out: { path: string; manifest: Manifest }[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(packagesDir, entry.name, "package.json");
    if (!existsSync(path)) continue;
    out.push({ path, manifest: await readManifest(path) });
  }
  return out;
}

async function installedVersion(pkg: string): Promise<string> {
  const path = join(ROOT, "node_modules", pkg, "package.json");
  if (!existsSync(path)) {
    throw new Error(
      `${pkg} is not installed; run \`bun ci\` before this test (it reads the installed renderer)`,
    );
  }
  const manifest = (await Bun.file(path).json()) as { version?: string };
  if (manifest.version === undefined) {
    throw new Error(`${path} has no version`);
  }
  return manifest.version;
}

describe("React version pairing", () => {
  test("root dependencies declare react and react-dom at the same range", async () => {
    const root = await readManifest(join(ROOT, "package.json"));
    const react = root.dependencies?.react;
    const reactDom = root.dependencies?.["react-dom"];
    expect(react, "package.json dependencies.react").toBeString();
    expect(reactDom, "package.json dependencies.react-dom").toBeString();
    expect(reactDom, "react-dom must move with react").toBe(react);
  });

  test("the catalog pairs react and react-dom, and the root agrees with it", async () => {
    const root = await readManifest(join(ROOT, "package.json"));
    const catalogReact = root.catalog?.react;
    const catalogReactDom = root.catalog?.["react-dom"];
    expect(catalogReact, "package.json catalog.react").toBeString();
    expect(
      catalogReactDom,
      "catalog.react-dom must move with catalog.react",
    ).toBe(catalogReact);
    // A root pin and a catalog pin that disagree install two React copies, and the workspace
    // renders with a dispatcher the root's renderer cannot see.
    expect(root.dependencies?.react).toBe(catalogReact);
  });

  test("workspaces declare react and react-dom together, on the root's range", async () => {
    const root = await readManifest(join(ROOT, "package.json"));
    const rootReact = root.dependencies?.react;
    for (const { path, manifest } of await workspaceManifests()) {
      const react =
        manifest.dependencies?.react ?? manifest.devDependencies?.react;
      const reactDom =
        manifest.dependencies?.["react-dom"] ??
        manifest.devDependencies?.["react-dom"];
      if (react === undefined && reactDom === undefined) continue;
      expect(react, `${path} declares react-dom without react`).toBeString();
      expect(reactDom, `${path} declares react without react-dom`).toBeString();
      expect(
        declaredVersion("react", react, root),
        `${path} must resolve react to the root range`,
      ).toBe(rootReact);
    }
  });

  test("the installed react-dom accepts the installed react", async () => {
    const reactVersion = await installedVersion("react");
    const reactDomVersion = await installedVersion("react-dom");
    expect(
      majorOf(reactDomVersion),
      `react ${reactVersion} vs react-dom ${reactDomVersion}`,
    ).toBe(majorOf(reactVersion));

    const reactDomManifest = (await Bun.file(
      join(ROOT, "node_modules", "react-dom", "package.json"),
    ).json()) as { peerDependencies?: Readonly<Record<string, string>> };
    const peer = reactDomManifest.peerDependencies?.react;
    if (peer !== undefined) {
      expect(
        Bun.semver.satisfies(reactVersion, peer),
        `installed react ${reactVersion} is outside react-dom's peer range "${peer}"`,
      ).toBe(true);
    }
  });

  test("@types/react tracks the installed react major", async () => {
    const root = await readManifest(join(ROOT, "package.json"));
    const reactVersion = await installedVersion("react");
    const reactDomVersion = await installedVersion("react-dom");
    expect(
      majorOf(root.devDependencies?.["@types/react"]),
      "@types/react must describe the React the code runs",
    ).toBe(majorOf(reactVersion));
    expect(
      majorOf(root.devDependencies?.["@types/react-dom"]),
      "@types/react-dom must describe the renderer the code runs",
    ).toBe(majorOf(reactDomVersion));
  });
});
