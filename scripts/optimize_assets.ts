#!/usr/bin/env bun
/**
 * @file scripts/optimize_assets.ts
 * @description Native `Bun.file` + `Bun.Image` (`backend = "bun"`) asset pipeline, auditor,
 * WebP sibling encoder, and LQIP blur-placeholder manifest generator.
 *
 * Usage:
 *   bun run scripts/optimize_assets.ts [--write] [--json] [--yaml] [--quality 82]
 */

import { Glob, YAML } from "bun";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { contentTypeFor, type LogoFormat } from "../lib/logo_image.ts";

Bun.Image.backend = "bun";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");
const RASTER_EXT_RE = /\.(?:png|jpe?g|webp|gif|avif)$/i;

export interface AssetImageEntry {
  readonly path: string;
  readonly format: LogoFormat;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly webpSibling: string | null;
  readonly webpBytes: number | null;
  readonly savingsPct: number | null;
  readonly placeholder: string;
}

export interface AssetOptimizationManifest {
  readonly schemaVersion: 1;
  readonly backend: string;
  readonly elapsedMs: number;
  readonly totalSourceBytes: number;
  readonly totalEffectiveBytes: number;
  readonly netSavingsBytes: number;
  readonly netSavingsPct: number;
  readonly generatedWebpSiblings: readonly string[];
  readonly images: readonly AssetImageEntry[];
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function siblingWebpRelPath(relPath: string): string | null {
  const ext = extname(relPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    return `${relPath.slice(0, -ext.length)}.webp`;
  }
  return null;
}

export async function runAssetOptimization(
  options: {
    readonly root?: string;
    readonly write?: boolean;
    readonly quality?: number;
  } = {},
): Promise<AssetOptimizationManifest> {
  const start = performance.now();
  const root = options.root ?? DEFAULT_ROOT;
  const write = options.write === true;
  const quality = options.quality ?? 82;
  const assetsDir = join(root, "docs/assets");

  const generatedWebpSiblings: string[] = [];

  // 1. When --write is enabled, ensure large non-pipeline JPEG/PNG assets have deterministic WebP siblings.
  if (write) {
    const candidates: string[] = [];
    for await (const name of new Glob("*").scan({
      cwd: assetsDir,
      onlyFiles: true,
    })) {
      if (!/\.(?:jpe?g|png)$/i.test(name)) continue;
      if (name.startsWith("pipeline-")) continue; // pipeline-* siblings are owned by generate_pipeline_reference_images.ts
      candidates.push(name);
    }
    candidates.sort();

    await Promise.all(
      candidates.map(async (name) => {
        const srcPath = join(assetsDir, name);
        const ext = extname(name);
        const webpName = `${name.slice(0, -ext.length)}.webp`;
        const webpPath = join(assetsDir, webpName);
        const srcFile = Bun.file(srcPath);
        if (!(await srcFile.exists())) return;
        const encoded = await srcFile.image().webp({ quality }).bytes();
        const existingFile = Bun.file(webpPath);
        let needsWrite = true;
        if (await existingFile.exists()) {
          const prev = new Uint8Array(await existingFile.arrayBuffer());
          if (
            prev.byteLength === encoded.byteLength &&
            sha256Hex(prev) === sha256Hex(encoded)
          ) {
            needsWrite = false;
          }
        }
        if (needsWrite) {
          await Bun.write(webpPath, encoded);
        }
        generatedWebpSiblings.push(`docs/assets/${webpName}`);
      }),
    );
  }

  // 2. Scan all raster assets under docs/assets in deterministic order and inspect concurrently via Bun.file + Bun.Image.
  const relFiles: string[] = [];
  for await (const name of new Glob("*").scan({
    cwd: assetsDir,
    onlyFiles: true,
  })) {
    if (RASTER_EXT_RE.test(name)) {
      relFiles.push(`docs/assets/${name}`);
    }
  }
  relFiles.sort();

  const rawEntries = await Promise.all(
    relFiles.map(async (relPath) => {
      const absPath = join(root, relPath);
      const file = Bun.file(absPath);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = new Bun.Image(bytes);
      const [meta, placeholder] = await Promise.all([
        image.metadata(),
        image.placeholder(),
      ]);
      return {
        relPath,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        format: meta.format,
        contentType: contentTypeFor(meta.format),
        width: meta.width,
        height: meta.height,
        placeholder,
      };
    }),
  );

  const byRel = new Map(rawEntries.map((e) => [e.relPath, e]));

  let totalSourceBytes = 0;
  let totalEffectiveBytes = 0;

  const images: AssetImageEntry[] = rawEntries.map((entry) => {
    const sibRel = siblingWebpRelPath(entry.relPath);
    const sib = sibRel !== null ? (byRel.get(sibRel) ?? null) : null;
    const webpBytes = sib ? sib.bytes : null;
    const savingsPct =
      sib !== null && entry.bytes > 0
        ? Number((((entry.bytes - sib.bytes) / entry.bytes) * 100).toFixed(1))
        : null;

    // Count primary (non-sibling) rasters toward source vs effective WebP transfer budget
    if (entry.format !== "webp") {
      totalSourceBytes += entry.bytes;
      totalEffectiveBytes +=
        webpBytes !== null && webpBytes < entry.bytes ? webpBytes : entry.bytes;
    }

    return {
      path: entry.relPath,
      format: entry.format,
      contentType: entry.contentType,
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      sha256: entry.sha256,
      webpSibling: sib !== null ? sib.relPath : null,
      webpBytes,
      savingsPct,
      placeholder: entry.placeholder,
    };
  });

  const netSavingsBytes = Math.max(0, totalSourceBytes - totalEffectiveBytes);
  const netSavingsPct =
    totalSourceBytes > 0
      ? Number(((netSavingsBytes / totalSourceBytes) * 100).toFixed(1))
      : 0;
  const elapsedMs = Number((performance.now() - start).toFixed(2));

  const manifest: AssetOptimizationManifest = {
    schemaVersion: 1,
    backend: Bun.Image.backend,
    elapsedMs,
    totalSourceBytes,
    totalEffectiveBytes,
    netSavingsBytes,
    netSavingsPct,
    generatedWebpSiblings,
    images,
  };

  if (write) {
    const distManifestPath = join(root, "dist/assets/asset-manifest.json");
    await Bun.write(distManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return manifest;
}

class AssetReportFormatter {
  constructor(private readonly manifest: AssetOptimizationManifest) {}

  [Bun.inspect.custom](): string {
    const rows = this.manifest.images.map((img) => ({
      asset: basename(img.path),
      format: img.format,
      dimensions: `${img.width}×${img.height}`,
      sizeKB: Number((img.bytes / 1024).toFixed(1)),
      webpKB:
        img.webpBytes !== null
          ? Number((img.webpBytes / 1024).toFixed(1))
          : "-",
      saved: img.savingsPct !== null ? `${img.savingsPct}%` : "-",
      lqipBytes: img.placeholder.length,
    }));
    const srcKb = (this.manifest.totalSourceBytes / 1024).toFixed(1);
    const effKb = (this.manifest.totalEffectiveBytes / 1024).toFixed(1);
    return [
      `🖼️  SportsDesk Bun.Image Asset Pipeline (backend=${this.manifest.backend}, ${this.manifest.elapsedMs}ms)`,
      `   Primary payload: ${srcKb} KB → ${effKb} KB with WebP siblings (-${this.manifest.netSavingsPct}%)`,
      Bun.inspect.table(rows),
    ].join("\n");
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      yaml: { type: "boolean", default: false },
      quality: { type: "string", default: "82" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(
      [
        "optimize_assets — Native Bun.file + Bun.Image asset auditor & WebP encoder",
        "",
        "Usage: bun run scripts/optimize_assets.ts [--write] [--quality 82] [--json | --yaml]",
        "",
        "Options:",
        "  --write        Encode deterministic WebP siblings (e.g. ARCH-Guide.webp) & dist/assets/asset-manifest.json",
        "  --quality <n>  WebP quality 1..100 (default: 82)",
        "  --json         Emit machine-readable JSON manifest",
        "  --yaml         Emit Bun.YAML manifest",
      ].join("\n"),
    );
    process.exit(0);
  }

  const qRaw = Number(values.quality ?? "82");
  const quality = Number.isFinite(qRaw)
    ? Math.min(100, Math.max(1, Math.trunc(qRaw)))
    : 82;

  const manifest = await runAssetOptimization({
    write: values.write === true,
    quality,
  });

  if (values.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else if (values.yaml) {
    console.log(YAML.stringify(manifest, null, 2).trimEnd());
  } else {
    console.log(Bun.inspect(new AssetReportFormatter(manifest)));
  }
}
