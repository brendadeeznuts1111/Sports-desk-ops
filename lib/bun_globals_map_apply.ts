/**
 * @file lib/bun_globals_map_apply.ts
 * @description The writer half of the globals-map summary fix, extracted from the CLI so it can be
 * tested without the repository, a network fetch, or a child process.
 *
 * `scripts/bun_globals_map_summaries.ts` is a thin wrapper: parse flags → resolve `bun-types` →
 * call this → print. Everything that can silently corrupt the committed artifact lives here:
 * provenance migration, metadata rewriting, formatting, and rollback when formatting fails.
 */
import {
  findFalsifiedTypeOnlyClaims,
  findInheritedSummaries,
  type BunTypesDeclarations,
  suppressSummaryDefects,
  type SuppressedSummary,
} from "./bun_globals_map_summaries.ts";

export interface ApplyRow {
  readonly symbol: string;
  readonly kind: string;
  readonly summary?: string;
  readonly [key: string]: unknown;
}

export interface LegacySummaryRecord {
  readonly symbol: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly runtimeTypeof?: string;
  readonly upstreamSummary?: string;
}

export interface ApplyMeta {
  summariesSuppressed?: readonly LegacySummaryRecord[];
  bunTypes?: {
    readonly package?: string;
    readonly files?: readonly string[];
  };
  bunTypesDeclaration?: unknown;
  readonly [key: string]: unknown;
}

/** Returns true when the artifacts were formatted successfully. Injected so tests can fail it. */
export type ArtifactFormatter = (
  paths: readonly string[],
) => boolean | Promise<boolean>;

export interface ApplyOptions {
  readonly rowsPath: string;
  readonly metaPath: string;
  readonly declarations: BunTypesDeclarations;
  readonly apply: boolean;
  /** Defaults to a no-op that reports success; the CLI passes the real `bun fmt` child. */
  readonly format?: ArtifactFormatter;
}

export interface ApplyResult {
  readonly falsified: readonly SuppressedSummary[];
  readonly inherited: readonly SuppressedSummary[];
  /** Claims actually written by this run (empty in report mode). */
  readonly applied: readonly SuppressedSummary[];
  /** Distinct symbols still defective after the run; 0 means the artifact is clean. */
  readonly remaining: number;
  /** Legacy (reason-less) provenance records found before the run. */
  readonly legacyRecords: number;
  /** True when the artifacts were rewritten. */
  readonly wrote: boolean;
  /** False when the injected formatter failed and the rewrite was rolled back. */
  readonly formatted: boolean;
  /** True when the formatter failed and the previous bytes were restored. */
  readonly restored: boolean;
  readonly rows: readonly ApplyRow[];
}

function recordDetail(record: LegacySummaryRecord | SuppressedSummary): string {
  if (
    "detail" in record &&
    typeof record.detail === "string" &&
    record.detail !== ""
  ) {
    return record.detail;
  }
  if (
    "runtimeTypeof" in record &&
    typeof record.runtimeTypeof === "string" &&
    record.runtimeTypeof !== ""
  ) {
    return record.runtimeTypeof;
  }
  return "unknown";
}

/** Older records carried `runtimeTypeof` only; normalize so one shape reaches the metadata. */
export function normalizeRecord(
  record: LegacySummaryRecord | SuppressedSummary,
): SuppressedSummary {
  const reason = record.reason;
  const detail = recordDetail(record);
  const upstreamSummary = record.upstreamSummary ?? "";
  if (reason === "types-only-falsified" || reason === "inherited-from-base") {
    return { symbol: record.symbol, reason, detail, upstreamSummary };
  }
  return {
    symbol: record.symbol,
    reason: "types-only-falsified",
    detail,
    upstreamSummary,
  };
}

function bunTypesOf(declarations: BunTypesDeclarations): {
  package: string;
  files: readonly string[];
} {
  return {
    package: declarations.package,
    files: declarations.relativeFiles,
  };
}

function provenanceNeedsUpdate(
  meta: ApplyMeta,
  declarations: BunTypesDeclarations,
): boolean {
  const next = bunTypesOf(declarations);
  if (meta.bunTypes?.package !== next.package) return true;
  return (
    JSON.stringify(meta.bunTypes?.files ?? []) !== JSON.stringify(next.files) ||
    "bunTypesDeclaration" in meta
  );
}

/**
 * Audit, and with `apply`, fix the artifact in place.
 *
 * Guarantees:
 * - report mode never writes;
 * - `apply` with nothing to do never writes (idempotent);
 * - a formatter failure restores the exact previous bytes;
 * - provenance migration happens even when no new defect is found;
 * - `remaining` is re-derived from the post-run rows, not assumed to be 0.
 */
export async function applySummaryFixes(
  options: ApplyOptions,
): Promise<ApplyResult> {
  const rows = (await Bun.file(options.rowsPath).json()) as ApplyRow[];
  const meta = (await Bun.file(options.metaPath).json()) as ApplyMeta;

  const falsified = findFalsifiedTypeOnlyClaims(rows);
  const inherited = findInheritedSummaries(
    rows,
    options.declarations.declarations,
  );

  const existingRecords = (meta.summariesSuppressed ?? []).map(normalizeRecord);
  const legacyRecords = (meta.summariesSuppressed ?? []).filter(
    (record) => record.reason === undefined,
  ).length;
  const metaNeedsUpdate = provenanceNeedsUpdate(meta, options.declarations);

  let rowsAfter: readonly ApplyRow[] = rows;
  let applied: readonly SuppressedSummary[] = [];
  let wrote = false;
  let formatted = true;
  let restored = false;

  if (options.apply) {
    const result = suppressSummaryDefects(rows, {
      declarations: options.declarations.declarations,
    });
    rowsAfter = result.rows;
    applied = result.suppressed;

    if (applied.length > 0 || legacyRecords > 0 || metaNeedsUpdate) {
      const recorded = new Map<string, SuppressedSummary>(
        existingRecords.map((record) => [record.symbol, record]),
      );
      for (const claim of applied) recorded.set(claim.symbol, claim);
      const nextMeta: Record<string, unknown> = {
        ...meta,
        bunTypes: bunTypesOf(options.declarations),
        summariesSuppressed: [...recorded.values()],
      };
      delete nextMeta.bunTypesDeclaration;

      const before = {
        rows: await Bun.file(options.rowsPath).text(),
        meta: await Bun.file(options.metaPath).text(),
      };
      await Bun.write(
        options.rowsPath,
        `${JSON.stringify(rowsAfter, null, 2)}\n`,
      );
      await Bun.write(
        options.metaPath,
        `${JSON.stringify(nextMeta, null, 2)}\n`,
      );
      formatted =
        options.format === undefined
          ? true
          : await options.format([options.rowsPath, options.metaPath]);
      if (!formatted) {
        await Bun.write(options.rowsPath, before.rows);
        await Bun.write(options.metaPath, before.meta);
        restored = true;
        rowsAfter = rows;
        applied = [];
      } else {
        wrote = true;
      }
    }
  }

  const remainingClaims = [
    ...findFalsifiedTypeOnlyClaims(rowsAfter),
    ...findInheritedSummaries(rowsAfter, options.declarations.declarations),
  ];
  const remaining = new Set(remainingClaims.map((claim) => claim.symbol)).size;

  return {
    falsified,
    inherited,
    applied,
    remaining,
    legacyRecords,
    wrote,
    formatted,
    restored,
    rows: rowsAfter,
  };
}

/** Hand annotations in the committed artifact; no generator produces these. */
export const HAND_NOTE = /^\[Not in Bun 1\.4\.4:/;

export interface AnnotationRow {
  readonly kind: string;
  readonly symbol: string;
  readonly summary: string;
}

/**
 * Carry hand annotations across a re-scrape. They are matched by `kind` + `symbol`, so a generated
 * row cannot inherit another row's note, and rows that had no note keep the scraped text.
 */
export function preserveHandAnnotations<T extends AnnotationRow>(
  previousRows: readonly AnnotationRow[],
  rows: readonly T[],
): T[] {
  const notes = new Map(
    previousRows
      .filter((row) => HAND_NOTE.test(row.summary))
      .map((row) => [`${row.kind}\u0000${row.symbol}`, row.summary] as const),
  );
  if (notes.size === 0) return [...rows];
  return rows.map((row) => {
    const note = notes.get(`${row.kind}\u0000${row.symbol}`);
    return note === undefined ? row : { ...row, summary: note };
  });
}

export interface MergeGeneratedMetaInput {
  readonly previous: Record<string, unknown>;
  readonly generated: Record<string, unknown>;
  readonly declarations: BunTypesDeclarations;
  readonly summariesSuppressed: readonly SuppressedSummary[];
}

/**
 * Merge a fresh scrape's metadata over the committed one: hand-maintained keys survive, generated
 * fields win on collision, provenance is rewritten to the package-relative shape, and the legacy
 * absolute-path key is dropped.
 */
export function mergeGeneratedMeta(
  input: MergeGeneratedMetaInput,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...input.previous,
    ...input.generated,
    bunTypes: bunTypesOf(input.declarations),
    summariesSuppressed: [...input.summariesSuppressed],
  };
  delete merged.bunTypesDeclaration;
  return merged;
}
