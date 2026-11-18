#!/usr/bin/env bun
/**
 * @file scripts/image_asset_diagnostics.ts
 * @description Print `Bun.Image` asset attributes and optionally write deterministic WebP thumbnails.
 *
 * Metadata reads the header only, so the default scan does not decode pixels; `--placeholders`
 * opts into the ThumbHash decode and `--thumbs` opts into a resize + WebP encode. Entry and
 * thumbnail paths are masked per the selected visibility tier. Exit 1 when a file is oversized,
 * undecodable, or a thumbnail cannot be written, so the command can gate a build.
 *
 * Run: bun run assets:diagnostics [dir ...] [options]   (see --help)
 */

import { useColor } from "../lib/ansi_color.ts";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  scanBunImageAssetFiles,
  scanBunImageAssetPaths,
  type BunImageAssetFile,
  type BunImageAssetScanFailure,
} from "../lib/bun_image_assets.ts";
import {
  DEFAULT_THUMBNAIL_EDGE,
  DEFAULT_THUMBNAIL_QUALITY,
  MAX_THUMBNAIL_EDGE,
  thumbnailDestination,
  writeWebpThumbnail,
  type BunImageBackend,
} from "../lib/bun_thumbnail.ts";
import { formatByteCount } from "../lib/format_bytes.ts";
import {
  INSPECT_VISIBILITIES,
  type InspectVisibility,
} from "../lib/inspect_redactor.ts";
import { maskAssetSource } from "../lib/inspect_diagnostics.ts";
import {
  DEFAULT_ASSET_ROOT,
  TOOL_VERSION,
  USAGE,
} from "./image_asset_cli_spec.ts";

const VISIBILITY_NAMES = new Set<string>(INSPECT_VISIBILITIES);
const SORT_MODES = ["name", "size"] as const;
type SortMode = (typeof SORT_MODES)[number];
const BACKEND_MODES = ["bun", "system"] as const;

interface ParsedArgs {
  readonly dirs: readonly string[];
  readonly json: boolean;
  readonly summary: boolean;
  readonly limit: number | undefined;
  readonly maxBytes: number | undefined;
  readonly headerBytes: number | undefined;
  readonly budgetBytes: number | undefined;
  readonly maxDimension: number | undefined;
  readonly recursive: boolean;
  readonly filter: string | undefined;
  readonly exclude: string | undefined;
  readonly sort: SortMode;
  readonly placeholders: boolean;
  readonly visibility: InspectVisibility;
  readonly backend: BunImageBackend | undefined;
  readonly thumbs: number | null;
  readonly thumbsDir: string | undefined;
  readonly thumbQuality: number;
  readonly fail: boolean;
  readonly color: boolean;
}

interface ThumbnailWritten {
  readonly ok: true;
  readonly source: string;
  readonly destination: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly backend: string;
}

interface ThumbnailFailed {
  readonly ok: false;
  readonly source: string;
  readonly error: string;
}

type ThumbnailOutcome = ThumbnailWritten | ThumbnailFailed;

interface DirectoryReport {
  readonly root: string;
  readonly total: number;
  readonly truncated: boolean;
  readonly failures: number;
  readonly files: readonly BunImageAssetFile[];
  readonly thumbnails: readonly ThumbnailOutcome[];
  readonly thumbnailFailures: number;
}

type ResolvedInput =
  | { readonly label: string; readonly kind: "dir"; readonly dir: string }
  | {
      readonly label: string;
      readonly kind: "paths";
      readonly paths: readonly string[];
    };

/** Positional args may be directories, single files, or globs already expanded by Bun.Glob. */
function resolveInputs(args: readonly string[]): readonly ResolvedInput[] {
  return args.map((arg): ResolvedInput => {
    let isDirectory = false;
    let isFile = false;
    try {
      const stat = statSync(arg);
      isDirectory = stat.isDirectory();
      isFile = stat.isFile();
    } catch {
      // Not an existing path; a glob or a directory the scanner will report as empty.
    }
    if (isDirectory) return { label: arg, kind: "dir", dir: arg };
    if (isFile) return { label: arg, kind: "paths", paths: [arg] };
    if (
      arg.includes("*") ||
      arg.includes("?") ||
      arg.includes("[") ||
      arg.includes("{")
    ) {
      const globAt = arg.search(/[*?[\]{}]/);
      const prefix = globAt === -1 ? arg : arg.slice(0, globAt);
      const slash = prefix.lastIndexOf("/");
      const base = slash === -1 ? "." : prefix.slice(0, slash) || "/";
      const pattern = slash === -1 ? arg : arg.slice(slash + 1);
      const matches = [
        ...new Bun.Glob(pattern).scanSync({
          cwd: base,
          onlyFiles: true,
          dot: false,
        }),
      ]
        .map((relative) => join(base, relative))
        .sort();
      return { label: arg, kind: "paths", paths: matches };
    }
    return { label: arg, kind: "dir", dir: arg };
  });
}

const BUDGET_CODE = "ERR_ASSET_BUDGET_EXCEEDED";
const DIMENSION_CODE = "ERR_ASSET_DIMENSION_EXCEEDED";

/** Converts over-budget assets into failure entries, so the exit code follows the gate. */
function applyBudgets(
  file: BunImageAssetFile,
  args: ParsedArgs,
): BunImageAssetFile {
  if (file.entry.type !== "BunImageAssetDiagnostic") return file;
  let code: string | null = null;
  if (
    args.budgetBytes !== undefined &&
    (file.entry.bytes ?? 0) > args.budgetBytes
  ) {
    code = BUDGET_CODE;
  } else if (
    args.maxDimension !== undefined &&
    (file.entry.width > args.maxDimension ||
      file.entry.height > args.maxDimension)
  ) {
    code = DIMENSION_CODE;
  }
  if (code === null) return file;
  const entry: BunImageAssetScanFailure = Object.freeze({
    type: "BunImageAssetScanFailure",
    source: file.entry.source,
    code,
  });
  return Object.freeze({ path: file.path, entry });
}

function isVisibility(value: string): value is InspectVisibility {
  return VISIBILITY_NAMES.has(value);
}

function isSortMode(value: string): value is SortMode {
  return (SORT_MODES as readonly string[]).includes(value);
}

function isBackend(value: string): value is BunImageBackend {
  return (BACKEND_MODES as readonly string[]).includes(value);
}

function intInRange(
  name: string,
  raw: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer in ${minimum}..${maximum}, got "${raw}"`,
    );
  }
  return value;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const dirs: string[] = [];
  let json = false;
  let summary = false;
  let limit: number | undefined;
  let maxBytes: number | undefined;
  let headerBytes: number | undefined;
  let budgetBytes: number | undefined;
  let maxDimension: number | undefined;
  let recursive = false;
  let filter: string | undefined;
  let exclude: string | undefined;
  let sort: SortMode = "name";
  let placeholders = false;
  let visibility: InspectVisibility = "RISK_MANAGER";
  let backend: BunImageBackend | undefined;
  let thumbs: number | null = null;
  let thumbsDir: string | undefined;
  let thumbQuality = DEFAULT_THUMBNAIL_QUALITY;
  let thumbQualitySet = false;
  let fail = true;
  let color = true;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      continue; // handled before parsing
    } else if (arg === "-v" || arg === "--version") {
      continue; // handled before parsing
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--summary") {
      summary = true;
    } else if (arg === "--recursive" || arg === "-r") {
      recursive = true;
    } else if (arg === "--placeholders") {
      placeholders = true;
    } else if (arg === "--no-fail") {
      fail = false;
    } else if (arg === "--no-color") {
      color = false;
    } else if (arg === "--thumbs") {
      thumbs = DEFAULT_THUMBNAIL_EDGE;
    } else if (arg.startsWith("--thumbs=")) {
      thumbs = intInRange(
        "--thumbs",
        arg.slice("--thumbs=".length),
        1,
        MAX_THUMBNAIL_EDGE,
      );
    } else if (arg.startsWith("--thumbs-dir=")) {
      const value = arg.slice("--thumbs-dir=".length).trim();
      if (value === "") throw new Error("--thumbs-dir must not be empty");
      thumbsDir = value;
    } else if (arg.startsWith("--thumb-quality=")) {
      thumbQuality = intInRange(
        "--thumb-quality",
        arg.slice("--thumb-quality=".length),
        1,
        100,
      );
      thumbQualitySet = true;
    } else if (arg.startsWith("--limit=")) {
      limit = intInRange("--limit", arg.slice("--limit=".length), 1, 100);
    } else if (arg.startsWith("--max-bytes=")) {
      maxBytes = intInRange(
        "--max-bytes",
        arg.slice("--max-bytes=".length),
        1,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (arg.startsWith("--header-bytes=")) {
      headerBytes = intInRange(
        "--header-bytes",
        arg.slice("--header-bytes=".length),
        1,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (arg.startsWith("--filter=")) {
      const value = arg.slice("--filter=".length).trim();
      filter = value === "" ? undefined : value;
    } else if (arg.startsWith("--exclude=")) {
      const value = arg.slice("--exclude=".length).trim();
      exclude = value === "" ? undefined : value;
    } else if (arg.startsWith("--budget-bytes=")) {
      budgetBytes = intInRange(
        "--budget-bytes",
        arg.slice("--budget-bytes=".length),
        1,
        Number.MAX_SAFE_INTEGER,
      );
    } else if (arg.startsWith("--max-dimension=")) {
      maxDimension = intInRange(
        "--max-dimension",
        arg.slice("--max-dimension=".length),
        1,
        MAX_THUMBNAIL_EDGE,
      );
    } else if (arg.startsWith("--sort=")) {
      const value = arg.slice("--sort=".length);
      if (!isSortMode(value)) {
        throw new Error(
          `--sort must be one of ${SORT_MODES.join(", ")}, got "${value}"`,
        );
      }
      sort = value;
    } else if (arg.startsWith("--visibility=")) {
      const value = arg.slice("--visibility=".length);
      if (!isVisibility(value)) {
        throw new Error(
          `--visibility must be one of ${INSPECT_VISIBILITIES.join(", ")}, got "${value}"`,
        );
      }
      visibility = value;
    } else if (arg.startsWith("--backend=")) {
      const value = arg.slice("--backend=".length);
      if (!isBackend(value)) {
        throw new Error(
          `--backend must be one of ${BACKEND_MODES.join(", ")}, got "${value}"`,
        );
      }
      backend = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}"`);
    } else {
      dirs.push(arg);
    }
  }

  if (thumbsDir !== undefined && thumbs === null) {
    throw new Error("--thumbs-dir requires --thumbs");
  }
  if (thumbQualitySet && thumbs === null) {
    throw new Error("--thumb-quality requires --thumbs");
  }
  if (headerBytes !== undefined && placeholders) {
    throw new Error("--header-bytes cannot be combined with --placeholders");
  }

  return {
    dirs: dirs.length === 0 ? [DEFAULT_ASSET_ROOT] : dirs,
    json,
    summary,
    limit,
    maxBytes,
    headerBytes,
    budgetBytes,
    maxDimension,
    recursive,
    filter,
    exclude,
    sort,
    placeholders,
    visibility,
    backend,
    thumbs,
    thumbsDir,
    thumbQuality,
    fail,
    color,
  };
}

function bytesOf(file: BunImageAssetFile): number {
  return file.entry.type === "BunImageAssetScanFailure"
    ? 0
    : (file.entry.bytes ?? 0);
}

/** Error codes only: a raw message can quote the absolute destination path. */
function errorCodeOf(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "ERR_THUMBNAIL_WRITE";
}

async function buildReport(
  input: ResolvedInput,
  args: ParsedArgs,
): Promise<DirectoryReport> {
  // A size sort must see every candidate before the requested limit is applied.
  const scanLimit = args.sort === "size" ? 100 : args.limit;
  const scanOptions = {
    limit: scanLimit,
    maxBytes: args.maxBytes,
    headerBytes: args.headerBytes,
    visibility: args.visibility,
    placeholders: args.placeholders,
  };
  const scan =
    input.kind === "dir"
      ? await scanBunImageAssetFiles(input.dir, {
          ...scanOptions,
          recursive: args.recursive,
          filter: args.filter,
          exclude: args.exclude,
        })
      : await scanBunImageAssetPaths(input.paths, scanOptions);
  const ordered =
    args.sort === "size"
      ? [...scan.files].sort((a, b) => bytesOf(b) - bytesOf(a))
      : scan.files;
  const limited =
    args.limit === undefined ? ordered : ordered.slice(0, args.limit);
  const files = limited.map((file) => applyBudgets(file, args));

  let failures = 0;
  for (const file of files) {
    if (file.entry.type === "BunImageAssetScanFailure") failures += 1;
  }

  const thumbnails: ThumbnailOutcome[] = [];
  let thumbnailFailures = 0;
  if (args.thumbs !== null) {
    const thumbsRoot =
      input.kind === "dir" ? input.dir : dirname(input.paths[0] ?? ".");
    const thumbsDir = args.thumbsDir ?? join(thumbsRoot, ".thumbs");
    for (const file of files) {
      if (file.entry.type !== "BunImageAssetDiagnostic") continue;
      const destination = thumbnailDestination(
        thumbsRoot,
        file.path,
        thumbsDir,
      );
      try {
        const thumb = await writeWebpThumbnail(file.path, destination, {
          maxEdge: args.thumbs,
          quality: args.thumbQuality,
          backend: args.backend ?? "bun",
        });
        thumbnails.push(
          Object.freeze({
            ok: true as const,
            source: file.path,
            destination,
            bytes: thumb.bytesWritten,
            width: thumb.width,
            height: thumb.height,
            backend: thumb.backend,
          }),
        );
      } catch (error) {
        thumbnailFailures += 1;
        thumbnails.push(
          Object.freeze({
            ok: false as const,
            source: file.path,
            error: errorCodeOf(error),
          }),
        );
      }
    }
  }

  return {
    root: input.label,
    total: scan.total,
    truncated: scan.total > files.length,
    failures,
    files,
    thumbnails,
    thumbnailFailures,
  };
}

function printText(
  reports: readonly DirectoryReport[],
  args: ParsedArgs,
  color: boolean,
): void {
  for (const report of reports) {
    const suffix = report.truncated
      ? ` (showing ${report.files.length} of ${report.total})`
      : "";
    console.log(
      `Image assets · ${report.root} · ${report.files.length}${suffix} · visibility=${args.visibility}` +
        (args.headerBytes === undefined
          ? ""
          : ` · header≤${args.headerBytes} B`),
    );
    if (args.summary) {
      const thumbs =
        args.thumbs === null
          ? ""
          : ` · thumbnails=${report.thumbnails.length - report.thumbnailFailures}` +
            (report.thumbnailFailures > 0
              ? ` thumbFailures=${report.thumbnailFailures}`
              : "");
      console.log(
        `  total=${report.total} · failures=${report.failures} · shown=${report.files.length}${thumbs}`,
      );
      console.log("");
      continue;
    }
    for (const file of report.files) {
      console.log(Bun.inspect(file.entry, { colors: color, depth: 2 }));
      console.log("");
    }
    if (args.thumbs !== null && report.thumbnails.length > 0) {
      console.log("Thumbnails");
      for (const thumb of report.thumbnails) {
        const source = maskAssetSource(thumb.source, args.visibility);
        if (thumb.ok) {
          const destination = maskAssetSource(
            thumb.destination,
            args.visibility,
          );
          console.log(
            `  ${source} → ${destination} (${thumb.width}×${thumb.height}, ${formatByteCount(thumb.bytes)})`,
          );
        } else {
          console.log(`  ${source} → failed: ${thumb.error}`);
        }
      }
      console.log("");
    }
  }
  const failures = reports.reduce(
    (sum, report) => sum + report.failures + report.thumbnailFailures,
    0,
  );
  if (failures > 0) {
    console.log(
      `${failures} asset(s) failed a decode, budget or thumbnail check.`,
    );
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(`image_asset_diagnostics ${TOOL_VERSION} (Bun ${Bun.version})`);
    return 0;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`image_asset_diagnostics: ${message}`);
    console.error(USAGE);
    return 2;
  }

  if (args.backend !== undefined) {
    Bun.Image.backend = args.backend;
  }

  const reports: DirectoryReport[] = [];
  for (const input of resolveInputs(args.dirs)) {
    reports.push(await buildReport(input, args));
  }
  const failures = reports.reduce(
    (sum, report) => sum + report.failures + report.thumbnailFailures,
    0,
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: failures === 0,
          generatedAt: new Date().toISOString(),
          visibility: args.visibility,
          backend: Bun.Image.backend,
          headerBytes: args.headerBytes ?? null,
          recursive: args.recursive,
          filter: args.filter ?? null,
          exclude: args.exclude ?? null,
          sort: args.sort,
          budgetBytes: args.budgetBytes ?? null,
          maxDimension: args.maxDimension ?? null,
          failures,
          thumbnails:
            args.thumbs === null
              ? { enabled: false }
              : {
                  enabled: true,
                  maxEdge: args.thumbs,
                  quality: args.thumbQuality,
                  backend: args.backend ?? "bun",
                },
          directories: reports.map((report) => ({
            root: report.root,
            total: report.total,
            truncated: report.truncated,
            count: report.files.length,
            assets: report.files.map((file) => file.entry),
            thumbnails: report.thumbnails.map((thumb) =>
              thumb.ok
                ? {
                    source: maskAssetSource(thumb.source, args.visibility),
                    path: maskAssetSource(thumb.destination, args.visibility),
                    bytes: thumb.bytes,
                    width: thumb.width,
                    height: thumb.height,
                    backend: thumb.backend,
                  }
                : {
                    source: maskAssetSource(thumb.source, args.visibility),
                    error: thumb.error,
                  },
            ),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    printText(
      reports,
      args,
      args.color &&
        useColor({ env: Bun.env, isTTY: process.stdout.isTTY === true }),
    );
  }

  if (failures > 0 && args.fail) return 1;
  return 0;
}

process.exit(await main(Bun.argv.slice(2)));
