#!/usr/bin/env bun
/**
 * @file packages/contracts/scripts/build.ts
 * @description Build ESM JavaScript into dist/ for consumers that are not Bun.
 *
 * The package exports TypeScript source under the "bun" condition (fast local
 * resolution) and this build under "default" (Node, bundlers). Entries are derived
 * from the package.json exports map so the two cannot drift. Runs from `prepack`,
 * so `bun pm pack` / `bun publish` always ship a current dist.
 */
import { mkdir, rm } from "node:fs/promises";

type ExportTarget = string | { types?: string; bun?: string; default?: string };

const pkgDir = new URL("..", import.meta.url);
const pkg = (await Bun.file(new URL("package.json", pkgDir)).json()) as {
  exports: Record<string, ExportTarget>;
};
const outdir = new URL("dist/", pkgDir);

const entries: string[] = [];
const expected: string[] = [];
for (const target of Object.values(pkg.exports)) {
  const source =
    typeof target === "string"
      ? target
      : (target.bun ?? target.types ?? target.default);
  const dist = typeof target === "string" ? undefined : target.default;
  if (!source) {
    console.error("build: an exports entry has no source target");
    process.exit(1);
  }
  entries.push(new URL(source.replace(/^\.\//, ""), pkgDir).pathname);
  if (dist) expected.push(dist.split("/").pop()!);
}
if (entries.length === 0) {
  console.error("build: package.json has no exports to build");
  process.exit(1);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const srcRoot = new URL("src/", pkgDir).pathname;
const result = await Bun.build({
  entrypoints: entries,
  root: srcRoot,
  outdir: outdir.pathname,
  format: "esm",
  target: "node",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Every conditional export must have produced its dist file, or a Node consumer
// resolves a path that does not exist.
const emitted = new Set(
  result.outputs.map((o) => o.path.slice(outdir.pathname.length)),
);
const missing = expected.filter((f) => !emitted.has(f));
if (missing.length > 0) {
  console.error(`build: missing dist output(s): ${missing.join(", ")}`);
  process.exit(1);
}

console.log(
  `build: dist/ has ${result.outputs.length} file(s) for ${entries.length} exports`,
);
