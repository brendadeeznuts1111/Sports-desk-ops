#!/usr/bin/env bun
/**
 * Rewrite a local HTML document with the SRI values from the pinned CDN manifest.
 *
 *   bun run sri:apply --in scratch/manager.html --out scratch/manager.sri.html
 *
 * This is the build half of the SRI control: the manifest is the single source of truth, so a
 * document cannot be hand-edited into a hash that does not match the pinned bytes. It works on
 * input we are given; the live `manager.html` is vendor-served, so the output is a patch to send
 * upstream, not a deploy.
 *
 * Exits 2 when an external asset is unpinned or the input is unreadable. `rel="stylesheet/less"`
 * links are left untouched (SRI is not honoured on them) and reported as skipped.
 */

import { parseArgs } from "node:util";

import { applySriToHtml } from "../lib/f402_sri.ts";
import { loadCdnManifest } from "../lib/f402_cdn_pin.ts";

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    out: { type: "string" },
  },
});

const inputPath = values.in ?? null;
const outputPath = values.out ?? null;

if (inputPath === null) {
  console.error("usage: bun run sri:apply --in <html> [--out <html>]");
  process.exit(2);
}

const inputFile = Bun.file(inputPath);
if (!(await inputFile.exists())) {
  console.error(`sri:apply: ${inputPath} does not exist`);
  process.exit(2);
}

const manifest = await loadCdnManifest();
const result = applySriToHtml(await inputFile.text(), manifest);

const unpinned = result.skipped.filter(
  (entry) => entry.reason === "not pinned",
);
if (unpinned.length > 0) {
  for (const entry of unpinned) {
    console.error(`sri:apply: unpinned external asset — ${entry.url}`);
  }
  console.error(
    "sri:apply: review the asset, then run `bun run pin:cdn:update`",
  );
  process.exit(2);
}

if (outputPath === null) {
  process.stdout.write(result.html);
} else {
  await Bun.write(outputPath, result.html);
  console.log(`sri:apply: wrote ${outputPath}`);
}

console.log(
  `sri:apply: ${result.applied.length} tag(s) signed, ${result.skipped.length} skipped`,
);
for (const entry of result.skipped) {
  console.log(`  skipped ${entry.url} — ${entry.reason}`);
}
