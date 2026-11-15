/**
 * json | csv | md formatters for analyze outputs. IPs must already be hashed.
 */

import { F402AnalyzeError } from "./f402_analyze_ingest.ts";

export type AnalyzeFormat = "json" | "csv" | "md";

export function parseAnalyzeFormat(raw: string | undefined): AnalyzeFormat {
  const value = (raw ?? "json").trim().toLowerCase();
  if (value === "json" || value === "csv" || value === "md") return value;
  throw new F402AnalyzeError(
    "config",
    "format",
    "--format must be json, csv, or md",
  );
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns?: readonly string[],
): string {
  if (rows.length === 0) {
    return columns !== undefined && columns.length > 0
      ? `${columns.join(",")}\n`
      : "";
  }
  const cols = columns ?? Object.keys(rows[0]!);
  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((col) => csvEscape(row[col])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function kvTable(rows: readonly [string, string][]): string {
  if (rows.length === 0) return "";
  const lines = ["| field | value |", "| --- | --- |"];
  for (const [k, v] of rows) {
    lines.push(`| ${k.replaceAll("|", "\\|")} | ${v.replaceAll("|", "\\|")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatMarkdown(title: string, body: unknown): string {
  if (typeof body === "string") {
    return `# ${title}\n\n${body.endsWith("\n") ? body : `${body}\n`}`;
  }
  if (
    Array.isArray(body) &&
    body.every((row) => row !== null && typeof row === "object")
  ) {
    const rows = body as Record<string, unknown>[];
    if (rows.length === 0) return `# ${title}\n\n_(empty)_\n`;
    const cols = Object.keys(rows[0]!);
    const lines = [
      `# ${title}`,
      "",
      `| ${cols.join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
    ];
    for (const row of rows) {
      lines.push(
        `| ${cols.map((col) => String(row[col] ?? "").replaceAll("|", "\\|")).join(" | ")} |`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
  if (body !== null && typeof body === "object") {
    const entries = Object.entries(body as Record<string, unknown>).map(
      ([k, v]) =>
        [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string],
    );
    return `# ${title}\n\n${kvTable(entries)}`;
  }
  return `# ${title}\n\n${String(body)}\n`;
}

export function renderAnalyzeOutput(
  format: AnalyzeFormat,
  title: string,
  value: unknown,
  csvRows?: readonly Record<string, unknown>[],
): string {
  if (format === "json") return formatJson(value);
  if (format === "csv") {
    if (csvRows !== undefined) return toCsv(csvRows);
    if (Array.isArray(value)) {
      return toCsv(value as Record<string, unknown>[]);
    }
    return toCsv([value as Record<string, unknown>]);
  }
  return formatMarkdown(title, csvRows ?? value);
}
