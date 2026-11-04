/**
 * Config files as JSON5, YAML or TOML, parsed with Bun.JSON5 / Bun.YAML / Bun.TOML and validated
 * with a zod schema.
 *
 * Bun's parse errors carry no line or column ("YAML Parse error: Unexpected token", Bun 1.4.4), so
 * every message here leads with the file path: it is the only location the operator gets.
 *
 * Schemas should be `z.strictObject` at every level: zod's default strips unknown keys, so a typo
 * (`thub:` for `thumb:`) would validate clean and do nothing. {@link validateConfig} refuses a
 * stripping top-level object; nested objects are the schema author's to make strict.
 *
 * TOML date/times parse to Temporal objects (Instant, PlainDateTime, PlainDate, PlainTime), which
 * `z.date()` rejects; validate them with `z.instanceof(Temporal.PlainDate)` and so on (the global
 * exists at runtime but TypeScript 5.9 and bun-types 1.4.4 do not declare it, so reach it through
 * `globalThis`). This module only reads: `Bun.TOML.stringify` drops comments and reorders keys,
 * so it must not back a writer for hand-edited files.
 */

import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { toLocalPath } from "./local_path.ts";
import { UsageError } from "./usage_error.ts";

export type ConfigFormat = "json5" | "yaml" | "toml";

/** JSON and JSONC are subsets of JSON5, so all three go through Bun.JSON5. */
const FORMAT_BY_EXTENSION: Readonly<Record<string, ConfigFormat>> = {
  ".json": "json5",
  ".jsonc": "json5",
  ".json5": "json5",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

const PARSE: Readonly<Record<ConfigFormat, (raw: string) => unknown>> = {
  json5: (raw) => Bun.JSON5.parse(raw),
  yaml: (raw) => Bun.YAML.parse(raw),
  toml: (raw) => Bun.TOML.parse(raw),
};

/** A comment-only document: YAML reads it as null, TOML as an empty table. */
function hasNoContent(format: ConfigFormat, value: unknown): boolean {
  if (format === "yaml") return value === null;
  if (format === "toml") {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 0
    );
  }
  return false;
}

/** Throws {@link UsageError} for a path whose extension is not a supported config format. */
export function configFormat(path: string): ConfigFormat {
  const name = basename(toLocalPath(path));
  // extname(".yaml") is "": a bare dotfile name is its own extension.
  const ext = (
    extname(name) || (name.startsWith(".") ? name : "")
  ).toLowerCase();
  const format = FORMAT_BY_EXTENSION[ext];
  if (format === undefined) {
    throw new UsageError(
      `${path}: unsupported config extension ${ext === "" ? "(none)" : `"${ext}"`}; use ${Object.keys(FORMAT_BY_EXTENSION).join(", ")}`,
    );
  }
  return format;
}

/**
 * Syntax only: the parsed value, unvalidated. A YAML stream with several `---` documents comes back
 * as an array, indistinguishable from one document whose top level is a list; a schema that accepts
 * arrays (`z.array`, `z.union`, `z.record`, `z.any`) cannot tell them apart either.
 */
export function parseConfig(
  raw: string,
  format: ConfigFormat,
  source = "config",
): unknown {
  if (raw.trim() === "") throw new UsageError(`${source}: config is empty`);
  let value: unknown;
  try {
    value = PARSE[format](raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new UsageError(`${source}: ${error.message}`, { cause: error });
  }
  if (hasNoContent(format, value)) {
    throw new UsageError(
      `${source}: config has no content (only comments, or a bare null)`,
    );
  }
  return value;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

/** Shape only. Throws {@link UsageError} naming the source and every failing field path. */
export function validateConfig<S extends z.ZodType>(
  value: unknown,
  schema: S,
  source = "config",
): z.output<S> {
  if (schema instanceof z.ZodObject && schema.def.catchall === undefined) {
    throw new TypeError(
      "config schemas must reject unknown keys: use z.strictObject, not z.object",
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`${source}: ${formatIssues(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Reads (path or file:// URL), parses and validates one config file; failures are UsageErrors. */
export async function readConfig<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const format = configFormat(path);
  const local = toLocalPath(path);
  const info = await stat(local).catch((error: unknown) => {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  });
  if (info === null) throw new UsageError(`${path}: config file not found`);
  if (info.isDirectory()) throw new UsageError(`${path}: is a directory`);
  const raw = await Bun.file(local).text();
  return validateConfig(parseConfig(raw, format, path), schema, path);
}
