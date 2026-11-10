#!/usr/bin/env bun
/**
 * @file scripts/stage_dist.ts
 * @description Zero-subprocess parallel `dist/` bundler & asset stager powered by native
 * `Bun.file` + `Bun.write(destFile, srcFile)` (zero-copy `clonefile`/`fcopyfile` on macOS APFS).
 *
 * Replaces 12 sequential shell `cp` spawns in `docs:stage` with concurrent `Bun.file` → `Bun.write`
 * transfers and emits `dist/stage-manifest.json` with SHA-256 digests and byte counts.
 */

import { Glob } from "bun";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");

const ROOT_DOCS_FILES = [
  "index.html",
  "graph.html",
  "graph.js",
  "graph-live-feed.json",
  "backtest-4wk-cfb-nba.json",
  "combo-uniqueness.json",
  "cross-domain-bridge.json",
  "openapi.json",
  "api-reference.md",
] as const;

export interface StagedFileEntry {
  readonly source: string;
  readonly dest: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface StageDistManifest {
  readonly schemaVersion: 1;
  readonly stagedAt: string;
  readonly elapsedMs: number;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly StagedFileEntry[];
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function stageDist(
  options: {
    readonly root?: string;
    readonly headersSource?: string;
    readonly headersOut?: string;
  } = {},
): Promise<StageDistManifest> {
  const start = performance.now();
  const root = options.root ?? DEFAULT_ROOT;
  const headersRel = options.headersSource ?? "infra/pages/_headers";
  const headersOutRel = options.headersOut ?? "dist/_headers";

  mkdirSync(join(root, "dist/assets"), { recursive: true });
  mkdirSync(dirname(join(root, headersOutRel)), { recursive: true });

  const pairs: Array<{ readonly source: string; readonly dest: string }> = [
    ...ROOT_DOCS_FILES.map((name) => ({
      source: `docs/${name}`,
      dest: `dist/${name}`,
    })),
    {
      source: headersRel,
      dest: headersOutRel,
    },
  ];

  const assetNames: string[] = [];
  for await (const name of new Glob("*").scan({
    cwd: join(root, "docs/assets"),
    onlyFiles: true,
  })) {
    assetNames.push(name);
  }
  assetNames.sort();
  for (const name of assetNames) {
    pairs.push({
      source: `docs/assets/${name}`,
      dest: `dist/assets/${name}`,
    });
  }

  const staged = await Promise.all(
    pairs.map(async ({ source, dest }): Promise<StagedFileEntry> => {
      const srcFile = Bun.file(join(root, source));
      if (!(await srcFile.exists())) {
        throw new Error(`[stage_dist] Missing required source file: ${source}`);
      }
      const destFile = Bun.file(join(root, dest));
      await Bun.write(destFile, srcFile);
      const bytes = new Uint8Array(await destFile.arrayBuffer());
      return {
        source,
        dest,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      };
    }),
  );

  const totalBytes = staged.reduce((sum, entry) => sum + entry.bytes, 0);
  const elapsedMs = Number((performance.now() - start).toFixed(2));
  const manifest: StageDistManifest = {
    schemaVersion: 1,
    stagedAt: new Date().toISOString(),
    elapsedMs,
    totalFiles: staged.length,
    totalBytes,
    files: staged,
  };

  await Bun.write(
    join(root, "dist/stage-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return manifest;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      headers: { type: "string", default: "infra/pages/_headers" },
      out: { type: "string", default: "dist/_headers" },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const manifest = await stageDist({
    headersSource:
      typeof values.headers === "string"
        ? values.headers
        : "infra/pages/_headers",
    headersOut: typeof values.out === "string" ? values.out : "dist/_headers",
  });

  if (values.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    const mb = (manifest.totalBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `✓ Staged ${manifest.totalFiles} files (${mb} MB) into dist/ via Bun.file → Bun.write in ${manifest.elapsedMs}ms`,
    );
  }
}
