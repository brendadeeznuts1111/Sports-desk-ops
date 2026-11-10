/**
 * @file lib/docs_render_cache.ts
 * @description Render a Markdown tree to HTML with a content-addressed cache.
 *
 * The cache key covers the Bun version, the parser options and the file bytes. Hashing only the
 * bytes (the obvious version) silently reuses HTML produced by a different renderer or a different
 * option set after an upgrade.
 *
 * `Bun.zstdCompress` returns a Promise. Both `Bun.write(path, promise)` and `promise.byteLength`
 * accept it without complaining and produce useless output, so this module only ever writes a
 * value it has awaited or produced with `Bun.zstdCompressSync`.
 */

import { Glob } from "bun";
import { rename } from "node:fs/promises";
import { join } from "node:path";

export const MAX_MARKDOWN_BYTES = 1_000_000;

/**
 * Options for documentation output: trusted content, so `noHtml*` is belt and braces rather than
 * the primary boundary, and `tagFilter` is left on for GFM compatibility. `headings` carries both
 * fields because the type requires them; `true` would also autolink every heading.
 */
export const DOCS_RENDER_OPTIONS = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  tagFilter: true,
  noHtmlBlocks: true,
  noHtmlSpans: true,
  headings: { autolink: false, ids: true },
  collapseWhitespace: true,
} as const satisfies Bun.markdown.Options;

export interface RenderedDoc {
  /** Cache key: sha256 over Bun version, parser options and file bytes. */
  readonly key: string;
  /** Path relative to the scanned directory. */
  readonly rel: string;
  readonly sourceBytes: number;
  readonly htmlBytes: number;
  readonly zstdBytes: number;
  /** True when the HTML came from the cache instead of the parser. */
  readonly cached: boolean;
}

export interface ManifestEntry {
  readonly sources: readonly string[];
  readonly htmlBytes: number;
  readonly zstdBytes: number;
}

export interface DocsManifest {
  readonly version: 1;
  /** Content hash of `entries`, so an unchanged build keeps the same id. */
  readonly buildId: string;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
}

export class MarkdownTooLargeError extends Error {
  constructor(
    readonly rel: string,
    readonly bytes: number,
  ) {
    super(
      `${rel} is ${bytes} bytes (limit ${MAX_MARKDOWN_BYTES}); refusing to parse`,
    );
    this.name = "MarkdownTooLargeError";
  }
}

/**
 * sha256 over Bun version, parser options and file bytes.
 *
 * The version and option text are length-prefixed so a change in either cannot be cancelled out by
 * a change in the other (for example `1.4.4` + `{}` must not collide with `1.4` + `4{}`).
 */
export function docsCacheKey(
  bytes: Uint8Array | ArrayBuffer,
  bunVersion: string = Bun.version,
  options: Bun.markdown.Options = DOCS_RENDER_OPTIONS,
): string {
  const version = `${bunVersion}`;
  const optionsJson = JSON.stringify(options);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `${version.length}:${version}${optionsJson.length}:${optionsJson}`,
  );
  hasher.update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
  return hasher.digest("hex");
}

/** Write via a sibling temporary file so a crash cannot leave a truncated cache entry. */
async function writeAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await Bun.write(tmp, data);
  await rename(tmp, path);
}

async function renderOne(
  dir: string,
  cacheDir: string,
  rel: string,
  dryRun: boolean,
): Promise<RenderedDoc> {
  const buffer = await Bun.file(join(dir, rel)).arrayBuffer();
  if (buffer.byteLength > MAX_MARKDOWN_BYTES) {
    throw new MarkdownTooLargeError(rel, buffer.byteLength);
  }

  const key = docsCacheKey(buffer);
  const htmlPath = join(cacheDir, `${key}.html`);
  const zstdPath = join(cacheDir, `${key}.html.zst`);

  let html: string;
  let cached: boolean;
  if (await Bun.file(htmlPath).exists()) {
    html = await Bun.file(htmlPath).text();
    cached = true;
  } else {
    // trusted-markdown: repo docs/ sources only; the result is a static file, not a DOM sink.
    html = Bun.markdown.html(buffer, DOCS_RENDER_OPTIONS);
    if (!dryRun) await writeAtomic(htmlPath, html);
    cached = false;
  }

  let zstdBytes = 0;
  const zstdFile = Bun.file(zstdPath);
  if (await zstdFile.exists()) {
    zstdBytes = zstdFile.size;
  } else if (!dryRun) {
    // Sync on purpose: the async form is a Promise, and writing that Promise stores text.
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(html));
    await writeAtomic(zstdPath, compressed);
    zstdBytes = compressed.byteLength;
  }

  return {
    key,
    rel,
    sourceBytes: buffer.byteLength,
    htmlBytes: Buffer.byteLength(html),
    zstdBytes,
    cached,
  };
}

/**
 * Render every `**\/*.md` under `dir`.
 *
 * Files are visited in sorted order so console output and cache writes are reproducible. A file
 * over the limit fails loudly instead of being truncated or skipped.
 */
export async function renderDocsTree(options: {
  readonly dir: string;
  readonly cacheDir: string;
  /** Compute what would be rendered without touching the cache. */
  readonly dryRun?: boolean;
}): Promise<readonly RenderedDoc[]> {
  const rels: string[] = [];
  for await (const rel of new Glob("**/*.md").scan({
    cwd: options.dir,
    onlyFiles: true,
  })) {
    rels.push(rel);
  }
  rels.sort();

  const RENDER_CONCURRENCY = 16;
  const rendered: RenderedDoc[] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < rels.length) {
      const idx = nextIdx++;
      const rel = rels[idx];
      if (rel === undefined) continue;
      rendered[idx] = await renderOne(
        options.dir,
        options.cacheDir,
        rel,
        options.dryRun === true,
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(RENDER_CONCURRENCY, rels.length) }, () =>
      worker(),
    ),
  );
  return rendered;
}

export const MANIFEST_FILE = "manifest.json";

/**
 * Build the build/serve bridge document.
 *
 * Entries are keyed by cache key and sorted, and `buildId` is a hash of that canonical JSON, so an
 * unchanged tree produces a byte-identical manifest. Two documents with identical bytes share one
 * entry and are listed under `sources` instead of silently overwriting each other.
 */
export function buildDocsManifest(
  rendered: readonly RenderedDoc[],
): DocsManifest {
  const merged = new Map<
    string,
    { sources: string[]; htmlBytes: number; zstdBytes: number }
  >();
  for (const doc of rendered) {
    const current = merged.get(doc.key);
    if (current) {
      current.sources.push(doc.rel);
    } else {
      merged.set(doc.key, {
        sources: [doc.rel],
        htmlBytes: doc.htmlBytes,
        zstdBytes: doc.zstdBytes,
      });
    }
  }

  const entries: Record<string, ManifestEntry> = {};
  for (const key of [...merged.keys()].sort()) {
    const value = merged.get(key)!;
    entries[key] = {
      sources: [...value.sources].sort(),
      htmlBytes: value.htmlBytes,
      zstdBytes: value.zstdBytes,
    };
  }

  const buildId = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return { version: 1, buildId, entries };
}

export async function writeDocsManifest(
  path: string,
  manifest: DocsManifest,
): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Parse and validate a manifest. Shape checking happens here, not at every request. */
export async function readDocsManifest(path: string): Promise<DocsManifest> {
  const raw: unknown = await Bun.file(path).json();
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path}: manifest is not an object`);
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate["version"] !== 1) {
    throw new Error(
      `${path}: unsupported manifest version ${String(candidate["version"])}`,
    );
  }
  if (typeof candidate["buildId"] !== "string" || candidate["buildId"] === "") {
    throw new Error(`${path}: manifest is missing buildId`);
  }
  const rawEntries = candidate["entries"];
  if (typeof rawEntries !== "object" || rawEntries === null) {
    throw new Error(`${path}: manifest is missing entries`);
  }

  const entries: Record<string, ManifestEntry> = {};
  for (const [key, value] of Object.entries(
    rawEntries as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${path}: entry ${key} is not an object`);
    }
    const entry = value as Record<string, unknown>;
    const sources = entry["sources"];
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      !sources.every((source) => typeof source === "string")
    ) {
      throw new Error(`${path}: entry ${key} has no sources`);
    }
    const htmlBytes = entry["htmlBytes"];
    const zstdBytes = entry["zstdBytes"];
    if (typeof htmlBytes !== "number" || typeof zstdBytes !== "number") {
      throw new Error(`${path}: entry ${key} has non-numeric sizes`);
    }
    entries[key] = { sources: sources as string[], htmlBytes, zstdBytes };
  }

  return { version: 1, buildId: candidate["buildId"], entries };
}
