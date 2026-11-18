/**
 * @file scripts/image_asset_cli_spec.ts
 * @description Version, flag table and usage text for `assets:diagnostics`.
 *
 * Defaults are interpolated from the modules that enforce them, so changing `DEFAULT_ASSET_LIMIT`
 * or `DEFAULT_THUMBNAIL_EDGE` updates the help output instead of leaving a stale hand-written
 * number behind.
 */

import {
  DEFAULT_ASSET_LIMIT,
  DEFAULT_MAX_ASSET_BYTES,
  MAX_ASSET_LIMIT,
} from "../lib/bun_image_assets.ts";
import {
  DEFAULT_THUMBNAIL_EDGE,
  DEFAULT_THUMBNAIL_QUALITY,
  MAX_THUMBNAIL_EDGE,
} from "../lib/bun_thumbnail.ts";
import { formatByteCount } from "../lib/format_bytes.ts";
import { INSPECT_VISIBILITIES } from "../lib/inspect_redactor.ts";

const packageJson = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as { readonly version: string };

/** The package version is the tool version; no separate hand-bumped constant. */
export const TOOL_VERSION = packageJson.version;
export const DEFAULT_ASSET_ROOT = "docs/assets";

export interface CliFlagSpec {
  readonly flags: string;
  /** Value placeholder; omitted for boolean flags. */
  readonly value?: string;
  readonly description: string;
}

export const FLAG_SPECS: readonly CliFlagSpec[] = Object.freeze([
  {
    flags: "--json",
    description: "Machine output (single JSON object, full entries)",
  },
  {
    flags: "--summary",
    description: "Text totals per directory; skip per-asset cards",
  },
  {
    flags: "--limit",
    value: "N",
    description: `Entries per directory, 1..${MAX_ASSET_LIMIT} (default ${DEFAULT_ASSET_LIMIT})`,
  },
  {
    flags: "--recursive, -r",
    description: "Walk subdirectories with a Bun.Glob (**/*.{png,jpg,…})",
  },
  {
    flags: "--filter",
    value: "TEXT",
    description: "Case-insensitive substring filter on the relative asset name",
  },
  {
    flags: "--exclude",
    value: "TEXT",
    description: "Case-insensitive substring exclusion, applied after --filter",
  },
  {
    flags: "--sort",
    value: "name|size",
    description: "name (default, scan order) or size (largest first)",
  },
  {
    flags: "--placeholders",
    description:
      "Decode each image to compute its ThumbHash placeholder (slower)",
  },
  {
    flags: "--max-bytes",
    value: "N",
    description: `Skip files larger than N bytes (default ${formatByteCount(DEFAULT_MAX_ASSET_BYTES)})`,
  },
  {
    flags: "--header-bytes",
    value: "N",
    description:
      "Read only N bytes per file and resolve dimensions from the header",
  },
  {
    flags: "--budget-bytes",
    value: "N",
    description: "Fail any asset larger than N bytes",
  },
  {
    flags: "--max-dimension",
    value: "N",
    description: `Fail any asset wider or taller than N pixels (max ${MAX_THUMBNAIL_EDGE})`,
  },
  {
    flags: "--visibility",
    value: "TIER",
    description: INSPECT_VISIBILITIES.join(" | "),
  },
  {
    flags: "--backend",
    value: "bun|system",
    description:
      "Set Bun.Image.backend before reading (default: runtime value)",
  },
  {
    flags: "--thumbs",
    value: "EDGE",
    description: `Write WebP thumbnails capped at EDGE px (default ${DEFAULT_THUMBNAIL_EDGE})`,
  },
  {
    flags: "--thumbs-dir",
    value: "DIR",
    description: "Thumbnail directory (default: <dir>/.thumbs)",
  },
  {
    flags: "--thumb-quality",
    value: "N",
    description: `WebP quality 1..100 (default ${DEFAULT_THUMBNAIL_QUALITY})`,
  },
  {
    flags: "--no-fail",
    description: "Exit 0 even when an asset or thumbnail fails",
  },
  {
    flags: "--no-color",
    description: "Disable ANSI color",
  },
  {
    flags: "--version, -v",
    description: "Print the tool and Bun versions",
  },
  {
    flags: "-h, --help",
    description: "Show this help",
  },
]);

const FLAG_COLUMN = 26;

function flagLine(spec: CliFlagSpec): string {
  const form =
    spec.value === undefined ? spec.flags : `${spec.flags}=${spec.value}`;
  return `  ${form.padEnd(FLAG_COLUMN)}${spec.description}`;
}

export const USAGE = `image_asset_diagnostics ${TOOL_VERSION} — Bun.Image asset attributes

Usage:
  bun run assets:diagnostics [dir ...] [options]

Directories default to ${DEFAULT_ASSET_ROOT}. Each directory is scanned shallowly unless --recursive.
A positional argument may also be a file or a glob (${DEFAULT_ASSET_ROOT}/*.webp).

Options:
${FLAG_SPECS.map(flagLine).join("\n")}

Thumbnails use \`Bun.Image.backend = "bun"\` unless --backend says otherwise, so resize geometry is
portable; JPEG/PNG/WebP codecs are byte-identical across platforms, while TIFF/HEIC/AVIF still
decode through the OS. Hidden \`.thumbs\` directories are skipped by --recursive (Bun.Glob default).

Exit codes: 0 all files readable · 1 any scan or thumbnail failure · 2 invalid argument

Examples:
  bun run assets:diagnostics
  bun run assets:diagnostics ${DEFAULT_ASSET_ROOT} --recursive --filter=pipeline --limit=10
  bun run assets:diagnostics --json --sort=size --placeholders > /tmp/assets.json
  bun run assets:diagnostics --header-bytes=65536 --recursive
  bun run assets:diagnostics "${DEFAULT_ASSET_ROOT}/*.webp" --budget-bytes=262144
  bun run assets:diagnostics --thumbs=320 --recursive --summary`;
