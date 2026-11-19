#!/usr/bin/env bun
/**
 * @file scripts/render_docs.ts
 * @description Render a Markdown tree to HTML, cache it, and write the build manifest.
 *
 *   bun run docs:render
 *   bun run scripts/render_docs.ts --dir docs --cache scratch/.md-cache
 *   bun run scripts/render_docs.ts --check     # nothing written; exit 1 if stale
 *
 * The cache key includes the Bun version and the parser options, so an upgrade or an option change
 * produces new entries instead of serving HTML from a different renderer. The manifest is written
 * atomically and its `buildId` is a hash of the entries, so an unchanged tree rebuilds byte-for-byte.
 */

import { join } from "node:path";
import {
  DOCS_RENDER_OPTIONS,
  MANIFEST_FILE,
  MarkdownTooLargeError,
  type RenderedDoc,
  buildDocsManifest,
  readDocsManifest,
  renderDocsTree,
  writeDocsManifest,
} from "../lib/docs_render_cache.ts";
import { wrapDisplay } from "../lib/terminal_format.ts";

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : fallback;
}

const args = process.argv.slice(2);
const dir = flag(args, "--dir", "docs");
const cacheDir = flag(args, "--cache", "scratch/.md-cache");
const manifestPath = flag(args, "--manifest", join(cacheDir, MANIFEST_FILE));
const check = args.includes("--check");

let rendered: readonly RenderedDoc[];
try {
  rendered = await renderDocsTree({ dir, cacheDir, dryRun: check });
} catch (error) {
  if (error instanceof MarkdownTooLargeError) {
    console.error(`docs:render: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

if (rendered.length === 0) {
  console.error(`docs:render: no Markdown files under ${dir}`);
  process.exit(2);
}

const manifest = buildDocsManifest(rendered);
const stale = rendered.filter((entry) => !entry.cached).length;
let manifestStatus: string;
let manifestStale = false;

if (check) {
  const existing = await readDocsManifest(manifestPath).catch(() => null);
  if (!existing) {
    manifestStatus = "missing";
    manifestStale = true;
  } else if (existing.buildId !== manifest.buildId) {
    manifestStatus = `stale (${existing.buildId.slice(0, 12)} != ${manifest.buildId.slice(0, 12)})`;
    manifestStale = true;
  } else {
    manifestStatus = `current (${manifest.buildId.slice(0, 12)})`;
  }
} else {
  await writeDocsManifest(manifestPath, manifest);
  manifestStatus = `written (${manifest.buildId.slice(0, 12)})`;
}

const width = process.stdout.columns ?? 0;
for (const entry of rendered) {
  const state = entry.cached ? "cached" : check ? "stale" : "rendered";
  const line = `${entry.rel}  ${entry.sourceBytes} B -> ${entry.htmlBytes} B (zst ${entry.zstdBytes} B)  ${state}`;
  process.stdout.write(
    width > 0
      ? `${wrapDisplay(line, width, { hard: false }).join("\n")}\n`
      : `${line}\n`,
  );
}

const total = (pick: (entry: RenderedDoc) => number): number =>
  rendered.reduce((sum, entry) => sum + pick(entry), 0);
const summary = `${rendered.length} files · src ${total((e) => e.sourceBytes)} B · html ${total((e) => e.htmlBytes)} B · zst ${total((e) => e.zstdBytes)} B · ${rendered.length - stale} cached`;
process.stderr.write(
  `${wrapDisplay(summary, width || 80, { hard: false }).join("\n")}\n`,
);
process.stderr.write(
  `docs:render: ${cacheDir} · manifest ${manifestStatus} · Bun ${Bun.version} · ${JSON.stringify(DOCS_RENDER_OPTIONS).length} B options\n`,
);

if (check && (stale > 0 || manifestStale)) {
  console.error(
    `docs:render: ${stale} file(s) and manifest=${manifestStale ? "stale" : "current"} — not cache-current for this Bun version and option set`,
  );
  process.exit(1);
}
