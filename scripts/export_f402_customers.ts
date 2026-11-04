#!/usr/bin/env bun
/**
 * @file export_f402_customers.ts
 * @description Normalize an operator-supplied F402 customer export into the explicit customer list
 * that Bridge 3b needs (`F402_PENDING_CUSTOMERS_FILE`, one id per line).
 *
 * There is no server-side "all customers" scope: `Report/Pending` is strictly customer-scoped
 * (measured 2026-11-04), so 3b's list must come from a complete operator export — never from an
 * implicit enumeration. This tool accepts JSON (array/string/object rows), CSV/TSV with a customer
 * header, or one-id-per-line text; it de-duplicates, validates, writes 0600, and prints only counts
 * and length ranges (never an id).
 *
 * `enriched_customers_full.json` is a curated cohort used for tests, not a complete book; the tool
 * warns when the source name suggests it so it is not mistaken for production input.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const ID_FIELDS = [
  "customer_id",
  "customerID",
  "CustomerID",
  "customerId",
  "customer",
  "Customer",
  "login",
  "Login",
  "id",
  "ID",
] as const;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class CustomerExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerExportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickId(value: unknown, preferredField?: string): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (!isRecord(value)) return "";
  const fields =
    preferredField === undefined ? ID_FIELDS : [preferredField, ...ID_FIELDS];
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === "string" || typeof candidate === "number") {
      return String(candidate);
    }
  }
  return "";
}

function rowsFromJson(value: unknown, preferredField?: string): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => pickId(item, preferredField)).filter(Boolean);
  }
  if (isRecord(value)) {
    for (const key of ["customers", "rows", "data", "items", "results"]) {
      if (Array.isArray(value[key])) {
        return rowsFromJson(value[key], preferredField);
      }
    }
    return [pickId(value, preferredField)].filter(Boolean);
  }
  return [];
}

function rowsFromDelimited(text: string, preferredField?: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return [];
  const first = lines[0]!;
  const delimiter = first.includes("\t")
    ? "\t"
    : first.includes(",")
      ? ","
      : "";
  if (delimiter === "") {
    return lines.map((line) => line.replace(/^['"]|['"]$/g, "").trim());
  }
  const header = first
    .split(delimiter)
    .map((cell) => cell.trim().replace(/^['"]|['"]$/g, ""));
  const column =
    preferredField === undefined
      ? header.findIndex((cell) =>
          (ID_FIELDS as readonly string[]).includes(cell),
        )
      : header.indexOf(preferredField);
  if (column === -1) {
    throw new CustomerExportError(
      `no customer-id column found in header [${header.join(", ")}]; pass --id-field`,
    );
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(delimiter);
    return (cells[column] ?? "").trim().replace(/^['"]|['"]$/g, "");
  });
}

/** Parse one source text into raw ids (before validation/de-dupe). Exported for tests. */
export function parseCustomerExport(
  text: string,
  options: { readonly idField?: string } = {},
): string[] {
  const trimmed = text.trim();
  if (trimmed === "") throw new CustomerExportError("source is empty");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new CustomerExportError(
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return rowsFromJson(parsed, options.idField);
  }
  return rowsFromDelimited(trimmed, options.idField);
}

/** Trim, validate, de-duplicate, and cap a raw id list. Order is preserved. */
export function normalizeCustomerIds(
  raw: readonly string[],
  options: { readonly limit?: number } = {},
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    const id = value.trim();
    if (id === "") continue;
    if (!ID_PATTERN.test(id)) {
      throw new CustomerExportError(
        `invalid customer id: must be 1..64 characters of [A-Za-z0-9._-] (got ${JSON.stringify(id.slice(0, 12))}${id.length > 12 ? "…" : ""})`,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (options.limit !== undefined && ids.length >= options.limit) break;
  }
  return ids;
}

export interface ExportCustomerListResult {
  readonly path: string;
  readonly count: number;
  readonly minChars: number;
  readonly maxChars: number;
}

/** Write the normalized list at 0600 with an atomic temp+rename. Returns counts, never ids. */
export function writeCustomerList(
  ids: readonly string[],
  path: string,
): ExportCustomerListResult {
  if (ids.length === 0) {
    throw new CustomerExportError("no customer ids after normalization");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${ids.join("\n")}\n`, { mode: 0o600 });
  renameSync(temp, path);
  const lengths = ids.map((id) => id.length);
  return {
    path,
    count: ids.length,
    minChars: Math.min(...lengths),
    maxChars: Math.max(...lengths),
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(): void {
  const args = Bun.argv.slice(2);
  const from = flag(args, "--from");
  const out = flag(args, "--out");
  if (from === undefined || out === undefined) {
    console.error(
      "usage: bun run scripts/export_f402_customers.ts --from <approved-export.json|csv|txt> --out <list.txt> [--id-field <name>] [--limit <n>]",
    );
    console.error(
      "  the source must be the operator's complete customer export; Report/Pending has no agent-wide scope",
    );
    process.exit(2);
  }
  const limitRaw = flag(args, "--limit");
  const limit =
    limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    console.error("export_f402_customers: --limit must be a positive integer");
    process.exit(2);
  }
  if (basename(from).includes("enriched_customers")) {
    console.error(
      "export_f402_customers: WARNING: enriched_customers_full.json is a curated cohort (test fixture), not a complete book; production 3b needs the operator's full customer export",
    );
  }
  let ids: string[];
  try {
    const text = readFileSync(from, "utf8");
    const idField = flag(args, "--id-field");
    ids = normalizeCustomerIds(
      parseCustomerExport(text, idField === undefined ? {} : { idField }),
      limit === undefined ? {} : { limit },
    );
  } catch (error) {
    console.error(
      `export_f402_customers: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const result = writeCustomerList(ids, out);
  console.error(
    `export_f402_customers: wrote ${result.count} customer id(s) (lengths ${result.minChars}..${result.maxChars}) -> ${result.path} (0600)`,
  );
  console.error(
    "  use it with: F402_PENDING_CUSTOMERS_FILE=<path> bun run bridge3b:rollup (or --customers-file)",
  );
}

if (import.meta.main) main();
