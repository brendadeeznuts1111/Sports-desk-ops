#!/usr/bin/env bun
/**
 * @file scripts/generate_pipeline_reference_images.ts
 * @description Generates specification-grade SVG & PNG pipeline reference diagrams with rich
 * embedded metadata:
 *   - SVG `<metadata>` containing W3C RDF / Dublin Core (`dc:title`, `dc:creator`, `dc:description`,
 *     `dc:subject`, `dc:identifier`) + Schema.org `ImageObject` / `TechArticle` JSON-LD
 *   - PNG binary chunks (`tEXt` & `iTXt` with CRC32 verification) embedding `Title`, `Author`,
 *     `Description`, `Software`, `Source`, `XML:com.adobe.xmp` (Adobe XMP packet), and
 *     `SportsDesk:PipelineSpecJson` (canonical 10-Mode & 6-Layer JSON specification)
 *   - Sidecar catalog `docs/assets/pipeline-artifacts-metadata.json` with SHA-256 digests,
 *     public Cloudflare R2 URLs, repository paths, upstream module mappings, and CLI commands.
 *
 * Rasterization is a hard gate: the SVG is rendered by a real SVG engine (`rsvg-convert`, then
 * `qlmanage`) and the resulting PNG must pass an ink/color check. If no backend produces visible
 * ink, the script throws. There is no silent "blank banner" fallback — that path produced the
 * text-free grid PNGs this generator used to commit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const repoRoot = path.resolve(import.meta.dirname, "..");
const docsAssetsDir = path.join(repoRoot, "docs", "assets");
const distAssetsDir = path.join(repoRoot, "dist", "assets");
const publicR2Base = "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

Bun.Image.backend = "bun";

fs.mkdirSync(docsAssetsDir, { recursive: true });
fs.mkdirSync(distAssetsDir, { recursive: true });

export interface PipelineArtifactSpec {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly domainsCovered: readonly string[];
  readonly modesCovered: readonly number[];
  readonly upstreamModules: readonly string[];
  readonly cleaningLayers: readonly string[];
  readonly operatorCliCommands: readonly string[];
  readonly renderSvgBody: () => string;
}

// ============================================================================
// CRC32 & PNG tEXt / iTXt CHUNK INJECTOR (RFC 2083 Compliant)
// ============================================================================
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildPngChunk(typeFourCc: string, dataBuf: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(typeFourCc, "ascii");
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function buildPngTextChunk(keyword: string, value: string): Buffer {
  const keyBuf = Buffer.from(keyword.slice(0, 79), "latin1");
  const nul = Buffer.from([0]);
  const valBuf = Buffer.from(value, "latin1");
  return buildPngChunk("tEXt", Buffer.concat([keyBuf, nul, valBuf]));
}

function buildPngItxtChunk(keyword: string, utf8Value: string): Buffer {
  // iTXt: keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text(UTF-8)
  // Empty languageTag + translatedKeyword is 4 bytes after the keyword NUL, so the text follows immediately.
  const keyBuf = Buffer.from(keyword.slice(0, 79), "latin1");
  const header = Buffer.from([0, 0, 0, 0]);
  const textBuf = Buffer.from(utf8Value, "utf8");
  return buildPngChunk("iTXt", Buffer.concat([keyBuf, header, textBuf]));
}

/**
 * `tEXt` is Latin-1 only, so any value with characters outside U+0000..U+00FF (em dashes,
 * arrows, accented names) is written as an uncompressed UTF-8 `iTXt` chunk instead.
 * Readers that only understand `tEXt` still get the ASCII keywords.
 */
function buildPngTextChunkSmart(keyword: string, value: string): Buffer {
  // eslint-disable-next-line no-control-regex
  const isLatin1 = !/[^\u0000-\u00ff]/.test(value);
  return isLatin1
    ? buildPngTextChunk(keyword, value)
    : buildPngItxtChunk(keyword, value);
}

function sha256Hex(buf: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

// ============================================================================
// XML TEXT ESCAPING (the generated SVG must be well-formed XML)
// ============================================================================
/**
 * Escapes a raw string for use in SVG/XML text nodes and attribute values.
 * Spec titles contain `&` (`SPORTSDESK & FANTASY402`), which used to make the
 * committed SVGs unparseable for every conforming renderer.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Average glyph advance as a fraction of font-size, per text class. Menlo is 0.60em, SF ~0.55em. */
const TEXT_CLASS_METRICS: Record<string, { size: number; advance: number }> = {
  title: { size: 24, advance: 0.58 },
  subtitle: { size: 13, advance: 0.6 },
  "col-hdr": { size: 15, advance: 0.58 },
  "card-title": { size: 13.5, advance: 0.58 },
  "card-body": { size: 11.5, advance: 0.6 },
  "card-accent": { size: 11, advance: 0.6 },
  "mono-lg": { size: 13, advance: 0.6 },
  footer: { size: 12.5, advance: 0.6 },
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Guarantees that no `<text>` line runs past the right edge of its enclosing panel/card.
 *
 * The diagram copy is authored for readability (long forensic lines), but a monospace line of
 * 160 characters is wider than a 504px panel. For any line that would overflow, this pass
 * shrinks the font-size proportionally (via inline `style`, which beats the class rule) and
 * pins `textLength` + `lengthAdjust` so the renderer fits it exactly. Without it the raster
 * silently clips the right-hand characters, which is how the old diagrams looked "garbled".
 */
export function fitSvgTextToWidth(
  svgBody: string,
  defaultRightEdge = 1576,
): string {
  const EDGE_MARGIN = 14;
  let rightEdge = defaultRightEdge;

  return svgBody.replace(
    /<rect\b([^>]*)>|<text\b([^>]*)>([^<]*)<\/text>/g,
    (
      whole,
      rectAttrs: string | undefined,
      textAttrs: string | undefined,
      content: string | undefined,
    ) => {
      if (rectAttrs !== undefined) {
        if (/\bclass="(panel|card)"/.test(rectAttrs)) {
          const x = /\bx="([\d.]+)"/.exec(rectAttrs);
          const width = /\bwidth="([\d.]+)"/.exec(rectAttrs);
          if (x && width) rightEdge = Number(x[1]) + Number(width[1]);
        }
        return whole;
      }

      if (textAttrs === undefined || content === undefined) return whole;
      const classMatch = /\bclass="([^"]+)"/.exec(textAttrs);
      const xMatch = /\bx="([\d.]+)"/.exec(textAttrs);
      if (!classMatch || !xMatch) return whole;
      const metrics = TEXT_CLASS_METRICS[classMatch[1]!];
      if (!metrics) return whole;

      const chars = [...decodeXmlEntities(content)].length;
      if (chars === 0) return whole;
      const available = rightEdge - Number(xMatch[1]) - EDGE_MARGIN;
      const estimated = chars * metrics.size * metrics.advance;
      if (estimated <= available) return whole;

      const fittedSize = Math.max(
        8,
        Math.round(((metrics.size * available) / estimated) * 10) / 10,
      );
      const fittedAttrs = `${textAttrs} style="font-size:${fittedSize}px" textLength="${Math.max(1, Math.floor(available))}" lengthAdjust="spacingAndGlyphs"`;
      return `<text${fittedAttrs}>${content}</text>`;
    },
  );
}

// ============================================================================
// PURE-BUN PNG DECODE + INK STATISTICS (used to reject blank rasters)
// ============================================================================
export interface DecodedRaster {
  readonly width: number;
  readonly height: number;
  /** Channels per pixel after decode (always 3 = RGB or 4 = RGBA). */
  readonly channels: 3 | 4;
  readonly pixels: Uint8Array;
  /** Per-pixel alpha when the source had an alpha channel, otherwise null. */
  readonly alpha: Uint8Array | null;
}

export interface PngInkStats {
  readonly width: number;
  readonly height: number;
  readonly uniqueColors: number;
  /** Fraction of pixels differing from the modal (background) color by > 24 in any channel. */
  readonly inkCoverage: number;
  /** Fraction of near-white pixels (luma >= 200): the white diagram text. */
  readonly brightCoverage: number;
  readonly backgroundRgb: readonly [number, number, number];
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Decodes an 8-bit non-interlaced PNG (color types 0/2/4/6 and palette 3) without dependencies. */
export function decodePngToRaster(png: Buffer): DecodedRaster {
  if (!isPng(png))
    throw new Error("decodePngToRaster: buffer is not a PNG (bad signature)");

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0)
    throw new Error("decodePngToRaster: missing or invalid IHDR");
  if (bitDepth !== 8)
    throw new Error(`decodePngToRaster: unsupported bit depth ${bitDepth}`);
  if (interlace !== 0)
    throw new Error("decodePngToRaster: interlaced PNG is not supported");
  if (
    colorType !== 0 &&
    colorType !== 2 &&
    colorType !== 3 &&
    colorType !== 4 &&
    colorType !== 6
  ) {
    throw new Error(`decodePngToRaster: unsupported color type ${colorType}`);
  }

  const sourceChannels =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 6
            ? 4
            : 1;
  const stride = width * sourceChannels;
  // PNG IDAT is a zlib stream (RFC 1950): Bun.inflateSync only handles raw DEFLATE, so use node:zlib.
  const inflated = new Uint8Array(zlib.inflateSync(Buffer.concat(idat)));
  if (inflated.length < (stride + 1) * height) {
    throw new Error(
      `decodePngToRaster: truncated IDAT (${inflated.length} < ${(stride + 1) * height})`,
    );
  }

  const unfiltered = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!;
    const lineOffset = y * (stride + 1) + 1;
    const cur = unfiltered.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const raw = inflated[lineOffset + i]!;
      const a = i >= sourceChannels ? cur[i - sourceChannels]! : 0;
      const b = prev[i]!;
      const c = i >= sourceChannels ? prev[i - sourceChannels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + a;
          break;
        case 2:
          value = raw + b;
          break;
        case 3:
          value = raw + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(
            `decodePngToRaster: invalid scanline filter ${filter} on row ${y}`,
          );
      }
      cur[i] = value & 0xff;
    }
    prev = cur;
  }

  // Palette PNGs (color type 3) expand to RGB through PLTE.
  if (colorType === 3) {
    if (!palette)
      throw new Error("decodePngToRaster: palette PNG without PLTE chunk");
    const pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const idx = unfiltered[i]!;
      pixels[i * 3] = palette[idx * 3] ?? 0;
      pixels[i * 3 + 1] = palette[idx * 3 + 1] ?? 0;
      pixels[i * 3 + 2] = palette[idx * 3 + 2] ?? 0;
    }
    return { width, height, channels: 3, pixels, alpha: null };
  }

  if (sourceChannels === 3) {
    return { width, height, channels: 3, pixels: unfiltered, alpha: null };
  }

  const pixels = new Uint8Array(width * height * 3);
  if (sourceChannels === 4) {
    const alpha = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < unfiltered.length; i += 4, j += 3) {
      pixels[j] = unfiltered[i]!;
      pixels[j + 1] = unfiltered[i + 1]!;
      pixels[j + 2] = unfiltered[i + 2]!;
      alpha[j / 3] = unfiltered[i + 3]!;
    }
    return { width, height, channels: 3, pixels, alpha };
  }
  if (sourceChannels === 2) {
    const alpha = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < unfiltered.length; i += 2, j += 3) {
      pixels[j] = unfiltered[i]!;
      pixels[j + 1] = unfiltered[i]!;
      pixels[j + 2] = unfiltered[i]!;
      alpha[j / 3] = unfiltered[i + 1]!;
    }
    return { width, height, channels: 3, pixels, alpha };
  }
  for (let i = 0, j = 0; i < unfiltered.length; i += 1, j += 3) {
    pixels[j] = unfiltered[i]!;
    pixels[j + 1] = unfiltered[i]!;
    pixels[j + 2] = unfiltered[i]!;
  }
  return { width, height, channels: 3, pixels, alpha: null };
}

/**
 * Counts unique colors, ink coverage (pixels unlike the modal color) and near-white text pixels.
 * Fully transparent pixels are excluded: `qlmanage` pads its square thumbnail canvas with
 * transparent rows, which must not be counted as ink.
 */
export function computePngInkStats(png: Buffer): PngInkStats {
  const { width, height, channels, pixels, alpha } = decodePngToRaster(png);
  const histogram = new Map<number, number>();
  const total = width * height;
  for (let i = 0; i < total; i++) {
    if (alpha && alpha[i]! < 8) continue;
    const p = i * channels;
    const key = (pixels[p]! << 16) | (pixels[p + 1]! << 8) | pixels[p + 2]!;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  let counted = 0;
  for (const count of histogram.values()) counted += count;
  if (counted === 0)
    throw new Error("computePngInkStats: image has no opaque pixels");

  let backgroundKey = 0;
  let backgroundCount = -1;
  for (const [key, count] of histogram) {
    if (count > backgroundCount) {
      backgroundCount = count;
      backgroundKey = key;
    }
  }
  const br = (backgroundKey >> 16) & 0xff;
  const bg = (backgroundKey >> 8) & 0xff;
  const bb = backgroundKey & 0xff;

  let ink = 0;
  let bright = 0;
  for (let i = 0; i < total; i++) {
    if (alpha && alpha[i]! < 8) continue;
    const p = i * channels;
    const r = pixels[p]!;
    const g = pixels[p + 1]!;
    const b = pixels[p + 2]!;
    if (Math.abs(r - br) > 24 || Math.abs(g - bg) > 24 || Math.abs(b - bb) > 24)
      ink++;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b >= 200) bright++;
  }

  return {
    width,
    height,
    uniqueColors: histogram.size,
    inkCoverage: ink / counted,
    brightCoverage: bright / counted,
    backgroundRgb: [br, bg, bb],
  };
}

// ============================================================================
// SVG -> PNG RASTERIZATION (real renderer or loud failure, never a blank card)
// ============================================================================
const RASTER_WIDTH = 1600;
const RASTER_HEIGHT = 920;

/** A raster is accepted only when it contains real ink: many colors and near-white text. */
export interface RasterGate {
  readonly minUniqueColors: number;
  readonly minInkCoverage: number;
  readonly minBrightCoverage: number;
}

export const RASTER_GATE: RasterGate = {
  minUniqueColors: 800,
  minInkCoverage: 0.08,
  minBrightCoverage: 0.008,
};

export function checkRasterGate(
  stats: PngInkStats,
  gate: RasterGate = RASTER_GATE,
): string | null {
  if (!Number.isFinite(stats.inkCoverage)) return "raster stats unavailable";
  if (stats.width < 1200 || stats.height < 800) {
    return `raster ${stats.width}x${stats.height} is smaller than the 1200x800 minimum`;
  }
  if (stats.uniqueColors < gate.minUniqueColors) {
    return `only ${stats.uniqueColors} unique colors (< ${gate.minUniqueColors}) — looks like a flat banner`;
  }
  if (stats.inkCoverage < gate.minInkCoverage) {
    return `ink coverage ${(stats.inkCoverage * 100).toFixed(2)}% (< ${(gate.minInkCoverage * 100).toFixed(0)}%) — looks blank`;
  }
  if (stats.brightCoverage < gate.minBrightCoverage) {
    return `near-white text coverage ${(stats.brightCoverage * 100).toFixed(3)}% (< ${(gate.minBrightCoverage * 100).toFixed(1)}%) — no label text`;
  }
  return null;
}

interface RasterizerAttempt {
  readonly backend: string;
  readonly command: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly png?: Buffer;
  readonly stats?: PngInkStats;
}

interface RasterizedSvg {
  readonly png: Buffer;
  readonly backend: string;
  readonly stats: PngInkStats;
}

function validateRasterCandidate(png: Buffer): {
  stats: PngInkStats | null;
  reason: string | null;
} {
  if (!isPng(png)) return { stats: null, reason: "output is not a PNG" };
  try {
    const stats = computePngInkStats(png);
    return { stats, reason: checkRasterGate(stats) };
  } catch (error) {
    return { stats: null, reason: (error as Error).message };
  }
}

function runRasterizer(
  command: readonly string[],
  timeoutMs = 30_000,
): { status: number; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [...command],
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return {
    status: result.exitCode ?? 1,
    stderr: result.stderr
      ? Buffer.from(result.stderr).toString("utf8").trim()
      : "",
  };
}

function attemptFromOutput(
  backend: string,
  command: readonly string[],
  produced: Buffer | null,
  status: number,
  stderr: string,
): RasterizerAttempt {
  const rendered = command.join(" ");
  if (status !== 0)
    return {
      backend,
      command: rendered,
      ok: false,
      detail: `exit ${status}: ${stderr || "no stderr"}`,
    };
  if (!produced || produced.length === 0)
    return {
      backend,
      command: rendered,
      ok: false,
      detail: "exited 0 but wrote no output",
    };
  const { stats, reason } = validateRasterCandidate(produced);
  if (!stats)
    return {
      backend,
      command: rendered,
      ok: false,
      detail: reason ?? "unreadable output",
    };
  if (reason) return { backend, command: rendered, ok: false, detail: reason };
  return {
    backend,
    command: rendered,
    ok: true,
    detail: `${stats.width}x${stats.height}`,
    png: produced,
    stats,
  };
}

/** `rsvg-convert` renders at the SVG's exact 1600x920 aspect ratio. */
function rasterizeWithRsvgConvert(
  svgPath: string,
  tmpDir: string,
): RasterizerAttempt {
  const outPath = path.join(tmpDir, "rsvg.png");
  const command = [
    "rsvg-convert",
    "--width",
    String(RASTER_WIDTH),
    "--height",
    String(RASTER_HEIGHT),
    "--output",
    outPath,
    svgPath,
  ];
  try {
    const { status, stderr } = runRasterizer(command);
    const produced =
      status === 0 && fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
    return attemptFromOutput("rsvg-convert", command, produced, status, stderr);
  } catch (error) {
    return {
      backend: "rsvg-convert",
      command: command.join(" "),
      ok: false,
      detail: `not runnable: ${(error as Error).message}`,
    };
  }
}

/**
 * `qlmanage` always renders a square thumbnail canvas, so it is only a fallback for hosts without
 * librsvg. It still produces real ink, which is what the gate checks.
 */
function rasterizeWithQlmanage(
  svgPath: string,
  tmpDir: string,
): RasterizerAttempt {
  const command = [
    "qlmanage",
    "-t",
    "-s",
    String(RASTER_WIDTH),
    "-o",
    tmpDir,
    svgPath,
  ];
  try {
    const { status, stderr } = runRasterizer(command);
    const producedPath = path.join(tmpDir, `${path.basename(svgPath)}.png`);
    const produced =
      status === 0 && fs.existsSync(producedPath)
        ? fs.readFileSync(producedPath)
        : null;
    return attemptFromOutput("qlmanage", command, produced, status, stderr);
  } catch (error) {
    return {
      backend: "qlmanage",
      command: command.join(" "),
      ok: false,
      detail: `not runnable: ${(error as Error).message}`,
    };
  }
}

/**
 * Rasterizes an SVG to a verified PNG. Backends run in order and stop at the first verified
 * output, so a fallback can never overwrite a better render. Throws when every backend fails —
 * a broken image must stop the build instead of committing a text-free dark grid.
 */
export function rasterizeSvgToPng(
  svgPath: string,
  outPath: string,
): RasterizedSvg {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sportsdesk-raster-"));
  const attempts: RasterizerAttempt[] = [];
  try {
    const backends = [rasterizeWithRsvgConvert, rasterizeWithQlmanage];
    let winner:
      (RasterizerAttempt & { png: Buffer; stats: PngInkStats }) | null = null;

    for (const backend of backends) {
      const attempt = backend(svgPath, tmpDir);
      attempts.push(attempt);
      if (attempt.ok && attempt.png && attempt.stats) {
        winner = { ...attempt, png: attempt.png, stats: attempt.stats };
        break;
      }
    }

    if (!winner) {
      const report = attempts
        .map((a) => `  • ${a.backend}: ${a.detail}\n    $ ${a.command}`)
        .join("\n");
      throw new Error(
        `SVG rasterization failed for ${path.relative(repoRoot, svgPath)} — refusing to write a blank fallback PNG.\n` +
          `Install librsvg (\`brew install librsvg\`) or run on a host with a working QuickLook SVG renderer.\n${report}`,
      );
    }

    // Gate re-check on the exact bytes that will be committed (metadata chunks are added later).
    const gateFailure = checkRasterGate(winner.stats);
    if (gateFailure) {
      throw new Error(
        `Rasterizer ${winner.backend} produced an unusable PNG for ${svgPath}: ${gateFailure}`,
      );
    }

    fs.writeFileSync(outPath, winner.png);
    return { png: winner.png, backend: winner.backend, stats: winner.stats };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function injectRichMetadataIntoPng(
  pngBuf: Buffer,
  spec: PipelineArtifactSpec,
  xmpXml: string,
  jsonLdString: string,
): Buffer {
  // Strip any previously injected SportsDesk iTXt/tEXt chunks so operation is idempotent
  const signature = pngBuf.subarray(0, 8);
  const chunks: Buffer[] = [signature];
  let offset = 8;
  let injected = false;

  while (offset + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString("ascii");
    const totalChunkLen = 12 + len;
    const rawChunk = pngBuf.subarray(offset, offset + totalChunkLen);

    if (type === "IHDR") {
      chunks.push(rawChunk);
      chunks.push(buildPngTextChunkSmart("Title", spec.title));
      chunks.push(
        buildPngTextChunkSmart(
          "Author",
          "SportsDesk & Fantasy402 Risk Engineering (BILLY666 Master)",
        ),
      );
      chunks.push(buildPngTextChunkSmart("Description", spec.description));
      chunks.push(
        buildPngTextChunkSmart(
          "Software",
          "SportsDesk 10-Mode Forensic & Canonical Pipeline Generator (Bun v1.4.4)",
        ),
      );
      chunks.push(
        buildPngTextChunkSmart(
          "Source",
          `${publicR2Base}/assets/${spec.slug}.svg`,
        ),
      );
      chunks.push(
        buildPngTextChunkSmart(
          "Copyright",
          "SportsDesk Ops Specification-Grade Reference Artifact",
        ),
      );
      chunks.push(buildPngItxtChunk("XML:com.adobe.xmp", xmpXml));
      chunks.push(
        buildPngItxtChunk("SportsDesk:PipelineSpecJson", jsonLdString),
      );
      injected = true;
    } else if (type === "tEXt" || type === "iTXt") {
      // Skip old text chunks so we replace cleanly
    } else {
      chunks.push(rawChunk);
    }
    offset += totalChunkLen;
  }

  if (!injected) {
    throw new Error(
      "injectRichMetadataIntoPng: no IHDR chunk found — refusing to write a PNG without metadata",
    );
  }
  return Buffer.concat(chunks);
}

function buildXmpPacket(spec: PipelineArtifactSpec): string {
  const subject = [...spec.domainsCovered, ...spec.upstreamModules]
    .map((tag) => `<rdf:li>${escapeXmlText(tag)}</rdf:li>`)
    .join("");
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:xmp="http://ns.adobe.com/xap/1.0/"
           xmlns:sportsdesk="https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/ns/1.0/">
    <rdf:Description rdf:about="${publicR2Base}/assets/${spec.slug}.svg">
      <dc:identifier>${escapeXmlText(spec.id)}</dc:identifier>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmlText(spec.title)}</rdf:li></rdf:Alt></dc:title>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmlText(spec.description)}</rdf:li></rdf:Alt></dc:description>
      <dc:creator><rdf:Seq><rdf:li>SportsDesk &amp; Fantasy402 Risk Engineering</rdf:li></rdf:Seq></dc:creator>
      <dc:subject><rdf:Bag>${subject}</rdf:Bag></dc:subject>
      <xmp:CreatorTool>SportsDesk 10-Mode Pipeline Generator (Bun v1.4.4)</xmp:CreatorTool>
      <sportsdesk:modesCovered>${spec.modesCovered.join(",")}</sportsdesk:modesCovered>
      <sportsdesk:cliEntrypoint>${escapeXmlText(spec.operatorCliCommands.join(" | "))}</sportsdesk:cliEntrypoint>
      <sportsdesk:portalUrl>${publicR2Base}/graph.html</sportsdesk:portalUrl>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * JSON-LD lives inside an XML document, so it is wrapped in CDATA: raw `&` and `<` in the
 * description would otherwise make the SVG unparseable for every conforming renderer.
 */
function embedJsonLdInCdata(jsonLdString: string): string {
  return `<![CDATA[${jsonLdString.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function buildFullSvgDocument(
  spec: PipelineArtifactSpec,
  xmpXml: string,
  jsonLdObj: object,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 920" width="1600" height="920" role="img" aria-labelledby="${spec.slug}-title ${spec.slug}-desc">
  <title id="${spec.slug}-title">${escapeXmlText(spec.title)}</title>
  <desc id="${spec.slug}-desc">${escapeXmlText(spec.description)}</desc>
  <metadata>
    ${xmpXml}
    <script type="application/ld+json">${embedJsonLdInCdata(JSON.stringify(jsonLdObj))}</script>
  </metadata>
  <defs>
    <style>
      .bg { fill: #070b14; }
      .panel { fill: #0b1329; stroke-width: 2; rx: 12px; }
      .card { fill: #101c38; stroke-width: 1.5; rx: 8px; }
      .title { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 24px; font-weight: 800; fill: #f8fafc; letter-spacing: 0.03em; }
      .subtitle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; fill: #38bdf8; }
      .col-hdr { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px; font-weight: 800; letter-spacing: 0.05em; }
      .card-title { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13.5px; font-weight: 700; fill: #f8fafc; }
      .card-body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; fill: #cbd5e1; }
      .card-accent { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 700; }
      .mono-lg { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 700; fill: #f8fafc; }
      .footer { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 700; fill: #6ee7b7; }
    </style>
  </defs>
  <rect class="bg" x="0" y="0" width="1600" height="920" />
  <!-- Header Banner -->
  <rect x="24" y="18" width="1552" height="68" rx="10" fill="#0f172a" stroke="#1e293b" stroke-width="1.5" />
  <text x="48" y="48" class="title">${escapeXmlText(spec.title)}</text>
  <text x="48" y="70" class="subtitle">${escapeXmlText(spec.subtitle)} • ID: ${escapeXmlText(spec.id)}</text>
  ${fitSvgTextToWidth(spec.renderSvgBody())}
  <!-- Footer Command Bar -->
  <rect x="24" y="856" width="1552" height="46" rx="8" fill="#06281e" stroke="#10b981" stroke-width="1.8" />
  <text x="48" y="884" class="footer">⚡ OPERATOR CLI &amp; LIVE LINKS: ${escapeXmlText(spec.operatorCliCommands.join("   |   "))}   →   ${publicR2Base}/graph.html</text>
</svg>
`;
}

// ============================================================================
// 4 CANONICAL PIPELINE REFERENCE DIAGRAM SPECIFICATIONS
// ============================================================================
export const PIPELINE_ARTIFACTS: readonly PipelineArtifactSpec[] = [
  {
    id: "SD-ARTIFACT-01-10MODE-PIPELINE",
    slug: "pipeline-10-mode-architecture",
    title:
      "SPORTSDESK & FANTASY402 — DATA CLEANING, 10-MODE ENGINE & OPERATOR ACTION PIPELINE",
    subtitle:
      "End-to-End Flow: 4 Upstream Feeds -> 6-Layer Canonical Cleaner -> 10-Mode Diagnostic Matrix -> Automated Desk Actions",
    description:
      "End-to-end architectural diagram showing how report.js, help-report.js, bet-ticker.js, ip-tracker.js, GSLive Partner 118 (player_[login]), and Polymarket CLOB/Data APIs are cleaned into canonical primitives, evaluated across Modes 1..10 (Risk & Exposure, Identity & Network, Cross-Market, Data Integrity), and converted into sub-320ms Ban-Hammer clamps, Stepped Line dispatches, +15c/+20c vig shading, and $0-gap ledger reconciliations.",
    domainsCovered: [
      "Risk & Exposure",
      "Identity & Network",
      "Cross-Market",
      "Data Integrity",
    ],
    modesCovered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    upstreamModules: [
      "customer/report/report.js",
      "app/manager/report/help-report.js",
      "app/manager/module/bet-ticker.js",
      "app/manager/module/ip-tracker.js",
      "Polymarket Gamma/CLOB/Data API",
      "GSLive Manager Partner 118 (player_[login])",
    ],
    cleaningLayers: [
      "TicketNumber-WagerNumber Parent Grouping",
      "BLOCKED Drop & ALERT Mirror Zeroing",
      "FreePlayFlag='Y' Zero-Principal Loss & Stake/Payout/Liability Split",
      "Teaser Effective Line & DGS ROT+5000 Normalization",
      "Mode B Per-Office customerID=<Office> vs Global 0 & Mode C YYYY-MM-DD",
      "4-Surface Identity Join & 11-Char PaddedCustomerId Write Guard",
    ],
    operatorCliCommands: [
      "./bin/dx status",
      "./bin/dx modes [1..10]",
      "./bin/dx iptracker",
      "./bin/dx deploy",
    ],
    renderSvgBody: () => `
      <!-- COLUMN 1: UPSTREAM FEEDS -->
      <rect class="panel" x="24" y="102" width="368" height="736" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">1. UPSTREAM FEEDS &amp; MODULES</text>

      <rect class="card" x="42" y="150" width="332" height="155" stroke="#06b6d4" />
      <text x="58" y="175" class="card-title">📄 report.js &amp; help-report.js</text>
      <text x="58" y="198" class="card-body">• api/Report/Pending &amp; getPendingByTicket</text>
      <text x="58" y="216" class="card-body">• api/Report/getDailyFiguresByCustomer</text>
      <text x="58" y="234" class="card-body">• api/Report/getGradedWagerByCustomer</text>
      <text x="58" y="252" class="card-body">• api/Report/getTransactions &amp; getGrading</text>
      <text x="58" y="274" class="card-accent" fill="#67e8f9">getTypeInfo(10) • getRotationNumber • getLineGame</text>

      <rect class="card" x="42" y="322" width="332" height="150" stroke="#06b6d4" />
      <text x="58" y="347" class="card-title">⚡ bet-ticker.js (Manager/getBetTicker)</text>
      <text x="58" y="370" class="card-body">• 5,000ms watermark poll (lastWagerNumber)</text>
      <text x="58" y="388" class="card-body">• Dual ID: l.Login (Player) + l.AgentLogin (Office)</text>
      <text x="58" y="406" class="card-body">• Channels: Internet, ALERT, GSLIVE, GSBUILDER</text>
      <text x="58" y="428" class="card-accent" fill="#67e8f9">getListVip • vipListInsert • #D90000 Alert Flag</text>

      <rect class="card" x="42" y="488" width="332" height="155" stroke="#06b6d4" />
      <text x="58" y="513" class="card-title">🌐 ip-tracker.js (Manager/getWebLog)</text>
      <text x="58" y="536" class="card-body">• Mode A: WEB_ACCESS (MM/DD/YYYY)</text>
      <text x="58" y="554" class="card-body">• Mode B: Per-Office (customerID=&lt;Office&gt;) vs 0</text>
      <text x="58" y="572" class="card-body">• Mode C: PLAYER_IP_MATCHER (YYYY-MM-DD)</text>
      <text x="58" y="590" class="card-body">• Mode I: Reverse IP Lookup (ip=&lt;IP&gt;)</text>
      <text x="58" y="612" class="card-accent" fill="#67e8f9">Pivots: go-ip (Mode I) • go-customer (Mode A)</text>

      <rect class="card" x="42" y="660" width="332" height="158" stroke="#06b6d4" />
      <text x="58" y="685" class="card-title">🔗 Polymarket APIs &amp; GSLive Partner 118</text>
      <text x="58" y="708" class="card-body">• CLOB WSS (&lt;500ms SLA: 345ms E2E)</text>
      <text x="58" y="726" class="card-body">• data-api.polymarket.com/v2/positions?user=0x</text>
      <text x="58" y="744" class="card-body">• plive.sportswidgets.pro/manager-tools/</text>
      <text x="58" y="766" class="card-accent" fill="#6ee7b7">39 0x Wallets ↔ 49 F402 Logins ↔ player_[login]</text>

      <!-- COLUMN 2: CANONICAL DATA CLEANING -->
      <rect class="panel" x="418" y="102" width="368" height="736" stroke="#10b981" />
      <text x="438" y="132" class="col-hdr" fill="#6ee7b7">2. 6-LAYER CANONICAL DATA CLEANING</text>

      <rect class="card" x="436" y="150" width="332" height="105" stroke="#10b981" />
      <text x="452" y="173" class="card-title">1. Parent Ticket Grouping</text>
      <text x="452" y="194" class="card-body">Composite key: TicketNumber + "-" + WagerNumber</text>
      <text x="452" y="212" class="card-body">Collapses multi-leg parlay rows so Stake &amp; ToWin</text>
      <text x="452" y="230" class="card-accent" fill="#6ee7b7">are counted 1x per ticket (never multiplied by legs)</text>

      <rect class="card" x="436" y="268" width="332" height="105" stroke="#10b981" />
      <text x="452" y="291" class="card-title">2. Channel &amp; Twin Deduplication</text>
      <text x="452" y="312" class="card-body">Drops BLOCKED sentinel rows pre-grouping;</text>
      <text x="452" y="330" class="card-body">Zeroes ALERT syndicate mirror slips (&lt;=6s twin)</text>
      <text x="452" y="348" class="card-accent" fill="#6ee7b7">canonicalVolumeCents = 0 on ALERT twin rows</text>

      <rect class="card" x="436" y="386" width="332" height="105" stroke="#10b981" />
      <text x="452" y="409" class="card-title">3. Free-Play &amp; Liability Separation</text>
      <text x="452" y="430" class="card-body">FreePlayFlag="Y": Loss = $0 principal debit;</text>
      <text x="452" y="448" class="card-body">Separates Stake ($16.2K), Payout ($67.82K),</text>
      <text x="452" y="466" class="card-accent" fill="#6ee7b7">&amp; Defined Liability ($51.62K) for MJ102</text>

      <rect class="card" x="436" y="504" width="332" height="105" stroke="#10b981" />
      <text x="452" y="527" class="card-title">4. Effective Line &amp; DGS ROT+5000 Math</text>
      <text x="452" y="548" class="card-body">Spread: AdjSpread+Teaser | Total O/U: -/+Teaser</text>
      <text x="452" y="566" class="card-body">Integer LineHundredths (-7.5 -&gt; -750);</text>
      <text x="452" y="584" class="card-accent" fill="#6ee7b7">DGS Child ROT 5501 normalized -&gt; Parent ROT 501</text>

      <rect class="card" x="436" y="622" width="332" height="95" stroke="#10b981" />
      <text x="452" y="645" class="card-title">5. IP-Tracker Mode B &amp; Mode C Hygiene</text>
      <text x="452" y="666" class="card-body">Mode B customerID=&lt;Office&gt; vs "0" (MM/DD/YYYY)</text>
      <text x="452" y="684" class="card-accent" fill="#6ee7b7">Mode C auto-rewrites dates to YYYY-MM-DD</text>

      <rect class="card" x="436" y="728" width="332" height="92" stroke="#10b981" />
      <text x="452" y="751" class="card-title">6. 11-Char Write Padding &amp; Scope Guard</text>
      <text x="452" y="772" class="card-body">padEnd(11, " ") on customerID; direct office</text>
      <text x="452" y="790" class="card-accent" fill="#6ee7b7">agentID (blocks BILLY666 &amp; poisoned path 500s)</text>

      <!-- COLUMN 3: 10-MODE DIAGNOSTIC MATRIX -->
      <rect class="panel" x="812" y="102" width="368" height="736" stroke="#f59e0b" />
      <text x="832" y="132" class="col-hdr" fill="#fcd34d">3. 10-MODE DIAGNOSTIC MATRIX</text>

      <rect class="card" x="830" y="150" width="332" height="175" stroke="#f59e0b" />
      <text x="846" y="175" class="card-title" fill="#fcd34d">DOMAIN A: RISK &amp; EXPOSURE (MODES 1, 8, 9)</text>
      <text x="846" y="198" class="card-body">• Mode 1 · Customer Overview: Validated net,</text>
      <text x="846" y="215" class="card-body">  pending exposure, freshness &amp; gap warnings</text>
      <text x="846" y="236" class="card-body">• Mode 8 · Settled Net: 24H/7D/4WK USD &amp; USDC</text>
      <text x="846" y="253" class="card-body">  P/L + FreePlay saved + ledger adjustments</text>
      <text x="846" y="274" class="card-body">• Mode 9 · Pending Exposure: Unique tickets,</text>
      <text x="846" y="291" class="card-accent" fill="#fcd34d">  Stake vs Potential Payout vs Defined Liability</text>

      <rect class="card" x="830" y="340" width="332" height="225" stroke="#38bdf8" />
      <text x="846" y="365" class="card-title" fill="#7dd3fc">DOMAIN B: IDENTITY &amp; NETWORK (MODES 2–6)</text>
      <text x="846" y="388" class="card-body">• Mode 2 · Access Logs: SELF_PLAYER vs</text>
      <text x="846" y="405" class="card-body">  OFFICE_AGENT Actor/Target &amp; 4.2s wager dwell</text>
      <text x="846" y="426" class="card-body">• Mode 3 · Shared-IP Overview: 13 Office &amp;</text>
      <text x="846" y="443" class="card-body">  Cross-Office /24 subnet groups</text>
      <text x="846" y="464" class="card-body">• Mode 4 · Customer IP History: ASN switches</text>
      <text x="846" y="481" class="card-body">  &amp; &gt;24h collection gap warnings (32.75h)</text>
      <text x="846" y="502" class="card-body">• Mode 5 · Accounts by IP: 104.28.34.12 (5 accts)</text>
      <text x="846" y="523" class="card-accent" fill="#7dd3fc">• Mode 6 · Activity Overlap: 270s Session Overlap</text>
      <text x="846" y="540" class="card-accent" fill="#7dd3fc">  vs 24s Nearby Point Events</text>

      <rect class="card" x="830" y="580" width="332" height="115" stroke="#10b981" />
      <text x="846" y="605" class="card-title" fill="#6ee7b7">DOMAIN C: CROSS-MARKET (MODE 7)</text>
      <text x="846" y="628" class="card-body">• Mode 7 · Wager Comparison: F402 vs Polymarket</text>
      <text x="846" y="646" class="card-body">  by ROT, Period, Side, LineHundredths (Δ=+100)</text>
      <text x="846" y="666" class="card-accent" fill="#6ee7b7">  &amp; Δt=4s with matchReasons &amp; uncertaintyFlags</text>

      <rect class="card" x="830" y="710" width="332" height="110" stroke="#f43f5e" />
      <text x="846" y="735" class="card-title" fill="#fda4af">DOMAIN D: DATA INTEGRITY (MODE 10)</text>
      <text x="846" y="758" class="card-body">• Mode 10 · Reconciliation: DailyFigures vs</text>
      <text x="846" y="776" class="card-body">  GradedTickets vs Ledger (Identical Scope)</text>
      <text x="846" y="796" class="card-accent" fill="#6ee7b7">  Explained Diff -$1,500 • Unresolved Gap = $0.00</text>

      <!-- COLUMN 4: OPERATOR & AUTOMATED DESK ACTIONS -->
      <rect class="panel" x="1206" y="102" width="370" height="736" stroke="#f43f5e" />
      <text x="1226" y="132" class="col-hdr" fill="#fda4af">4. OPERATOR &amp; AUTOMATED ACTIONS</text>

      <rect class="card" x="1224" y="150" width="334" height="155" stroke="#f43f5e" />
      <text x="1240" y="175" class="card-title">🔨 Ban-Hammer Profile Clamp (&lt;320ms)</text>
      <text x="1240" y="198" class="card-body">Triggered by Mode 2 (Dwell &lt;=6s), Mode 3/5</text>
      <text x="1240" y="216" class="card-body">(Shared Office IP), or Mode 6 (Session Overlap):</text>
      <text x="1240" y="238" class="card-accent" fill="#fda4af">• MaxBet = $1,000   • ParlayMaxBet = $0</text>
      <text x="1240" y="256" class="card-accent" fill="#fda4af">• Delay = 6s        • Allow1H2HQtr = 0 (FG-Only)</text>
      <text x="1240" y="278" class="card-body">Verified via getInfoPlayer read-back</text>

      <rect class="card" x="1224" y="322" width="334" height="155" stroke="#f59e0b" />
      <text x="1240" y="347" class="card-title">📉 Stepped Line Dispatcher &amp; Vig Curtain</text>
      <text x="1240" y="370" class="card-body">Triggered by Mode 7 Cross-Market LineDelta</text>
      <text x="1240" y="388" class="card-body">or &lt;500ms CLOB WSS Steam (TXST +14.5 -&gt; +13.0,</text>
      <text x="1240" y="406" class="card-body">KC -1.5 -&gt; -2.5, Patriots Key-7 crossing):</text>
      <text x="1240" y="428" class="card-accent" fill="#fcd34d">• Step half-point at -125/-125 Vig Curtain</text>
      <text x="1240" y="446" class="card-accent" fill="#fcd34d">• Route $312K Key-7 layoff to Wintermute RFQ</text>

      <rect class="card" x="1224" y="494" width="334" height="155" stroke="#a855f7" />
      <text x="1240" y="519" class="card-title">🛡️ +15c/+20c Vig Shading &amp; Probit Guard</text>
      <text x="1240" y="542" class="card-body">Triggered by Mode 8 High-CLV Extractor or</text>
      <text x="1240" y="560" class="card-body">Mode 7 DGS ROT+5000 Same-Game Alt+ML Parlay:</text>
      <text x="1240" y="582" class="card-accent" fill="#e9d5ff">• vigSetupInsert (+15c Spread / +20c Derivative)</text>
      <text x="1240" y="600" class="card-accent" fill="#e9d5ff">• Block Alt+ML Subset when Probit ρ &gt;= 0.65</text>
      <text x="1240" y="620" class="card-body">• Reprice 6pt Key-3/7 Teasers to -135</text>

      <rect class="card" x="1224" y="666" width="334" height="154" stroke="#10b981" />
      <text x="1240" y="691" class="card-title">✅ 180s Quarantine &amp; Mode 10 Settlement</text>
      <text x="1240" y="714" class="card-body">• 180s Quarantine Auto-Resolver reverts</text>
      <text x="1240" y="732" class="card-body">  DEN/PHX U223.5 scalp trap @ T+112s</text>
      <text x="1240" y="754" class="card-body">• Mode 9 sizes hedges on Defined Liability</text>
      <text x="1240" y="776" class="card-accent" fill="#6ee7b7">• Mode 10 confirms Unresolved Gap == $0.00</text>
      <text x="1240" y="794" class="card-accent" fill="#6ee7b7">  before weekly agent balance settlement</text>
    `,
  },
  {
    id: "SD-ARTIFACT-02-6LAYER-CLEANING",
    slug: "pipeline-6-layer-data-cleaning",
    title:
      "ROSETTA STONE 6-LAYER DATA CLEANING & CANONICAL FIELD MAPPING REFERENCE",
    subtitle:
      "De-obfuscated report.js • help-report.js • bet-ticker.js • ip-tracker.js -> Canonical TypeScript Primitives",
    description:
      "Detailed engineering reference diagram illustrating the 6 canonical data-cleaning transformations applied to Fantasy402, GSLive Partner 118, and Polymarket feeds: (1) TicketNumber-WagerNumber composite parent grouping, (2) BLOCKED drop & ALERT mirror zeroing, (3) FreePlayFlag='Y' zero-principal loss & Stake/Payout/Liability separation, (4) Teaser effective line & DGS GameNum+5000 parent rotation normalization, (5) IP-Tracker Mode B Per-Office vs Global & Mode C YYYY-MM-DD date rewrite, and (6) 4-Surface Identity Join with 11-char space-padded PaddedCustomerId write enforcement.",
    domainsCovered: [
      "Risk & Exposure",
      "Identity & Network",
      "Cross-Market",
      "Data Integrity",
    ],
    modesCovered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    upstreamModules: [
      "customer/report/report.js",
      "app/manager/report/help-report.js",
      "app/manager/module/bet-ticker.js",
      "app/manager/module/ip-tracker.js",
    ],
    cleaningLayers: [
      "Layer 1: Composite TicketNumber-WagerNumber Grouping",
      "Layer 2: TicketWriter BLOCKED Drop & ALERT Twin Zeroing",
      "Layer 3: Effective Line Math (LineHundredths & DGS ROT+5000)",
      "Layer 4: FreePlayFlag='Y' Zero-Principal Loss & Liability Split",
      "Layer 5: IP-Tracker Mode B Scope & Mode C YYYY-MM-DD Rewrite",
      "Layer 6: 4-Surface Identity & 11-Char PaddedCustomerId",
    ],
    operatorCliCommands: [
      "./bin/dx modes 7",
      "./bin/dx modes 9",
      "./bin/dx modes 10",
      "bun test tests/forensic_diagnostic_modes.test.ts",
    ],
    renderSvgBody: () => `
      <!-- ROW 1: LAYERS 1, 2, 3 -->
      <rect class="panel" x="24" y="102" width="504" height="356" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">LAYER 1: PARENT TICKET DEDUPLICATION</text>
      <text x="44" y="160" class="card-body">Upstream Source: report.js / help-report.js (api/Report/Pending)</text>
      <rect class="card" x="44" y="176" width="464" height="125" stroke="#1e293b" />
      <text x="60" y="200" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (1 Row Per Leg Repeats Full Ticket Risk):</text>
      <text x="60" y="220" class="card-body">Row 1: Ticket 901104-1 (Leg 1 LAL 1Q) -&gt; AmountWagered: 1620000</text>
      <text x="60" y="238" class="card-body">Row 2: Ticket 901104-1 (Leg 2 LAL -3) -&gt; AmountWagered: 1620000</text>
      <text x="60" y="264" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (evaluateMode9PendingExposure):</text>
      <text x="60" y="284" class="card-body">Group by composite key: d.TicketNumber + "-" + d.WagerNumber</text>
      <text x="44" y="330" class="card-body">• Counts Stake ($16,200) &amp; ToWin ($42,120) strictly 1x per parent ticket</text>
      <text x="44" y="352" class="card-body">• Prevents 2x–6x exposure inflation on multi-leg parlays &amp; teasers</text>
      <text x="44" y="378" class="card-accent" fill="#38bdf8">Used by: Mode 9 (Pending Exposure) &amp; Mode 7 (Combo Hash)</text>

      <rect class="panel" x="548" y="102" width="504" height="356" stroke="#10b981" />
      <text x="568" y="132" class="col-hdr" fill="#6ee7b7">LAYER 2: CHANNEL &amp; TWIN DEDUPLICATION</text>
      <text x="568" y="160" class="card-body">Upstream Source: bet-ticker.js (POST /cloud/api/Manager/getBetTicker)</text>
      <rect class="card" x="568" y="176" width="464" height="125" stroke="#1e293b" />
      <text x="584" y="200" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Sentinel &amp; Syndicate Mirror Duplication):</text>
      <text x="584" y="220" class="card-body">TicketWriter="BLOCKED" noise rows + "ALERT" mirror twin slips</text>
      <text x="584" y="238" class="card-body">emitted within &lt;=6s of primary Internet / GSLIVE / GSBUILDER bet</text>
      <text x="584" y="264" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (L19.N0518 &amp; L21.N0884):</text>
      <text x="584" y="284" class="card-body">Drop BLOCKED pre-grouping; set ALERT canonicalVolumeCents = 0</text>
      <text x="568" y="330" class="card-body">• Preserves ALERT row for sub-250ms syndicate velocity telemetry</text>
      <text x="568" y="352" class="card-body">• Eliminates 100% of twin double-counting in Mode 9 liability</text>
      <text x="568" y="378" class="card-accent" fill="#6ee7b7">Used by: Mode 9 (Pending Exposure) &amp; Tab 5 ROT Bet-Ticker</text>

      <rect class="panel" x="1072" y="102" width="504" height="356" stroke="#f59e0b" />
      <text x="1092" y="132" class="col-hdr" fill="#fcd34d">LAYER 3: EFFECTIVE LINE &amp; DGS ROT+5000 MATH</text>
      <text x="1092" y="160" class="card-body">Upstream Source: report.js getLineGame() &amp; getRotationNumber()</text>
      <rect class="card" x="1092" y="176" width="464" height="125" stroke="#1e293b" />
      <text x="1108" y="200" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Split Teaser Fields &amp; Child Rotation IDs):</text>
      <text x="1108" y="220" class="card-body">Teasers split across AdjSpread/AdjTotalPoints + TeaserPoints;</text>
      <text x="1108" y="238" class="card-body">DGS Alt-Spreads book on GameNum + 5000 (ROT 5501 vs 501)</text>
      <text x="1108" y="264" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (computeEffectiveLineHundredths):</text>
      <text x="1108" y="284" class="card-body">Spread: Adj+Teaser | Over: Adj-Teaser | Under: Adj+Teaser</text>
      <text x="1092" y="330" class="card-body">• Stores exact integer LineHundredths (-7.5 -&gt; -750, 48.5 -&gt; 4850)</text>
      <text x="1092" y="352" class="card-body">• Normalizes ROT 5501 -&gt; Parent ROT 501 for Polymarket matching</text>
      <text x="1092" y="378" class="card-accent" fill="#fcd34d">Used by: Mode 7 (Wager Comparison) &amp; Probit Corr Guard</text>

      <!-- ROW 2: LAYERS 4, 5, 6 -->
      <rect class="panel" x="24" y="480" width="504" height="356" stroke="#a855f7" />
      <text x="44" y="510" class="col-hdr" fill="#e9d5ff">LAYER 4: FREE-PLAY &amp; SIGN NORMALIZATION</text>
      <text x="44" y="538" class="card-body">Upstream Source: help-report.js (FreePlayFlag &amp; getTransactions)</text>
      <rect class="card" x="44" y="554" width="464" height="125" stroke="#1e293b" />
      <text x="60" y="578" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Free-Play Asymmetric Cash Accounting):</text>
      <text x="60" y="598" class="card-body">FreePlayFlag="Y" Loss (WagerStatus="L") debits $0 cash principal;</text>
      <text x="60" y="616" class="card-body">FreePlay Win credits only ToWinAmount (stake is never returned)</text>
      <text x="60" y="642" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (Modes 8, 9 &amp; 10):</text>
      <text x="60" y="662" class="card-body">FreePlay Stake = $0 | Payout = Stake+ToWin | Liability = ToWin</text>
      <text x="44" y="708" class="card-body">• Tracks freePlayLostPrincipalSavedCents ($3,000 on MJ102)</text>
      <text x="44" y="730" class="card-body">• Enforces CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN</text>
      <text x="44" y="756" class="card-accent" fill="#e9d5ff">Used by: Mode 8 (Settled Net), Mode 9, Mode 10 (Reconciliation)</text>

      <rect class="panel" x="548" y="480" width="504" height="356" stroke="#38bdf8" />
      <text x="568" y="510" class="col-hdr" fill="#7dd3fc">LAYER 5: IP-TRACKER MODE &amp; OVERLAP HYGIENE</text>
      <text x="568" y="538" class="card-body">Upstream Source: ip-tracker.js lines 76–89 (Manager/getWebLog)</text>
      <rect class="card" x="568" y="554" width="464" height="125" stroke="#1e293b" />
      <text x="584" y="578" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Overloaded customerID &amp; Date Inversion):</text>
      <text x="584" y="598" class="card-body">Mode B uses customerID=&lt;OfficeAgentID&gt; for Per-Office match vs "0"</text>
      <text x="584" y="616" class="card-body">for Global; Mode C requires YYYY-MM-DD while A/B/I require MM/DD/YYYY</text>
      <text x="584" y="642" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (formatWebLogDateForMode &amp; Mode 6):</text>
      <text x="584" y="662" class="card-body">Auto-formats dates per mode &amp; separates Session vs Point Overlap</text>
      <text x="568" y="708" class="card-body">• Distinguishes 270s Concurrent Session Overlap (MJ102 &lt;-&gt; MJ103)</text>
      <text x="568" y="730" class="card-body">• From 24s Nearby Point Events without session overlap (CHURN_059)</text>
      <text x="568" y="756" class="card-accent" fill="#7dd3fc">Used by: Modes 2, 3, 4, 5, 6 (Identity &amp; Network)</text>

      <rect class="panel" x="1072" y="480" width="504" height="356" stroke="#f43f5e" />
      <text x="1092" y="510" class="col-hdr" fill="#fda4af">LAYER 6: 4-SURFACE ID &amp; 11-CHAR WRITE GUARD</text>
      <text x="1092" y="538" class="card-body">Upstream Source: Manager/updateByColumn &amp; GSLive Partner 118</text>
      <rect class="card" x="1092" y="554" width="464" height="125" stroke="#1e293b" />
      <text x="1108" y="578" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Silent Write No-Ops &amp; Scope Rejection):</text>
      <text x="1108" y="598" class="card-body">Unpadded customerID returns Result: 0 (SILENT_NO_OP); passing</text>
      <text x="1108" y="616" class="card-body">master BILLY666 returns Result: -1; passing path causes HTTP 500</text>
      <text x="1108" y="642" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (padCustomerIdCanonical &amp; Scope Guard):</text>
      <text x="1108" y="662" class="card-body">"MJ102" -&gt; "MJ102      " (11 chars) + direct office agentID="MJ2026"</text>
      <text x="1092" y="708" class="card-body">• Unifies F402 LoginID + Office AgentLogin + GSLive player_[login] + 0x</text>
      <text x="1092" y="730" class="card-body">• Verifies every write via POST /cloud/api/Manager/getInfoPlayer</text>
      <text x="1092" y="756" class="card-accent" fill="#fda4af">Used by: Mode 1 Drill-Downs &amp; Ban-Hammer Mutation Engine</text>
    `,
  },
  {
    id: "SD-ARTIFACT-03-IP-AND-RECONCILIATION",
    slug: "pipeline-per-office-ip-and-reconciliation",
    title:
      "PER-OFFICE IP-TRACKER (MODES 2–6) & SCOPE-LOCKED RECONCILIATION (MODES 1, 8, 9, 10)",
    subtitle:
      "13 Office & Cross-Office IP Clusters (MJ2026, BIGDAD, CUB22HR, ATEAM...) + Zero-Gap Financial Reconciliation",
    description:
      "Reference diagram combining the 13 Per-Office & Cross-Office IP-Tracker clusters (getWebLog Mode B customerID=<OfficeAgentID> vs customerID=0, Mode C YYYY-MM-DD history, Mode I reverse IP, and Mode 6 concurrent session overlap) with the Risk & Data Integrity reconciliation pipeline (Mode 1 Overview, Mode 8 Settled Net, Mode 9 Pending Exposure, and Mode 10 Scope-Locked Reconciliation proving Unresolved Gap = $0.00).",
    domainsCovered: ["Identity & Network", "Risk & Exposure", "Data Integrity"],
    modesCovered: [1, 2, 3, 4, 5, 6, 8, 9, 10],
    upstreamModules: [
      "app/manager/module/ip-tracker.js",
      "app/manager/module/bet-ticker.js",
      "app/manager/report/help-report.js",
    ],
    cleaningLayers: [
      "Per-Office Mode B (customerID=<OfficeAgentID>) vs Global Master (customerID='0')",
      "Mode 6 Concurrent Session Overlap (270s) vs Nearby Point Events (24s)",
      "Mode 10 Identical-Scope Verification (Report DailyFigures vs Settled Tickets vs Ledger)",
    ],
    operatorCliCommands: [
      "./bin/dx iptracker",
      "./bin/dx modes 3",
      "./bin/dx modes 6",
      "./bin/dx modes 10",
    ],
    renderSvgBody: () => `
      <!-- LEFT HALF: PER-OFFICE & CROSS-OFFICE IP-TRACKER PIPELINE (MODES 2-6) -->
      <rect class="panel" x="24" y="102" width="764" height="736" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">LEFT: PER-OFFICE &amp; CROSS-OFFICE IP-TRACKER (MODES 2, 3, 4, 5, 6)</text>

      <rect class="card" x="44" y="150" width="724" height="150" stroke="#06b6d4" />
      <text x="60" y="175" class="card-title" fill="#67e8f9">Mode 3 · Per-Office vs. Global Shared-IP Matcher (ip-tracker.js line 78)</text>
      <text x="60" y="198" class="card-body">• Per-Office Query: POST /cloud/api/Manager/getWebLog { type: "B", agentID: "BILLY666", customerID: "MJ2026" }</text>
      <text x="60" y="216" class="card-body">  -&gt; Returns 5 accounts in MJ2026 on 104.28.34.12 (MJ102, EJ8834, MJ103, EJ8835, MJ101) | Dwell: 4.2s | MFCS: 98/100</text>
      <text x="60" y="238" class="card-body">• Global Cross-Office Query: POST /cloud/api/Manager/getWebLog { type: "B", agentID: "BILLY666", customerID: "0" }</text>
      <text x="60" y="256" class="card-body">  -&gt; Catches CUB22HR (5x) &lt;-&gt; MAX92/MX920_1 &lt;-&gt; BILLY666/CUST_BAY_1..2 on 104.28.55.19 &amp; LAKERS &lt;-&gt; SOUTHSHORE</text>
      <text x="60" y="278" class="card-accent" fill="#6ee7b7">All 13 Clusters Active: MJ2026, BIGDAD, CUB22HR, ATEAM, GPRO50RSK, JUICEPLUS, DAN318, MACHR, GOLD22, TEXANS, SPEN, LAKERS, KOBE24</text>

      <rect class="card" x="44" y="316" width="724" height="155" stroke="#38bdf8" />
      <text x="60" y="341" class="card-title" fill="#7dd3fc">Modes 2, 4 &amp; 5 · Actor/Target Timeline, YYYY-MM-DD IP History &amp; Reverse IP</text>
      <text x="60" y="364" class="card-body">• Mode 2 (Access Logs): Distinguishes SELF_PLAYER (MJ102 Login @ 14:42:07Z -&gt; Wager @ 14:42:11Z, 4.2s dwell)</text>
      <text x="60" y="382" class="card-body">  from OFFICE_AGENT override (Actor=MJ2026 -&gt; Target=MJ102 @ 14:42:18Z executing Ban-Hammer clamp)</text>
      <text x="60" y="404" class="card-body">• Mode 4 (Customer IP History, type="C" YYYY-MM-DD): Tracks MJ102 across 3 IP spans, 2 ASN transitions,</text>
      <text x="60" y="422" class="card-body">  and flags 1 collection gap (32.75h &gt; 24h threshold)</text>
      <text x="60" y="444" class="card-accent" fill="#67e8f9">• Mode 5 (Accounts by IP, type="I"): 104.28.34.12 -&gt; 5 observed accounts (90 total auth/wager hits)</text>

      <rect class="card" x="44" y="488" width="724" height="165" stroke="#a855f7" />
      <text x="60" y="513" class="card-title" fill="#e9d5ff">Mode 6 · Activity Overlap: Concurrent Session Intervals vs. Nearby Point Events</text>
      <text x="60" y="538" class="card-accent" fill="#fda4af">1. CONFIRMED_CONCURRENT_SESSION_OVERLAP (MJ102 [14:40:00Z..14:46:30Z] &lt;-&gt; MJ103 [14:41:10Z..14:45:40Z]):</text>
      <text x="60" y="558" class="card-body">   Bounded session intervals intersect for 270 seconds on 104.28.34.12 -&gt; Clamp entire office ring</text>
      <text x="60" y="586" class="card-accent" fill="#fcd34d">2. NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP (CHURN_059 @ 15:22:48Z &lt;-&gt; CHURN_049 @ 15:23:12Z):</text>
      <text x="60" y="606" class="card-body">   Single bet-ticker point timestamps separated by 24s (0s session overlap) -&gt; Flagged as nearby point window</text>
      <text x="60" y="632" class="card-accent" fill="#6ee7b7">Prevents false session-overlap accusations when only point-in-time bet timestamps are available</text>

      <rect class="card" x="44" y="670" width="724" height="148" stroke="#10b981" />
      <text x="60" y="695" class="card-title" fill="#6ee7b7">4-Surface Identity Join (F402 + Office + GSLive Partner 118 + Polymarket 0x)</text>
      <text x="60" y="720" class="card-body">• F402 Customer &amp; Office : https://fantasy402.com/manager.html?customer=MJ102&amp;agent=MJ2026</text>
      <text x="60" y="742" class="card-body">• GSLive Partner 118     : https://plive.sportswidgets.pro/manager-tools/#/reports/users?partnerId=118&amp;text=player_MJ102</text>
      <text x="60" y="764" class="card-body">• Polymarket On-Chain 0x : https://polymarket.com/profile/0x07db5765beba17be154cbfbd6324a15f3c81fa4f</text>
      <text x="60" y="790" class="card-accent" fill="#6ee7b7">• Write Mutation Wire ID : customerID="MJ102      " (11-char padded) + agentOwner="MJ2026"</text>

      <!-- RIGHT HALF: RISK & DATA INTEGRITY RECONCILIATION PIPELINE (MODES 1, 8, 9, 10) -->
      <rect class="panel" x="812" y="102" width="764" height="736" stroke="#f59e0b" />
      <text x="832" y="132" class="col-hdr" fill="#fcd34d">RIGHT: RISK EXPOSURE &amp; SCOPE-LOCKED RECONCILIATION (MODES 1, 8, 9, 10)</text>

      <rect class="card" x="832" y="150" width="724" height="150" stroke="#f59e0b" />
      <text x="848" y="175" class="card-title" fill="#fcd34d">Mode 1 · Customer Overview &amp; Missing-Data Guardrails</text>
      <text x="848" y="198" class="card-body">• MJ102 (MJ2026)  : Validated Net +$42,850 | Pending Stake $60,600 | Liability $64,120 | Fresh 310s ago (OK)</text>
      <text x="848" y="218" class="card-body">• BGD101 (BIGDAD) : Validated Net +$89,400 | Pending Stake $73,300 | Liability $85,411 | Fresh 455s ago (OK)</text>
      <text x="848" y="238" class="card-body">• CB112_1 (CUB22HR): Validated Net +$31,200 | Pending Stake $63,000 | Liability $57,272 | Fresh 368s ago (OK)</text>
      <text x="848" y="262" class="card-accent" fill="#fda4af">• CHURN_059 (LAKERS): Emits STALE_ACCESS_TELEMETRY_54H + WEBLOG_MODE_A_COLLECTION_GAP warnings</text>

      <rect class="card" x="832" y="316" width="724" height="155" stroke="#10b981" />
      <text x="848" y="341" class="card-title" fill="#6ee7b7">Mode 8 · Settled Net (Period &amp; Currency P/L + Free-Play Principal Convention)</text>
      <text x="848" y="364" class="card-body">Sign Convention: CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN (Book Hold = -SettledSportsNet)</text>
      <text x="848" y="386" class="card-body">• Ticket 899101-1 (7D USD, Standard Win, FreePlay="N"): Stake $22,000 -&gt; Won +$20,000</text>
      <text x="848" y="406" class="card-body">• Ticket 899145-1 (7D USD, FreePlay Win, FreePlay="Y"): Stake $5,000  -&gt; Won +$4,545 (principal excluded)</text>
      <text x="848" y="426" class="card-body">• Ticket 899210-1 (7D USD, FreePlay Loss, FreePlay="Y"): Stake $3,000 -&gt; Lost $0 cash (Saved $3,000 principal)</text>
      <text x="848" y="448" class="card-accent" fill="#6ee7b7">• Net 7D USD: +$24,545 Settled - $1,500 Adj (TXN-ADJ-901) = +$23,045 USD + $19,805 USDC = +$42,850</text>

      <rect class="card" x="832" y="488" width="724" height="150" stroke="#38bdf8" />
      <text x="848" y="513" class="card-title" fill="#7dd3fc">Mode 9 · Pending Exposure (Unique Tickets: Stake vs. Potential Payout vs. Liability)</text>
      <text x="848" y="536" class="card-body">Ingests 4 raw pending rows for MJ102 -&gt; Drops 1 ALERT twin -&gt; Collapses 2 parlay leg rows into 901104-1:</text>
      <text x="848" y="558" class="card-body">• Ticket 901104-1 (2-Leg Parlay, FreePlay="N"): Stake = $16,200 | Liability = $42,120 | Payout = $58,320</text>
      <text x="848" y="578" class="card-body">• Ticket 901188-1 (Straight Bet, FreePlay="Y"): Stake = $0      | Liability = $9,500  | Payout = $9,500</text>
      <text x="848" y="604" class="card-accent" fill="#fcd34d">SEPARATED TOTALS: Cash Stake = $16,200  |  Potential Payout = $67,820  |  Defined Liability = $51,620</text>

      <rect class="card" x="832" y="654" width="724" height="164" stroke="#f43f5e" />
      <text x="848" y="679" class="card-title" fill="#fda4af">Mode 10 · Scope-Locked Reconciliation (DailyFigures vs. GradedTickets vs. Ledger)</text>
      <text x="848" y="702" class="card-body">Identical Scope Lock: 2026-10-25..2026-10-31 (America/Chicago FigureDate Window)</text>
      <text x="848" y="724" class="card-body">• MJ102 : Report DailyFigures (+$24,545) == Settled Tickets (+$24,545) | Ledger Delta (+$23,045)</text>
      <text x="848" y="744" class="card-body">          Explained Difference: -$1,500 (MANUAL_LEDGER_ADJUSTMENT TXN-ADJ-901 wire settlement fee)</text>
      <text x="848" y="766" class="card-body">• BGD101: Report DailyFigures (+$89,400) == Settled Tickets (+$89,400) == Ledger Delta (+$89,400)</text>
      <text x="848" y="792" class="card-accent" fill="#6ee7b7">✅ VERDICT: Unresolved Gap = $0.00 across both accounts (RECONCILED_WITH_EXPLAINED_DIFFS &amp; RECONCILED_EXACT)</text>
    `,
  },
  {
    id: "SD-ARTIFACT-04-DUAL-SURFACE-GSLIVE",
    slug: "pipeline-dual-surface-gslive-model",
    title:
      "DUAL-SURFACE GSLIVE MODEL — BATCH ACCOUNT REPORT vs LIVE BET-HISTORY STREAM",
    subtitle:
      "GSLive Manager Partner 118: #/reports/users (batch) • #/events/bet-history (live) • desk-day window • betTime vs calcTime • `t` cache-buster tick",
    description:
      "Reference model for the two GSLive Partner 118 surfaces and the rule that keeps them from double-counting. The batch surface #/reports/users returns one settled account row per player_[login] per desk day (handle, win/loss, wager count) and is authoritative for booked volume. The live surface #/events/bet-history pushes one event per wager state change, where betTime is the placement wall clock and calcTime is the grade/settle clock, and is authoritative for in-flight exposure and placement velocity. Both are bucketed into the America/Chicago desk day (00:00:00.000-23:59:59.999 CT), joined on (partnerId, login, ticketNumber, betTime), and refreshed with a `t` cache-buster tick (Math.floor(Date.now()/60000)) so a batch re-fetch never serves a stale edge copy and never disturbs the stream.",
    domainsCovered: ["Risk & Exposure", "Cross-Market", "Data Integrity"],
    modesCovered: [1, 7, 8, 9, 10],
    upstreamModules: [
      "GSLive Manager Partner 118 (#/reports/users)",
      "GSLive Manager Partner 118 (#/events/bet-history)",
      "app/manager/module/bet-ticker.js",
    ],
    cleaningLayers: [
      "Desk-Day Bucketing in America/Chicago (00:00:00.000-23:59:59.999 CT)",
      "betTime (placement) vs calcTime (settle) field split",
      "`t` Cache-Buster Tick (Math.floor(Date.now()/60000))",
      "Batch-Over-Stream Precedence for Settled Totals",
      "(partnerId, login, ticketNumber, betTime) Ticket Dedupe",
    ],
    operatorCliCommands: [
      "./bin/dx gslive",
      "./bin/dx modes 7",
      "./bin/dx modes 9",
      "./bin/dx modes 10",
    ],
    renderSvgBody: () => `
      <!-- COLUMN 1: BATCH SURFACE -->
      <rect class="panel" x="24" y="102" width="504" height="736" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">SURFACE A — #/reports/users (BATCH)</text>
      <text x="44" y="154" class="card-body">Pull model: one settled row per player_[login] per desk day</text>

      <rect class="card" x="40" y="168" width="472" height="140" stroke="#06b6d4" />
      <text x="56" y="193" class="card-title">🔗 Endpoint &amp; Query Contract</text>
      <text x="56" y="216" class="card-body">GET /manager-tools/#/reports/users?partnerId=118</text>
      <text x="56" y="234" class="card-body">    &amp;text=player_MJ102&amp;dateFrom=2026-10-25&amp;dateTo=2026-10-31</text>
      <text x="56" y="252" class="card-body">dateFrom/dateTo are desk-day dates (YYYY-MM-DD, CT)</text>
      <text x="56" y="276" class="card-accent" fill="#67e8f9">text= is a substring filter, not an exact login match</text>
      <text x="56" y="296" class="card-body">→ always confirm the returned login == requested login</text>

      <rect class="card" x="40" y="324" width="472" height="140" stroke="#10b981" />
      <text x="56" y="349" class="card-title" fill="#6ee7b7">📄 Payload Shape (account × day)</text>
      <text x="56" y="372" class="card-body">{ login, agentLogin, wagerCount,</text>
      <text x="56" y="390" class="card-body">  handleCents, winLossCents, settledAt }</text>
      <text x="56" y="408" class="card-body">Settled-only: a row appears after the day closes</text>
      <text x="56" y="432" class="card-accent" fill="#6ee7b7">Authoritative for booked handle &amp; settled net</text>
      <text x="56" y="452" class="card-body">No per-bet timestamps and no open-ticket rows</text>

      <rect class="card" x="40" y="480" width="472" height="140" stroke="#f59e0b" />
      <text x="56" y="505" class="card-title" fill="#fcd34d">⏱ Cadence &amp; Cache Posture</text>
      <text x="56" y="528" class="card-body">Refresh on portal open + scheduled desk cron</text>
      <text x="56" y="546" class="card-body">Edge and browser both cache the GET response</text>
      <text x="56" y="564" class="card-body">A plain re-fetch can return yesterday's totals</text>
      <text x="56" y="588" class="card-accent" fill="#fcd34d">Batch is pull-only: no push, no invalidation signal</text>
      <text x="56" y="608" class="card-body">→ pair every batch call with a \`t\` cache-buster</text>

      <rect class="card" x="40" y="636" width="472" height="182" stroke="#f43f5e" />
      <text x="56" y="661" class="card-title" fill="#fda4af">⚠️ Batch-Only Failure Modes</text>
      <text x="56" y="684" class="card-body">• Refetch before cutoff → previous desk-day totals</text>
      <text x="56" y="702" class="card-body">• dateFrom &gt; dateTo → silent empty rows, not an error</text>
      <text x="56" y="720" class="card-body">• substring \`text=\` filter → neighbouring logins leak in</text>
      <text x="56" y="738" class="card-body">• T+N grade lag → settledAt lands after the report day</text>
      <text x="56" y="762" class="card-accent" fill="#fda4af">Never size live liability or velocity from this surface</text>
      <text x="56" y="784" class="card-body">Batch answers "what closed?" — not "what is open now?"</text>
      <text x="56" y="806" class="card-accent" fill="#67e8f9">Gate: reject rows whose login != requested player_ login</text>

      <!-- COLUMN 2: DESK DAY + CACHE BUSTER -->
      <rect class="panel" x="548" y="102" width="504" height="736" stroke="#10b981" />
      <text x="568" y="132" class="col-hdr" fill="#6ee7b7">DESK-DAY WINDOW &amp; \`t\` CACHE-BUSTER</text>
      <text x="568" y="154" class="card-body">One shared clock so batch and stream agree on "today"</text>

      <rect class="card" x="564" y="168" width="472" height="158" stroke="#10b981" />
      <text x="580" y="193" class="card-title" fill="#6ee7b7">🗓 Desk-Day Window (America/Chicago)</text>
      <text x="580" y="216" class="card-body">day = 00:00:00.000 → 23:59:59.999 CT</text>
      <text x="580" y="234" class="card-body">CDT = UTC−5 • CST = UTC−6 (DST follows CT)</text>
      <text x="580" y="252" class="card-body">week = Mon 00:00 CT → Sun 23:59:59.999 CT</text>
      <text x="580" y="276" class="card-accent" fill="#6ee7b7">Batch dateFrom/dateTo are CT calendar dates</text>
      <text x="580" y="296" class="card-body">Convert every stream timestamp to CT before bucketing</text>
      <text x="580" y="314" class="card-body">Never bucket on UTC midnight — it splits the desk day</text>

      <rect class="card" x="564" y="342" width="472" height="152" stroke="#38bdf8" />
      <text x="580" y="367" class="card-title" fill="#7dd3fc">⏱ betTime vs calcTime — Two Questions</text>
      <text x="580" y="390" class="card-body">betTime   = placement wall clock (who bet, when)</text>
      <text x="580" y="408" class="card-body">calcTime  = grade/settle clock (when the book posted)</text>
      <text x="580" y="426" class="card-body">Δ = calcTime − betTime</text>
      <text x="580" y="450" class="card-accent" fill="#7dd3fc">Live: Δ ≈ 0s • Pre-match: seconds • T+N: hours/days</text>
      <text x="580" y="470" class="card-body">calcTime may be null while the ticket is still open</text>
      <text x="580" y="486" class="card-body">→ open ticket: count exposure, never count settled net</text>

      <rect class="card" x="564" y="510" width="472" height="160" stroke="#a855f7" />
      <text x="580" y="535" class="card-title" fill="#e9d5ff">🔁 The \`t\` Cache-Buster Tick</text>
      <text x="580" y="558" class="card-body">…&amp;text=player_MJ102&amp;t=1761912000</text>
      <text x="580" y="576" class="card-body">t = Math.floor(Date.now() / 60000)</text>
      <text x="580" y="594" class="card-body">60s bucket → stable within a minute, fresh across minutes</text>
      <text x="580" y="618" class="card-accent" fill="#e9d5ff">Busts edge + browser cache on the batch GET only</text>
      <text x="580" y="638" class="card-body">The stream is untouched: no reconnect, no replay gap</text>
      <text x="580" y="656" class="card-body">t must never enter the join key or the desk-day bucket</text>

      <rect class="card" x="564" y="686" width="472" height="132" stroke="#f59e0b" />
      <text x="580" y="711" class="card-title" fill="#fcd34d">✅ Allocation Rule (one desk day, one owner)</text>
      <text x="580" y="734" class="card-body">betTime  ↦ desk day of placement   (velocity, count)</text>
      <text x="580" y="752" class="card-body">calcTime ↦ desk day of settlement  (handle, win/loss)</text>
      <text x="580" y="770" class="card-accent" fill="#fcd34d">A settle never rewrites the placement day's report</text>
      <text x="580" y="792" class="card-body">Late calcTime ⇒ moves to tomorrow's batch, not today's</text>
      <text x="580" y="808" class="card-body">Same rule for teasers and parlays: one parent, one day</text>

      <!-- COLUMN 3: JOIN + RECONCILIATION -->
      <rect class="panel" x="1072" y="102" width="504" height="736" stroke="#f59e0b" />
      <text x="1092" y="132" class="col-hdr" fill="#fcd34d">SURFACE B — #/events/bet-history (LIVE)</text>
      <text x="1092" y="154" class="card-body">Push model: one event per wager state change</text>

      <rect class="card" x="1088" y="168" width="472" height="150" stroke="#f59e0b" />
      <text x="1104" y="193" class="card-title" fill="#fcd34d">⚡ Stream Contract</text>
      <text x="1104" y="216" class="card-body">WS/SSE: placed → line-changed → graded → settled</text>
      <text x="1104" y="234" class="card-body">{ ticketNumber, login, betTime, calcTime,</text>
      <text x="1104" y="252" class="card-body">  stakeCents, toWinCents, wagerStatus }</text>
      <text x="1104" y="276" class="card-accent" fill="#fcd34d">calcTime is empty while the bet is in flight</text>
      <text x="1104" y="296" class="card-body">Reconnect must replay from the last seen betTime</text>

      <rect class="card" x="1088" y="334" width="472" height="164" stroke="#38bdf8" />
      <text x="1104" y="359" class="card-title" fill="#7dd3fc">🔗 Join Key &amp; Precedence</text>
      <text x="1104" y="382" class="card-body">key = (partnerId, login, ticketNumber, betTime)</text>
      <text x="1104" y="400" class="card-body">Settled totals on conflict → batch wins (report of record)</text>
      <text x="1104" y="418" class="card-body">Open / in-flight on conflict → stream wins (not booked yet)</text>
      <text x="1104" y="442" class="card-accent" fill="#7dd3fc">Never SUM batch + stream for the same ticketNumber</text>
      <text x="1104" y="462" class="card-body">Stream row with calcTime set and a batch row present ⇒</text>
      <text x="1104" y="480" class="card-body">keep the batch row, drop the stream row (settled once)</text>

      <rect class="card" x="1088" y="514" width="472" height="164" stroke="#10b981" />
      <text x="1104" y="539" class="card-title" fill="#6ee7b7">🧮 Daily Reconciliation Loop</text>
      <text x="1104" y="562" class="card-body">Σ stream settled(calcTime ∈ desk day)</text>
      <text x="1104" y="580" class="card-body">  == batch.handleCents for the same desk day</text>
      <text x="1104" y="598" class="card-body">Explained diffs: T+N grade lag, ledger adjustments</text>
      <text x="1104" y="622" class="card-accent" fill="#6ee7b7">Unresolved gap must be $0.00 before settlement</text>
      <text x="1104" y="642" class="card-body">Unexplained Σ ⇒ replay the stream, then re-pull batch</text>
      <text x="1104" y="660" class="card-body">Re-pull always carries a new \`t\` — never the old URL</text>

      <rect class="card" x="1088" y="694" width="472" height="124" stroke="#f43f5e" />
      <text x="1104" y="719" class="card-title" fill="#fda4af">🛠 Operator Surfaces</text>
      <text x="1104" y="742" class="card-body">Batch:  #/reports/users?partnerId=118&amp;text=player_[login]</text>
      <text x="1104" y="760" class="card-body">Live:   #/events/bet-history (stream)</text>
      <text x="1104" y="778" class="card-accent" fill="#fda4af">./bin/dx gslive • ./bin/dx modes 7 • ./bin/dx modes 9</text>
      <text x="1104" y="798" class="card-body">./bin/dx modes 10 verifies batch == stream for the day</text>
    `,
  },
];

export interface GeneratedArtifactFiles {
  readonly svgRepoPath: string;
  readonly pngRepoPath: string;
  readonly webpRepoPath: string;
  readonly svgPublicR2Url: string;
  readonly pngPublicR2Url: string;
  readonly webpPublicR2Url: string;
  readonly svgBytes: number;
  readonly pngBytes: number;
  readonly webpBytes: number;
  readonly svgSha256: string;
  readonly pngSha256: string;
  readonly webpSha256: string;
  /** The PNG carries the tEXt/iTXt/XMP/JSON-LD chunks; the WebP is a bare re-encode. */
  readonly pngMetadataBearing: true;
  readonly webpMetadataBearing: false;
  readonly pngMimeType: "image/png";
  readonly webpMimeType: "image/webp";
}

export interface GeneratedArtifactRender {
  readonly rasterizer: string;
  readonly width: number;
  readonly height: number;
  readonly uniqueColors: number;
  readonly inkCoverage: number;
  readonly brightCoverage: number;
}

export interface GeneratedArtifactCatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly domainsCovered: readonly string[];
  readonly modesCovered: readonly number[];
  readonly upstreamModules: readonly string[];
  readonly cleaningLayers: readonly string[];
  readonly operatorCliCommands: readonly string[];
  readonly files: GeneratedArtifactFiles;
  readonly render: GeneratedArtifactRender;
  readonly embeddedMetadataStandards: readonly string[];
}

async function encodeWebpFromPng(
  pngBuf: Buffer,
  slug: string,
): Promise<Buffer> {
  const encoded = await new Bun.Image(pngBuf).webp({ quality: 82 }).bytes();
  const webp = Buffer.from(encoded);
  if (
    webp.length < 16 ||
    webp.toString("ascii", 0, 4) !== "RIFF" ||
    webp.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error(
      `WebP encode failed for ${slug}: output is not a RIFF/WEBP container`,
    );
  }
  return webp;
}

/** Copies a file into dist/assets using zero-copy `Bun.write(destFile, srcFile)` (ARCH-Guide JPEG bytes stay untouched). */
async function copyToDist(fileName: string): Promise<void> {
  const srcFile = Bun.file(path.join(docsAssetsDir, fileName));
  if (!(await srcFile.exists())) return;
  await Bun.write(Bun.file(path.join(distAssetsDir, fileName)), srcFile);
}

export async function generateAllPipelineReferenceImages(): Promise<
  readonly GeneratedArtifactCatalogEntry[]
> {
  // ARCH-Guide is an upstream JPEG baseline: it carries no PNG tEXt/iTXt chunks, so it is copied
  // byte-for-byte. Its deterministic WebP sibling (ARCH-Guide.webp) is also ensured via Bun.Image.
  const existingArchFile = Bun.file(path.join(docsAssetsDir, "ARCH-Guide.jpg"));
  if (await existingArchFile.exists()) {
    await copyToDist("ARCH-Guide.jpg");
    const archWebpDocsPath = path.join(docsAssetsDir, "ARCH-Guide.webp");
    const archWebpFile = Bun.file(archWebpDocsPath);
    if (!(await archWebpFile.exists())) {
      const encodedArchWebp = await existingArchFile
        .image()
        .webp({ quality: 82 })
        .bytes();
      await Bun.write(archWebpDocsPath, encodedArchWebp);
    }
    await copyToDist("ARCH-Guide.webp");
    console.log(
      "  • docs/assets/ARCH-Guide.jpg copied unchanged + ARCH-Guide.webp staged via Bun.file/Bun.Image",
    );
  }

  const catalogEntries = await Promise.all(
    PIPELINE_ARTIFACTS.map(
      async (spec): Promise<GeneratedArtifactCatalogEntry> => {
        const xmpXml = buildXmpPacket(spec);
        const jsonLdObj = {
          "@context": "https://schema.org",
          "@type": "ImageObject",
          "@id": `${publicR2Base}/assets/${spec.slug}.svg`,
          identifier: spec.id,
          name: spec.title,
          alternateName: spec.subtitle,
          description: spec.description,
          contentUrl: `${publicR2Base}/assets/${spec.slug}.svg`,
          thumbnailUrl: `${publicR2Base}/assets/${spec.slug}.png`,
          encodingFormat: ["image/svg+xml", "image/png", "image/webp"],
          creator: {
            "@type": "Organization",
            name: "SportsDesk & Fantasy402 Risk Engineering",
          },
          keywords: [
            ...spec.domainsCovered,
            ...spec.upstreamModules,
            ...spec.cleaningLayers,
          ],
          potentialAction: spec.operatorCliCommands,
        };
        const jsonLdString = JSON.stringify(jsonLdObj);

        const svgContent = buildFullSvgDocument(spec, xmpXml, jsonLdObj);
        const svgBuf = Buffer.from(svgContent, "utf8");
        const svgDocsPath = path.join(docsAssetsDir, `${spec.slug}.svg`);
        const svgDistPath = path.join(distAssetsDir, `${spec.slug}.svg`);
        await Promise.all([
          Bun.write(svgDocsPath, svgBuf),
          Bun.write(svgDistPath, svgBuf),
        ]);

        // Real SVG rasterization, verified for ink. Throws instead of writing a blank banner.
        const pngDocsPath = path.join(docsAssetsDir, `${spec.slug}.png`);
        const pngDistPath = path.join(distAssetsDir, `${spec.slug}.png`);
        const raster = rasterizeSvgToPng(svgDocsPath, pngDocsPath);

        const [richPngBuf, webpBuf] = await Promise.all([
          Promise.resolve(
            injectRichMetadataIntoPng(raster.png, spec, xmpXml, jsonLdString),
          ),
          encodeWebpFromPng(raster.png, spec.slug),
        ]);
        const webpDocsPath = path.join(docsAssetsDir, `${spec.slug}.webp`);
        const webpDistPath = path.join(distAssetsDir, `${spec.slug}.webp`);
        await Promise.all([
          Bun.write(pngDocsPath, richPngBuf),
          Bun.write(pngDistPath, richPngBuf),
          Bun.write(webpDocsPath, webpBuf),
          Bun.write(webpDistPath, webpBuf),
        ]);

        return {
          id: spec.id,
          slug: spec.slug,
          title: spec.title,
          subtitle: spec.subtitle,
          description: spec.description,
          domainsCovered: spec.domainsCovered,
          modesCovered: spec.modesCovered,
          upstreamModules: spec.upstreamModules,
          cleaningLayers: spec.cleaningLayers,
          operatorCliCommands: spec.operatorCliCommands,
          files: {
            svgRepoPath: `docs/assets/${spec.slug}.svg`,
            pngRepoPath: `docs/assets/${spec.slug}.png`,
            webpRepoPath: `docs/assets/${spec.slug}.webp`,
            svgPublicR2Url: `${publicR2Base}/assets/${spec.slug}.svg`,
            pngPublicR2Url: `${publicR2Base}/assets/${spec.slug}.png`,
            webpPublicR2Url: `${publicR2Base}/assets/${spec.slug}.webp`,
            svgBytes: svgBuf.length,
            pngBytes: richPngBuf.length,
            webpBytes: webpBuf.length,
            svgSha256: sha256Hex(svgBuf),
            pngSha256: sha256Hex(richPngBuf),
            webpSha256: sha256Hex(webpBuf),
            pngMetadataBearing: true,
            webpMetadataBearing: false,
            pngMimeType: "image/png",
            webpMimeType: "image/webp",
          },
          render: {
            rasterizer: raster.backend,
            width: raster.stats.width,
            height: raster.stats.height,
            uniqueColors: raster.stats.uniqueColors,
            inkCoverage: Number(raster.stats.inkCoverage.toFixed(4)),
            brightCoverage: Number(raster.stats.brightCoverage.toFixed(4)),
          },
          embeddedMetadataStandards: [
            "W3C RDF / Dublin Core (dc:title, dc:description, dc:creator, dc:subject, dc:identifier)",
            "Adobe XMP Packet (XML:com.adobe.xmp)",
            "Schema.org ImageObject JSON-LD (SportsDesk:PipelineSpecJson)",
            "PNG RFC-2083 tEXt & iTXt Chunks with CRC-32 Verification",
            "Cloudflare R2 x-amz-meta-* Custom Object Metadata Headers",
            "WebP sibling carries NO XMP/tEXt chunks (metadataBearing: false) — use the PNG for metadata",
          ],
        };
      },
    ),
  );

  const manifestPayload = {
    schemaVersion: "2026.10.31",
    generatedAtIso: new Date().toISOString(),
    portalPublicUrl: `${publicR2Base}/graph.html`,
    metadataCatalogPublicUrl: `${publicR2Base}/assets/pipeline-artifacts-metadata.json`,
    totalArtifacts: catalogEntries.length,
    formats: {
      svg: {
        mimeType: "image/svg+xml",
        metadataBearing: true,
        role: "source of truth (RDF/XMP/JSON-LD in <metadata>)",
      },
      png: {
        mimeType: "image/png",
        metadataBearing: true,
        role: "download + metadata-bearing raster (tEXt/iTXt/XMP/JSON-LD)",
      },
      webp: {
        mimeType: "image/webp",
        metadataBearing: false,
        role: "lightweight raster sibling; Bun.Image re-encode drops XMP/tEXt",
      },
    },
    artifacts: catalogEntries,
  };

  const manifestJson = JSON.stringify(manifestPayload, null, 2) + "\n";
  await Promise.all([
    Bun.write(
      path.join(docsAssetsDir, "pipeline-artifacts-metadata.json"),
      manifestJson,
    ),
    Bun.write(
      path.join(distAssetsDir, "pipeline-artifacts-metadata.json"),
      manifestJson,
    ),
  ]);

  return catalogEntries;
}

if (import.meta.main) {
  const entries = await generateAllPipelineReferenceImages();
  console.log(
    "================================================================================================================================",
  );
  console.log(
    "  🖼️  GENERATED RICH-METADATA PIPELINE REFERENCE IMAGES (SVG + PNG + WebP + XMP + JSON-LD)",
  );
  console.log(
    "================================================================================================================================",
  );
  for (const e of entries) {
    const { files } = e;
    console.log(
      `  • ${e.id.padEnd(34)} | SVG ${String(files.svgBytes).padStart(6)} B | PNG ${String(files.pngBytes).padStart(6)} B | WebP ${String(files.webpBytes).padStart(6)} B\n` +
        `      raster=${e.render.rasterizer} ${e.render.width}x${e.render.height} uniqueColors=${e.render.uniqueColors} ` +
        `ink=${(e.render.inkCoverage * 100).toFixed(2)}% bright=${(e.render.brightCoverage * 100).toFixed(2)}%`,
    );
  }
  console.log(
    "================================================================================================================================",
  );
}
